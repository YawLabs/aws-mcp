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

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  annotations: ToolAnnotations;
  // Each tool's schema shape is specific, but the runtime only needs the
  // generic ZodObject<ZodRawShape> interface to pull .shape off for
  // server.tool(). Keep the annotation wide.
  inputSchema: ZodObject<ZodRawShape>;
  handler: (input: unknown) => Promise<ToolResult>;
}
