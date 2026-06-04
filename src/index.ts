#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { assumeTools } from "./tools/assume.js";
import { authTools } from "./tools/auth.js";
import { callTools } from "./tools/call.js";
import { docsTools } from "./tools/docs.js";
import { iamSimulateTools } from "./tools/iam-simulate.js";
import { logsTools } from "./tools/logs.js";
import { metricsTools } from "./tools/metrics.js";
import { multiRegionTools } from "./tools/multi-region.js";
import { paginateTools } from "./tools/paginate.js";
import { profilesTools } from "./tools/profiles.js";
import { resourceTools } from "./tools/resource.js";
import { scriptTools } from "./tools/script.js";
import { sessionTools } from "./tools/session.js";
import type { Tool, ToolResult } from "./tools/tool.js";

/** The MCP tool-call result shape this server emits. */
export interface McpResult {
  // Index signature so this is assignable to the MCP SDK's CallToolResult
  // ({ [x: string]: unknown; content: [...] }) at the server.tool boundary.
  [x: string]: unknown;
  content: [{ type: "text"; text: string }];
  isError?: true;
}

/**
 * Map a tool handler's {@link ToolResult} envelope to the MCP call result the
 * SDK serializes. Pure and behavior-preserving — the emitted shape must stay
 * byte-identical to the inline mapping the registration loop used previously.
 */
export function toMcpResult(response: ToolResult): McpResult {
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
}

/**
 * Map a thrown handler error to an MCP error result, logging message + stack to
 * stderr as a side effect.
 *
 * The MCP response only carries the message; preserving the original stack to
 * stderr means the operator sees what actually went wrong when the model's
 * surfaced error text is too thin to debug from.
 *
 * Log only message + stack rather than the whole err object so any future
 * handler that re-throws an AwsCallResult-shaped value (with rawStdout /
 * rawStderr fields) doesn't dump those into operator stderr verbatim.
 */
export function errorToMcpResult(err: unknown, toolName: string): McpResult {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  console.error(`[aws-mcp] handler '${toolName}' threw: ${message}`);
  if (stack) console.error(stack);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

// Injected at build time by esbuild; falls back to reading package.json for tsc builds.
declare const __VERSION__: string | undefined;
const version =
  typeof __VERSION__ !== "undefined"
    ? __VERSION__
    : ((await import("node:module")).createRequire(import.meta.url)("../package.json") as { version: string }).version;

// True when this module is the process entry point (run as the `aws-mcp` bin),
// false when it's imported (e.g. by index.test.js for the exported pure
// functions). Gates the stdio-server bootstrap below so importing the module
// doesn't connect a transport or print the ready line as a side effect.
const isEntryPoint = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
})();

const subcommand = process.argv[2];
if (isEntryPoint && (subcommand === "version" || subcommand === "--version")) {
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
  ...metricsTools,
  ...resourceTools,
  ...multiRegionTools,
  ...iamSimulateTools,
  ...docsTools,
  ...scriptTools,
];

// Re-exported so tests can import the exact array the registration loop below
// iterates -- a "tool count" assertion against this export catches both
// (a) a new tool file exported with an empty array, and (b) a typo where
// index.ts references a non-existent array name (the spread would throw at
// module load). Not exposed via the MCP surface.
export { allTools };

// Only bootstrap the stdio server when run as the bin entry point. When the
// module is imported (e.g. by index.test.js for toMcpResult/errorToMcpResult),
// skip connecting a transport and printing the ready line.
if (isEntryPoint) {
  const server = new McpServer({
    name: "@yawlabs/aws-mcp",
    version,
  });

  for (const tool of allTools) {
    server.tool(tool.name, tool.description, tool.inputSchema.shape, tool.annotations, async (input) => {
      try {
        return toMcpResult(await tool.handler(input));
      } catch (err) {
        return errorToMcpResult(err, tool.name);
      }
    });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`@yawlabs/aws-mcp v${version} ready (${allTools.length} tools)`);
}
