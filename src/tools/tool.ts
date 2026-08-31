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
 * minutes, aws_multi_region fans out across up to 32 regions, aws_assume_role
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
