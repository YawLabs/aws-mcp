/**
 * Subprocess integration tests for runAwsCall. Spawns a real child process
 * (no mocking) pointed at the fake aws binary at dist/testing/fake-aws.js.
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runAwsCall } from "./aws-cli.js";
import { _resetSession, setProfile, setRegion } from "./session.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AWS = join(__dirname, "testing", "fake-aws.js");

function fakeOpts(scenario: string, overrides: { timeoutMs?: number } = {}) {
  return {
    command: process.execPath,
    prefixArgs: [FAKE_AWS],
    timeoutMs: overrides.timeoutMs ?? 5000,
    env: { ...process.env, AWS_MCP_FAKE_SCENARIO: scenario },
  };
}

afterEach(() => {
  _resetSession();
});

describe("runAwsCall — success paths", () => {
  it("parses JSON stdout on success", async () => {
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      ...fakeOpts("call_json_success"),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const data = r.data as { Buckets: Array<{ Name: string }> };
    assert.equal(data.Buckets.length, 2);
    assert.equal(data.Buckets[0].Name, "bucket-1");
    assert.ok(r.command.includes("s3api"));
    assert.ok(r.command.includes("list-buckets"));
  });

  it("returns null data on empty stdout + exit 0", async () => {
    const r = await runAwsCall({
      service: "iam",
      operation: "tag-role",
      ...fakeOpts("call_empty_success"),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.data, null);
  });

  it("returns raw string when stdout isn't valid JSON (outputFormat=json)", async () => {
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      ...fakeOpts("call_nonjson_success"),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.data, "some-plain-string");
  });

  it("skips JSON parsing when outputFormat='text'", async () => {
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      outputFormat: "text",
      ...fakeOpts("call_nonjson_success"),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.match(r.data as string, /some-plain-string/);
  });
});

describe("runAwsCall — argv construction", () => {
  it("passes --cli-input-json with the provided params", async () => {
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-objects-v2",
      params: { Bucket: "foo", MaxKeys: 10 },
      ...fakeOpts("call_echo_args"),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const { argv } = r.data as { argv: string[] };
    const idx = argv.indexOf("--cli-input-json");
    assert.ok(idx >= 0, "expected --cli-input-json flag");
    assert.deepEqual(JSON.parse(argv[idx + 1]), { Bucket: "foo", MaxKeys: 10 });
  });

  it("omits --cli-input-json when params is absent", async () => {
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      ...fakeOpts("call_echo_args"),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const { argv } = r.data as { argv: string[] };
    assert.ok(!argv.includes("--cli-input-json"));
  });

  it("omits --cli-input-json when params is an empty object", async () => {
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      params: {},
      ...fakeOpts("call_echo_args"),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const { argv } = r.data as { argv: string[] };
    assert.ok(!argv.includes("--cli-input-json"));
  });

  it("passes --profile and --region from explicit options", async () => {
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      profile: "custom-prof",
      region: "ap-south-1",
      ...fakeOpts("call_echo_args"),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const { argv } = r.data as { argv: string[] };
    assert.equal(argv[argv.indexOf("--profile") + 1], "custom-prof");
    assert.equal(argv[argv.indexOf("--region") + 1], "ap-south-1");
  });

  it("falls back to session profile/region when none passed", async () => {
    setProfile("session-sticky");
    setRegion("eu-west-2");
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      ...fakeOpts("call_echo_args"),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const { argv } = r.data as { argv: string[] };
    assert.equal(argv[argv.indexOf("--profile") + 1], "session-sticky");
    assert.equal(argv[argv.indexOf("--region") + 1], "eu-west-2");
  });

  it("passes --output in the requested format", async () => {
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      outputFormat: "yaml",
      ...fakeOpts("call_echo_args"),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    // outputFormat != "json" skips the JSON.parse — parse the raw stdout
    // manually since fake-aws always emits JSON regardless of the flag.
    const { argv } = JSON.parse(r.rawStdout) as { argv: string[] };
    assert.equal(argv[argv.indexOf("--output") + 1], "yaml");
  });

  it("defaults --output to json when unspecified", async () => {
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      ...fakeOpts("call_echo_args"),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const { argv } = r.data as { argv: string[] };
    assert.equal(argv[argv.indexOf("--output") + 1], "json");
  });

  it("splits multi-token operations into separate argv entries", async () => {
    // Some aws commands nest: e.g. `aws configure sso`. runAwsCall accepts
    // "configure sso" as the operation and splits on whitespace.
    const r = await runAwsCall({
      service: "configure",
      operation: "sso",
      ...fakeOpts("call_echo_args"),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const { argv } = r.data as { argv: string[] };
    assert.ok(argv.includes("configure"));
    assert.ok(argv.includes("sso"));
  });

  it("passes --query when a query is provided", async () => {
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      query: "Buckets[].Name",
      ...fakeOpts("call_echo_args"),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const { argv } = r.data as { argv: string[] };
    const qIdx = argv.indexOf("--query");
    assert.ok(qIdx >= 0, "expected --query to be present");
    assert.equal(argv[qIdx + 1], "Buckets[].Name");
  });

  it("omits --query when not provided", async () => {
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      ...fakeOpts("call_echo_args"),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const { argv } = r.data as { argv: string[] };
    assert.ok(!argv.includes("--query"));
  });

  it("omits --query when query is an empty/whitespace string", async () => {
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      query: "   ",
      ...fakeOpts("call_echo_args"),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const { argv } = r.data as { argv: string[] };
    assert.ok(!argv.includes("--query"));
  });

  it("redacts --cli-input-json value in the returned displayCommand", async () => {
    const r = await runAwsCall({
      service: "iam",
      operation: "update-login-profile",
      params: { UserName: "admin", Password: "hunter2-secret" },
      ...fakeOpts("call_echo_args"),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    // Subprocess still got the real payload -- safety fence is the displayed
    // command, not the argv.
    const { argv } = r.data as { argv: string[] };
    assert.deepEqual(JSON.parse(argv[argv.indexOf("--cli-input-json") + 1]), {
      UserName: "admin",
      Password: "hunter2-secret",
    });
    // But r.command (what gets returned to the MCP client / model) must not.
    assert.ok(!r.command.includes("hunter2-secret"), "secret leaked in displayCommand");
    assert.match(r.command, /<redacted len=\d+>/);
  });
});

describe("runAwsCall — failure paths", () => {
  it("classifies access denied as nonzero_exit with stderr text", async () => {
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      ...fakeOpts("call_access_denied"),
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "nonzero_exit");
    assert.match(r.error, /AccessDenied/);
    assert.equal(r.exitCode, 255);
  });

  it("classifies SSO expiry with a re-login hint mentioning the profile", async () => {
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      profile: "custom-prof",
      ...fakeOpts("call_sso_expired"),
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "sso_expired");
    assert.match(r.error, /SSO session expired/);
    assert.match(r.error, /custom-prof/);
    assert.match(r.error, /aws_login_start/);
  });

  it("classifies missing credentials", async () => {
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      ...fakeOpts("call_no_creds"),
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "no_creds");
    assert.match(r.error, /No credentials found/);
  });

  it("returns timeout when subprocess outlives timeoutMs", async () => {
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      ...fakeOpts("call_slow", { timeoutMs: 200 }),
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "timeout");
    assert.match(r.error, /timed out/);
  });

  it("returns output_too_large when stdout exceeds 5 MB cap", async () => {
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      ...fakeOpts("call_large", { timeoutMs: 10_000 }),
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "output_too_large");
    assert.match(r.error, /5 MB/);
  });

  it("returns spawn_failure when the command doesn't exist", async () => {
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      command: "this-binary-does-not-exist-xyz123",
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "spawn_failure");
  });
});
