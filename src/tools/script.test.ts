import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { buildPaginateAll, runScript, type ScriptHandlers, scriptTools } from "./script.js";
import type { Tool } from "./tool.js";

/**
 * Values returned from the vm sandbox carry the vm realm's prototypes, not
 * the outer realm's, so `assert.deepEqual` (strict) rejects them even when
 * structurally identical. JSON round-trip strips the prototype so assertions
 * compare plain values.
 */
function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

const tool = scriptTools.find((t) => t.name === "aws_script");
if (!tool) throw new Error("scriptTools missing aws_script");

/**
 * Build a fresh mock handler set per test. Each method records the calls it
 * received and returns whatever the test scripted. Tests that don't supply a
 * handler get a default that throws -- catching scripts that reach for tools
 * the test didn't intend to mock.
 */
function makeMockHandlers(overrides: Partial<ScriptHandlers> = {}): {
  handlers: ScriptHandlers;
  calls: { method: string; input: unknown }[];
} {
  const calls: { method: string; input: unknown }[] = [];
  const record = (method: string, fn: (input: unknown) => Promise<unknown>) => async (input: unknown) => {
    calls.push({ method, input });
    return fn(input);
  };
  const notImpl = (name: string) => async () => {
    throw new Error(`mock: ${name} not stubbed`);
  };
  const defaults: ScriptHandlers = {
    call: notImpl("call"),
    paginate: notImpl("paginate"),
    paginateAll: notImpl("paginateAll"),
    logsTail: notImpl("logsTail"),
    resource: {
      get: notImpl("resource.get"),
      list: notImpl("resource.list"),
      create: notImpl("resource.create"),
      update: notImpl("resource.update"),
      delete: notImpl("resource.delete"),
      status: notImpl("resource.status"),
    },
  };
  const merged: ScriptHandlers = {
    call: overrides.call ? record("call", overrides.call) : defaults.call,
    paginate: overrides.paginate ? record("paginate", overrides.paginate) : defaults.paginate,
    paginateAll: overrides.paginateAll
      ? (record(
          "paginateAll",
          overrides.paginateAll as (input: unknown) => Promise<unknown>,
        ) as ScriptHandlers["paginateAll"])
      : defaults.paginateAll,
    logsTail: overrides.logsTail ? record("logsTail", overrides.logsTail) : defaults.logsTail,
    resource: {
      get: overrides.resource?.get ? record("resource.get", overrides.resource.get) : defaults.resource.get,
      list: overrides.resource?.list ? record("resource.list", overrides.resource.list) : defaults.resource.list,
      create: overrides.resource?.create
        ? record("resource.create", overrides.resource.create)
        : defaults.resource.create,
      update: overrides.resource?.update
        ? record("resource.update", overrides.resource.update)
        : defaults.resource.update,
      delete: overrides.resource?.delete
        ? record("resource.delete", overrides.resource.delete)
        : defaults.resource.delete,
      status: overrides.resource?.status
        ? record("resource.status", overrides.resource.status)
        : defaults.resource.status,
    },
  };
  return { handlers: merged, calls };
}

describe("aws_script schema", () => {
  it("accepts a minimal call with just code", () => {
    const r = tool.inputSchema.safeParse({ code: "return 1;" });
    assert.equal(r.success, true);
  });

  it("rejects empty code", () => {
    const r = tool.inputSchema.safeParse({ code: "" });
    assert.equal(r.success, false);
  });

  it("accepts an explicit timeoutMs", () => {
    const r = tool.inputSchema.safeParse({ code: "return 1;", timeoutMs: 5000 });
    assert.equal(r.success, true);
  });

  it("rejects timeoutMs above the 5-minute hard cap", () => {
    const r = tool.inputSchema.safeParse({ code: "return 1;", timeoutMs: 10 * 60_000 });
    assert.equal(r.success, false);
  });
});

describe("runScript synchronous evaluation", () => {
  it("returns the value of a `return` statement", async () => {
    const { handlers } = makeMockHandlers();
    const r = await runScript({ code: "return 42;" }, handlers);
    assert.equal(r.data, 42);
  });

  it("returns undefined when no explicit return", async () => {
    const { handlers } = makeMockHandlers();
    const r = await runScript({ code: "1 + 1;" }, handlers);
    assert.equal(r.data, undefined);
  });

  it("captures console.log lines into the logs array", async () => {
    const { handlers } = makeMockHandlers();
    const r = await runScript(
      {
        code: `
          console.log("hello", "world");
          console.warn({ a: 1 });
          return "done";
        `,
      },
      handlers,
    );
    assert.equal(r.data, "done");
    assert.equal(r.logs.length, 2);
    assert.ok(r.logs[0].includes("hello world"));
    assert.ok(r.logs[1].includes('{"a":1}'));
  });
});

describe("runScript with mocked AWS tools", () => {
  it("invokes aws.call and returns the data", async () => {
    const { handlers, calls } = makeMockHandlers({
      call: async (input) => ({
        command: "aws s3api list-buckets",
        result: { Buckets: [{ Name: input ? "b1" : "?" }] },
      }),
    });
    const r = await runScript(
      {
        code: `
          const r = await aws.call({ service: "s3api", operation: "list-buckets" });
          return r.result.Buckets[0].Name;
        `,
      },
      handlers,
    );
    assert.equal(r.data, "b1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "call");
  });

  it("propagates tool errors as thrown JS Errors caught by user try/catch", async () => {
    const { handlers } = makeMockHandlers({
      call: async () => {
        throw new Error("AccessDenied");
      },
    });
    const r = await runScript(
      {
        code: `
          try {
            await aws.call({ service: "ec2", operation: "describe-instances" });
            return "unreachable";
          } catch (e) {
            return "caught: " + e.message;
          }
        `,
      },
      handlers,
    );
    assert.equal(r.data, "caught: AccessDenied");
  });

  it("chains multiple tool calls and aggregates results", async () => {
    let getCount = 0;
    const { handlers, calls } = makeMockHandlers({
      resource: {
        list: async () => ({
          resources: [{ identifier: "fn1" }, { identifier: "fn2" }, { identifier: "fn3" }],
        }),
        get: async (input) => {
          getCount++;
          const id = (input as { identifier: string }).identifier;
          return { properties: { FunctionName: id, MemorySize: getCount * 256 } };
        },
        create: async () => ({}),
        update: async () => ({}),
        delete: async () => ({}),
        status: async () => ({}),
      },
    });
    const r = await runScript(
      {
        code: `
          const listed = await aws.resource.list({ typeName: "AWS::Lambda::Function" });
          const out = [];
          for (const r of listed.resources) {
            const cfg = await aws.resource.get({ typeName: "AWS::Lambda::Function", identifier: r.identifier });
            if (cfg.properties.MemorySize > 256) out.push(cfg.properties.FunctionName);
          }
          return out;
        `,
      },
      handlers,
    );
    assert.deepEqual(plain(r.data), ["fn2", "fn3"]);
    // 1 list + 3 get
    assert.equal(calls.length, 4);
  });
});

describe("runScript sandbox isolation", () => {
  it("does not expose require / process / fs / globalThis", async () => {
    const { handlers } = makeMockHandlers();
    const r = await runScript(
      {
        code: `
          const present = {
            require: typeof require,
            process: typeof process,
            globalThis: typeof globalThis,
            Buffer: typeof Buffer,
            setTimeout: typeof setTimeout,
          };
          return present;
        `,
      },
      handlers,
    );
    const present = plain(r.data) as Record<string, string>;
    assert.equal(present.require, "undefined");
    assert.equal(present.process, "undefined");
    assert.equal(present.globalThis, "undefined");
    assert.equal(present.Buffer, "undefined");
    assert.equal(present.setTimeout, "undefined");
  });

  it("disables eval and new Function (codeGeneration.strings = false)", async () => {
    const { handlers } = makeMockHandlers();
    const r = await runScript(
      {
        code: `
          let evalBlocked = false;
          try { eval("1+1"); } catch (e) { evalBlocked = true; }
          let funcBlocked = false;
          try { new Function("return 1")(); } catch (e) { funcBlocked = true; }
          return { evalBlocked, funcBlocked };
        `,
      },
      handlers,
    );
    assert.deepEqual(plain(r.data), { evalBlocked: true, funcBlocked: true });
  });

  it("script-side prototype pollution does NOT leak to host Object.prototype", async () => {
    const { handlers } = makeMockHandlers();
    // Make sure host is clean going in. If a previous run leaked, fail loudly.
    assert.equal(
      (Object.prototype as Record<string, unknown>).polluted_by_aws_script,
      undefined,
      "host Object.prototype is dirty before the test runs -- earlier leak?",
    );
    const r = await runScript(
      {
        code: `
          Object.prototype.polluted_by_aws_script = "yes";
          // From inside the sandbox, the script's own Object IS polluted.
          const innerSees = ({}).polluted_by_aws_script;
          return innerSees;
        `,
      },
      handlers,
    );
    // The sandbox's own realm sees the pollution -- that's expected.
    assert.equal(r.data, "yes");
    // The host's Object.prototype must NOT see it.
    assert.equal(
      (Object.prototype as Record<string, unknown>).polluted_by_aws_script,
      undefined,
      "sandbox prototype pollution leaked into host Object.prototype",
    );
  });

  it("does not expose fetch / Request / Response / Headers / AbortController / AbortSignal", async () => {
    const { handlers } = makeMockHandlers();
    const r = await runScript(
      {
        code: `
          return {
            fetch: typeof fetch,
            Request: typeof Request,
            Response: typeof Response,
            Headers: typeof Headers,
            AbortController: typeof AbortController,
            AbortSignal: typeof AbortSignal,
          };
        `,
      },
      handlers,
    );
    assert.deepEqual(plain(r.data), {
      fetch: "undefined",
      Request: "undefined",
      Response: "undefined",
      Headers: "undefined",
      AbortController: "undefined",
      AbortSignal: "undefined",
    });
  });

  it("realm-local Math / JSON / Date / Promise / console still work", async () => {
    const { handlers } = makeMockHandlers();
    const r = await runScript(
      {
        code: `
          const mathOk = Math.max(1, 2, 3) === 3 && typeof Math.PI === "number";
          const jsonOk = JSON.parse(JSON.stringify({ a: 1 })).a === 1;
          const dateOk = typeof (new Date()).getTime() === "number" && typeof Date.now() === "number";
          const promiseOk = (await Promise.resolve(7)) === 7;
          console.log("hello from realm");
          return { mathOk, jsonOk, dateOk, promiseOk };
        `,
      },
      handlers,
    );
    assert.deepEqual(plain(r.data), {
      mathOk: true,
      jsonOk: true,
      dateOk: true,
      promiseOk: true,
    });
    assert.ok(r.logs.some((l) => l.includes("hello from realm")));
  });
});

describe("runScript paginateAll", () => {
  it("loops aws_paginate until hasMore=false and concatenates items", async () => {
    let page = 0;
    const pageData = [
      { result: ["a", "b"], nextToken: "t1", hasMore: true },
      { result: ["c"], nextToken: "t2", hasMore: true },
      { result: ["d", "e"], nextToken: null, hasMore: false },
    ];
    let paginateCalls = 0;
    const fakePaginateTool: Tool = {
      name: "aws_paginate",
      description: "",
      annotations: {},
      inputSchema: z.object({}) as unknown as Tool["inputSchema"],
      handler: async () => {
        paginateCalls++;
        return { ok: true, data: pageData[page++] };
      },
    };
    const { handlers } = makeMockHandlers();
    const customHandlers: ScriptHandlers = {
      ...handlers,
      paginateAll: buildPaginateAll(fakePaginateTool),
    };
    const r = await runScript(
      {
        code: `
          const all = await aws.paginateAll({ service: "s3api", operation: "list-objects-v2", query: "Contents[].Key" });
          return all.items;
        `,
      },
      customHandlers,
    );
    assert.deepEqual(plain(r.data), ["a", "b", "c", "d", "e"]);
    assert.equal(paginateCalls, 3);
  });

  it("respects maxPages safety cap", async () => {
    let paginateCalls = 0;
    const fakePaginateTool: Tool = {
      name: "aws_paginate",
      description: "",
      annotations: {},
      inputSchema: z.object({}) as unknown as Tool["inputSchema"],
      handler: async () => {
        paginateCalls++;
        return { ok: true, data: { result: [paginateCalls], nextToken: `t${paginateCalls}`, hasMore: true } };
      },
    };
    const { handlers } = makeMockHandlers();
    const customHandlers: ScriptHandlers = {
      ...handlers,
      paginateAll: buildPaginateAll(fakePaginateTool),
    };
    const r = await runScript(
      {
        code: `
          const all = await aws.paginateAll({
            service: "s3api", operation: "list-objects-v2", maxPages: 3
          });
          return all.pages;
        `,
      },
      customHandlers,
    );
    assert.equal(r.data, 3);
    assert.equal(paginateCalls, 3);
  });
});

describe("runScript cross-realm error bridging", () => {
  it("a thrown host Error appears as `e instanceof Error` inside the script", async () => {
    // Load-bearing assertion for the v0.9.2 realm-isolation fix: bridge
    // handlers throw host-realm Error instances, but the sandbox sees a
    // fresh `Error` extracted from the realm. Without the wrapForRealm
    // shim, `e instanceof Error` is FALSE inside the script -- breaking
    // the documented try/catch pattern.
    const { handlers } = makeMockHandlers({
      call: async () => {
        throw new Error("AccessDenied");
      },
    });
    const r = await runScript(
      {
        code: `
          try {
            await aws.call({ service: "ec2", operation: "describe-instances" });
            return { reached: true };
          } catch (e) {
            return {
              isError: e instanceof Error,
              message: e.message,
              hasName: typeof e.name === "string",
            };
          }
        `,
      },
      handlers,
    );
    const out = plain(r.data) as { isError: boolean; message: string; hasName: boolean };
    assert.equal(out.isError, true, "e instanceof Error must be true inside the script");
    assert.equal(out.message, "AccessDenied");
    assert.equal(out.hasName, true);
  });

  it("propagates custom error props (rawBody, toolName) across the realm boundary", async () => {
    const { handlers } = makeMockHandlers({
      call: async () => {
        const e = new Error("ToolFailed") as Error & { rawBody?: string; toolName?: string };
        e.rawBody = "<xml>boom</xml>";
        e.toolName = "aws_call";
        throw e;
      },
    });
    const r = await runScript(
      {
        code: `
          try {
            await aws.call({ service: "ec2", operation: "describe-instances" });
            return null;
          } catch (e) {
            return { message: e.message, rawBody: e.rawBody, toolName: e.toolName };
          }
        `,
      },
      handlers,
    );
    assert.deepEqual(plain(r.data), {
      message: "ToolFailed",
      rawBody: "<xml>boom</xml>",
      toolName: "aws_call",
    });
  });

  it("non-Error throws (strings, primitives) pass through unchanged", async () => {
    const { handlers } = makeMockHandlers({
      call: async () => {
        throw "plain string boom";
      },
    });
    const r = await runScript(
      {
        code: `
          try {
            await aws.call({ service: "ec2", operation: "describe-instances" });
            return null;
          } catch (e) {
            return { type: typeof e, value: e, isError: e instanceof Error };
          }
        `,
      },
      handlers,
    );
    const out = plain(r.data) as { type: string; value: unknown; isError: boolean };
    assert.equal(out.type, "string");
    assert.equal(out.value, "plain string boom");
    assert.equal(out.isError, false);
  });

  it("captureLog survives an object with a throwing toString / @@toPrimitive", async () => {
    const { handlers } = makeMockHandlers();
    // Construct the trap INSIDE the sandbox so the failing path is the
    // String(a) fallback on a sandbox-realm object. JSON.stringify on a
    // circular ref throws first; String() on that same ref then trips the
    // user-defined toString and throws too -- exactly the case we're
    // hardening.
    const r = await runScript(
      {
        code: `
          const a = {};
          a.self = a; // makes JSON.stringify throw
          a.toString = () => { throw new Error("boom-toString"); };
          a[Symbol.toPrimitive] = () => { throw new Error("boom-toPrimitive"); };
          console.log(a);
          return "ok";
        `,
      },
      handlers,
    );
    assert.equal(r.data, "ok");
    assert.equal(r.logs.length, 1);
    assert.ok(
      r.logs[0].includes("[unrepresentable]"),
      `expected '[unrepresentable]' sentinel in log line, got: ${r.logs[0]}`,
    );
  });
});

describe("runScript log capture limits", () => {
  it("caps logs.length at MAX_LOG_LINES (500) and flips truncatedLogs when exceeded", async () => {
    const { handlers } = makeMockHandlers();
    // 501 console.log lines: the 501st must NOT land in logs, and
    // truncatedLogs must flip to true. Loop runs inside the sandbox so we
    // exercise the captureLog path on every call.
    const r = await runScript(
      {
        code: `
          for (let i = 0; i < 501; i++) console.log("line-" + i);
          return "done";
        `,
      },
      handlers,
    );
    assert.equal(r.data, "done");
    assert.equal(r.logs.length, 500, "logs.length must be capped at MAX_LOG_LINES (500)");
    assert.equal(r.truncatedLogs, true, "truncatedLogs must flip true once the cap is hit");
    // The first line is kept; the 501st (index "line-500") is dropped.
    assert.ok(r.logs[0].includes("line-0"));
    assert.ok(r.logs[499].includes("line-499"));
    assert.ok(!r.logs.some((l) => l.includes("line-500")), "line-500 should have been dropped after the cap was hit");
  });

  it("truncates a single log line over MAX_LOG_LINE_BYTES (4096) with a `... [line truncated]` suffix", async () => {
    const { handlers } = makeMockHandlers();
    // 5000-char line: kept content is the first 4096 chars, then the marker.
    // The total emitted line is `[log] <4096 chars>... [line truncated]`.
    const r = await runScript(
      {
        code: `
          console.log("x".repeat(5000));
          return "done";
        `,
      },
      handlers,
    );
    assert.equal(r.data, "done");
    assert.equal(r.logs.length, 1);
    const line = r.logs[0];
    assert.ok(line.startsWith("[log] "), `expected level prefix, got: ${line.slice(0, 20)}...`);
    assert.ok(line.endsWith("... [line truncated]"), "expected the truncation suffix on an over-cap line");
    // 5 char prefix "[log] " (6 with space) + 4096 char payload + suffix.
    // Anchor on the payload length explicitly so a future refactor of the
    // prefix doesn't silently flip this assertion.
    const suffix = "... [line truncated]";
    const payload = line.slice("[log] ".length, line.length - suffix.length);
    assert.equal(payload.length, 4096, `expected payload of exactly MAX_LOG_LINE_BYTES (4096), got ${payload.length}`);
    assert.ok(
      payload.split("").every((c) => c === "x"),
      "payload should be the first 4096 chars of the input, unchanged",
    );
  });

  it("does NOT truncate a line exactly at the byte limit (boundary case)", async () => {
    const { handlers } = makeMockHandlers();
    // The cap path is `text.length > MAX_LOG_LINE_BYTES`, so length == 4096
    // must pass through untouched. Anchor the boundary so a future `>=`
    // typo is caught.
    const r = await runScript(
      {
        code: `
          console.log("x".repeat(4096));
          return "done";
        `,
      },
      handlers,
    );
    assert.equal(r.logs.length, 1);
    assert.ok(
      !r.logs[0].endsWith("... [line truncated]"),
      "a line of exactly 4096 chars must not be tagged as truncated",
    );
  });
});

describe("runScript timer cleanup on normal completion", () => {
  it("does not leak the wall-clock setTimeout handle when a script completes well before timeoutMs", async () => {
    // Load-bearing: the finally-block `clearTimeout(timer)` must release the
    // pending timer so a long-running process running many scripts back-to-
    // back doesn't accumulate one pending handle per call. We assert the
    // active-handle count is stable across N sequential runs with a very
    // large timeoutMs -- without clearTimeout the timers would all stay
    // pending and the handle count would climb by ~N.
    //
    // Some Node builds keep a small set of background handles unrelated to
    // our script (test reporter, GC, etc.); we tolerate a slack of 2.
    const { handlers } = makeMockHandlers();
    // Prime: one warm-up run so any first-call lazy-init handles settle
    // (require resolution caches, vm context init, etc.) before we measure.
    await runScript({ code: "return 1;", timeoutMs: 300_000 }, handlers);

    const getHandles = (process as unknown as { _getActiveHandles: () => unknown[] })._getActiveHandles;
    assert.equal(typeof getHandles, "function", "expected process._getActiveHandles in Node");

    const before = getHandles.call(process).length;
    const RUNS = 20;
    for (let i = 0; i < RUNS; i++) {
      // timeoutMs much larger than the script's actual runtime. If the
      // finally-block clearTimeout were removed, each iteration would leak
      // one pending setTimeout handle.
      const r = await runScript({ code: "return 1 + 1;", timeoutMs: 300_000 }, handlers);
      assert.equal(r.data, 2);
    }
    const after = getHandles.call(process).length;
    const delta = after - before;
    assert.ok(
      delta < RUNS / 2,
      `expected no growth in active handles across ${RUNS} script runs (clearTimeout in finally), got delta=${delta}`,
    );
  });
});

describe("runScript timeouts", () => {
  it("rejects an async wall-clock hang within timeoutMs", async () => {
    // The mock resolves at 200ms, the script timeout fires at 100ms. The
    // wall-clock timer wins; we assert on the rejection. We keep the mock
    // delay short and ref'd so its pending Promise drains before the test
    // returns -- node:test flags lingering pending promises as
    // "cancelledByParent" otherwise.
    const { handlers } = makeMockHandlers({
      call: () => new Promise<unknown>((resolve) => setTimeout(() => resolve({ command: "", result: {} }), 200)),
    });
    let caught: Error | undefined;
    try {
      await runScript(
        {
          code: `await aws.call({ service: "s3api", operation: "list-buckets" }); return "unreachable";`,
          timeoutMs: 100,
        },
        handlers,
      );
    } catch (e) {
      caught = e as Error;
    }
    // Let the slow mock's Promise settle before returning so the script's
    // dangling await drains. Cheaper than tracking timer handles.
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.ok(caught, "expected runScript to throw on timeout");
    assert.ok(caught.message.includes("timed out"), `expected timeout message, got: ${caught.message}`);
  });

  it("kills a synchronous infinite loop via vm timeout", async () => {
    const handlerResult = await tool.handler({
      code: "while (true) { /* no yield */ }",
      timeoutMs: 200,
    });
    assert.equal(handlerResult.ok, false);
    // vm sync-timeout surfaces as "Script execution timed out after Xms";
    // our wall-clock Promise.race fallback would surface "Script timed out
    // after Ns". Either path is acceptable -- we just need ok:false with a
    // non-empty message.
    assert.ok(handlerResult.error && handlerResult.error.length > 0);
  });
});
