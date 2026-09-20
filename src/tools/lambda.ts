/**
 * Synchronous Lambda invocation (`aws lambda invoke`).
 *
 * WHY THIS TOOL EXISTS -- i.e. why aws_call cannot do it.
 *
 * `aws lambda invoke` is one of the AWS CLI's CUSTOMIZED commands, and it
 * breaks the two assumptions aws_call is built on. Both were verified against
 * aws-cli/2.34.3 rather than inferred from the docs:
 *
 *   1. It takes the response body as a REQUIRED POSITIONAL outfile. aws_call
 *      reaches argv only through `service` + `operation`, and every operation
 *      token is checked against SAFE_NAME_RE (`/^[a-z0-9][a-z0-9-]*$/`,
 *      aws-cli.ts:59). So `operation: "invoke out.json"` is rejected on the
 *      token `out.json` before anything spawns, with a kebab-case complaint
 *      that gives the caller nowhere to go.
 *
 *   2. It does not accept `--cli-input-json` AT ALL. That flag is the ONLY
 *      channel aws_call has for operation parameters, so even if the outfile
 *      could be smuggled past SAFE_NAME_RE there would still be no way to send
 *      FunctionName or Payload. The real CLI answers with
 *      `Unknown options: --cli-input-json, {...}`, and `--generate-cli-skeleton`
 *      is rejected the same way; `aws s3api list-objects --cli-input-json ...`
 *      accepts it in the same shell, which is what isolates this to the
 *      `invoke` customization rather than to our argv assembly.
 *
 * Those are independent blockers, so this is a structural gap in aws_call, not
 * a rough edge a better-phrased call could route around.
 *
 * SCOPE. This is deliberately NOT the first of fifteen data-plane tools. The
 * qualifying test is narrow: the CLI's required positional outfile makes the
 * operation UNREACHABLE through aws_call. Lambda invoke and S3 GetObject pass
 * that test; DynamoDB GetItem does not (it is an ordinary
 * `--cli-input-json` operation aws_call already handles). Anything that aws_call
 * can express, however awkwardly, does not belong here.
 *
 * RETRIES AND TIMEOUTS. The invoke is sent AT MOST ONCE, because a CLI retry of
 * an Invoke that already reached Lambda runs the function again -- and the
 * function is somebody else's code. The child gets AWS_MAX_ATTEMPTS=1
 * (invokeChildEnv), which also overrides a `max_attempts` in the caller's
 * profile. Verified against a stubbed Lambda endpoint on aws-cli 2.34.3: a 70 s
 * function with timeoutMs 200000 received THREE Invoke POSTs 60 s apart on the
 * CLI's defaults -- five with `max_attempts = 5` -- and the call still came back
 * with no payload and no log tail after 183 s.
 *
 * `timeoutMs` is how long to wait for the FUNCTION, and three timers hang off
 * it (invokeTimeouts): the CLI's own --cli-read-timeout gets
 * INVOKE_RESPONSE_SLACK_S more, and our kill sits INVOKE_CLI_GRACE_MS behind
 * that as a backstop. The CLI therefore reports first on a real hang, which is
 * what makes the failure legible.
 *
 * One property of the CLI shapes that failure path: --cli-read-timeout also
 * bounds the CLI's CREDENTIAL calls, so a read timeout does NOT by itself prove
 * the invoke was sent. A `role_arn` profile whose STS endpoint accepts the
 * connection and never answers produces the identical `Read timeout on endpoint
 * URL` text with ZERO Invoke requests (verified on 2.34.3 and 2.22.0). The
 * failure branch reads the URL out of that message instead of assuming the
 * function ran.
 *
 * DEFERRED, explicitly and with intent:
 *   - `InvocationType: "Event"` (async fire-and-forget). It returns 202 with no
 *     payload and no logs, so it shares almost nothing with the code below and
 *     wants its own result contract.
 *   - `InvocationType: "DryRun"` (permission check only). aws_iam_simulate
 *     covers the identity-policy half (it wraps simulate-principal-policy and
 *     never fetches the function's resource-based policy), and nothing else here
 *     needs a DryRun.
 *   - `--client-context`. Base64 client metadata for mobile SDK callers; no
 *     demand from an MCP context.
 *   - The aws_script bridge binding. Registering this tool for in-process
 *     scripting is a separate change to tools/script.ts.
 */

import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runAwsCall } from "../aws-cli.js";
import { READ_TIMEOUT_RE } from "../errors.js";
import type { Tool, ToolContext, ToolResult } from "./tool.js";

/**
 * Cap on the response payload we read back out of the outfile.
 *
 * This is a CONTEXT budget, not an AWS limit -- Lambda allows a 6 MB
 * synchronous response, and runAwsCall's own 5 MB guard does not apply here
 * because the payload never travels over stdout; the CLI streams it straight
 * into the outfile and we read that file ourselves. Handing a model six
 * megabytes of JSON is worse than telling it the response was clipped, so we
 * clip and say so via `payloadTruncated`.
 */
const MAX_RESPONSE_PAYLOAD_BYTES = 256 * 1024;

/**
 * Argv-safety charset for `functionName`.
 *
 * Deliberately LOOSER than the service's own FunctionName pattern: AWS accepts
 * a bare name, `name:alias`, a partial ARN (`123456789012:function:name`), and
 * a full ARN, and encoding all four precisely here would mean re-implementing a
 * service-side regex that can change under us. The job of this check is only to
 * keep argv honest -- the characters below are exactly those the four accepted
 * forms use, so anything outside them is malformed regardless, and Lambda
 * itself returns a far better message for a name that is well-formed but wrong.
 *
 * The leading-hyphen rejection is the load-bearing half: without it a
 * `functionName` of `--profile evil` would land as its own argv entry and be
 * read by `aws` as a flag. Same defense logs.ts applies to its log-group
 * positional.
 */
const SAFE_FUNCTION_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9\-_.:$]*$/;
// Invoke's own FunctionName maximum (the 2.34.3 model and `aws lambda invoke
// help`), and 170 was wrong for longer than it looked: a full ARN is 47
// characters plus the name (up to 64), a colon, and the alias (up to 128), so a
// 64-character name with a 59-character alias was already refused here -- before
// anything spawned, with a length complaint rather than anything Lambda said. The
// CLI itself enforces no maximum: a 257-character name was sent.
const MAX_FUNCTION_NAME_LEN = 256;

/**
 * Version number or alias name. `$LATEST` is why `$` is in the class, and `.` is
 * for `$LATEST.PUBLISHED` -- the qualifier an unqualified invoke resolves to on
 * Lambda Managed Instances, which the CLI accepts (verified: sent as
 * `?Qualifier=%24LATEST.PUBLISHED`) and this pattern used to refuse.
 *
 * Deliberately looser than the service's own Qualifier pattern, the same
 * reasoning as SAFE_FUNCTION_NAME_RE above. NEVER add `:` or `/`: the CLI
 * replaces a `file://` or `fileb://` value with the contents of that local file
 * (verified on 2.34.3, which sent `?Qualifier=CONTENTS-OF-LOCAL-FILE`).
 * runAwsCall's central guard refuses such a value too -- lambda exempts only its
 * own payload path from it -- so this is the defense-in-depth layer under that,
 * not the only one.
 */
const SAFE_QUALIFIER_RE = /^[a-zA-Z0-9$][a-zA-Z0-9\-_.$]*$/;
const MAX_QUALIFIER_LEN = 128;

/** Matches the `timeoutMs` description and runAwsCall's own default. */
const DEFAULT_INVOKE_TIMEOUT_MS = 60_000;

/**
 * Lambda's synchronous ceiling, in seconds.
 *
 * A larger `timeoutMs` is silently treated as this rather than rejected: the
 * input schema accepts any positive integer today, so refusing one would be a
 * breaking input change for a value that cannot help. It also caps the timers
 * below well under the 2^31-1 ms a Node timer can express -- above that Node
 * fires the timer after 1 ms instead, which used to make a huge `timeoutMs`
 * time the call out immediately.
 *
 * The 90-minute Lambda Managed Instances timeout (2026-09-09) is for async and
 * event-source invocations; a synchronous invoke, durable ones included, still
 * stops at 15 minutes.
 */
const MAX_SYNC_INVOKE_S = 900;

/**
 * What the CLI is allowed beyond the caller's wait, as `--cli-read-timeout`.
 *
 * Sized for the on-demand Init phase: Lambda caps init at 10 s and does NOT
 * count it against the function's own timeout, so a cold function that hits
 * that timeout answers at up to init + timeout. With less slack a caller who
 * follows the `timeoutMs` description and sets it to the function's own timeout
 * would turn the function's "Task timed out" functionError -- with its log tail,
 * the reason this tool exists -- into a bare read timeout with nothing in it.
 */
const INVOKE_RESPONSE_SLACK_S = 10;

/**
 * Room between the CLI's read timeout and our kill, so the CLI reports first.
 *
 * It then exits on its own: no kill, so no Windows EBUSY on the outfile (see the
 * finally block), and its message names the URL that went unanswered. Sized for
 * CLI startup, measured at 0.9-1.8 s on this machine.
 */
const INVOKE_CLI_GRACE_MS = 5_000;

/**
 * The three timers one invoke runs on, derived from the caller's `timeoutMs`.
 *
 * Pure and exported for direct unit coverage: the RELATIONSHIP between them is
 * the fix for a function being invoked three times, and pinning it here is far
 * cheaper than waiting out real timers through a spawned call.
 *
 * A non-finite or non-positive value falls back to the default rather than
 * throwing -- the same defense-in-depth reasoning as the handler's own
 * validation below: the MCP layer rejects such a value, an in-process caller
 * does not.
 */
export function invokeTimeouts(timeoutMs: number | undefined): {
  waitS: number;
  readTimeoutS: number;
  spawnTimeoutMs: number;
} {
  const ms =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_INVOKE_TIMEOUT_MS;
  const waitS = Math.min(Math.ceil(ms / 1000), MAX_SYNC_INVOKE_S);
  // At least 1 + 10, so never 0: `--cli-read-timeout 0` means block forever,
  // which would leave the kill as the only bound and lose the URL the CLI's
  // message carries.
  const readTimeoutS = waitS + INVOKE_RESPONSE_SLACK_S;
  return { waitS, readTimeoutS, spawnTimeoutMs: readTimeoutS * 1000 + INVOKE_CLI_GRACE_MS };
}

/**
 * The child environment for one invoke: a copy of `base` with every spelling of
 * AWS_MAX_ATTEMPTS dropped and the variable set to "1".
 *
 * A whole copy, not a patch, because runAwsCall's `env` REPLACES the parent
 * environment rather than merging into it (node's spawn semantics; see
 * AwsCallOptions.env). The spread keeps everything else the call needs, the
 * fake-aws test knobs included.
 *
 * The variable beats `max_attempts` in the caller's ~/.aws/config -- verified on
 * 2.34.3 and 2.22.0, with a named profile and with [default], and under
 * `retry_mode = adaptive` -- which is the whole point: the profile belongs to the
 * user, and one that asks for five attempts would otherwise run the function
 * five times.
 *
 * Deleting the case-variants is load-bearing rather than tidy. Given both
 * AWS_MAX_ATTEMPTS and aws_max_attempts, Node 22.22.2 hands the child the
 * upper-case one while oam 0.16.2 -- the runtime the published command uses by
 * default -- hands it the LAST key in the object (measured both ways). So an
 * operator's lower-case spelling could win there, on the one setting that keeps
 * the function from running twice.
 */
export function invokeChildEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "AWS_MAX_ATTEMPTS") delete env[key];
  }
  env.AWS_MAX_ATTEMPTS = "1";
  return env;
}

/**
 * The Invoke request path as it appears in the CLI's read-timeout message:
 * `/2015-03-31/functions/<name>/invocations`, with `?Qualifier=...` appended
 * when a qualifier was passed. The name segment can be a URL-encoded ARN, so the
 * class excludes only what would end the segment or the URL itself.
 */
const INVOKE_PATH_RE = /\/functions\/[^/?#"\\\s]+\/invocations/;
/** Any URL on that line, so a pre-invoke timeout can name the endpoint. */
const ANY_URL_RE = /https?:\/\/[^"\\\s]+/;

/**
 * Test-only override for the backstop kill timer, honored only for a positive
 * integer (AWS_MCP_TEST_LAMBDA_SPAWN_TIMEOUT_MS).
 *
 * The backstop is reachable only when the CLI itself stalls, and with the
 * constants above that takes 16 s at the very shortest -- too long for a unit
 * test. The real-CLI suite needs the opposite: a very large value there
 * guarantees the CLI's own read timeout fires first, so those cases assert on
 * the CLI's message instead of racing it.
 *
 * Never set in production. Same AWS_MCP_TEST_ convention as aws-cli.ts's
 * command / prefix-args knobs, and a malformed value is ignored the same way
 * rather than wedging every invoke.
 */
function testSpawnTimeoutOverride(): number | undefined {
  const raw = process.env.AWS_MCP_TEST_LAMBDA_SPAWN_TIMEOUT_MS;
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * The `errorKind: "timeout"` envelope, in three flavors that differ only in what
 * they can honestly say about whether the invoke went out.
 *
 * All three are `timeout` rather than `nonzero_exit`, including the CLI's own
 * read timeout, which used to arrive as the latter. The condition is exactly
 * runAwsCall's `timeout` -- no answer in time -- so which clock fired first must
 * not change the kind a caller branches on.
 *
 * "unknown" is the conservative default, and that ordering is the point of the
 * whole branch: telling a model "not sent" about an invoke that WAS sent invites
 * a second run of somebody's function, so an unreadable message gets the
 * may-or-may-not wording instead.
 */
function invokeTimeoutFailure(o: {
  label: string;
  waitS: number;
  readTimeoutS: number;
  spawnTimeoutMs: number;
  outcome: "sent" | "not-sent" | "unknown";
  url?: string;
  rawBody: string;
  killed: boolean;
}): ToolResult {
  // Named once: two of the three flavors end in the same advice, because both
  // leave a function that may be running.
  const checkLogs = `Check the function's recent logs with aws_logs_tail (log group /aws/lambda/<function name> unless it sets a custom one) before invoking again; raise timeoutMs if the function's own timeout is longer than ${o.waitS}s (at most 900000).`;
  let message: string;
  let suggestion: string;
  if (o.outcome === "sent") {
    message = `No response from Lambda function '${o.label}' within ${o.readTimeoutS}s (timeoutMs ${o.waitS}s + ${INVOKE_RESPONSE_SLACK_S}s). The invoke was sent once and not retried, but Lambda does not stop a synchronous invocation when the caller stops waiting: the function may still be running, or may already have finished.`;
    suggestion = checkLogs;
  } else if (o.outcome === "not-sent") {
    message = `The AWS CLI got no response from ${o.url} within ${o.readTimeoutS}s while resolving credentials, before it sent the invoke. '${o.label}' was not invoked.`;
    suggestion =
      "Retrying is safe once that endpoint answers; for a role_arn profile it is the STS endpoint, for an SSO profile the SSO portal. Check network access and any proxy.";
  } else {
    const bound = o.killed ? `${o.spawnTimeoutMs / 1000}s and was stopped` : `${o.readTimeoutS}s`;
    message = `The AWS CLI did not finish invoking '${o.label}' within ${bound}. It most likely stalled before the invoke went out (resolving credentials, connecting, or uploading the payload), but the invoke may or may not have been sent. It was not sent more than once.`;
    suggestion = checkLogs;
  }
  return {
    ok: false,
    errorKind: "timeout",
    // Repeated at the end of `error` as well, which is the documented invariant
    // for this field: toMcpResult does not render `suggestion` separately, so a
    // remedy that lived only there would never reach the model.
    error: `${message}\n\nSuggestion: ${suggestion}`,
    suggestion,
    ...(o.rawBody ? { rawBody: o.rawBody } : {}),
  };
}

/**
 * Shape of the JSON `aws lambda invoke` writes to STDOUT. The response body
 * itself is NOT in here -- it goes to the outfile -- so this is metadata only.
 * Verified against a stubbed Lambda endpoint; a successful RequestResponse call
 * emits StatusCode + LogResult + ExecutedVersion, plus FunctionError when the
 * handler raised.
 */
interface InvokeStdout {
  StatusCode?: number;
  FunctionError?: string;
  LogResult?: string;
  ExecutedVersion?: string;
}

function isInvokeStdout(v: unknown): v is InvokeStdout {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Decode the `LogResult` header the CLI passes through verbatim.
 *
 * LogResult is a base64 STRING member of the Lambda API response, not a CLI
 * blob, so `--cli-binary-format` cannot change its encoding -- confirmed by
 * running the same invoke with and without `raw-in-base64-out` and getting
 * byte-identical base64 both times. That is why decoding is unconditional here
 * rather than contingent on how the CLI was configured.
 *
 * Bounded by the API, not by us: `LogType: "Tail"` returns at most the last
 * 4 KB of the execution log, so there is nothing to truncate.
 *
 * Returns undefined rather than throwing on undecodable input. Buffer.from with
 * "base64" never throws -- it silently drops invalid characters -- so the only
 * real failure mode is a missing field.
 */
function decodeLogTail(logResult: string | undefined): string | undefined {
  if (logResult === undefined || logResult.length === 0) return undefined;
  return Buffer.from(logResult, "base64").toString("utf8");
}

export const lambdaTools: readonly Tool[] = [
  {
    name: "aws_lambda_invoke",
    description:
      "Invoke a Lambda function synchronously (RequestResponse) and return its response payload plus the DECODED tail of its execution log in one call. Use this instead of aws_call for Lambda invokes: `aws lambda invoke` needs a positional output file and rejects --cli-input-json, so aws_call structurally cannot reach it. The returned `logTail` is the last ~4 KB of the function's own log output, already base64-decoded, which removes the usual invoke -> find the log group -> tail it -> hope the window caught it loop. Functions on Lambda Managed Instances do not support the log tail; read their logs with aws_logs_tail. IMPORTANT: a non-empty `functionError` means the function's HANDLER threw; the invocation itself still succeeded, so ok is true and the thrown error is in `payload`. The invoke is sent AT MOST ONCE: the AWS CLI's automatic retries are turned off here, because a retried invoke runs the function again. A TooManyRequestsException, or a connection that could not be opened, means nothing ran, so retrying is safe. On errorKind 'timeout' the error says whether the invoke was sent; if it was, or after a dropped connection or a 5xx, the function may have run and may still be running -- check its logs before invoking again.",
    annotations: {
      title: "Invoke a Lambda function",
      // destructiveHint: true, and it must stay that way.
      //
      // We are executing SOMEBODY ELSE'S CODE. The function body is entirely
      // opaque to this server -- it can drop a table, wire money, send mail, or
      // do nothing at all, and nothing in the arguments tells us which. Per the
      // MCP spec destructiveHint defaults to true and `false` positively
      // asserts "performs only additive updates", which is the single claim
      // this tool is least able to make. That is the same reasoning v2.0.1
      // applied to aws_call, aws_multi_region and aws_resource_update, and it
      // applies here with more force, not less: aws_call at least names the
      // operation it is about to run.
      //
      // idempotentHint is false for the same reason -- invoking twice runs the
      // side effects twice, whatever they are.
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      functionName: z
        .string()
        .describe(
          "Function name, name:alias, partial ARN ('123456789012:function:my-fn'), or full ARN. E.g. 'my-function', 'my-function:PROD'.",
        ),
      payload: z
        .unknown()
        .optional()
        .describe(
          "The event to pass to the function. Any JSON value (usually an object); it is JSON-encoded and sent as the request body. Omit for a function that takes no input — this sends no payload at all rather than an empty object.",
        ),
      qualifier: z
        .string()
        .optional()
        .describe(
          "Version number or alias to invoke, e.g. '3' or 'PROD'. Omit for the service default: $LATEST for a standard function, $LATEST.PUBLISHED for one on Lambda Managed Instances. Durable functions need an explicit qualifier (a version, an alias, or $LATEST).",
        ),
      invocationType: z
        .enum(["RequestResponse"])
        .optional()
        .describe(
          "Only 'RequestResponse' (synchronous) is supported. Async 'Event' and permission-check 'DryRun' are deliberately not implemented — 'Event' returns no payload or logs and needs its own result shape. For a pre-flight permission check, aws_iam_simulate evaluates the caller's identity policies but not the function's resource-based policy.",
        ),
      profile: z.string().optional().describe("Override session profile for this call."),
      region: z.string().optional().describe("Override session region for this call."),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "How long to wait for the function to respond, in milliseconds. Default 60000. Set it to at least the function's own configured timeout; a synchronous invoke runs at most 15 minutes, so values above 900000 are treated as 900000. The AWS CLI is allowed 10 s beyond this to cover a cold start, so a function that hits its own timeout still returns as a functionError with its log tail; a call that gets no answer at all fails with errorKind 'timeout' after at most timeoutMs + 15 s.",
        ),
    }),
    handler: async (input: unknown, ctx?: ToolContext): Promise<ToolResult> => {
      const i = input as {
        functionName: string;
        payload?: unknown;
        qualifier?: string;
        invocationType?: string;
        profile?: string;
        region?: string;
        timeoutMs?: number;
      };

      // Defense-in-depth on every branch below: the MCP layer validates against
      // inputSchema, but direct in-process callers (tests, and the aws_script
      // bridge if this tool is ever bound into it) bypass that entirely. Same
      // rationale as the handler-level clamps in logs.ts and paginate.ts.
      //
      // These return a bare { ok:false, error } with NO errorKind -- per the
      // ToolResult contract an absent errorKind means "unclassified", and a
      // handler rejecting its own input holds no kind from aws-cli.ts to report.
      if (typeof i.functionName !== "string" || i.functionName.length === 0) {
        return { ok: false, error: "functionName is required." };
      }
      if (i.functionName.length > MAX_FUNCTION_NAME_LEN) {
        return {
          ok: false,
          error: `Invalid functionName: ${i.functionName.length} chars exceeds the ${MAX_FUNCTION_NAME_LEN}-char maximum the Invoke API documents for FunctionName.`,
        };
      }
      if (!SAFE_FUNCTION_NAME_RE.test(i.functionName)) {
        return {
          ok: false,
          error: `Invalid functionName '${i.functionName}'. Use a name, name:alias, partial ARN, or full ARN — letters, digits, and - _ . : $ only, not starting with '-'.`,
        };
      }
      if (i.qualifier !== undefined) {
        if (i.qualifier.length === 0 || i.qualifier.length > MAX_QUALIFIER_LEN) {
          return {
            ok: false,
            error: `Invalid qualifier: must be 1-${MAX_QUALIFIER_LEN} characters.`,
          };
        }
        if (!SAFE_QUALIFIER_RE.test(i.qualifier)) {
          return {
            ok: false,
            error: `Invalid qualifier '${i.qualifier}'. Use a version number or alias name — letters, digits, and - _ . $ only, not starting with '-' or '.'.`,
          };
        }
      }
      if (i.invocationType !== undefined && i.invocationType !== "RequestResponse") {
        return {
          ok: false,
          error: `invocationType '${i.invocationType}' is not supported. Only 'RequestResponse' (synchronous) is implemented; 'Event' and 'DryRun' are deliberately out of scope.`,
        };
      }

      // Every timer for this call, settled before anything is created: the CLI's
      // read timeout goes on argv, the backstop goes to runAwsCall, and `waitS`
      // is what the caller asked for, named in the progress line and in every
      // timeout message.
      const { waitS, readTimeoutS, spawnTimeoutMs: computedSpawnMs } = invokeTimeouts(i.timeoutMs);
      const spawnTimeoutMs = testSpawnTimeoutOverride() ?? computedSpawnMs;
      const label = `${i.functionName}${i.qualifier ? `:${i.qualifier}` : ""}`;

      // One directory holds both temp files, so cleanup is a single rmSync.
      // mkdtempSync is atomic and collision-free, which a hand-rolled
      // `tmpdir()/prefix-${Date.now()}` is not, and it creates the directory
      // 0700 on POSIX. On Windows those mode bits are ignored, but os.tmpdir()
      // there is the per-user %LOCALAPPDATA%\Temp, so the containing directory
      // is already ACL'd to this user -- the confidentiality property holds on
      // both platforms, by different mechanisms.
      const dir = mkdtempSync(join(tmpdir(), "aws-mcp-lambda-"));
      try {
        // Pre-create the outfile 0600 with "wx" (exclusive), so that on POSIX
        // the response payload never briefly lands in a umask-default 0644
        // file: the CLI opens this path for writing and, because the file
        // already exists, open(2) ignores the mode argument and leaves ours in
        // place. Belt-and-braces given the 0700 parent above -- it is what keeps
        // the file itself private if the directory mode ever regresses.
        //
        // On a failed invoke the CLI writes nothing and this stays a 0-byte
        // file, which is fine: it is only read on the success path.
        const outPath = join(dir, "response.json");
        closeSync(openSync(outPath, "wx", 0o600));

        // The payload goes through a FILE (`--payload fileb://...`), not an
        // argv value, for three separate reasons:
        //
        //   1. Secrets. `--payload` is not in aws-cli.ts's REDACTED_VALUE_FLAGS,
        //      so an inline value would be echoed back to the model verbatim in
        //      `command`. A file path leaks nothing.
        //   2. Size. Lambda accepts a 6 MB synchronous payload; Windows caps a
        //      process command line at 32767 characters. Anything past ~32 KB
        //      inline simply fails to spawn.
        //   3. Encoding. An inline `--payload` is base64-decoded by AWS CLI v2
        //      and needs `--cli-binary-format raw-in-base64-out` to accept raw
        //      JSON (without it the CLI answers `Invalid base64`). `fileb://`
        //      reads raw bytes regardless of the caller's cli_binary_format
        //      setting, so this path does not depend on that flag at all --
        //      verified both ways against the real CLI.
        //
        // JSON.stringify, so `payload` may be any JSON value; a bare string
        // becomes a JSON string, which is a legal Lambda event.
        const extraFlags: string[] = ["--function-name", i.functionName];
        // runAwsCall refuses a `file://` / `fileb://` argv value by default --
        // the CLI would swap it for a local file's contents. This one IS a
        // server-minted path, so it is exempted by its exact value below; every
        // other value in the same call (`--qualifier`, the function name) stays
        // guarded.
        let payloadArg: string | undefined;
        if (i.payload !== undefined) {
          const payloadPath = join(dir, "payload.json");
          writeFileSync(payloadPath, JSON.stringify(i.payload), { mode: 0o600 });
          payloadArg = `fileb://${payloadPath}`;
          extraFlags.push("--payload", payloadArg);
        }
        if (i.qualifier !== undefined) extraFlags.push("--qualifier", i.qualifier);
        // Always Tail: the decoded log is this tool's whole reason for existing,
        // and the API caps it at 4 KB, so there is no payload-size argument for
        // making it opt-in.
        extraFlags.push("--log-type", "Tail", "--invocation-type", "RequestResponse");
        // The CLI's socket read timeout, which defaults to 60 s: without this
        // flag a function slower than that lost its response and, worse, had its
        // Invoke re-sent by the CLI's retry logic. See the header.
        extraFlags.push("--cli-read-timeout", String(readTimeoutS));
        // The outfile positional goes LAST in extraFlags. runAwsCall appends
        // `--output/--profile/--region` after them, and `aws lambda invoke`
        // accepts the positional before those flags.
        extraFlags.push(outPath);

        // One notification before the call, not a stream during it. This tool's
        // own description tells callers to set `timeoutMs` to the function's own
        // timeout, which a Lambda may carry up to 15 minutes -- safe advice now
        // that the invoke cannot be re-sent -- and a stdio server that says
        // nothing for that long is indistinguishable from one that has hung.
        // That is the exact reasoning v2.1.0 used when it gave
        // aws_resource_*, aws_multi_region and aws_assume_role progress; this tool
        // shipped in v2.2.0 without inheriting it.
        //
        // No `total`, and no intermediate steps: a single indivisible invoke has
        // no honest denominator, and manufacturing fake phases would be worse
        // than one line that says what is being waited on. Same shape as
        // aws_assume_role's single starting notification.
        ctx?.reportProgress(
          0,
          undefined,
          // waitS, not i.timeoutMs: name the bound that is actually in force, so
          // the line is useful on the default path and honest when the value was
          // clamped to Lambda's 15-minute ceiling.
          `Invoking ${label} (timeout ${waitS}s)`,
        );

        const result = await runAwsCall({
          service: "lambda",
          operation: "invoke",
          profile: i.profile,
          region: i.region,
          // The backstop, not the caller's value: the CLI is meant to report
          // first, and a kill leaves the message unable to say whether the
          // invoke went out.
          timeoutMs: spawnTimeoutMs,
          // AWS_MAX_ATTEMPTS=1, on a full copy of this process's environment
          // because `env` replaces rather than merges. This is the single line
          // that keeps one tool call from running the function three times.
          env: invokeChildEnv(process.env),
          // stdout here is the invoke METADATA envelope (StatusCode,
          // FunctionError, LogResult, ExecutedVersion) -- a single JSON
          // document, so the default parse applies cleanly.
          outputFormat: "json",
          extraFlags,
          ...(payloadArg ? { trustedParamFileArgs: [payloadArg] } : {}),
        });

        if (!result.ok) {
          // `||` not `??`: rawStderr is "" (not nullish) on a nonzero exit that
          // wrote its diagnostic to stdout, and `??` would hand back that empty
          // string instead of falling through. Same fix as call.ts and logs.ts.
          const rawBody = result.rawStderr || result.rawStdout || "";
          // A read timeout is a TIMEOUT, whichever clock reported it. The CLI
          // exits 255 on its own read timeout, so it arrives here as
          // `nonzero_exit` with no usable classification -- that is the shape
          // that used to reach callers with no payload and nothing to act on.
          if (result.kind === "nonzero_exit" || result.kind === "timeout") {
            const rt = READ_TIMEOUT_RE.exec(rawBody);
            if (rt) {
              const url = ANY_URL_RE.exec(rt[0])?.[0];
              // Invoke path -> the request went out. Any other URL -> the CLI was
              // still resolving credentials, so nothing was invoked. No readable
              // URL -> say neither.
              const outcome = INVOKE_PATH_RE.test(rt[0]) ? "sent" : url !== undefined ? "not-sent" : "unknown";
              return invokeTimeoutFailure({
                label,
                waitS,
                readTimeoutS,
                spawnTimeoutMs,
                outcome,
                ...(url !== undefined ? { url } : {}),
                rawBody,
                killed: result.kind === "timeout",
              });
            }
            // A kill with no read-timeout line at all: the CLI never got far
            // enough to name a URL.
            if (result.kind === "timeout") {
              return invokeTimeoutFailure({
                label,
                waitS,
                readTimeoutS,
                spawnTimeoutMs,
                outcome: "unknown",
                rawBody,
                killed: true,
              });
            }
          }
          return {
            ok: false,
            error: result.error,
            errorKind: result.kind,
            suggestion: result.suggestion,
            rawBody: result.rawStderr || result.rawStdout,
          };
        }

        const meta: InvokeStdout = isInvokeStdout(result.data) ? result.data : {};

        // Read the response body the CLI streamed into the outfile.
        let payload: unknown;
        let payloadTruncated = false;
        const raw = readFileSync(outPath);
        if (raw.length > MAX_RESPONSE_PAYLOAD_BYTES) {
          // Deliberately NOT parsed: a clipped JSON document cannot parse, and
          // reporting that as a malformed response would blame the function for
          // our own cap. Hand back the prefix as text and flag it.
          //
          // The cut is by BYTE, so a multi-byte character straddling the
          // boundary decodes to one U+FFFD at the very end. Left as-is rather
          // than backed off to a character boundary: the value is already
          // declared truncated, so a replacement char on its last code point
          // misleads nobody. (Contrast truncateForErrorMsg in aws-cli.ts, which
          // does back off -- it cuts a STRING by UTF-16 unit, where the same
          // slip would emit a lone surrogate and corrupt the JSON response
          // itself rather than just the tail of a field.)
          payload = raw.subarray(0, MAX_RESPONSE_PAYLOAD_BYTES).toString("utf8");
          payloadTruncated = true;
        } else if (raw.length === 0) {
          // A function that returns nothing writes a 0-byte outfile. null is the
          // same thing runAwsCall reports for empty stdout.
          payload = null;
        } else {
          const text = raw.toString("utf8");
          try {
            payload = JSON.parse(text);
          } catch {
            // A Lambda response body is not required to be JSON. Keep the text
            // rather than failing the call over it.
            payload = text;
          }
        }

        // ok:true EVEN WHEN functionError IS SET, and this is the deliberate
        // call rather than an oversight.
        //
        // A FunctionError means the invocation worked and the HANDLER threw:
        // credentials resolved, the request was authorized, Lambda ran the code,
        // and the service returned HTTP 200 with the thrown error as the
        // response body. The AWS CLI agrees -- it exits 0 -- so runAwsCall
        // classifies it as success and reporting ok:false here would mean
        // inventing a failure no layer below us observed, with no honest value
        // to put in errorKind (the ToolResult contract reserves that field for
        // kinds a handler actually holds).
        //
        // The practical argument points the same way. An ok:false return carries
        // `error`/`rawBody` and no `data`, so it would DROP `payload` and
        // `logTail` -- precisely the two things that explain why the handler
        // threw, and the reason this tool exists. Callers branch on
        // `functionError !== undefined`, which the tool description states
        // explicitly so the model does not read ok:true as "the function worked".
        return {
          ok: true,
          data: {
            command: result.command,
            statusCode: meta.StatusCode,
            functionError: meta.FunctionError,
            executedVersion: meta.ExecutedVersion,
            payload,
            logTail: decodeLogTail(meta.LogResult),
            // Only present when it happened -- an always-present `false` invites
            // a reader to treat the field as a size report rather than an
            // exception flag.
            ...(payloadTruncated ? { payloadTruncated: true } : {}),
          },
        };
      } finally {
        // Covers every exit: success, FunctionError, nonzero exit, TIMEOUT, and
        // SPAWN ERROR. Those last two are the ones worth naming -- runAwsCall
        // resolves its envelope rather than rejecting on both, so control always
        // reaches this block instead of unwinding past it. `force` swallows the
        // ENOENT case where the CLI never created the outfile, and `recursive`
        // takes the payload file with it.
        //
        // Best-effort, and the try/catch is load-bearing rather than decorative.
        // `force` only suppresses ENOENT; on Windows, removing a directory whose
        // file is still open by another process fails with EBUSY/EPERM instead,
        // and the timeout path is exactly where that can happen -- runAwsCall
        // may settle while a killed `aws` (or a descendant that inherited the
        // handle) still holds the outfile open. A throw here would propagate out
        // of the finally and DISCARD the result we are returning, so a clean
        // `timeout` envelope would reach the caller as a generic caught error
        // with no errorKind. Leaving a directory in the OS temp dir is the far
        // cheaper failure.
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch (err) {
          console.error(
            `[aws-mcp] failed to remove Lambda invoke temp dir ${dir}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    },
  },
];
