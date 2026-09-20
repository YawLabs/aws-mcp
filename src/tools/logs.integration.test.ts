/**
 * Subprocess integration for aws_logs_tail: the handler driven end to end against
 * the fake CLI, one `logs-tail_*` scenario per CLI era.
 *
 * The scenarios answer like the real `aws logs filter-log-events` -- verbatim
 * captures, or an emulator whose every rule was measured against a real CLI
 * (src/testing/logs-tail-fake.ts) -- so these cases pin the handler's own
 * behavior: which read mode it chose, how many CLI calls that cost, what the
 * payload carried, and which end of a busy window came back. The argv side
 * channel (AWS_MCP_FAKE_LOGS_TAIL_ARGV_LOG) is how the call count and the payload
 * are read, because `command` redacts the payload.
 *
 * Handler-level wiring only: AWS_MCP_TEST_AWS_COMMAND / AWS_MCP_TEST_AWS_PREFIX_ARGS
 * are set in before(), so the handler's own runAwsCall spawns the fake. The
 * runAwsCall-direct argv tests this file used to carry pinned `aws logs tail`'s
 * positional argv, which no longer exists; logs.realcli.test.ts drives the real
 * CLI instead.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { REAL_CLI_CAPTURES } from "../testing/logs-tail-fake.js";
import {
  _resetLogsTailCliModelCache,
  DEFAULT_MAX_EVENTS,
  LOG_GROUP_IDENTIFIER_MIN_CLI,
  logsTools,
  MAX_MAX_EVENTS,
} from "./logs.js";

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

const handlerTool = logsTools.find((t) => t.name === "aws_logs_tail");
if (!handlerTool) throw new Error("logsTools missing aws_logs_tail");

/** One line per CLI invocation the fake saw, in order. */
interface FakeInvocation {
  argv: string[];
  params: Record<string, unknown> | null;
}

describe("aws_logs_tail handler — FilterLogEvents against the fake CLI", () => {
  // Every case here passes an explicit region so a developer shell carrying
  // AWS_REGION cannot change what an ARN case asserts.
  const REGION = "us-east-1";
  const ARN = `arn:aws:logs:${REGION}:123456789012:log-group:/aws/lambda/my-fn`;
  let argvLogDir: string;
  let argvLog: string;

  const msg = (e: unknown) => (e as { message: string }).message;

  /** The fake's per-invocation log for the call that just ran. */
  const invocations = (): FakeInvocation[] => {
    let raw: string;
    try {
      raw = readFileSync(argvLog, "utf8");
    } catch {
      return [];
    }
    return raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as FakeInvocation);
  };

  const tail = async (scenario: string, input: Record<string, unknown> = {}) => {
    process.env.AWS_MCP_FAKE_SCENARIO = scenario;
    return await handlerTool.handler({ logGroupName: "/aws/lambda/my-fn", region: REGION, ...input });
  };

  before(() => {
    argvLogDir = mkdtempSync(join(tmpdir(), "logs-tail-argv-"));
  });
  after(() => {
    delete process.env.AWS_MCP_FAKE_LOGS_TAIL_ARGV_LOG;
    rmSync(argvLogDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // A fresh log per test, and a fresh capability cache: the "this CLI has no
    // startFromHead" flag lives for the process, and a test that inherited it from
    // the previous one would assert against the wrong read mode.
    counter += 1;
    argvLog = join(argvLogDir, `argv-${counter}.jsonl`);
    process.env.AWS_MCP_FAKE_LOGS_TAIL_ARGV_LOG = argvLog;
    _resetLogsTailCliModelCache();
  });

  // --- a CLI that has startFromHead (AWS CLI 2.35.8+) ---------------------------

  it("reads newest-first in ONE call and returns structured events", async () => {
    const r = await tail("logs-tail_current_basic");
    assert.equal(r.ok, true, `handler failed: ${r.error ?? ""}`);
    const data = r.data as {
      logGroupName: string;
      logGroupIdentifier: string | null;
      eventCount: number;
      totalEvents: number | null;
      truncated: boolean;
      events: Array<{ timestamp: string | null; logStreamName: string | null; message: string | null }>;
    };
    assert.equal(data.eventCount, 6);
    assert.equal(data.totalEvents, 6);
    assert.equal(data.truncated, false);
    assert.equal(data.logGroupName, "/aws/lambda/my-fn");
    assert.equal(data.logGroupIdentifier, null, "a bare-name call sends no identifier");
    // Structured events, oldest first -- the thing this tool never returned against
    // a real CLI before 2.4.0.
    assert.equal(data.events.length, 6);
    assert.equal(data.events[0].timestamp, "2026-09-19T10:00:00.000Z");
    assert.equal(data.events[0].message, "START RequestId: 11-22 Version: $LATEST\n");
    assert.equal(data.events[3].logStreamName, "my stream/2026");

    const calls = invocations();
    assert.equal(calls.length, 1, "a current CLI pays for no rejected call");
    const argv = calls[0].argv;
    assert.ok(argv.includes("filter-log-events"), "the operation is filter-log-events, not tail");
    assert.equal(argv[argv.indexOf("--page-size") + 1], String(DEFAULT_MAX_EVENTS + 1));
    assert.equal(argv[argv.indexOf("--max-items") + 1], String(DEFAULT_MAX_EVENTS + 1), "one sentinel event");
    assert.match(
      argv[argv.indexOf("--query") + 1],
      /^\{total: length\(events \|\| `\[\]`\), events: \(events \|\| `\[\]`\)\[\]\./,
    );
    assert.deepEqual(calls[0].params, {
      logGroupName: "/aws/lambda/my-fn",
      startTime: (calls[0].params as { startTime: number }).startTime,
      startFromHead: false,
    });
  });

  it("keeps the NEWEST maxEvents of a busy window and reports totalEvents:null", async () => {
    const r = await tail("logs-tail_current_bulk");
    assert.equal(r.ok, true);
    const data = r.data as { eventCount: number; totalEvents: number | null; truncated: boolean; events: unknown[] };
    assert.equal(data.eventCount, DEFAULT_MAX_EVENTS);
    assert.equal(data.truncated, true);
    assert.equal(data.totalEvents, null, "the read stopped early, so the window's size is unknown");
    assert.equal(msg(data.events[0]), `event-${1200 - DEFAULT_MAX_EVENTS}`);
    assert.equal(msg(data.events[DEFAULT_MAX_EVENTS - 1]), "event-1199", "oldest-first within the slice");
  });

  it("honors an explicit maxEvents", async () => {
    const r = await tail("logs-tail_current_bulk", { maxEvents: 10 });
    assert.equal(r.ok, true);
    const data = r.data as { eventCount: number; events: unknown[] };
    assert.equal(data.eventCount, 10);
    for (let idx = 0; idx < 10; idx++) assert.equal(msg(data.events[idx]), `event-${1190 + idx}`);
    assert.equal(invocations()[0].argv[invocations()[0].argv.indexOf("--max-items") + 1], "11");
  });

  it("treats exactly maxEvents as a complete window and flips one below it", async () => {
    // An off-by-one to `>=` would report truncated on a window that came back whole
    // -- and tell the caller to narrow a `since` that needed no narrowing.
    const exact = await tail("logs-tail_current_bulk", { maxEvents: 1200 });
    assert.equal(exact.ok, true);
    const exactData = exact.data as {
      eventCount: number;
      totalEvents: number | null;
      truncated: boolean;
      events: unknown[];
    };
    assert.equal(exactData.eventCount, 1200);
    assert.equal(exactData.totalEvents, 1200, "nothing was left unread");
    assert.equal(exactData.truncated, false);
    assert.equal(msg(exactData.events[0]), "event-0");

    const one = await tail("logs-tail_current_bulk", { maxEvents: 1199 });
    assert.equal(one.ok, true);
    const oneData = one.data as {
      eventCount: number;
      totalEvents: number | null;
      truncated: boolean;
      events: unknown[];
    };
    assert.equal(oneData.eventCount, 1199);
    assert.equal(oneData.truncated, true);
    assert.equal(oneData.totalEvents, null);
    assert.equal(msg(oneData.events[0]), "event-1", "the single OLDEST event is the one dropped");
  });

  it("clamps an out-of-range maxEvents from a direct (non-schema) caller", async () => {
    const low = await tail("logs-tail_current_bulk", { maxEvents: 0 });
    assert.equal(low.ok, true);
    const lowData = low.data as { eventCount: number; events: unknown[] };
    assert.equal(lowData.eventCount, 1, "0 clamps up to 1");
    assert.equal(msg(lowData.events[0]), "event-1199", "and it is the newest event that survives");

    const high = await tail("logs-tail_current_bulk", { maxEvents: 999_999 });
    assert.equal(high.ok, true);
    const highData = high.data as { eventCount: number; truncated: boolean };
    assert.equal(highData.eventCount, 1200, `clamps down to ${MAX_MAX_EVENTS}, which exceeds the window`);
    assert.equal(highData.truncated, false);
    // --page-size is capped at FilterLogEvents' own EventsLimit maximum, so the
    // clamped 10,000 asks for 10,000 and not 10,001.
    const argv = invocations().at(-1)?.argv ?? [];
    assert.equal(argv[argv.indexOf("--page-size") + 1], String(MAX_MAX_EVENTS));
    assert.equal(argv[argv.indexOf("--max-items") + 1], String(MAX_MAX_EVENTS + 1));
  });

  it("never sends an empty logStreamNames or logStreamNamePrefix", async () => {
    // botocore refuses both before any request, so sending them would break calls
    // that work today. The emulator exits 2 if either reaches the payload.
    for (const input of [{ logStreamNames: [] }, { logStreamNamePrefix: "" }]) {
      const r = await tail("logs-tail_current_empty", input);
      assert.equal(r.ok, true, `${JSON.stringify(input)} must still be a valid call: ${r.error ?? ""}`);
      const params = invocations().at(-1)?.params ?? {};
      assert.equal("logStreamNames" in params, false);
      assert.equal("logStreamNamePrefix" in params, false);
    }
  });

  it("keeps every caller value inside --cli-input-json, out of argv", async () => {
    // The F15 closure for this tool: the CLI expands an argv value starting with
    // `file://` into that file's contents, and a read-only tool must never do that.
    // Inside the payload the same string is sent literally.
    const filterPattern = "file://~/.aws/credentials";
    const r = await tail("logs-tail_current_empty", { filterPattern, logStreamNamePrefix: "2026/09/" });
    assert.equal(r.ok, true, `handler failed: ${r.error ?? ""}`);
    const call = invocations().at(-1);
    assert.ok(call);
    assert.equal(call.argv.includes(filterPattern), false, "the pattern is not its own argv entry");
    assert.equal(call.argv.includes("2026/09/"), false);
    assert.equal(call.argv.includes("--filter-pattern"), false, "nor is the flag it used to ride on");
    assert.equal(call.params?.filterPattern, filterPattern, "it travels in the payload, literally");
    assert.equal(call.params?.logStreamNamePrefix, "2026/09/");
  });

  it("sends an ARN as logGroupIdentifier without the ':*' and echoes it back", async () => {
    for (const input of [ARN, `${ARN}:*`]) {
      const r = await tail("logs-tail_echo_argv", { logGroupName: input });
      assert.equal(r.ok, true, `expected ${input} to be accepted: ${r.error ?? ""}`);
      const data = r.data as { logGroupName: string; logGroupIdentifier: string | null };
      assert.equal(data.logGroupName, "/aws/lambda/my-fn", "the envelope still echoes the bare name");
      assert.equal(data.logGroupIdentifier, ARN, "and the identifier that was actually sent");
      const call = invocations().at(-1);
      assert.ok(call);
      assert.equal(call.params?.logGroupIdentifier, ARN);
      assert.equal("logGroupName" in (call.params ?? {}), false, "exactly one of the two is sent");
      assert.equal(call.argv.includes(input), false, "the raw ARN is never an argv entry");
    }
  });

  it("sends a bare name as logGroupName with no identifier", async () => {
    const r = await tail("logs-tail_echo_argv");
    assert.equal(r.ok, true);
    assert.equal((r.data as { logGroupIdentifier: string | null }).logGroupIdentifier, null);
    const params = invocations().at(-1)?.params ?? {};
    assert.equal(params.logGroupName, "/aws/lambda/my-fn");
    assert.equal("logGroupIdentifier" in params, false);
  });

  // --- a CLI that rejects startFromHead (before 2.35.8) ------------------------

  it("falls back to a whole-window read and pins the rejection for the process", async () => {
    const first = await tail("logs-tail_legacy_bulk");
    assert.equal(first.ok, true, `handler failed: ${first.error ?? ""}`);
    const data = first.data as {
      eventCount: number;
      totalEvents: number | null;
      truncated: boolean;
      events: unknown[];
    };
    assert.equal(data.eventCount, DEFAULT_MAX_EVENTS);
    assert.equal(data.truncated, true);
    assert.equal(data.totalEvents, 1200, "the whole window was read, so the count is exact");
    assert.equal(msg(data.events[0]), `event-${1200 - DEFAULT_MAX_EVENTS}`);
    assert.equal(msg(data.events[DEFAULT_MAX_EVENTS - 1]), "event-1199");

    const calls = invocations();
    assert.equal(calls.length, 2, "one rejected newest-first attempt, then the whole window");
    assert.equal(calls[0].params?.startFromHead, false);
    assert.equal("startFromHead" in (calls[1].params ?? {}), false);
    assert.equal(calls[1].argv.includes("--max-items"), false, "the whole-window read pages to the end");
    assert.equal(calls[1].argv.includes("--page-size"), false);
    assert.match(calls[1].argv[calls[1].argv.indexOf("--query") + 1], /\(events \|\| `\[\]`\)\[-500:\]/);

    // The negative answer is cached, so a second call costs one invocation.
    const second = await tail("logs-tail_legacy_bulk");
    assert.equal(second.ok, true);
    assert.equal(invocations().length, 3, "the second handler call made ONE invocation");
    assert.equal("startFromHead" in (invocations()[2].params ?? {}), false);

    // ...and the cache is per process, so a reset brings the detection back.
    _resetLogsTailCliModelCache();
    const third = await tail("logs-tail_legacy_bulk");
    assert.equal(third.ok, true);
    assert.equal(invocations().length, 5, "after a reset it detects again: two invocations");
  });

  it("gets the boundaries right on the whole-window path too", async () => {
    const exact = await tail("logs-tail_legacy_bulk", { maxEvents: 1200 });
    assert.equal(exact.ok, true);
    const exactData = exact.data as { totalEvents: number | null; truncated: boolean };
    assert.equal(exactData.totalEvents, 1200);
    assert.equal(exactData.truncated, false);

    _resetLogsTailCliModelCache();
    const one = await tail("logs-tail_legacy_bulk", { maxEvents: 1199 });
    assert.equal(one.ok, true);
    const oneData = one.data as { eventCount: number; totalEvents: number | null; truncated: boolean };
    assert.equal(oneData.eventCount, 1199);
    assert.equal(oneData.totalEvents, 1200, "exact even when truncated, on this path");
    assert.equal(oneData.truncated, true);
  });

  it("parses the bytes the real CLI printed for a whole-window read", async () => {
    // logs-tail_legacy_basic answers with a verbatim 2.34.3 capture rather than the
    // emulator, and refuses any call but the one it was captured from.
    const r = await tail("logs-tail_legacy_basic");
    assert.equal(r.ok, true, `handler failed: ${r.error ?? ""}`);
    const data = r.data as {
      eventCount: number;
      totalEvents: number | null;
      events: Array<{ message: string | null }>;
    };
    assert.equal(data.eventCount, 6);
    assert.equal(data.totalEvents, 6);
    assert.equal(data.events[0].message, "START RequestId: 11-22 Version: $LATEST\n");
    assert.equal(data.events[1].message, '{"level":"error","msg":"boom","ctx":{"id":7}}');
  });

  it("falls back when the rejection arrives in the CLI's JSON error format", async () => {
    // AWS_CLI_ERROR_FORMAT=enhanced is pinned in every child environment, so this
    // is the CLI that ignores the pin. The detector reads the parameter name
    // through the escaped quotes.
    const r = await tail("logs-tail_jsonfmt_bulk");
    assert.equal(r.ok, true, `handler failed: ${r.error ?? ""}`);
    assert.equal((r.data as { totalEvents: number | null }).totalEvents, 1200);
    assert.equal(invocations().length, 2);
  });

  it("refuses ARN input on a CLI that cannot address a group by ARN", async () => {
    const r = await tail("logs-tail_ancient_basic", { logGroupName: ARN });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", new RegExp(`AWS CLI ${LOG_GROUP_IDENTIFIER_MIN_CLI.replaceAll(".", "\\.")}\\+`));
    assert.match(r.error ?? "", /Pass the bare name '\/aws\/lambda\/my-fn'/);
    assert.match(r.error ?? "", /123456789012/, "the ARN's account, which the bare name would NOT read");
    assert.equal(r.errorKind, "nonzero_exit");
    assert.equal(r.suggestion, undefined, "parseAwsError's 'fix the parameter shape' is wrong advice here");
    assert.equal(invocations().length, 1, "no point retrying: nothing was sent and nothing else can be");
  });

  it("still serves a bare name on that same CLI, after one rejected attempt", async () => {
    const r = await tail("logs-tail_ancient_basic");
    assert.equal(r.ok, true, `handler failed: ${r.error ?? ""}`);
    assert.equal((r.data as { eventCount: number }).eventCount, 6);
    assert.equal(invocations().length, 2);
  });

  // --- an endpoint that IGNORES startFromHead (moto, LocalStack) ---------------

  it("re-reads the whole window when the endpoint ignored startFromHead", async () => {
    // Without the orientation check this returned the OLDEST events labelled as the
    // newest, with truncated:true -- a silently wrong answer.
    const r = await tail("logs-tail_ignored_bulk");
    assert.equal(r.ok, true, `handler failed: ${r.error ?? ""}`);
    const data = r.data as { eventCount: number; totalEvents: number | null; truncated: boolean; events: unknown[] };
    assert.equal(data.eventCount, DEFAULT_MAX_EVENTS);
    assert.equal(data.truncated, true);
    assert.equal(data.totalEvents, 1200);
    assert.equal(msg(data.events[0]), `event-${1200 - DEFAULT_MAX_EVENTS}`, "the NEWEST end of the window");
    assert.equal(msg(data.events[DEFAULT_MAX_EVENTS - 1]), "event-1199");

    const calls = invocations();
    assert.equal(calls.length, 2, "the newest-first read, then the whole window");
    assert.equal(calls[0].params?.startFromHead, false);
    assert.equal("startFromHead" in (calls[1].params ?? {}), false);

    // NOT cached: the CLI supports the member, this endpoint does not, and
    // endpoints differ by region and profile.
    const second = await tail("logs-tail_ignored_bulk");
    assert.equal(second.ok, true);
    assert.equal(invocations().length, 4, "the second handler call tries newest-first again");
  });

  // --- the parser's strictness -------------------------------------------------

  it("refuses the text 'aws logs tail --format json' prints instead of guessing", async () => {
    // The regression pin for the defect 2.4.0 fixes: this text used to come back as
    // ok:true with the whole blob as `events`, eventCount and totalEvents null, and
    // maxEvents silently unapplied.
    const r = await tail("logs-tail_real_tail_text");
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /exited 0 but printed something other than the \{total, events\} document/);
    assert.match(r.error ?? "", /Refusing to guess/);
    assert.equal(r.errorKind, undefined, "the CLI exited 0, so nothing classified this");
    assert.match(r.rawBody ?? "", /fake-stream a message that LOOKS like a tail header/);
    assert.ok(
      REAL_CLI_CAPTURES.tailFormatJsonStdout.startsWith("2026-09-19T10:00:00+00:00 "),
      "precondition: the scenario serves the real formatter's text",
    );
  });

  it("does not mistake an ordinary API failure for a model gap", async () => {
    // The fallback exists for one thing: a CLI whose model does not know
    // startFromHead, which says so in its ParamValidation text. An AccessDenied is
    // a real answer from the service, so it is reported at once -- a whole-window
    // retry would cost another CLI start and fail the same way.
    const r = await tail("logs-tail_api_error");
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, "nonzero_exit");
    assert.match(r.rawBody ?? "", /AccessDeniedException/);
    assert.equal(invocations().length, 1, "ONE CLI call, no fallback");
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
    // The README's errorKind contract names aws_logs_query explicitly, so both
    // of its CLI-failure arms have to carry the classification. This one shipped
    // without it once already: the arm returned error + rawBody and dropped the
    // kind runAwsCall had already computed.
    assert.equal(r.errorKind, "nonzero_exit");
  });

  it("forwards the classified errorKind from a start-query auth failure", async () => {
    // call_sso_expired is argv-independent -- stderr + exit 255 whatever the
    // command -- so it reaches the start-query arm unchanged.
    process.env.AWS_MCP_FAKE_SCENARIO = "call_sso_expired";
    const r = await queryTool.handler({ ...baseInput, profile: "my-profile", pollIntervalMs: 500 });
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, "sso_expired", "a caller must be able to tell re-auth from a bad query");
    assert.match(r.error ?? "", /SSO session expired/);
  });

  it("forwards the classified errorKind when credentials lapse mid-poll", async () => {
    // The poll arm rewrites `error` wholesale to lead with the recovery hint, so
    // errorKind is the only classification the caller has left.
    process.env.AWS_MCP_FAKE_SCENARIO = "logs_query_poll_sso_expired";
    const r = await queryTool.handler({ ...baseInput, profile: "my-profile", pollIntervalMs: 500 });
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, "sso_expired");
    // The queryId still has to reach the caller: the query is unaffected by a
    // poll-side credential failure and its results stay retrievable.
    assert.match(r.error ?? "", /q-poll-expired-1/);
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

  it("brackets the truncated >= boundary: landing exactly ON the limit counts as truncated", async () => {
    // The tool's own description tells callers to check `truncated` to decide
    // whether more matched than came back, so a `>=` -> `>` regression makes a
    // clipped result set report truncated:false and the agent draws a
    // conclusion from a silently partial answer. logs_query_complete branches
    // on argv and always returns its 2 rows regardless of the
    // --cli-input-json payload, so `limit` is free to vary.
    process.env.AWS_MCP_FAKE_SCENARIO = "logs_query_complete";
    const atLimit = await queryTool.handler({ ...baseInput, limit: 2, pollIntervalMs: 500 });
    assert.equal(atLimit.ok, true, `expected ok, got: ${JSON.stringify(atLimit)}`);
    const atLimitData = atLimit.data as { rowCount: number; truncated: boolean };
    assert.equal(atLimitData.rowCount, 2);
    assert.equal(atLimitData.truncated, true, "rows.length === limit is truncated");

    const underLimit = await queryTool.handler({ ...baseInput, limit: 3, pollIntervalMs: 500 });
    assert.equal(underLimit.ok, true);
    const underLimitData = underLimit.data as { rowCount: number; truncated: boolean };
    assert.equal(underLimitData.rowCount, 2);
    assert.equal(underLimitData.truncated, false, "one under the limit is not");
  });

  it("fills the documented statistics keys with null and lets newer members ride through", async () => {
    // The contract is "the documented keys are always present": an agent
    // reading statistics.recordsMatched to decide whether `truncated` mattered
    // would get undefined instead of null if the defaults-fill regressed, and a
    // hand-written reshape (what the spread deliberately replaced) would drop
    // members AWS adds later.
    //
    // logs_query_echo_args answers the poll with statistics:{} and no
    // queryLanguage -- the older-model shape.
    process.env.AWS_MCP_FAKE_SCENARIO = "logs_query_echo_args";
    const sparse = await queryTool.handler({ ...baseInput, pollIntervalMs: 500 });
    assert.equal(sparse.ok, true, `expected ok, got: ${JSON.stringify(sparse)}`);
    const sparseData = sparse.data as { statistics: Record<string, unknown>; queryLanguage: unknown };
    assert.deepEqual(sparseData.statistics, { recordsMatched: null, recordsScanned: null, bytesScanned: null });
    assert.equal(sparseData.queryLanguage, null, "null, never undefined, when the response omits the member");

    // logs_query_complete carries all three PLUS logGroupsScanned, which the
    // reshape does not name.
    process.env.AWS_MCP_FAKE_SCENARIO = "logs_query_complete";
    const full = await queryTool.handler({ ...baseInput, pollIntervalMs: 500 });
    assert.equal(full.ok, true);
    const fullData = full.data as {
      statistics: Record<string, unknown>;
      queryLanguage: unknown;
      startTime: string;
      endTime: string;
    };
    assert.equal(fullData.statistics.logGroupsScanned, 1, "a member the reshape does not name must survive");
    assert.equal(fullData.queryLanguage, "CWLI");
    assert.match(fullData.startTime, /^\d{4}-\d{2}-\d{2}T.*Z$/);
    assert.match(fullData.endTime, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it("copies queryLanguage onto the wire verbatim, and omits the key when unset", async () => {
    // Only the Zod enum was tested -- that CWLI/PPL parse and SQL does not.
    // A dropped assignment means every PPL query silently runs as CWLI and
    // fails with a parse error the caller cannot explain from this tool's own
    // output.
    const argvFile = join(tmpdir(), `aws-mcp-qlang-${process.pid}-${counter++}`);
    const payloadFrom = (): Record<string, unknown> => {
      const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
      const jsonIdx = argv.indexOf("--cli-input-json");
      assert.ok(jsonIdx >= 0, `--cli-input-json missing from argv: ${argv.join(" ")}`);
      return JSON.parse(argv[jsonIdx + 1]) as Record<string, unknown>;
    };
    process.env.AWS_MCP_FAKE_ARGV_OUT = argvFile;
    process.env.AWS_MCP_FAKE_SCENARIO = "logs_query_echo_args";
    try {
      const withLang = await queryTool.handler({ ...baseInput, queryLanguage: "PPL", pollIntervalMs: 500 });
      assert.equal(withLang.ok, true, `expected ok, got: ${JSON.stringify(withLang)}`);
      assert.equal(payloadFrom().queryLanguage, "PPL");

      const withoutLang = await queryTool.handler({ ...baseInput, pollIntervalMs: 500 });
      assert.equal(withoutLang.ok, true);
      // ABSENT, not null: an emitted-but-null key is a botocore
      // ParamValidationError before the request is ever signed, and the CLI /
      // service can only apply its own default when the key is missing.
      assert.equal("queryLanguage" in payloadFrom(), false);
    } finally {
      delete process.env.AWS_MCP_FAKE_ARGV_OUT;
      rmSync(argvFile, { force: true });
    }
  });

  it("rebuilds a NON-auth poll failure around the queryId and re-appends the suggestion", async () => {
    // The v2.2.1 fix, which shipped on manual verification alone: `underlying`
    // deliberately prefers the RAW stderr over runAwsCall's already-suffixed
    // message, so a recognized error code's remedy has to be added back or it
    // is lost from BOTH the message and the envelope -- contradicting README's
    // Stability promise that `suggestion` is duplicated in `error`.
    process.env.AWS_MCP_FAKE_SCENARIO = "lq2_poll_access_denied";
    const r = await queryTool.handler({ ...baseInput, pollIntervalMs: 500 });
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, "nonzero_exit");
    assert.equal(r.suggestion, "Check IAM permissions for this operation.");
    // The queryId is the whole reason this arm rebuilds the message: the query
    // is unaffected by a poll-side failure and its results stay collectible.
    assert.match(r.error ?? "", /q-poll-denied-1/);
    // The non-auth prefix. logs_query_poll_sso_expired takes the isAuthKind
    // branch instead, so nothing else exercises this string.
    assert.ok((r.error ?? "").startsWith("Polling the query failed."), `got: ${r.error}`);
    assert.ok(
      (r.error ?? "").endsWith("\n\nSuggestion: Check IAM permissions for this operation."),
      `error must end with the suggestion sentence, got: ${r.error}`,
    );
    assert.match(r.rawBody ?? "", /AccessDenied/);
  });

  it("gives each terminal status its own diagnostic, with the resume hint only where it belongs", async () => {
    // Only "Failed" was covered end to end. The poll loop's CLASSIFICATION of
    // these statuses as terminal is tested in logs.test.ts, but that test stops
    // at the loop's return value -- nothing exercised the message the caller
    // actually reads, which is the entire diagnostic for a query that produced
    // no rows.
    process.env.AWS_MCP_FAKE_SCENARIO = "lq2_terminal_status";
    const cases: Array<{ status: string | undefined; match: RegExp; resumeHint: boolean }> = [
      { status: "Failed", match: /failed server-side/, resumeHint: false },
      { status: "Timeout", match: /60-minute/, resumeHint: false },
      { status: "Cancelled", match: /stopped elsewhere/, resumeHint: false },
      { status: "Unknown", match: /no transition out of it/, resumeHint: false },
      { status: undefined, match: /no 'status' field/, resumeHint: true },
      { status: "Frobnicated", match: /unrecognized terminal status/, resumeHint: true },
    ];
    try {
      for (const c of cases) {
        if (c.status === undefined) delete process.env.AWS_MCP_FAKE_QUERY_STATUS;
        else process.env.AWS_MCP_FAKE_QUERY_STATUS = c.status;
        const label = c.status ?? "(no status member)";
        const r = await queryTool.handler({ ...baseInput, pollIntervalMs: 500 });
        assert.equal(r.ok, false, label);
        assert.match(r.error ?? "", c.match, label);
        // The common `where` suffix rides on every arm.
        assert.match(r.error ?? "", /q-term-1/, label);
        assert.match(r.error ?? "", /1 poll\(s\)/, label);
        // Only the null and default arms append queryResumeHint -- for two of
        // these messages it is the only place a caller learns the queryId is
        // still collectible, and for the other four its ABSENCE is a deliberate
        // design choice that a switch fallthrough would violate.
        assert.equal((r.error ?? "").includes("7 days"), c.resumeHint, label);
      }
    } finally {
      delete process.env.AWS_MCP_FAKE_QUERY_STATUS;
    }
  });

  it("bails without polling when start-query returns no usable queryId", async () => {
    // Exists to stop the loop handing `--query-id undefined` to the CLI once
    // per attempt for the whole wait budget. Reachable from a CLI model that
    // drops the output member, an --output misconfiguration, or a proxy that
    // reshapes the response. isValidQueryId is unit-tested in isolation, but
    // nothing connected it to this call site.
    process.env.AWS_MCP_FAKE_SCENARIO = "lq2_start_bad_query_id";
    const cases: Array<{ shape: string | undefined; typeName: string }> = [
      { shape: undefined, typeName: "undefined" },
      { shape: "number", typeName: "number" },
      { shape: "hyphen", typeName: "string" },
    ];
    try {
      for (const c of cases) {
        if (c.shape === undefined) delete process.env.AWS_MCP_FAKE_QUERY_ID_SHAPE;
        else process.env.AWS_MCP_FAKE_QUERY_ID_SHAPE = c.shape;
        const label = c.shape ?? "missing member";
        const r = await queryTool.handler({ ...baseInput, pollIntervalMs: 500 });
        assert.equal(r.ok, false, label);
        assert.match(r.error ?? "", /no usable queryId/, label);
        assert.match(r.error ?? "", new RegExp(`got ${c.typeName}\\b`), label);
        // The scenario has no get-query-results branch; its fall-through exits
        // 2 with a distinctive string, so its absence proves no poll ran --
        // the same negative proof logs_query_start_malformed relies on.
        assert.equal(`${r.error ?? ""}${r.rawBody ?? ""}`.includes("unexpected argv"), false, label);
        // This arm classifies nothing, so errorKind stays absent.
        assert.equal(r.errorKind, undefined, label);
      }
    } finally {
      delete process.env.AWS_MCP_FAKE_QUERY_ID_SHAPE;
    }
  });
});

describe("aws_logs_tail handler -- errorKind / suggestion forwarding", () => {
  // logs.ts has exactly ONE errorKind-forwarding return: aws_logs_tail's CLI
  // failure arm. Both scenarios below are argv-independent, so the
  // filter-log-events argv reaches the same fake branch aws_call does -- this pins
  // the FORWARDING, not the classifier.

  it("forwards nonzero_exit plus the parsed suggestion, which stays embedded in error too", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "call_access_denied";
    const r = await handlerTool.handler({ logGroupName: "/aws/lambda/my-fn" });
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, "nonzero_exit");
    assert.equal(r.suggestion, "Check IAM permissions for this operation.");
    // Carried structurally AND left in the message: toMcpResult does not
    // re-render `suggestion`, so removing it from `error` would drop the
    // remedy from what the model reads.
    assert.ok(
      (r.error ?? "").endsWith("\n\nSuggestion: Check IAM permissions for this operation."),
      `error must still end with the suggestion sentence, got: ${r.error}`,
    );
    assert.match(r.rawBody ?? "", /AccessDenied/);
  });

  it("forwards the auth-class kind with no suggestion beside it", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "call_sso_expired";
    const r = await handlerTool.handler({ logGroupName: "/aws/lambda/my-fn", profile: "my-profile" });
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, "sso_expired");
    // The auth branches build their own profile-aware remedy into `error`, so
    // parseAwsError never runs -- the two fields are independent.
    assert.equal(r.suggestion, undefined);
    assert.match(r.error ?? "", /SSO session expired/);
  });

  it("carries the classifier's own remedy for a CloudWatch Logs IAM refusal", async () => {
    // Verbatim 2.34.3 stderr for FilterLogEvents refused by IAM (exit 254), where
    // errors.ts can name the principal and the action -- a better remedy than the
    // generic one above, on the exact text this tool's calls produce.
    process.env.AWS_MCP_FAKE_SCENARIO = "logs-tail_api_error";
    const r = await handlerTool.handler({ logGroupName: "/aws/lambda/my-fn", region: "us-east-1" });
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, "nonzero_exit");
    assert.match(r.suggestion ?? "", /lacks logs:FilterLogEvents/);
    assert.match(r.rawBody ?? "", /AccessDeniedException/);
  });
});
