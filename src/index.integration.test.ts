/**
 * Process-level integration tests for the server entry point.
 *
 * Everything in index.test.ts imports ./index.js, which by construction takes
 * the isEntryPoint === false path -- so the entry-point detection, the version
 * subcommand, and the entire McpServer bootstrap never execute there. This file
 * covers them the only way they can be covered: by SPAWNING the built
 * dist/index.js as a child process and speaking MCP over its stdio.
 *
 * Why that matters beyond coverage bookkeeping: npm installs the `aws-mcp` bin
 * as a SYMLINK (`npx -y @yawlabs/aws-mcp`, or a global install), so the
 * realpath branch of the entry-point check is the path essentially every real
 * user hits. Its failure mode is silent -- no transport is connected, nothing
 * is printed, and the MCP host hangs on a handshake that never gets answered.
 *
 * Note on what is under test: `npm run build` runs tsc and THEN esbuild, so
 * dist/index.js is the bundled artifact that actually ships (package.json
 * `files` publishes dist/index.js alone), not the tsc output. Spawning it here
 * exercises the shipped bundle, including the build-time __VERSION__ define.
 *
 * Wire format is newline-delimited JSON-RPC -- NOT LSP Content-Length framing.
 * The client below is deliberately hand-rolled rather than the SDK's, so a
 * regression in the SDK's own client cannot mask a regression in the server's
 * stdout discipline: this reader sees every raw byte the server writes.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { allTools } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The built bundle, sitting next to this compiled test file in dist/. */
const SERVER_ENTRY = join(__dirname, "index.js");

/** Root package.json -- `npm test` builds first, so this is what got bundled. */
const PKG_VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

// Every wait in this file is bounded. A hung server is the exact defect these
// tests exist to catch, so it has to fail with a diagnostic rather than sit
// until the runner's own (300s) timeout.
const BOOT_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 20_000;
/** Grace period after stdin close before we start killing. Measured exit: ~50ms. */
const REAP_TIMEOUT_MS = 3_000;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/**
 * A child env with the AWS knobs stripped, so a developer's own AWS_PROFILE /
 * AWS_REGION cannot change what the server reports. Overrides are applied on
 * top for the cases that want a specific value.
 */
function childEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION"]) {
    delete env[key];
  }
  return { ...env, ...overrides };
}

/**
 * Minimal newline-delimited JSON-RPC client over a spawned server process.
 *
 * Records EVERY complete stdout line verbatim (including ones that are not
 * JSON) so the stdout-purity assertion has something real to check: a stray
 * console.log to stdout desyncs the SDK's line-oriented reader and takes the
 * whole protocol stream down, and it is invisible from the client side of a
 * well-behaved SDK client.
 */
class ServerProcess {
  readonly child: ChildProcess;
  /** Every complete line written to stdout, raw, in order. Blank lines included. */
  readonly stdoutLines: string[] = [];
  stderr = "";

  private stdoutBuf = "";
  private nextId = 1;
  private exited = false;
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  private readonly replyWaiters = new Map<number, (m: JsonRpcMessage) => void>();
  private readonly failWaiters = new Set<(err: Error) => void>();
  private readonly stderrWaiters = new Set<() => void>();

  constructor(entry: string, argv: string[] = [], env: NodeJS.ProcessEnv = childEnv()) {
    this.child = spawn(process.execPath, [entry, ...argv], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env,
    });

    // A closed stdin on an already-dead child turns a write into an EPIPE
    // throw; swallowing it keeps a reap from masking the real assertion.
    this.child.stdin?.on("error", () => {});

    this.child.stdout?.setEncoding("utf-8");
    this.child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr?.setEncoding("utf-8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderr += chunk;
      for (const w of [...this.stderrWaiters]) w();
    });

    this.child.on("error", (err) => this.fail(new Error(`failed to spawn the server: ${err.message}`)));
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      this.exitInfo = { code, signal };
      for (const w of [...this.stderrWaiters]) w();
      this.fail(new Error(`server exited (code=${code}, signal=${signal}) before answering. ${this.diagnostics()}`));
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    for (let nl = this.stdoutBuf.indexOf("\n"); nl !== -1; nl = this.stdoutBuf.indexOf("\n")) {
      const line = this.stdoutBuf.slice(0, nl);
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      this.stdoutLines.push(line);
      let parsed: JsonRpcMessage;
      try {
        parsed = JSON.parse(line) as JsonRpcMessage;
      } catch {
        // Not JSON. Kept in stdoutLines for the purity assertion; nothing to
        // dispatch. Deliberately NOT a throw -- the assertion names it better.
        continue;
      }
      if (typeof parsed.id === "number") {
        const waiter = this.replyWaiters.get(parsed.id);
        if (waiter) {
          this.replyWaiters.delete(parsed.id);
          waiter(parsed);
        }
      }
    }
  }

  private fail(err: Error): void {
    for (const w of [...this.failWaiters]) w(err);
  }

  /** stderr + stdout, trimmed, for an assertion message. */
  diagnostics(): string {
    return `stderr=${JSON.stringify(this.stderr)} stdout=${JSON.stringify(this.stdoutLines.join("\\n").slice(0, 400))}`;
  }

  private write(payload: Record<string, unknown>): void {
    this.child.stdin?.write(`${JSON.stringify(payload)}\n`);
  }

  notify(method: string, params: unknown = {}): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** Send a request; resolve on its reply, reject on timeout or early exit. */
  request(method: string, params: unknown = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const settle = (fn: () => void) => {
        clearTimeout(timer);
        this.replyWaiters.delete(id);
        this.failWaiters.delete(onFail);
        fn();
      };
      const timer = setTimeout(() => {
        settle(() => reject(new Error(`no reply to '${method}' within ${timeoutMs}ms. ${this.diagnostics()}`)));
      }, timeoutMs);
      const onFail = (err: Error) => settle(() => reject(err));

      this.failWaiters.add(onFail);
      this.replyWaiters.set(id, (m) => settle(() => resolve(m)));
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Resolve once stderr matches; reject on timeout or early exit. */
  waitForStderr(re: RegExp, timeoutMs = BOOT_TIMEOUT_MS): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const settle = (fn: () => void) => {
        clearTimeout(timer);
        this.stderrWaiters.delete(check);
        this.failWaiters.delete(onFail);
        fn();
      };
      const timer = setTimeout(() => {
        settle(() => reject(new Error(`stderr never matched ${re} within ${timeoutMs}ms. ${this.diagnostics()}`)));
      }, timeoutMs);
      const check = () => {
        if (re.test(this.stderr)) settle(resolve);
      };
      // Exit is only a failure if the pattern never showed up; check first.
      const onFail = (err: Error) => {
        if (re.test(this.stderr)) settle(resolve);
        else settle(() => reject(err));
      };

      this.failWaiters.add(onFail);
      this.stderrWaiters.add(check);
      check();
    });
  }

  /** Full MCP handshake: initialize request, then the initialized notification. */
  async initialize(): Promise<JsonRpcMessage> {
    const reply = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "aws-mcp-integration-test", version: "0.0.0" },
    });
    this.notify("notifications/initialized");
    return reply;
  }

  /** Wait for exit; resolve with the exit info. Assumes something will end it. */
  private waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (this.exited) return Promise.resolve(this.exitInfo ?? { code: null, signal: null });
    return new Promise((resolve) => {
      this.child.once("exit", (code, signal) => resolve({ code, signal }));
    });
  }

  /** Run to completion (for `version` and friends), bounded. */
  async runToExit(timeoutMs = BOOT_TIMEOUT_MS): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`process did not exit within ${timeoutMs}ms. ${this.diagnostics()}`)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([this.waitForExit(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Always reap. Close stdin (the server's own shutdown path), then escalate.
   * A leaked server process wedges the whole suite, so this has to run on the
   * assertion-failure path too -- see withServer's finally.
   */
  async dispose(): Promise<void> {
    if (this.exited) return;
    const exited = this.waitForExit();
    this.child.stdin?.end();
    const soft = setTimeout(() => this.child.kill(), REAP_TIMEOUT_MS);
    const hard = setTimeout(() => this.child.kill("SIGKILL"), REAP_TIMEOUT_MS + 2_000);
    try {
      await exited;
    } finally {
      clearTimeout(soft);
      clearTimeout(hard);
    }
  }
}

/** Spawn, run the body, and reap unconditionally -- including on assertion failure. */
async function withServer<T>(
  fn: (server: ServerProcess) => Promise<T>,
  opts: { entry?: string; argv?: string[]; env?: NodeJS.ProcessEnv } = {},
): Promise<T> {
  const server = new ServerProcess(opts.entry ?? SERVER_ENTRY, opts.argv ?? [], opts.env ?? childEnv());
  try {
    return await fn(server);
  } finally {
    await server.dispose();
  }
}

/**
 * Windows needs SeCreateSymbolicLinkPrivilege (admin, or Developer Mode) to
 * create a file symlink. Probe once at load so the symlink case can carry an
 * explicit skip REASON rather than silently passing on a machine that cannot
 * exercise it.
 */
const symlinkSkip: string | false = (() => {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), "aws-mcp-symprobe-"));
    symlinkSync(SERVER_ENTRY, join(dir, "probe.js"), "file");
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown";
    return `cannot create a file symlink on this machine (${code}) -- needs admin or Developer Mode on Windows`;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
})();

function toolResult(reply: JsonRpcMessage): McpToolResult {
  assert.equal(reply.error, undefined, `tools/call returned a JSON-RPC error: ${JSON.stringify(reply.error)}`);
  return reply.result as unknown as McpToolResult;
}

describe("spawned server — MCP handshake over stdio", () => {
  it("boots, answers initialize, and lists every registered tool with no duplicates", async () => {
    await withServer(async (server) => {
      const init = await server.initialize();

      assert.equal(init.error, undefined, `initialize failed: ${JSON.stringify(init.error)}`);
      assert.equal(init.jsonrpc, "2.0");
      assert.equal(init.id, 1);
      const initResult = init.result as {
        protocolVersion: string;
        capabilities: { tools?: unknown };
        serverInfo: { name: string; version: string };
      };
      assert.equal(initResult.serverInfo.name, "@yawlabs/aws-mcp");
      assert.equal(
        initResult.serverInfo.version,
        PKG_VERSION,
        "the bundled __VERSION__ define drifted from package.json",
      );
      // The registration loop ran, so the server advertises the tools capability.
      assert.ok(initResult.capabilities.tools, "server did not advertise a tools capability");

      const list = await server.request("tools/list");
      assert.equal(list.error, undefined, `tools/list failed: ${JSON.stringify(list.error)}`);
      const tools = (list.result as { tools: Array<{ name: string; description?: string; inputSchema?: unknown }> })
        .tools;

      // The wire-visible set must be exactly the registry index.ts iterates.
      // Comparing against the export rather than a second pinned number means
      // adding a tool updates one place, and a tool that fails to register
      // (or registers under a shadowed name) shows up as a set difference.
      const overWire = tools.map((t) => t.name).sort();
      const registered = allTools.map((t) => t.name).sort();
      assert.deepEqual(overWire, registered, "tools/list does not match the allTools registry");

      // server.tool() is keyed by name, so a duplicate would have collapsed two
      // registrations into one and this length check would catch it.
      assert.equal(new Set(overWire).size, overWire.length, "tools/list contains a duplicate tool name");
      assert.equal(tools.length, allTools.length);

      // Every entry actually carries a usable schema -- a tool whose zod shape
      // failed to convert would still be listed.
      for (const tool of tools) {
        assert.ok(tool.description, `tool '${tool.name}' has no description`);
        assert.equal(typeof tool.inputSchema, "object", `tool '${tool.name}' has no inputSchema object`);
      }
    });
  });

  it("prints the ready line to stderr, and never to stdout", async () => {
    await withServer(async (server) => {
      await server.waitForStderr(/ready \(\d+ tools\)/);

      assert.match(
        server.stderr,
        new RegExp(`@yawlabs/aws-mcp v${PKG_VERSION.replace(/\./g, "\\.")} ready \\(${allTools.length} tools\\)`),
        `ready line missing or malformed: ${JSON.stringify(server.stderr)}`,
      );

      // Nothing at all on stdout before a request: the ready line is a
      // diagnostic, and a diagnostic on stdout is protocol corruption.
      assert.deepEqual(
        server.stdoutLines,
        [] as string[],
        `server wrote to stdout before any request: ${JSON.stringify(server.stdoutLines)}`,
      );

      // And it stays true across a real exchange.
      await server.initialize();
      await server.request("tools/list");
      assert.equal(
        server.stdoutLines.some((l) => l.includes("ready (")),
        false,
        "the ready line leaked onto stdout",
      );
    });
  });

  it("writes ONLY parseable JSON-RPC to stdout", async () => {
    await withServer(async (server) => {
      await server.initialize();
      await server.request("tools/list");
      // A tool call too: handler output flows through toMcpResult, and a
      // console.log in that path would corrupt the stream just as fatally.
      await server.request("tools/call", { name: "aws_session_get", arguments: {} });

      assert.ok(server.stdoutLines.length >= 3, `expected at least 3 stdout lines, got ${server.stdoutLines.length}`);
      for (const [i, line] of server.stdoutLines.entries()) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          assert.fail(
            `stdout line ${i} is not JSON -- a stray write to stdout desyncs the protocol reader: ${JSON.stringify(line.slice(0, 200))}`,
          );
        }
        assert.equal(
          (parsed as { jsonrpc?: string }).jsonrpc,
          "2.0",
          `stdout line ${i} is JSON but not a JSON-RPC message: ${JSON.stringify(line.slice(0, 200))}`,
        );
      }
    });
  });

  it("routes a tool call through the registration loop's success mapping", async () => {
    await withServer(
      async (server) => {
        await server.initialize();
        const reply = await server.request("tools/call", { name: "aws_session_get", arguments: {} });
        const result = toolResult(reply);

        assert.equal(result.isError, undefined, "a successful tool call must not set isError");
        assert.equal(result.content.length, 1);
        assert.equal(result.content[0].type, "text");
        // toMcpResult pretty-prints `data` at 2-space indent. The values are
        // the child's OWN env, which proves this is a real separate process.
        const data = JSON.parse(result.content[0].text) as Record<string, string>;
        assert.deepEqual(data, {
          profile: "itest-profile",
          region: "eu-north-1",
          profileSource: "env",
          regionSource: "env",
        });
      },
      { env: childEnv({ AWS_PROFILE: "itest-profile", AWS_REGION: "eu-north-1" }) },
    );
  });

  it("routes a rejected tool call through the registration loop's error mapping", async () => {
    await withServer(async (server) => {
      await server.initialize();
      // aws_session_set validates before mutating and returns ok:false; that
      // envelope has to reach the wire as isError:true + "Error: <msg>".
      // Purely local validation -- no AWS CLI is invoked.
      const reply = await server.request("tools/call", {
        name: "aws_session_set",
        arguments: { region: "NOT A REGION" },
      });
      const result = toolResult(reply);

      assert.equal(result.isError, true, "an ok:false handler result must surface as isError:true");
      assert.match(result.content[0].text, /^Error: Invalid region 'NOT A REGION'/);
    });
  });
});

describe("spawned server — version subcommand", () => {
  for (const arg of ["version", "--version"]) {
    it(`\`node dist/index.js ${arg}\` prints the version to stdout and exits 0`, async () => {
      await withServer(
        async (server) => {
          const { code, signal } = await server.runToExit();
          assert.equal(signal, null);
          assert.equal(code, 0, `expected exit 0, got ${code}. ${server.diagnostics()}`);
          assert.deepEqual(server.stdoutLines, [PKG_VERSION]);
          // process.exit(0) happens before the McpServer bootstrap, so no
          // transport is connected and no ready line is printed.
          assert.equal(server.stderr, "", `version mode printed to stderr: ${JSON.stringify(server.stderr)}`);
        },
        { argv: [arg] },
      );
    });
  }

  it("falls through to server mode for an argument it does not recognize", async () => {
    // Pins the important half of the gate: only the two exact spellings above
    // short-circuit. Anything else an MCP host tacks on must still get a
    // SERVER -- exiting silently on a stray arg is the hang this file exists
    // to prevent.
    await withServer(
      async (server) => {
        await server.waitForStderr(/ready \(\d+ tools\)/);
        const init = await server.initialize();
        assert.equal(init.error, undefined);
        assert.equal((init.result as { serverInfo: { name: string } }).serverInfo.name, "@yawlabs/aws-mcp");
      },
      { argv: ["-v"] },
    );
  });
});

describe("spawned server — symlinked bin (the realpath branch)", () => {
  it("boots when argv[1] is a SYMLINK to dist/index.js, not the file itself", { skip: symlinkSkip }, async () => {
    // This is how npm installs a bin: `npx -y @yawlabs/aws-mcp` and every
    // global install land on a symlink. Node resolves the main entry to its
    // realpath for import.meta.url but leaves argv[1] as the LINK, so the
    // exact-string URL compare in index.ts fails and only the realpath
    // resolution can conclude "yes, this is the entry point". Without it the
    // server registers nothing, prints nothing, and the host hangs forever.
    const dir = mkdtempSync(join(tmpdir(), "aws-mcp-symlink-"));
    const link = join(dir, "aws-mcp-bin.js");
    try {
      symlinkSync(SERVER_ENTRY, link, "file");
      await withServer(
        async (server) => {
          await server.waitForStderr(/ready \(\d+ tools\)/);
          // The "not starting" and "could not resolve" diagnostics both mean
          // the branch concluded wrong; neither may appear.
          assert.equal(server.stderr.includes("not starting"), false, server.stderr);
          assert.equal(server.stderr.includes("could not resolve"), false, server.stderr);

          const init = await server.initialize();
          assert.equal(init.error, undefined, `initialize over the symlink failed: ${JSON.stringify(init.error)}`);
          assert.equal((init.result as { serverInfo: { name: string } }).serverInfo.name, "@yawlabs/aws-mcp");

          const list = await server.request("tools/list");
          assert.equal((list.result as { tools: unknown[] }).tools.length, allTools.length);
        },
        { entry: link },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
