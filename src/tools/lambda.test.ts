/**
 * Handler + subprocess tests for aws_lambda_invoke (tools/lambda.ts).
 *
 * The tool's contract has three halves that a stdout-only fake would not
 * exercise, so all of them are driven through the real subprocess path at the
 * fake aws binary:
 *   - the METADATA envelope on stdout (StatusCode / FunctionError / LogResult),
 *   - the response BODY, which arrives in a positional outfile the handler
 *     mints and reads itself, and
 *   - the temp-directory lifecycle, which has to survive the failure paths too.
 *
 * Routing is via the documented AWS_MCP_TEST_AWS_COMMAND /
 * AWS_MCP_TEST_AWS_PREFIX_ARGS knobs (aws-cli.ts) rather than a per-call
 * command/prefixArgs override, because this handler deliberately exposes no
 * such knob -- doing so would put argv injection on the MCP surface.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { _resetSession } from "../session.js";
import { lambdaTools } from "./lambda.js";

const tool = lambdaTools.find((t) => t.name === "aws_lambda_invoke");
if (!tool) throw new Error("lambdaTools missing aws_lambda_invoke");

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AWS = join(__dirname, "..", "testing", "fake-aws.js");

/**
 * The handler's own scratch directories, by the prefix mkdtempSync is given.
 *
 * Used as a before/after set comparison rather than a bare count so an
 * unrelated leftover from a previous run cannot turn into a false failure. Safe
 * against interference from sibling test FILES because nothing else in the
 * suite creates this prefix, and node:test runs the subtests within one file
 * sequentially.
 */
function lambdaTmpDirs(): string[] {
  return readdirSync(tmpdir())
    .filter((n) => n.startsWith("aws-mcp-lambda-"))
    .sort();
}

type InvokeData = {
  command?: string;
  statusCode?: number;
  functionError?: string;
  executedVersion?: string;
  payload?: unknown;
  logTail?: string;
  payloadTruncated?: boolean;
};
type InvokeResult = { ok: boolean; data?: InvokeData; error?: string; errorKind?: string; rawBody?: string };

let counter = 0;

describe("aws_lambda_invoke — input validation (no subprocess)", () => {
  // These reject before any spawn, so they need no fake wiring at all. That is
  // itself part of the contract: a bad functionName must never reach argv.

  it("rejects a missing functionName", async () => {
    const r = (await tool.handler({})) as InvokeResult;
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /functionName is required/);
    // An input-validation failure holds no classified kind from aws-cli.ts, so
    // errorKind must stay ABSENT rather than be invented. See ToolResult.
    assert.equal(r.errorKind, undefined);
  });

  it("rejects a functionName that would pose as a flag", async () => {
    const r = (await tool.handler({ functionName: "--profile evil" })) as InvokeResult;
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid functionName/);
  });

  it("rejects a functionName past the 170-char ARN maximum", async () => {
    const r = (await tool.handler({ functionName: "a".repeat(171) })) as InvokeResult;
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /170-char maximum/);
  });

  it("rejects a qualifier that would pose as a flag", async () => {
    const r = (await tool.handler({ functionName: "fn", qualifier: "-x" })) as InvokeResult;
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid qualifier/);
  });

  it("rejects a non-RequestResponse invocationType with a message naming the scope decision", async () => {
    const r = (await tool.handler({ functionName: "fn", invocationType: "Event" })) as InvokeResult;
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /only 'RequestResponse'/i);
  });
});

describe("aws_lambda_invoke — result shaping (via fake-aws subprocess)", () => {
  beforeEach(() => {
    process.env.AWS_MCP_TEST_AWS_COMMAND = process.execPath;
    process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS = JSON.stringify([FAKE_AWS]);
    _resetSession();
  });

  afterEach(() => {
    delete process.env.AWS_MCP_TEST_AWS_COMMAND;
    delete process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS;
    delete process.env.AWS_MCP_FAKE_SCENARIO;
    delete process.env.AWS_MCP_FAKE_ARGV_OUT;
    _resetSession();
  });

  it("returns the parsed outfile body, the decoded log tail, and the metadata", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "lambda_invoke_success";
    const r = (await tool.handler({ functionName: "my-fn", payload: { k: 1 } })) as InvokeResult;
    assert.equal(r.ok, true);
    // The BODY comes from the outfile, not stdout -- this is the assertion that
    // fails if the outfile plumbing regresses.
    assert.deepEqual(r.data?.payload, { ok: true, greeting: "hello" });
    assert.equal(r.data?.statusCode, 200);
    assert.equal(r.data?.executedVersion, "$LATEST");
    assert.equal(r.data?.functionError, undefined);
    assert.equal(r.data?.payloadTruncated, undefined);
    // logTail must be DECODED text, not the base64 the API sends. This is the
    // tool's differentiator, so it is asserted on content rather than presence.
    assert.match(r.data?.logTail ?? "", /hello from the handler/);
    assert.doesNotMatch(r.data?.logTail ?? "", /^[A-Za-z0-9+/=]+$/);
    assert.match(r.data?.command ?? "", /lambda/);
    assert.match(r.data?.command ?? "", /invoke/);
  });

  it("reports a thrown handler as ok:true with functionError set, keeping payload and logTail", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "lambda_invoke_function_error";
    const r = (await tool.handler({ functionName: "my-fn" })) as InvokeResult;
    // The deliberate call: the INVOCATION succeeded, the function's code threw.
    // The CLI exits 0 here, so ok:false would be a failure no layer observed --
    // and would drop the two fields that explain the throw.
    assert.equal(r.ok, true);
    assert.equal(r.data?.functionError, "Unhandled");
    assert.equal(r.data?.statusCode, 200);
    assert.deepEqual((r.data?.payload as { errorMessage?: string })?.errorMessage, "boom");
    assert.match(r.data?.logTail ?? "", /hello from the handler/);
  });

  it("surfaces a service failure as ok:false with the classified kind and stderr", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "lambda_invoke_not_found";
    const r = (await tool.handler({ functionName: "missing-fn" })) as InvokeResult;
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, "nonzero_exit");
    assert.match(r.error ?? "", /ResourceNotFoundException/);
    assert.match(r.rawBody ?? "", /Function not found/);
  });

  it("maps an empty outfile to a null payload", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "lambda_invoke_empty_response";
    const r = (await tool.handler({ functionName: "my-fn" })) as InvokeResult;
    assert.equal(r.ok, true);
    assert.equal(r.data?.payload, null);
  });

  it("keeps a non-JSON response body as text instead of failing the call", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "lambda_invoke_nonjson_response";
    const r = (await tool.handler({ functionName: "my-fn" })) as InvokeResult;
    assert.equal(r.ok, true);
    assert.equal(r.data?.payload, "plain text, not JSON");
  });

  it("accepts all four legal functionName forms", async () => {
    // Wired at the fake deliberately: these names PASS validation, so an
    // unwired handler call would spawn the real `aws` binary against whatever
    // credentials the machine happens to have.
    process.env.AWS_MCP_FAKE_SCENARIO = "lambda_invoke_success";
    for (const name of [
      "my-function",
      "my-function:PROD",
      "123456789012:function:my-fn",
      "arn:aws:lambda:us-east-1:123456789012:function:my-fn",
    ]) {
      const r = (await tool.handler({ functionName: name })) as InvokeResult;
      assert.equal(r.ok, true, `rejected ${name}: ${r.error}`);
    }
  });

  it("clips an oversized response and flags it rather than parsing a clipped document", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "lambda_invoke_large_response";
    const r = (await tool.handler({ functionName: "my-fn" })) as InvokeResult;
    assert.equal(r.ok, true);
    assert.equal(r.data?.payloadTruncated, true);
    // Text, not an object: a clipped JSON document cannot parse, and blaming the
    // function for our own cap would be the wrong diagnosis.
    assert.equal(typeof r.data?.payload, "string");
    assert.equal((r.data?.payload as string).length, 256 * 1024);
  });
});

describe("aws_lambda_invoke — argv construction (via fake-aws echo)", () => {
  let argvOut: string;

  beforeEach(() => {
    process.env.AWS_MCP_TEST_AWS_COMMAND = process.execPath;
    process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS = JSON.stringify([FAKE_AWS]);
    process.env.AWS_MCP_FAKE_SCENARIO = "lambda_invoke_echo_argv";
    argvOut = join(tmpdir(), `aws-mcp-lambda-argv-${process.pid}-${counter++}.json`);
    process.env.AWS_MCP_FAKE_ARGV_OUT = argvOut;
    _resetSession();
  });

  afterEach(() => {
    delete process.env.AWS_MCP_TEST_AWS_COMMAND;
    delete process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS;
    delete process.env.AWS_MCP_FAKE_SCENARIO;
    delete process.env.AWS_MCP_FAKE_ARGV_OUT;
    rmSync(argvOut, { force: true });
    _resetSession();
  });

  function readEcho(): { argv: string[]; payloadFile: string | null } {
    return JSON.parse(readFileSync(argvOut, "utf8"));
  }

  it("sends function name, qualifier, Tail logs and RequestResponse, with the outfile before --output", async () => {
    const r = (await tool.handler({
      functionName: "my-fn",
      qualifier: "PROD",
      payload: { hello: "world" },
    })) as InvokeResult;
    assert.equal(r.ok, true);
    const { argv } = readEcho();

    assert.deepEqual(argv.slice(0, 2), ["lambda", "invoke"]);
    assert.equal(argv[argv.indexOf("--function-name") + 1], "my-fn");
    assert.equal(argv[argv.indexOf("--qualifier") + 1], "PROD");
    assert.equal(argv[argv.indexOf("--log-type") + 1], "Tail");
    assert.equal(argv[argv.indexOf("--invocation-type") + 1], "RequestResponse");

    // The outfile is a bare POSITIONAL, and it has to sit directly before the
    // --output that runAwsCall appends. This is the whole reason aws_call cannot
    // express this operation, so it gets a direct assertion.
    const outputIdx = argv.indexOf("--output");
    assert.ok(outputIdx > 0);
    const outfile = argv[outputIdx - 1];
    assert.doesNotMatch(outfile, /^--/, "outfile must be a positional, not a flag");
    assert.match(outfile, /aws-mcp-lambda-/);
  });

  it("passes the payload by file reference, and the file holds the encoded event", async () => {
    await tool.handler({ functionName: "my-fn", payload: { hello: "world" } });
    const { argv, payloadFile } = readEcho();
    const ref = argv[argv.indexOf("--payload") + 1];
    // fileb:// (raw bytes), never an inline value: an inline --payload would be
    // echoed to the model in `command` unredacted, would break past the Windows
    // 32 KB command-line cap, and would require --cli-binary-format to carry
    // raw JSON at all.
    assert.match(ref, /^fileb:\/\//);
    assert.equal(payloadFile, JSON.stringify({ hello: "world" }));
  });

  it("omits --payload entirely when no payload was given", async () => {
    await tool.handler({ functionName: "my-fn" });
    const { argv, payloadFile } = readEcho();
    // Not an empty object: a function taking no input should receive no payload
    // rather than `{}`, which is a different event.
    assert.equal(argv.includes("--payload"), false);
    assert.equal(payloadFile, null);
  });

  it("keeps the payload out of the command string returned to the model", async () => {
    const r = (await tool.handler({
      functionName: "my-fn",
      payload: { password: "hunter2-should-not-leak" },
    })) as InvokeResult;
    // The file-reference design means there is nothing to redact -- the secret
    // never enters argv in the first place.
    assert.doesNotMatch(r.data?.command ?? "", /hunter2/);
  });
});

describe("aws_lambda_invoke — temp files are cleaned up on every path", () => {
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

  it("leaves nothing behind on the success path", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "lambda_invoke_success";
    const before = lambdaTmpDirs();
    const r = (await tool.handler({ functionName: "my-fn", payload: { k: 1 } })) as InvokeResult;
    assert.equal(r.ok, true);
    assert.deepEqual(lambdaTmpDirs(), before);
  });

  it("leaves nothing behind on a nonzero-exit failure", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "lambda_invoke_not_found";
    const before = lambdaTmpDirs();
    const r = (await tool.handler({ functionName: "missing-fn" })) as InvokeResult;
    assert.equal(r.ok, false);
    assert.deepEqual(lambdaTmpDirs(), before);
  });

  it("leaves nothing behind on the TIMEOUT path", async () => {
    // The scenario never exits and never writes the outfile, so runAwsCall's
    // timeout branch is what settles the call. runAwsCall RESOLVES its envelope
    // rather than rejecting, so the handler's finally block still runs -- that
    // is the property under test.
    process.env.AWS_MCP_FAKE_SCENARIO = "lambda_invoke_hang";
    const before = lambdaTmpDirs();
    const r = (await tool.handler({ functionName: "my-fn", timeoutMs: 300 })) as InvokeResult;
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, "timeout");
    assert.deepEqual(lambdaTmpDirs(), before);
  });

  it("leaves nothing behind on the SPAWN-ERROR path", async () => {
    // No such binary -> ENOENT on the async 'error' event -> spawn_failure. The
    // temp dir was already minted by then, so this is the path where a cleanup
    // that lived only on the happy branch would leak.
    process.env.AWS_MCP_TEST_AWS_COMMAND = join(__dirname, "no-such-aws-binary-xyz");
    process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS = JSON.stringify([]);
    const before = lambdaTmpDirs();
    const r = (await tool.handler({ functionName: "my-fn", payload: { k: 1 } })) as InvokeResult;
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, "spawn_failure");
    assert.deepEqual(lambdaTmpDirs(), before);
  });
});
