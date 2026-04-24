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

const SINCE_RE = /^\d+[smhdw]$/i;
// AWS log group names: [.\-_/#A-Za-z0-9]+ (length 1-512). We additionally
// disallow a leading hyphen so an input like "--force" can't masquerade as
// a flag when we append it to argv.
const LOG_GROUP_RE = /^[.A-Za-z0-9_/#][.\-_/#A-Za-z0-9]{0,511}$/;
// AWS log stream names: 1-512 chars, ':' and '*' disallowed by AWS. We also
// reject leading '-' (argv-injection defense) and ASCII control characters.
// Real-world stream names include slashes and brackets, e.g.
// '2026/04/21/[$LATEST]abc' for Lambda — those must still match.
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
        .describe("Log group name, e.g. '/aws/lambda/my-fn' or '/aws/ecs/my-service'. No leading 'logs/'."),
      since: z
        .string()
        .regex(SINCE_RE, "since must match /^\\d+[smhdw]$/i, e.g. '5m', '2h', '1d'")
        .optional()
        .describe("Window to tail: '<number><s|m|h|d|w>'. Default '10m'. Example: '30m', '1h', '3d'."),
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

      if (!LOG_GROUP_RE.test(i.logGroupName)) {
        return {
          ok: false,
          error: `Invalid logGroupName '${i.logGroupName}'. Must start with alphanumeric/dot/slash/underscore/hash and contain only [.\\-_/#A-Za-z0-9].`,
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

      // aws logs tail expects the log group name as a positional before any
      // flags. We inject it as the first entry of extraFlags so runAwsCall
      // places it between the operation ('tail') and --format/--since/etc.
      // The leading-hyphen defense above blocks argv injection.
      const extraFlags: string[] = [i.logGroupName, "--format", "json", "--since", i.since ?? "10m"];
      if (i.filterPattern) extraFlags.push("--filter-pattern", i.filterPattern);
      if (i.logStreamNames && i.logStreamNames.length > 0) {
        extraFlags.push("--log-stream-names", ...i.logStreamNames);
      }
      if (i.logStreamNamePrefix) {
        extraFlags.push("--log-stream-name-prefix", i.logStreamNamePrefix);
      }

      const result = await runAwsCall({
        service: "logs",
        operation: "tail",
        profile: i.profile,
        region: i.region,
        timeoutMs: i.timeoutMs,
        outputFormat: "json",
        extraFlags,
      });

      if (!result.ok) {
        return { ok: false, error: result.error, rawBody: result.rawStderr ?? result.rawStdout };
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
          logGroupName: i.logGroupName,
          since: i.since ?? "10m",
          eventCount,
          events,
        },
      };
    },
  },
];

// Exported for tests.
export { LOG_GROUP_RE, LOG_STREAM_NAME_RE, parseLogsJsonOutput };
