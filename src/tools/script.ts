import { createContext, runInContext } from "node:vm";
import { z } from "zod";
import { assumeTools } from "./assume.js";
import { callTools } from "./call.js";
import { docsTools } from "./docs.js";
import { iamSimulateTools } from "./iam-simulate.js";
import { logsTools } from "./logs.js";
import { metricsTools } from "./metrics.js";
import { multiRegionTools } from "./multi-region.js";
import { paginateTools } from "./paginate.js";
import { resourceTools } from "./resource.js";
import type { Tool, ToolResult } from "./tool.js";

/**
 * aws_script lets the agent batch multiple AWS tool calls and shape the
 * combined result in a single round-trip. Each tool call from inside a
 * script is still a real handler invocation -- no shortcut -- but the agent
 * doesn't have to ping-pong through N MCP tool calls and intermediate
 * context.
 *
 * Trust model: this is NOT a security sandbox, and the vm context does NOT
 * contain a determined script. `require`, `process`, `fs` and `fetch` are
 * absent as bare globals, and `codeGeneration.strings: false` turns off the
 * in-realm `eval` / `Function` -- enough to stop an ACCIDENTAL reach for them,
 * and nothing more (see ESCAPE IS REACHABLE below). Treat aws_script exactly
 * the way you treat anything else the model can already call -- the threat
 * surface is "model writes JS that calls our tools," not "untrusted code from
 * the internet" -- and rely on IAM, not on this file, for what any of it is
 * permitted to do.
 *
 * ESCAPE IS REACHABLE (measured on Node 22, against the shipped build): the
 * in-realm code-generation block is real but partial. `Function('return
 * this')()` does throw EvalError -- that half holds. What it does not cover is
 * the bridge: every function bound onto the context (aws.*, the console
 * capture fns) is a HOST closure whose prototype chain never entered the
 * sandbox, so `console.log.constructor` IS the HOST realm's `Function`, not
 * the sandbox's. Compiling through it happens in the host realm, where
 * `codeGeneration.strings` does not apply:
 * `console.log.constructor('return process')()` returns the real host
 * `process` object (the probe read back the host pid exactly), and from there
 * `process.getBuiltinModule('fs')` and `('child_process')` are both reachable.
 * Any aws.* helper is the same door. So: host process, fs and child_process
 * ARE reachable from inside a script. The shadow entry and the codeGeneration
 * flags raise the bar on the obvious paths; they are not a boundary, and
 * nothing in this file is.
 *
 * RUNTIME CAVEAT (oam.js): `codeGeneration: { strings: false }` is honored by
 * Node but NOT by oam -- under oam, `eval` and `Function` still work inside the
 * context. Measured, not assumed, and re-measured against oam 0.9.0: still
 * divergent, so this is a standing difference rather than a bug awaiting a fix.
 * Given the bridge-constructor path above, that divergence changes how
 * convenient an escape is, not whether one exists. Do not treat the
 * codeGeneration flag as a portable guarantee.
 *
 * Sandbox surface (explicitly bound):
 *   aws.call({service, operation, params?, query?, profile?, region?,
 *             outputFormat?, timeoutMs?}) -> {command, result}
 *   aws.paginate({...}) -> {command, result, nextToken, hasMore}
 *   aws.paginateAll({...}) -> {items[], pages, count}  (auto-loops)
 *   aws.resource.{get,list,create,update,delete,status,diff}({...})
 *   aws.logsTail({...})
 *   aws.metricsQuery({...})
 *   aws.iamSimulate({...})
 *   aws.multiRegion({...})
 *   aws.assumeRole({...})
 *   aws.docs.{search,read}({...})
 *   console.log/info/warn/error/debug -> captured into a buffer, returned
 *                                        with the result
 *   Realm-local intrinsics (JSON, Math, Date, Promise, Array, Object, String,
 *     Number, Boolean, Error, ...) come free with `createContext({})` -- the
 *     fresh realm brings its own set, so a script that mutates
 *     `Object.prototype` dirties only the sandbox's Object.
 *
 * Intentionally NOT bound (run as separate MCP tool calls):
 *   - aws_list_profiles, aws_whoami, aws_login_start, aws_login_complete,
 *     aws_refresh_if_expiring_soon, aws_session_*
 *   - aws_script itself (no self-recursion)
 * Auth/session/profile tools are intentionally not bound -- they reshape
 * process-wide state that doesn't compose with scripted orchestration.
 * aws_script self-recursion is also off the table for the same reason a
 * shell script doesn't embed a second copy of itself.
 *
 * Explicitly shadowed (made `undefined`): `globalThis`, and only that. It is
 * an ECMAScript intrinsic, so it is present in every realm and would hand a
 * script a live handle on its own global object; nothing else needs
 * shadowing because nothing else is there. Probed on Node 22: a bare
 * `vm.createContext({})` carries `globalThis`, `console`, `Intl`,
 * `WebAssembly`, `Atomics`, `SharedArrayBuffer` and the ECMAScript
 * intrinsics -- and nothing else. `Buffer`, `process`, `require`, the
 * timer/clear functions, `queueMicrotask`, `global`, `fetch` / `Request` /
 * `Response` / `Headers`, `AbortController` / `AbortSignal` and
 * `BroadcastChannel` are all absent already, so the old entries for them
 * were no-ops.
 *
 * Node-injected vm-context globals left available: `Intl`, `WebAssembly`
 * (with `compile`/`instantiate` blocked by `codeGeneration.wasm: false`),
 * `Atomics`, `SharedArrayBuffer`. All pure-compute APIs with no
 * filesystem/network/event-loop reach.
 *
 * Everything else -- `URL`, `URLSearchParams`, `TextEncoder`, `TextDecoder`,
 * `crypto`, `structuredClone`, `EventTarget`, `MessageChannel`,
 * `performance`, `fs`, plus every name in the ex-shadow list above -- is
 * absent by default, so a bare reference is a ReferenceError and `typeof`
 * reports "undefined". `import` is likewise unavailable: a bare `import`
 * statement is a syntax error in the non-module script body, and dynamic
 * `import()` is off because `codeGeneration` is disabled. Re-run the probe if
 * a future Node release starts injecting a global with reach beyond compute
 * (a `webcrypto.subtle`-style key store, a thread spawner, ...) -- absence is
 * the contract here, and it is a runtime fact, not a list this file owns.
 *
 * The script body is wrapped in `(async () => { ... })()` so callers use
 * `return <value>` to surface a result.
 */

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
const MAX_LOG_LINES = 500;
const MAX_LOG_LINE_CHARS = 4 * 1024;
const DEFAULT_MAX_PAGES = 50;
const MAX_PAGES_HARD_CAP = 1000;

/** Find a tool by name from one of the existing tool arrays. Throws if missing -- callers should hit this only at module load when the registries are stable. */
function findTool(name: string, source: readonly Tool[]): Tool {
  const t = source.find((x) => x.name === name);
  if (!t) throw new Error(`Internal: tool '${name}' not found in registry.`);
  return t;
}

/**
 * Render a Zod failure as a compact one-liner. `ZodError.message` is a
 * JSON-encoded issue array -- readable by a machine, noise for a model reading
 * an error string. Duck-type on `.issues` rather than `instanceof z.ZodError`
 * so this keeps working across zod major versions.
 */
function formatSchemaError(err: unknown): string {
  // Guard before the property read: `(null).issues` throws a TypeError, which
  // would replace the schema error with an unrelated crash from inside the
  // error FORMATTER. Not reachable today (.parse only throws ZodError), but a
  // helper whose whole job is rendering someone else's failure must not be able
  // to fail itself.
  if (!err || typeof err !== "object") return String(err);
  const issues = (err as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return err instanceof Error ? err.message : String(err);
  return issues
    .map((raw) => {
      const it = raw as { path?: unknown[]; message?: unknown };
      const path = Array.isArray(it.path) && it.path.length > 0 ? it.path.join(".") : "(root)";
      return `${path}: ${typeof it.message === "string" ? it.message : "invalid"}`;
    })
    .join("; ");
}

/**
 * Validate against the tool's own schema, then translate the ToolResult into a
 * thrown Error on failure or the unwrapped data on success. Script authors get
 * JS-natural error handling (try/catch) instead of inspecting ok/error fields.
 *
 * The parse is load-bearing, not belt-and-braces. The MCP boundary validates in
 * index.ts via `server.tool(..., tool.inputSchema.shape, ...)`, but THIS bridge
 * calls `tool.handler` directly -- so without a parse here, every cap that
 * lives only in a Zod schema is unenforced for anything a script calls.
 * Measured before this existed: `aws.multiRegion({regions: [...40 regions]})`
 * spawned all 40 CLI subprocesses despite the schema's `.max(32)`, and
 * `aws.resource.list({maxResults: 5000})` sent `--max-results 5000` despite
 * `.max(100)`.
 *
 * Argv-safety was never at risk either way -- those validators (SAFE_NAME_RE,
 * PROFILE_NAME_RE, TYPE_NAME_RE, isValidIdentifier, ...) all run inside the
 * handlers. What this restores is the RESOURCE BOUNDS.
 *
 * Parsed (not raw) input is forwarded, so schema defaults and coercions apply
 * to scripted calls exactly as they do to MCP calls. Unknown keys are stripped
 * by zod's default object behavior -- which is what lets buildPaginateAll pass
 * its own `maxPages` through without the paginate tool ever seeing it.
 */
async function unwrap(tool: Tool, input: unknown): Promise<unknown> {
  let parsed: unknown;
  try {
    parsed = tool.inputSchema.parse(input);
  } catch (err) {
    const e = new Error(`Invalid input for '${tool.name}': ${formatSchemaError(err)}`) as Error & {
      toolName?: string;
    };
    e.toolName = tool.name;
    throw e;
  }
  const r = await tool.handler(parsed);
  if (!r.ok) {
    const e = new Error(r.error || `Tool '${tool.name}' failed`) as Error & {
      rawBody?: string;
      toolName?: string;
    };
    if (r.rawBody) e.rawBody = r.rawBody;
    e.toolName = tool.name;
    throw e;
  }
  return r.data;
}

/**
 * Mirror of aws_paginate's input schema, minus fields the auto-loop manages
 * itself (`startingToken`) and minus fields aws_paginate doesn't expose
 * today (`outputFormat` -- aws_paginate hard-codes JSON because the wrapper
 * needs to parse the response shape for next-token extraction). If
 * aws_paginate ever surfaces outputFormat, add it here too -- this interface
 * intentionally tracks the aws_paginate surface 1:1 to avoid silently
 * dropping a field a script author passed.
 */
interface PaginateAllInput {
  service: string;
  operation: string;
  params?: Record<string, unknown>;
  query?: string;
  maxItems?: number;
  profile?: string;
  region?: string;
  timeoutMs?: number;
  maxPages?: number;
}

/**
 * Loop aws_paginate until hasMore=false or the per-call maxPages safety cap.
 * Concatenates `items` (when a query is provided) or `result` (raw page body)
 * across pages. Most-common script use case -- worth bundling so callers
 * don't reimplement the loop every time.
 */
export function buildPaginateAll(paginateTool: Tool) {
  return async (input: PaginateAllInput) => {
    // Floor of 1, not just a ceiling: without it `maxPages: 0` (or a negative)
    // skipped the loop entirely and returned {items: [], pages: 0} as a
    // SUCCESS -- an empty result that reads like "the list is empty" rather
    // than "you asked for zero pages". One page is the smallest request that
    // can answer anything, so clamp up to it.
    const maxPages = Math.max(1, Math.min(input.maxPages ?? DEFAULT_MAX_PAGES, MAX_PAGES_HARD_CAP));
    let token: string | undefined;
    const items: unknown[] = [];
    let pages = 0;
    for (let i = 0; i < maxPages; i++) {
      pages++;
      const data = (await unwrap(paginateTool, {
        ...input,
        startingToken: token,
      })) as {
        result: unknown;
        nextToken: string | null;
        hasMore: boolean;
      };
      if (Array.isArray(data.result)) {
        items.push(...data.result);
      } else if (data.result !== null && data.result !== undefined) {
        items.push(data.result);
      }
      if (!data.hasMore || !data.nextToken) break;
      token = data.nextToken;
    }
    return { items, pages, count: items.length };
  };
}

export interface ScriptHandlers {
  call: (input: unknown) => Promise<unknown>;
  paginate: (input: unknown) => Promise<unknown>;
  paginateAll: (input: PaginateAllInput) => Promise<unknown>;
  logsTail: (input: unknown) => Promise<unknown>;
  metricsQuery: (input: unknown) => Promise<unknown>;
  iamSimulate: (input: unknown) => Promise<unknown>;
  multiRegion: (input: unknown) => Promise<unknown>;
  assumeRole: (input: unknown) => Promise<unknown>;
  resource: {
    get: (input: unknown) => Promise<unknown>;
    list: (input: unknown) => Promise<unknown>;
    create: (input: unknown) => Promise<unknown>;
    update: (input: unknown) => Promise<unknown>;
    delete: (input: unknown) => Promise<unknown>;
    status: (input: unknown) => Promise<unknown>;
    diff: (input: unknown) => Promise<unknown>;
  };
  docs: {
    search: (input: unknown) => Promise<unknown>;
    read: (input: unknown) => Promise<unknown>;
  };
}

/** Build the production handler set from the real tool registries. Tests substitute mocks via `runScript(opts, customHandlers)` instead of calling this. */
function defaultScriptHandlers(): ScriptHandlers {
  const callTool = findTool("aws_call", callTools);
  const paginateTool = findTool("aws_paginate", paginateTools);
  const logsTailTool = findTool("aws_logs_tail", logsTools);
  const metricsQueryTool = findTool("aws_metrics_query", metricsTools);
  const iamSimulateTool = findTool("aws_iam_simulate", iamSimulateTools);
  const multiRegionTool = findTool("aws_multi_region", multiRegionTools);
  const assumeRoleTool = findTool("aws_assume_role", assumeTools);
  const docsSearchTool = findTool("aws_docs_search", docsTools);
  const docsReadTool = findTool("aws_docs_read", docsTools);
  const resourceGet = findTool("aws_resource_get", resourceTools);
  const resourceList = findTool("aws_resource_list", resourceTools);
  const resourceCreate = findTool("aws_resource_create", resourceTools);
  const resourceUpdate = findTool("aws_resource_update", resourceTools);
  const resourceDelete = findTool("aws_resource_delete", resourceTools);
  const resourceStatus = findTool("aws_resource_status", resourceTools);
  const resourceDiff = findTool("aws_resource_diff", resourceTools);
  return {
    call: (input) => unwrap(callTool, input),
    paginate: (input) => unwrap(paginateTool, input),
    paginateAll: buildPaginateAll(paginateTool),
    logsTail: (input) => unwrap(logsTailTool, input),
    metricsQuery: (input) => unwrap(metricsQueryTool, input),
    iamSimulate: (input) => unwrap(iamSimulateTool, input),
    multiRegion: (input) => unwrap(multiRegionTool, input),
    assumeRole: (input) => unwrap(assumeRoleTool, input),
    resource: {
      get: (input) => unwrap(resourceGet, input),
      list: (input) => unwrap(resourceList, input),
      create: (input) => unwrap(resourceCreate, input),
      update: (input) => unwrap(resourceUpdate, input),
      delete: (input) => unwrap(resourceDelete, input),
      status: (input) => unwrap(resourceStatus, input),
      // aws_resource_diff is the preview half of preview-then-update, which
      // is exactly the composition a script is for: diff, inspect `changes`,
      // then call aws.resource.update with the same patch only if it looks
      // right. Leaving it unbound forced that round-trip back out to the MCP
      // boundary.
      diff: (input) => unwrap(resourceDiff, input),
    },
    docs: {
      search: (input) => unwrap(docsSearchTool, input),
      read: (input) => unwrap(docsReadTool, input),
    },
  };
}

interface RunScriptOptions {
  code: string;
  timeoutMs?: number;
}

interface ScriptRunResult {
  data: unknown;
  logs: string[];
  truncatedLogs: boolean;
  durationMs: number;
}

/**
 * An Error escaping `runScript` carries whatever the script logged before it
 * died. A script that times out or throws is exactly when those lines matter
 * most -- they're the only trace of how far it got -- so they ride out on the
 * error rather than being dropped with the rejected promise.
 */
interface ScriptFailure extends Error {
  logs?: string[];
  truncatedLogs?: boolean;
  durationMs?: number;
  rawBody?: string;
}

/**
 * Duck-type, not `instanceof Error` -- vm's own timeout error is built in
 * another realm, so `instanceof` says false for it (measured: `e.name ===
 * "Error"`, `e.message === "Script execution timed out after 200ms"`, and
 * `e instanceof Error === false`). The exact error a timed-out script
 * produces is the one whose logs matter most, so the check has to recognize
 * it. A thrown string or a plain data object has no string `message` and is
 * left alone, preserving the documented "non-Error throws pass through
 * unchanged" contract.
 */
function isErrorLike(v: unknown): v is ScriptFailure {
  return typeof v === "object" && v !== null && typeof (v as { message?: unknown }).message === "string";
}

export async function runScript(
  opts: RunScriptOptions,
  handlers: ScriptHandlers = defaultScriptHandlers(),
): Promise<ScriptRunResult> {
  const logs: string[] = [];
  let truncatedLogs = false;
  const captureLog =
    (level: string) =>
    (...args: unknown[]) => {
      if (logs.length >= MAX_LOG_LINES) {
        truncatedLogs = true;
        return;
      }
      const text = args
        .map((a) => {
          if (typeof a === "string") return a;
          try {
            return JSON.stringify(a);
          } catch {
            // Second fallback can also throw -- e.g. an object whose
            // `toString` / `@@toPrimitive` throws will make `String(a)` throw.
            // Swallow that and emit a sentinel rather than crashing the log
            // capture (which would crash the whole script).
            try {
              return String(a);
            } catch {
              return "[unrepresentable]";
            }
          }
        })
        .join(" ");
      const capped =
        text.length > MAX_LOG_LINE_CHARS ? `${text.slice(0, MAX_LOG_LINE_CHARS)}... [line truncated]` : text;
      logs.push(`[${level}] ${capped}`);
    };

  // Realm-isolated context: passing an empty object to createContext gives
  // the script its OWN set of intrinsics (Object, Array, Promise, Error, ...).
  // A script that does `Object.prototype.polluted = 1` mutates the sandbox
  // realm's Object, not the host's -- the parent process stays clean. That
  // isolation is a property of the fresh realm alone; this file does not have
  // to do anything to get it. (An earlier version read JSON / Math / Date /
  // Promise / Array / Object / String / Number / Boolean out of the context
  // and assigned them straight back onto it, which was credited with the
  // isolation above. Probed: the values are identical before and after, so
  // the round-trip was a no-op -- the realm was already local.)
  const ctx = createContext(
    {},
    {
      name: "aws_script",
      codeGeneration: { strings: false, wasm: false },
    },
  );

  // The one read that IS load-bearing: `wrapForRealm` below needs the
  // sandbox's own Error constructor so a bridge failure arrives as something
  // a script-side `e instanceof Error` recognizes. `runInContext` evaluates
  // inside ctx, so this is the realm's constructor, not the host's.
  const fresh = runInContext("({ Error })", ctx) as { Error: typeof Error };

  // Bridge handlers throw host-realm Error instances (created in `unwrap`
  // above, or anywhere else inside the bridge that uses `new Error(...)`).
  // Those instances have the HOST Error.prototype on their chain, so a
  // script-side `e instanceof Error` -- which compares against the
  // REALM-FRESH Error -- returns false. That breaks the documented
  // try/catch + instanceof pattern script authors expect.
  //
  // Wrap every bridge entry so any thrown host Error is re-thrown as a
  // fresh.Error with the same message and enumerable custom props
  // (rawBody, toolName, ...). Non-Error throws (strings, primitives,
  // null/undefined, plain objects) pass through unchanged -- the script
  // sees them as-is, just like host JS would.
  const wrapForRealm =
    <Args extends unknown[], R>(fn: (...args: Args) => Promise<R>): ((...args: Args) => Promise<R>) =>
    async (...args: Args) => {
      try {
        return await fn(...args);
      } catch (err) {
        if (err instanceof Error) {
          const out = new fresh.Error(err.message);
          // Copy enumerable own props (rawBody, toolName, anything else
          // the bridge attached) onto the realm-fresh error.
          for (const key of Object.keys(err)) {
            (out as unknown as Record<string, unknown>)[key] = (err as unknown as Record<string, unknown>)[key];
          }
          throw out;
        }
        throw err;
      }
    };

  const aws = {
    call: wrapForRealm(handlers.call),
    paginate: wrapForRealm(handlers.paginate),
    paginateAll: wrapForRealm(handlers.paginateAll as (input: unknown) => Promise<unknown>),
    logsTail: wrapForRealm(handlers.logsTail),
    metricsQuery: wrapForRealm(handlers.metricsQuery),
    iamSimulate: wrapForRealm(handlers.iamSimulate),
    multiRegion: wrapForRealm(handlers.multiRegion),
    assumeRole: wrapForRealm(handlers.assumeRole),
    resource: {
      get: wrapForRealm(handlers.resource.get),
      list: wrapForRealm(handlers.resource.list),
      create: wrapForRealm(handlers.resource.create),
      update: wrapForRealm(handlers.resource.update),
      delete: wrapForRealm(handlers.resource.delete),
      status: wrapForRealm(handlers.resource.status),
      diff: wrapForRealm(handlers.resource.diff),
    },
    docs: {
      search: wrapForRealm(handlers.docs.search),
      read: wrapForRealm(handlers.docs.read),
    },
  };

  // Bind the AWS bridge + the capturing console + the one real shadow onto
  // the context's global object.
  Object.assign(ctx, {
    aws,
    console: {
      log: captureLog("log"),
      info: captureLog("info"),
      warn: captureLog("warn"),
      error: captureLog("error"),
      debug: captureLog("debug"),
    },
    // `globalThis` is an ECMAScript intrinsic, so it exists in every realm --
    // this is the only entry here that shadows something actually present.
    // The block used to carry 18 more (Buffer, process, require, the
    // timer/clear family, queueMicrotask, global, fetch/Request/Response/
    // Headers, AbortController/AbortSignal, BroadcastChannel). Probed on Node
    // 22: `createContext({})` injects NONE of them -- a bare context has only
    // globalThis, console, Intl, WebAssembly, Atomics, SharedArrayBuffer and
    // the ECMAScript intrinsics -- so all 18 were assigning `undefined` over
    // nothing. Absence already gives the same script-visible result (bare
    // reference -> ReferenceError, `typeof` -> "undefined"), so they are gone
    // rather than restated. If a future Node release starts injecting one,
    // this is where it would go back.
    globalThis: undefined,
  });

  const timeoutMs = Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const wrappedSource = `(async () => {\n${opts.code}\n})()`;

  // Two-layer timeout, with a hole between the layers that nothing here
  // closes. vm's `timeout` only measures SYNCHRONOUS evaluation: its window
  // shuts the moment the IIFE yields at its first `await`. Promise.race then
  // covers async wall-clock -- but only while the event loop is free to run
  // the timer callback. So a synchronous loop placed AFTER any `await`
  // escapes both: the vm window has already closed, and the timer cannot fire
  // because the loop owns the thread. No arranging is required -- an `await`
  // followed by a spin loop is enough, and it is the natural shape (fetch,
  // then process). Measured: a spin loop after one await ran 4001ms against a
  // 1000ms timeout, and `while (true) {}` after an await wedges the server
  // permanently -- no timeout fires, and nothing short of a restart recovers
  // it. A synchronous loop BEFORE the first await is still caught by the vm
  // layer. Known hole; fixing it means moving execution off this thread.
  const started = Date.now();
  // Hoist the reject so setTimeout can be created OUTSIDE the Promise
  // executor. The previous shape (let timer; new Promise(() => { timer =
  // setTimeout(...) }); timer.unref()) only worked because Promise executors
  // run synchronously, so `timer` was always defined by the time the unref
  // line ran. Removing that ordering dependency means a future reorder
  // (moving the unref into an async block, or restructuring the Promise)
  // can't silently leak a ref'd handle that pins the event loop.
  let timeoutReject!: (err: Error) => void;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutReject = reject;
  });
  const timer = setTimeout(() => {
    timeoutReject(
      new Error(`Script timed out after ${Math.round(timeoutMs / 1000)}s. Raise timeoutMs or trim the script.`),
    );
  }, timeoutMs);
  timer.unref();

  try {
    const evalResult = runInContext(wrappedSource, ctx, {
      timeout: timeoutMs,
      filename: "aws_script",
    }) as Promise<unknown>;
    const data = await Promise.race([evalResult, timeoutPromise]);
    return { data, logs, truncatedLogs, durationMs: Date.now() - started };
  } catch (err) {
    // Carry the captured output out with the failure. On a timeout the logs
    // are the only record of how far the script got before it stalled, and
    // they were previously discarded with the rejected promise. Non-Error
    // throws pass through untouched -- scripts can throw primitives, and the
    // documented contract is that those reach the caller unchanged.
    if (isErrorLike(err)) {
      try {
        err.logs = logs;
        err.truncatedLogs = truncatedLogs;
        err.durationMs = Date.now() - started;
      } catch {
        // Frozen or sealed error object: nothing to attach to. The failure
        // itself still propagates -- losing the logs beats losing the error.
      }
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export const scriptTools: readonly Tool[] = [
  {
    name: "aws_script",
    description:
      "Run a short JavaScript snippet that orchestrates other aws-mcp tools (aws.call, aws.paginate, aws.paginateAll, aws.resource.*, aws.logsTail, aws.metricsQuery, aws.iamSimulate, aws.multiRegion, aws.assumeRole, aws.docs.{search,read}) and returns a combined result. Best for batched read+filter+aggregate workflows that would otherwise need N tool round-trips: 'list all Lambdas, fetch each one's config, return those with memory > 1024'. Use `return <value>` at the end to surface a result; console.log lines are captured and returned alongside. Helpers throw Errors on failure -- use try/catch. NOT a security sandbox -- treat the same as any other tool the model can call.",
    annotations: {
      title: "Run a JS snippet that orchestrates AWS tool calls",
      // The script may invoke destructive tools (resource.create/update/delete)
      // so annotate the worst case honestly: non-read-only AND destructive.
      // Cautious clients may confirm read-only scripts too -- acceptable cost;
      // an unflagged delete is not.
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      code: z
        .string()
        .min(1)
        .describe(
          "JavaScript snippet evaluated inside `(async () => { ... })()`. Use `return <value>` to surface a result. Bound globals: aws.call, aws.paginate, aws.paginateAll, aws.resource.{get,list,create,update,delete,status,diff}, aws.logsTail, aws.metricsQuery, aws.iamSimulate, aws.multiRegion, aws.assumeRole, aws.docs.{search,read}, console (capture), JSON, Math, Date, Promise, Array, Object, String, Number, Boolean, Error, Intl, Atomics, SharedArrayBuffer, WebAssembly (compile blocked). Intentionally NOT bound (call as sibling MCP tools instead): aws_list_profiles, the auth/session tools, and aws_script itself. Shadowed (undefined): globalThis. NOT available (ReferenceError if referenced, `typeof` reports 'undefined'): require, process, Buffer, global, fetch/Request/Response/Headers, AbortController/AbortSignal, BroadcastChannel, setTimeout/setInterval/setImmediate and their clear* pairs, queueMicrotask, URL, URLSearchParams, TextEncoder, TextDecoder, crypto, structuredClone, EventTarget, MessageChannel, performance, fs, import. The in-realm eval/Function are disabled under Node (codeGeneration off) and remain callable under the oam.js runtime; either way this is not a security boundary -- write scripts as if they run with the server's full authority, because they do. Tool helpers throw on failure -- wrap in try/catch when you want to handle errors per-call.",
        ),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(MAX_TIMEOUT_MS)
        .optional()
        .describe(
          `Wall-clock timeout in milliseconds. Default ${DEFAULT_TIMEOUT_MS}; max ${MAX_TIMEOUT_MS}. Best-effort: it fires on synchronous spin BEFORE the first await, and on async wall-clock once the script has yielded. It does NOT fire on a synchronous loop placed after an await -- that loop holds the thread, so the timer never runs and the call hangs until the process is restarted. Keep post-await work non-blocking. On timeout the script stops being awaited and the tool returns an error (with the console lines captured so far), but any aws.* call already in flight is NOT cancelled -- it continues until its own per-call timeout (default 60s). Plan retries accordingly: a script that timed out mid 'resource.delete' may have completed the delete; re-issuing the same script can double-mutate.`,
        ),
    }),
    handler: async (input: unknown): Promise<ToolResult> => {
      const i = input as { code: string; timeoutMs?: number };
      try {
        const r = await runScript({ code: i.code, timeoutMs: i.timeoutMs });
        return {
          ok: true,
          data: {
            result: r.data,
            logs: r.logs,
            truncatedLogs: r.truncatedLogs,
            durationMs: r.durationMs,
          },
        };
      } catch (err) {
        // isErrorLike, not instanceof: vm's cross-realm timeout error fails
        // `instanceof Error` (see the note on isErrorLike), and `String(err)`
        // on it prepends a redundant "Error: " to the message.
        const failure = isErrorLike(err) ? err : undefined;
        const message = failure ? failure.message : String(err);
        const logs = failure?.logs ?? [];
        const truncatedLogs = failure?.truncatedLogs ?? false;
        // The captured lines go out on rawBody as well as on `data`: index.ts
        // renders only `error` + `rawBody` for a failed ToolResult, so logs
        // left in `data` alone would never reach the model -- and a timeout is
        // exactly when it wants to see how far the script got.
        const logBody = logs.length
          ? `Captured console output before the failure (${logs.length} line(s)${truncatedLogs ? ", truncated" : ""}):\n${logs.join("\n")}`
          : undefined;
        const toolRawBody = typeof failure?.rawBody === "string" ? failure.rawBody : undefined;
        const rawBody = [toolRawBody, logBody].filter((s): s is string => Boolean(s)).join("\n\n");
        return {
          ok: false,
          error: message,
          rawBody: rawBody || undefined,
          data: { logs, truncatedLogs, durationMs: failure?.durationMs },
        };
      }
    },
  },
];
