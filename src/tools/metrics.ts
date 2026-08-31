import { z } from "zod";
import { runAwsCall } from "../aws-cli.js";
import { getProfile, getRegion } from "../session.js";
import { RELATIVE_TIME_RE, relativeTimeMs } from "./logs.js";
import { extractNextToken } from "./paginate.js";
import type { Tool, ToolResult } from "./tool.js";

/**
 * aws_metrics_query wraps `cloudwatch get-metric-data`, the multi-metric /
 * expression-capable API (NOT the legacy `get-metric-statistics`, which is
 * single-metric and missing math expressions).
 *
 * The pain this solves: "average CPU on this Lambda over the last hour" is
 * a one-liner with CloudWatch but the raw MetricDataQueries JSON shape is
 * verbose and easy to get wrong. This tool takes flat-friendly inputs
 * (id, namespace, metricName, dimensions{}, statistic, optional period)
 * and shapes them into the PascalCase nested structure CloudWatch wants.
 *
 * Pairs with aws_logs_tail (the Logs counterpart) -- the metric side of
 * the same observability question the agent gets asked all the time.
 *
 * Response shape: this tool flat-promotes useful fields (series, periodSeconds,
 * startTime, endTime, profile, region, nextToken, hasMore) at the top level
 * INSTEAD of nesting under a {result: ...} envelope. That follows the
 * semantic-tool convention used by aws_resource_get / aws_resource_list /
 * aws_resource_status, not the thin CLI-proxy convention used by aws_call /
 * aws_paginate (which DO nest under `result`). Both shapes are intentional:
 * the proxy tools forward an opaque AWS response so wrapping in `result`
 * keeps the proxy boundary obvious, while the semantic tools shape a typed
 * response and flat-promote so callers can destructure without a step.
 * Don't "fix" this to add a `result` envelope -- it would be a SemVer-major
 * break and the semantic-tool sibling convention is the right one here.
 */

// Statistic vocabulary CloudWatch accepts on a MetricStat.Stat field. The
// extended stats (p99, p95, ...) are also accepted; we let through any
// string matching the conservative shape so future percentile / TM-style
// stats added by CloudWatch don't require a code change.
const SIMPLE_STATS = ["Average", "Sum", "Maximum", "Minimum", "SampleCount"] as const;
// Matches "p99", "p99.9", "tm95", "tc90", "wm99", etc. -- the extended-stat
// shapes documented at https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Statistics-definitions.html
//
// IQM (interquartile mean) takes NO numeric suffix; CloudWatch rejects
// 'iqm99' / 'iqm0.5' with a ValidationError. Split it out so it only matches
// the bare token 'iqm' (case-insensitive). All other prefixes still accept
// an optional d{1,3}(.d{1,3})? suffix.
const EXTENDED_STAT_RE = /^((p|tm|tc|wm|pr|ts)(\d{1,3}(\.\d{1,3})?)?|iqm)$/i;

function isValidStatistic(s: string): boolean {
  // Case-fold the simple list so 'average', 'AVERAGE', 'Average' all pass --
  // the extended-stat regex below is already case-insensitive (/i), so a
  // case-sensitive simple list would reject 'average' while accepting 'p99'.
  const lower = s.toLowerCase();
  if (SIMPLE_STATS.some((stat) => stat.toLowerCase() === lower)) return true;
  return EXTENDED_STAT_RE.test(s);
}

/**
 * Canonicalize a stat to the exact form CloudWatch's MetricStat.Stat field
 * expects. The wire format is case-sensitive on BOTH branches:
 *   - Simple stats want PascalCase: 'Average' is accepted, 'average' gets a
 *     ValidationError.
 *   - Extended stats want lowercase: 'p99' / 'tm95' are accepted, 'P99' /
 *     'Tm95' get a ValidationError.
 * isValidStatistic accepts case-folded forms on both branches (the simple
 * list is folded explicitly, the extended-stat regex carries /i), so the
 * schema doesn't reject 'average' or 'P99' -- but we MUST canonicalize
 * before sending so the agent's mixed-case input doesn't bounce server-side.
 * The trailing `return s` is defense-in-depth for inputs that somehow reach
 * this function without passing isValidStatistic first.
 */
function canonicalizeStatistic(s: string): string {
  const lower = s.toLowerCase();
  for (const stat of SIMPLE_STATS) {
    if (stat.toLowerCase() === lower) return stat;
  }
  if (EXTENDED_STAT_RE.test(s)) return lower;
  return s;
}

// CloudWatch requires query Ids match /^[a-z][A-Za-z0-9_]*$/ and be unique
// within a request. Mirror the spec; the handler additionally checks for
// duplicates across the input list.
const QUERY_ID_RE = /^[a-z][A-Za-z0-9_]*$/;

// CloudWatch hard-caps GetMetricData at 500 queries per request. We cap
// lower so a malformed input doesn't burn the per-call latency budget
// before the API would reject it; 100 covers every realistic agent case.
const MAX_QUERIES = 100;

// CloudWatch caps a single GetMetricData response at ~100,800 datapoints PER
// REQUEST (1,440 points/day over 70 days) -- not per query. We validate the
// datapoint count upfront so an over-the-cap request bounces with an actionable
// message instead of CloudWatch's less-specific downstream ValidationError, and
// the check has to mirror the cap's shape: each query on its own AND the sum
// across the batch, since 100 queries of 100,000 points each pass individually
// and blow the request cap together. Both the explicit-period and the
// auto-picked-period paths are checked (see pickAutoPeriodSeconds below for why
// the auto-pick is not safe by construction). CloudWatch also requires `period`
// to be a positive multiple of 60.
//
// The estimate is derived from the REQUESTED period, which is only what
// CloudWatch returns when the caller has NOT bounded the response. `MaxDatapoints`
// (this tool's `maxDataPoints`) is exactly such a bound: CloudWatch widens the
// period server-side until the series fits it and pages the remainder behind
// NextToken, which this tool already surfaces as nextToken / hasMore. So the
// estimate is clamped to the caller's bound before it is compared -- otherwise a
// batch the caller has ALREADY bounded, and that CloudWatch would serve happily,
// gets rejected here on a count that never materializes.
const CLOUDWATCH_MAX_DATAPOINTS = 100_800;

// Pick a sane period granularity scaled to the requested range so a wide
// window doesn't default to a needlessly fine resolution: minutes for a few
// hours, coarser steps as the range grows to days/weeks. The tiers exist to
// give a useful default shape (someone asking for 7 days almost never wants 1s
// points), NOT to defend against the datapoint cap: the last tier floors at
// 3600s, so any range beyond ~11.5 years crosses CLOUDWATCH_MAX_DATAPOINTS on
// the auto-pick alone. The handler therefore checks the auto-picked period too.
const PERIOD_3H_MS = 3 * 60 * 60 * 1000;
const PERIOD_24H_MS = 24 * 60 * 60 * 1000;
const PERIOD_15D_MS = 15 * 24 * 60 * 60 * 1000;

export function pickAutoPeriodSeconds(startMs: number, endMs: number): number {
  const rangeMs = Math.max(0, endMs - startMs);
  if (rangeMs <= PERIOD_3H_MS) return 60;
  if (rangeMs <= PERIOD_24H_MS) return 300;
  if (rangeMs <= PERIOD_15D_MS) return 900;
  return 3600;
}

// The relative-time vocab ("5m" / "2h" / "1d" / "1w", relative to "now") is
// shared with aws_logs_tail's `since` flag so agents only learn it once, and is
// IMPORTED from logs.ts rather than re-declared here -- the two copies were
// byte-identical, which is the drift multi-region.ts already designed out by
// centralizing its region regex in session.ts.

// A bare number is the trap this rejects. "5" fails RELATIVE_TIME_RE (no unit)
// and would fall through to `new Date("5")`, which V8 reads as 2001-05-01 -- a
// dropped unit silently becomes a 25-year window with nothing rejecting it
// locally. Neither reading ("5 minutes"? "the year 5"?) is safe to guess.
const BARE_NUMBER_RE = /^\d+(?:\.\d+)?$/;

// ISO 8601 shapes we accept, and why the offset is mandatory: `new Date()`
// parses a DATE-ONLY string as UTC but a DATE-TIME without an offset as LOCAL
// time. The handler then .toISOString()s the result into the CloudWatch
// request, so "2026-05-16T10:00:00" -- which the tool description calls ISO
// 8601 -- silently shifts the query window by the host's UTC offset, and the
// same call means different things on a laptop and a container. Requiring an
// explicit offset (Z or +/-HH:MM) makes the window host-independent; date-only
// stays accepted because its UTC interpretation is unambiguous.
const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}:?\d{2})$/;

/**
 * Resolve a startTime / endTime input to a Date. Accepted forms:
 *   - "now"
 *   - relative shorthand ("15m", "1h", "1d", "1w"), interpreted as "ago"
 *   - ISO 8601 date-only ("2026-05-16"), read as UTC midnight
 *   - ISO 8601 date-time WITH an explicit offset ("2026-05-16T10:00:00Z",
 *     "2026-05-16T10:00:00-04:00")
 * Everything else -- an offset-less date-time, a bare number, free text --
 * returns null rather than being handed to Date's permissive parser.
 */
export function resolveTime(input: string, now: number): Date | null {
  if (input === "now") return new Date(now);
  if (RELATIVE_TIME_RE.test(input)) {
    const ms = relativeTimeMs(input);
    return ms === null ? null : new Date(now - ms);
  }
  if (BARE_NUMBER_RE.test(input)) return null;
  if (!ISO_DATE_ONLY_RE.test(input) && !ISO_DATE_TIME_RE.test(input)) return null;
  const t = new Date(input);
  if (Number.isNaN(t.getTime())) return null;
  return t;
}

/** Per-query input from the MCP caller. PascalCase fields land in CloudWatch's
 * MetricDataQueries shape; we keep the wire schema camelCase to match every
 * other tool in this server. */
interface MetricsQueryInput {
  id: string;
  namespace?: string;
  metricName?: string;
  dimensions?: Record<string, string>;
  statistic?: string;
  period?: number;
  expression?: string;
  label?: string;
  returnData?: boolean;
  unit?: string;
}

interface CloudWatchMetricStat {
  Metric: {
    Namespace: string;
    MetricName: string;
    Dimensions?: Array<{ Name: string; Value: string }>;
  };
  Period: number;
  Stat: string;
  Unit?: string;
}

interface CloudWatchMetricDataQuery {
  Id: string;
  Label?: string;
  ReturnData?: boolean;
  MetricStat?: CloudWatchMetricStat;
  Expression?: string;
  Period?: number;
}

/**
 * Shape a list of flat MetricsQueryInput into CloudWatch's nested
 * MetricDataQueries array. Each query is one of two flavors:
 *   - metric-stat: requires namespace + metricName, optional dimensions,
 *     statistic (default Average), period (defaults to autoPeriod)
 *   - expression: requires expression, no metric-stat fields
 * Mixing the two on one query (both expression AND namespace) is rejected
 * by the caller-side validation, not here.
 */
export function buildMetricDataQueries(
  inputs: readonly MetricsQueryInput[],
  autoPeriod: number,
): CloudWatchMetricDataQuery[] {
  return inputs.map((q): CloudWatchMetricDataQuery => {
    const base: CloudWatchMetricDataQuery = { Id: q.id };
    if (q.label !== undefined) base.Label = q.label;
    if (q.returnData !== undefined) base.ReturnData = q.returnData;
    if (q.expression !== undefined) {
      base.Expression = q.expression;
      if (q.period !== undefined) base.Period = q.period;
      return base;
    }
    // metric-stat flavor: namespace + metricName guaranteed by the caller-
    // side guard. Defaults: Stat=Average, Period=autoPeriod. Treat an empty
    // dimensions map ({}) the same as no dimensions: Object.entries({}) is []
    // and [] is truthy, so a naive `dimensions ? ...` test would emit
    // `Dimensions: []`, which CloudWatch rejects with a ValidationError.
    const dimEntries = q.dimensions ? Object.entries(q.dimensions) : [];
    const stat: CloudWatchMetricStat = {
      Metric: {
        Namespace: q.namespace as string,
        MetricName: q.metricName as string,
        ...(dimEntries.length > 0 ? { Dimensions: dimEntries.map(([Name, Value]) => ({ Name, Value })) } : {}),
      },
      Period: q.period ?? autoPeriod,
      Stat: q.statistic !== undefined ? canonicalizeStatistic(q.statistic) : "Average",
    };
    if (q.unit !== undefined) stat.Unit = q.unit;
    base.MetricStat = stat;
    return base;
  });
}

interface CloudWatchMetricDataResult {
  Id?: string;
  Label?: string;
  Timestamps?: string[];
  Values?: number[];
  StatusCode?: string;
}

interface CloudWatchMetricDataResponse {
  MetricDataResults?: CloudWatchMetricDataResult[];
  Messages?: Array<{ Code?: string; Value?: string }>;
  NextToken?: string;
}

export const metricsTools: readonly Tool[] = [
  {
    name: "aws_metrics_query",
    description:
      "Query CloudWatch metrics via GetMetricData (the modern multi-metric / expression-capable API, not the legacy get-metric-statistics). Pass `queries` as a flat array of {id, namespace, metricName, dimensions?, statistic?, period?, expression?, label?}; the tool shapes them into MetricDataQueries for you. `startTime`/`endTime` accept relative shorthand ('15m', '1h', '1d', '1w'), 'now', or ISO 8601 WITH an explicit offset ('2026-05-16T10:00:00Z' / '...-04:00' -- an offset-less date-time is rejected rather than silently read in the host's local zone; a date-only '2026-05-16' is read as UTC midnight); endTime defaults to 'now'. Period is auto-picked from the time range when omitted (60s for <=3h, 300s for <=24h, 900s for <=15d, 3600s otherwise) to stay under CloudWatch's ~100,800-datapoint response cap. Returns {series: [{id, label?, timestamps, values, period?, statusCode?}], messages?, periodSeconds, profile, region, nextToken, hasMore}. Each series' `period` is the effective granularity for that query (its explicit period, or the auto-pick it inherited); it is omitted for an expression query that didn't set one. The top-level `periodSeconds` is always the auto-pick. When CloudWatch truncates a large response, `hasMore` is true and `nextToken` carries the resume cursor -- call again with `nextToken` set to fetch the next page (rare for typical agent queries that stay within the per-request cap). Use for 'show me the CPU on this instance for the last hour', 'sum lambda invocations across these 3 functions', or expression-based 'p99 latency divided by average latency' lookups.",
    annotations: {
      title: "Query CloudWatch metrics (GetMetricData)",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      queries: z
        .array(
          z.object({
            id: z
              .string()
              .regex(QUERY_ID_RE, "id must match /^[a-z][A-Za-z0-9_]*$/ (CloudWatch's MetricDataQuery.Id contract)"),
            namespace: z
              .string()
              .min(1)
              .optional()
              .describe("AWS metric namespace, e.g. 'AWS/Lambda', 'AWS/EC2'. Required unless `expression` is set."),
            metricName: z
              .string()
              .min(1)
              .optional()
              .describe("Metric name, e.g. 'Invocations', 'CPUUtilization'. Required unless `expression` is set."),
            dimensions: z
              .record(z.string(), z.string())
              .optional()
              .describe("Dimension Name -> Value map, e.g. {FunctionName: 'my-fn'}."),
            statistic: z
              .string()
              .optional()
              .describe(
                "Statistic: Average | Sum | Maximum | Minimum | SampleCount, or an extended stat like 'p99', 'p99.9', 'tm95'. Default 'Average'.",
              ),
            period: z
              .number()
              .int()
              .positive()
              .optional()
              .describe("Period in seconds. Defaults to an auto-pick from the time range (60s/300s/900s/3600s)."),
            expression: z
              .string()
              .min(1)
              .optional()
              .describe(
                "CloudWatch metric math expression, e.g. 'SUM([m1, m2])' or 'AVG(METRICS(\"AWS/Lambda\"))'. Mutually exclusive with namespace/metricName/dimensions. Validated server-side by CloudWatch; malformed values surface as a downstream ValidationError rather than a local rejection.",
              ),
            label: z.string().optional().describe("Human-readable label for the series in the response."),
            returnData: z
              .boolean()
              .optional()
              .describe(
                "Set false to compute this query but not return its data (useful for intermediate values in expressions). Default true.",
              ),
            unit: z
              .string()
              .optional()
              .describe(
                "Restrict to a specific Unit (e.g. 'Seconds', 'Bytes'). Default: no filter. Only meaningful on metric-stat queries. Validated server-side by CloudWatch; malformed values surface as a downstream ValidationError rather than a local rejection.",
              ),
          }),
        )
        .min(1)
        .max(MAX_QUERIES)
        .describe(`1-${MAX_QUERIES} queries. Each is either a metric-stat (namespace + metricName) or an expression.`),
      startTime: z
        .string()
        .optional()
        .describe(
          "Relative shorthand ('15m', '1h', '1d', '1w'), 'now', or an ISO 8601 timestamp with an explicit offset ('2026-05-16T10:00:00Z', '2026-05-16T10:00:00-04:00'). A date-only '2026-05-16' is read as UTC midnight; an offset-less date-time is rejected (it would resolve in the server host's local zone). A bare number like '5' is rejected -- write '5m'. Default '1h' (one hour ago).",
        ),
      endTime: z
        .string()
        .optional()
        .describe(
          "Same forms as startTime: relative shorthand, 'now', or ISO 8601 with an explicit offset. Default 'now'.",
        ),
      scanBy: z
        .enum(["TimestampAscending", "TimestampDescending"])
        .optional()
        .describe("Sort order for returned datapoints. Default 'TimestampDescending' (matches CloudWatch's default)."),
      maxDataPoints: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Target datapoint count. CloudWatch does not truncate to the first N points -- it widens (coarsens) the period server-side so the series aggregates down to fit this many points. CloudWatch's own ceiling is ~100,800; lower this to make CloudWatch return a coarser, smaller series. Setting it also tells this tool the response is bounded, so a wide range or large batch that would otherwise be rejected locally against that ceiling is passed through (a value ABOVE the ceiling bounds nothing and is still rejected). Forwarded as CloudWatch's MaxDatapoints (single 'p') field; the camelCase schema name follows this server's convention.",
        ),
      nextToken: z
        .string()
        .optional()
        .describe(
          "Resume cursor from a previous call's `nextToken`. Omit for the first page. Forwarded as CloudWatch's NextToken; only meaningful when a prior call returned `hasMore: true`.",
        ),
      profile: z.string().optional().describe("Override session profile for this call."),
      region: z.string().optional().describe("Override session region for this call."),
      timeoutMs: z.number().int().positive().optional().describe("Timeout in milliseconds. Default 60000 (60s)."),
    }),
    handler: async (input: unknown): Promise<ToolResult> => {
      const i = input as {
        queries: MetricsQueryInput[];
        startTime?: string;
        endTime?: string;
        scanBy?: "TimestampAscending" | "TimestampDescending";
        maxDataPoints?: number;
        nextToken?: string;
        profile?: string;
        region?: string;
        timeoutMs?: number;
      };

      // Cross-field validation that zod can't express cleanly: per-query
      // "exactly one of (namespace+metricName) or expression" + statistic
      // shape check + id-uniqueness across the batch.
      const seenIds = new Map<string, number>();
      for (let qi = 0; qi < i.queries.length; qi++) {
        const q = i.queries[qi];
        const firstIdx = seenIds.get(q.id);
        if (firstIdx !== undefined) {
          return {
            ok: false,
            error: `Duplicate query id '${q.id}' at queries[${qi}]; first seen at queries[${firstIdx}]. Each MetricDataQuery.Id must be unique in a batch.`,
          };
        }
        seenIds.set(q.id, qi);

        const hasMetricStat = q.namespace !== undefined || q.metricName !== undefined || q.dimensions !== undefined;
        const hasExpression = q.expression !== undefined;
        if (hasMetricStat && hasExpression) {
          return {
            ok: false,
            error: `Query '${q.id}' mixes metric-stat fields (namespace/metricName/dimensions) with 'expression'. Pick one shape per query.`,
          };
        }
        if (!hasMetricStat && !hasExpression) {
          return {
            ok: false,
            error: `Query '${q.id}' has neither metric-stat (namespace+metricName) nor 'expression'. One is required.`,
          };
        }
        if (hasMetricStat && (q.namespace === undefined || q.metricName === undefined)) {
          return {
            ok: false,
            error: `Query '${q.id}' must include BOTH 'namespace' and 'metricName' (or use 'expression' instead).`,
          };
        }
        if (q.statistic !== undefined && !isValidStatistic(q.statistic)) {
          return {
            ok: false,
            error: `Query '${q.id}' has invalid statistic '${q.statistic}'. Use Average | Sum | Maximum | Minimum | SampleCount, or an extended stat like p99 / p99.9 / tm95.`,
          };
        }
      }

      const now = Date.now();
      const startStr = i.startTime ?? "1h";
      const endStr = i.endTime ?? "now";
      const startDate = resolveTime(startStr, now);
      const endDate = resolveTime(endStr, now);
      if (!startDate) {
        return {
          ok: false,
          error: `Invalid startTime '${startStr}'. Use relative shorthand ('15m', '1h', '1d', '1w'), 'now', or ISO 8601 WITH an explicit offset ('2026-05-16T10:00:00Z', '2026-05-16T10:00:00-04:00'); a date-only '2026-05-16' is read as UTC midnight. An offset-less date-time is rejected because it would be read in the host's local zone, and a bare number is rejected because Date reads it as a date, not a duration -- write '5m', not '5'.`,
        };
      }
      if (!endDate) {
        return {
          ok: false,
          error: `Invalid endTime '${endStr}'. Use 'now', relative shorthand ('15m', '1h', '1d', '1w'), or ISO 8601 WITH an explicit offset ('2026-05-16T10:00:00Z', '2026-05-16T10:00:00-04:00'); a date-only '2026-05-16' is read as UTC midnight. An offset-less date-time and a bare number are both rejected -- see startTime.`,
        };
      }
      if (endDate.getTime() <= startDate.getTime()) {
        return {
          ok: false,
          error: `endTime (${endDate.toISOString()}) must be after startTime (${startDate.toISOString()}).`,
        };
      }

      // Validate period + datapoint volume upfront so a bad request bounces
      // with an actionable message instead of CloudWatch's less-specific
      // downstream ValidationError. CLOUDWATCH_MAX_DATAPOINTS is a PER-REQUEST
      // cap, so this checks each query AND the sum across the batch, and it
      // checks the auto-picked period as well as explicit ones (the auto-pick
      // floors at 3600s, so it is not safe by construction for very wide
      // ranges).
      //
      // `callerCap` is the caller's own bound on the response (see the note on
      // CLOUDWATCH_MAX_DATAPOINTS): with maxDataPoints set, CloudWatch coarsens
      // the period and pages the rest, so no more than that many points come
      // back and the raw estimate is an over-count. Clamping to it on BOTH arms
      // -- per query and the batch aggregate -- means a bounded request is never
      // rejected on an estimate that cannot happen, while an unbounded one
      // (callerCap = Infinity, the clamp a no-op) still gets the hard rejection.
      // A maxDataPoints above the ceiling CloudWatch itself enforces clamps to a
      // still-over-cap number and correctly bounces here.
      const rangeSeconds = (endDate.getTime() - startDate.getTime()) / 1000;
      const periodSeconds = pickAutoPeriodSeconds(startDate.getTime(), endDate.getTime());
      const callerCap = i.maxDataPoints ?? Number.POSITIVE_INFINITY;
      const overCapHint =
        i.maxDataPoints !== undefined
          ? ` Note that maxDataPoints (${i.maxDataPoints}) is itself above the cap, so it does not bound this request below it.`
          : "";
      let totalDatapoints = 0;
      for (const q of i.queries) {
        if (q.period !== undefined && (q.period <= 0 || q.period % 60 !== 0)) {
          return {
            ok: false,
            error: `Query '${q.id}' has invalid period ${q.period}. CloudWatch requires period to be a positive multiple of 60 (seconds).`,
          };
        }
        // returnData:false computes an intermediate value for an expression
        // without returning a series, so it costs nothing against the cap.
        if (q.returnData === false) continue;
        const effectivePeriod = q.period ?? periodSeconds;
        const datapoints = Math.ceil(rangeSeconds / effectivePeriod);
        if (Math.min(datapoints, callerCap) > CLOUDWATCH_MAX_DATAPOINTS) {
          const periodPhrase =
            q.period !== undefined ? `period ${q.period}s` : `the auto-picked period ${effectivePeriod}s`;
          return {
            ok: false,
            error: `Query '${q.id}' with ${periodPhrase} over the requested range (${startDate.toISOString()} to ${endDate.toISOString()}) would request ${datapoints} datapoints, exceeding CloudWatch's per-request cap of ${CLOUDWATCH_MAX_DATAPOINTS}. Widen the period, narrow the time range, or set maxDataPoints to let CloudWatch coarsen the series for you.${overCapHint}`,
          };
        }
        totalDatapoints += datapoints;
      }
      if (Math.min(totalDatapoints, callerCap) > CLOUDWATCH_MAX_DATAPOINTS) {
        return {
          ok: false,
          error: `These ${i.queries.length} queries would request ${totalDatapoints} datapoints in a single GetMetricData call over the requested range (${startDate.toISOString()} to ${endDate.toISOString()}), exceeding CloudWatch's per-request cap of ${CLOUDWATCH_MAX_DATAPOINTS}. The cap applies to the whole request, not to each query. Widen the periods, narrow the time range, set maxDataPoints to let CloudWatch coarsen the series, or split the queries across calls.${overCapHint}`,
        };
      }

      const metricDataQueries = buildMetricDataQueries(i.queries, periodSeconds);

      const params: Record<string, unknown> = {
        MetricDataQueries: metricDataQueries,
        StartTime: startDate.toISOString(),
        EndTime: endDate.toISOString(),
        ScanBy: i.scanBy ?? "TimestampDescending",
      };
      if (i.maxDataPoints !== undefined) params.MaxDatapoints = i.maxDataPoints;
      if (i.nextToken !== undefined) params.NextToken = i.nextToken;

      // Mirror runAwsCall's resolution so the response echoes back the
      // EFFECTIVE profile/region the CLI was invoked with -- not the user's
      // raw input (which may be undefined). Same fallback chain as
      // runAwsCall in aws-cli.ts (opts override -> session -> env -> default).
      const effectiveProfile = i.profile ?? getProfile();
      const effectiveRegion = i.region ?? getRegion();

      const result = await runAwsCall({
        service: "cloudwatch",
        operation: "get-metric-data",
        profile: i.profile,
        region: i.region,
        timeoutMs: i.timeoutMs,
        outputFormat: "json",
        params,
      });

      if (!result.ok) {
        // `||`, not `??`: an empty-string rawStderr is not nullish, so `??`
        // would hand back "" instead of falling back to stdout.
        return { ok: false, error: result.error, rawBody: result.rawStderr || result.rawStdout };
      }

      const raw = (result.data ?? {}) as CloudWatchMetricDataResponse;
      // Echo each series' EFFECTIVE period by mapping it back to its input
      // query. The top-level `periodSeconds` only reflects the auto-pick; a
      // query that supplies its own `period` uses that instead, and without a
      // per-series period the caller can't tell the real granularity apart
      // from the auto-pick. Metric-stat queries without an explicit period
      // inherit the auto-pick; expression queries without one let CloudWatch
      // decide, so we emit nothing rather than a value that was never sent.
      const queryById = new Map(i.queries.map((q) => [q.id, q]));
      const series = (raw.MetricDataResults ?? []).map((r) => {
        // queryById.get(r.Id ?? '') silently resolves to undefined when r.Id is
        // absent, so effectivePeriod is also undefined and the `period` field is
        // omitted from that series entry. CloudWatch always echoes the Id field
        // in practice, so this case should not arise in production; the
        // fallthrough is intentional defense-in-depth rather than a silent bug.
        const q = queryById.get(r.Id ?? "");
        const effectivePeriod = q?.period ?? (q && q.expression === undefined ? periodSeconds : undefined);
        return {
          id: r.Id ?? "",
          ...(r.Label !== undefined ? { label: r.Label } : {}),
          timestamps: r.Timestamps ?? [],
          values: r.Values ?? [],
          ...(effectivePeriod !== undefined ? { period: effectivePeriod } : {}),
          ...(r.StatusCode !== undefined ? { statusCode: r.StatusCode } : {}),
        };
      });
      const messages = raw.Messages?.filter((m) => m.Code || m.Value).map((m) => ({
        code: m.Code,
        value: m.Value,
      }));
      const nextToken = extractNextToken(raw);

      return {
        ok: true,
        data: {
          command: result.command,
          profile: effectiveProfile,
          region: effectiveRegion,
          startTime: startDate.toISOString(),
          endTime: endDate.toISOString(),
          periodSeconds,
          series,
          nextToken,
          hasMore: nextToken !== null,
          ...(messages && messages.length > 0 ? { messages } : {}),
        },
      };
    },
  },
];
