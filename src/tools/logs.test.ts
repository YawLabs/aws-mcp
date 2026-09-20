import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { runAwsCall } from "../aws-cli.js";
import { REAL_CLI_CAPTURES, TAIL_QUERY_RE } from "../testing/logs-tail-fake.js";
import {
  _resetLogsTailCliModelCache,
  buildTailParams,
  buildTailQuery,
  DEFAULT_MAX_EVENTS,
  DEFAULT_QUERY_LIMIT,
  detectFleModelGaps,
  fetchIgnoredStartFromHead,
  flattenQueryRows,
  isValidLogStreamName,
  isValidQueryId,
  LOG_GROUP_IDENTIFIER_MIN_CLI,
  LOG_GROUP_RE,
  LOG_STREAM_NAME_RE,
  logsTools,
  MAX_MAX_EVENTS,
  MAX_QUERY_LIMIT,
  MAX_QUERY_LOG_GROUPS,
  MAX_QUERY_RANGE_MS,
  MAX_SINCE_MS,
  parseLogGroupArn,
  parseTailOutput,
  pollQueryUntilTerminal,
  RELATIVE_TIME_RE,
  relativeTimeMs,
  resolveLogGroupName,
  START_FROM_HEAD_MIN_CLI,
  selectTailWindow,
} from "./logs.js";

const tool = logsTools.find((t) => t.name === "aws_logs_tail");
if (!tool) throw new Error("logsTools missing aws_logs_tail");

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AWS = join(__dirname, "..", "testing", "fake-aws.js");

let prevCommand: string | undefined;
let prevPrefixArgs: string | undefined;
before(() => {
  prevCommand = process.env.AWS_MCP_TEST_AWS_COMMAND;
  prevPrefixArgs = process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS;
  process.env.AWS_MCP_TEST_AWS_COMMAND = process.execPath;
  process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS = JSON.stringify([FAKE_AWS]);
});
after(() => {
  if (prevCommand === undefined) delete process.env.AWS_MCP_TEST_AWS_COMMAND;
  else process.env.AWS_MCP_TEST_AWS_COMMAND = prevCommand;
  if (prevPrefixArgs === undefined) delete process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS;
  else process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS = prevPrefixArgs;
});

afterEach(() => {
  delete process.env.AWS_MCP_FAKE_SCENARIO;
});

describe("LOG_GROUP_RE", () => {
  it("accepts common log group shapes", () => {
    for (const name of [
      "/aws/lambda/my-fn",
      "/aws/ecs/my-service",
      "/aws/apigateway/welcome",
      "my-custom-group",
      "app/service/v2",
      "group_with_underscores",
      "/aws/codebuild/project#1",
    ]) {
      assert.match(name, LOG_GROUP_RE, `expected ${name} to match`);
    }
  });

  it("rejects leading hyphen (argv-injection defense)", () => {
    assert.doesNotMatch("-force", LOG_GROUP_RE);
    assert.doesNotMatch("--profile", LOG_GROUP_RE);
  });

  it("rejects shell-meaningful characters", () => {
    assert.doesNotMatch("/aws/lambda/foo;rm", LOG_GROUP_RE);
    assert.doesNotMatch("/aws/lambda/$(echo)", LOG_GROUP_RE);
    assert.doesNotMatch("/aws/lambda/foo bar", LOG_GROUP_RE);
  });

  it("rejects empty string", () => {
    assert.doesNotMatch("", LOG_GROUP_RE);
  });
});

describe("resolveLogGroupName", () => {
  it("passes a bare group name through unchanged", () => {
    assert.equal(resolveLogGroupName("/aws/lambda/my-fn"), "/aws/lambda/my-fn");
    assert.equal(resolveLogGroupName("my-custom-group"), "my-custom-group");
  });

  it("extracts the group name from a log-group ARN (the console's copy-button shape)", () => {
    // LOG_GROUP_RE rejects ':', so a pasted ARN used to bounce with a shape
    // error even though the group it names is perfectly valid.
    assert.equal(
      resolveLogGroupName("arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/my-fn"),
      "/aws/lambda/my-fn",
    );
  });

  it("tolerates the trailing ':*' that IAM policies and the console carry", () => {
    assert.equal(
      resolveLogGroupName("arn:aws:logs:eu-west-1:123456789012:log-group:/aws/ecs/my-service:*"),
      "/aws/ecs/my-service",
    );
  });

  it("accepts non-commercial partitions", () => {
    assert.equal(resolveLogGroupName("arn:aws-us-gov:logs:us-gov-west-1:123456789012:log-group:app/svc"), "app/svc");
  });

  it("holds an ARN-extracted name to the same argv-safety contract as a bare one", () => {
    // The extracted name still runs through LOG_GROUP_RE, so a hostile or
    // malformed group inside an otherwise well-formed ARN is still rejected.
    assert.equal(resolveLogGroupName("arn:aws:logs:us-east-1:123456789012:log-group:-force"), null);
    assert.equal(resolveLogGroupName("arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/foo;rm"), null);
  });

  it("rejects near-miss ARNs and non-group inputs", () => {
    assert.equal(resolveLogGroupName("arn:aws:logs:us-east-1:12345:log-group:/aws/lambda/fn"), null); // short account
    assert.equal(resolveLogGroupName("arn:aws:s3:::my-bucket"), null); // wrong service
    assert.equal(resolveLogGroupName("--force"), null);
    assert.equal(resolveLogGroupName(""), null);
  });
});

describe("relativeTimeMs (shared with aws_metrics_query)", () => {
  // The pattern lives here and metrics.ts imports it -- previously the two
  // files each carried a byte-identical copy.
  it("converts each documented unit", () => {
    assert.equal(relativeTimeMs("30s"), 30_000);
    assert.equal(relativeTimeMs("15m"), 15 * 60_000);
    assert.equal(relativeTimeMs("2h"), 2 * 3_600_000);
    assert.equal(relativeTimeMs("1d"), 86_400_000);
    assert.equal(relativeTimeMs("1w"), 7 * 86_400_000);
  });

  it("returns null for anything RELATIVE_TIME_RE rejects", () => {
    for (const bad of ["5", "m", "5x", "15M", "5 m", "-5m", ""]) {
      assert.equal(relativeTimeMs(bad), null, `expected '${bad}' to be rejected`);
      assert.doesNotMatch(bad, RELATIVE_TIME_RE);
    }
  });
});

// The instant every fixture below is anchored to (2026-09-19T10:00:00Z), the
// same one logs-tail-fake.ts uses.
const T0 = Date.UTC(2026, 8, 19, 10, 0, 0);
const rawEvent = (ms: number | null, message: string, logStreamName = "s1") => ({
  timestampMs: ms,
  logStreamName,
  message,
});
/** n events NEWEST first, which is what `startFromHead: false` returns. */
const descendingEvents = (n: number) =>
  Array.from({ length: n }, (_, k) => rawEvent(T0 + (n - 1 - k) * 1000, `event-${n - 1 - k}`));
/** n events OLDEST first, which is what an endpoint ignoring the member returns. */
const ascendingEvents = (n: number) => Array.from({ length: n }, (_, k) => rawEvent(T0 + k * 1000, `event-${k}`));

describe("parseTailOutput", () => {
  it("reads the document the real CLI printed for the basic dataset", () => {
    // The verbatim 2.34.3 capture, through the same JSON.parse runAwsCall does.
    const parsed = parseTailOutput(JSON.parse(REAL_CLI_CAPTURES.legacyBasicStdout));
    assert.ok(parsed, "the captured whole-window read must parse");
    assert.equal(parsed.total, 6);
    assert.equal(parsed.events.length, 6);
    const window = selectTailWindow(parsed, 500, "full-window");
    assert.equal(window.eventCount, 6);
    assert.equal(window.totalEvents, 6);
    assert.equal(window.truncated, false);
    // Timestamps convert from epoch ms to ISO 8601 UTC with milliseconds.
    assert.equal(window.events[0].timestamp, "2026-09-19T10:00:00.000Z");
    assert.equal(window.events[1].timestamp, "2026-09-19T10:00:01.123Z");
    // Messages are VERBATIM: the trailing newline Lambda's START line carries,
    // both newlines of the traceback, the JSON message byte-for-byte (the old
    // path got it back re-indented by the CLI's formatter), a stream name with a
    // space in it, a bare scalar as a string, and a message that reads like one
    // of the formatter's own header lines.
    assert.equal(window.events[0].message, "START RequestId: 11-22 Version: $LATEST\n");
    assert.equal(window.events[1].message, '{"level":"error","msg":"boom","ctx":{"id":7}}');
    assert.equal(
      window.events[2].message,
      'Traceback (most recent call last):\n  File "x.py", line 1\nValueError: bad',
    );
    assert.equal(window.events[3].logStreamName, "my stream/2026");
    assert.equal(window.events[4].message, "42");
    assert.match(window.events[5].message ?? "", /LOOKS like a tail header$/);
  });

  it("reads an empty window", () => {
    const parsed = parseTailOutput({ total: 0, events: [] });
    assert.deepEqual(parsed, { total: 0, events: [] });
  });

  it("refuses anything that is not the {total, events} document", () => {
    // THE regression pin. The parser this replaced turned `aws logs tail --format
    // json`'s TEXT into ok:true with the blob as `events`, which is how the tool
    // shipped never returning a structured event against a real CLI. Each input
    // below must be a refusal, not a guess.
    assert.equal(parseTailOutput(REAL_CLI_CAPTURES.tailFormatJsonStdout), null, "the real tail text");
    assert.equal(parseTailOutput(null), null, "empty stdout");
    assert.equal(parseTailOutput(undefined), null);
    assert.equal(parseTailOutput("something"), null, "a scalar string");
    assert.equal(parseTailOutput([{ timestamp: 1, message: "x" }]), null, "a bare array");
    assert.equal(parseTailOutput({ events: [] }), null, "no total");
    assert.equal(parseTailOutput({ total: "6", events: [] }), null, "total as a string");
    assert.equal(parseTailOutput({ total: 1.5, events: [] }), null, "a fractional total");
    assert.equal(parseTailOutput({ total: -1, events: [] }), null, "a negative total");
    assert.equal(parseTailOutput({ total: 1, events: "x" }), null, "events not an array");
  });

  it("maps a missing member to null instead of dropping the event", () => {
    // A caller counting events has to see the number the service returned.
    const parsed = parseTailOutput({ total: 2, events: [{ timestamp: T0 }, {}] });
    assert.ok(parsed);
    assert.equal(parsed.events.length, 2);
    assert.deepEqual(parsed.events[1], { timestampMs: null, logStreamName: null, message: null });
    const window = selectTailWindow(parsed, 10, "full-window");
    assert.deepEqual(window.events[1], { timestamp: null, logStreamName: null, message: null });
  });

  it("turns a timestamp Date cannot represent into null", () => {
    const parsed = parseTailOutput({
      total: 3,
      events: [{ timestamp: 9e15 }, { timestamp: "nope" }, { timestamp: T0 }],
    });
    assert.ok(parsed);
    const window = selectTailWindow(parsed, 10, "full-window");
    assert.equal(window.events[0].timestamp, null, "9e15 ms is past Date's range");
    assert.equal(window.events[1].timestamp, null, "a non-numeric timestamp");
    assert.equal(window.events[2].timestamp, "2026-09-19T10:00:00.000Z");
  });
});

describe("buildTailQuery", () => {
  it("projects every event on the newest-first path and the newest maxEvents on the other", () => {
    assert.equal(
      buildTailQuery("newest-first", 500),
      "{total: length(events || `[]`), events: (events || `[]`)[].{timestamp: timestamp, logStreamName: logStreamName, message: message}}",
    );
    assert.equal(
      buildTailQuery("full-window", 500),
      "{total: length(events || `[]`), events: (events || `[]`)[-500:].{timestamp: timestamp, logStreamName: logStreamName, message: message}}",
    );
  });

  it("defaults both members, so a reply with no events key neither errors nor parses as null", () => {
    // Both halves matter, and neither is cosmetic. `length(null)` is a hard CLI
    // failure (`In function length(), invalid type for value: None`, exit 255 on
    // 2.34.3 and 2.22.0), while a slice of null quietly yields null, which
    // parseTailOutput refuses -- so defaulting `total` alone just moves the
    // failure. The real-CLI suite proves the pair end to end; this pins the text.
    for (const mode of ["newest-first", "full-window"] as const) {
      const query = buildTailQuery(mode, 500);
      assert.match(query, /length\(events \|\| `\[\]`\)/, `${mode}: total is defaulted`);
      assert.match(query, /\(events \|\| `\[\]`\)\[/, `${mode}: the projected list is defaulted`);
    }
  });

  it("writes the only projection the fake answers, for every maxEvents", () => {
    // Drift pin between the handler and the fake CLI: the emulator exits 2 on any
    // other --query, so a projection change here without a re-capture fails loudly
    // rather than being humoured.
    for (const maxEvents of [1, 10, DEFAULT_MAX_EVENTS, MAX_MAX_EVENTS]) {
      for (const mode of ["newest-first", "full-window"] as const) {
        const query = buildTailQuery(mode, maxEvents);
        assert.match(query, TAIL_QUERY_RE, `${mode} ${maxEvents}`);
        assert.ok(query.length < 2048, "runAwsCall rejects a --query over 2048 chars");
      }
    }
  });
});

describe("buildTailParams", () => {
  const base = { logGroupName: "/aws/lambda/my-fn", logGroupIdentifier: null, startTime: T0, newestFirst: true };

  it("sends a bare name as logGroupName and an ARN as logGroupIdentifier, never both", () => {
    const bare = buildTailParams(base);
    assert.equal(bare.logGroupName, "/aws/lambda/my-fn");
    assert.equal("logGroupIdentifier" in bare, false);
    const arn = buildTailParams({
      ...base,
      logGroupIdentifier: "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/my-fn",
    });
    assert.equal(arn.logGroupIdentifier, "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/my-fn");
    assert.equal("logGroupName" in arn, false);
  });

  it("sends startFromHead:false exactly when the read is newest-first", () => {
    assert.equal(buildTailParams(base).startFromHead, false);
    assert.equal("startFromHead" in buildTailParams({ ...base, newestFirst: false }), false);
  });

  it("never sends limit, nextToken, interleaved, unmask or endTime", () => {
    // `limit` or `nextToken` in the payload turns the CLI's own pagination off, and
    // with --max-items the call then fails with `Unknown parameter in input:
    // "PaginationConfig"` (measured, exit 252). The other three have no input.
    const params = buildTailParams({
      ...base,
      filterPattern: "ERROR",
      logStreamNames: ["s1"],
    });
    for (const banned of ["limit", "nextToken", "interleaved", "unmask", "endTime"]) {
      assert.equal(banned in params, false, `${banned} must never be sent`);
    }
    assert.deepEqual(Object.keys(params).sort(), [
      "filterPattern",
      "logGroupName",
      "logStreamNames",
      "startFromHead",
      "startTime",
    ]);
  });

  it("omits an empty stream list, prefix or filter pattern", () => {
    // botocore refuses an empty logStreamNames or logStreamNamePrefix before any
    // request (`Invalid length for parameter ..., value: 0, valid min length: 1`,
    // exit 252, measured on 2.34.3 and 2.22.0), and the schema accepts both -- so
    // sending them would break calls that work today. An empty filterPattern IS
    // accepted by botocore; it is omitted for parity with the truthiness check the
    // handler has always applied.
    const params = buildTailParams({ ...base, logStreamNames: [], logStreamNamePrefix: "", filterPattern: "" });
    assert.deepEqual(Object.keys(params).sort(), ["logGroupName", "startFromHead", "startTime"]);
  });
});

describe("detectFleModelGaps", () => {
  it("recognizes a startFromHead rejection in every form the CLI prints it", () => {
    // 2.34.3's, 2.22.0's (no `aws: [ERROR]: An error occurred (ParamValidation):`
    // header), and the JSON error format, where the name carries escaped quotes.
    for (const [label, stderr] of [
      ["2.34.3", REAL_CLI_CAPTURES.startFromHeadRejectStderr],
      ["2.22.0", REAL_CLI_CAPTURES.startFromHeadRejectLegacyCliStderr],
      ["json error format", REAL_CLI_CAPTURES.startFromHeadRejectJsonFormatStderr],
      ["pre-2.9.2 model, bare name", REAL_CLI_CAPTURES.ancientBareNameRejectStderr],
    ] as const) {
      assert.deepEqual(
        detectFleModelGaps(stderr),
        { startFromHead: true, logGroupIdentifier: false },
        `expected a startFromHead gap from ${label}`,
      );
    }
  });

  it("recognizes a model that has no logGroupIdentifier at all", () => {
    // botocore reports every problem in one message, so ARN input against a
    // pre-2.9.2 model rejects the identifier AND misses the required name.
    assert.deepEqual(detectFleModelGaps(REAL_CLI_CAPTURES.ancientRejectStderr), {
      startFromHead: true,
      logGroupIdentifier: true,
    });
    // The optional-name change (AWS CLI 2.9.15) is the same era, and a model from
    // 2.9.2..2.9.14 knows logGroupIdentifier but still requires logGroupName.
    assert.deepEqual(detectFleModelGaps('Missing required parameter in input: "logGroupName"'), {
      startFromHead: false,
      logGroupIdentifier: true,
    });
  });

  it("reads the same rejection whatever the line endings are", () => {
    const lf = REAL_CLI_CAPTURES.ancientRejectStderr.replaceAll("\r\n", "\n");
    assert.deepEqual(detectFleModelGaps(lf), { startFromHead: true, logGroupIdentifier: true });
  });

  it("treats a bad VALUE for a known member as no gap at all", () => {
    // The member exists; the value was wrong. Falling back to a whole-window read
    // here would hide a real bug behind a second, slower call.
    for (const stderr of [
      "Invalid type for parameter startFromHead, value: no, type: <class 'str'>, valid types: <class 'bool'>",
      "Invalid length for parameter logStreamNames, value: 0, valid min length: 1",
      "An error occurred (AccessDeniedException) when calling the FilterLogEvents operation: User is not authorized",
      "An error occurred (ResourceNotFoundException) when calling the FilterLogEvents operation: The specified log group does not exist.",
      "",
    ]) {
      assert.deepEqual(
        detectFleModelGaps(stderr),
        { startFromHead: false, logGroupIdentifier: false },
        `expected no gap from: ${stderr.slice(0, 40)}`,
      );
    }
  });
});

describe("selectTailWindow — newest-first", () => {
  const msg = (e: { message: string | null }) => e.message;

  it("keeps the newest maxEvents and reverses them to oldest-first", () => {
    // The fetch asks for maxEvents + 1, so 501 events back means the window held
    // more than 500 -- exact, without trusting a NextToken that over-reports.
    const window = selectTailWindow({ total: 501, events: descendingEvents(501) }, 500, "newest-first");
    assert.equal(window.truncated, true);
    assert.equal(window.eventCount, 500);
    assert.equal(window.totalEvents, null, "the read stopped early, so the window's size is unknown");
    assert.equal(msg(window.events[0]), "event-1", "the sentinel event-0 is dropped as the oldest");
    assert.equal(msg(window.events[499]), "event-500");
  });

  it("treats exactly maxEvents as a complete window", () => {
    const window = selectTailWindow({ total: 500, events: descendingEvents(500) }, 500, "newest-first");
    assert.equal(window.truncated, false);
    assert.equal(window.eventCount, 500);
    assert.equal(window.totalEvents, 500, "nothing was left unread, so the count is exact");
    assert.equal(msg(window.events[0]), "event-0");
  });

  it("answers an empty window", () => {
    const window = selectTailWindow({ total: 0, events: [] }, 500, "newest-first");
    assert.deepEqual(window, { events: [], eventCount: 0, totalEvents: 0, truncated: false });
  });

  it("keeps an ascending, complete fetch exactly as it came", () => {
    // An endpoint that ignored startFromHead, but the whole window arrived: the
    // same events are the answer either way, so reversing them would be the bug.
    const window = selectTailWindow({ total: 3, events: ascendingEvents(3) }, 500, "newest-first");
    assert.equal(window.totalEvents, 3);
    assert.equal(window.truncated, false);
    assert.deepEqual(window.events.map(msg), ["event-0", "event-1", "event-2"]);
  });

  it("reads equal timestamps as newest-first, the API's documented order", () => {
    const events = [rawEvent(T0, "a"), rawEvent(T0, "b")];
    const window = selectTailWindow({ total: 2, events }, 500, "newest-first");
    assert.deepEqual(window.events.map(msg), ["b", "a"], "unclassifiable order is reversed like a descending one");
  });
});

describe("fetchIgnoredStartFromHead", () => {
  it("flags an ascending fetch that was truncated -- the wrong end of the window", () => {
    // moto and LocalStack never read startFromHead, so a newest-first read comes
    // back oldest-first; keeping the first maxEvents would present the OLDEST
    // events as the newest with truncated:true.
    assert.equal(fetchIgnoredStartFromHead(ascendingEvents(501), 500), true);
  });

  it("does not flag a descending fetch, a complete window, or one event", () => {
    assert.equal(fetchIgnoredStartFromHead(descendingEvents(501), 500), false);
    assert.equal(fetchIgnoredStartFromHead(ascendingEvents(3), 500), false, "the whole window arrived");
    assert.equal(fetchIgnoredStartFromHead(ascendingEvents(1), 0), false, "one event has no order");
    assert.equal(fetchIgnoredStartFromHead([], 0), false);
  });

  it("does not flag a fetch whose ends carry no timestamp", () => {
    const events = [rawEvent(null, "a"), rawEvent(T0, "b"), rawEvent(null, "c")];
    assert.equal(fetchIgnoredStartFromHead(events, 1), false);
  });
});

describe("selectTailWindow — full-window", () => {
  it("reports the window's exact size and keeps the newest maxEvents", () => {
    // The projection already sliced events[-maxEvents:]; `total` is what the CLI
    // fetched, which on this path is the whole window.
    const window = selectTailWindow({ total: 1200, events: ascendingEvents(500) }, 500, "full-window");
    assert.equal(window.truncated, true);
    assert.equal(window.totalEvents, 1200);
    assert.equal(window.eventCount, 500);
  });

  it("flips truncated exactly at maxEvents", () => {
    assert.equal(selectTailWindow({ total: 500, events: ascendingEvents(500) }, 500, "full-window").truncated, false);
    assert.equal(selectTailWindow({ total: 501, events: ascendingEvents(500) }, 500, "full-window").truncated, true);
  });
});

describe("parseLogGroupArn", () => {
  it("splits an ARN into its parts and drops a trailing ':*'", () => {
    assert.deepEqual(parseLogGroupArn("arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/my-fn:*"), {
      partition: "aws",
      region: "us-east-1",
      account: "123456789012",
      name: "/aws/lambda/my-fn",
      identifier: "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/my-fn",
    });
  });

  it("handles a non-commercial partition", () => {
    const parts = parseLogGroupArn("arn:aws-us-gov:logs:us-gov-west-1:123456789012:log-group:app/svc");
    assert.equal(parts?.partition, "aws-us-gov");
    assert.equal(parts?.region, "us-gov-west-1");
    assert.equal(parts?.identifier, "arn:aws-us-gov:logs:us-gov-west-1:123456789012:log-group:app/svc");
  });

  it("returns null for a bare name and for every near miss", () => {
    for (const input of [
      "/aws/lambda/my-fn",
      "arn:aws:logs:us-east-1:12345:log-group:/aws/lambda/fn",
      "arn:aws:s3:::my-bucket",
      "arn:aws:logs:us-east-1:123456789012:log-group:-force",
      "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/foo;rm",
      "--force",
      "",
    ]) {
      assert.equal(parseLogGroupArn(input), null, `expected null for '${input}'`);
    }
  });
});

describe("isValidLogStreamName", () => {
  it("accepts real-world AWS stream name shapes", () => {
    for (const name of [
      "2026/04/21/[$LATEST]abc",
      "main-stream",
      "app/service/v2",
      "x",
      "stream_with_underscores",
      "stream.with.dots",
      "MixedCASE-123",
    ]) {
      assert.ok(isValidLogStreamName(name), `expected ${name} to be valid`);
    }
  });

  it("accepts legitimate stream-name prefixes (used for logStreamNamePrefix)", () => {
    // A prefix is a partial stream name; the handler validates
    // logStreamNamePrefix with this same predicate. A slashed date prefix
    // like '2026/04/21/' must pass.
    for (const prefix of ["2026/04/21/", "app/service/", "main-"]) {
      assert.ok(isValidLogStreamName(prefix), `expected prefix ${prefix} to be valid`);
    }
  });

  it("rejects leading hyphen (argv-injection defense)", () => {
    assert.equal(isValidLogStreamName("-force"), false);
    assert.equal(isValidLogStreamName("--profile"), false);
  });

  it("rejects ':' and '*' (AWS forbids these)", () => {
    assert.equal(isValidLogStreamName("bad:name"), false);
    assert.equal(isValidLogStreamName("bad*name"), false);
    assert.equal(isValidLogStreamName(":leading-colon"), false);
  });

  it("allows embedded spaces (AWS permits them; only leading whitespace is blocked)", () => {
    // CloudWatch's CreateLogStream pattern is [^:*]*, which allows spaces.
    // Our validator blocks a leading space (argv-safety) but must not forbid
    // spaces elsewhere -- a future 'fix' removing the space carve-out would
    // reject real stream names.
    assert.equal(isValidLogStreamName("stream with space"), true);
    assert.equal(isValidLogStreamName("my stream/2026"), true);
  });

  it("rejects control characters and whitespace leads", () => {
    assert.equal(isValidLogStreamName("bad\x01name"), false);
    assert.equal(isValidLogStreamName(" leading-space"), false);
    assert.equal(isValidLogStreamName("tab\tinside"), false);
  });

  it("rejects embedded DEL and high control chars", () => {
    assert.equal(isValidLogStreamName("has\x00null"), false);
    assert.equal(isValidLogStreamName("has\x1fus"), false);
  });

  it("rejects empty string and over-length names", () => {
    assert.equal(isValidLogStreamName(""), false);
    assert.equal(isValidLogStreamName("a".repeat(513)), false);
    assert.equal(isValidLogStreamName("a".repeat(512)), true);
  });

  it("LOG_STREAM_NAME_RE alone still rejects structural issues", () => {
    // Keep coverage on the raw regex in case callers reach for it directly.
    assert.doesNotMatch("-bad", LOG_STREAM_NAME_RE);
    assert.match("2026/04/21/[$LATEST]abc", LOG_STREAM_NAME_RE);
  });
});

describe("aws_logs_tail schema", () => {
  it("accepts a minimal valid call", () => {
    assert.equal(tool.inputSchema.safeParse({ logGroupName: "/aws/lambda/my-fn" }).success, true);
  });

  it("accepts maxEvents across its documented range", () => {
    for (const maxEvents of [1, 10, DEFAULT_MAX_EVENTS, MAX_MAX_EVENTS]) {
      assert.equal(
        tool.inputSchema.safeParse({ logGroupName: "/aws/lambda/my-fn", maxEvents }).success,
        true,
        `expected maxEvents=${maxEvents} to parse`,
      );
    }
  });

  it("rejects maxEvents outside 1..MAX_MAX_EVENTS and non-integers", () => {
    // Both sides of the ceiling in one test, so a future `.max()` edit fails
    // here rather than at runtime.
    for (const maxEvents of [0, -1, 1.5, MAX_MAX_EVENTS + 1, "500"]) {
      assert.equal(
        tool.inputSchema.safeParse({ logGroupName: "/aws/lambda/my-fn", maxEvents }).success,
        false,
        `expected maxEvents=${JSON.stringify(maxEvents)} to be rejected`,
      );
    }
  });

  it("accepts typical since values", () => {
    for (const since of ["5m", "30s", "2h", "1d", "1w"]) {
      assert.equal(
        tool.inputSchema.safeParse({ logGroupName: "/aws/lambda/my-fn", since }).success,
        true,
        `expected ${since} to parse`,
      );
    }
  });

  it("rejects uppercase unit suffixes (the vocabulary is lowercase-only)", () => {
    // The vocabulary came from `aws logs tail --since`, which rejects "15M"/"2H";
    // the window is resolved here now, but the accepted input set is unchanged, so
    // the schema still rejects them. Anchored case so a future `/i` flip gets
    // caught here rather than at runtime.
    for (const since of ["15M", "2H", "1D", "1W", "30S"]) {
      assert.equal(
        tool.inputSchema.safeParse({ logGroupName: "/aws/lambda/my-fn", since }).success,
        false,
        `expected ${since} to be rejected (uppercase unit)`,
      );
    }
  });

  it("rejects malformed since values", () => {
    for (const since of ["5", "m", "5minutes", "-5m", "5 m"]) {
      assert.equal(
        tool.inputSchema.safeParse({ logGroupName: "/aws/lambda/my-fn", since }).success,
        false,
        `expected ${since} to fail`,
      );
    }
  });

  it("accepts filterPattern, logStreamNames, logStreamNamePrefix", () => {
    const r = tool.inputSchema.safeParse({
      logGroupName: "/aws/lambda/my-fn",
      filterPattern: "ERROR",
      logStreamNames: ["2026/04/21/[$LATEST]abc"],
    });
    assert.equal(r.success, true);
  });

  it("rejects missing logGroupName", () => {
    assert.equal(tool.inputSchema.safeParse({}).success, false);
  });

  it("names both AWS CLI floors its behavior depends on, inside the description budget", () => {
    // A caller reading the description has to know which floor explains
    // `totalEvents: null` and which one explains an ARN rejection, and the whole
    // string has to stay inside the 2,000-byte budget every tool is held to.
    const escaped = (v: string) => v.replaceAll(".", ".");
    assert.match(tool.description, new RegExp(`AWS CLI ${escaped(START_FROM_HEAD_MIN_CLI)}+`));
    assert.match(tool.description, new RegExp(`AWS CLI ${escaped(LOG_GROUP_IDENTIFIER_MIN_CLI)}+`));
    assert.ok(
      Buffer.byteLength(tool.description) < 2000,
      `description is ${Buffer.byteLength(tool.description)} bytes`,
    );
  });
});

describe("aws_logs_tail handler — input validation (no spawn)", () => {
  it("rejects logGroupName with a leading hyphen", async () => {
    const r = (await tool.handler({ logGroupName: "--force" })) as {
      ok: boolean;
      error?: string;
      errorKind?: string;
      suggestion?: string;
    };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid logGroupName/);
    // NEGATIVE contract: this guard returns before runAwsCall (the describe
    // name says "no spawn"), so nothing classified the failure. An ABSENT
    // errorKind means "unclassified" -- never "nonzero_exit", and never a
    // manufactured "bad_input".
    assert.equal(r.errorKind, undefined);
    assert.equal(r.suggestion, undefined);
  });

  it("rejects logGroupName with shell metachars", async () => {
    const r = (await tool.handler({ logGroupName: "/aws/lambda/foo;rm" })) as { ok: boolean; error?: string };
    assert.equal(r.ok, false);
  });

  it("rejects mutually exclusive logStreamNames + logStreamNamePrefix", async () => {
    const r = (await tool.handler({
      logGroupName: "/aws/lambda/my-fn",
      logStreamNames: ["s1"],
      logStreamNamePrefix: "pre",
    })) as { ok: boolean; error?: string };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /not both/);
  });

  it("rejects logStreamNames containing a flag-like entry", async () => {
    const r = (await tool.handler({
      logGroupName: "/aws/lambda/my-fn",
      logStreamNames: ["good", "--force"],
    })) as { ok: boolean; error?: string };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid logStreamName/);
  });

  it("rejects logStreamNames containing forbidden characters", async () => {
    const r = (await tool.handler({
      logGroupName: "/aws/lambda/my-fn",
      logStreamNames: ["bad:name"],
    })) as { ok: boolean; error?: string };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid logStreamName/);
  });

  it("rejects a hostile logStreamNamePrefix (leading hyphen)", async () => {
    for (const prefix of ["-rf", "--force"]) {
      const r = (await tool.handler({
        logGroupName: "/aws/lambda/my-fn",
        logStreamNamePrefix: prefix,
      })) as { ok: boolean; error?: string };
      assert.equal(r.ok, false, `expected ${prefix} to be rejected`);
      assert.match(r.error ?? "", /Invalid logStreamNamePrefix/);
    }
  });

  it("rejects a logStreamNamePrefix with control characters", async () => {
    const r = (await tool.handler({
      logGroupName: "/aws/lambda/my-fn",
      logStreamNamePrefix: "bad\x01prefix",
    })) as { ok: boolean; error?: string };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid logStreamNamePrefix/);
  });

  it("accepts a log-group ARN where a bare name is expected", async () => {
    // Reaches the spawn path, so only assert that validation let it through --
    // the ARN branch itself is pinned by the resolveLogGroupName cases above.
    const r = (await tool.handler({
      logGroupName: "arn:aws:logs:us-east-1:123456789012:log-group:-force",
    })) as { ok: boolean; error?: string };
    assert.equal(r.ok, false, "a hostile group name inside an ARN is still rejected");
    assert.match(r.error ?? "", /Invalid logGroupName/);
    assert.match(r.error ?? "", /log-group ARN/, "the error must name the ARN form as accepted input");
  });

  it("rejects a zero-width since window", async () => {
    // '0m' matched the shape regex, spawned the CLI, and came back ok:true with
    // eventCount:0 -- indistinguishable from 'the log group is quiet'.
    for (const since of ["0m", "0s", "0h", "0d", "0w"]) {
      const r = (await tool.handler({ logGroupName: "/aws/lambda/my-fn", since })) as {
        ok: boolean;
        error?: string;
      };
      assert.equal(r.ok, false, `expected ${since} to be rejected`);
      assert.match(r.error ?? "", /zero-width window/);
    }
  });

  it("rejects a since window beyond the maximum", async () => {
    // A window this wide spends FilterLogEvents call after call; the timeout and
    // the 5 MB stdout cap only fire AFTER those calls are paid for.
    const r = (await tool.handler({ logGroupName: "/aws/lambda/my-fn", since: "520w" })) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /maximum is 30 days/);
    assert.equal(MAX_SINCE_MS, 30 * 86_400_000, "error text above is anchored to MAX_SINCE_MS");
  });

  it("still runs the windows the description documents (boundary: 4w in, 5w out)", async () => {
    // The cap must not shrink the vocabulary the tool advertises ('1w', '3d').
    // 4w (28 days) is inside the 30-day ceiling and runs; 5w (35 days) is not.
    process.env.AWS_MCP_FAKE_SCENARIO = "logs-tail_current_empty";
    const inside = (await tool.handler({ logGroupName: "/aws/lambda/my-fn", since: "4w" })) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(inside.ok, true, "28 days must still be allowed");
    const outside = (await tool.handler({ logGroupName: "/aws/lambda/my-fn", since: "5w" })) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(outside.ok, false, "35 days is over the ceiling");
    assert.match(outside.error ?? "", /maximum is 30 days/);
  });

  it("accepts EXACTLY the maximum window and rejects one day more (30d in, 31d out)", async () => {
    // The 4w/5w case above brackets the ceiling but straddles it by 2 days on
    // one side and 5 on the other, so an off-by-one in the comparison (`>=`
    // instead of `>`) survives it. The cap is inclusive: sinceMs > MAX_SINCE_MS
    // rejects, so exactly 30 days must still run.
    assert.equal(relativeTimeMs("30d"), MAX_SINCE_MS, "precondition: '30d' is exactly the ceiling");
    process.env.AWS_MCP_FAKE_SCENARIO = "logs-tail_current_empty";
    const atMax = (await tool.handler({ logGroupName: "/aws/lambda/my-fn", since: "30d" })) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(atMax.ok, true, `exactly 30 days must be allowed, got: ${atMax.error ?? ""}`);
    const overMax = (await tool.handler({ logGroupName: "/aws/lambda/my-fn", since: "31d" })) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(overMax.ok, false, "31 days is one day over the ceiling");
    assert.match(overMax.error ?? "", /maximum is 30 days/);
    assert.match(overMax.error ?? "", /asks for a 31-day window/);
  });

  it("rejects a filterPattern that starts with '-'", async () => {
    // The pattern travels inside --cli-input-json now, so a leading '-' was never
    // exploitable and is not an argv concern at all -- the guard stays so this
    // release does not widen the accepted input set as well. Real CloudWatch filter
    // patterns never start with '-' (they start with a literal word, a quote, or
    // '[' for structured matching), so the reject costs nothing.
    const r = (await tool.handler({
      logGroupName: "/aws/lambda/my-fn",
      filterPattern: "-x",
    })) as { ok: boolean; error?: string };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /filterPattern/);
    assert.match(r.error ?? "", /must not start with '-'/);
  });
});

describe("aws_logs_tail handler — log-group ARN region check (no spawn)", () => {
  // FilterLogEvents is regional, so an ARN from another region is rejected HERE
  // rather than read as a same-named group in the call's region, which is what the
  // old name-extraction did silently. Every case pins the region explicitly: the
  // check reads `i.region ?? getRegion()`, and a developer shell carrying
  // AWS_REGION=eu-west-1 must not change the answer.
  const ARN = "arn:aws:logs:us-west-2:123456789012:log-group:/aws/lambda/my-fn";
  let prevRegion: string | undefined;
  let prevDefaultRegion: string | undefined;
  before(() => {
    prevRegion = process.env.AWS_REGION;
    prevDefaultRegion = process.env.AWS_DEFAULT_REGION;
    _resetLogsTailCliModelCache();
  });
  after(() => {
    if (prevRegion === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = prevRegion;
    if (prevDefaultRegion === undefined) delete process.env.AWS_DEFAULT_REGION;
    else process.env.AWS_DEFAULT_REGION = prevDefaultRegion;
  });

  it("refuses an ARN whose region is not the call's, naming both regions", async () => {
    const r = (await tool.handler({ logGroupName: ARN, region: "us-east-1" })) as {
      ok: boolean;
      error?: string;
      errorKind?: string;
      suggestion?: string;
    };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /us-west-2/);
    assert.match(r.error ?? "", /us-east-1/);
    assert.match(r.error ?? "", /FilterLogEvents is regional/);
    assert.match(r.error ?? "", /pass the bare name '\/aws\/lambda\/my-fn'/);
    // Nothing was spawned, so nothing classified this failure.
    assert.equal(r.errorKind, undefined);
    assert.equal(r.suggestion, undefined);
  });

  it("says which region it compared against when the call named none", async () => {
    process.env.AWS_REGION = "us-east-1";
    delete process.env.AWS_DEFAULT_REGION;
    const r = (await tool.handler({ logGroupName: ARN })) as { ok: boolean; error?: string };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /'us-east-1' \(the session\/default region\)/);
  });

  it("lets a matching region through to the call", async () => {
    process.env.AWS_REGION = "us-east-1";
    delete process.env.AWS_DEFAULT_REGION;
    process.env.AWS_MCP_FAKE_SCENARIO = "logs-tail_current_empty";
    const r = (await tool.handler({
      logGroupName: "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/my-fn",
      region: "us-east-1",
    })) as { ok: boolean; error?: string; data?: { logGroupIdentifier: string | null } };
    assert.equal(r.ok, true, `expected the ARN to be accepted, got: ${r.error ?? ""}`);
    assert.equal(
      r.data?.logGroupIdentifier,
      "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/my-fn",
      "the envelope echoes the identifier that was sent",
    );
  });
});

// ---------------------------------------------------------------------------
// aws_logs_query
// ---------------------------------------------------------------------------

const queryTool = logsTools.find((t) => t.name === "aws_logs_query");
if (!queryTool) throw new Error("logsTools missing aws_logs_query");

const okQuery = (over: Record<string, unknown> = {}) => ({
  logGroupNames: ["/aws/lambda/my-fn"],
  queryString: "fields @timestamp, @message",
  ...over,
});

describe("aws_logs_query schema", () => {
  it("requires logGroupNames (1..MAX_QUERY_LOG_GROUPS) and a non-empty queryString", () => {
    assert.equal(queryTool.inputSchema.safeParse({}).success, false);
    assert.equal(queryTool.inputSchema.safeParse(okQuery({ logGroupNames: [] })).success, false);
    assert.equal(queryTool.inputSchema.safeParse(okQuery({ queryString: "" })).success, false);
    assert.equal(queryTool.inputSchema.safeParse(okQuery()).success, true);

    const names = (n: number) => Array.from({ length: n }, (_, i) => `/g/${i}`);
    assert.equal(
      queryTool.inputSchema.safeParse(okQuery({ logGroupNames: names(MAX_QUERY_LOG_GROUPS) })).success,
      true,
    );
    assert.equal(
      queryTool.inputSchema.safeParse(okQuery({ logGroupNames: names(MAX_QUERY_LOG_GROUPS + 1) })).success,
      false,
    );
  });

  it("restricts queryLanguage to CWLI | PPL -- SQL names its log groups inside the query string", () => {
    // AWS: "The exception is queries using the OpenSearch Service SQL query
    // language, where you specify the log group names inside the querystring
    // instead of here." This tool always sends logGroupNames, so SQL is routed
    // to aws_call rather than silently conflicting.
    for (const queryLanguage of ["CWLI", "PPL"]) {
      assert.equal(queryTool.inputSchema.safeParse(okQuery({ queryLanguage })).success, true, queryLanguage);
    }
    assert.equal(queryTool.inputSchema.safeParse(okQuery({ queryLanguage: "SQL" })).success, false);
  });

  it("bounds limit at MAX_QUERY_LIMIT, which is GetQueryResults' single-call ceiling", () => {
    // NOT StartQuery's documented 100,000: one GetQueryResults call returns at
    // most 10,000 rows, and the remainder is only reachable through pagination
    // members the installed CLI's model does not carry.
    for (const limit of [1, DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT]) {
      assert.equal(queryTool.inputSchema.safeParse(okQuery({ limit })).success, true, String(limit));
    }
    for (const limit of [0, -1, 1.5, MAX_QUERY_LIMIT + 1]) {
      assert.equal(queryTool.inputSchema.safeParse(okQuery({ limit })).success, false, String(limit));
    }
  });

  it("declares read-only, non-destructive annotations", () => {
    assert.deepEqual(queryTool.annotations, {
      title: "Run a CloudWatch Logs Insights query and wait for results",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
  });
});

describe("isValidQueryId", () => {
  it("accepts a bounded, argv-safe id and rejects the rest", () => {
    assert.equal(isValidQueryId("f1e2d3c4-1234-5678-9abc-def012345678"), true);
    assert.equal(isValidQueryId("a".repeat(256)), true);
    assert.equal(isValidQueryId(""), false);
    assert.equal(isValidQueryId("a".repeat(257)), false);
    assert.equal(isValidQueryId("-x"), false, "leading hyphen could masquerade as a flag");
    assert.equal(isValidQueryId("a\nb"), false, "control characters are rejected");
    // A SPACE is allowed, matching isValidIdentifier / isValidOpaqueToken in
    // resource.ts: the value goes into a single argv entry and never through a
    // shell, so an embedded space cannot split it into a second argument. Only
    // control characters (< 0x20) and a leading hyphen are dangerous there.
    assert.equal(isValidQueryId("a b"), true);
  });
});

describe("flattenQueryRows", () => {
  it("flattens {field,value} pairs into objects and collects fields in first-seen order", () => {
    const { rows, fields } = flattenQueryRows([
      [
        { field: "@message", value: "a" },
        { field: "@ptr", value: "p" },
      ],
      [{ field: "@message", value: "b" }],
    ]);
    assert.deepEqual(fields, ["@message", "@ptr"]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]["@message"], "a");
    assert.equal(rows[0]["@ptr"], "p");
    assert.equal(rows[1]["@message"], "b");
  });

  it("skips a non-string field name and nulls a non-string value", () => {
    const { rows, fields } = flattenQueryRows([
      [
        { field: 42, value: "x" },
        { field: "@m", value: { nested: true } },
      ],
    ]);
    assert.deepEqual(fields, ["@m"]);
    assert.equal(rows[0]["@m"], null);
  });

  it("a literal __proto__ field becomes an OWN property and does not poison Object.prototype", () => {
    // Field names come from the caller's own log data -- Insights discovers JSON
    // keys automatically -- so "__proto__" is reachable input, not a hypothetical.
    const { rows } = flattenQueryRows([[{ field: "__proto__", value: "pwned" }]]);
    assert.deepEqual(Object.keys(rows[0]), ["__proto__"]);
    // Both rules fire on the next line and they contradict each other here:
    // useLiteralKeys wants dot notation, noProto forbids naming __proto__ at all.
    // Naming it IS the test -- it asserts an OWN property was created rather than
    // the prototype setter being reached -- so both are suppressed deliberately.
    // biome-ignore lint/suspicious/noProto: naming __proto__ is the assertion itself
    // biome-ignore lint/complexity/useLiteralKeys: bracket form is required by the line above
    assert.equal(JSON.parse(JSON.stringify(rows[0]))["__proto__"], "pwned");
    assert.equal(Object.getPrototypeOf({}), Object.prototype);
    // biome-ignore lint/suspicious/noProto: the control proving Object.prototype was not polluted
    assert.equal(({} as Record<string, unknown>).__proto__, Object.prototype);
  });

  it("returns empty rows and fields for non-array input", () => {
    assert.deepEqual(flattenQueryRows(null), { rows: [], fields: [] });
    assert.deepEqual(flattenQueryRows("nope"), { rows: [], fields: [] });
  });

  it("drops a non-array ROW entirely rather than emitting an empty object", () => {
    // The consequential one of the malformed shapes: rowCount feeds the
    // `truncated` comparison, so a discarded row silently shrinking the count
    // is indistinguishable from "the query matched fewer records" -- and an
    // empty object in its place would be a row the caller cannot read.
    const { rows, fields } = flattenQueryRows([
      [{ field: "@m", value: "a" }],
      "not-a-row",
      null,
      [{ field: "@m", value: "b" }],
    ]);
    assert.equal(rows.length, 2);
    assert.deepEqual(fields, ["@m"]);
  });

  it("collapses a field repeated within one row to the LAST value, with one fields entry", () => {
    // Documented in the function's own doc comment ("Two pairs with the same
    // field name in one row collapse to the last"), and nothing held the code
    // to it. The single fields entry is the other half: `seen` must dedupe.
    const { rows, fields } = flattenQueryRows([
      [
        { field: "@m", value: "first" },
        { field: "@m", value: "second" },
      ],
    ]);
    assert.equal(rows[0]["@m"], "second");
    assert.deepEqual(fields, ["@m"], "one entry, not two");
  });

  it("skips every unusable pair shape, including an EMPTY-STRING field name", () => {
    // The empty-string `field` is the branch worth having here; the non-string
    // half of the same condition is already pinned above.
    const { rows, fields } = flattenQueryRows([
      [null, "pair", 7, { field: "", value: "x" }, { field: "@ok", value: "y" }],
    ]);
    // Rows are Object.create(null), so deepStrictEqual against an object
    // literal fails on the prototype check -- assert through Object.keys, the
    // way the __proto__ case above does.
    assert.deepEqual(Object.keys(rows[0]), ["@ok"]);
    assert.deepEqual(fields, ["@ok"]);
  });
});

describe("pollQueryUntilTerminal", () => {
  // A scripted GetQueryResults caller: one response per call, in order.
  const scriptedCaller = (statuses: Array<string | null>, results: unknown[][] = []) => {
    const calls: Array<Parameters<typeof runAwsCall>[0]> = [];
    let n = 0;
    const call = async (opts: Parameters<typeof runAwsCall>[0]) => {
      calls.push(opts);
      const status = statuses[Math.min(n, statuses.length - 1)];
      const rows = results[Math.min(n, results.length - 1)] ?? [];
      n++;
      return {
        ok: true as const,
        data: { ...(status === null ? {} : { status }), results: rows, statistics: {} },
        command: "aws logs get-query-results",
        rawStdout: "",
      };
    };
    return { call, calls };
  };

  it("keeps polling through Scheduled and Running, and returns on Complete", async () => {
    const { call, calls } = scriptedCaller(["Scheduled", "Running", "Complete"]);
    const slept: number[] = [];
    const r = await pollQueryUntilTerminal(
      { queryId: "q1", pollIntervalMs: 1234, maxWaitMs: 60_000 },
      call,
      async (ms: number) => {
        slept.push(ms);
      },
    );
    assert.equal(r.reason, "terminal");
    assert.equal(r.status, "Complete");
    assert.equal(r.attempts, 3);
    assert.deepEqual(slept, [1234, 1234], "one sleep BETWEEN polls, none before the first or after the last");
    for (const c of calls) {
      assert.equal(c.service, "logs");
      assert.equal(c.operation, "get-query-results");
      assert.deepEqual(c.extraFlags, ["--query-id", "q1"]);
    }
  });

  it("treats every non-in-flight status as terminal, including unrecognized and missing", async () => {
    // The allowlist is Scheduled/Running: anything else stops. A status AWS adds
    // after this release lands here rather than spinning to the budget.
    for (const status of ["Failed", "Timeout", "Cancelled", "Frobnicated", null]) {
      const { call } = scriptedCaller([status]);
      const r = await pollQueryUntilTerminal(
        { queryId: "q1", pollIntervalMs: 10, maxWaitMs: 60_000 },
        call,
        async () => {},
      );
      assert.equal(r.reason, "terminal", String(status));
      assert.equal(r.attempts, 1, String(status));
      assert.equal(r.status, status, String(status));
    }
  });

  it("stops at the budget without making a call past maxWaitMs, and names the queryId", async () => {
    const { call, calls } = scriptedCaller(["Running"]);
    let now = 0;
    const r = await pollQueryUntilTerminal(
      { queryId: "q-budget", pollIntervalMs: 20, maxWaitMs: 100 },
      call,
      async (ms: number) => {
        now += ms;
      },
    );
    assert.equal(r.reason, "budget");
    assert.equal(calls.length, r.attempts, "no AWS call after the budget expired");
    assert.match(r.error ?? "", /q-budget/);
    assert.match(r.error ?? "", /maxWaitMs/);
    assert.match(r.error ?? "", /7 days/, "the resume hint must survive onto the budget arm");
    assert.ok(now >= 0);
  });

  it("makes ZERO AWS calls when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let called = 0;
    const r = await pollQueryUntilTerminal(
      {
        queryId: "q-cancel",
        pollIntervalMs: 10,
        maxWaitMs: 60_000,
        ctx: { reportProgress: () => {}, signal: controller.signal },
      },
      async () => {
        called++;
        throw new Error("must not be called");
      },
      async () => {},
    );
    assert.equal(r.reason, "cancelled");
    assert.equal(r.attempts, 0);
    assert.equal(called, 0, "the signal is checked BEFORE the first pass, not after it");
    // Never a fake success, and honest about what was and was not cancelled.
    assert.match(r.error ?? "", /NOT cancelled/);
    assert.match(r.error ?? "", /q-cancel/);
  });

  it("wakes immediately when cancellation arrives mid-sleep", async () => {
    // The real abortable sleep, with an interval far longer than the test can
    // wait: if the sleep were not abortable this would run for 30s.
    const controller = new AbortController();
    const { call } = scriptedCaller(["Running"]);
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    const r = await pollQueryUntilTerminal(
      {
        queryId: "q-midsleep",
        pollIntervalMs: 30_000,
        maxWaitMs: 60_000,
        ctx: { reportProgress: () => {}, signal: controller.signal },
      },
      call,
    );
    assert.equal(r.reason, "cancelled");
    assert.ok(Date.now() - started < 5_000, "must wake on abort, not wait out the 30s interval");
    assert.match(r.error ?? "", /NOT cancelled/);
    assert.match(r.error ?? "", /q-midsleep/);
  });

  it("reports one progress update per attempt, monotonic, with no total", async () => {
    // No honest denominator exists -- the query ends when AWS says so -- so the
    // v2.1.0 rule applies: omit `total` rather than manufacture one.
    const { call } = scriptedCaller(["Scheduled", "Running", "Complete"]);
    const seen: Array<{ progress: number; total?: number; message?: string }> = [];
    const r = await pollQueryUntilTerminal(
      {
        queryId: "q1",
        pollIntervalMs: 1,
        maxWaitMs: 60_000,
        ctx: {
          reportProgress: (progress: number, total?: number, message?: string) =>
            seen.push({ progress, total, message }),
        },
      },
      call,
      async () => {},
    );
    assert.equal(r.attempts, 3);
    assert.equal(seen.length, 3);
    assert.deepEqual(
      seen.map((s) => s.progress),
      [1, 2, 3],
    );
    for (const s of seen) assert.equal(s.total, undefined, "no fabricated denominator");
    assert.match(seen[0].message ?? "", /Scheduled/);
    assert.match(seen[2].message ?? "", /Complete/);
  });

  it("behaves identically with no ctx at all", async () => {
    const { call } = scriptedCaller(["Complete"]);
    const r = await pollQueryUntilTerminal(
      { queryId: "q1", pollIntervalMs: 1, maxWaitMs: 60_000 },
      call,
      async () => {},
    );
    assert.equal(r.reason, "terminal");
    assert.equal(r.attempts, 1);
  });

  it("clamps the inter-poll sleep to the REMAINING budget, never the raw interval", async () => {
    // The budget test above looks like it covers this but does not: its `now`
    // accumulator is never compared against anything (its closing assertion is
    // vacuous) and the loop reads real Date.now(). The only other test that
    // inspects sleep durations uses maxWaitMs 60000 against pollIntervalMs
    // 1234, where the clamp never binds. This is a single-threaded stdio
    // server, so a 30s sleep past a sub-second budget blocks every other tool
    // call for the overshoot.
    const { call } = scriptedCaller(["Running"]);
    const slept: number[] = [];
    const r = await pollQueryUntilTerminal(
      { queryId: "q-clamp", pollIntervalMs: 30_000, maxWaitMs: 200 },
      call,
      async (ms: number) => {
        slept.push(ms);
        // Sleep for REAL so the wall clock advances into the budget (the loop
        // has no injectable clock), but cap what is actually waited: a
        // regressed clamp would otherwise hang this test for the full 30s
        // instead of failing on the recorded value.
        await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5)));
      },
    );
    assert.equal(r.reason, "budget");
    assert.ok(slept.length > 0, "the loop must have slept at least once for this to assert anything");
    // Deliberately NOT a fixed slept.length or an exact value -- with no
    // injectable clock the iteration count is wall-clock dependent. The
    // ceiling is the invariant.
    for (const ms of slept) {
      assert.ok(ms <= 200, `slept ${ms}ms against a 200ms budget`);
    }
  });

  it("still makes exactly ONE call when the budget is already spent", async () => {
    // The one-shot guarantee: the budget check is skipped while attempts === 0,
    // so a caller always gets a result. Not reachable through the schema (the
    // maxWaitMs floor is 1000), so this is a unit-level invariant of the
    // exported function -- and it is what the `attempts > 0` guard is for.
    const { call, calls } = scriptedCaller(["Running"]);
    const slept: number[] = [];
    const r = await pollQueryUntilTerminal(
      { queryId: "q-zero-budget", pollIntervalMs: 30_000, maxWaitMs: 0 },
      call,
      async (ms: number) => {
        slept.push(ms);
      },
    );
    assert.equal(r.reason, "budget");
    assert.equal(r.attempts, 1);
    assert.equal(calls.length, 1);
    assert.deepEqual(slept, [], "waitMs <= 0 skips the sleep entirely");
  });

  it("returns call_failed with the kind, the suggestion, and the STDOUT fallback on empty stderr", async () => {
    // scriptedCaller always succeeds, so this return has only ever run through
    // one integration scenario -- whose stderr is non-empty and whose kind is
    // auth-class. `rawBody: result.rawStderr || result.rawStdout` is a `||` on
    // purpose: rawStderr is "" (not nullish) on a nonzero exit with empty
    // stderr, and `??` would hand back that "" so the handler's `underlying`
    // would silently fall back to the summary and lose the only raw diagnostic
    // a poll failure has.
    const reported: number[] = [];
    const failing = async () => ({
      ok: false as const,
      kind: "nonzero_exit" as const,
      error: "boom\n\nSuggestion: fix it",
      suggestion: "fix it",
      command: "aws logs get-query-results",
      rawStderr: "",
      rawStdout: "diagnostic on stdout",
    });
    const r = await pollQueryUntilTerminal(
      {
        queryId: "q-callfail",
        pollIntervalMs: 1,
        maxWaitMs: 60_000,
        ctx: { reportProgress: (progress: number) => reported.push(progress) },
      },
      failing,
      async () => {},
    );
    assert.equal(r.reason, "call_failed");
    assert.equal(r.kind, "nonzero_exit");
    // The suggestion carry is the v2.2.1 fix, and this return is the only place
    // it is observable.
    assert.equal(r.suggestion, "fix it");
    assert.equal(r.rawBody, "diagnostic on stdout");
    assert.equal(r.command, "aws logs get-query-results");
    assert.equal(r.attempts, 1, "the attempt is counted before the failure returns");
    assert.deepEqual(reported, [], "the arm returns BEFORE reportProgress");
  });
});

describe("aws_logs_query handler — the 90-day window cap", () => {
  it("rejects a window far past the ceiling, and classifies nothing", async () => {
    // startTime is an unbounded free string in the schema, so this line is the
    // only thing between a fat-fingered window and a real Insights bill --
    // Insights charges by the uncompressed bytes SCANNED, matched or not.
    const r = (await queryTool.handler(okQuery({ startTime: "520w" }))) as {
      ok: boolean;
      error?: string;
      errorKind?: string;
      suggestion?: string;
    };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /maximum is 90/);
    assert.equal(MAX_QUERY_RANGE_MS, 90 * 86_400_000, "error text above is anchored to MAX_QUERY_RANGE_MS");
    // Returns before runAwsCall, so nothing classified it -- the same negative
    // contract the aws_logs_tail no-spawn suite asserts.
    assert.equal(r.errorKind, undefined);
    assert.equal(r.suggestion, undefined);
  });

  it("accepts EXACTLY the maximum window and rejects one day more (90d in, 91d out)", async () => {
    // The cap is inclusive -- `rangeMs > MAX_QUERY_RANGE_MS` rejects -- so
    // exactly 90 days must still run, and a `>` -> `>=` flip is invisible
    // without this pair. startTime and endTime both resolve from the SAME
    // `now` inside the handler, so '90d' -> 'now' is exactly 90 days with no
    // skew between the two reads.
    process.env.AWS_MCP_FAKE_SCENARIO = "logs_query_complete";
    const atMax = (await queryTool.handler(okQuery({ startTime: "90d", endTime: "now", pollIntervalMs: 500 }))) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(atMax.ok, true, `exactly 90 days must be allowed, got: ${atMax.error ?? ""}`);

    const overMax = (await queryTool.handler(okQuery({ startTime: "91d", endTime: "now" }))) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(overMax.ok, false, "91 days is one day over the ceiling");
    assert.match(overMax.error ?? "", /requested window is 91 days/);
    assert.match(overMax.error ?? "", /maximum is 90/);
  });
});

describe("aws_logs_query handler — input validation (no spawn)", () => {
  it("rejects a flag-like logGroupNames entry and classifies nothing", async () => {
    const r = (await queryTool.handler(okQuery({ logGroupNames: ["/aws/lambda/ok", "--force"] }))) as {
      ok: boolean;
      error?: string;
      errorKind?: string;
      suggestion?: string;
    };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid logGroupName/);
    // An ABSENT errorKind means "unclassified" -- never a manufactured value.
    assert.equal(r.errorKind, undefined);
    assert.equal(r.suggestion, undefined);
  });

  it("rejects a bare-number startTime -- '5' is not '5m'", async () => {
    // Date reads "5" as a date, not a duration, so a dropped unit would
    // silently become a 25-year window with nothing rejecting it locally.
    const r = (await queryTool.handler(okQuery({ startTime: "5" }))) as { ok: boolean; error?: string };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid startTime/);
  });

  it("rejects an offset-less ISO date-time as endTime", async () => {
    // Reached only because startTime defaults to '1h' and passes first.
    const r = (await queryTool.handler(okQuery({ endTime: "2026-05-16T10:00:00" }))) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid endTime/);
  });

  it("rejects an endTime at or before startTime", async () => {
    // A separate literal from the identical rejection in metrics.ts, and only
    // the metrics copy was tested.
    const r = (await queryTool.handler(okQuery({ startTime: "now", endTime: "1h" }))) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /must be after startTime/);
  });
});
