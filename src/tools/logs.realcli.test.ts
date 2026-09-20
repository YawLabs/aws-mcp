/**
 * aws_logs_tail driven through the AWS CLI v2 installed on this machine, against a
 * CloudWatch Logs endpoint inside the test process.
 *
 * This is the step that would have caught the defect 2.4.0 fixes. The tool shipped
 * parsing `aws logs tail --format json` as NDJSON from 0.2.0, its first release, to
 * 2.3.4 because the fake CLI was the only CLI the suite ever ran, and the fake had
 * been told the wrong format. So: the same handler, the same datasets, the REAL binary -- and for
 * four of the cases an assertion that the fake gives the identical answer, which is
 * what makes the fake trustworthy for the fast tests.
 *
 * Default-on: about a dozen CLI starts (1.4-3.4 s each on this ARM64 box, so ~20 s
 * of the suite's wall clock), nothing to wait out, and it skips with a reason when
 * there is no AWS CLI v2 to run. With no CI, `npm test` is the only place it runs.
 *
 * Nothing here reaches AWS. testing/real-cli.ts scrubs every AWS_* and PYTHON*
 * variable, writes throwaway config and credentials holding fake static keys, and
 * points everything not bound for 127.0.0.1 at a dead proxy; every call is routed
 * at the stub with `--endpoint-url`, and a preflight proves the routing works before
 * any case counts requests. Per the shared rules it passes no `command` and leaves
 * AWS_MCP_TEST_AWS_COMMAND unset, so the binary under test is the one runAwsCall
 * resolves for itself.
 *
 * How one installed binary covers three CLI eras: writeModelOverlay drops a ~3 KB
 * FilterLogEvents model into a temp directory and AWS_DATA_PATH points the CLI at
 * it. `current` knows `startFromHead` (AWS CLI 2.35.8+), `legacy` does not
 * (2.9.15-2.35.7, which is what both local CLIs are), `ancient` knows no
 * `logGroupIdentifier` either (before 2.9.2). Without the overlays the newest-first
 * path would have no real-CLI coverage on any machine whose CLI predates 2.35.8.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BASIC_EVENTS,
  bulkEvents,
  type FakeFilteredLogEvent,
  UNICODE_EVENTS,
  writeModelOverlay,
} from "../testing/logs-tail-fake.js";
import {
  detectRealAwsCli,
  type IsolatedAwsEnv,
  isolateAwsEnv,
  type LoopbackStub,
  meetsMinVersion,
  startLoopbackStub,
} from "../testing/real-cli.js";
import { _resetLogsTailCliModelCache, logsTools } from "./logs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AWS = join(__dirname, "..", "testing", "fake-aws.js");

const detected = detectRealAwsCli();
const skip = detected.ok ? false : detected.reason;
/** The CLI's own model has startFromHead only from here. */
const CLI_HAS_START_FROM_HEAD = detected.ok ? meetsMinVersion(detected.cli.version, [2, 35, 8]) : false;

const tool = logsTools.find((t) => t.name === "aws_logs_tail");
if (!tool) throw new Error("logsTools missing aws_logs_tail");

const REGION = "us-east-1";
const ACCOUNT = "123456789012";
const arnFor = (name: string) => `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:${name}`;

/** The projection the handler asks for, applied to a dataset event. */
const projected = (e: FakeFilteredLogEvent) => ({
  timestamp: new Date(e.timestamp).toISOString(),
  logStreamName: e.logStreamName,
  message: e.message,
});

interface TailEnvelope {
  logGroupName: string;
  logGroupIdentifier: string | null;
  eventCount: number;
  totalEvents: number | null;
  truncated: boolean;
  events: Array<{ timestamp: string | null; logStreamName: string | null; message: string | null }>;
}

const parity = (real: TailEnvelope, fake: TailEnvelope, label: string): void => {
  assert.deepEqual(fake.events, real.events, `${label}: events differ between the fake and the real CLI`);
  assert.equal(fake.eventCount, real.eventCount, `${label}: eventCount`);
  assert.equal(fake.totalEvents, real.totalEvents, `${label}: totalEvents`);
  assert.equal(fake.truncated, real.truncated, `${label}: truncated`);
  assert.equal(fake.logGroupIdentifier, real.logGroupIdentifier, `${label}: logGroupIdentifier`);
};

describe(`aws_logs_tail -- installed AWS CLI${detected.ok ? ` (${detected.cli.versionLine})` : ""}`, { skip }, () => {
  let stub: LoopbackStub;
  let iso: IsolatedAwsEnv;
  let overlayRoot: string;
  const overlays: Record<"current" | "legacy" | "ancient", string> = { current: "", legacy: "", ancient: "" };
  /** Every FilterLogEvents request body the stub received, newest last. */
  let bodies: Array<Record<string, unknown>> = [];

  const BULK = bulkEvents();

  /**
   * FilterLogEvents over the shared datasets. One group per behavior, keyed by
   * substring so the same routing works for a name and for an ARN:
   *   /stub/basic    the six-event dataset, one page
   *   /stub/bulk     1,200 events, pages of min(500, limit)
   *   /stub/ignored  the same, but startFromHead is IGNORED (moto, LocalStack)
   *   /stub/unicode  the three non-ASCII messages
   *   /stub/empty    no events at all
   *   /stub/noevents an empty window reported with NO `events` member at all
   */
  const page = (
    all: readonly FakeFilteredLogEvent[],
    body: Record<string, unknown>,
    pageMax: number,
    honour: boolean,
  ) => {
    const token = typeof body.nextToken === "string" ? body.nextToken : null;
    const descending = honour && (body.startFromHead === false || token?.startsWith("d") === true);
    const ordered = descending ? [...all].reverse() : [...all];
    const limit = typeof body.limit === "number" ? body.limit : pageMax;
    const size = Math.min(pageMax, limit);
    const start = token ? Number(token.slice(1)) : 0;
    const events = ordered.slice(start, start + size);
    const next = start + size < ordered.length ? `${descending ? "d" : "a"}${start + size}` : undefined;
    return { events, searchedLogStreams: [], ...(next ? { nextToken: next } : {}) };
  };

  before(async () => {
    stub = await startLoopbackStub((req, res) => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(req.body || "{}") as Record<string, unknown>;
      } catch {
        // Left as {}: the assertion that fails will be the one reading the body.
      }
      bodies.push(body);
      const group = String(body.logGroupName ?? body.logGroupIdentifier ?? "");
      let answer: unknown;
      // Checked before /empty, whose substring it does not contain, but keeping the
      // narrower route first makes the ordering independent of the names.
      if (group.includes("/noevents")) answer = { searchedLogStreams: [] };
      else if (group.includes("/empty")) answer = { events: [], searchedLogStreams: [] };
      else if (group.includes("/unicode")) answer = { events: UNICODE_EVENTS, searchedLogStreams: [] };
      else if (group.includes("/ignored")) answer = page(BULK, body, 500, false);
      else if (group.includes("/bulk")) answer = page(BULK, body, 500, true);
      else answer = { events: BASIC_EVENTS, searchedLogStreams: [] };
      const payload = JSON.stringify(answer);
      res.writeHead(200, {
        "content-type": "application/x-amz-json-1.1",
        "content-length": String(Buffer.byteLength(payload)),
      });
      res.end(payload);
    });

    overlayRoot = mkdtempSync(join(tmpdir(), "logs-tail-models-"));
    for (const variant of ["current", "legacy", "ancient"] as const) {
      overlays[variant] = writeModelOverlay(join(overlayRoot, variant), variant);
    }

    iso = isolateAwsEnv({
      set: {
        // The routing every call uses. AWS_MCP_TEST_AWS_COMMAND stays UNSET, so
        // runAwsCall resolves the binary exactly as it does in production.
        AWS_MCP_TEST_AWS_PREFIX_ARGS: JSON.stringify(["--endpoint-url", stub.url]),
        // A second guard: honoured from AWS CLI 2.13.0, and harmless before it.
        AWS_ENDPOINT_URL: stub.url,
        AWS_REGION: REGION,
      },
    });

    // Preflight, per the shared real-CLI rules. A CLI is installed, so broken
    // routing is a bug here, not a reason to skip -- and without this a suite whose
    // calls never arrive would pass every "zero requests" assertion.
    const r = await tailReal("/stub/empty");
    assert.equal(r.ok, true, `preflight call failed: ${r.error ?? ""}`);
    assert.ok(stub.requests.length >= 1, "the preflight call reached the stub");
  });

  after(async () => {
    iso?.restore();
    await stub?.close();
    if (overlayRoot) rmSync(overlayRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    bodies = [];
    // The "this CLI has no startFromHead" flag lives for the process, and the cases
    // deliberately change which model the CLI loads.
    _resetLogsTailCliModelCache();
  });

  /** One handler call through the REAL CLI, optionally under a model overlay. */
  const tailReal = async (
    logGroupName: string,
    input: Record<string, unknown> = {},
    variant?: "current" | "legacy" | "ancient",
  ) => {
    if (variant) process.env.AWS_DATA_PATH = overlays[variant];
    else delete process.env.AWS_DATA_PATH;
    try {
      // Room for a cold CLI start on a machine busy with a parallel `node --test`
      // run; nothing here waits on a timeout.
      return await tool.handler({ logGroupName, region: REGION, timeoutMs: 120_000, ...input });
    } finally {
      delete process.env.AWS_DATA_PATH;
    }
  };

  /** The same handler call through the fake CLI, for the parity assertions. */
  const tailFake = async (scenario: string, logGroupName: string, input: Record<string, unknown> = {}) => {
    const prevCommand = process.env.AWS_MCP_TEST_AWS_COMMAND;
    const prevPrefix = process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS;
    process.env.AWS_MCP_TEST_AWS_COMMAND = process.execPath;
    process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS = JSON.stringify([FAKE_AWS]);
    process.env.AWS_MCP_FAKE_SCENARIO = scenario;
    _resetLogsTailCliModelCache();
    try {
      return await tool.handler({ logGroupName, region: REGION, timeoutMs: 120_000, ...input });
    } finally {
      delete process.env.AWS_MCP_FAKE_SCENARIO;
      if (prevCommand === undefined) delete process.env.AWS_MCP_TEST_AWS_COMMAND;
      else process.env.AWS_MCP_TEST_AWS_COMMAND = prevCommand;
      if (prevPrefix === undefined) delete process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS;
      else process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS = prevPrefix;
      _resetLogsTailCliModelCache();
    }
  };

  it("case 1: the installed CLI, no overlay, returns the six events structured", async () => {
    const r = await tailReal("/stub/basic");
    assert.equal(r.ok, true, `handler failed: ${r.error ?? ""}`);
    const data = r.data as TailEnvelope;
    assert.deepEqual(data.events, BASIC_EVENTS.map(projected), "the real CLI's own output, projected");
    assert.equal(data.eventCount, 6);
    assert.equal(data.totalEvents, 6);
    assert.equal(data.truncated, false);
    assert.equal(data.logGroupIdentifier, null);
    // Which path this binary took is a fact about the CLI, not about the handler.
    assert.equal(
      "startFromHead" in bodies[0],
      CLI_HAS_START_FROM_HEAD,
      CLI_HAS_START_FROM_HEAD
        ? "a 2.35.8+ CLI sends the member"
        : "an older CLI rejects it before sending, so the first REQUEST carries none",
    );

    // Parity with whichever fake scenario models the path this CLI took.
    const fake = await tailFake(
      CLI_HAS_START_FROM_HEAD ? "logs-tail_current_basic" : "logs-tail_legacy_basic",
      "/stub/basic",
    );
    assert.equal(fake.ok, true, `fake failed: ${fake.error ?? ""}`);
    parity(data, fake.data as TailEnvelope, "case 1");
  });

  it("case 2: with startFromHead, one request brings back the newest maxEvents", async () => {
    const r = await tailReal("/stub/bulk", { maxEvents: 5 }, "current");
    assert.equal(r.ok, true, `handler failed: ${r.error ?? ""}`);
    const data = r.data as TailEnvelope;
    assert.deepEqual(
      data.events.map((e) => e.message),
      ["event-1195", "event-1196", "event-1197", "event-1198", "event-1199"],
      "the newest five, oldest-first",
    );
    assert.equal(data.truncated, true);
    assert.equal(data.totalEvents, null, "the read stopped early");
    assert.equal(bodies.length, 1, "one FilterLogEvents request for a 1,200-event window");
    assert.equal(bodies[0].startFromHead, false);
    assert.equal(bodies[0].limit, 6, "--page-size became the request's limit: maxEvents + 1");
    assert.equal("nextToken" in bodies[0], false);

    const fake = await tailFake("logs-tail_current_bulk", "/stub/bulk", { maxEvents: 5 });
    assert.equal(fake.ok, true, `fake failed: ${fake.error ?? ""}`);
    parity(data, fake.data as TailEnvelope, "case 2");
  });

  it("case 3: without startFromHead, the rejected attempt sends nothing and the window is drained", async () => {
    const r = await tailReal("/stub/bulk", { maxEvents: 5 }, "legacy");
    assert.equal(r.ok, true, `handler failed: ${r.error ?? ""}`);
    const data = r.data as TailEnvelope;
    assert.deepEqual(
      data.events.map((e) => e.message),
      ["event-1195", "event-1196", "event-1197", "event-1198", "event-1199"],
      "the same five events as the newest-first path",
    );
    assert.equal(data.truncated, true);
    assert.equal(data.totalEvents, 1200, "the whole window was read, so the count is exact");
    // The rejection is client-side: zero requests for the first attempt, then the
    // drain. 1,200 events in pages of 500 is three requests.
    assert.equal(bodies.length, 3, "the rejected newest-first attempt reached the endpoint zero times");
    for (const body of bodies) assert.equal("startFromHead" in body, false);

    const fake = await tailFake("logs-tail_legacy_bulk", "/stub/bulk", { maxEvents: 5 });
    assert.equal(fake.ok, true, `fake failed: ${fake.error ?? ""}`);
    parity(data, fake.data as TailEnvelope, "case 3");
  });

  it("case 3b: the rejection is remembered for the process, so the next call skips it", async () => {
    // Observable from the endpoint: after a legacy CLI has rejected the member, a
    // call that CAN send it (the current overlay) still does not, because the
    // handler no longer tries. Then a cache reset brings the attempt back.
    await tailReal("/stub/empty", {}, "legacy");
    bodies = [];
    await tailReal("/stub/empty", {}, "current");
    assert.equal(bodies.length, 1);
    assert.equal("startFromHead" in bodies[0], false, "the pinned answer skipped the newest-first read");

    _resetLogsTailCliModelCache();
    bodies = [];
    await tailReal("/stub/empty", {}, "current");
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].startFromHead, false, "after the reset it asks newest-first again");
  });

  it("case 4: an endpoint that ignores startFromHead is re-read whole, not reversed", async () => {
    const r = await tailReal("/stub/ignored", { maxEvents: 3 }, "current");
    assert.equal(r.ok, true, `handler failed: ${r.error ?? ""}`);
    const data = r.data as TailEnvelope;
    assert.deepEqual(
      data.events.map((e) => e.message),
      ["event-1197", "event-1198", "event-1199"],
      "the NEWEST three -- reversing the ascending fetch would have given event-2,1,0",
    );
    assert.equal(data.totalEvents, 1200, "the whole window, so the count is exact");
    assert.equal(data.truncated, true);
    // The newest-first read (one page of 4, ascending because the endpoint ignored
    // the member), then the whole-window drain.
    assert.equal(bodies[0].startFromHead, false);
    assert.equal(bodies[0].limit, 4);
    assert.equal("startFromHead" in bodies[1], false, "the second read asks for the whole window");
    assert.equal(bodies.length, 4, "one newest-first page plus three whole-window pages");

    const fake = await tailFake("logs-tail_ignored_bulk", "/stub/ignored", { maxEvents: 3 });
    assert.equal(fake.ok, true, `fake failed: ${fake.error ?? ""}`);
    parity(data, fake.data as TailEnvelope, "case 4");
  });

  it("case 5: ARN input reaches the endpoint as logGroupIdentifier without the ':*'", async () => {
    const r = await tailReal(`${arnFor("/stub/basic")}:*`, {}, "current");
    assert.equal(r.ok, true, `handler failed: ${r.error ?? ""}`);
    const data = r.data as TailEnvelope;
    assert.equal(data.logGroupIdentifier, arnFor("/stub/basic"));
    assert.equal(data.logGroupName, "/stub/basic");
    assert.equal(bodies[0].logGroupIdentifier, arnFor("/stub/basic"), "the real CLI forwards it as sent");
    assert.equal("logGroupName" in bodies[0], false);
    assert.equal(data.eventCount, 6);
  });

  it("case 6: ARN input on a CLI that has no logGroupIdentifier fails with ZERO requests", async () => {
    const r = await tailReal(arnFor("/stub/basic"), {}, "ancient");
    assert.equal(r.ok, false, "a model without logGroupIdentifier cannot address the group");
    assert.match(r.error ?? "", /AWS CLI 2\.9\.15\+/);
    assert.match(r.error ?? "", /Pass the bare name '\/stub\/basic'/);
    assert.equal(r.errorKind, "nonzero_exit");
    assert.equal(r.suggestion, undefined);
    assert.equal(bodies.length, 0, "botocore validates before signing, so nothing was sent");
  });

  it("case 7: an empty window is an empty array, not an error", async () => {
    const r = await tailReal("/stub/empty", {}, "current");
    assert.equal(r.ok, true, `handler failed: ${r.error ?? ""}`);
    const data = r.data as TailEnvelope;
    assert.deepEqual(data.events, []);
    assert.equal(data.eventCount, 0);
    assert.equal(data.totalEvents, 0);
    assert.equal(data.truncated, false);
  });

  it("case 7b: an endpoint that omits the events member is still an empty window", async () => {
    // The one case only a real CLI can show: the --query is evaluated by the CLI's
    // own JMESPath, and logs-tail-fake.ts's emulator always builds an `events`
    // list, so no fake call can reach this. Before the `|| `[]`` defaults in
    // buildTailQuery, `length(events)` raised on the null and the CLI exited 255
    // with `In function length(), invalid type for value: None` -- forwarded to the
    // caller as nonzero_exit, for the one window the tool always got right.
    //
    // Real CloudWatch Logs and moto both send `events: []`; the reachable
    // population is a compatible endpoint behind AWS_ENDPOINT_URL. The projection
    // is ours either way.
    const r = await tailReal("/stub/noevents", {}, "current");
    assert.equal(r.ok, true, `handler failed: ${r.error ?? ""}`);
    const data = r.data as TailEnvelope;
    assert.deepEqual(data.events, [], "no events member reads as no events, not as a failure");
    assert.equal(data.eventCount, 0);
    assert.equal(data.totalEvents, 0);
    assert.equal(data.truncated, false);
  });

  it("case 8: non-ASCII log messages round-trip exactly", async () => {
    // No `todo`: the child-env encoding pins (AWS_CLI_OUTPUT_ENCODING=utf-8 and
    // PYTHONUTF8=1, aws-spawn.ts) ship in this same release. Without them the check
    // mark failed the whole call on Windows with `'charmap' codec can't encode
    // character` and `café` came back as U+FFFD with ok: true.
    const r = await tailReal("/stub/unicode", {}, "current");
    assert.equal(r.ok, true, `handler failed: ${r.error ?? ""}`);
    const data = r.data as TailEnvelope;
    assert.deepEqual(
      data.events.map((e) => e.message),
      UNICODE_EVENTS.map((e) => e.message),
      "every message byte-for-byte through the real CLI",
    );
  });
});

/**
 * The one thing no stub can show: that the live service really returns the newest
 * events first when `startFromHead: false` is sent, across the streams of a busy
 * group. Read-only, one call.
 *
 * Runs with the ORIGINAL environment (the describe above restores it in its after
 * hook), so it uses the operator's own credentials. Gated on AWS_MCP_LIVE_TESTS=1
 * plus AWS_MCP_LIVE_LOG_GROUP; AWS_MCP_LIVE_PROFILE / AWS_MCP_LIVE_REGION override
 * profile and region just for this test.
 *
 * Run THIS FILE ONLY -- a bare `AWS_MCP_LIVE_TESTS=1 npm test` also drives a real
 * Cloud Control resource lifecycle:
 *   npm run build && AWS_MCP_LIVE_TESTS=1 AWS_MCP_LIVE_PROFILE=my-profile \
 *     AWS_MCP_LIVE_LOG_GROUP=/aws/lambda/something-busy \
 *     node --test dist/tools/logs.realcli.test.js
 */
const LIVE = process.env.AWS_MCP_LIVE_TESTS === "1";
const LIVE_LOG_GROUP = process.env.AWS_MCP_LIVE_LOG_GROUP;
const liveSkip = !LIVE
  ? "set AWS_MCP_LIVE_TESTS=1 to run the live check"
  : !LIVE_LOG_GROUP
    ? "set AWS_MCP_LIVE_LOG_GROUP to a log group with recent events"
    : false;

describe("aws_logs_tail -- live CloudWatch Logs", { skip: liveSkip }, () => {
  it("returns at most maxEvents events, oldest-first, from a real busy group", async () => {
    const started = Date.now();
    const r = await tool.handler({
      logGroupName: LIVE_LOG_GROUP as string,
      since: "1h",
      maxEvents: 20,
      timeoutMs: 120_000,
      ...(process.env.AWS_MCP_LIVE_PROFILE ? { profile: process.env.AWS_MCP_LIVE_PROFILE } : {}),
      ...(process.env.AWS_MCP_LIVE_REGION ? { region: process.env.AWS_MCP_LIVE_REGION } : {}),
    });
    assert.equal(r.ok, true, `live read failed: ${r.error ?? ""}`);
    const data = r.data as TailEnvelope;
    console.log(
      `[live] ${data.eventCount} events, totalEvents=${data.totalEvents}, truncated=${data.truncated}, ${Date.now() - started} ms`,
    );
    assert.ok(data.eventCount <= 20, "the cap held");
    const stamps = data.events.map((e) => e.timestamp);
    for (let idx = 1; idx < stamps.length; idx++) {
      assert.ok(
        (stamps[idx - 1] ?? "") <= (stamps[idx] ?? ""),
        `events must be oldest-first: ${stamps[idx - 1]} then ${stamps[idx]}`,
      );
    }
    // On a CLI that sends startFromHead, a group busy enough to fill the cap must
    // report the truncation -- and the newest event must be inside the window.
    if (CLI_HAS_START_FROM_HEAD && data.eventCount === 20) {
      assert.equal(data.truncated, true);
      assert.equal(data.totalEvents, null);
      const newest = stamps.at(-1);
      assert.ok(newest && Date.now() - Date.parse(newest) <= 3_600_000 + 60_000, "the newest event is inside 'since'");
    }
  });
});
