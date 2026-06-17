import { z } from "zod";
import { runAwsCall } from "../aws-cli.js";
import { getProfile, getRegion } from "../session.js";
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

// CloudWatch caps a single GetMetricData response at ~100,800 datapoints per
// request (1,440 points/day over 70 days). When a caller supplies an explicit
// `period`, we validate datapoint-count upfront so an over-the-cap period+range
// bounces with an actionable message instead of CloudWatch's less-specific
// downstream ValidationError. The auto-pick path (pickAutoPeriodSeconds) is
// already capped well under this by construction, so we only check explicit
// periods. CloudWatch also requires `period` to be a positive multiple of 60.
const CLOUDWATCH_MAX_DATAPOINTS = 100_800;

// Pick a sane period granularity scaled to the requested range so a wide
// window doesn't default to a needlessly fine resolution: minutes for a few
// hours, coarser steps as the range grows to days/weeks. The tiers stay well
// short of CloudWatch's per-request datapoint ceiling -- they exist to give a
// useful default shape (someone asking for 7 days almost never wants 1s
// points), not to defend against that cap.
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

// Mirrors the relative-time vocab used by aws_logs_tail's `since` flag so
// agents only learn it once. "5m" / "2h" / "1d" / "1w" relative to "now"
// when used as startTime; endTime defaults to "now" if omitted.
const RELATIVE_TIME_RE = /^\d+[smhdw]$/;
const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Resolve a startTime / endTime input (ISO 8601 or relative like "1h") to
 * a Date. Relative values are interpreted as "ago" relative to `now`; ISO
 * values are parsed verbatim. Returns null on parse failure.
 */
export function resolveTime(input: string, now: number): Date | null {
  if (input === "now") return new Date(now);
  const rel = input.match(RELATIVE_TIME_RE);
  if (rel) {
    const num = Number(input.slice(0, -1));
    const unit = input.slice(-1);
    const ms = UNIT_MS[unit];
    if (!ms || !Number.isFinite(num)) return null;
    return new Date(now - num * ms);
  }
  const t = new Date(input);
  if (Number.isNaN(t.getTime())) return null;
  return t;
}

/** Per-query input from the MCP caller. PascalCase fields land in CloudWatch's
 * MetricDataQueries shape; we keep the wire schema camelCase to match every
 * other tool in this server. */
export interface MetricsQueryInput {
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
      "Query CloudWatch metrics via GetMetricData (the modern multi-metric / expression-capable API, not the legacy get-metric-statistics). Pass `queries` as a flat array of {id, namespace, metricName, dimensions?, statistic?, period?, expression?, label?}; the tool shapes them into MetricDataQueries for you. `startTime`/`endTime` accept ISO 8601 or relative shorthand ('15m', '1h', '1d', '1w'); endTime defaults to 'now'. Period is auto-picked from the time range when omitted (60s for <=3h, 300s for <=24h, 900s for <=15d, 3600s otherwise) to stay under CloudWatch's ~100,800-datapoint response cap. Returns {series: [{id, label?, timestamps, values, period?, statusCode?}], messages?, periodSeconds, profile, region, nextToken, hasMore}. Each series' `period` is the effective granularity for that query (its explicit period, or the auto-pick it inherited); it is omitted for an expression query that didn't set one. The top-level `periodSeconds` is always the auto-pick. When CloudWatch truncates a large response, `hasMore` is true and `nextToken` carries the resume cursor -- call again with `nextToken` set to fetch the next page (rare for typical agent queries that stay within the per-request cap). Use for 'show me the CPU on this instance for the last hour', 'sum lambda invocations across these 3 functions', or expression-based 'p99 latency divided by average latency' lookups.",
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
        .describe("ISO 8601 timestamp or relative shorthand ('15m', '1h', '1d', '1w'). Default '1h' (one hour ago)."),
      endTime: z.string().optional().describe("ISO 8601 timestamp or relative shorthand. Default 'now'."),
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
          "Target datapoint count. CloudWatch does not truncate to the first N points -- it widens (coarsens) the period server-side so the series aggregates down to fit this many points. CloudWatch's own ceiling is ~100,800; lower this to make CloudWatch return a coarser, smaller series. Forwarded as CloudWatch's MaxDatapoints (single 'p') field; the camelCase schema name follows this server's convention.",
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
          error: `Invalid startTime '${startStr}'. Use ISO 8601 (e.g. '2026-05-16T10:00:00Z') or relative shorthand (e.g. '1h', '15m', '1d').`,
        };
      }
      if (!endDate) {
        return {
          ok: false,
          error: `Invalid endTime '${endStr}'. Use ISO 8601 or relative shorthand, or 'now' for the current moment.`,
        };
      }
      if (endDate.getTime() <= startDate.getTime()) {
        return {
          ok: false,
          error: `endTime (${endDate.toISOString()}) must be after startTime (${startDate.toISOString()}).`,
        };
      }

      // Validate any EXPLICITLY-supplied per-query period upfront so a bad
      // period bounces with an actionable message instead of CloudWatch's
      // less-specific downstream ValidationError. Only the explicit-period
      // path is checked here; the auto-pick path (pickAutoPeriodSeconds) is
      // capped safe by construction.
      const rangeSeconds = (endDate.getTime() - startDate.getTime()) / 1000;
      for (const q of i.queries) {
        if (q.period === undefined) continue;
        if (q.period <= 0 || q.period % 60 !== 0) {
          return {
            ok: false,
            error: `Query '${q.id}' has invalid period ${q.period}. CloudWatch requires period to be a positive multiple of 60 (seconds).`,
          };
        }
        const datapoints = Math.ceil(rangeSeconds / q.period);
        if (datapoints > CLOUDWATCH_MAX_DATAPOINTS) {
          return {
            ok: false,
            error: `Query '${q.id}' with period ${q.period}s over the requested range (${startDate.toISOString()} to ${endDate.toISOString()}) would request ${datapoints} datapoints, exceeding CloudWatch's per-request cap of ${CLOUDWATCH_MAX_DATAPOINTS}. Widen the period or narrow the time range.`,
          };
        }
      }

      const periodSeconds = pickAutoPeriodSeconds(startDate.getTime(), endDate.getTime());
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
        return { ok: false, error: result.error, rawBody: result.rawStderr ?? result.rawStdout };
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
