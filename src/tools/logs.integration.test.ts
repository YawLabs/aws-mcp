/**
 * Subprocess integration for aws_logs_tail. Exercises the argv construction
 * and NDJSON parsing by routing runAwsCall at the fake aws binary via the
 * same test-injection knobs the other integration tests use.
 *
 * The handler itself doesn't take command/prefixArgs/env knobs, so we call
 * runAwsCall directly with the extraFlags aws_logs_tail would have built and
 * then verify via parseLogsJsonOutput that the NDJSON round-trip works.
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runAwsCall } from "../aws-cli.js";
import { logsTools, parseLogsJsonOutput } from "./logs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AWS = join(__dirname, "..", "testing", "fake-aws.js");

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
    // the middle line is not valid JSON (see fake-aws.ts:437). The handler
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
});
