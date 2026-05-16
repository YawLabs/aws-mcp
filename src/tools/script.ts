import { createContext, runInContext } from "node:vm";
import { z } from "zod";
import { callTools } from "./call.js";
import { logsTools } from "./logs.js";
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
 * Trust model: this is NOT a security sandbox. We strip the most obvious
 * filesystem / process escape hatches (no require, no process, no fs, no
 * fetch, codeGeneration disabled so eval/Function are off) so a misled
 * model can't trivially exfiltrate credentials, but node:vm is not a
 * hardened boundary. Treat aws_script the same way you treat anything else
 * the model can already call -- the threat surface is "model writes JS that
 * calls our tools," not "untrusted code from the internet."
 *
 * Sandbox surface:
 *   aws.call({service, operation, params?, query?, profile?, region?,
 *             outputFormat?, timeoutMs?}) -> {command, result}
 *   aws.paginate({...}) -> {command, result, nextToken, hasMore}
 *   aws.paginateAll({...}) -> {items[], pages, count}  (auto-loops)
 *   aws.resource.{get,list,create,update,delete,status}({...})
 *   aws.logsTail({...})
 *   console.log/info/warn/error/debug -> captured into a buffer, returned
 *                                        with the result
 *   JSON, Math, Date, Promise, Array, Object, String, Number, Boolean, Error
 *
 * No require, no import, no process, no fs, no fetch, no setTimeout/Interval,
 * no globalThis. The script body is wrapped in `(async () => { ... })()`
 * so callers use `return <value>` to surface a result.
 */

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
const MAX_LOG_LINES = 500;
const MAX_LOG_LINE_BYTES = 4 * 1024;
const DEFAULT_MAX_PAGES = 50;
const MAX_PAGES_HARD_CAP = 1000;

/** Find a tool by name from one of the existing tool arrays. Throws if missing -- callers should hit this only at module load when the registries are stable. */
function findTool(name: string, source: readonly Tool[]): Tool {
  const t = source.find((x) => x.name === name);
  if (!t) throw new Error(`Internal: tool '${name}' not found in registry.`);
  return t;
}

/**
 * Translate a ToolResult into a thrown Error on failure or the unwrapped
 * data on success. Script authors get JS-natural error handling
 * (try/catch) instead of inspecting ok/error fields by hand.
 */
async function unwrap(tool: Tool, input: unknown): Promise<unknown> {
  const r = await tool.handler(input);
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

export interface PaginateAllInput {
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
    const maxPages = Math.min(input.maxPages ?? DEFAULT_MAX_PAGES, MAX_PAGES_HARD_CAP);
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
  resource: {
    get: (input: unknown) => Promise<unknown>;
    list: (input: unknown) => Promise<unknown>;
    create: (input: unknown) => Promise<unknown>;
    update: (input: unknown) => Promise<unknown>;
    delete: (input: unknown) => Promise<unknown>;
    status: (input: unknown) => Promise<unknown>;
  };
}

/** Build the production handler set from the real tool registries. Exposed so tests can substitute mocks via `runScript(opts, customHandlers)`. */
export function defaultScriptHandlers(): ScriptHandlers {
  const callTool = findTool("aws_call", callTools);
  const paginateTool = findTool("aws_paginate", paginateTools);
  const logsTailTool = findTool("aws_logs_tail", logsTools);
  const resourceGet = findTool("aws_resource_get", resourceTools);
  const resourceList = findTool("aws_resource_list", resourceTools);
  const resourceCreate = findTool("aws_resource_create", resourceTools);
  const resourceUpdate = findTool("aws_resource_update", resourceTools);
  const resourceDelete = findTool("aws_resource_delete", resourceTools);
  const resourceStatus = findTool("aws_resource_status", resourceTools);
  return {
    call: (input) => unwrap(callTool, input),
    paginate: (input) => unwrap(paginateTool, input),
    paginateAll: buildPaginateAll(paginateTool),
    logsTail: (input) => unwrap(logsTailTool, input),
    resource: {
      get: (input) => unwrap(resourceGet, input),
      list: (input) => unwrap(resourceList, input),
      create: (input) => unwrap(resourceCreate, input),
      update: (input) => unwrap(resourceUpdate, input),
      delete: (input) => unwrap(resourceDelete, input),
      status: (input) => unwrap(resourceStatus, input),
    },
  };
}

export interface RunScriptOptions {
  code: string;
  timeoutMs?: number;
}

export interface ScriptRunResult {
  data: unknown;
  logs: string[];
  truncatedLogs: boolean;
  durationMs: number;
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
        text.length > MAX_LOG_LINE_BYTES ? `${text.slice(0, MAX_LOG_LINE_BYTES)}... [line truncated]` : text;
      logs.push(`[${level}] ${capped}`);
    };

  // Realm-isolated context: passing an empty object to createContext gives
  // the script its OWN set of intrinsics (Object, Array, Promise, Error, ...).
  // A script that does `Object.prototype.polluted = 1` mutates the sandbox
  // realm's Object, not the host's -- the parent process stays clean. We then
  // pull JSON / Math / Date / Promise / Array / Object / String / Number /
  // Boolean / Error / console out of the FRESH context (via runInContext)
  // and rebind them on the same context so a script that names them as
  // globals gets the realm-local versions, not the host's.
  const ctx = createContext(
    {},
    {
      name: "aws_script",
      codeGeneration: { strings: false, wasm: false },
    },
  );

  // Grab the fresh realm's intrinsics. `runInContext` evaluates inside ctx,
  // so the values returned here are the sandbox's own constructors.
  const fresh = runInContext("({ JSON, Math, Date, Promise, Array, Object, String, Number, Boolean, Error })", ctx) as {
    JSON: typeof JSON;
    Math: typeof Math;
    Date: typeof Date;
    Promise: typeof Promise;
    Array: typeof Array;
    Object: typeof Object;
    String: typeof String;
    Number: typeof Number;
    Boolean: typeof Boolean;
    Error: typeof Error;
  };

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
    resource: {
      get: wrapForRealm(handlers.resource.get),
      list: wrapForRealm(handlers.resource.list),
      create: wrapForRealm(handlers.resource.create),
      update: wrapForRealm(handlers.resource.update),
      delete: wrapForRealm(handlers.resource.delete),
      status: wrapForRealm(handlers.resource.status),
    },
  };

  // Bind realm-local intrinsics + the AWS bridge + console + explicit
  // shadows onto the context's global object.
  Object.assign(ctx, {
    aws,
    JSON: fresh.JSON,
    Math: fresh.Math,
    Date: fresh.Date,
    Promise: fresh.Promise,
    Array: fresh.Array,
    Object: fresh.Object,
    String: fresh.String,
    Number: fresh.Number,
    Boolean: fresh.Boolean,
    Error: fresh.Error,
    console: {
      log: captureLog("log"),
      info: captureLog("info"),
      warn: captureLog("warn"),
      error: captureLog("error"),
      debug: captureLog("debug"),
    },
    // Node injects a handful of host globals into every new vm context
    // (Buffer, the timer APIs, queueMicrotask, AbortController, ...). The
    // ones that hand out filesystem / event-loop / process / network access
    // are explicitly shadowed here so `typeof Buffer === "undefined"` inside
    // the script -- a model that asks for them gets a ReferenceError.
    Buffer: undefined,
    process: undefined,
    require: undefined,
    setTimeout: undefined,
    setInterval: undefined,
    setImmediate: undefined,
    clearTimeout: undefined,
    clearInterval: undefined,
    clearImmediate: undefined,
    queueMicrotask: undefined,
    global: undefined,
    globalThis: undefined,
    // README claims no network access. node:vm doesn't inject fetch by
    // default, but Node's behaviour here has changed before -- shadow the
    // whole fetch surface explicitly so the contract is enforced by code,
    // not by a runtime default.
    fetch: undefined,
    Request: undefined,
    Response: undefined,
    Headers: undefined,
    AbortController: undefined,
    AbortSignal: undefined,
  });

  const timeoutMs = Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const wrappedSource = `(async () => {\n${opts.code}\n})()`;

  // Two-layer timeout: vm's `timeout` catches a synchronous infinite loop
  // before the IIFE yields its first microtask; Promise.race covers async
  // wall-clock once the IIFE has yielded. An async function that never
  // yields (e.g. `while(true) {}` before any `await`) is caught by the
  // first layer; an async function that yields then hangs is caught by the
  // second. A script that yields and then re-enters a sync infinite loop
  // between awaits is still possible to construct but requires arranging
  // the loop to fall behind the timeout's setTimeout entry on the event
  // loop -- documented limitation, not a security issue.
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
  } finally {
    clearTimeout(timer);
  }
}

export const scriptTools: readonly Tool[] = [
  {
    name: "aws_script",
    description:
      "Run a short JavaScript snippet that orchestrates other aws-mcp tools (aws.call, aws.paginate, aws.paginateAll, aws.resource.*, aws.logsTail) and returns a combined result. Best for batched read+filter+aggregate workflows that would otherwise need N tool round-trips: 'list all Lambdas, fetch each one's config, return those with memory > 1024'. Use `return <value>` at the end to surface a result; console.log lines are captured and returned alongside. Helpers throw Errors on failure -- use try/catch. NOT a security sandbox -- treat the same as any other tool the model can call.",
    annotations: {
      title: "Run a JS snippet that orchestrates AWS tool calls",
      // The script may invoke destructive tools (resource.create/update/delete)
      // so we conservatively annotate as non-read-only.
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      code: z
        .string()
        .min(1)
        .describe(
          "JavaScript snippet evaluated inside `(async () => { ... })()`. Use `return <value>` to surface a result. Globals: aws.call, aws.paginate, aws.paginateAll, aws.resource.{get,list,create,update,delete,status}, aws.logsTail, JSON, Math, Date, Promise, Array, Object, String, Number, Boolean, Error, console. No require/import/process/fs/fetch/setTimeout/globalThis. Tool helpers throw on failure -- wrap in try/catch when you want to handle errors per-call.",
        ),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(MAX_TIMEOUT_MS)
        .optional()
        .describe(
          `Wall-clock timeout in milliseconds. Default ${DEFAULT_TIMEOUT_MS}; max ${MAX_TIMEOUT_MS}. Covers evaluation plus every awaited aws.* call.`,
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
        const message = err instanceof Error ? err.message : String(err);
        const rawBody =
          err instanceof Error && typeof (err as Error & { rawBody?: string }).rawBody === "string"
            ? (err as Error & { rawBody?: string }).rawBody
            : undefined;
        return { ok: false, error: message, rawBody };
      }
    },
  },
];
