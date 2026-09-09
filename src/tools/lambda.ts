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
 * DEFERRED, explicitly and with intent:
 *   - `InvocationType: "Event"` (async fire-and-forget). It returns 202 with no
 *     payload and no logs, so it shares almost nothing with the code below and
 *     wants its own result contract.
 *   - `InvocationType: "DryRun"` (permission check only). aws_iam_simulate
 *     already answers "may this principal invoke it" without running anything.
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
const MAX_FUNCTION_NAME_LEN = 170; // Full-ARN maximum per the Lambda API docs.

/** Version number or alias name. `$LATEST` is why `$` is in the class. */
const SAFE_QUALIFIER_RE = /^[a-zA-Z0-9$][a-zA-Z0-9\-_$]*$/;
const MAX_QUALIFIER_LEN = 128;

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
      "Invoke a Lambda function synchronously (RequestResponse) and return its response payload plus the DECODED tail of its execution log in one call. Use this instead of aws_call for Lambda invokes: `aws lambda invoke` needs a positional output file and rejects --cli-input-json, so aws_call structurally cannot reach it. The returned `logTail` is the last ~4 KB of the function's own log output, already base64-decoded, which removes the usual invoke -> find the log group -> tail it -> hope the window caught it loop. IMPORTANT: a non-empty `functionError` means the function's HANDLER threw; the invocation itself still succeeded, so ok is true and the thrown error is in `payload`.",
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
        .describe("Version number or alias to invoke, e.g. '3' or 'PROD'. Defaults to $LATEST."),
      invocationType: z
        .enum(["RequestResponse"])
        .optional()
        .describe(
          "Only 'RequestResponse' (synchronous) is supported. Async 'Event' and permission-check 'DryRun' are deliberately not implemented — 'Event' returns no payload or logs and needs its own result shape; for 'DryRun', use aws_iam_simulate instead.",
        ),
      profile: z.string().optional().describe("Override session profile for this call."),
      region: z.string().optional().describe("Override session region for this call."),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Timeout in milliseconds. Default 60000 (60s). Raise it for a function whose own timeout is longer — a Lambda may run up to 15 minutes.",
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
          error: `Invalid functionName: ${i.functionName.length} chars exceeds the ${MAX_FUNCTION_NAME_LEN}-char maximum for a Lambda function ARN.`,
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
            error: `Invalid qualifier '${i.qualifier}'. Use a version number or alias name — letters, digits, and - _ $ only, not starting with '-'.`,
          };
        }
      }
      if (i.invocationType !== undefined && i.invocationType !== "RequestResponse") {
        return {
          ok: false,
          error: `invocationType '${i.invocationType}' is not supported. Only 'RequestResponse' (synchronous) is implemented; 'Event' and 'DryRun' are deliberately out of scope.`,
        };
      }

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
        if (i.payload !== undefined) {
          const payloadPath = join(dir, "payload.json");
          writeFileSync(payloadPath, JSON.stringify(i.payload), { mode: 0o600 });
          extraFlags.push("--payload", `fileb://${payloadPath}`);
        }
        if (i.qualifier !== undefined) extraFlags.push("--qualifier", i.qualifier);
        // Always Tail: the decoded log is this tool's whole reason for existing,
        // and the API caps it at 4 KB, so there is no payload-size argument for
        // making it opt-in.
        extraFlags.push("--log-type", "Tail", "--invocation-type", "RequestResponse");
        // The outfile positional goes LAST in extraFlags. runAwsCall appends
        // `--output/--profile/--region` after them, and `aws lambda invoke`
        // accepts the positional before those flags.
        extraFlags.push(outPath);

        // One notification before the call, not a stream during it. This tool's
        // own description tells callers to raise `timeoutMs` for a function whose
        // own timeout is longer -- a Lambda may run up to 15 minutes -- and a
        // stdio server that says nothing for that long is indistinguishable from
        // one that has hung. That is the exact reasoning v2.1.0 used when it gave
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
          // i.timeoutMs may be absent; name the effective bound rather than
          // "undefined", so the line is useful on the default path too.
          `Invoking ${i.functionName}${i.qualifier ? `:${i.qualifier}` : ""} (timeout ${Math.round((i.timeoutMs ?? 60_000) / 1000)}s)`,
        );

        const result = await runAwsCall({
          service: "lambda",
          operation: "invoke",
          profile: i.profile,
          region: i.region,
          timeoutMs: i.timeoutMs,
          // stdout here is the invoke METADATA envelope (StatusCode,
          // FunctionError, LogResult, ExecutedVersion) -- a single JSON
          // document, so the default parse applies cleanly.
          outputFormat: "json",
          extraFlags,
        });

        if (!result.ok) {
          // `||` not `??`: rawStderr is "" (not nullish) on a nonzero exit that
          // wrote its diagnostic to stdout, and `??` would hand back that empty
          // string instead of falling through. Same fix as call.ts and logs.ts.
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
