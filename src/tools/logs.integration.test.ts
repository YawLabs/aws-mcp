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
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runAwsCall } from "../aws-cli.js";
import { parseLogsJsonOutput } from "./logs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AWS = join(__dirname, "..", "testing", "fake-aws.js");

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
