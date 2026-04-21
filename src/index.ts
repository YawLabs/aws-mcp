#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ZodObject, ZodRawShape } from "zod";
import { authTools } from "./tools/auth.js";

// Injected at build time by esbuild; falls back to reading package.json for tsc builds.
declare const __VERSION__: string | undefined;
const version =
  typeof __VERSION__ !== "undefined"
    ? __VERSION__
    : ((await import("node:module")).createRequire(import.meta.url)("../package.json") as { version: string }).version;

const subcommand = process.argv[2];
if (subcommand === "version" || subcommand === "--version") {
  console.log(version);
  process.exit(0);
}

type Tool = {
  name: string;
  description: string;
  annotations: { readOnlyHint?: boolean };
  inputSchema: ZodObject<ZodRawShape>;
  handler: (input: unknown) => Promise<unknown>;
};

const allTools: ReadonlyArray<Tool> = [...(authTools as unknown as ReadonlyArray<Tool>)];

const server = new McpServer({
  name: "@yawlabs/aws-mcp",
  version,
});

for (const tool of allTools) {
  server.tool(
    tool.name,
    tool.description,
    tool.inputSchema.shape,
    tool.annotations,
    async (input: Record<string, unknown>) => {
      try {
        const result = await (tool.handler as (input: unknown) => Promise<unknown>)(input);
        const response = result as { ok: boolean; data?: unknown; error?: string; rawBody?: string };

        if (!response.ok) {
          return {
            content: [{ type: "text" as const, text: `Error: ${response.error || "Unknown error"}` }],
            isError: true,
          };
        }

        const text = response.rawBody ?? JSON.stringify(response.data ?? { success: true }, null, 2);
        return {
          content: [{ type: "text" as const, text }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`@yawlabs/aws-mcp v${version} ready (${allTools.length} tools)`);
