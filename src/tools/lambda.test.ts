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
import { platform, tmpdir } from "node:os";
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

describe("aws_lambda_invoke — declared annotations", () => {
  it("declares a destructive, non-idempotent, open-world tool", () => {
    // This tool executes SOMEBODY ELSE'S CODE, and destructiveHint is the field
    // an MCP client's auto-approve policy reads to decide whether to run it
    // without asking. The source carries a 15-line comment ending "and it must
    // stay that way"; this is what actually holds it there. deepEqual on the
    // WHOLE object rather than four separate asserts, so an added-and-wrong
    // sixth field fails too.
    assert.deepEqual(tool.annotations, {
      title: "Invoke a Lambda function",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  });
});

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

  it("rejects an empty or over-long qualifier", async () => {
    // Both are reachable from a plain MCP client: the schema is
    // z.string().optional() with no .min(1)/.max(128), so this handler-level
    // guard is the only thing standing between a caller and an argv entry that
    // is either empty or 129+ chars.
    for (const qualifier of ["", "a".repeat(129)]) {
      const r = (await tool.handler({ functionName: "fn", qualifier })) as InvokeResult;
      assert.equal(r.ok, false, `accepted a ${qualifier.length}-char qualifier`);
      assert.match(r.error ?? "", /must be 1-128 characters/);
      assert.equal(r.errorKind, undefined);
    }
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
    // `?.length` rather than a bare cast: if `data` were ever absent the cast
    // form throws a TypeError from inside the assertion, which reads as a test
    // harness crash instead of the clean "expected 262144, got undefined".
    assert.equal((r.data?.payload as string | undefined)?.length, 256 * 1024);
  });

  it("clips an oversized MULTI-BYTE response by byte, not by character", async () => {
    // The cap is a CONTEXT budget, so it has to be enforced in bytes. On the
    // all-ASCII body above a byte cut and a character cut are indistinguishable
    // -- this body is 100k three-byte characters, where they differ by ~3x.
    //
    // A "cleanup" to raw.toString("utf8").slice(0, MAX) would cut by UTF-16
    // unit and let ~300 KB through, blowing the budget the cap exists to
    // enforce while still reporting payloadTruncated: true.
    process.env.AWS_MCP_FAKE_SCENARIO = "lam2_invoke_multibyte_large_response";
    const r = (await tool.handler({ functionName: "my-fn" })) as InvokeResult;
    assert.equal(r.ok, true);
    assert.equal(r.data?.payloadTruncated, true);
    assert.equal(typeof r.data?.payload, "string");
    const payload = r.data?.payload as string;

    // The two numbers together are the proof. Bytes: at most the cap plus the
    // 2 extra bytes a single U+FFFD costs over the one dangling byte it
    // replaces -- the documented tail a byte cut leaves on a split sequence.
    assert.ok(
      Buffer.byteLength(payload, "utf8") <= 256 * 1024 + 2,
      `byte length ${Buffer.byteLength(payload, "utf8")} exceeds the 256 KB cap (+U+FFFD tail)`,
    );
    // Characters: roughly a third of the cap, because each one cost 3 bytes. A
    // character cut would have kept every one of the body's 100011 chars.
    assert.ok(payload.length < 90_000, `payload is ${payload.length} chars -- looks cut by character, not by byte`);
    // ...and it really was clipped, not just short.
    assert.ok(payload.length > 80_000, `payload is only ${payload.length} chars`);
  });

  it("accepts a qualifier and functionName sitting exactly on their length maxima", async () => {
    // The accepting half of the two length guards above. Without it a `>=`
    // typo in either bound would reject a legal value and no test would notice.
    process.env.AWS_MCP_FAKE_SCENARIO = "lambda_invoke_success";
    const maxQualifier = (await tool.handler({
      functionName: "my-fn",
      qualifier: "a".repeat(128),
    })) as InvokeResult;
    assert.equal(maxQualifier.ok, true, `rejected a 128-char qualifier: ${maxQualifier.error}`);
    const maxName = (await tool.handler({ functionName: "a".repeat(170) })) as InvokeResult;
    assert.equal(maxName.ok, true, `rejected a 170-char functionName: ${maxName.error}`);
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

  function readEcho(): {
    argv: string[];
    payloadFile: string | null;
    dirMode: number | null;
    outfileMode: number | null;
    payloadFileMode: number | null;
  } {
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

  it("omits --qualifier entirely when no qualifier was given", async () => {
    await tool.handler({ functionName: "my-fn" });
    const { argv } = readEcho();
    // Pushing the flag unconditionally would send the literal string
    // "undefined", which Lambda resolves as an ALIAS NAME -- so the call either
    // fails confusingly or, if such an alias exists, runs a DIFFERENT VERSION
    // of the function than the caller asked for. Same negative assertion
    // --payload already carries above.
    assert.equal(argv.includes("--qualifier"), false);
  });

  it("mints the scratch dir 0700 and both temp files 0600 (skipped on Windows)", async () => {
    // Observed from INSIDE the fake, because the handler's finally block
    // removes the whole directory before it returns -- there is no moment in
    // which the parent could stat these. The dir's 0700 is the load-bearing
    // bit; the two 0600s are the defense-in-depth layer under it that keeps
    // the files private if the directory mode ever regresses.
    //
    // Both files can carry customer data: the outfile holds the Lambda RESPONSE
    // BODY and the payload file holds the inbound EVENT. Dropping the 0o600
    // argument, or relaxing "wx" to "w" (which looks like a harmless
    // simplification, since the file is new either way), lands the response at
    // umask-default 0644 -- world-readable on any shared host or CI runner for
    // the life of the invocation.
    if (platform() === "win32") return;
    const r = (await tool.handler({ functionName: "my-fn", payload: { k: 1 } })) as InvokeResult;
    assert.equal(r.ok, true);
    const { dirMode, outfileMode, payloadFileMode } = readEcho();
    assert.equal(dirMode, 0o700, `expected dir 0700, got ${dirMode?.toString(8)}`);
    assert.equal(outfileMode, 0o600, `expected outfile 0600, got ${outfileMode?.toString(8)}`);
    assert.equal(payloadFileMode, 0o600, `expected payload file 0600, got ${payloadFileMode?.toString(8)}`);
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

  it("leaves nothing behind when runAwsCall rejects BEFORE any spawn", async () => {
    // Structurally distinct from the four paths above, which all involve a
    // spawn attempt. Here the scratch dir and BOTH temp files (the payload
    // argument is what forces the second one) already exist when runAwsCall
    // rejects the argv-unsafe value and returns without spawning anything --
    // so a cleanup that ever moved out of the finally and into the post-spawn
    // code would leak a directory per call while all four tests above still
    // passed.
    //
    // Reachable without malformed tool input, too: profile and region are
    // resolved from session state and the AWS_PROFILE / AWS_REGION env vars, so
    // a malformed operator shell sends every invoke down this branch.
    for (const [override, pattern] of [
      [{ region: "--evil" }, /Invalid region/],
      [{ profile: "--evil" }, /Invalid profile name/],
    ] as const) {
      const before = lambdaTmpDirs();
      const r = (await tool.handler({
        functionName: "my-fn",
        payload: { k: 1 },
        ...override,
      })) as InvokeResult;
      assert.equal(r.ok, false);
      assert.equal(r.errorKind, "bad_input");
      assert.equal(r.data, undefined);
      assert.match(r.error ?? "", pattern);
      assert.deepEqual(lambdaTmpDirs(), before);
    }
  });
});

describe("aws_lambda_invoke — concurrent invokes stay isolated", () => {
  beforeEach(() => {
    process.env.AWS_MCP_TEST_AWS_COMMAND = process.execPath;
    process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS = JSON.stringify([FAKE_AWS]);
    process.env.AWS_MCP_FAKE_SCENARIO = "lam2_invoke_echo_payload";
    _resetSession();
  });

  afterEach(() => {
    delete process.env.AWS_MCP_TEST_AWS_COMMAND;
    delete process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS;
    delete process.env.AWS_MCP_FAKE_SCENARIO;
    _resetSession();
  });

  it("gives each in-flight call its OWN response body, and neither cleanup takes the other's dir", async () => {
    // The MCP SDK dispatches tool calls concurrently -- index.ts awaits the
    // handler with no serialization -- so two in-flight invokes are ordinary,
    // not a corner case. mkdtempSync is atomic and today's code is correct;
    // this is what holds it there. A refactor to a fixed
    // `tmpdir()/aws-mcp-lambda/response.json`, or to the `Date.now()`-suffixed
    // name the source comment explicitly warns against, would make caller A
    // read caller B's response body -- customer data crossing between two
    // unrelated invocations, silently, with ok:true on both.
    const before = lambdaTmpDirs();
    const [a, b] = (await Promise.all([
      tool.handler({ functionName: "fn-a", payload: { id: "A" } }),
      tool.handler({ functionName: "fn-b", payload: { id: "B" } }),
    ])) as [InvokeResult, InvokeResult];

    assert.equal(a.ok, true, `call A failed: ${a.error}`);
    assert.equal(b.ok, true, `call B failed: ${b.error}`);
    // The fake echoes the fileb:// payload it was handed straight into its own
    // outfile, so each result's payload is a fingerprint of which scratch dir
    // the handler read back.
    assert.deepEqual(a.data?.payload, { id: "A" });
    assert.deepEqual(b.data?.payload, { id: "B" });
    // Both cleanups ran and neither removed the other's directory -- a shared
    // path would show up here as a leftover or as an rmSync that lost a race.
    assert.deepEqual(lambdaTmpDirs(), before);
  });
});
