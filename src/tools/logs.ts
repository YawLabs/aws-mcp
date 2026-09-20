import { z } from "zod";
import {
  type AwsCallFailure,
  type AwsCallFailureKind,
  type AwsCallResult,
  runAwsCall,
  truncateForErrorMsg,
} from "../aws-cli.js";
import { getProfile, getRegion } from "../session.js";
import { sleepUnlessAborted } from "./resource.js";
import type { Tool, ToolContext, ToolResult } from "./tool.js";

/**
 * aws_logs_tail calls the FilterLogEvents API through `aws logs filter-log-events`
 * -- the same API `aws logs tail` calls, without its formatter in the way.
 *
 * Why not `aws logs tail --format json`, which this tool wrapped until 2.4.0: that
 * flag selects a PRETTY-PRINT formatter (awscli customizations/logs/tail.py,
 * byte-identical from 2.34.3 to v2 head), not NDJSON. It writes
 * `<iso-timestamp> <stream> <message>` per event and re-indents a message that is
 * entirely JSON across several lines, so the text cannot be split back into
 * events: a message beginning with a timestamp reads as a new event, a stream name
 * with a space cannot be told from the message after it, continuation lines carry
 * no prefix, and a JSON message has been re-serialized. `tail` also has no
 * newest-first and no limit, so it always drained the whole window.
 *
 * How a read works now. Every caller value travels INSIDE --cli-input-json, in
 * the API's own camelCase, where the CLI passes it through literally -- so no
 * caller value is an argv entry whose `file://` prefix the CLI would expand. A
 * fixed --query projects `{total, events[].{timestamp, logStreamName, message}}`,
 * which bounds stdout. There are two read modes (TailReadMode): newest-first,
 * which sends FilterLogEvents' `startFromHead: false` and stops after maxEvents,
 * and a whole-window read for CLIs that reject that member -- recognized from the
 * rejection itself (detectFleModelGaps) -- or endpoints that accept it and page
 * ascending anyway (fetchIgnoredStartFromHead). Page size goes through --page-size
 * and never through the payload: `limit` or `nextToken` in --cli-input-json turns
 * the CLI's own pagination off and makes the call fail. An EMPTY logStreamNames or
 * logStreamNamePrefix is never sent either -- botocore refuses both before the
 * request.
 *
 * Safety: the remaining argv values this file builds are a fixed literal
 * (--page-size, --max-items) or a number it stringified, and runAwsCall refuses a
 * `file://` extraFlags value from any tool as a backstop.
 */

/**
 * Relative-time vocabulary, defined here and SHARED with aws_metrics_query.
 *
 * `aws logs tail --since` is where the vocabulary comes from: lowercase units
 * only -- the CLI rejects uppercase (15M, 2H, ...), so accepting them at the
 * schema level would have Zod-OK'd an input the CLI then errored on. aws_logs_tail
 * now resolves the window itself and sends an epoch-millisecond startTime, so
 * nothing downstream parses these strings any more; the vocabulary is kept
 * unchanged so an existing input still means what it meant. metrics.ts mirrors
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

// A window this tool cannot pay for. The newest-first read stops after maxEvents,
// but a filterPattern that rarely matches still pages back through everything,
// and the whole-window read (old CLIs, endpoints that ignore startFromHead) always
// does -- and the 60s timeout and the 5MB stdout cap both fire AFTER those API
// calls are spent, so the caller pays for the scan and gets an error. The schema
// shape alone accepts '520w' (a 10-year scan), so bound the window here. 30 days
// comfortably covers the documented vocabulary ('1w', '3d') while rejecting the
// fat-fingered case.
const MAX_SINCE_MS = 30 * 24 * 60 * 60 * 1000;

// --- moved verbatim from metrics.ts, see the note left in its place there ---

// A bare number is the trap this rejects. "5" fails RELATIVE_TIME_RE (no unit)
// and would fall through to `new Date("5")`, which V8 reads as 2001-05-01 -- a
// dropped unit silently becomes a 25-year window with nothing rejecting it
// locally. Neither reading ("5 minutes"? "the year 5"?) is safe to guess.
const BARE_NUMBER_RE = /^\d+(?:\.\d+)?$/;

// ISO 8601 shapes we accept, and why the offset is mandatory: `new Date()`
// parses a DATE-ONLY string as UTC but a DATE-TIME without an offset as LOCAL
// time. The handler then serializes the result into the request, so
// "2026-05-16T10:00:00" -- which the tool descriptions call ISO 8601 --
// silently shifts the window by the host's UTC offset, and the same call means
// different things on a laptop and a container. Requiring an explicit offset (Z
// or +/-HH:MM) makes the window host-independent; date-only stays accepted
// because its UTC interpretation is unambiguous.
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
 *
 * Shared by aws_metrics_query (which re-exports it under its old name) and
 * aws_logs_query, so the two observability tools take the same window vocabulary.
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

// A busy group returns tens of thousands of events in an hour, and nothing between
// the API and the caller counts them. Bound what the caller receives. 500 sits just
// above the "a few hundred events" this tool's own description names as the point
// where a window gets unwieldy, and at a typical 200-400 bytes per JSON event it
// puts a full response in the low hundreds of KB. The ceiling is the 10,000
// aws_paginate already allows for one page -- the same "the caller explicitly asked
// for a lot" bound, one number across the two tools that return lists.
//
// What the cap bounds depends on the read mode. On a CLI that has FilterLogEvents'
// startFromHead (START_FROM_HEAD_MIN_CLI) it bounds the SCAN too: the read asks for
// maxEvents + 1 events newest-first and stops. On any CLI the --query slice bounds
// stdout, so even a whole-window read of a busy hour no longer trips runAwsCall's
// 5 MB cap -- but it still spends every FilterLogEvents call, so narrowing `since`
// or adding a `filterPattern` is what makes that CALL cheaper.
const DEFAULT_MAX_EVENTS = 500;
const MAX_MAX_EVENTS = 10_000;

// AWS log group names: [.\-_/#A-Za-z0-9]+ (length 1-512). We additionally
// disallow a leading hyphen so an input like "--force" can't masquerade as
// a flag when we append it to argv.
const LOG_GROUP_RE = /^[.A-Za-z0-9_/#][.\-_/#A-Za-z0-9]{0,511}$/;
// A log-group ARN -- 'arn:aws:logs:<region>:<account>:log-group:<name>', with
// the optional ':*' suffix the console's copy button and IAM policies carry.
// LOG_GROUP_RE (correctly) rejects ':', so a pasted ARN used to bounce with a
// shape error even though the group it names is perfectly valid. Capture group 1
// is the name: aws_logs_query reads it through resolveLogGroupName below, and
// aws_logs_tail reads the whole ARN through parseLogGroupArn.
const LOG_GROUP_ARN_RE = /^arn:[a-z0-9-]{1,32}:logs:[a-z0-9-]{1,32}:[0-9]{12}:log-group:([^:*\s]{1,512})(?::\*)?$/;

/**
 * Resolve a caller-supplied log group to a bare group NAME, discarding an ARN's
 * account and region. Accepts either a bare group name or a log-group ARN; returns
 * null when neither shape validates (the extracted ARN name is held to the same
 * LOG_GROUP_RE argv-safety contract as a directly-supplied name).
 *
 * aws_logs_query's path, which sends bare names. aws_logs_tail uses
 * parseLogGroupArn instead, so an ARN there addresses the group it actually names.
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
 * The AWS CLI releases that decide which FilterLogEvents members can be sent.
 * Message text only -- nothing here is ever compared against a version, because
 * the CLI's own rejection is the ground truth (see detectFleModelGaps).
 */
export const START_FROM_HEAD_MIN_CLI = "2.35.8";
export const LOG_GROUP_IDENTIFIER_MIN_CLI = "2.9.15";

// FilterLogEvents' EventsLimit maximum, and so the ceiling on --page-size.
const FLE_MAX_PAGE_SIZE = 10_000;

export interface LogGroupArnParts {
  partition: string;
  region: string;
  account: string;
  name: string;
  /** The ARN as FilterLogEvents wants it: no trailing ':*'. */
  identifier: string;
}

/**
 * Split a log-group ARN into the parts the request needs, or null when the input
 * is not one (a bare name included).
 *
 * Built on the UNCHANGED LOG_GROUP_ARN_RE plus split(':'), deliberately: the
 * regex's capture group 1 is the group name, aws_logs_query resolves its own
 * input through resolveLogGroupName, and a named-group rewrite would have moved
 * that capture index under the other tool's feet. The name is held to the same
 * LOG_GROUP_RE contract as a directly supplied one, so a hostile name inside a
 * well-formed ARN is still not an ARN here.
 */
export function parseLogGroupArn(input: string): LogGroupArnParts | null {
  const m = input.match(LOG_GROUP_ARN_RE);
  if (!m) return null;
  const name = m[1];
  if (!LOG_GROUP_RE.test(name)) return null;
  // Positions are fixed by the regex, which rejects ':' inside the name.
  const parts = input.split(":");
  const [, partition, , region, account] = parts;
  return {
    partition,
    region,
    account,
    name,
    identifier: `arn:${partition}:logs:${region}:${account}:log-group:${name}`,
  };
}

/**
 * How one read asks the service for the window.
 *
 * `newest-first` sends `startFromHead: false` and stops after maxEvents + 1
 * events; `full-window` sends no such member and reads every page, which is what
 * a CLI older than START_FROM_HEAD_MIN_CLI -- or an endpoint that ignores the
 * member -- leaves as the only correct option.
 */
export type TailReadMode = "newest-first" | "full-window";

/**
 * The --query projection, which does three jobs: it bounds stdout (a
 * 2,000-event window measured 780 KB unprojected, 130 KB through the
 * whole-window form), it drops eventId, ingestionTime and the deprecated
 * searchedLogStreams, and its `total` keeps the window's real size on the
 * full-window path even though `events` carries only the newest maxEvents.
 *
 * `total` counts what the CLI FETCHED, which is the whole window on the
 * full-window path and at most maxEvents + 1 on the newest-first one (measured:
 * an 8-event window with `--max-items 4` answers `total: 4`). Both forms stay
 * around 130 characters (130 and 135), far below runAwsCall's 2,048-character
 * --query cap.
 *
 * `events || `[]`` in BOTH members, because a reply that omits `events`
 * otherwise fails the whole call: JMESPath's length() raises on a null operand,
 * so `length(events)` printed `In function length(), invalid type for value:
 * None` and exit 255 -- measured on 2.34.3 and 2.22.0 against a loopback stub
 * answering `{"searchedLogStreams": []}`. Real CloudWatch Logs and moto both
 * send `events: []`, so the reachable population is a compatible endpoint
 * behind AWS_ENDPOINT_URL, but the projection is ours and an empty window is
 * the one case this tool always got right. Defaulting `total` alone is not
 * enough: a slice of null yields null rather than erroring, so `events` came
 * back `null` (exit 0) and parseTailOutput's deliberate strictness then
 * reported it as stdout that was not the document asked for.
 */
export function buildTailQuery(mode: TailReadMode, maxEvents: number): string {
  const slice = mode === "newest-first" ? "" : `-${maxEvents}:`;
  return `{total: length(events || \`[]\`), events: (events || \`[]\`)[${slice}].{timestamp: timestamp, logStreamName: logStreamName, message: message}}`;
}

/**
 * The --cli-input-json payload. Every caller-supplied value travels in here,
 * where the CLI passes it through literally -- the reason filterPattern is no
 * longer an argv entry the CLI's paramfile loader would expand.
 *
 * What is deliberately absent, each verified on aws-cli 2.34.3 and 2.22.0
 * against a loopback stub:
 *   - `limit` and `nextToken`: either one turns the CLI's own pagination off
 *     (awscli customizations/paginate.py
 *     check_should_enable_pagination_call_parameters), and with --max-items the
 *     PaginationConfig then leaks into the request and the call dies with
 *     `Unknown parameter in input: "PaginationConfig"`. Page size goes through
 *     --page-size only.
 *   - an EMPTY `logStreamNames` or `logStreamNamePrefix`: botocore refuses both
 *     client-side (`Invalid length for parameter logStreamNames, value: 0, valid
 *     min length: 1`, exit 252, nothing sent), and the schema accepts `[]` and
 *     `""`, so sending them would break calls that work today. An empty
 *     `filterPattern` IS accepted by botocore, and is omitted too, for parity
 *     with the truthiness check the handler has always applied.
 *   - `endTime`, `interleaved` (deprecated and assumed true since 2019) and
 *     `unmask`: the tool exposes no input for any of them.
 */
export function buildTailParams(o: {
  logGroupName: string;
  logGroupIdentifier: string | null;
  startTime: number;
  filterPattern?: string;
  logStreamNames?: string[];
  logStreamNamePrefix?: string;
  newestFirst: boolean;
}): Record<string, unknown> {
  const params: Record<string, unknown> = o.logGroupIdentifier
    ? { logGroupIdentifier: o.logGroupIdentifier }
    : { logGroupName: o.logGroupName };
  params.startTime = o.startTime;
  if (o.filterPattern) params.filterPattern = o.filterPattern;
  if (o.logStreamNames && o.logStreamNames.length > 0) params.logStreamNames = o.logStreamNames;
  if (o.logStreamNamePrefix) params.logStreamNamePrefix = o.logStreamNamePrefix;
  if (o.newestFirst) params.startFromHead = false;
  return params;
}

/** One event as the --query projection delivers it, before the ISO conversion. */
interface RawTailEvent {
  timestampMs: number | null;
  logStreamName: string | null;
  message: string | null;
}

/** One event as the caller receives it. */
export interface TailEvent {
  /** ISO 8601 UTC with milliseconds, or null when AWS sent no usable timestamp. */
  timestamp: string | null;
  logStreamName: string | null;
  message: string | null;
}

/**
 * Read the `{total, events}` document the projection asks for, or null when
 * stdout was anything else.
 *
 * Strict on purpose, and the strictness IS the regression pin: the parser this
 * replaces turned the CLI's pretty-printed tail TEXT into `ok: true` with the
 * whole blob as `events`, which is how a tool shipped for four minor versions
 * without ever returning a structured event against a real CLI. Empty stdout
 * (null), a string, a bare array and a wrong-typed `total` all return null, and
 * the handler reports that as a failure rather than guessing.
 *
 * Elements missing a member map to null rather than being dropped: a caller
 * counting events must see the same number the service returned.
 */
export function parseTailOutput(raw: unknown): { total: number; events: RawTailEvent[] } | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const doc = raw as { total?: unknown; events?: unknown };
  if (typeof doc.total !== "number" || !Number.isInteger(doc.total) || doc.total < 0) return null;
  if (!Array.isArray(doc.events)) return null;
  const events = doc.events.map((e): RawTailEvent => {
    const event = typeof e === "object" && e !== null ? (e as Record<string, unknown>) : {};
    return {
      timestampMs: typeof event.timestamp === "number" ? event.timestamp : null,
      logStreamName: typeof event.logStreamName === "string" ? event.logStreamName : null,
      message: typeof event.message === "string" ? event.message : null,
    };
  });
  return { total: doc.total, events };
}

// botocore reports a member its model does not know, and a required member that
// is missing, in these two shapes. The optional backslash covers the CLI's JSON
// error format, where the parameter name arrives as \"startFromHead\": this
// server pins AWS_CLI_ERROR_FORMAT=enhanced in every child environment and the
// variable beats the user's config, so a CLI that honours the pin cannot print
// that form -- tolerating it is what keeps the detector working on one that does
// not. Both forms were captured on 2.34.3, along with 2.22.0's, which prints the
// validation lines with no `aws: [ERROR]: An error occurred (ParamValidation):`
// header at all; the detector never reads that header.
const FLE_UNKNOWN_PARAM_RE = /Unknown parameter in input: \\?"(\w+)\\?"/g;
const FLE_MISSING_PARAM_RE = /Missing required parameter in input: \\?"(\w+)\\?"/g;

/**
 * Which FilterLogEvents members this CLI's model does not have, read from the
 * rejection it printed.
 *
 * botocore validates against the model the binary loaded and sends NOTHING when a
 * member is unknown (exit 252, zero requests, measured on both local CLIs), so
 * this is ground truth about the installed CLI rather than a version guess -- and
 * it handles a custom or unparseable version string, which a probe would not. A
 * missing `logGroupName` means the model predates the optional-name change
 * (2.9.15), which is the same era as not knowing `logGroupIdentifier` at all.
 *
 * `Invalid type for parameter startFromHead` and `Invalid length for parameter
 * logStreamNames` are NOT gaps: the member exists and the value was wrong.
 */
export function detectFleModelGaps(stderr: string): { startFromHead: boolean; logGroupIdentifier: boolean } {
  const unknown = new Set<string>();
  for (const m of stderr.matchAll(FLE_UNKNOWN_PARAM_RE)) unknown.add(m[1]);
  const missing = new Set<string>();
  for (const m of stderr.matchAll(FLE_MISSING_PARAM_RE)) missing.add(m[1]);
  return {
    startFromHead: unknown.has("startFromHead"),
    logGroupIdentifier: unknown.has("logGroupIdentifier") || missing.has("logGroupName"),
  };
}

/**
 * Set once a CLI has rejected `startFromHead`, so the rest of the process reads
 * the whole window directly instead of paying for a rejected call first.
 *
 * Only the NEGATIVE answer is cached: a current CLI never pays for detection, and
 * a CLI upgraded mid-session is picked up on the next server start. The cost on an
 * old CLI is one extra CLI start, once per process.
 */
let startFromHeadUnsupported = false;

/** Test-only seam, same convention as sso.ts's _clearCliVersionCache. */
export function _resetLogsTailCliModelCache(): void {
  startFromHeadUnsupported = false;
}

/**
 * True when a newest-first fetch came back OLDEST-first and the kept end is
 * therefore the wrong one.
 *
 * moto's FilterLogEvents never reads `startFromHead` (its handler reads
 * logGroupName, logStreamNames, startTime, filterPattern, interleaved, endTime,
 * limit and nextToken), so LocalStack ignores it too, as can a partition or proxy
 * that lags the member. The CLI still sends it, so without this check the handler
 * would keep the OLDEST maxEvents, reverse them, and present them as the newest
 * window with truncated: true -- a silently wrong answer. Reproduced through
 * runAwsCall against a moto-shaped stub: a newest-first read for 3 events
 * returned event-0..event-3.
 *
 * Only an ascending fetch that was also TRUNCATED is wrong: when the whole window
 * arrived, the same events are the answer either way. Equal timestamps cannot be
 * classified and count as newest-first, the real API's documented order.
 */
export function fetchIgnoredStartFromHead(events: readonly RawTailEvent[], maxEvents: number): boolean {
  if (events.length < 2 || events.length <= maxEvents) return false;
  return isAscending(events);
}

export interface TailWindow {
  events: TailEvent[];
  eventCount: number;
  totalEvents: number | null;
  truncated: boolean;
}

/**
 * Turn one read's projected events into the window the caller gets: at most
 * maxEvents events, oldest-first, keeping the NEWEST when the window held more.
 *
 * `totalEvents` is how many events the window held, and null when the read
 * stopped early and so never learned that:
 *   - newest-first: the fetch is descending and holds at most maxEvents + 1
 *     events. More than maxEvents means the window held more, so truncated is
 *     exact and totalEvents is null. The sentinel event is why NextToken is not
 *     used for this -- FilterLogEvents documents that a partial or empty page
 *     does not mean pagination is finished, so a token over-reports truncation.
 *     An ascending, untruncated fetch (an endpoint that ignored the member) is
 *     already oldest-first and is kept as it stands.
 *   - full-window: the CLI read every page, so `total` is exact and the
 *     projection already sliced the newest maxEvents; the slice here is
 *     defensive.
 *
 * In newest-first mode a caller MUST run fetchIgnoredStartFromHead first and re-read
 * the whole window when it answers true. This function cannot fix that case: an
 * ascending fetch that was truncated holds the oldest events of the window, and no
 * arrangement of them is the newest maxEvents.
 */
export function selectTailWindow(
  parsed: { total: number; events: RawTailEvent[] },
  maxEvents: number,
  mode: TailReadMode,
): TailWindow {
  if (mode === "full-window") {
    const kept = parsed.events.slice(-maxEvents);
    return {
      events: kept.map(toTailEvent),
      eventCount: kept.length,
      totalEvents: parsed.total,
      truncated: parsed.total > maxEvents,
    };
  }
  const fetched = parsed.events;
  const ascending = fetched.length >= 2 && isAscending(fetched);
  const truncated = fetched.length > maxEvents;
  // Descending fetches are reversed into the oldest-first order this tool has
  // always returned; an ascending one already is oldest-first.
  const kept = ascending ? fetched.slice(0, maxEvents) : fetched.slice(0, maxEvents).reverse();
  return {
    events: kept.map(toTailEvent),
    eventCount: kept.length,
    totalEvents: truncated ? null : fetched.length,
    truncated,
  };
}

function isAscending(events: readonly RawTailEvent[]): boolean {
  const first = events[0].timestampMs;
  const last = events[events.length - 1].timestampMs;
  if (first === null || last === null) return false;
  return first < last;
}

function toTailEvent(e: RawTailEvent): TailEvent {
  return { timestamp: toIsoOrNull(e.timestampMs), logStreamName: e.logStreamName, message: e.message };
}

/**
 * FilterLogEvents' Timestamp shape is a `long` of epoch milliseconds, so
 * cli_timestamp_format never touches it and the conversion happens here. Anything
 * Date cannot represent (±8.64e15 ms is its range) becomes null rather than
 * "Invalid Date" or a thrown RangeError.
 */
function toIsoOrNull(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return null;
  return new Date(ms).toISOString();
}

/** What arrived instead of the document, for the refusing-to-guess message. */
function describeShape(x: unknown): string {
  if (x === null || x === undefined) return "empty output";
  if (Array.isArray(x)) return "an array";
  return typeof x;
}

// ---------------------------------------------------------------------------
// aws_logs_query support. Place this block above `export const logsTools` (:140).
// ---------------------------------------------------------------------------

/**
 * aws_logs_query runs a CloudWatch Logs Insights query to completion in ONE
 * tool call: StartQuery, poll GetQueryResults until the query leaves the
 * in-flight set, flatten the rows.
 *
 * Why it is a tool and not three aws_call round-trips: the raw shape forces
 * every caller to re-implement the same loop, the same "Scheduled and Running
 * are not done" rule, and the same partial-results-while-Running trap.
 * aws_script is not the alternative either -- its context binds no timers at
 * all (see the NOT-available list in script.ts), so a busy-wait poll written
 * there blocks this single-threaded stdio server for the whole query.
 *
 * Wire format, and the thing that bites anyone copying metrics.ts: CloudWatch
 * LOGS models its API members in camelCase (logGroupNames, queryString,
 * startTime); CloudWatch METRICS uses PascalCase (MetricDataQueries, StartTime).
 * Both go out through the same --cli-input-json path, so the casing is the only
 * difference and getting it wrong is a botocore ParamValidationError before the
 * request is signed. StartQuery also takes its window in epoch SECONDS -- not
 * the milliseconds FilterLogEvents (and so `aws logs tail`) uses.
 */

// StartQuery accepts at most 50 log groups in logGroupNames.
const MAX_QUERY_LOG_GROUPS = 50;
// StartQuery's documented queryString ceiling. AWS's own minimum is 0, but an
// empty query is a guaranteed MalformedQueryException, so the schema floors at
// 1 and spends a local error instead of a round-trip.
const MAX_QUERY_STRING_CHARS = 10_000;
// StartQuery's own `limit` ceiling is 100,000, but a single GetQueryResults
// call returns at most 10,000 rows and the rest is reachable ONLY through
// GetQueryResults pagination -- whose nextToken/maxItems members are absent
// from the model in aws-cli 2.34.3 (verified: `get-query-results
// --generate-cli-skeleton` emits {"queryId": ""} and nothing else). This server
// declares no minimum CLI version, so we do not send those flags, and a limit
// above 10,000 would quietly return the first 10,000 rows with no way to reach
// the rest. Cap where the data actually stops.
const MAX_QUERY_LIMIT = 10_000;
// Not AWS's default -- ours. runAwsCall kills a call whose stdout passes 5 MB,
// and that kill lands AFTER the query has run and been billed, so an unbounded
// result set turns a paid query into an output_too_large error. 1000 rows is
// what the Insights console shows by default and is plenty for the
// investigate-then-narrow loop an agent runs.
const DEFAULT_QUERY_LIMIT = 1_000;
// Poll pacing. The 500ms floor is 2 GetQueryResults/sec from one query against
// an account/region quota of 10/sec, so a single tool call cannot throttle
// itself; the 30s ceiling and 2s default mirror the CCAPI loop in resource.ts.
// GetQueryResults has no RetryAfter hint, so unlike that loop the interval is
// never overridden by the response.
const QUERY_MIN_POLL_INTERVAL_MS = 500;
const QUERY_MAX_POLL_INTERVAL_MS = 30_000;
const DEFAULT_QUERY_POLL_INTERVAL_MS = 2_000;
// Wait budget. Deliberately shorter than the CCAPI loop's 30 minutes: a
// mutation you stop watching may be unrecoverable, while a query you stop
// watching keeps running and its results stay retrievable for 7 days, so
// handing back the queryId early costs the caller nothing. AWS kills the query
// itself at 60 minutes.
const QUERY_MIN_MAX_WAIT_MS = 1_000;
const QUERY_MAX_MAX_WAIT_MS = 15 * 60_000;
const DEFAULT_QUERY_MAX_WAIT_MS = 2 * 60_000;
// Cost guard, not a correctness one. Insights bills by uncompressed bytes
// SCANNED, so unlike every other bound in this file a fat-fingered window here
// spends money rather than a wasted call: '520w' across 50 log groups is a
// real bill for a typo. 90 days covers the retention most groups actually run;
// a genuinely wider query can go through aws_call.
const MAX_QUERY_RANGE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * The GetQueryResults statuses that mean "not done yet". Deliberately an
 * ALLOWLIST, which is the opposite of resource.ts's TERMINAL_STATUSES denylist.
 * The API documents seven values -- Scheduled, Running, Complete, Failed,
 * Cancelled, Timeout, Unknown -- and only these two are in flight. With a
 * denylist, a status AWS adds after this release, or a null status from a
 * malformed response, would read as "keep waiting" and burn the entire wait
 * budget to end up with a vaguer message than the status already was.
 */
const IN_FLIGHT_QUERY_STATUSES: ReadonlySet<string> = new Set(["Scheduled", "Running"]);

/**
 * Argv-safety guard for a queryId before it lands in `--query-id <value>`.
 *
 * The value comes from AWS's own StartQuery response rather than the caller, so
 * this defends against a malformed response, not user input -- but the poll
 * loop would otherwise hand whatever came back straight to argv, and the
 * leading-hyphen rule is the one every other free-text field in this server is
 * held to. None of resource.ts's three validators has the right bound here:
 * StartQuery documents queryId at 1-256 chars, isValidOpaqueToken caps at 128,
 * and isValidIdentifier / validateCursorToken at 2048.
 */
export function isValidQueryId(id: string): boolean {
  if (id.length === 0 || id.length > 256) return false;
  if (id.startsWith("-")) return false;
  for (let i = 0; i < id.length; i++) {
    if (id.charCodeAt(i) < 0x20) return false;
  }
  return true;
}

/**
 * The recovery path, written once because four separate failure arms need it
 * and the error envelope has no `data` channel to put it in (toMcpResult drops
 * `data` when ok is false), so it has to ride inside the message.
 *
 * Says "this tool never stops it" as a statement of fact about the code below:
 * no path in this file calls StopQuery. See the decision recorded on the
 * cancelled arm of pollQueryUntilTerminal.
 */
function queryResumeHint(queryId: string): string {
  return `The query keeps running server-side -- this tool never stops it -- and its results stay retrievable for 7 days: call aws_call with service='logs', operation='get-query-results', params={queryId: '${queryId}'} to collect them, or operation='stop-query' with the same queryId to abandon it and free the concurrency slot (AWS allows 100 concurrent Logs Insights queries per account).`;
}

/**
 * Flatten GetQueryResults' `results` -- an array of ROWS, each an array of
 * {field, value} pairs -- into plain objects, plus the union of field names in
 * first-seen order.
 *
 * Rows are built on a NULL-PROTOTYPE object. Field names come from the caller's
 * own log data (Insights discovers JSON keys automatically), so a record
 * carrying a literal "__proto__" key is reachable input; assigning that onto an
 * object literal hits the prototype setter instead of creating an own property
 * and the field silently disappears. Object.create(null) has no such setter and
 * JSON.stringify serializes it normally -- same reasoning as resolvePointer in
 * resource.ts refusing prototype segments.
 *
 * A pair whose `field` is not a non-empty string is skipped: there is no key to
 * file it under. A non-string `value` becomes null rather than being coerced,
 * so the caller can tell "AWS sent something unexpected" from "the field was
 * the empty string". Two pairs with the same field name in one row collapse to
 * the last; CloudWatch does not emit that shape, and preserving it would mean
 * handing back the raw pair array this helper exists to remove.
 */
export function flattenQueryRows(raw: unknown): {
  rows: Array<Record<string, string | null>>;
  fields: string[];
} {
  const rows: Array<Record<string, string | null>> = [];
  const fields: string[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(raw)) return { rows, fields };
  for (const rawRow of raw) {
    if (!Array.isArray(rawRow)) continue;
    const row = Object.create(null) as Record<string, string | null>;
    for (const pair of rawRow) {
      if (!pair || typeof pair !== "object") continue;
      const { field, value } = pair as { field?: unknown; value?: unknown };
      if (typeof field !== "string" || field.length === 0) continue;
      row[field] = typeof value === "string" ? value : null;
      if (!seen.has(field)) {
        seen.add(field);
        fields.push(field);
      }
    }
    rows.push(row);
  }
  return { rows, fields };
}

/** The GetQueryResults members this tool reads. Everything is `unknown` because
 * it arrives as parsed CLI stdout and is type-guarded at each use. */
interface QueryResultsBody {
  status?: unknown;
  queryLanguage?: unknown;
  results?: unknown;
  statistics?: unknown;
}

/**
 * Why the loop stopped. resource.ts distinguishes its arms by the presence or
 * absence of an AwsCallFailureKind, which works there because each arm builds a
 * different message by construction. Naming the reason makes the four-way
 * branch in the handler readable instead of inferred.
 */
type QueryPollReason = "terminal" | "budget" | "cancelled" | "call_failed";

interface QueryPollResult {
  reason: QueryPollReason;
  /** Last observed `status`, or null when no poll returned a string one. */
  status: string | null;
  /** Last successful GetQueryResults body; null when the first call failed. */
  body: QueryResultsBody | null;
  command: string;
  attempts: number;
  elapsedMs: number;
  /** Set on every reason except "terminal". */
  error?: string;
  /** Set on "call_failed" only, mirroring AwsCallFailure.kind. */
  kind?: AwsCallFailureKind;
  /** Set on "call_failed" only, mirroring AwsCallFailure.suggestion. */
  suggestion?: string;
  rawBody?: string;
}

/**
 * The shape pollQueryUntilTerminal needs from its caller: runAwsCall itself, or
 * a test double with the same signature.
 */
type QueryAwsCaller = (opts: Parameters<typeof runAwsCall>[0]) => Promise<AwsCallResult>;

/**
 * Loop `logs get-query-results` until the query leaves IN_FLIGHT_QUERY_STATUSES,
 * the budget runs out, the client cancels, or the CLI errors.
 *
 * Modeled on pollUntilTerminal in resource.ts and deliberately NOT a call into
 * it: that loop hardcodes the cloudcontrol service, the
 * get-resource-request-status operation, --request-token, and the ProgressEvent
 * unwrap. What IS shared is sleepUnlessAborted, imported rather than copied.
 *
 * Budget is checked BEFORE each call and skipped on the first pass, so the loop
 * always makes at least one request and never spends one past maxWaitMs -- the
 * ordering resource.ts settled on after the old form burned an extra call every
 * time. Cancellation outranks the budget and applies on the FIRST pass too: the
 * one-shot guarantee exists so a caller always gets a result, and a cancelled
 * request has no caller left to receive one.
 *
 * Deliberate omission: on cancellation this does NOT call StopQuery. Results are
 * retained for 7 days, so letting the query finish preserves work the caller has
 * already been billed for, while stopping it would leave only partial rows;
 * StopQuery also errors outright when the query has already ended, which is the
 * common case right after a poll. So the message below can say the query was not
 * cancelled and mean it, and abandoning the query stays an explicit choice the
 * caller can make with the queryId.
 *
 * One progress report per attempt, AFTER the call returns so the message names
 * the status THIS attempt observed. No `total`: the loop ends when AWS says the
 * query is done, so any denominator would be invented -- maxWaitMs bounds the
 * WAIT, not the work. `attempts` only ever increments, so the monotonicity the
 * MCP spec requires falls out of the counter.
 *
 * `awsCall` and `sleep` are injectable purely so unit tests can drive the loop
 * with scripted responses; production takes the defaults.
 */
export async function pollQueryUntilTerminal(
  opts: {
    queryId: string;
    profile?: string;
    region?: string;
    timeoutMs?: number;
    pollIntervalMs: number;
    maxWaitMs: number;
    ctx?: ToolContext;
  },
  awsCall: QueryAwsCaller = runAwsCall,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void> = sleepUnlessAborted,
): Promise<QueryPollResult> {
  const start = Date.now();
  let attempts = 0;
  let lastBody: QueryResultsBody | null = null;
  let lastCommand = "";
  let lastStatus: string | null = null;

  while (true) {
    if (opts.ctx?.signal?.aborted) {
      const elapsed = Date.now() - start;
      return {
        reason: "cancelled",
        status: lastStatus,
        body: lastBody,
        command: lastCommand,
        attempts,
        elapsedMs: elapsed,
        error: `Cancelled by the client after ${Math.round(elapsed / 1000)}s and ${attempts} poll(s) (last status: ${lastStatus ?? "unknown"}). Polling stopped; the CloudWatch Logs Insights query itself was NOT cancelled. ${queryResumeHint(opts.queryId)}`,
      };
    }
    if (attempts > 0 && Date.now() - start >= opts.maxWaitMs) {
      const elapsed = Date.now() - start;
      return {
        reason: "budget",
        status: lastStatus,
        body: lastBody,
        command: lastCommand,
        attempts,
        elapsedMs: elapsed,
        error: `Polled for ${Math.round(elapsed / 1000)}s over ${attempts} attempt(s) without the query reaching a terminal status (last status: ${lastStatus ?? "unknown"}). This is this tool's maxWaitMs, not AWS's -- AWS gives a query 60 minutes. Raise maxWaitMs, or narrow the time range / add a filter so the query scans less. ${queryResumeHint(opts.queryId)}`,
      };
    }
    attempts++;
    const result = await awsCall({
      service: "logs",
      operation: "get-query-results",
      profile: opts.profile,
      region: opts.region,
      timeoutMs: opts.timeoutMs,
      outputFormat: "json",
      // extraFlags, not params: a queryId carries no secret, and keeping it out
      // of --cli-input-json keeps it VISIBLE in the `command` field that
      // redactDisplayArgs would otherwise stub out -- it is the one value a
      // reader of a failed poll actually needs.
      extraFlags: ["--query-id", opts.queryId],
    });
    if (!result.ok) {
      return {
        reason: "call_failed",
        status: lastStatus,
        body: lastBody,
        command: result.command ?? lastCommand,
        attempts,
        elapsedMs: Date.now() - start,
        error: result.error,
        kind: result.kind,
        // Carried because the handler's call_failed arm REBUILDS the message
        // around the queryId and quotes the raw diagnostic rather than
        // `result.error` -- so a recognized error code's "Suggestion: ..." line,
        // which runAwsCall appends to `error` and nowhere else, would otherwise
        // be dropped from both the message and the envelope.
        //
        // Conditional spread, matching the two consumer sites below and
        // aws-cli.ts: omit the key rather than setting it to undefined.
        ...(result.suggestion !== undefined ? { suggestion: result.suggestion } : {}),
        // `||`, not `??`: rawStderr is "" (not nullish) on a nonzero exit with
        // empty stderr, and `??` would return that "" instead of falling back
        // to stdout. Same fix as aws_logs_tail's failure return above.
        rawBody: result.rawStderr || result.rawStdout,
      };
    }
    lastCommand = result.command;
    lastBody = result.data && typeof result.data === "object" ? (result.data as QueryResultsBody) : null;
    lastStatus = lastBody && typeof lastBody.status === "string" ? lastBody.status : null;
    const elapsed = Date.now() - start;
    opts.ctx?.reportProgress(
      attempts,
      undefined,
      `Poll ${attempts}: ${lastStatus ?? "unknown"} after ${Math.round(elapsed / 1000)}s`,
    );
    if (lastStatus === null || !IN_FLIGHT_QUERY_STATUSES.has(lastStatus)) {
      return {
        reason: "terminal",
        status: lastStatus,
        body: lastBody,
        command: lastCommand,
        attempts,
        elapsedMs: Date.now() - start,
      };
    }
    // Clamped to the remaining budget so the wait can't overshoot it. No
    // RetryAfter equivalent exists on GetQueryResults, so unlike the CCAPI loop
    // nothing overrides pollIntervalMs.
    const waitMs = Math.min(opts.pollIntervalMs, opts.maxWaitMs - elapsed);
    // Hand the signal to the sleep so a cancellation arriving mid-wait wakes us
    // immediately; the loop's own check at the top then builds the result.
    if (waitMs > 0) await sleep(waitMs, opts.ctx?.signal);
  }
}

/**
 * Message for a query that reached a terminal status other than Complete. Every
 * one is an ok:false -- the caller asked for rows and there are none to give.
 * GetQueryResults carries no failure detail beyond the status itself (there is
 * no errorMessage member), so each branch says what the status MEANS rather
 * than inventing a cause.
 */
function terminalQueryFailure(status: string | null, queryId: string, attempts: number, elapsedMs: number): string {
  const where = ` (queryId '${queryId}', ${attempts} poll(s), ${Math.round(elapsedMs / 1000)}s)`;
  switch (status) {
    case "Failed":
      return `The CloudWatch Logs Insights query failed server-side${where}. GetQueryResults reports only the status, with no reason attached -- check the query syntax, and that every log group exists in this region and account. 'aws_call' with operation='describe-queries' shows the query's own record.`;
    case "Cancelled":
      return `The query was cancelled${where}. This tool never cancels a query, so it was stopped elsewhere -- a StopQuery call, or the CloudWatch console. Re-run to get a fresh queryId.`;
    case "Timeout":
      return `The query hit CloudWatch's own 60-minute execution timeout${where}. That is AWS's limit, not this tool's maxWaitMs -- a maxWaitMs timeout says "still running" and hands the queryId back instead. Narrow the time range, add a filter, or split the query into several.`;
    case "Unknown":
      return `The query reported status 'Unknown'${where}. AWS documents the value but no transition out of it, so this tool treats it as terminal rather than polling a status that cannot progress. Re-run the query; if it recurs, inspect it with 'aws_call' operation='describe-queries'.`;
    case null:
      return `GetQueryResults returned no 'status' field${where}. The response is malformed, so polling stopped rather than waiting on a status that may never arrive. ${queryResumeHint(queryId)}`;
    default:
      return `The query reached an unrecognized terminal status '${status}'${where}. Anything outside Scheduled/Running is treated as done, so a status AWS adds after this release lands here instead of spinning until maxWaitMs. ${queryResumeHint(queryId)}`;
  }
}

export const logsTools: readonly Tool[] = [
  {
    name: "aws_logs_tail",
    description: `Fetch the newest CloudWatch Logs events for one log group over the last \`since\` (default 10m), via FilterLogEvents ('aws logs filter-log-events'). Returns events oldest first as {timestamp (ISO 8601 UTC), logStreamName, message (verbatim)}. At most \`maxEvents\` come back (default ${DEFAULT_MAX_EVENTS}, max ${MAX_MAX_EVENTS}); when the window held more, the OLDEST are dropped and \`truncated\` is true. On AWS CLI ${START_FROM_HEAD_MIN_CLI}+ the read goes newest-first and stops once it has enough, so a busy group costs a page or two -- and a truncated result reports \`totalEvents: null\` because the rest was never read. Older CLIs read the whole window (exact \`totalEvents\`); narrow \`since\` or add \`filterPattern\` if a wide window times out. \`logGroupName\` takes a bare name or a log-group ARN in the call's region; an ARN is sent as logGroupIdentifier, so a source-account ARN works from a cross-account monitoring account (AWS CLI ${LOG_GROUP_IDENTIFIER_MIN_CLI}+). Does not stream: call again for newer events. eventId and ingestionTime are omitted -- use aws_call for them.`,
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
          `Log group name, e.g. '/aws/lambda/my-fn' or '/aws/ecs/my-service' (no leading 'logs/'). A full log-group ARN ('arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/my-fn', with or without a trailing ':*') is also accepted: it is sent as FilterLogEvents' logGroupIdentifier with the ':*' removed, so it reads the group in the ARN's own account. The ARN's region must match this call's region, and ARN input needs AWS CLI ${LOG_GROUP_IDENTIFIER_MIN_CLI}+.`,
        ),
      since: z
        .string()
        .regex(RELATIVE_TIME_RE, "since must match /^\\d+[smhdw]$/ (lowercase units only), e.g. '5m', '2h', '1d'")
        .optional()
        .describe(
          `Window to tail: '<number><s|m|h|d|w>'. Default '10m'. Example: '30m', '1h', '3d'. Must be greater than zero and at most ${MAX_SINCE_MS / 86_400_000} days.`,
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
      maxEvents: z
        .number()
        .int()
        .positive()
        .max(MAX_MAX_EVENTS)
        .optional()
        .describe(
          `Maximum events to return (1-${MAX_MAX_EVENTS}). Default ${DEFAULT_MAX_EVENTS}. Events come back oldest-first; when the window held more than this, the OLDEST are dropped, the newest are kept and truncated=true. On AWS CLI ${START_FROM_HEAD_MIN_CLI}+ the read itself stops after this many events, so totalEvents is null when truncated is true; an older CLI scans the whole window and reports the exact totalEvents. Narrow 'since' or add a 'filterPattern' to make the call itself cheaper.`,
        ),
      profile: z.string().optional().describe("Override session profile for this call."),
      region: z.string().optional().describe("Override session region for this call."),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Timeout in milliseconds per aws CLI call (at most two per tool call). Default 60000 (60s). Raise for large windows.",
        ),
    }),
    handler: async (input: unknown): Promise<ToolResult> => {
      const i = input as {
        logGroupName: string;
        since?: string;
        filterPattern?: string;
        logStreamNames?: string[];
        logStreamNamePrefix?: string;
        maxEvents?: number;
        profile?: string;
        region?: string;
        timeoutMs?: number;
      };

      // Accepts a bare name or a log-group ARN. An ARN keeps its account: it is
      // sent as logGroupIdentifier, and only the ECHOED logGroupName is the bare
      // name. A bare name goes as logGroupName, which every CLI understands.
      const arn = parseLogGroupArn(i.logGroupName);
      const logGroupName = arn ? arn.name : resolveLogGroupName(i.logGroupName);
      const logGroupIdentifier = arn ? arn.identifier : null;
      if (logGroupName === null) {
        return {
          ok: false,
          error: `Invalid logGroupName '${i.logGroupName}'. Pass a bare group name -- starting with alphanumeric/dot/slash/underscore/hash and containing only [.\\-_/#A-Za-z0-9] -- or a full log-group ARN like 'arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/my-fn' (an optional trailing ':*' is allowed).`,
        };
      }

      // FilterLogEvents is regional: a logGroupIdentifier for another region is not
      // read from the region the call runs in, it simply is not found there. The
      // old code cut the ARN down to its name, so this silently read a same-named
      // group in the caller's own region instead. Checked before any spawn, so
      // errorKind stays absent -- nothing was classified.
      const effectiveRegion = i.region ?? getRegion();
      if (arn && arn.region !== effectiveRegion) {
        return {
          ok: false,
          error: `logGroupName is a log-group ARN in region '${arn.region}', but this call runs in '${effectiveRegion}'${i.region === undefined ? " (the session/default region)" : ""}. FilterLogEvents is regional, so the ARN cannot be read from there. Pass region: '${arn.region}', or pass the bare name '${arn.name}' to read the same-named group in '${effectiveRegion}'.`,
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
          error: `since '${since}' asks for a ${Math.round(sinceMs / 86_400_000)}-day window; the maximum is ${MAX_SINCE_MS / 86_400_000} days. A window this wide spends FilterLogEvents call after call and then fails on the timeout instead of returning events. Narrow the window, or add a filterPattern and tail it in slices.`,
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
      // filterPattern now travels inside --cli-input-json, where the CLI passes it
      // through literally: neither a leading '-' nor a `file://` prefix is an argv
      // concern for this tool any more. The guard stays so this release does not
      // also change which inputs are ACCEPTED -- and a real CloudWatch filter
      // pattern never legitimately starts with '-' (patterns start with a quote, a
      // literal word, or '[' for structured matching).
      if (i.filterPattern?.startsWith("-")) {
        return {
          ok: false,
          error: "Invalid filterPattern: must not start with '-'.",
        };
      }

      // Defense-in-depth: the schema caps maxEvents at MAX_MAX_EVENTS, but direct
      // (non-MCP) callers bypass schema validation -- clamp here for parity with
      // the handler-level clamps in paginate.ts and docs.ts. Ahead of the call now,
      // because the cap decides --page-size, --max-items and the --query slice.
      const maxEvents = Math.min(Math.max(1, i.maxEvents ?? DEFAULT_MAX_EVENTS), MAX_MAX_EVENTS);
      // Resolved once: two reads of the same window must not span two windows.
      const startTime = Date.now() - sinceMs;
      const params = (newestFirst: boolean): Record<string, unknown> =>
        buildTailParams({
          logGroupName,
          logGroupIdentifier,
          startTime,
          filterPattern: i.filterPattern,
          logStreamNames: i.logStreamNames,
          logStreamNamePrefix: i.logStreamNamePrefix,
          newestFirst,
        });

      /**
       * One FilterLogEvents read. `--page-size` becomes the request's `limit` and
       * `--max-items` stops the CLI's own paginator, so a newest-first read fetches
       * maxEvents + 1 events -- the sentinel that makes `truncated` exact -- and
       * nothing more.
       */
      const read = (mode: TailReadMode): Promise<AwsCallResult> =>
        runAwsCall({
          service: "logs",
          operation: "filter-log-events",
          profile: i.profile,
          region: i.region,
          timeoutMs: i.timeoutMs,
          outputFormat: "json",
          query: buildTailQuery(mode, maxEvents),
          params: params(mode === "newest-first"),
          extraFlags:
            mode === "newest-first"
              ? [
                  "--page-size",
                  String(Math.min(maxEvents + 1, FLE_MAX_PAGE_SIZE)),
                  "--max-items",
                  String(maxEvents + 1),
                ]
              : undefined,
        });

      // Why a whole-window read happened, for the timeout message: the CLI has no
      // startFromHead, or the endpoint ignored it.
      type FullWindowCause = "cli" | "endpoint" | null;

      /** The two runAwsCall failure kinds whose own remedy does not fit this tool. */
      const tailFailure = (failure: AwsCallFailure, mode: TailReadMode, cause: FullWindowCause): ToolResult => {
        let error = failure.error;
        if (failure.kind === "output_too_large") {
          error = `The newest ${maxEvents} events alone passed the 5 MB output cap -- these log events are large. Lower maxEvents, or narrow with filterPattern or logStreamNames.`;
        } else if (failure.kind === "timeout") {
          // The caller's own timeoutMs, defaulting to runAwsCall's 60s.
          const seconds = Math.round((i.timeoutMs ?? 60_000) / 1000);
          if (mode === "full-window") {
            const why =
              cause === "endpoint"
                ? "This endpoint ignored FilterLogEvents' startFromHead, so the whole window is read"
                : `This AWS CLI rejects FilterLogEvents' startFromHead (added in AWS CLI ${START_FROM_HEAD_MIN_CLI}), so the whole window is read`;
            error = `Timed out after ${seconds}s reading every event since '${since}'. ${why} before the newest ${maxEvents} can be picked. Narrow 'since', add a filterPattern, raise timeoutMs${cause === "endpoint" ? "" : `, or upgrade the AWS CLI to ${START_FROM_HEAD_MIN_CLI}+`}.`;
          } else {
            error = `Timed out after ${seconds}s before ${maxEvents} matching events were found reading newest-first. A filterPattern that rarely matches still pages back through the whole window; narrow 'since' or raise timeoutMs.`;
          }
        }
        // `||`, not `??`: rawStderr is "" (not nullish) on a nonzero exit with
        // empty stderr, and `??` would return that "" instead of falling back
        // to stdout. Same fix as call.ts and the resource.ts failure returns.
        return {
          ok: false,
          error,
          errorKind: failure.kind,
          suggestion: failure.suggestion,
          rawBody: failure.rawStderr || failure.rawStdout,
        };
      };

      /**
       * One read plus the two arms every read shares: a failure this tool reports as
       * it stands, and stdout that is not the document the --query asked for. A
       * `nonzero_exit` comes back UNMAPPED, because only the caller knows whether a
       * rejected member means "read the window the other way" or "give up".
       */
      const attempt = async (
        mode: TailReadMode,
        cause: FullWindowCause,
      ): Promise<
        | { kind: "rejected"; failure: AwsCallFailure }
        | { kind: "failed"; result: ToolResult }
        | { kind: "read"; command: string; parsed: { total: number; events: RawTailEvent[] } }
      > => {
        const r = await read(mode);
        if (!r.ok) {
          if (r.kind === "nonzero_exit") return { kind: "rejected", failure: r };
          return { kind: "failed", result: tailFailure(r, mode, cause) };
        }
        const parsed = parseTailOutput(r.data);
        if (parsed === null) {
          // No errorKind: the CLI exited 0, so nothing classified this. Precedent:
          // aws_logs_query's no-queryId arm.
          return {
            kind: "failed",
            result: {
              ok: false,
              error: `'aws logs filter-log-events' exited 0 but printed something other than the {total, events} document this tool's --query asks for (got ${describeShape(r.data)}). Refusing to guess at the format. Command: ${r.command}`,
              rawBody: truncateForErrorMsg(r.rawStdout),
            },
          };
        }
        return { kind: "read", command: r.command, parsed };
      };

      let mode: TailReadMode = startFromHeadUnsupported ? "full-window" : "newest-first";
      let cause: FullWindowCause = startFromHeadUnsupported ? "cli" : null;
      let a = await attempt(mode, cause);

      if (a.kind === "rejected") {
        const gaps = detectFleModelGaps(a.failure.rawStderr ?? "");
        if (gaps.startFromHead) startFromHeadUnsupported = true;
        if (arn && gaps.logGroupIdentifier) {
          // Gated on `arn` as well as on the gap: a bare-name call sends
          // logGroupName and no identifier, so neither half of that gap can be
          // about a group this call named -- and this message would then be
          // nonsense. Such a failure is forwarded as it stands instead.
          //
          // No `suggestion`: parseAwsError's "Fix parameter shape" remedy for
          // ParamValidation is the wrong advice when the shape is right and the CLI
          // is old.
          return {
            ok: false,
            error: `This AWS CLI predates addressing a log group by ARN: FilterLogEvents' logGroupIdentifier needs AWS CLI ${LOG_GROUP_IDENTIFIER_MIN_CLI}+, and nothing was sent. Pass the bare name '${logGroupName}' to read that group in the account profile '${i.profile ?? getProfile()}' resolves to -- which is not necessarily the ARN's account ${arn.account} -- or upgrade the AWS CLI.`,
            errorKind: "nonzero_exit",
            rawBody: a.failure.rawStderr || a.failure.rawStdout,
          };
        }
        if (gaps.startFromHead && mode === "newest-first") {
          mode = "full-window";
          cause = "cli";
          a = await attempt(mode, cause);
        }
      }
      if (a.kind === "rejected") return tailFailure(a.failure, mode, cause);
      if (a.kind === "failed") return a.result;

      if (mode === "newest-first" && fetchIgnoredStartFromHead(a.parsed.events, maxEvents)) {
        // The endpoint accepted startFromHead and paged ascending anyway, so the
        // events in hand are the OLDEST of the window. Read the whole window
        // instead. Not cached: the CLI supports the member, this endpoint does not,
        // and endpoints differ by region and profile.
        mode = "full-window";
        cause = "endpoint";
        const second = await attempt(mode, cause);
        if (second.kind === "rejected") return tailFailure(second.failure, mode, cause);
        if (second.kind === "failed") return second.result;
        a = second;
      }

      const window = selectTailWindow(a.parsed, maxEvents, mode);
      return {
        ok: true,
        data: {
          command: a.command,
          // The bare group NAME, as it has always been echoed; logGroupIdentifier
          // below says whether an ARN was sent, which `command` cannot show because
          // it redacts the --cli-input-json payload.
          logGroupName,
          logGroupIdentifier,
          since,
          // eventCount keeps the meaning it has had since 1.0 -- how many events are
          // in `events` -- and totalEvents is how many the window held, or null when
          // the read stopped before learning that.
          eventCount: window.eventCount,
          totalEvents: window.totalEvents,
          truncated: window.truncated,
          events: window.events,
        },
      };
    },
  },
  {
    name: "aws_logs_query",
    description:
      "Run a CloudWatch Logs Insights query and wait for it to finish -- StartQuery, poll GetQueryResults until the query reaches a terminal status, return the rows -- in ONE call, replacing the three-step start/poll/interpret-status dance you would otherwise write with aws_call. `logGroupNames` takes 1-50 bare group names ('/aws/lambda/my-fn'); a log-group ARN is accepted and its NAME extracted, which DISCARDS the ARN's account, so a cross-account ARN queries the same-named group in your own account -- real cross-account queries need logGroupIdentifiers, which this tool does not send. `queryString` is Logs Insights QL, e.g. 'fields @timestamp, @message | filter @message like /ERROR/ | sort @timestamp desc | limit 20' or 'stats count(*) by bin(5m)'. `startTime`/`endTime` take the same vocabulary as aws_logs_tail and aws_metrics_query -- relative shorthand ('15m', '1h', '1d', '1w'), 'now', or ISO 8601 with an explicit offset -- defaulting to the last hour, and the window is capped at 90 days. Returns {queryId, status, rows, rowCount, fields, statistics, truncated, ...}: rows are FLATTENED from the API's [{field, value}] pairs into plain objects, so a row reads {'@timestamp': '...', '@message': '...', '@ptr': '...'}. `statistics.recordsMatched` counts everything the query matched and can be far larger than `rowCount` when `limit` (default 1000, max 10000) clipped the result -- `truncated` is true when it did. BILLING: Insights charges by the uncompressed bytes SCANNED, so a wide window across many log groups costs money whether or not anything matches; narrow the window and add a `filter` before widening either. Waits up to `maxWaitMs` (default 120000, max 900000) and reports one progress update per poll; on timeout or client cancellation the query is NEVER stopped -- it keeps running and the error hands back `queryId`, whose results stay retrievable for 7 days. For plain 'show me recent log lines' with no aggregation, aws_logs_tail is cheaper and simpler.",
    annotations: {
      title: "Run a CloudWatch Logs Insights query and wait for results",
      // Reads log data and mutates nothing: StartQuery creates no AWS resource
      // the caller can address, and no log event, group or stream is changed.
      readOnlyHint: true,
      // Truthful here in the way v2.0.1 demanded of aws_call and
      // aws_resource_update: this tool cannot delete or overwrite anything.
      destructiveHint: false,
      // NOT idempotent, and this is where the billing model bites: two
      // identical calls start two SEPARATE queries with different queryIds,
      // each scanning -- and each billed for -- the same bytes again, and each
      // taking one of the account's 100 concurrent Logs Insights slots. A host
      // that auto-retries on this hint would double the bill.
      idempotentHint: false,
      openWorldHint: true,
      // On cost and the annotations, since Insights is billed by bytes
      // scanned and the question comes up: spend does NOT move readOnlyHint or
      // destructiveHint. destructiveHint means "may perform destructive or
      // irreversible UPDATES" -- hosts gate delete-confirmation prompts on it,
      // and repurposing it as "expensive" would make it mean two different
      // things across this server's tool surface and misfire on exactly the
      // calls it exists to guard. The cost risk is handled where a caller can act on
      // it: the 90-day range cap, the 1000-row default limit, and an explicit
      // sentence in the description above.
    },
    inputSchema: z.object({
      logGroupNames: z
        .array(z.string().min(1))
        .min(1)
        .max(MAX_QUERY_LOG_GROUPS)
        .describe(
          `1-${MAX_QUERY_LOG_GROUPS} log group names, e.g. ['/aws/lambda/my-fn'] -- StartQuery caps a query at ${MAX_QUERY_LOG_GROUPS}. A full log-group ARN is accepted and its name extracted; that discards the ARN's account, so a cross-account ARN queries the same-named group in YOUR account.`,
        ),
      queryString: z
        .string()
        .min(1)
        .max(MAX_QUERY_STRING_CHARS)
        .describe(
          `CloudWatch Logs Insights query, max ${MAX_QUERY_STRING_CHARS} chars. E.g. 'fields @timestamp, @message | filter @message like /ERROR/ | sort @timestamp desc | limit 20', or 'stats count(*) by bin(5m)'.`,
        ),
      queryLanguage: z
        .enum(["CWLI", "PPL"])
        .optional()
        .describe(
          "Query language. Default CWLI (Logs Insights QL -- what the queryString examples use). 'PPL' is OpenSearch Piped Processing Language. OpenSearch SQL is deliberately not offered: it expects the log groups named INSIDE the query string rather than passed alongside it, which contradicts this tool's required logGroupNames -- use aws_call for SQL.",
        ),
      startTime: z
        .string()
        .optional()
        .describe(
          `Relative shorthand ('15m', '1h', '1d', '1w'), 'now', or an ISO 8601 timestamp with an explicit offset ('2026-05-16T10:00:00Z', '2026-05-16T10:00:00-04:00'). A date-only '2026-05-16' is read as UTC midnight; an offset-less date-time is rejected (it would resolve in the server host's local zone). A bare number like '5' is rejected -- write '5m'. Default '1h'. The window may not exceed ${MAX_QUERY_RANGE_MS / 86_400_000} days.`,
        ),
      endTime: z
        .string()
        .optional()
        .describe(
          "Same forms as startTime: relative shorthand, 'now', or ISO 8601 with an explicit offset. Default 'now'.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_QUERY_LIMIT)
        .optional()
        .describe(
          `Maximum rows the query RETURNS (it still scans, and bills for, the whole window). Default ${DEFAULT_QUERY_LIMIT}. StartQuery's own ceiling is 100000, but a single GetQueryResults call returns at most ${MAX_QUERY_LIMIT} rows and the remainder needs GetQueryResults pagination this tool does not use, so ${MAX_QUERY_LIMIT} is the cap here. Check 'truncated' and 'statistics.recordsMatched' to see whether more matched than came back.`,
        ),
      pollIntervalMs: z
        .number()
        .int()
        .min(QUERY_MIN_POLL_INTERVAL_MS)
        .max(QUERY_MAX_POLL_INTERVAL_MS)
        .optional()
        .describe(
          `Delay between GetQueryResults polls, in ms (range ${QUERY_MIN_POLL_INTERVAL_MS}-${QUERY_MAX_POLL_INTERVAL_MS}). Default ${DEFAULT_QUERY_POLL_INTERVAL_MS}. The floor keeps one call inside the 10/sec account quota for this API.`,
        ),
      maxWaitMs: z
        .number()
        .int()
        .min(QUERY_MIN_MAX_WAIT_MS)
        .max(QUERY_MAX_MAX_WAIT_MS)
        .optional()
        .describe(
          `Total time to wait for the query, in ms (range ${QUERY_MIN_MAX_WAIT_MS}-${QUERY_MAX_MAX_WAIT_MS}). Default ${DEFAULT_QUERY_MAX_WAIT_MS}. On timeout the query is NOT stopped -- the error returns the queryId and results stay retrievable for 7 days.`,
        ),
      profile: z.string().optional().describe("Override session profile for this call."),
      region: z.string().optional().describe("Override session region for this call."),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Timeout for each individual aws CLI call, in ms. Default 60000. Bounds one start-query or one get-query-results, not the whole wait -- that is maxWaitMs.",
        ),
    }),
    handler: async (input: unknown, ctx?: ToolContext): Promise<ToolResult> => {
      const i = input as {
        logGroupNames: string[];
        queryString: string;
        queryLanguage?: "CWLI" | "PPL";
        startTime?: string;
        endTime?: string;
        limit?: number;
        pollIntervalMs?: number;
        maxWaitMs?: number;
        profile?: string;
        region?: string;
        timeoutMs?: number;
      };

      // Same accept-a-name-or-an-ARN resolution aws_logs_tail uses, and the same
      // argv-safety contract: StartQuery's own logGroupNames pattern is
      // [\.\-_/#A-Za-z0-9]+ at 1-512 chars, which is exactly LOG_GROUP_RE.
      const logGroupNames: string[] = [];
      for (const raw of i.logGroupNames) {
        const name = resolveLogGroupName(raw);
        if (name === null) {
          return {
            ok: false,
            error: `Invalid logGroupName '${raw}'. Pass a bare group name -- starting with alphanumeric/dot/slash/underscore/hash and containing only [.\\-_/#A-Za-z0-9] -- or a full log-group ARN like 'arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/my-fn' (an optional trailing ':*' is allowed).`,
          };
        }
        logGroupNames.push(name);
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
          error: `Invalid endTime '${endStr}'. Use 'now', relative shorthand ('15m', '1h', '1d', '1w'), or ISO 8601 WITH an explicit offset; a date-only '2026-05-16' is read as UTC midnight. An offset-less date-time and a bare number are both rejected -- see startTime.`,
        };
      }
      if (endDate.getTime() <= startDate.getTime()) {
        return {
          ok: false,
          error: `endTime (${endDate.toISOString()}) must be after startTime (${startDate.toISOString()}).`,
        };
      }
      const rangeMs = endDate.getTime() - startDate.getTime();
      if (rangeMs > MAX_QUERY_RANGE_MS) {
        return {
          ok: false,
          error: `The requested window is ${Math.round(rangeMs / 86_400_000)} days (${startDate.toISOString()} to ${endDate.toISOString()}); the maximum is ${MAX_QUERY_RANGE_MS / 86_400_000}. CloudWatch Logs Insights bills by the uncompressed bytes SCANNED, so a window this wide across ${logGroupNames.length} log group(s) costs real money whether or not it matches anything. Narrow the window and query in slices, or go through aws_call with 'logs start-query' if you genuinely need a wider scan.`,
        };
      }

      const limit = i.limit ?? DEFAULT_QUERY_LIMIT;
      // camelCase, NOT the PascalCase aws_metrics_query sends: CloudWatch Logs
      // and CloudWatch model their members differently and both arrive here via
      // --cli-input-json, so this is the one place the difference shows.
      // startTime/endTime are epoch SECONDS per StartQuery -- not the
      // milliseconds FilterLogEvents uses.
      const params: Record<string, unknown> = {
        logGroupNames,
        queryString: i.queryString,
        startTime: Math.floor(startDate.getTime() / 1000),
        endTime: Math.floor(endDate.getTime() / 1000),
        limit,
      };
      if (i.queryLanguage !== undefined) params.queryLanguage = i.queryLanguage;

      // Mirror runAwsCall's resolution so the response echoes the EFFECTIVE
      // profile/region rather than the caller's (possibly undefined) input.
      const effectiveProfile = i.profile ?? getProfile();
      const effectiveRegion = i.region ?? getRegion();

      const started = await runAwsCall({
        service: "logs",
        operation: "start-query",
        profile: i.profile,
        region: i.region,
        timeoutMs: i.timeoutMs,
        outputFormat: "json",
        params,
      });
      if (!started.ok) {
        // Forward the classification runAwsCall already made. Without this the
        // README's errorKind contract -- which names aws_logs_query explicitly --
        // is false for this tool, and a caller cannot tell an expired session
        // (re-authenticate) from a MalformedQueryException (fix the query)
        // without regex-matching prose the README tells them not to match.
        return {
          ok: false,
          error: started.error,
          errorKind: started.kind,
          // Conditional spread rather than `suggestion: started.suggestion`, so
          // the key is absent instead of explicitly undefined when there is none
          // -- matching how aws-cli.ts builds this same field.
          ...(started.suggestion !== undefined ? { suggestion: started.suggestion } : {}),
          rawBody: started.rawStderr || started.rawStdout,
        };
      }
      const rawQueryId = (started.data as { queryId?: unknown } | null)?.queryId;
      if (typeof rawQueryId !== "string" || !isValidQueryId(rawQueryId)) {
        // Nothing to poll on. Bail with the command rather than looping on an
        // undefined --query-id, which the CLI would reject once per attempt for
        // the whole budget.
        return {
          ok: false,
          error: `start-query succeeded but returned no usable queryId (got ${typeof rawQueryId}). Nothing can be polled. Command: ${started.command}`,
          rawBody: started.rawStdout,
        };
      }
      const queryId = rawQueryId;
      // Progress 0 before the first poll, so a client that later cancels has
      // still been told the queryId it needs to collect results with. Monotonic:
      // the poll loop continues from 1.
      ctx?.reportProgress(0, undefined, `Started query ${queryId}`);

      const polled = await pollQueryUntilTerminal({
        queryId,
        profile: i.profile,
        region: i.region,
        timeoutMs: i.timeoutMs,
        pollIntervalMs: i.pollIntervalMs ?? DEFAULT_QUERY_POLL_INTERVAL_MS,
        maxWaitMs: i.maxWaitMs ?? DEFAULT_QUERY_MAX_WAIT_MS,
        ctx,
      });

      if (polled.reason === "cancelled" || polled.reason === "budget") {
        // Both messages are built in the loop and already carry the queryId and
        // the recovery path. Deliberately NOT ok:true -- the query had not
        // finished when we stopped watching, and saying otherwise would be a
        // fake success.
        return { ok: false, error: polled.error ?? "Polling stopped before the query finished." };
      }
      if (polled.reason === "call_failed") {
        // Same shape as resource.ts's poll-failure arm, condensed: whatever went
        // wrong with the POLL, the query is unaffected and its results are the
        // thing worth recovering, so the queryId has to reach the caller. An
        // auth-class kind additionally names the remedy, which the bare CLI
        // error buries in stderr.
        const isAuthKind =
          polled.kind === "sso_expired" ||
          polled.kind === "expired_creds" ||
          polled.kind === "invalid_creds" ||
          polled.kind === "no_creds";
        const prefix = isAuthKind
          ? `Credentials for profile '${effectiveProfile}' stopped working while polling the query (${polled.kind}). Fix them -- aws_login_start for an SSO profile, a fresh assume for an STS session, repaired keys for a rejected one -- then collect the results.`
          : "Polling the query failed.";
        // Quote the RAW diagnostic, not polled.error: the auth-class messages
        // aws-cli.ts builds are themselves "<remedy>. Underlying error: <stderr>",
        // and nesting a second remedy inside ours displaces the queryId that is
        // the whole reason this arm exists. Falls back to the summary when there
        // is no raw body, so the clause is never empty.
        const underlying = polled.rawBody?.trim() || polled.error || "unknown";
        // Re-append the remedy runAwsCall derived from a recognized error code.
        // It normally rides at the end of `result.error`, but `underlying` above
        // deliberately prefers the RAW stderr over that message -- so without
        // this the sentence is lost from the text AND from the envelope, while
        // README's Stability section promises `suggestion` is duplicated in
        // `error`. Guarded on containment so a rawBody that already quotes it
        // does not print it twice (the defect v2.0.1 fixed for rawBody itself).
        const remedy =
          polled.suggestion && !underlying.includes(polled.suggestion) ? `\n\nSuggestion: ${polled.suggestion}` : "";
        return {
          ok: false,
          error: `${prefix} ${queryResumeHint(queryId)} Underlying error: ${underlying}${remedy}`,
          // The kind is already in hand -- `isAuthKind` above reads it -- and the
          // arm rewrites `error` wholesale, so without forwarding it the caller's
          // only classification signal is the prose we just replaced.
          errorKind: polled.kind,
          ...(polled.suggestion !== undefined ? { suggestion: polled.suggestion } : {}),
          rawBody: polled.rawBody,
        };
      }

      const body = polled.body ?? {};
      if (polled.status !== "Complete") {
        return { ok: false, error: terminalQueryFailure(polled.status, queryId, polled.attempts, polled.elapsedMs) };
      }

      const { rows, fields } = flattenQueryRows(body.results);
      const rawStats =
        body.statistics && typeof body.statistics === "object" ? (body.statistics as Record<string, unknown>) : null;
      // Spread the API's object OVER the three members it has always returned,
      // so the documented keys are always present (null when the response
      // omitted them) while anything newer -- estimatedBytesSkipped,
      // estimatedRecordsSkipped, logGroupsScanned, resultCount -- rides along
      // untouched instead of being dropped by a hand-written reshape. Values are
      // passed through as AWS sent them and are not re-validated.
      const statistics = rawStats
        ? { recordsMatched: null, recordsScanned: null, bytesScanned: null, ...rawStats }
        : null;

      return {
        ok: true,
        data: {
          command: polled.command,
          startCommand: started.command,
          profile: effectiveProfile,
          region: effectiveRegion,
          queryId,
          status: polled.status,
          // Null when the response omitted it -- the member is newer than some
          // shipped CLI models, and botocore drops output members its model does
          // not know.
          queryLanguage: typeof body.queryLanguage === "string" ? body.queryLanguage : null,
          // The RESOLVED bare names, so an ARN-shaped input echoes back what was
          // actually queried.
          logGroupNames,
          startTime: startDate.toISOString(),
          endTime: endDate.toISOString(),
          fields,
          rows,
          rowCount: rows.length,
          statistics,
          // `limit` bounds what the query RETURNS, not what it matched. Landing
          // exactly on it is the only local signal that more matched than came
          // back; statistics.recordsMatched carries the real count.
          truncated: rows.length >= limit,
          polled: { attempts: polled.attempts, elapsedMs: polled.elapsedMs },
        },
      };
    },
  },
];

// Exported for tests, plus the time vocabulary metrics.ts imports
// (RELATIVE_TIME_RE / RELATIVE_TIME_UNIT_MS / relativeTimeMs / resolveTime) so
// the shorthand and the window parser are defined once for all three tools.
// aws_logs_query's own helpers (isValidQueryId, flattenQueryRows, resolveTime)
// are exported at their definitions.
export {
  DEFAULT_MAX_EVENTS,
  DEFAULT_QUERY_LIMIT,
  LOG_GROUP_ARN_RE,
  LOG_GROUP_RE,
  LOG_STREAM_NAME_RE,
  MAX_MAX_EVENTS,
  MAX_QUERY_LIMIT,
  MAX_QUERY_LOG_GROUPS,
  MAX_QUERY_RANGE_MS,
  MAX_SINCE_MS,
  RELATIVE_TIME_RE,
  RELATIVE_TIME_UNIT_MS,
  relativeTimeMs,
  resolveLogGroupName,
};
