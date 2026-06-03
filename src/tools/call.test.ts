import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { _resetSession } from "../session.js";
import { callTools } from "./call.js";

// Direct handler-level tests for aws_call (src/tools/call.ts:55-91). The two
// branches under test are the post-runAwsCall envelope shaping:
//   - success  -> { ok: true,  data: { command, result } }
//   - failure  -> { ok: false, error, rawBody: rawStderr ?? rawStdout }
//
// The handler calls runAwsCall directly and exposes no command/prefixArgs knob
// (that would surface argv injection through the MCP surface), so we route the
// subprocess at the fake aws shim via the documented test env-var hook
// (AWS_MCP_TEST_AWS_COMMAND / AWS_MCP_TEST_AWS_PREFIX_ARGS, see aws-cli.ts).
// Same pattern paginate.test.ts and multi-region.test.ts use.

const tool = callTools.find((t) => t.name === "aws_call");
if (!tool) throw new Error("callTools missing aws_call");

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AWS = join(__dirname, "..", "testing", "fake-aws.js");

describe("aws_call handler — success envelope vs rawBody fallback (fake-aws)", () => {
  beforeEach(() => {
    process.env.AWS_MCP_TEST_AWS_COMMAND = process.execPath;
    process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS = JSON.stringify([FAKE_AWS]);
    _resetSession();
  });

  afterEach(() => {
    delete process.env.AWS_MCP_TEST_AWS_COMMAND;
    delete process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS;
    delete process.env.AWS_MCP_FAKE_SCENARIO;
    _resetSession();
  });

  // --- success branch: { ok:true, data: { command, result } } ---

  it("wraps a JSON success in { command, result } with the parsed payload", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "call_json_success";
    const r = (await tool.handler({ service: "s3api", operation: "list-buckets" })) as {
      ok: boolean;
      data?: { command?: string; result?: unknown };
    };
    assert.equal(r.ok, true);
    // The success envelope nests the parsed JSON under `result` and the literal
    // command under `command` — not the bare runAwsCall data shape.
    assert.deepEqual(r.data?.result, {
      Buckets: [
        { Name: "bucket-1", CreationDate: "2024-01-01T00:00:00.000Z" },
        { Name: "bucket-2", CreationDate: "2024-02-01T00:00:00.000Z" },
      ],
      Owner: { DisplayName: "me", ID: "abc123" },
    });
    // command is the redacted display string runAwsCall assembled; it must name
    // the service + operation that were dispatched.
    assert.equal(typeof r.data?.command, "string");
    assert.match(r.data?.command ?? "", /s3api/);
    assert.match(r.data?.command ?? "", /list-buckets/);
  });

  it("passes through a null result on an empty-stdout success (put-/tag- style ops)", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "call_empty_success";
    const r = (await tool.handler({ service: "iam", operation: "tag-role" })) as {
      ok: boolean;
      data?: { command?: string; result?: unknown };
    };
    assert.equal(r.ok, true);
    // runAwsCall returns data:null for empty stdout; the handler nests it verbatim.
    assert.equal(r.data?.result, null);
    assert.match(r.data?.command ?? "", /tag-role/);
  });

  it("preserves a plain scalar string when --query extracts a non-JSON value", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "call_nonjson_success";
    const r = (await tool.handler({ service: "s3api", operation: "list-buckets", query: "Buckets[0].Name" })) as {
      ok: boolean;
      data?: { result?: unknown };
    };
    assert.equal(r.ok, true);
    // runAwsCall falls back to the trimmed text when JSON.parse fails; the
    // handler surfaces that string as `result`.
    assert.equal(r.data?.result, "some-plain-string");
  });

  // --- failure branch: { ok:false, error, rawBody: rawStderr ?? rawStdout } ---

  it("on a nonzero exit returns ok:false with rawBody set to the stderr blob", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "call_access_denied";
    const r = (await tool.handler({ service: "s3api", operation: "list-buckets" })) as {
      ok: boolean;
      error?: string;
      rawBody?: string;
      data?: unknown;
    };
    assert.equal(r.ok, false);
    // No success envelope on failure.
    assert.equal(r.data, undefined);
    assert.match(r.error ?? "", /Access Denied/);
    // rawBody is the rawStderr half of `rawStderr ?? rawStdout` — the fake
    // wrote the AccessDenied line to stderr.
    assert.match(r.rawBody ?? "", /AccessDenied/);
    assert.match(r.rawBody ?? "", /ListBuckets/);
  });

  it("surfaces the classified SSO-expiry error and stderr rawBody on an expired token", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "call_sso_expired";
    const r = (await tool.handler({ service: "sts", operation: "get-caller-identity", profile: "my-profile" })) as {
      ok: boolean;
      error?: string;
      rawBody?: string;
    };
    assert.equal(r.ok, false);
    // The handler passes runAwsCall's already-classified sso_expired error text
    // through unchanged — same hint aws_whoami surfaces.
    assert.match(r.error ?? "", /SSO session expired/);
    assert.match(r.error ?? "", /my-profile/);
    assert.match(r.error ?? "", /aws_login_start/);
    // The underlying stderr is still preserved in rawBody for diagnosis.
    assert.match(r.rawBody ?? "", /Error loading SSO Token/);
  });

  it("surfaces the classified no-creds error and stderr rawBody", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "call_no_creds";
    const r = (await tool.handler({ service: "s3api", operation: "list-buckets", profile: "my-profile" })) as {
      ok: boolean;
      error?: string;
      rawBody?: string;
    };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /No credentials found/);
    assert.match(r.error ?? "", /my-profile/);
    assert.match(r.rawBody ?? "", /Unable to locate credentials/);
  });

  it("rawBody is the EMPTY stderr (not stdout) on a stdout-only nonzero exit — `??` does not fall through on ''", async () => {
    // Documents the REAL behavior of `rawBody: result.rawStderr ?? result.rawStdout`.
    // On any nonzero exit runAwsCall sets BOTH rawStdout and rawStderr, and
    // rawStderr is a STRING (possibly empty), never undefined. Because `??`
    // only falls back on null/undefined — not on '' — an empty rawStderr
    // short-circuits and rawBody becomes '' even though stdout had content.
    //
    // Practical consequence: the `?? result.rawStdout` operand is effectively
    // dead for the nonzero_exit/timeout shapes (they always supply a string
    // rawStderr). It would only fire on a failure shape that leaves rawStderr
    // strictly undefined while populating rawStdout — and no current runAwsCall
    // branch does that (spawn_failure sets neither; output_too_large sets
    // rawStderr only). Flagged as a finding; the test pins the observed shape.
    process.env.AWS_MCP_FAKE_SCENARIO = "call_fail_stdout_only";
    const r = (await tool.handler({ service: "s3api", operation: "list-buckets" })) as {
      ok: boolean;
      error?: string;
      rawBody?: string;
    };
    assert.equal(r.ok, false);
    // The generic nonzero-exit error text is the stderr trim (empty) -> the
    // "no stderr" fallback message from aws-cli.ts.
    assert.match(r.error ?? "", /aws CLI exited with code 1 and no stderr/);
    // rawBody resolves to the empty rawStderr string, NOT the stdout content.
    assert.equal(r.rawBody, "");
  });

  // --- bad_input short-circuit (runAwsCall returns before spawning) ---

  it("returns ok:false with undefined rawBody when validation fails before any subprocess", async () => {
    // An invalid (flag-shaped) service makes runAwsCall bail with kind:bad_input
    // and NO rawStdout/rawStderr, so the handler's `rawStderr ?? rawStdout`
    // resolves to undefined. The fake is never spawned.
    const r = (await tool.handler({ service: "--evil", operation: "list-buckets" })) as {
      ok: boolean;
      error?: string;
      rawBody?: string;
    };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid service/);
    assert.equal(r.rawBody, undefined);
  });
});
