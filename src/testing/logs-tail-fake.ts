/**
 * The CloudWatch Logs half of the fake CLI: the datasets aws_logs_tail's
 * scenarios serve, the real-CLI bytes those datasets were checked against, and a
 * small FilterLogEvents emulator that refuses anything the real CLI refuses.
 *
 * Why this lives beside fake-aws.ts rather than inside it: the emulator needs a
 * few hundred lines and three model variants, and fake-aws.ts is a shared file
 * every package edits. Its `logs-tail_*` cases are a one-line dynamic import of
 * runLogsTailScenario, so no other scenario pays for any of this at startup.
 *
 * The rule the file exists to enforce: THE FAKE MAY ONLY SAY WHAT THE REAL CLI
 * SAYS. aws_logs_tail shipped parsing `aws logs tail --format json` as NDJSON
 * because the old fake emitted one JSON object per line -- a format the real CLI
 * has never produced -- so the suite agreed with the handler and both were wrong.
 * Hence:
 *   - every success payload is either a verbatim real-CLI capture
 *     (REAL_CLI_CAPTURES) or built by emulateFilterLogEvents, whose semantics
 *     were each measured against a real CLI (the citations below);
 *   - the emulator exits 2 on a `--query` other than the handler's own, on
 *     `limit`/`nextToken` inside the payload, and on an empty stream list or
 *     prefix, because the real CLI fails all four. A handler that drifted from
 *     the argv these datasets were captured with fails instead of being humoured.
 *
 * It keys on MEANING -- the `--cli-input-json` payload, `--max-items`, `--query`
 * -- and never on argv positions, so runAwsCall's global flags (`--output`,
 * `--cli-binary-format base64`) and its temp-file route for payloads over 8,192
 * characters cannot break it.
 *
 * Measurements behind every claim here: aws-cli/2.34.3 Python/3.13.11
 * Windows/11 exe/ARM64 and aws-cli/2.22.0 Python/3.12.6 Windows/11 exe/ARM64,
 * both through runAwsCall against a loopback stub on 127.0.0.1 with fake static
 * keys, 2026-09-20.
 *
 * Test-only. Nothing reachable from src/index.ts imports this file, and esbuild
 * bundles from src/index.ts alone, so none of it ships in dist/index.js.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCliInputJson } from "./cli-input.js";

export interface FakeFilteredLogEvent {
  logStreamName: string;
  timestamp: number;
  message: string;
  ingestionTime: number;
  eventId: string;
}

/** 2026-09-19T10:00:00Z: the instant every dataset below is anchored to. */
export const FAKE_EVENTS_T0 = Date.UTC(2026, 8, 19, 10, 0, 0);

/**
 * One FilterLogEvents event. `eventId` is 56 digits like the real API's, and
 * `ingestionTime` sits after `timestamp`, so a handler that started reading
 * either field would see something plausible rather than a placeholder.
 */
function fakeEvent(i: number, logStreamName: string, message: string, offsetMs = i * 1000): FakeFilteredLogEvent {
  return {
    logStreamName,
    timestamp: FAKE_EVENTS_T0 + offsetMs,
    message,
    ingestionTime: FAKE_EVENTS_T0 + offsetMs + 250,
    eventId: `3915${String(i).padStart(52, "0")}`,
  };
}

/**
 * Six events chosen for what they do to a TEXT formatter, which is what
 * `aws logs tail --format json` runs: a Lambda START line with a trailing
 * newline, a message that is entirely JSON (the CLI re-indents it across several
 * lines), a three-line traceback (continuation lines carry no prefix), a stream
 * name with a space in it (legal: CreateLogStream's pattern is `[^:*]*`), a bare
 * JSON scalar, and a message that looks exactly like one of the formatter's own
 * header lines. REAL_CLI_CAPTURES.tailFormatJsonStdout is what the real CLI
 * printed for this dataset; no split of that text recovers these six events.
 */
export const BASIC_EVENTS: readonly FakeFilteredLogEvent[] = [
  fakeEvent(0, "2026/09/19/[$LATEST]abc", "START RequestId: 11-22 Version: $LATEST\n"),
  fakeEvent(1, "2026/09/19/[$LATEST]abc", JSON.stringify({ level: "error", msg: "boom", ctx: { id: 7 } }), 1123),
  fakeEvent(2, "2026/09/19/[$LATEST]abc", 'Traceback (most recent call last):\n  File "x.py", line 1\nValueError: bad'),
  fakeEvent(3, "my stream/2026", "plain message on a stream whose name has a space"),
  fakeEvent(4, "2026/09/19/[$LATEST]abc", "42"),
  fakeEvent(
    5,
    "2026/09/19/[$LATEST]abc",
    "2026-09-19T10:00:05+00:00 fake-stream a message that LOOKS like a tail header",
  ),
];

/**
 * A busy window, one event per second, each message carrying its own index.
 * 1,200 is above aws_logs_tail's default cap of 500, and the index is the only
 * thing that makes "kept the newest" distinguishable from "kept the oldest".
 */
export function bulkEvents(n = 1200): FakeFilteredLogEvent[] {
  return Array.from({ length: n }, (_, i) => fakeEvent(i, "s1", `event-${i}`));
}

/**
 * Three messages the Windows ANSI code page cannot carry: one character inside
 * cp1252, one outside the BMP, and CJK. Without the child-env encoding pins
 * (aws-spawn.ts) the first came back as U+FFFD and the others failed the whole
 * call with `'charmap' codec can't encode character`.
 */
export const UNICODE_EVENTS: readonly FakeFilteredLogEvent[] = [
  fakeEvent(0, "s1", "héllo wörld ✓"),
  fakeEvent(1, "s1", "emoji \u{1F600} and CJK 日本語"),
  fakeEvent(2, "s1", JSON.stringify({ msg: "café" })),
];

const CRLF = "\r\n";
/** Join captured lines with the CRLF the real CLI wrote on Windows. */
const captured = (lines: readonly string[]): string => `${lines.join(CRLF)}${CRLF}`;

/**
 * Bytes the REAL AWS CLI wrote, stored as line arrays so neither an editor nor
 * git's line-ending normalization can alter them. Provenance for each is in the
 * comment above it; all were re-captured on 2026-09-20 against the loopback stub
 * and compared byte-for-byte with the planning run's files.
 */
export const REAL_CLI_CAPTURES = {
  /**
   * `aws logs filter-log-events --query '{total: length(events), events:
   * events[-500:].{...}}' --cli-input-json '{"logGroupName":"/stub/basic",
   * "startTime":1789812000000}' --output json` on 2.34.3: the whole-window read
   * of BASIC_EVENTS. 1,226 bytes, exit 0, one request. This is the shape
   * parseTailOutput must accept.
   */
  legacyBasicStdout: captured([
    "{",
    '    "total": 6,',
    '    "events": [',
    "        {",
    '            "timestamp": 1789812000000,',
    '            "logStreamName": "2026/09/19/[$LATEST]abc",',
    '            "message": "START RequestId: 11-22 Version: $LATEST\\n"',
    "        },",
    "        {",
    '            "timestamp": 1789812001123,',
    '            "logStreamName": "2026/09/19/[$LATEST]abc",',
    '            "message": "{\\"level\\":\\"error\\",\\"msg\\":\\"boom\\",\\"ctx\\":{\\"id\\":7}}"',
    "        },",
    "        {",
    '            "timestamp": 1789812002000,',
    '            "logStreamName": "2026/09/19/[$LATEST]abc",',
    '            "message": "Traceback (most recent call last):\\n  File \\"x.py\\", line 1\\nValueError: bad"',
    "        },",
    "        {",
    '            "timestamp": 1789812003000,',
    '            "logStreamName": "my stream/2026",',
    '            "message": "plain message on a stream whose name has a space"',
    "        },",
    "        {",
    '            "timestamp": 1789812004000,',
    '            "logStreamName": "2026/09/19/[$LATEST]abc",',
    '            "message": "42"',
    "        },",
    "        {",
    '            "timestamp": 1789812005000,',
    '            "logStreamName": "2026/09/19/[$LATEST]abc",',
    '            "message": "2026-09-19T10:00:05+00:00 fake-stream a message that LOOKS like a tail header"',
    "        }",
    "    ]",
    "}",
  ]),

  /**
   * stderr when `startFromHead` is in the payload and the CLI's model does not
   * know it: exit 252, ZERO requests -- botocore validates before signing. The
   * same bytes on the installed 2.34.3 (native model) and under the `legacy`
   * overlay, checked both ways.
   */
  startFromHeadRejectStderr: captured([
    "",
    "aws: [ERROR]: An error occurred (ParamValidation): Parameter validation failed:",
    'Unknown parameter in input: "startFromHead", must be one of: logGroupName, logGroupIdentifier, logStreamNames, logStreamNamePrefix, startTime, endTime, filterPattern, nextToken, limit, interleaved, unmask',
  ]),

  /**
   * The same rejection from 2.22.0, which prints the validation lines WITHOUT
   * the `aws: [ERROR]: An error occurred (ParamValidation):` header 2.34.x adds.
   * The detector anchors on the `Unknown parameter in input: "X"` line alone,
   * which is why both forms are kept here.
   */
  startFromHeadRejectLegacyCliStderr: captured([
    "",
    "Parameter validation failed:",
    'Unknown parameter in input: "startFromHead", must be one of: logGroupName, logGroupIdentifier, logStreamNames, logStreamNamePrefix, startTime, endTime, filterPattern, nextToken, limit, interleaved, unmask',
  ]),

  /**
   * The same rejection printed in the CLI's JSON error format (2.34.0 added
   * `cli_error_format`), where the parameter name carries escaped quotes. This
   * server pins AWS_CLI_ERROR_FORMAT=enhanced in every child environment and the
   * variable beats config, so a CLI that honours the pin cannot print this --
   * the capture is what keeps the detector working on one that does not.
   */
  startFromHeadRejectJsonFormatStderr: captured([
    "{",
    '    "Code": "ParamValidation",',
    '    "Message": "Parameter validation failed:\\nUnknown parameter in input: \\"startFromHead\\", must be one of: logGroupName, logGroupIdentifier, logStreamNames, logStreamNamePrefix, startTime, endTime, filterPattern, nextToken, limit, interleaved, unmask"',
    "}",
  ]),

  /**
   * ARN input against a model that predates `logGroupIdentifier`: botocore
   * reports every problem in one message, so the missing-required and
   * unknown-parameter lines arrive together. Captured from the REAL 2.34.3
   * binary with a SYNTHESIZED pre-2.9.2 model overlay -- a genuine pre-2.9.2
   * model would not list `unmask` among the members it does know.
   */
  ancientRejectStderr: captured([
    "",
    "aws: [ERROR]: An error occurred (ParamValidation): Parameter validation failed:",
    'Missing required parameter in input: "logGroupName"',
    'Unknown parameter in input: "logGroupIdentifier", must be one of: logGroupName, logStreamNames, logStreamNamePrefix, startTime, endTime, filterPattern, nextToken, limit, interleaved, unmask',
    'Unknown parameter in input: "startFromHead", must be one of: logGroupName, logStreamNames, logStreamNamePrefix, startTime, endTime, filterPattern, nextToken, limit, interleaved, unmask',
  ]),

  /**
   * The same overlay for a BARE-NAME call: only `startFromHead` is unknown, and
   * the member list it offers has no `logGroupIdentifier` in it.
   */
  ancientBareNameRejectStderr: captured([
    "",
    "aws: [ERROR]: An error occurred (ParamValidation): Parameter validation failed:",
    'Unknown parameter in input: "startFromHead", must be one of: logGroupName, logStreamNames, logStreamNamePrefix, startTime, endTime, filterPattern, nextToken, limit, interleaved, unmask',
  ]),

  /**
   * `aws logs tail /stub/basic --format json --since 1h --output json` on
   * 2.34.3: 639 bytes, exit 0 -- what aws_logs_tail wrapped until 2.4.0. Not
   * NDJSON and never was: `<iso-timestamp> <stream> <message>` header lines, a
   * re-indented JSON message, continuation lines with no prefix, and a message
   * that reads as a header. The strictness pin uses it to prove this text can
   * never be `ok: true` again.
   */
  tailFormatJsonStdout: captured([
    "2026-09-19T10:00:00+00:00 2026/09/19/[$LATEST]abc START RequestId: 11-22 Version: $LATEST",
    "2026-09-19T10:00:01.123000+00:00 2026/09/19/[$LATEST]abc ",
    "{",
    '    "level": "error",',
    '    "msg": "boom",',
    '    "ctx": {',
    '        "id": 7',
    "    }",
    "}",
    "2026-09-19T10:00:02+00:00 2026/09/19/[$LATEST]abc Traceback (most recent call last):",
    '  File "x.py", line 1',
    "ValueError: bad",
    "2026-09-19T10:00:03+00:00 my stream/2026 plain message on a stream whose name has a space",
    "2026-09-19T10:00:04+00:00 2026/09/19/[$LATEST]abc ",
    "42",
    "2026-09-19T10:00:05+00:00 2026/09/19/[$LATEST]abc 2026-09-19T10:00:05+00:00 fake-stream a message that LOOKS like a tail header",
  ]),
} as const;

/**
 * The only `--query` this emulator answers: exactly what buildTailQuery writes,
 * with or without the whole-window slice. A handler that changed its projection
 * without re-capturing REAL_CLI_CAPTURES gets exit 2 rather than a payload the
 * real CLI would not have produced.
 */
export const TAIL_QUERY_RE =
  /^\{total: length\(events\), events: events\[(?:-(\d+):)?\]\.\{timestamp: timestamp, logStreamName: logStreamName, message: message\}\}$/;

export type FleModelVariant = "current" | "legacy" | "ancient";

export interface FakeCliOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface EmulateFleOptions {
  /**
   * Model the endpoint moto and LocalStack are: it never reads `startFromHead`
   * (moto's `filter_log_events` reads logGroupName, logStreamNames, startTime,
   * filterPattern, interleaved, endTime, limit and nextToken, and nothing else),
   * so a newest-first read pages ASCENDING and the caller is handed the oldest
   * events as if they were the newest.
   */
  ignoresStartFromHead?: boolean;
  /** Which error format the rejection is printed in. Default "enhanced". */
  errorFormat?: "enhanced" | "json";
}

const fail = (message: string, exitCode = 2): FakeCliOutcome => ({
  stdout: "",
  stderr: `fake-aws: ${message}\n`,
  exitCode,
});

/** A botocore ParamValidation refusal: exit 252, nothing sent. */
const paramValidation = (stderr: string): FakeCliOutcome => ({ stdout: "", stderr, exitCode: 252 });

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx === -1 ? undefined : argv[idx + 1];
}

/**
 * Answer one `aws logs filter-log-events` call the way the real CLI did.
 *
 * Verified semantics, each against both local CLIs:
 *   - the CLI pages until `--max-items` is reached, then applies `--query` to
 *     the events it FETCHED -- so `total` is the fetched count, not the window's
 *     size, whenever --max-items cut the scan short (8-event dataset,
 *     --max-items 4 -> `total: 4`; no --max-items -> `total: 8`);
 *   - `--page-size` becomes the request's `limit`;
 *   - `startFromHead: false` reverses the order the endpoint returns;
 *   - `limit` or `nextToken` inside --cli-input-json turns the CLI's own
 *     pagination off, and with --max-items the call then dies with
 *     `Unknown parameter in input: "PaginationConfig"`;
 *   - an empty `logStreamNames` or `logStreamNamePrefix` is refused by botocore
 *     before any request (`Invalid length for parameter ..., value: 0`), while
 *     an empty `filterPattern` is accepted and sent.
 */
export function emulateFilterLogEvents(
  argv: readonly string[],
  model: FleModelVariant,
  dataset: readonly FakeFilteredLogEvent[],
  opts: EmulateFleOptions = {},
): FakeCliOutcome {
  const query = flagValue(argv, "--query");
  if (query === undefined) return fail("aws_logs_tail must pass --query; got none");
  const slice = TAIL_QUERY_RE.exec(query);
  if (!slice) return fail(`--query is not the projection aws_logs_tail builds: ${query}`);

  let payload: Record<string, unknown>;
  try {
    const read = readCliInputJson(argv);
    if (read === null) return fail("aws logs filter-log-events was called without --cli-input-json");
    if (typeof read.params !== "object" || read.params === null || Array.isArray(read.params)) {
      return fail(`--cli-input-json is not a JSON object: ${read.text.slice(0, 120)}`);
    }
    payload = read.params as Record<string, unknown>;
  } catch (err) {
    return fail(err instanceof Error ? err.message.replace(/^fake-aws: /, "") : String(err));
  }

  for (const banned of ["limit", "nextToken"] as const) {
    if (banned in payload) {
      return fail(
        `'${banned}' inside --cli-input-json turns the CLI's own pagination off; with --max-items the real CLI then fails with 'Unknown parameter in input: "PaginationConfig"'`,
      );
    }
  }
  if (Array.isArray(payload.logStreamNames) && payload.logStreamNames.length === 0) {
    return fail("botocore refuses an empty logStreamNames: Invalid length for parameter logStreamNames, value: 0");
  }
  if (payload.logStreamNamePrefix === "") {
    return fail(
      "botocore refuses an empty logStreamNamePrefix: Invalid length for parameter logStreamNamePrefix, value: 0",
    );
  }

  if (model === "ancient" && "logGroupIdentifier" in payload) {
    return paramValidation(REAL_CLI_CAPTURES.ancientRejectStderr);
  }
  if (model !== "current" && "startFromHead" in payload) {
    if (opts.errorFormat === "json") return paramValidation(REAL_CLI_CAPTURES.startFromHeadRejectJsonFormatStderr);
    return paramValidation(
      model === "ancient" ? REAL_CLI_CAPTURES.ancientBareNameRejectStderr : REAL_CLI_CAPTURES.startFromHeadRejectStderr,
    );
  }

  const descending = payload.startFromHead === false && !opts.ignoresStartFromHead;
  const ordered = descending ? [...dataset].reverse() : [...dataset];
  const maxItems = Number(flagValue(argv, "--max-items") ?? Number.NaN);
  const fetched = Number.isInteger(maxItems) && maxItems > 0 ? ordered.slice(0, maxItems) : ordered;
  const keep = slice[1] === undefined ? fetched : fetched.slice(-Number(slice[1]));
  const body = {
    total: fetched.length,
    events: keep.map((e) => ({ timestamp: e.timestamp, logStreamName: e.logStreamName, message: e.message })),
  };
  // Indent 4 and a trailing newline, which is what the CLI writes. It writes
  // CRLF on Windows; the verbatim captures above carry that form, and every
  // consumer of this output goes through JSON.parse, which does not care.
  return { stdout: `${JSON.stringify(body, null, 4)}\n`, stderr: "", exitCode: 0 };
}

/** Every scenario name fake-aws.ts routes here. */
export type LogsTailScenario =
  | "logs-tail_current_basic"
  | "logs-tail_current_bulk"
  | "logs-tail_current_empty"
  | "logs-tail_current_unicode"
  | "logs-tail_legacy_basic"
  | "logs-tail_legacy_bulk"
  | "logs-tail_legacy_empty"
  | "logs-tail_ancient_basic"
  | "logs-tail_ignored_bulk"
  | "logs-tail_jsonfmt_bulk"
  | "logs-tail_echo_argv"
  | "logs-tail_real_tail_text";

/**
 * True when this call is semantically the one legacyBasicStdout was captured
 * from: a whole-window read of the basic dataset (no `startFromHead`, no
 * `--max-items`, the 500-event slice). Keyed on meaning, not on argv order, so
 * an extra global flag cannot invalidate the capture.
 */
function isCapturedLegacyBasicCall(argv: readonly string[], payload: Record<string, unknown>): boolean {
  if ("startFromHead" in payload) return false;
  if (argv.includes("--max-items")) return false;
  const slice = TAIL_QUERY_RE.exec(flagValue(argv, "--query") ?? "");
  return slice?.[1] === "500";
}

/**
 * Dispatch for the `logs-tail_*` fake-aws scenarios. `env` carries the argv
 * side channel: AWS_MCP_FAKE_LOGS_TAIL_ARGV_LOG names a file this APPENDS one
 * `{argv, params}` JSON line to per invocation -- append, because one handler
 * call can invoke the CLI twice and the whole point is to see both.
 */
export function runLogsTailScenario(
  scenario: LogsTailScenario,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): FakeCliOutcome {
  const logPath = env.AWS_MCP_FAKE_LOGS_TAIL_ARGV_LOG;
  if (logPath) {
    let params: unknown = null;
    try {
      params = readCliInputJson(argv)?.params ?? null;
    } catch {
      // A payload this scenario is about to refuse anyway; the argv line is
      // still worth having.
    }
    writeFileSync(logPath, `${JSON.stringify({ argv, params })}\n`, { flag: "a" });
  }

  switch (scenario) {
    case "logs-tail_current_basic":
      return emulateFilterLogEvents(argv, "current", BASIC_EVENTS);
    case "logs-tail_current_bulk":
      return emulateFilterLogEvents(argv, "current", bulkEvents());
    case "logs-tail_current_empty":
      return emulateFilterLogEvents(argv, "current", []);
    case "logs-tail_current_unicode":
      return emulateFilterLogEvents(argv, "current", UNICODE_EVENTS);
    case "logs-tail_legacy_basic": {
      // The one scenario that answers with captured BYTES rather than the
      // emulator, so the handler's parser meets the real CLI's exact output.
      let payload: Record<string, unknown> = {};
      try {
        payload = (readCliInputJson(argv)?.params ?? {}) as Record<string, unknown>;
      } catch {
        return fail("logs-tail_legacy_basic could not read --cli-input-json");
      }
      if ("startFromHead" in payload) return paramValidation(REAL_CLI_CAPTURES.startFromHeadRejectStderr);
      if (!isCapturedLegacyBasicCall(argv, payload)) {
        return fail(
          "logs-tail_legacy_basic serves the captured whole-window read (no startFromHead, no --max-items, events[-500:]); this call asked for something else",
        );
      }
      return { stdout: REAL_CLI_CAPTURES.legacyBasicStdout, stderr: "", exitCode: 0 };
    }
    case "logs-tail_legacy_bulk":
      return emulateFilterLogEvents(argv, "legacy", bulkEvents());
    case "logs-tail_legacy_empty":
      return emulateFilterLogEvents(argv, "legacy", []);
    case "logs-tail_ancient_basic":
      return emulateFilterLogEvents(argv, "ancient", BASIC_EVENTS);
    case "logs-tail_ignored_bulk":
      return emulateFilterLogEvents(argv, "current", bulkEvents(), { ignoresStartFromHead: true });
    case "logs-tail_jsonfmt_bulk":
      return emulateFilterLogEvents(argv, "legacy", bulkEvents(), { errorFormat: "json" });
    case "logs-tail_echo_argv":
      // The payload is what such a test reads, out of the argv log above; the
      // handler still needs a well-formed answer to get past its parser.
      return { stdout: `${JSON.stringify({ total: 0, events: [] }, null, 4)}\n`, stderr: "", exitCode: 0 };
    case "logs-tail_real_tail_text":
      return { stdout: REAL_CLI_CAPTURES.tailFormatJsonStdout, stderr: "", exitCode: 0 };
  }
}

/**
 * The FilterLogEvents operation and the 23 shapes it reaches, from botocore's
 * `botocore/data/logs/2014-03-28/service-2.json` (Apache-2.0,
 * https://github.com/boto/botocore) with the `documentation` fields stripped.
 *
 * Committed as test data so writeModelOverlay can hand a real CLI, through
 * AWS_DATA_PATH, a model that KNOWS `startFromHead` -- the member AWS CLI 2.35.8
 * added and neither local CLI has. Without it the newest-first path has no
 * real-CLI coverage at all on a current machine; with it the same binary
 * exercises all three eras. A model this small leaves only `filter-log-events`
 * reachable under `aws logs`, which is all the suite calls.
 */
export const FILTER_LOG_EVENTS_MODEL =
  '{"version":"2.0","metadata":{"apiVersion":"2014-03-28","endpointPrefix":"logs","jsonVersion":"1.1","protocol":"json","protocols":["json"],"serviceFullName":"Amazon CloudWatch Logs","serviceId":"CloudWatch Logs","signatureVersion":"v4","targetPrefix":"Logs_20140328","uid":"logs-2014-03-28","auth":["aws.auth#sigv4"]},"operations":{"FilterLogEvents":{"name":"FilterLogEvents","http":{"method":"POST","requestUri":"/"},"input":{"shape":"FilterLogEventsRequest"},"output":{"shape":"FilterLogEventsResponse"},"errors":[{"shape":"InvalidParameterException"},{"shape":"ResourceNotFoundException"},{"shape":"ServiceUnavailableException"}]}},"shapes":{"FilterLogEventsRequest":{"type":"structure","members":{"logGroupName":{"shape":"LogGroupName"},"logGroupIdentifier":{"shape":"LogGroupIdentifier"},"logStreamNames":{"shape":"InputLogStreamNames"},"logStreamNamePrefix":{"shape":"LogStreamName"},"startTime":{"shape":"Timestamp"},"endTime":{"shape":"Timestamp"},"filterPattern":{"shape":"FilterPattern"},"nextToken":{"shape":"NextToken"},"limit":{"shape":"EventsLimit"},"startFromHead":{"shape":"StartFromHead"},"interleaved":{"shape":"Interleaved","deprecated":true,"deprecatedMessage":"Starting on June 17, 2019, this parameter will be ignored and the value will be assumed to be true. The response from this operation will always interleave events from multiple log streams within a log group."},"unmask":{"shape":"Unmask"}}},"LogGroupName":{"type":"string","max":512,"min":1,"pattern":"[\\\\.\\\\-_/#A-Za-z0-9]+"},"LogGroupIdentifier":{"type":"string","max":2048,"min":1,"pattern":"[\\\\w#+=/:,.@-]*"},"InputLogStreamNames":{"type":"list","member":{"shape":"LogStreamName"},"max":100,"min":1},"LogStreamName":{"type":"string","max":512,"min":1,"pattern":"[^:*]*"},"Timestamp":{"type":"long","min":0},"FilterPattern":{"type":"string","max":1024,"min":0},"NextToken":{"type":"string","min":1},"EventsLimit":{"type":"integer","max":10000,"min":1},"StartFromHead":{"type":"boolean"},"Interleaved":{"type":"boolean"},"Unmask":{"type":"boolean"},"FilterLogEventsResponse":{"type":"structure","members":{"events":{"shape":"FilteredLogEvents"},"searchedLogStreams":{"shape":"SearchedLogStreams"},"nextToken":{"shape":"NextToken"}}},"FilteredLogEvents":{"type":"list","member":{"shape":"FilteredLogEvent"}},"FilteredLogEvent":{"type":"structure","members":{"logStreamName":{"shape":"LogStreamName"},"timestamp":{"shape":"Timestamp"},"message":{"shape":"EventMessage"},"ingestionTime":{"shape":"Timestamp"},"eventId":{"shape":"EventId"}}},"EventMessage":{"type":"string","min":1},"EventId":{"type":"string"},"SearchedLogStreams":{"type":"list","member":{"shape":"SearchedLogStream"}},"SearchedLogStream":{"type":"structure","members":{"logStreamName":{"shape":"LogStreamName"},"searchedCompletely":{"shape":"LogStreamSearchedCompletely"}}},"LogStreamSearchedCompletely":{"type":"boolean"},"InvalidParameterException":{"type":"structure","members":{},"exception":true},"ResourceNotFoundException":{"type":"structure","members":{},"exception":true},"ServiceUnavailableException":{"type":"structure","members":{},"exception":true,"fault":true}}}';

/**
 * The CLI paginates FilterLogEvents only when a paginator model is visible, and
 * an AWS_DATA_PATH overlay replaces the whole service directory rather than
 * merging into it -- so the overlay has to carry this too or `--max-items`
 * silently stops working.
 */
const FILTER_LOG_EVENTS_PAGINATORS =
  '{"pagination":{"FilterLogEvents":{"input_token":"nextToken","output_token":"nextToken","limit_key":"limit","result_key":["events","searchedLogStreams"]}}}';

/**
 * Write `logs/2014-03-28/{service-2,paginators-1}.json` under `dir` and return
 * `dir`, ready for AWS_DATA_PATH. The variants are the three eras of the API as
 * the CLI saw them:
 *   - `current`: `startFromHead` present (AWS CLI 2.35.8+);
 *   - `legacy`: no `startFromHead` (2.9.15 through 2.35.7, and both local CLIs);
 *   - `ancient`: no `startFromHead`, no `logGroupIdentifier`, `logGroupName`
 *     required (before 2.9.2).
 */
export function writeModelOverlay(dir: string, variant: FleModelVariant): string {
  const model = JSON.parse(FILTER_LOG_EVENTS_MODEL) as {
    shapes: { FilterLogEventsRequest: { members: Record<string, unknown>; required?: string[] } };
  };
  const request = model.shapes.FilterLogEventsRequest;
  if (variant !== "current") delete request.members.startFromHead;
  if (variant === "ancient") {
    delete request.members.logGroupIdentifier;
    request.required = ["logGroupName"];
  }
  const target = join(dir, "logs", "2014-03-28");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "service-2.json"), JSON.stringify(model));
  writeFileSync(join(target, "paginators-1.json"), FILTER_LOG_EVENTS_PAGINATORS);
  return dir;
}
