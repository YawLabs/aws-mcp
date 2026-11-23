/**
 * Shared shapes for MCP tool registrations so every tools/*.ts module can
 * type its exported array directly instead of having index.ts reach in with
 * `as unknown as Tool[]` casts that erase literal types.
 */

import type { ZodObject, ZodRawShape } from "zod";

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  rawBody?: string;
  /**
   * Machine-readable classification of a failure, so a caller can branch on the
   * failure CLASS instead of regex-matching `error` prose -- which is what the
   * README "Stability" section already tells integrators to do, and what only
   * aws_multi_region could actually support before this field existed.
   *
   * Typed `string` rather than AwsCallFailureKind on purpose. It matches
   * RegionResult.errorKind in tools/multi-region.ts (the field this one
   * generalizes), and not every value comes from a CLI call: multi-region emits
   * "bad_input" for a region name it rejected locally and "unexpected" for a
   * worker that threw. Importing the union would also point this module at
   * aws-cli.ts, which nothing else here needs.
   *
   * Set ONLY where the handler already holds a classified kind. A handler that
   * fails its own input validation leaves this unset rather than inventing a
   * value, so an ABSENT errorKind means "unclassified" -- never "nonzero_exit".
   */
  errorKind?: string;
  /**
   * The one-line remedy for a recognized failure -- usually the one parseAwsError
   * (src/errors.ts) derives from an AWS error code -- carried structurally so a
   * caller does not have to split it back out of `error`.
   *
   * NOT rendered by toMcpResult, deliberately. Its producers -- runAwsCall's
   * nonzero_exit branch, aws_lambda_invoke's timeout remap, and the
   * parse-failure hints aws_call and aws_paginate add through failureToolResult
   * below (cliArgParseHint in tools/call.ts, which explains a command the CLI
   * can never run through --cli-input-json) -- all three already
   * append "\n\nSuggestion: <text>" to the message they build, so rendering the
   * field too would print the same sentence twice: the defect v2.0.1 fixed for
   * rawBody. Its consumers are in-process
   * ones -- the aws_script bridge attaches it to the Error it throws, so a
   * script can branch on it. A future handler that sets `suggestion` WITHOUT
   * also putting it in `error` would not surface it to the model at all; put it
   * in the message as well, or teach toMcpResult to append it when the text does
   * not already contain it.
   */
  suggestion?: string;
}

/**
 * The slice of an AwsCallFailure (aws-cli.ts) that failureToolResult reads.
 * Structural so this module keeps no import of aws-cli.ts -- see errorKind.
 */
interface CliFailureLike {
  error: string;
  kind: string;
  suggestion?: string;
  rawStdout?: string;
  rawStderr?: string;
}

/**
 * The CLI body a failure envelope carries as `rawBody`: stderr, or stdout when
 * stderr is empty. Truthiness, not `??`: an empty-string stderr means "no
 * stderr", and `??` would return that empty string and drop a stdout body that
 * does carry the diagnostic (rare but observed: some `aws` operations route
 * through stdout when stderr is closed or a wrapper swallows it). Pinned by
 * call.test.ts -- the contract is "diagnostic text first, stdout second", not
 * "stderr always wins even when empty".
 */
export function rawBodyOf(result: { rawStdout?: string; rawStderr?: string }): string | undefined {
  return result.rawStderr ? result.rawStderr : result.rawStdout;
}

/**
 * Map a failed CLI call to the tool's failure envelope, optionally with a
 * tool-side remedy (`hint`) that runAwsCall could not have known.
 *
 * The hint is embedded in `error` AND carried in `suggestion`, the same
 * convention runAwsCall's nonzero_exit branch uses -- toMcpResult renders only
 * `error`, so a hint that lived in the field alone would never reach the model.
 * `error` still OPENS with the CLI's own message, which is what keeps
 * toMcpResult from appending rawBody a second time. A suggestion runAwsCall
 * already derived wins over the hint in `suggestion`: callers pass a hint only
 * when there was none.
 */
export function failureToolResult(result: CliFailureLike, hint?: string): ToolResult {
  return {
    ok: false,
    error: hint ? `${result.error}\n\nSuggestion: ${hint}` : result.error,
    errorKind: result.kind,
    suggestion: result.suggestion ?? hint,
    rawBody: rawBodyOf(result),
  };
}

interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * Per-call context handed to a tool handler by the registration loop in
 * index.ts. Every field is optional to use and the whole argument is optional
 * to accept: the ~20 handlers with nothing to report keep their one-parameter
 * signature unchanged.
 *
 * Exists because several tools run far longer than a caller can be expected to
 * sit through blind -- `awaitCompletion` polls Cloud Control for up to 30
 * minutes, aws_multi_region fans out across up to 64 regions, aws_assume_role
 * allows 120s for a cold-start SAML round-trip -- and a stdio MCP server that
 * says nothing for that long is indistinguishable from one that has hung.
 */
export interface ToolContext {
  /**
   * Emit an MCP progress notification for this call.
   *
   * A NO-OP unless the client opted in by sending a `progressToken` in the
   * request's `_meta` (per the MCP spec, a server may only send progress for a
   * request that carried one). Handlers therefore call it unconditionally and
   * never branch on client support.
   *
   * `progress` must increase monotonically across calls within one request.
   * Pass `total` when the denominator is known (region count, page count);
   * omit it for open-ended work like polling, where the spec allows progress
   * without a total rather than inventing a fake one.
   */
  reportProgress: (progress: number, total?: number, message?: string) => void;
  /**
   * Aborts when the CLIENT cancels the request. Distinct from any per-call
   * `timeoutMs`, which is our own deadline: this one means the caller has
   * stopped caring, so long-running loops should check it and bail rather than
   * finish work whose result is already discarded.
   */
  signal?: AbortSignal;
}

export interface Tool {
  name: string;
  description: string;
  annotations: ToolAnnotations;
  // Each tool's schema shape is specific, but the runtime only needs the
  // generic ZodObject<ZodRawShape> interface to pull .shape off for
  // server.tool(). Keep the annotation wide.
  inputSchema: ZodObject<ZodRawShape>;
  // `ctx` is optional so the handlers that report nothing need no signature
  // change; index.ts always passes one.
  handler: (input: unknown, ctx?: ToolContext) => Promise<ToolResult>;
}
