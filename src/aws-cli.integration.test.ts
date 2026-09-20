/**
 * Subprocess integration tests for runAwsCall. Spawns a real child process
 * (no mocking) pointed at the fake aws binary at dist/testing/fake-aws.js.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { INLINE_CLI_INPUT_JSON_MAX_CHARS, runAwsCall, shellQuoteArg } from "./aws-cli.js";
import { _resetSession, setProfile, setRegion } from "./session.js";
import { tmpdirIgnoresModes } from "./testing/tmpdir-modes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AWS = join(__dirname, "testing", "fake-aws.js");

function fakeOpts(scenario: string, overrides: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}) {
  return {
    command: process.execPath,
    prefixArgs: [FAKE_AWS],
    // A hang guard, not the thing under test: success-path calls settle the
    // moment the fake exits. 5s lost to the fake's cold start with the CPU
    // saturated (5.3s and 5.8s measured), so size it for a starved machine.
    // Tests that exercise the timeout path pass their own timeoutMs.
    timeoutMs: overrides.timeoutMs ?? 30_000,
    env: { ...process.env, AWS_MCP_FAKE_SCENARIO: scenario, ...overrides.env },
  };
}

/**
 * The timeoutMs budgets tried, in order, by runWithFlushBeforeTimeout for a
 * fake that spawns nothing. The first keeps an idle run fast. The last is
 * sized for a starved machine, not an idle one: spawn-to-first-byte peaked at
 * ~3.6s with the CPU oversubscribed 2x, but went past 15s once with it
 * oversubscribed ~3x.
 */
const FLUSH_BEFORE_TIMEOUT_BUDGETS_MS = [2_000, 30_000];

/**
 * For tests whose premise is "the fake wrote its fragment, THEN our timeout
 * killed it". No fixed timeoutMs guarantees that ordering: Node's cold start
 * under a parallel `node --test` run can outlast any small budget, and when it
 * does the kill lands before the write and rawStdout is legitimately empty.
 * Raising the budget only moves the line: the partial-stdout test below went
 * from 200ms to 2000ms and still flaked.
 *
 * So instead of betting on the scheduler, each attempt asks the fake. It
 * creates `readyPath` only after its fragment is flushed to the pipe
 * (AWS_MCP_FAKE_READY_OUT, see writeStdoutThenMarkReady in fake-aws.ts). An
 * attempt that settled without the file never reached the behavior under test,
 * so it is discarded and retried at the next budget; the first attempt WITH the
 * file is returned for the caller to assert on. A discarded attempt never
 * counts as a pass -- the caller's assertions only ever see a run whose premise
 * held. An attempt that THROWS (a hang, say) fails the test at once, whatever
 * the file says.
 */
async function runWithFlushBeforeTimeout<T>(
  t: TestContext,
  budgetsMs: readonly number[],
  attempt: (timeoutMs: number, readyPath: string) => Promise<T>,
): Promise<T> {
  for (const timeoutMs of budgetsMs) {
    const readyPath = join(tmpdir(), `aws-mcp-ready-${process.pid}-${randomUUID()}`);
    try {
      const result = await attempt(timeoutMs, readyPath);
      if (existsSync(readyPath)) return result;
      t.diagnostic(`timeoutMs=${timeoutMs} fired before the fake flushed its fragment; attempt discarded`);
    } finally {
      rmSync(readyPath, { force: true });
    }
  }
  return assert.fail(
    `the fake never confirmed its fragment was flushed before runAwsCall killed it, at any budget up to ${budgetsMs.at(-1)}ms. Either this machine is starved far beyond a cold start, or the child is killed (or spawned without AWS_MCP_FAKE_READY_OUT) before it can write.`,
  );
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
    // A --query expression extracting a scalar returns it unquoted even under
    // --output json. That IS the successful result, so the string fallback
    // stays -- see the malformed-JSON cases below for the half that doesn't.
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

describe("runAwsCall — truncated JSON is a FAILURE, not a success", () => {
  // The bug: JSON.parse failure settled {ok:true, data: trimmed} for every
  // input, so a truncated payload was reported as a successful call carrying a
  // broken string. The scalar rationale is real, but it only covers stdout
  // that isn't JSON at all -- text that OPENS with '{' or '[' and fails to
  // parse is a truncation, and silently downgrading it to a string is how a
  // partial result gets treated as the whole result.

  it("settles kind='malformed_json' when stdout opens with '{' and fails to parse", async () => {
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      ...fakeOpts("call_truncated_json"),
    });
    assert.equal(r.ok, false, "a truncated payload must not be reported as a successful call");
    if (r.ok) return;
    assert.equal(r.kind, "malformed_json");
    assert.match(r.error, /failed to parse/i);
    assert.match(r.error, /truncated/i);
    // Exit code was 0 -- the CLI itself thought it succeeded. That is exactly
    // why this needs its own kind rather than nonzero_exit.
    assert.equal(r.exitCode, 0);
    // The bytes that did arrive are preserved for diagnosis.
    assert.match(r.rawStdout ?? "", /bucket-1/);
  });

  it("detects the '[' container too", async () => {
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      ...fakeOpts("call_truncated_json_array"),
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "malformed_json");
  });

  it("does NOT fire for a scalar --query result", async () => {
    // The guard against over-correcting: plain text must still be ok:true.
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      ...fakeOpts("call_nonjson_success"),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.data, "some-plain-string");
  });

  it("does NOT fire for empty stdout", async () => {
    // Empty is a legitimate success shape (tag-role, put-*) and never reaches
    // the parse at all.
    const r = await runAwsCall({
      service: "iam",
      operation: "tag-role",
      ...fakeOpts("call_empty_success"),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.data, null);
  });

  it("does NOT fire for outputFormat != json (nothing is parsed)", async () => {
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      outputFormat: "text",
      ...fakeOpts("call_truncated_json"),
    });
    assert.equal(r.ok, true, "text/table/yaml output is passed through unparsed");
    if (!r.ok) return;
    assert.match(r.data as string, /bucket-1/);
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

  it("shell-quotes the displayed command so it survives a paste", async () => {
    // data.command goes to a model, which pastes far more readily than a human
    // does. The redaction stub contains spaces and angle brackets and a --query
    // expression contains brackets and dots, so an unquoted join produced a
    // string that either failed to run or ran something else.
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      query: "Buckets[].Name",
      params: { Prefix: "x" },
      ...fakeOpts("call_echo_args"),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    // Both hazardous entries appear quoted...
    assert.match(r.command, /'Buckets\[\]\.Name'/);
    assert.match(r.command, /'<redacted len=\d+>'/);
    // ...and the ordinary tokens are left alone, so the string stays readable.
    assert.match(r.command, /(^|\s)s3api\s/);
    assert.match(r.command, /\s--query\s/);
  });

  it("passes a trusted fileb:// value through to argv untouched", async () => {
    // The exemption has to reach the child verbatim: the CLI resolves that path
    // itself, so a guard that rewrote or dropped the entry would break
    // aws_lambda_invoke's payload rather than protect anything. Windows
    // backslashes and a drive letter are part of the string it compares.
    const payloadArg = "fileb://C:\\aws-mcp\\payload.json";
    const r = await runAwsCall({
      service: "lambda",
      operation: "invoke",
      extraFlags: ["--function-name", "my-fn", "--payload", payloadArg],
      trustedParamFileArgs: [payloadArg],
      ...fakeOpts("call_echo_args"),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const { argv } = r.data as { argv: string[] };
    const idx = argv.indexOf("--payload");
    assert.ok(idx >= 0, "expected --payload to be present");
    assert.equal(argv[idx + 1], payloadArg);
  });

  it("leaves a clean extraFlags list exactly as given", async () => {
    // The guard reads extraFlags and never edits it. Asserted on a list with no
    // paramfile value at all, so a future "sanitize instead of refuse" change
    // fails here rather than silently altering what the CLI receives.
    const extraFlags = ["--max-items", "100", "--starting-token", "eyJOZXh0VG9rZW4iOiAiYWJjIn0="];
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-objects-v2",
      extraFlags,
      ...fakeOpts("call_echo_args"),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const { argv } = r.data as { argv: string[] };
    const start = argv.indexOf("--max-items");
    assert.ok(start >= 0, "expected --max-items to be present");
    assert.deepEqual(argv.slice(start, start + extraFlags.length), extraFlags);
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

  it("classifies a service-reported token expiry as expired_creds, with advice for BOTH origins", async () => {
    // AWS emits the ExpiredToken wrapper for any expired temporary credential.
    // Classifying it sso_expired sent an assume-role user to aws_login_start,
    // which cannot refresh an STS session -- and through aws_assume_role the
    // underlying stderr was dropped, so nothing on screen contradicted the
    // wrong advice. This kind names both remedies and keeps the raw stderr.
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      profile: "assume-prof",
      ...fakeOpts("awscli_expired_token"),
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "expired_creds");
    assert.match(r.error, /assume-prof/);
    assert.match(r.error, /aws_login_start/, "the SSO remedy must still be offered");
    assert.match(r.error, /aws_assume_role/, "the STS remedy is the one that was missing");
    // The stderr the assume path used to drop entirely.
    assert.match(r.error, /Underlying error: An error occurred \(ExpiredToken\)/);
    assert.equal(r.exitCode, 255);
  });

  it("keeps a genuinely SSO-sourced expiry on the SSO-specific message", async () => {
    // The other half of the split: when the stderr DOES name botocore's SSO
    // token provider, the origin is known and the re-login advice is right.
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      ...fakeOpts("call_sso_expired"),
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "sso_expired");
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

  it("reports 'exited with code N and no stderr' on nonzero exit with empty stderr", async () => {
    // call_fail_stdout_only writes to stdout and exits 1 with EMPTY stderr.
    // classifyAuthError(new Error("")) -> "other", so kind=nonzero_exit; the
    // empty trimmed stderr is falsy, so baseMsg falls back to the
    // "exited with code N and no stderr" string (aws-cli.ts:345). parseAwsError("")
    // returns {} so no Suggestion is appended.
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      ...fakeOpts("call_fail_stdout_only"),
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "nonzero_exit");
    assert.equal(r.error, "aws CLI exited with code 1 and no stderr");
    assert.equal(r.exitCode, 1);
    // The stdout it did emit is preserved for diagnosis even on the failure.
    assert.match(r.rawStdout ?? "", /partial-output-on-stdout/);
  });

  it("appends a recognized Suggestion onto a nonzero_exit error", async () => {
    // call_access_denied emits the canonical AccessDenied stderr. parseAwsError
    // recognizes code=AccessDenied with no User: line, so it appends the generic
    // IAM suggestion (errors.ts:137) after a blank-line separator.
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      ...fakeOpts("call_access_denied"),
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "nonzero_exit");
    assert.match(r.error, /AccessDenied/);
    assert.match(r.error, /\n\nSuggestion: Check IAM permissions for this operation\./);
  });

  it("includes the truncated stderr after 'Underlying error: ' for no_creds", async () => {
    // The no_creds branch (aws-cli.ts:342) suffixes the underlying stderr so the
    // agent can see WHY creds resolution failed, not just that it did.
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      ...fakeOpts("call_no_creds"),
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "no_creds");
    assert.match(r.error, /Underlying error: /);
    // The actual stderr text follows the prefix.
    assert.match(r.error, /Underlying error: Unable to locate credentials/);
  });

  it("preserves partial stdout when a timeout kills a subprocess mid-stream", async (t) => {
    // call_partial_then_hang flushes a JSON fragment, then hangs past our
    // timeoutMs. The timeout branch attaches the partial rawStdout to the
    // failure so the bytes that DID arrive before the kill aren't lost. The
    // fragment is not valid JSON on its own -- the timeout path never parses
    // stdout, it just preserves the raw bytes, so this does NOT go down the
    // malformed_json path above.
    //
    // runAwsCall now settles on 'close' rather than 'exit', which strengthens
    // this case: 'close' fires only once the pipes are drained, so a fragment
    // still sitting in the pipe when the child is reaped can no longer be lost
    // to a settle that beat the read.
    //
    // The remaining requirement is that the fake gets its write out before our
    // timeout kills it. A fixed timeoutMs cannot promise that: 200ms failed
    // about 1 run in 6 under a parallel full-suite run, and 2000ms still failed
    // 5 runs in 8 with the CPU oversubscribed, both as an empty rawStdout.
    // runWithFlushBeforeTimeout only asserts on a run where the fake confirmed
    // the write landed first.
    const r = await runWithFlushBeforeTimeout(t, FLUSH_BEFORE_TIMEOUT_BUDGETS_MS, (timeoutMs, readyPath) =>
      runAwsCall({
        service: "s3api",
        operation: "list-buckets",
        ...fakeOpts("call_partial_then_hang", { timeoutMs, env: { AWS_MCP_FAKE_READY_OUT: readyPath } }),
      }),
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "timeout");
    assert.match(r.error, /timed out/);
    assert.match(
      r.rawStdout ?? "",
      /this-arrived-before-the-timeout/,
      "partial stdout must survive the kill -- an empty rawStdout here means the fragment never drained before the timeout",
    );
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

  it("settles via the async proc.on('error') handler when spawn returns but the binary is missing", async () => {
    // Reliable trigger: Node's child_process.spawn for a nonexistent binary
    // returns a ChildProcess on both POSIX and Windows, then emits the
    // 'error' event asynchronously (ENOENT). The sync-throw codepath fires
    // only for argument-shape errors (e.g. invalid options), not for ENOENT.
    // The message variants differ: sync-throw produces "Failed to spawn ...";
    // the async handler at aws-cli.ts:263-271 produces "Failed to run ...".
    // Asserting the async-variant text pins the async handler.
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      command: "this-binary-does-not-exist-async-trigger-xyz",
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "spawn_failure");
    assert.match(
      r.error,
      /Failed to run/,
      "async proc.on('error') handler should produce 'Failed to run', not 'Failed to spawn'",
    );
    assert.match(r.error, /AWS CLI installed and on PATH/);
    // displayCommand must still be populated -- the handler reads it from the
    // outer closure to give the user context about which invocation failed.
    assert.ok(r.command, "command should be populated by the async error handler");
    assert.ok(r.command.includes("s3api"));
  });

  it("decodes a multi-byte UTF-8 codepoint split across two stdout 'data' chunks (StringDecoder coverage)", async () => {
    // The fake writes the 4-byte sequence for U+20BB7 split across two
    // process.stdout.write() calls with a 50ms sleep in between, so the
    // parent's stdout.on('data') handler fires twice and the StringDecoder
    // at aws-cli.ts:221 must buffer the partial sequence across calls. If
    // the decoder is replaced by a naive chunk.toString(), the second
    // decoded chunk starts with U+FFFD (replacement) and JSON.parse fails
    // or the resulting string contains replacement characters.
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      ...fakeOpts("awscli_utf8_split"),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const data = r.data as { name: string };
    assert.equal(data.name, "\u{20BB7}", "expected the supplementary-plane codepoint intact, not U+FFFD");
    // Belt-and-suspenders: explicitly assert no replacement characters in the
    // raw stdout. A naive .toString() per chunk would leave U+FFFD here.
    assert.ok(!r.rawStdout.includes("�"), "rawStdout must not contain U+FFFD replacement chars");
  });
});

describe("spawn-hardening: the pinned child environment", () => {
  it("pins the CLI settings this server parses, over hostile values in the caller's env", async () => {
    const r = await runAwsCall({
      service: "sts",
      operation: "get-caller-identity",
      ...fakeOpts("spawn-hardening_echo_env", {
        // The shapes a user's ~/.aws/config or shell can produce, each of which
        // breaks something this server reads: a non-default error format hides
        // the text errors.ts anchors on, auto-prompt kills the call outright,
        // and either encoding knob turned off corrupts non-ASCII output.
        env: {
          AWS_CLI_ERROR_FORMAT: "json",
          AWS_CLI_AUTO_PROMPT: "on",
          AWS_CLI_OUTPUT_ENCODING: "cp1252",
          PYTHONUTF8: "0",
          NoDefaultCurrentDirectoryInExePath: "0",
        },
      }),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const { env } = r.data as { env: Record<string, unknown> };
    assert.equal(env.AWS_CLI_ERROR_FORMAT, "enhanced");
    assert.equal(env.AWS_CLI_AUTO_PROMPT, "off");
    assert.equal(env.AWS_CLI_OUTPUT_ENCODING, "utf-8");
    assert.equal(env.PYTHONUTF8, "1");
    // win32 only: it stops the CLI's OWN children (session-manager-plugin, a
    // bare-name credential_process) resolving out of the working directory.
    assert.equal(
      env.NoDefaultCurrentDirectoryInExePath,
      process.platform === "win32" ? "1" : "0",
      "the win32 pin must win on win32, and must not be invented elsewhere",
    );
  });

  it("layers the pins over the caller's own environment rather than replacing it", async () => {
    // The shape aws_multi_account passes: a full copy of process.env with the
    // assumed-role credentials written in and every profile variable removed
    // (tools/multi-account.ts credentialEnv), plus tools/lambda.ts's
    // AWS_MAX_ATTEMPTS=1. Both have to survive the pins -- the credentials are
    // the only identity such a call has, and the attempt cap is what keeps a
    // Lambda from being invoked twice.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AWS_MCP_FAKE_SCENARIO: "spawn-hardening_echo_env",
      AWS_ACCESS_KEY_ID: "ASIAAWSMCPSPAWNHARDENING",
      AWS_SECRET_ACCESS_KEY: "aws-mcp-spawn-hardening-fake-secret",
      AWS_SESSION_TOKEN: "aws-mcp-spawn-hardening-fake-token",
      AWS_MAX_ATTEMPTS: "1",
    };
    delete env.AWS_PROFILE;
    delete env.AWS_DEFAULT_PROFILE;

    const r = await runAwsCall({
      service: "sts",
      operation: "get-caller-identity",
      command: process.execPath,
      prefixArgs: [FAKE_AWS],
      timeoutMs: 30_000,
      omitProfile: true,
      env,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const { argv, env: childEnv } = r.data as { argv: string[]; env: Record<string, unknown> };
    assert.equal(childEnv.credsPresent, true, "the caller's credentials must still reach the child");
    assert.equal(childEnv.AWS_MAX_ATTEMPTS, "1", "PINNED_CLI_ENV must not take the single-attempt guarantee away");
    assert.equal(childEnv.AWS_CLI_ERROR_FORMAT, "enhanced");
    assert.equal(childEnv.PYTHONUTF8, "1");
    assert.ok(!argv.includes("--profile"), "omitProfile still keeps the flag off argv");
  });

  it("classifies a rejected credential that the caller's error format would have hidden", async () => {
    // The fake prints the classifiable ("enhanced") body only when it sees the
    // pin, and the json body otherwise -- the precedence the real 2.34.3 shows.
    // So this fails as `nonzero_exit` with no suggestion the moment the pin
    // stops being passed, which is the failure users with `cli_error_format =
    // json` in ~/.aws/config get today.
    const r = await runAwsCall({
      service: "sts",
      operation: "get-caller-identity",
      ...fakeOpts("spawn-hardening_error_format", { env: { AWS_CLI_ERROR_FORMAT: "json" } }),
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "invalid_creds", `stderr was: ${r.rawStderr}`);
    assert.match(r.error, /rejected by AWS/);
  });
});

describe("spawn-hardening: --cli-binary-format on calls that carry params", () => {
  it("pins base64 once, right before --cli-input-json, leaving the output/profile/region block contiguous", async () => {
    const r = await runAwsCall({
      service: "kms",
      operation: "encrypt",
      params: { KeyId: "alias/k", Plaintext: "aGVsbG8=" },
      profile: "prod",
      region: "eu-west-1",
      ...fakeOpts("call_echo_args"),
    });
    assert.equal(r.ok, true, r.ok ? "" : `${r.kind}: ${r.error}`);
    if (!r.ok) return;
    const { argv } = r.data as { argv: string[] };
    assert.equal(argv.filter((a) => a === "--cli-binary-format").length, 1, "exactly once");
    const at = argv.indexOf("--cli-binary-format");
    assert.equal(argv[at + 1], "base64");
    assert.equal(at, argv.indexOf("--cli-input-json") - 2, "immediately before the payload");
    // The block several fake scenarios and lambdaOutfileFromArgv index into has
    // to stay exactly as it was.
    const out = argv.indexOf("--output");
    assert.deepEqual(argv.slice(out, out + 6), ["--output", "json", "--profile", "prod", "--region", "eu-west-1"]);
  });

  it("leaves a call without params alone, so AWS CLI v1 and every no-params call are untouched", async () => {
    // v1 has no --cli-binary-format at all, so pinning it on every call would
    // turn "unsupported but mostly working" into "nothing works".
    const r = await runAwsCall({
      service: "sts",
      operation: "get-caller-identity",
      ...fakeOpts("call_echo_args"),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const { argv } = r.data as { argv: string[] };
    assert.ok(!argv.includes("--cli-binary-format"));
  });
});

describe("spawn-hardening: params too long for a command line", () => {
  // café-日本-😀: a cp1252 character, a CJK one and an astral one, which is what
  // caught the first attempt at this -- a plain UTF-8 temp file reached the
  // endpoint as cafÃ©-æ—¥æœ¬-ðŸ˜€ because the CLI reads a file:// param in the
  // locale code page.
  const UNICODE_VALUE = "café-日本-😀";

  it("passes small params inline, exactly as before", async () => {
    const r = await runAwsCall({
      service: "dynamodb",
      operation: "put-item",
      params: { TableName: "t", Item: { pk: { S: UNICODE_VALUE } } },
      ...fakeOpts("spawn-hardening_read_input_file"),
    });
    assert.equal(r.ok, true, r.ok ? "" : `${r.kind}: ${r.error}`);
    if (!r.ok) return;
    const data = r.data as { viaFile: boolean; binaryFormat: string | null; params: { Item: { pk: { S: string } } } };
    assert.equal(data.viaFile, false);
    assert.equal(data.params.Item.pk.S, UNICODE_VALUE);
    assert.equal(data.binaryFormat, "base64", "the blob pin rides with the inline payload");
  });

  it("sends params over the inline cap through a private ASCII-only temp file, and removes it", async () => {
    // 51,200 bytes is a real CloudFormation template body, so this size is not a
    // synthetic edge: before the temp file it was unsendable on Windows, with an
    // error blaming PATH.
    const params = { TableName: "t", Item: { pk: { S: UNICODE_VALUE }, blob: { S: "x".repeat(12_000) } } };
    const json = JSON.stringify(params);
    assert.ok(json.length > INLINE_CLI_INPUT_JSON_MAX_CHARS, "the test payload must exceed the inline cap");

    const r = await runAwsCall({
      service: "dynamodb",
      operation: "put-item",
      params,
      ...fakeOpts("spawn-hardening_read_input_file"),
    });

    // On a filesystem that ignores chmod, the call is SUPPOSED to refuse: this
    // payload can hold credentials or a SecureString, and the 0600 the privacy
    // rests on is unavailable there. Asserting the refusal rather than skipping
    // means the guard has real coverage on exactly the machines that need it,
    // and a contributor whose TMPDIR points into a Windows drive sees a green
    // suite describing the behaviour instead of a red one they have to diagnose.
    if (tmpdirIgnoresModes()) {
      assert.equal(r.ok, false, "a mode-ignoring temp dir must not yield a successful private-file call");
      if (r.ok) return;
      assert.equal(r.kind, "spawn_failure");
      assert.match(r.error, /does not honour file modes/);
      assert.match(r.error, /TMPDIR/, "the message has to name the variable the operator can change");
      return;
    }

    assert.equal(r.ok, true, r.ok ? "" : `${r.kind}: ${r.error}`);
    if (!r.ok) return;
    const data = r.data as {
      viaFile: boolean;
      path: string;
      asciiOnly: boolean;
      mode: number | null;
      binaryFormat: string | null;
      params: typeof params;
    };
    assert.equal(data.viaFile, true, "a payload this size must not be on the command line");
    assert.equal(data.binaryFormat, "base64", "and it rides with the file transport too");
    assert.equal(data.asciiOnly, true, "the file has to be ASCII-only or the CLI decodes it in the code page");
    assert.deepEqual(data.params, params, "and it still has to parse back to exactly what was asked for");
    if (process.platform !== "win32") assert.equal(data.mode, 0o600);
    // Gone by the time the promise settles -- the CLI read it at startup.
    assert.equal(existsSync(dirname(data.path)), false, "the temp directory must not outlive the call");
    // The display string is the inline form either way, so no temp path leaks
    // into `command` and the redaction stub still reports the payload's length.
    assert.ok(!r.command.includes("file://"), r.command);
    assert.ok(r.command.includes(`<redacted len=${json.length}>`), r.command);
  });

  it("calls an argv value that still will not fit bad_input, naming the flag", async () => {
    // Only extraFlags can reach this now: CCAPI passes its payloads as dedicated
    // flags rather than through --cli-input-json. 40,000 chars throws
    // ENAMETOOLONG synchronously on Windows (measured); Linux caps a single
    // argument at 131,072, so it needs more.
    const size = process.platform === "win32" ? 40_000 : 3 * 1024 * 1024;
    const r = await runAwsCall({
      service: "cloudcontrol",
      operation: "create-resource",
      extraFlags: ["--desired-state", "x".repeat(size)],
      ...fakeOpts("call_echo_args"),
    });
    assert.equal(r.ok, false, r.ok ? "the OS accepted an argv this long; raise `size`" : "");
    if (r.ok) return;
    assert.equal(r.kind, "bad_input", `error was: ${r.error}`);
    assert.match(r.error, /too large to pass to the AWS CLI/);
    assert.match(r.error, /--desired-state/, "the message has to name which value is too long");
    assert.doesNotMatch(r.error, /on PATH/, "the old message sent readers to debug a PATH that was fine");
  });

  it("does not time out at once when timeoutMs is above a 32-bit timer", async () => {
    // node stores a timer delay in a signed 32-bit int: 2**31 + 1000 warns
    // (TimeoutOverflowWarning) and fires after 1 ms, so this call used to come
    // back as a timeout immediately. Measured on node 22.22.2.
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      ...fakeOpts("call_json_success", { timeoutMs: 2 ** 31 + 1000 }),
    });
    assert.equal(r.ok, true, r.ok ? "" : `${r.kind}: ${r.error}`);
  });
});

describe("spawn-hardening: which binary runs", () => {
  /**
   * A directory holding an `aws.exe` (win32) or `aws` (POSIX) that is really
   * this Node -- a hard link where the filesystem allows one, a copy otherwise
   * -- so spawning it with the fake's path as argv[1] behaves like the fake CLI.
   * That is what makes "which binary did we run" observable: the fake echoes
   * process.execPath back.
   */
  function plantNode(prefix: string): { dir: string; binary: string } {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    const binary = join(dir, process.platform === "win32" ? "aws.exe" : "aws");
    try {
      linkSync(process.execPath, binary);
    } catch {
      copyFileSync(process.execPath, binary);
      if (process.platform !== "win32") chmodSync(binary, 0o755);
    }
    return { dir, binary };
  }

  /**
   * Run `fn` with the two environment variables that would otherwise decide the
   * spawn for us removed, and put them back afterwards:
   *   - NoDefaultCurrentDirectoryInExePath, because libuv reads it from the
   *     PARENT's environment and this harness runs with it set, so leaving it in
   *     place would let a reverted bare spawn pass the planted-cwd test;
   *   - AWS_MCP_TEST_AWS_COMMAND, because it is an explicit command and would
   *     skip resolution entirely.
   */
  async function withoutSpawnOverrides(fn: () => Promise<void>): Promise<void> {
    const saved = {
      noDefault: process.env.NoDefaultCurrentDirectoryInExePath,
      testCommand: process.env.AWS_MCP_TEST_AWS_COMMAND,
    };
    delete process.env.NoDefaultCurrentDirectoryInExePath;
    delete process.env.AWS_MCP_TEST_AWS_COMMAND;
    try {
      await fn();
    } finally {
      if (saved.noDefault === undefined) delete process.env.NoDefaultCurrentDirectoryInExePath;
      else process.env.NoDefaultCurrentDirectoryInExePath = saved.noDefault;
      if (saved.testCommand === undefined) delete process.env.AWS_MCP_TEST_AWS_COMMAND;
      else process.env.AWS_MCP_TEST_AWS_COMMAND = saved.testCommand;
    }
  }

  it("runs the aws on PATH, not one planted in the working directory", async () => {
    // The regression test for the planting vector: on Windows a bare
    // spawn("aws") searches the working directory before PATH, and that
    // directory belongs to the MCP host. Reproduced on Node 22.22.2 before the
    // resolver landed -- the planted binary ran and its made-up JSON came back
    // as a successful aws_call. Kept on every platform: POSIX has the same shape
    // through an empty or "." PATH entry, and the assertion is the same.
    const plant = plantNode("aws-mcp-plant-");
    const legit = plantNode("aws-mcp-legit-");
    const cwd = process.cwd();
    try {
      await withoutSpawnOverrides(async () => {
        process.chdir(plant.dir);
        const r = await runAwsCall({
          service: "sts",
          operation: "get-caller-identity",
          prefixArgs: [FAKE_AWS],
          timeoutMs: 30_000,
          // undefined counts as unset. Without this the case is not hermetic:
          // an ambient AWS_MCP_AWS_CLI is an explicit command, so the resolver
          // honours it ahead of the PATH planted here and the operator's real
          // CLI runs with FAKE_AWS as argv[1].
          env: {
            ...process.env,
            PATH: legit.dir,
            AWS_MCP_FAKE_SCENARIO: "spawn-hardening_echo_env",
            AWS_MCP_AWS_CLI: undefined,
          },
        });
        assert.equal(r.ok, true, r.ok ? "" : `${r.kind}: ${r.error}`);
        if (!r.ok) return;
        const { execPath } = r.data as { execPath: string };
        assert.equal(execPath, legit.binary, "the binary that ran must be the one on PATH");
        assert.notEqual(execPath, plant.binary);
      });
    } finally {
      process.chdir(cwd);
      rmSync(plant.dir, { recursive: true, force: true });
      rmSync(legit.dir, { recursive: true, force: true });
    }
  });

  it("spawns nothing and says how to fix it when no CLI can be found", async () => {
    const empty = mkdtempSync(join(tmpdir(), "aws-mcp-nopath-"));
    try {
      await withoutSpawnOverrides(async () => {
        const r = await runAwsCall({
          service: "sts",
          operation: "get-caller-identity",
          // undefined counts as unset, so this also covers a machine where the
          // developer really has the override set.
          env: { ...process.env, PATH: empty, AWS_MCP_AWS_CLI: undefined },
        });
        assert.equal(r.ok, false);
        if (r.ok) return;
        assert.equal(r.kind, "spawn_failure");
        assert.match(r.error, /AWS_MCP_AWS_CLI/, "the message has to name the override");
        assert.match(r.error, /working directory is never searched/);
        // The envelope, not the clock: the resolver failed before any argv was
        // assembled, so there is no invocation to show. A bare-name fallback would
        // have spawned something and put its display string here. This file's own
        // budgets (fakeOpts, FLUSH_BEFORE_TIMEOUT_BUDGETS_MS) document multi-second
        // scheduler stalls under a parallel `node --test`, so a wall-clock bound on
        // "nothing ran" would go red on a build where resolution worked perfectly.
        assert.equal(r.command, undefined, "a resolver failure assembles no invocation, so nothing was spawned");
      });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("honors AWS_MCP_AWS_CLI, and refuses an unusable one instead of falling back", async () => {
    const override = plantNode("aws-mcp-override-");
    const onPath = plantNode("aws-mcp-onpath-");
    try {
      await withoutSpawnOverrides(async () => {
        const ok = await runAwsCall({
          service: "sts",
          operation: "get-caller-identity",
          prefixArgs: [FAKE_AWS],
          timeoutMs: 30_000,
          env: {
            ...process.env,
            PATH: onPath.dir,
            AWS_MCP_AWS_CLI: override.binary,
            AWS_MCP_FAKE_SCENARIO: "spawn-hardening_echo_env",
          },
        });
        assert.equal(ok.ok, true, ok.ok ? "" : `${ok.kind}: ${ok.error}`);
        if (!ok.ok) return;
        assert.equal((ok.data as { execPath: string }).execPath, override.binary, "the override beats PATH");
        // The absolute path is not what the reader needs to see; `aws` is.
        assert.match(ok.command, /^aws /);

        // A relative value is the shape a user most easily gets wrong, and the
        // whole point of the loud failure is that it does NOT quietly run the
        // perfectly good CLI sitting on PATH instead.
        const bad = await runAwsCall({
          service: "sts",
          operation: "get-caller-identity",
          prefixArgs: [FAKE_AWS],
          env: { ...process.env, PATH: onPath.dir, AWS_MCP_AWS_CLI: "relative/aws" },
        });
        assert.equal(bad.ok, false);
        if (bad.ok) return;
        assert.equal(bad.kind, "spawn_failure");
        assert.match(bad.error, /AWS_MCP_AWS_CLI must be an absolute path/);
      });
    } finally {
      rmSync(override.dir, { recursive: true, force: true });
      rmSync(onPath.dir, { recursive: true, force: true });
    }
  });
});

describe("runAwsCall — invalid_creds: credentials resolved and the service refused them", () => {
  // classifyAuthError has recognized this kind for a while, and errors.test.ts
  // covers the regexes in isolation -- but no stderr shape carrying one of
  // these three codes had ever travelled through runAwsCall, so the branch that
  // builds the rotated-key / clock-drift message had never executed. Its three
  // sibling kinds (sso_expired / expired_creds / no_creds) each had one.
  //
  // The distinction being pinned is against no_creds, not against nonzero_exit:
  // no_creds means nothing resolved ("check ~/.aws/config and
  // ~/.aws/credentials"), invalid_creds means something resolved and AWS
  // rejected it -- rotate the key, fix the partition, or fix the clock. Telling
  // a user with a deleted access key to check that their credentials file
  // exists sends them looking at the one thing that is fine.

  const CASES: Array<{ scenario: string; code: string; operation: string }> = [
    {
      scenario: "awscli2_invalid_creds_unrecognized_client",
      code: "UnrecognizedClientException",
      operation: "ListBuckets",
    },
    {
      scenario: "awscli2_invalid_creds_client_token_id",
      code: "InvalidClientTokenId",
      operation: "GetCallerIdentity",
    },
    {
      scenario: "awscli2_invalid_creds_signature_mismatch",
      code: "SignatureDoesNotMatch",
      operation: "ListObjectsV2",
    },
  ];

  for (const { scenario, code, operation } of CASES) {
    it(`classifies ${code} as invalid_creds, naming the rotated-key cause and keeping the stderr`, async () => {
      const r = await runAwsCall({
        service: "s3api",
        operation: "list-buckets",
        profile: "rotated-prof",
        ...fakeOpts(scenario),
      });
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.equal(r.kind, "invalid_creds", `${code} must not fall through to nonzero_exit`);
      // The message identifies WHICH profile was refused...
      assert.match(r.error, /rotated-prof/);
      // ...says the credentials resolved and were rejected, rather than missing...
      assert.match(r.error, /rejected by AWS/);
      // ...and names the two causes that actually explain this class: a
      // deleted/rotated access key, and a drifted clock breaking SigV4.
      assert.match(r.error, /rotated/);
      assert.match(r.error, /clock/);
      // The underlying stderr is preserved -- the service's own text carries the
      // detail (which operation, and for SignatureDoesNotMatch the two
      // timestamps that make the drift diagnosable).
      assert.match(r.error, new RegExp(`Underlying error: An error occurred \\(${code}\\)`));
      assert.match(r.error, new RegExp(operation));
      assert.match(r.rawStderr ?? "", new RegExp(code));
      assert.equal(r.exitCode, 255);
      // The wrong-advice regression: no_creds's message must not appear.
      assert.doesNotMatch(r.error, /No credentials found/);
      assert.doesNotMatch(r.error, /~\/\.aws\/credentials/);
    });
  }

  it("keeps a genuine no-creds stderr on no_creds (the neighbouring kind is unaffected)", async () => {
    // Guard against over-correcting the classifier in the other direction: the
    // two kinds share a remedy shape ("your credentials are the problem") and
    // differ in which remedy, so a regex loosened to catch more invalid_creds
    // must not start swallowing this.
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
});

describe("runAwsCall — a descendant holding the stdio pipes must not hang the call", () => {
  // Regression guard for the unbounded settle. 'close' is the right NORMAL
  // settle (it is the only event that guarantees the pipes have been drained),
  // but it fires when the LAST writer on those pipes goes away -- and `aws ssm
  // start-session` / `aws ecs execute-command` hand off to
  // session-manager-plugin with the stdio inherited. When runAwsCall depended on
  // 'close' alone, such a call stayed pending forever, past its own timeoutMs.
  // Both cases below hang without the pipe-close grace in aws-cli.ts.
  //
  // The fake spawns its orphan with detached:true deliberately -- see the note
  // on the scenarios in testing/fake-aws.ts. A plainly-spawned grandchild is
  // killed with its parent by libuv's job object on Windows, which masks the bug
  // and makes both of these pass vacuously.

  const PENDING = Symbol("still-pending");

  /** Resolve to PENDING if `p` has not settled within `ms`, so a hang fails the
   * assertion instead of hanging the test runner until its own timeout. */
  async function settleWithin<T>(p: Promise<T>, ms: number): Promise<T | typeof PENDING> {
    let timer: NodeJS.Timeout | undefined;
    const guard = new Promise<typeof PENDING>((resolve) => {
      timer = setTimeout(() => resolve(PENDING), ms);
    });
    try {
      return await Promise.race([p, guard]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  function orphanOpts(scenario: string, timeoutMs: number, extraEnv: NodeJS.ProcessEnv = {}) {
    const pidPath = join(tmpdir(), `aws-mcp-orphan-${process.pid}-${randomUUID()}.pid`);
    return {
      pidPath,
      opts: {
        command: process.execPath,
        prefixArgs: [FAKE_AWS],
        timeoutMs,
        env: {
          ...process.env,
          AWS_MCP_FAKE_SCENARIO: scenario,
          AWS_MCP_FAKE_ORPHAN_PID_OUT: pidPath,
          ...extraEnv,
        },
      },
    };
  }

  /** The orphan is by construction beyond runAwsCall's reach -- that is the
   * whole bug -- so the TEST reaps it. Left running it keeps the parent's pipes,
   * and therefore this file's event loop, pinned open for its full hold. */
  function reapOrphan(pidPath: string): void {
    try {
      const pid = Number(readFileSync(pidPath, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) process.kill(pid);
    } catch {
      // Already gone, or the fake never got far enough to write its pid.
    }
    rmSync(pidPath, { force: true });
  }

  it("settles kind='timeout' when the child is killed but an orphan keeps the pipes open", async (t) => {
    // Path (a): we outlive timeoutMs, so the timeout callback kills us and then
    // waits. killProc guarantees the CHILD exits; it says nothing about a
    // descendant holding the pipes, so 'close' never arrives.
    //
    // The premise needs the fake to have spawned its orphan AND flushed its
    // fragment before the kill, and with timeoutMs fixed at 2000ms that lost
    // to the fake's cold start in all 8 runs with the CPU oversubscribed.
    // runWithFlushBeforeTimeout only asserts on a run where the fake confirmed
    // both happened first.
    //
    // A discarded attempt needs one more guard here than in the partial-stdout
    // test, because this fake spawns a detached orphan. libuv creates a detached
    // child suspended and resumes it right after (CREATE_SUSPENDED, then
    // ResumeThread -- src/win/process.c), so a kill that lands between the two
    // leaves a process that never runs, never writes its pid, can never be
    // reaped, and holds this file's pipes open forever. Seen once in 26 attempts
    // at a 2000ms budget with the CPU saturated: every test passed, yet the file
    // process was still running 280s later.
    //
    // So each attempt hands the fake a wall-clock deadline half a budget before
    // the earliest possible kill (runAwsCall starts its timer after this line),
    // and past it the fake skips the orphan and just hangs -- no spawn for the
    // kill to interrupt, no ready file, attempt discarded. The 10s first budget
    // only keeps discards rare: each one costs a whole budget.
    const r = await runWithFlushBeforeTimeout(t, [10_000, 30_000], async (timeoutMs, readyPath) => {
      // After the kill, runAwsCall arms a KILL_ESCALATION_MS + 2s window and
      // shortens it to 2s once the child is reaped, so a correct call settles
      // ~2-4s past timeoutMs. 30s leaves room for a starved machine; a hang
      // still fails, because the orphan outlives the bound.
      const settleBoundMs = timeoutMs + 30_000;
      const { opts, pidPath } = orphanOpts("awscli_orphan_holds_pipes", timeoutMs, {
        AWS_MCP_FAKE_READY_OUT: readyPath,
        AWS_MCP_FAKE_ORPHAN_HOLD_MS: String(settleBoundMs + 10_000),
        AWS_MCP_FAKE_ORPHAN_SPAWN_BEFORE: String(Date.now() + timeoutMs / 2),
      });
      try {
        const settled = await settleWithin(
          runAwsCall({ service: "ssm", operation: "start-session", ...opts }),
          settleBoundMs,
        );
        if (settled === PENDING) {
          return assert.fail(
            "runAwsCall never settled: the orphan still holds the stdio pipes so 'close' cannot fire, and nothing bounds the wait",
          );
        }
        return settled;
      } finally {
        reapOrphan(pidPath);
      }
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "timeout");
    assert.match(r.error, /timed out/);
    // Buffered bytes still reach the caller when the fallback settles rather
    // than 'close' -- the flush is in the shared finish path, not in 'close'.
    assert.match(
      r.rawStdout ?? "",
      /emitted-before-the-orphan-hang/,
      "stdout read before the kill must survive the fallback settle",
    );
  });

  it("settles with the natural result when the child exits cleanly but an orphan keeps the pipes open", async () => {
    // Path (b), the worse one: we exit 0 long before timeoutMs. The timeout
    // callback's procHasExited() guard then returns early and never attempts a
    // kill at all, so before the grace existed nothing bounded this AT ALL -- it
    // hung past a timeout it could never trip.
    //
    // Three deadlines, ordered so a pass can only come from the grace the 'exit'
    // listener arms (child exit + 2s): the settle bound, then timeoutMs (where a
    // grace armed only by the timeout callback would settle), then the orphan's
    // own death (where 'close' would finally fire). The bound was 12s against a
    // 20s timeoutMs, and it flaked: with the CPU saturated the fake alone took
    // up to 6.7s to start and exit, so a correct runAwsCall missed 12s about 1
    // run in 5. The margins are now wide, and the ordering is what still gates.
    const settleBoundMs = 60_000;
    const timeoutMs = 120_000;
    const { opts, pidPath } = orphanOpts("awscli_orphan_outlives_exit", timeoutMs, {
      AWS_MCP_FAKE_ORPHAN_HOLD_MS: "180000",
    });
    const started = Date.now();
    try {
      const r = await settleWithin(runAwsCall({ service: "s3api", operation: "list-buckets", ...opts }), settleBoundMs);
      if (r === PENDING) {
        assert.fail("runAwsCall never settled after a clean child exit with the pipes held open by an orphan");
      }
      const elapsed = Date.now() - started;
      assert.ok(
        elapsed < timeoutMs,
        `must settle from the pipe-close grace, well before timeoutMs; took ${elapsed}ms of ${timeoutMs}ms`,
      );
      // The natural result, not a synthesized timeout: the child really did
      // succeed, and the payload really did arrive.
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.deepEqual(r.data, { orphan: "outlived-a-clean-exit" });
    } finally {
      reapOrphan(pidPath);
    }
  });
});

describe("commandArgv: the unambiguous form of the display command", () => {
  // `command` cannot be correct in every shell -- measured 0 of 24 probes in
  // cmd.exe, where `&`, `|` and a newline are live whatever the quoting, and the
  // Windows quoting fix makes a single-quoted value arrive wrong in Git Bash.
  // `commandArgv` is the answer to all of that: the exact tokens, so a consumer
  // re-quotes for its own shell and never unpicks the string.

  it("is the exact argv, and `command` is that argv quoted", async () => {
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      query: "Buckets[].Name",
      ...fakeOpts("call_json_success"),
    });
    assert.equal(r.ok, true, r.ok ? "" : `${r.kind}: ${r.error}`);
    if (!r.ok) return;

    // Entry 0 is the binary as displayed; the rest are one argument per entry,
    // unquoted. No entry may carry the shell quoting the string form adds.
    assert.ok(Array.isArray(r.commandArgv), "commandArgv must be an array");
    // Entry 0 is the binary AS DISPLAYED, which is the literal `aws` for a
    // resolved or overridden CLI and the real path for a test seam -- these tests
    // drive the fake through prefixArgs, so it is node here. The invariant worth
    // asserting is that it is the same head the string form shows, not a literal.
    assert.ok(r.commandArgv.length > 1 && r.commandArgv[0].length > 0, JSON.stringify(r.commandArgv));
    assert.ok(r.command.startsWith(shellQuoteArg(r.commandArgv[0])), r.command);
    assert.ok(r.commandArgv.includes("s3api"), r.commandArgv.join(" "));
    assert.ok(r.commandArgv.includes("list-buckets"));
    assert.ok(r.commandArgv.includes("Buckets[].Name"), "the query is one entry, unquoted");
    assert.ok(
      !r.commandArgv.some((entry) => entry.startsWith("'") && entry.endsWith("'") && entry.length > 1),
      `no entry may be shell-quoted: ${JSON.stringify(r.commandArgv)}`,
    );

    // And the string is exactly that array, quoted per entry -- derived from it,
    // so the two cannot drift apart.
    assert.equal(r.command, r.commandArgv.map((entry) => shellQuoteArg(entry)).join(" "));
  });

  it("keeps a cmd.exe metacharacter inside ONE entry, which is what retires the injection", async () => {
    // The F2 case: `--query 'x & echo PWNED_CMD'` printed PWNED_CMD when the
    // string form was pasted into cmd.exe, because single quotes do not quote
    // there. In argv form it is one element and there is nothing to re-parse.
    const hostile = "x & echo PWNED_CMD | more ^caret";
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      query: hostile,
      ...fakeOpts("call_json_success"),
    });
    assert.equal(r.ok, true, r.ok ? "" : `${r.kind}: ${r.error}`);
    if (!r.ok) return;
    assert.equal(
      r.commandArgv.filter((entry) => entry === hostile).length,
      1,
      `the whole value must be exactly one entry: ${JSON.stringify(r.commandArgv)}`,
    );
  });

  it("carries a single-quoted JMESPath exactly, which the string form cannot on Windows", async () => {
    // The F3 case: on Windows `command` quotes for PowerShell, so Git Bash reads
    // 'a''b' as concatenation and Buckets[?Name=='prod'].Name arrives as
    // Buckets[?Name==prod].Name -- a different, invalid expression. The argv is
    // unaffected, and this is the commonest non-trivial --query shape.
    const query = "Buckets[?Name=='prod'].Name";
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      query,
      ...fakeOpts("call_json_success"),
    });
    assert.equal(r.ok, true, r.ok ? "" : `${r.kind}: ${r.error}`);
    if (!r.ok) return;
    assert.ok(r.commandArgv.includes(query), `the quotes must survive: ${JSON.stringify(r.commandArgv)}`);
  });

  it("carries backslashes exactly, which fish's single quotes do not", async () => {
    // The F7 case: fish treats \ and \' as escapes inside single quotes, so
    // a\b arrived as a\b -- silent corruption in the one POSIX shell the string
    // form is wrong for. argv is byte-exact.
    const value = "C:logsa\\b";
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      query: value,
      ...fakeOpts("call_json_success"),
    });
    assert.equal(r.ok, true, r.ok ? "" : `${r.kind}: ${r.error}`);
    if (!r.ok) return;
    assert.ok(r.commandArgv.includes(value), `backslashes must survive: ${JSON.stringify(r.commandArgv)}`);
  });

  it("redacts in the argv exactly as in the string, so neither form leaks", async () => {
    // The redaction is applied once, to the array, and the string is rendered
    // from it -- so a secret cannot be scrubbed from one and not the other.
    const r = await runAwsCall({
      service: "secretsmanager",
      operation: "create-secret",
      params: { Name: "n", SecretString: "hunter2-secret" },
      ...fakeOpts("call_json_success"),
    });
    assert.equal(r.ok, true, r.ok ? "" : `${r.kind}: ${r.error}`);
    if (!r.ok) return;
    assert.ok(
      !r.commandArgv.some((entry) => entry.includes("hunter2-secret")),
      `the secret must not be in the argv: ${JSON.stringify(r.commandArgv)}`,
    );
    assert.ok(!r.command.includes("hunter2-secret"));
    assert.ok(
      r.commandArgv.some((entry) => /^<redacted len=\d+>$/.test(entry)),
      `the stub must be its own entry: ${JSON.stringify(r.commandArgv)}`,
    );
  });

  it("is present on a failure whenever the string is", async () => {
    // Both are absent only on a failure that never built an argv. Once a call
    // has spawned, a consumer inspecting the failure gets the same two forms.
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      ...fakeOpts("call_nonzero_exit"),
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(
      r.command === undefined,
      r.commandArgv === undefined,
      "command and commandArgv must be present or absent together",
    );
    if (r.command === undefined || r.commandArgv === undefined) return;
    assert.equal(r.command, r.commandArgv.map((entry) => shellQuoteArg(entry)).join(" "));
  });
});
