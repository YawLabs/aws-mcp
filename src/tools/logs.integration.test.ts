/**
 * Subprocess integration for aws_logs_tail. Exercises the argv construction
 * and NDJSON parsing by routing runAwsCall at the fake aws binary via the
 * same test-injection knobs the other integration tests use.
 *
 * Two wiring styles live here, both pointed at the same fake binary. The
 * runAwsCall-direct suites pass command/prefixArgs/env per call, which is how
 * the argv-construction cases assert flags the handler has no knob for. The
 * handler-level suites instead rely on the AWS_MCP_TEST_AWS_COMMAND /
 * AWS_MCP_TEST_AWS_PREFIX_ARGS pair set in before(), so the handler's own
 * runAwsCall spawns the fake.
 */

import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runAwsCall } from "../aws-cli.js";
import { DEFAULT_MAX_EVENTS, logsTools, MAX_MAX_EVENTS, parseLogsJsonOutput } from "./logs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AWS = join(__dirname, "..", "testing", "fake-aws.js");

// Unique suffix for the per-test side-channel files below.
let counter = 0;

// Wire the tool handler at the fake aws binary for handler-level tests (the
// same knobs logs.test.ts uses so the handler's internal runAwsCall spawns it).
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

function fakeOpts(scenario: string) {
  return {
    command: process.execPath,
    prefixArgs: [FAKE_AWS],
    env: { ...process.env, AWS_MCP_FAKE_SCENARIO: scenario },
  };
}

describe("aws_logs_tail — argv construction (via runAwsCall + fake)", () => {
  it("places log group name as first positional after 'tail'", async () => {
    const r = await runAwsCall({
      service: "logs",
      operation: "tail",
      extraFlags: ["/aws/lambda/my-fn", "--format", "json", "--since", "15m"],
      ...fakeOpts("call_echo_args"),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const { argv } = r.data as { argv: string[] };
    const tailIdx = argv.indexOf("tail");
    assert.equal(argv[tailIdx + 1], "/aws/lambda/my-fn");
    const formatIdx = argv.indexOf("--format");
    assert.equal(argv[formatIdx + 1], "json");
    const sinceIdx = argv.indexOf("--since");
    assert.equal(argv[sinceIdx + 1], "15m");
  });

  it("passes --filter-pattern and --log-stream-names as separate argv entries", async () => {
    const r = await runAwsCall({
      service: "logs",
      operation: "tail",
      extraFlags: [
        "/aws/lambda/my-fn",
        "--format",
        "json",
        "--since",
        "10m",
        "--filter-pattern",
        "ERROR",
        "--log-stream-names",
        "stream-a",
        "stream-b",
      ],
      ...fakeOpts("call_echo_args"),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const { argv } = r.data as { argv: string[] };
    const fIdx = argv.indexOf("--filter-pattern");
    assert.equal(argv[fIdx + 1], "ERROR");
    const sIdx = argv.indexOf("--log-stream-names");
    assert.equal(argv[sIdx + 1], "stream-a");
    assert.equal(argv[sIdx + 2], "stream-b");
  });
});

describe("aws_logs_tail — NDJSON output end-to-end", () => {
  it("parses per-line JSON events into an array", async () => {
    const r = await runAwsCall({
      service: "logs",
      operation: "tail",
      extraFlags: ["/aws/lambda/my-fn", "--format", "json"],
      // Mirrors the real call in logs.ts. NDJSON opens with `{` and cannot
      // parse as one document, which is indistinguishable from a truncated
      // payload unless the caller says so -- hence the explicit flag.
      ndjson: true,
      ...fakeOpts("logs_tail_ndjson"),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    // runAwsCall returns the raw string since NDJSON isn't a valid JSON
    // document on its own. The handler then runs parseLogsJsonOutput on it.
    const events = parseLogsJsonOutput(r.data);
    assert.ok(Array.isArray(events));
    assert.equal(events.length, 3);
    assert.equal((events[0] as { message: string }).message, "hello");
    assert.equal((events[2] as { logStreamName: string }).logStreamName, "s2");
  });

  it("treats the same bytes as a truncated payload when ndjson is NOT declared", async () => {
    // The other half of the contract above. runAwsCall cannot tell complete
    // NDJSON from a truncated JSON document by inspection -- both open with
    // `{` and fail a whole-blob parse -- so an undeclared caller gets the
    // conservative answer. This is why the flag exists rather than the check
    // simply special-casing newlines.
    const r = await runAwsCall({
      service: "logs",
      operation: "tail",
      extraFlags: ["/aws/lambda/my-fn", "--format", "json"],
      ...fakeOpts("logs_tail_ndjson"),
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "malformed_json");
    assert.match(r.rawStdout ?? "", /hello/, "raw stdout is preserved for diagnosis");
  });

  it("returns an empty array when the window produced no events", async () => {
    const r = await runAwsCall({
      service: "logs",
      operation: "tail",
      extraFlags: ["/aws/lambda/my-fn", "--format", "json"],
      ...fakeOpts("logs_tail_empty"),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    // runAwsCall returns null when stdout is empty (no JSON to parse).
    const events = parseLogsJsonOutput(r.data ?? "");
    assert.ok(Array.isArray(events));
    assert.equal(events.length, 0);
  });
});

const handlerTool = logsTools.find((t) => t.name === "aws_logs_tail");
if (!handlerTool) throw new Error("logsTools missing aws_logs_tail");

describe("aws_logs_tail handler — malformed NDJSON fallback", () => {
  it("surfaces eventCount=null and the raw blob when a line fails to parse", async () => {
    // The fake-aws scenario logs_tail_ndjson_malformed emits three lines where
    // the middle line is not valid JSON (see the logs_tail_ndjson_malformed scenario in fake-aws.ts). The handler
    // runs parseLogsJsonOutput on the raw stdout, which gives up on the bad
    // line and returns the unparsed string. The handler then sets
    // eventCount=null (because events is a string, not an array) and surfaces
    // the raw blob under `events` for diagnosis.
    process.env.AWS_MCP_FAKE_SCENARIO = "logs_tail_ndjson_malformed";
    const r = await handlerTool.handler({ logGroupName: "/aws/lambda/my-fn" });
    assert.equal(r.ok, true);
    const data = r.data as { eventCount: number | null; events: unknown };
    assert.equal(data.eventCount, null, "eventCount must be null when NDJSON contains an unparseable line");
    assert.equal(typeof data.events, "string", "events must be the raw string fallback for diagnosis");
    assert.ok((data.events as string).includes("this-line-is-not-json"), "raw blob should contain the offending line");
  });

  it("reports totalEvents:null and truncated:false alongside eventCount:null", async () => {
    // The honest-null decision: on the raw-blob path nothing was counted, so
    // neither count is a number and nothing was dropped. Pinned so a later
    // refactor cannot quietly report totalEvents: 0 here.
    process.env.AWS_MCP_FAKE_SCENARIO = "logs_tail_ndjson_malformed";
    const r = await handlerTool.handler({ logGroupName: "/aws/lambda/my-fn" });
    assert.equal(r.ok, true);
    const data = r.data as { eventCount: number | null; totalEvents: number | null; truncated: boolean };
    assert.equal(data.eventCount, null);
    assert.equal(data.totalEvents, null);
    assert.equal(data.truncated, false);
  });
});

describe("aws_logs_tail handler — maxEvents cap", () => {
  // logs_tail_ndjson_bulk emits 1200 events oldest-first, each message tagged
  // with its index ("event-0" .. "event-1199"), which is the only thing that
  // makes last-N distinguishable from first-N.
  const msg = (e: unknown) => (e as { message: string }).message;

  it("defaults to the newest DEFAULT_MAX_EVENTS and reports the full total", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "logs_tail_ndjson_bulk";
    const r = await handlerTool.handler({ logGroupName: "/aws/lambda/my-fn" });
    assert.equal(r.ok, true);
    const data = r.data as { eventCount: number; totalEvents: number; truncated: boolean; events: unknown[] };
    assert.equal(data.eventCount, DEFAULT_MAX_EVENTS);
    assert.equal(data.totalEvents, 1200);
    assert.equal(data.truncated, true);
    assert.equal(data.events.length, DEFAULT_MAX_EVENTS);
    // Load-bearing: the NEWEST events survived, not the oldest.
    assert.equal(msg(data.events[0]), `event-${1200 - DEFAULT_MAX_EVENTS}`);
    assert.equal(msg(data.events[DEFAULT_MAX_EVENTS - 1]), "event-1199");
  });

  it("an explicit maxEvents keeps exactly that many, still oldest-first within the slice", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "logs_tail_ndjson_bulk";
    const r = await handlerTool.handler({ logGroupName: "/aws/lambda/my-fn", maxEvents: 10 });
    assert.equal(r.ok, true);
    const data = r.data as { eventCount: number; totalEvents: number; truncated: boolean; events: unknown[] };
    assert.equal(data.eventCount, 10);
    assert.equal(data.totalEvents, 1200);
    assert.equal(data.truncated, true);
    // Order WITHIN the slice is unchanged, so a caller reading the last element
    // as "most recent" behaves exactly as it did before the cap existed.
    for (let idx = 0; idx < 10; idx++) {
      assert.equal(msg(data.events[idx]), `event-${1190 + idx}`);
    }
  });

  it("leaves a window under the cap untouched and reports truncated:false", async () => {
    // The no-regression case for every existing caller whose windows are small:
    // identical apart from the two new fields.
    process.env.AWS_MCP_FAKE_SCENARIO = "logs_tail_ndjson";
    const r = await handlerTool.handler({ logGroupName: "/aws/lambda/my-fn" });
    assert.equal(r.ok, true);
    const data = r.data as { eventCount: number; totalEvents: number; truncated: boolean; events: unknown[] };
    assert.equal(data.eventCount, 3);
    assert.equal(data.totalEvents, 3);
    assert.equal(data.truncated, false);
    assert.equal(data.events.length, 3);
  });

  it("clamps an out-of-range maxEvents from a direct (non-schema) caller", async () => {
    // Handler calls bypass Zod, which is why the Math.min(Math.max(1, ...))
    // clamp exists. Both directions.
    process.env.AWS_MCP_FAKE_SCENARIO = "logs_tail_ndjson_bulk";
    const low = await handlerTool.handler({ logGroupName: "/aws/lambda/my-fn", maxEvents: 0 });
    assert.equal(low.ok, true);
    const lowData = low.data as { eventCount: number; events: unknown[] };
    assert.equal(lowData.eventCount, 1, "0 clamps up to 1");
    assert.equal(msg(lowData.events[0]), "event-1199", "and it is the newest event that survives");

    process.env.AWS_MCP_FAKE_SCENARIO = "logs_tail_ndjson_bulk";
    const high = await handlerTool.handler({ logGroupName: "/aws/lambda/my-fn", maxEvents: 999_999 });
    assert.equal(high.ok, true);
    const highData = high.data as { eventCount: number; truncated: boolean };
    assert.equal(highData.eventCount, 1200, `clamps down to ${MAX_MAX_EVENTS}, which exceeds the window`);
    assert.equal(highData.truncated, false);
  });
});

describe("aws_logs_tail handler — log-group ARN end to end", () => {
  it("puts the ARN-extracted BARE NAME on the CLI and echoes it back as logGroupName", async () => {
    // resolveLogGroupName is unit-tested, but nothing pinned what the handler
    // actually SPAWNS for an ARN input. `aws logs tail` takes a bare group name
    // as its first positional; handing it the ARN (or an ARN whose ':*' suffix
    // survived) is a ResourceNotFound at runtime, and the echoed logGroupName
    // would then disagree with the group that was really tailed.
    //
    // call_echo_args emits {"argv": [...]} as a single JSON line, so the
    // handler's own NDJSON path parses it into events[0].argv -- no side
    // channel needed.
    for (const arn of [
      "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/my-fn",
      "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/my-fn:*",
    ]) {
      process.env.AWS_MCP_FAKE_SCENARIO = "call_echo_args";
      const r = await handlerTool.handler({ logGroupName: arn, since: "5m" });
      assert.equal(r.ok, true, `expected ${arn} to be accepted`);
      const data = r.data as { logGroupName: string; since: string; events: unknown };
      assert.equal(data.logGroupName, "/aws/lambda/my-fn", "the response must echo the RESOLVED bare name");

      const events = data.events as Array<{ argv: string[] }>;
      assert.ok(Array.isArray(events) && events.length === 1, "call_echo_args emits exactly one JSON line");
      const argv = events[0].argv;
      const tailIdx = argv.indexOf("tail");
      assert.ok(tailIdx >= 0, "argv should contain the 'tail' operation");
      assert.equal(argv[tailIdx + 1], "/aws/lambda/my-fn", "the first positional after 'tail' is the bare name");
      assert.equal(argv.includes(arn), false, "the raw ARN must never reach the CLI");
      const sinceIdx = argv.indexOf("--since");
      assert.equal(argv[sinceIdx + 1], "5m");
    }
  });
});

// ---------------------------------------------------------------------------
// aws_logs_query
// ---------------------------------------------------------------------------

const queryTool = logsTools.find((t) => t.name === "aws_logs_query");
if (!queryTool) throw new Error("logsTools missing aws_logs_query");

describe("aws_logs_query — end to end against the fake CLI", () => {
  const baseInput = {
    logGroupNames: ["/aws/lambda/my-fn"],
    queryString: "fields @timestamp, @message | filter @message like /ERROR/",
  };

  it("returns flattened rows, statistics and truncated:false on the happy path", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "logs_query_complete";
    const r = await queryTool.handler({ ...baseInput, pollIntervalMs: 500 });
    assert.equal(r.ok, true, `expected ok, got: ${JSON.stringify(r)}`);
    const d = r.data as {
      queryId: string;
      status: string;
      rows: Array<Record<string, unknown>>;
      rowCount: number;
      fields: string[];
      statistics: Record<string, unknown>;
      truncated: boolean;
      polled: { attempts: number };
    };
    assert.equal(d.queryId, "q-complete-1");
    assert.equal(d.status, "Complete");
    assert.equal(d.rowCount, 2);
    // Rows are FLATTENED from the API's [{field,value}] pairs into plain objects.
    assert.equal(d.rows[0]["@message"], "ERROR boom");
    assert.equal(d.rows[1]["@message"], "ERROR again");
    assert.deepEqual(d.fields, ["@timestamp", "@message", "@ptr"]);
    assert.equal(d.statistics.recordsMatched, 2);
    assert.equal(d.statistics.bytesScanned, 4096);
    assert.equal(d.truncated, false);
    assert.equal(d.polled.attempts, 1, "Complete on the first poll");
  });

  it("polls through Scheduled and Running without leaking the partial results", async () => {
    // The in-flight responses carry PARTIAL rows. Returning early with those
    // would look like a successful small result set rather than an unfinished
    // query, so the loop must ignore them until the status leaves the in-flight
    // set.
    const countFile = join(tmpdir(), `aws-mcp-qcount-${process.pid}-${counter++}`);
    process.env.AWS_MCP_FAKE_QUERY_COUNT_OUT = countFile;
    process.env.AWS_MCP_FAKE_SCENARIO = "logs_query_running_then_complete";
    try {
      const r = await queryTool.handler({ ...baseInput, pollIntervalMs: 500 });
      assert.equal(r.ok, true, `expected ok, got: ${JSON.stringify(r)}`);
      const d = r.data as { rows: Array<Record<string, unknown>>; polled: { attempts: number } };
      assert.equal(d.polled.attempts, 3, "Scheduled -> Running -> Complete");
      const messages = d.rows.map((row) => row["@message"]);
      assert.equal(
        messages.some((m) => typeof m === "string" && m.includes("partial")),
        false,
        `a partial-result row leaked into the final answer: ${JSON.stringify(messages)}`,
      );
    } finally {
      delete process.env.AWS_MCP_FAKE_QUERY_COUNT_OUT;
      rmSync(countFile, { force: true });
    }
  });

  it("reports a terminal Failed status as ok:false, never as an empty success", async () => {
    // An empty rows array from a failed query is indistinguishable from "the
    // query ran and matched nothing" unless the status is honoured.
    process.env.AWS_MCP_FAKE_SCENARIO = "logs_query_failed";
    const r = await queryTool.handler({ ...baseInput, pollIntervalMs: 500 });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /q-failed-1/, "the queryId must ride in the message: ok:false has no data channel");
  });

  it("surfaces a start-query failure directly and never polls", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "logs_query_start_malformed";
    const r = await queryTool.handler({ ...baseInput, pollIntervalMs: 500 });
    assert.equal(r.ok, false);
    assert.match(`${r.error ?? ""}${r.rawBody ?? ""}`, /MalformedQueryException/);
    // The scenario has no get-query-results branch; its fall-through exits 2
    // with a distinctive string, so its absence proves no poll was attempted.
    assert.equal(`${r.error ?? ""}${r.rawBody ?? ""}`.includes("unexpected argv"), false);
  });

  it("sends camelCase --cli-input-json with epoch-SECONDS times, and resolves an ARN to a bare name", async () => {
    // The two facts most easily got wrong. CloudWatch Logs models its API in
    // camelCase (unlike the PascalCase metrics.ts sends to GetMetricData), and
    // StartQuery takes epoch SECONDS while FilterLogEvents -- and therefore
    // `aws logs tail` -- uses milliseconds.
    const argvFile = join(tmpdir(), `aws-mcp-qargv-${process.pid}-${counter++}`);
    process.env.AWS_MCP_FAKE_ARGV_OUT = argvFile;
    process.env.AWS_MCP_FAKE_SCENARIO = "logs_query_echo_args";
    try {
      const r = await queryTool.handler({
        logGroupNames: ["arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/my-fn:*"],
        queryString: "fields @timestamp",
        startTime: "1h",
        pollIntervalMs: 500,
      });
      assert.equal(r.ok, true, `expected ok, got: ${JSON.stringify(r)}`);

      const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
      const jsonIdx = argv.indexOf("--cli-input-json");
      assert.ok(jsonIdx >= 0, `--cli-input-json missing from argv: ${argv.join(" ")}`);
      const payload = JSON.parse(argv[jsonIdx + 1]) as Record<string, unknown>;

      // camelCase, not PascalCase -- the wrong casing is a botocore
      // ParamValidationError before the request is ever signed.
      assert.ok("logGroupNames" in payload, `expected camelCase logGroupNames, got ${Object.keys(payload).join(",")}`);
      assert.equal("LogGroupNames" in payload, false);
      assert.ok("queryString" in payload);
      assert.equal("StartTime" in payload, false);

      // The ARN resolved to its bare name; neither the ARN nor its ':*' survives.
      assert.deepEqual(payload.logGroupNames, ["/aws/lambda/my-fn"]);

      // Epoch SECONDS (~1.7-1.8e9), not milliseconds (~1.7e12).
      for (const key of ["startTime", "endTime"]) {
        const v = payload[key] as number;
        assert.equal(Number.isInteger(v), true, `${key} must be an integer`);
        assert.ok(v > 1_500_000_000 && v < 5_000_000_000, `${key}=${v} is not epoch seconds`);
      }
      // And the window really is the requested hour.
      assert.equal(Math.round(((payload.endTime as number) - (payload.startTime as number)) / 60), 60);
    } finally {
      delete process.env.AWS_MCP_FAKE_ARGV_OUT;
      rmSync(argvFile, { force: true });
    }
  });
});
