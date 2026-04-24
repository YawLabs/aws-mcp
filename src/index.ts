#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { assumeTools } from "./tools/assume.js";
import { authTools } from "./tools/auth.js";
import { callTools } from "./tools/call.js";
import { logsTools } from "./tools/logs.js";
import { paginateTools } from "./tools/paginate.js";
import { profilesTools } from "./tools/profiles.js";
import { resourceTools } from "./tools/resource.js";
import { sessionTools } from "./tools/session.js";
import type { Tool } from "./tools/tool.js";

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

const allTools: readonly Tool[] = [
  ...authTools,
  ...sessionTools,
  ...callTools,
  ...profilesTools,
  ...paginateTools,
  ...assumeTools,
  ...logsTools,
  ...resourceTools,
];

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
        const response = await tool.handler(input);

        if (!response.ok) {
          // Include rawBody (e.g. aws CLI stderr) in the error so the model can
          // diagnose. Without it the caller only sees the one-line summary and
          // has to guess at the actual AWS-side failure.
          const baseError = `Error: ${response.error || "Unknown error"}`;
          const errorText = response.rawBody ? `${baseError}\n\n${response.rawBody}` : baseError;
          return {
            content: [{ type: "text" as const, text: errorText }],
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
