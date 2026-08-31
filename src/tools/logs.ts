import { z } from "zod";
import { runAwsCall } from "../aws-cli.js";
import type { Tool, ToolResult } from "./tool.js";

/**
 * `aws logs tail` is a high-level CLI wrapper, not a raw API op. Its flags
 * use kebab-case (--since, --filter-pattern) instead of --cli-input-json
 * PascalCase, so we build argv explicitly via runAwsCall's extraFlags.
 *
 * Safety: every flag value we append was either a fixed literal ("--format"),
 * a Zod-validated enum, or a number we stringified. User-supplied free text
 * (filterPattern, logStreamNames) goes in as individual argv entries and
 * doesn't pass through a shell -- argv injection is blocked the same way
 * runAwsCall blocks it for API params.
 */

/**
 * Relative-time vocabulary, defined here and SHARED with aws_metrics_query.
 *
 * `aws logs tail --since` is where the vocabulary comes from: lowercase units
 * only -- the CLI rejects uppercase (15M, 2H, ...), so accepting them at the
 * schema level would Zod-OK an input the CLI then errors on. metrics.ts mirrors
 * the same shorthand so an agent learns it once, and IMPORTS these rather than
 * re-declaring them: the pattern used to exist byte-identically in both files,
 * which is the drift risk multi-region.ts already removed by centralizing its
 * region regex in session.ts.
 */
const RELATIVE_TIME_RE = /^\d+[smhdw]$/;
const RELATIVE_TIME_UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Convert a RELATIVE_TIME_RE-shaped string ("15m", "2h", "1w") to milliseconds.
 * Returns null when the input isn't that shape -- callers decide whether that
 * means "reject" (logs' `since`) or "try the next format" (metrics' ISO branch).
 */
function relativeTimeMs(input: string): number | null {
  if (!RELATIVE_TIME_RE.test(input)) return null;
  const num = Number(input.slice(0, -1));
  const ms = RELATIVE_TIME_UNIT_MS[input.slice(-1)];
  if (ms === undefined || !Number.isFinite(num)) return null;
  return num * ms;
}

// `aws logs tail` drains FilterLogEvents internally -- it keeps paging until the
// requested window is exhausted. Nothing stops a wide window early: the 60s
// timeout and the 5MB stdout cap both fire AFTER those API calls are spent, and
// both surface as an ERROR, so the caller pays for the whole scan and gets
// nothing back. The schema shape alone accepts '520w' (a 10-year scan), so bound
// the window here. 30 days comfortably covers the documented vocabulary ('1w',
// '3d') while rejecting the fat-fingered case.
const MAX_SINCE_MS = 30 * 24 * 60 * 60 * 1000;

// AWS log group names: [.\-_/#A-Za-z0-9]+ (length 1-512). We additionally
// disallow a leading hyphen so an input like "--force" can't masquerade as
// a flag when we append it to argv.
const LOG_GROUP_RE = /^[.A-Za-z0-9_/#][.\-_/#A-Za-z0-9]{0,511}$/;
// A log-group ARN -- 'arn:aws:logs:<region>:<account>:log-group:<name>', with
// the optional ':*' suffix the console's copy button and IAM policies carry.
// LOG_GROUP_RE (correctly) rejects ':', so a pasted ARN used to bounce with a
// shape error even though the group it names is perfectly valid. Capture the
// name so the handler can hand the CLI the bare positional it actually wants.
const LOG_GROUP_ARN_RE = /^arn:[a-z0-9-]{1,32}:logs:[a-z0-9-]{1,32}:[0-9]{12}:log-group:([^:*\s]{1,512})(?::\*)?$/;

/**
 * Resolve a caller-supplied log group to the bare name `aws logs tail` takes as
 * its positional argument. Accepts either a bare group name or a log-group ARN;
 * returns null when neither shape validates (the extracted ARN name is held to
 * the same LOG_GROUP_RE argv-safety contract as a directly-supplied name).
 */
function resolveLogGroupName(input: string): string | null {
  const arn = input.match(LOG_GROUP_ARN_RE);
  const name = arn ? arn[1] : input;
  return LOG_GROUP_RE.test(name) ? name : null;
}
// AWS log stream names: 1-512 chars, ':' and '*' disallowed by AWS. We also
// reject leading '-' (argv-injection defense) and ASCII control characters.
// Real-world stream names include slashes and brackets, e.g.
// '2026/04/21/[$LATEST]abc' for Lambda -- those must still match.
//
// Embedded spaces ARE intentionally allowed here. AWS CreateLogStream's own
// pattern is [^:*]*, which permits spaces. Our validator's job is
// argv-safety (block leading '-', block ':' and '*', block control chars),
// not strict AWS-name validity. A "stream with space" is a legal stream name.
const LOG_STREAM_NAME_RE = /^[^-:*\s][^:*]{0,511}$/;

/**
 * Validate a log stream name. Combines LOG_STREAM_NAME_RE (structural shape)
 * with a control-character check that would otherwise require escapes Biome
 * rejects in regex literals.
 */
export function isValidLogStreamName(name: string): boolean {
  if (!LOG_STREAM_NAME_RE.test(name)) return false;
  for (let i = 0; i < name.length; i++) {
    if (name.charCodeAt(i) < 0x20) return false;
  }
  return true;
}

/**
 * `aws logs tail --format json` emits NDJSON (one event per line), not a
 * single JSON array. Normalize to an array regardless of how many events
 * landed:
 *
 *   - null / undefined / empty string -> []
 *   - already-parsed array           -> returned as-is
 *   - already-parsed single object   -> [object]  (runAwsCall's JSON.parse
 *                                                   will succeed when there's
 *                                                   exactly one event)
 *   - NDJSON string                  -> split lines, parse each, return array
 *   - any line fails to parse        -> return the raw string unchanged, as a
 *                                       diagnosis signal; callers render it as
 *                                       eventCount=null to flag the failure
 */
function parseLogsJsonOutput(raw: unknown): unknown[] | string {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object") return [raw];
  if (typeof raw !== "string") return [raw];

  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const events: unknown[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      return raw; // one bad line: give up and return the unparsed blob
    }
  }
  return events;
}

export const logsTools: readonly Tool[] = [
  {
    name: "aws_logs_tail",
    description:
      "Tail CloudWatch Logs for a log group. Wraps 'aws logs tail' (not the raw FilterLogEvents API) so you get the same server-side time parsing and event-grouping the CLI uses. Returns recent events as JSON. Does NOT stream -- run once to fetch the window, then call again with a later `since`. For long windows (> a few hundred events), narrow via `filterPattern` or lower `since`.",
    annotations: {
      title: "Fetch recent CloudWatch Logs events for a log group",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      logGroupName: z
        .string()
        .min(1)
        .describe(
          "Log group name, e.g. '/aws/lambda/my-fn' or '/aws/ecs/my-service' (no leading 'logs/'). A full log-group ARN ('arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/my-fn', with or without a trailing ':*') is also accepted -- the group name is extracted from it.",
        ),
      since: z
        .string()
        .regex(RELATIVE_TIME_RE, "since must match /^\\d+[smhdw]$/ (lowercase units only), e.g. '5m', '2h', '1d'")
        .optional()
        .describe(
          `Window to tail: '<number><s|m|h|d|w>'. Default '10m'. Example: '30m', '1h', '3d'. Must be greater than zero and at most ${MAX_SINCE_MS / 86_400_000} days -- 'aws logs tail' drains the whole window server-side.`,
        ),
      filterPattern: z
        .string()
        .optional()
        .describe(
          "CloudWatch Logs filter pattern. E.g. 'ERROR', '\"stack trace\"', '[timestamp, request_id, level = ERROR, ...]'.",
        ),
      logStreamNames: z
        .array(z.string().min(1))
        .optional()
        .describe("Restrict to specific stream names. Overrides the default (all streams in the group)."),
      logStreamNamePrefix: z
        .string()
        .optional()
        .describe("Restrict to streams with this prefix. Mutually exclusive with logStreamNames."),
      profile: z.string().optional().describe("Override session profile for this call."),
      region: z.string().optional().describe("Override session region for this call."),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Timeout in milliseconds. Default 60000 (60s). Raise for large windows."),
    }),
    handler: async (input: unknown): Promise<ToolResult> => {
      const i = input as {
        logGroupName: string;
        since?: string;
        filterPattern?: string;
        logStreamNames?: string[];
        logStreamNamePrefix?: string;
        profile?: string;
        region?: string;
        timeoutMs?: number;
      };

      // Accepts a bare name or a log-group ARN; everything downstream (argv,
      // the echoed response field) uses the resolved bare name.
      const logGroupName = resolveLogGroupName(i.logGroupName);
      if (logGroupName === null) {
        return {
          ok: false,
          error: `Invalid logGroupName '${i.logGroupName}'. Pass a bare group name -- starting with alphanumeric/dot/slash/underscore/hash and containing only [.\\-_/#A-Za-z0-9] -- or a full log-group ARN like 'arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/my-fn' (an optional trailing ':*' is allowed).`,
        };
      }

      // `since` shape is enforced by the schema, but the WINDOW it describes is
      // not: '520w' and '0m' both match /^\d+[smhdw]$/. Bound both ends here.
      // relativeTimeMs returns null only for a shape the regex rejects, which
      // the handler can still see when a caller reaches it without the schema.
      const since = i.since ?? "10m";
      const sinceMs = relativeTimeMs(since);
      if (sinceMs === null) {
        return {
          ok: false,
          error: `Invalid since '${since}'. Use '<number><s|m|h|d|w>' with a lowercase unit, e.g. '5m', '2h', '1d'.`,
        };
      }
      if (sinceMs <= 0) {
        return {
          ok: false,
          error: `Invalid since '${since}': a zero-width window always returns zero events, which is indistinguishable from 'the log group is quiet'. Use a positive window, e.g. '5m'.`,
        };
      }
      if (sinceMs > MAX_SINCE_MS) {
        return {
          ok: false,
          error: `since '${since}' asks for a ${Math.round(sinceMs / 86_400_000)}-day window; the maximum is ${MAX_SINCE_MS / 86_400_000} days. 'aws logs tail' drains the whole window server-side, so a request this wide spends every FilterLogEvents call and then fails on the 60s timeout or the 5 MB output cap instead of returning events. Narrow the window, or add a filterPattern and tail it in slices.`,
        };
      }
      if (i.logStreamNames && i.logStreamNamePrefix) {
        return {
          ok: false,
          error: "Pass either logStreamNames or logStreamNamePrefix, not both (mirrors aws CLI).",
        };
      }
      if (i.logStreamNames) {
        for (const name of i.logStreamNames) {
          if (!isValidLogStreamName(name)) {
            return {
              ok: false,
              error: `Invalid logStreamName '${name}'. Must be 1-512 chars, not start with '-', and contain no ':', '*', or control characters.`,
            };
          }
        }
      }
      // A prefix is a partial stream name, so the same validator applies:
      // reject a leading hyphen (argv-injection defense -- the value is
      // appended after --log-stream-name-prefix as its own argv entry),
      // control characters, and the AWS-forbidden ':'/'*'. A legitimate
      // prefix like '2026/04/21/' passes cleanly.
      if (i.logStreamNamePrefix && !isValidLogStreamName(i.logStreamNamePrefix)) {
        return {
          ok: false,
          error: `Invalid logStreamNamePrefix '${i.logStreamNamePrefix}'. Must be 1-512 chars, not start with '-', and contain no ':', '*', or control characters.`,
        };
      }
      // Argv-injection defense for filterPattern: the value lands as its own
      // argv entry after --filter-pattern, which CloudWatch consumes as the
      // pattern itself (so a leading '-' is not actually exploitable here).
      // The reject still matches the uniform leading-hyphen guard the
      // file-level comment promises, and a real CloudWatch filter pattern
      // never legitimately starts with '-' -- patterns either start with a
      // quote, a literal word, or '[' for structured matching.
      if (i.filterPattern?.startsWith("-")) {
        return {
          ok: false,
          error: "Invalid filterPattern: must not start with '-'.",
        };
      }

      // aws logs tail expects the log group name as a positional before any
      // flags. We inject it as the first entry of extraFlags so runAwsCall
      // places it between the operation ('tail') and --format/--since/etc.
      // The leading-hyphen defense above blocks argv injection.
      const extraFlags: string[] = [logGroupName, "--format", "json", "--since", since];
      if (i.filterPattern) extraFlags.push("--filter-pattern", i.filterPattern);
      if (i.logStreamNames && i.logStreamNames.length > 0) {
        extraFlags.push("--log-stream-names", ...i.logStreamNames);
      }
      if (i.logStreamNamePrefix) {
        extraFlags.push("--log-stream-name-prefix", i.logStreamNamePrefix);
      }

      // outputFormat:'json' causes runAwsCall to append '--output json' to
      // the argv. 'aws logs tail' ignores '--output' entirely (it is a
      // high-level command that always writes its own NDJSON; the standard
      // '--output' flag has no effect). The flag is a no-op here, not a
      // conflict -- the actual JSON shaping comes from '--format json' in
      // extraFlags above.
      const result = await runAwsCall({
        service: "logs",
        operation: "tail",
        profile: i.profile,
        region: i.region,
        timeoutMs: i.timeoutMs,
        outputFormat: "json",
        // `aws logs tail --format json` emits one JSON object PER LINE, so the
        // whole blob never parses as a single document. Declaring it here keeps
        // runAwsCall's truncated-payload check from reading a complete multi-
        // event tail as a corrupted one.
        ndjson: true,
        extraFlags,
      });

      if (!result.ok) {
        // `||`, not `??`: rawStderr is "" (not nullish) on a nonzero exit with
        // empty stderr, and `??` would return that "" instead of falling back
        // to stdout. Same fix as call.ts and the resource.ts failure returns.
        return { ok: false, error: result.error, rawBody: result.rawStderr || result.rawStdout };
      }
      // runAwsCall already tried JSON.parse on the whole stdout; for a single
      // event that succeeds and data is an object, for multiple events it
      // fails and data is the raw NDJSON string. parseLogsJsonOutput collapses
      // both into an array (or a raw-string escape hatch when any line is
      // malformed).
      const parsed = parseLogsJsonOutput(result.data);
      const events = parsed;
      const eventCount = Array.isArray(parsed) ? parsed.length : null;
      return {
        ok: true,
        data: {
          command: result.command,
          // The RESOLVED group name, so an ARN-shaped input echoes back the
          // name that was actually tailed (and matches `command`).
          logGroupName,
          since,
          eventCount,
          events,
        },
      };
    },
  },
];

// Exported for tests, plus the relative-time vocabulary metrics.ts imports
// (RELATIVE_TIME_RE / RELATIVE_TIME_UNIT_MS / relativeTimeMs) so the shorthand
// is defined once for both tools.
export {
  LOG_GROUP_ARN_RE,
  LOG_GROUP_RE,
  LOG_STREAM_NAME_RE,
  MAX_SINCE_MS,
  parseLogsJsonOutput,
  RELATIVE_TIME_RE,
  RELATIVE_TIME_UNIT_MS,
  relativeTimeMs,
  resolveLogGroupName,
};
