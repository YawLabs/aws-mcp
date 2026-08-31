/**
 * Subprocess integration tests for runAwsCall. Spawns a real child process
 * (no mocking) pointed at the fake aws binary at dist/testing/fake-aws.js.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

  it("preserves partial stdout when a timeout kills a subprocess mid-stream", async () => {
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
    // timeoutMs is still deliberately roomy and must NOT be tuned back down.
    // The remaining requirement is unchanged: the fake has to get its write
    // out before our timeout kills it, so the budget has to cover Node's cold
    // start and module load. At 200ms that failed roughly 1 run in 6 under a
    // parallel full-suite run (`node --test` runs files across all cores),
    // surfacing as an empty rawStdout. Anything comfortably between
    // startup+50ms and the fake's 10s hang works.
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      ...fakeOpts("call_partial_then_hang", { timeoutMs: 2000 }),
    });
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

  function orphanOpts(scenario: string, timeoutMs: number) {
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

  it("settles kind='timeout' when the child is killed but an orphan keeps the pipes open", async () => {
    // Path (a): we outlive timeoutMs, so the timeout callback kills us and then
    // waits. killProc guarantees the CHILD exits; it says nothing about a
    // descendant holding the pipes, so 'close' never arrives.
    const { opts, pidPath } = orphanOpts("awscli_orphan_holds_pipes", 2000);
    try {
      const r = await settleWithin(runAwsCall({ service: "ssm", operation: "start-session", ...opts }), 15_000);
      if (r === PENDING) {
        assert.fail(
          "runAwsCall never settled: the orphan still holds the stdio pipes so 'close' cannot fire, and nothing bounds the wait",
        );
      }
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
    } finally {
      reapOrphan(pidPath);
    }
  });

  it("settles with the natural result when the child exits cleanly but an orphan keeps the pipes open", async () => {
    // Path (b), the worse one: we exit 0 long before timeoutMs. The timeout
    // callback's procHasExited() guard then returns early and never attempts a
    // kill at all, so before the grace existed nothing bounded this AT ALL -- it
    // hung past a timeout it could never trip. timeoutMs is deliberately long so
    // that a pass here cannot be coming from the timeout path.
    const timeoutMs = 20_000;
    const { opts, pidPath } = orphanOpts("awscli_orphan_outlives_exit", timeoutMs);
    const started = Date.now();
    try {
      const r = await settleWithin(runAwsCall({ service: "s3api", operation: "list-buckets", ...opts }), 12_000);
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
