#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

/**
 * The MCP tool-call result shape this server emits.
 *
 * Not exported: toMcpResult / errorToMcpResult are the surface, and no .d.ts
 * ships (the published `files` list is dist/index.js alone), so nothing
 * outside this module needs to name the type.
 */
interface McpResult {
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
    //
    // ...but skip it when the summary ALREADY carries that text. The auth-class
    // messages in aws-cli.ts end with "Underlying error: <stderr>" so the
    // stderr survives handlers that rebuild the message without forwarding
    // rawBody (aws_assume_role does exactly that). Appending rawBody on top of
    // those printed the same stderr twice in one response -- observed against
    // the published 2.0.0 on a bad --profile, and worst on `no_creds` /
    // `expired_creds` / `invalid_creds`, the errors a first-run user is most
    // likely to hit.
    //
    // Compare on the TRIMMED rawBody: the embedded copy went through
    // truncateForErrorMsg(stderr.trim()) while rawBody is the raw stream, so
    // the two differ by trailing CR/LF even when the body is identical. When
    // stderr is long enough to have been truncated the containment check fails
    // and the full body is still appended -- which is the useful outcome, not
    // a duplicate: the summary holds a clipped copy and rawBody completes it.
    const baseError = `Error: ${response.error || "Unknown error"}`;
    const rawTrimmed = response.rawBody?.trim();
    const alreadyInSummary = !!rawTrimmed && baseError.includes(rawTrimmed);
    const errorText = rawTrimmed && !alreadyInSummary ? `${baseError}\n\n${response.rawBody}` : baseError;
    return {
      content: [{ type: "text" as const, text: errorText }],
      isError: true,
    };
  }

  // Emit BOTH when a handler sets both. This used to be
  // `response.rawBody ?? JSON.stringify(...)`, which silently DROPPED `data`
  // whenever rawBody was also present -- so a handler that returned a parsed,
  // summarized envelope alongside the raw CLI output had its envelope thrown
  // away and the model saw only the raw text. Same separator the error branch
  // uses: structured first, raw blob after a blank line.
  //
  // The { success: true } fallback still stands in only when there is nothing
  // at all to report; null/undefined data is "no data", matching the previous
  // `?? { success: true }`.
  const parts: string[] = [];
  if (response.data !== undefined && response.data !== null) {
    parts.push(JSON.stringify(response.data, null, 2));
  }
  if (response.rawBody !== undefined) parts.push(response.rawBody);
  const text = parts.length > 0 ? parts.join("\n\n") : JSON.stringify({ success: true }, null, 2);
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

// Injected at build time by esbuild; falls back to reading package.json for
// plain-tsc builds.
//
// Uses the STATIC createRequire import above, not a dynamic
// `(await import("node:module"))`. The dynamic form was both redundant (the
// symbol is already imported for the isSeaBinary probe below) and a top-level
// await -- which contradicts the deliberately TLA-free `server.connect().then()`
// form at the bottom of this file, whose whole point is that the CJS SEA bundle
// can't express top-level await. esbuild folds this ternary to `true ? "x" : ...`
// but KEEPS the dead branch, and it used to rewrite the dynamic import to a bare
// `null`, emitting `null.createRequire(...)`. So the fallback was dead code that
// would also have thrown a TypeError had it ever run in a bundled build -- which
// is every build we ship (package.json `files` publishes only the esbuild output).
declare const __VERSION__: string | undefined;
const version =
  typeof __VERSION__ !== "undefined"
    ? __VERSION__
    : (createRequire(import.meta.url)("../package.json") as { version: string }).version;

// True inside a Node Single Executable Application (the SEA binary). In the
// CJS bundle esbuild emits for the binary, `import.meta.url` is empty, so the
// argv[1] check below can never match -- without this short-circuit the binary
// would do nothing. A SEA is always its own entry point (never imported as a
// test module), so isSea() === true is a reliable "this is the entry" signal.
// node:sea exists on Node >= 20.12 and isSea() is true only inside a SEA, so a
// missing module or thrown call (plain `node`) safely falls through to false.
const isSeaBinary = (() => {
  try {
    // In the CJS SEA bundle `import.meta.url` is empty, which makes
    // createRequire(import.meta.url) throw -- fall back to a valid base
    // (process.execPath) so node:sea still resolves inside the binary.
    const base = import.meta.url || pathToFileURL(process.execPath).href;
    const require = createRequire(base);
    const sea = require("node:sea") as { isSea?: () => boolean };
    return typeof sea.isSea === "function" && sea.isSea() === true;
  } catch {
    return false;
  }
})();

/**
 * realpath plus a platform-appropriate case fold, or undefined when the path
 * cannot be resolved. Windows paths fold to lower case because the filesystem
 * is case-insensitive there.
 */
function canonicalPath(p: string): string | undefined {
  try {
    const real = realpathSync(p);
    return process.platform === "win32" ? real.toLowerCase() : real;
  } catch {
    return undefined;
  }
}

// True when this module is the process entry point (run as the `aws-mcp` bin),
// false when it's imported (e.g. by index.test.js for the exported pure
// functions). Gates the stdio-server bootstrap below so importing the module
// doesn't connect a transport or print the ready line as a side effect.
//
// A FALSE NEGATIVE here is this server's worst failure mode: no transport is
// connected, nothing is printed, the process just sits there, and the MCP host
// hangs on a handshake that will never be answered. The exact-string URL
// compare alone produces one in two real situations -- a SYMLINKED bin (a
// package manager or a hand-rolled /usr/local/bin link pointing here) and
// Windows drive-letter case drift between launchers (`c:\...` vs `C:\...`) --
// where argv[1] genuinely IS this module. So resolve both sides through
// realpath before concluding otherwise, and when the answer is still "not the
// entry point", say why on stderr instead of vanishing.
const isEntryPoint =
  isSeaBinary ||
  (() => {
    const entry = process.argv[1];
    // No argv[1] at all: `node -e`, a REPL, an embedder. Genuinely not an
    // entry point and not worth a diagnostic.
    if (!entry) return false;
    if (import.meta.url === pathToFileURL(entry).href) return true;

    let self: string | undefined;
    try {
      self = import.meta.url ? canonicalPath(fileURLToPath(import.meta.url)) : undefined;
    } catch {
      self = undefined;
    }
    const target = canonicalPath(entry);

    if (self !== undefined && target !== undefined) {
      if (self === target) return true;
      // Two genuinely different files. Overwhelmingly this is the intended
      // case -- a test importing the module -- so only speak up when argv[1]
      // carries OUR filename, which means someone meant to run this server and
      // started a different copy of it. Warning on every import would be noise.
      if (basename(self) === basename(target)) {
        console.error(
          `[aws-mcp] not starting: the process entry point (${target}) is a different file from this module (${self}). ` +
            "Launch the installed dist/index.js, or go through the aws-mcp bin.",
        );
      }
      return false;
    }

    // One side would not resolve: a deleted or unreadable path, or an empty
    // import.meta.url outside a SEA. Neither answer is provable, and guessing
    // "not the entry point" costs a silent hang -- so report it.
    console.error(
      `[aws-mcp] could not resolve the entry point (argv[1]=${entry}, module=${import.meta.url || "<empty>"}); ` +
        "not starting the stdio server. If your MCP host is waiting on a handshake, this is why.",
    );
    return false;
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

/**
 * Tool names appearing more than once in `tools`, in first-seen order.
 *
 * Exported so the registry test can exercise the detector on synthetic input
 * rather than only through the (hopefully always empty) real registry.
 */
export function findDuplicateToolNames(tools: readonly Tool[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) duplicates.add(tool.name);
    seen.add(tool.name);
  }
  return [...duplicates];
}

// Fail loudly on a duplicate tool name. server.tool() is keyed by name, so a
// second registration of an existing name REPLACES the first: the shadowed
// tool stays in allTools, still counts toward the ready line's tool total, and
// is simply unreachable over MCP. Nothing in the SDK complains.
//
// This runs at module load, outside the isEntryPoint gate, so a merge that
// collides two names breaks the test run as well as the server rather than
// shipping a tool that silently does not exist.
const duplicateToolNames = findDuplicateToolNames(allTools);
if (duplicateToolNames.length > 0) {
  throw new Error(
    `[aws-mcp] duplicate tool name(s) in the registry: ${duplicateToolNames.join(", ")}. ` +
      "server.tool() is keyed by name, so the later registration would silently shadow the earlier one. " +
      "Rename one of them in its tools/*.ts module.",
  );
}

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
  // Non-top-level-await form so the CJS bundle (esbuild, for the SEA binary)
  // builds -- CJS output cannot emit top-level await.
  server
    .connect(transport)
    .then(() => {
      console.error(`@yawlabs/aws-mcp v${version} ready (${allTools.length} tools)`);
    })
    .catch((err: unknown) => {
      process.stderr.write(`aws-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
