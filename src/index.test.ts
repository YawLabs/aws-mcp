import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { allTools, buildToolContext, errorToMcpResult, findDuplicateToolNames, toMcpResult } from "./index.js";
import { assumeTools } from "./tools/assume.js";
import { authTools } from "./tools/auth.js";
import { callTools } from "./tools/call.js";
import { docsTools } from "./tools/docs.js";
import { iamSimulateTools } from "./tools/iam-simulate.js";
import { lambdaTools } from "./tools/lambda.js";
import { logsTools } from "./tools/logs.js";
import { metricsTools } from "./tools/metrics.js";
import { multiAccountTools } from "./tools/multi-account.js";
import { multiRegionTools } from "./tools/multi-region.js";
import { paginateTools } from "./tools/paginate.js";
import { profilesTools } from "./tools/profiles.js";
import { resourceTools } from "./tools/resource.js";
import { scriptTools } from "./tools/script.js";
import { sessionTools } from "./tools/session.js";
import type { Tool, ToolContext, ToolResult } from "./tools/tool.js";

// Direct tests for the result-mapping functions extracted from the
// registration loop (src/index.ts). These were previously inline and untested;
// the refactor pulled them out as pure functions so the per-tool envelope
// mapping can be asserted without spinning up the stdio server.
//
// Importing ./index.js is side-effect-free here: the stdio-server bootstrap is
// gated behind an entry-point check, so pulling in toMcpResult/errorToMcpResult
// does not connect a transport or print the ready line.

describe("toMcpResult — ok:false (error) branches", () => {
  it("maps an error WITH rawBody: 'Error: <msg>\\n\\n<rawBody>', isError:true", () => {
    const r = toMcpResult({ ok: false, error: "AccessDenied", rawBody: "stderr blob" });
    assert.deepEqual(r, {
      content: [{ type: "text", text: "Error: AccessDenied\n\nstderr blob" }],
      isError: true,
    });
  });

  it("does NOT append rawBody the summary already quotes", () => {
    // The auth-class messages from aws-cli.ts end with
    // "Underlying error: <stderr>" so the stderr survives handlers that rebuild
    // the message without forwarding rawBody (aws_assume_role does that).
    // Appending rawBody on top printed the same stderr twice -- caught driving
    // the published 2.0.0 with a bad --profile, on the errors a first-run user
    // is most likely to see.
    const stderr = "aws: [ERROR]: The config profile (nope) could not be found";
    const r = toMcpResult({
      ok: false,
      error: `No credentials found for profile 'nope'. Check ~/.aws/config and ~/.aws/credentials. Underlying error: ${stderr}`,
      // The raw stream carries trailing CR/LF the embedded copy does not, which
      // is why the check compares against the TRIMMED body.
      rawBody: `${stderr}\r\n`,
    });
    const text = r.content[0].text;
    const occurrences = text.split("could not be found").length - 1;
    assert.equal(occurrences, 1, `stderr must appear exactly once, got ${occurrences}: ${text}`);
    assert.equal(text.includes("\n\n"), false, "nothing appended, so no separator");
  });

  it("DOES append a rawBody the summary only quotes in truncated form", () => {
    // The complement: when stderr was long enough to be clipped for the
    // summary, containment fails and appending is the useful outcome -- the
    // summary holds a clipped copy, rawBody completes it.
    const r = toMcpResult({
      ok: false,
      error: "Something failed. Underlying error: aaaa[truncated; 999 chars omitted]",
      rawBody: `${"a".repeat(200)}TAIL`,
    });
    const text = r.content[0].text;
    assert.match(text, /TAIL$/, "the full body must still be appended when it is not already present");
    assert.equal(text.includes("\n\n"), true);
  });

  it("maps an error WITHOUT rawBody: bare 'Error: <msg>' (no trailing newlines)", () => {
    const r = toMcpResult({ ok: false, error: "AccessDenied" });
    assert.deepEqual(r, {
      content: [{ type: "text", text: "Error: AccessDenied" }],
      isError: true,
    });
    // No rawBody means no "\n\n" separator is appended.
    assert.equal(r.content[0].text.includes("\n\n"), false);
  });

  it("falls back to 'Unknown error' when error is missing/empty", () => {
    // `response.error || "Unknown error"` — undefined error.
    const missing = toMcpResult({ ok: false });
    assert.equal(missing.content[0].text, "Error: Unknown error");
    assert.equal(missing.isError, true);

    // Empty-string error is falsy and also triggers the fallback.
    const empty = toMcpResult({ ok: false, error: "" });
    assert.equal(empty.content[0].text, "Error: Unknown error");

    // The fallback still composes with rawBody.
    const withRaw = toMcpResult({ ok: false, error: "", rawBody: "raw" });
    assert.equal(withRaw.content[0].text, "Error: Unknown error\n\nraw");
  });
});

describe("toMcpResult — errorKind delivery", () => {
  it("prefixes an `errorKind: <kind>` line ahead of the error summary", () => {
    const r = toMcpResult({ ok: false, error: "AccessDenied", errorKind: "nonzero_exit" });
    assert.deepEqual(r, {
      content: [{ type: "text", text: "errorKind: nonzero_exit\nError: AccessDenied" }],
      isError: true,
    });
    // ONE newline: the blank line stays reserved for "rawBody follows", so a
    // result with no rawBody still contains no "\n\n".
    assert.equal(r.content[0].text.includes("\n\n"), false);
  });

  it("omits the line entirely when errorKind is absent (legacy shape pinned)", () => {
    // The regression pin that makes the feature additive: an unclassified
    // failure must not gain a header. Byte-identical to the pre-change output.
    const r = toMcpResult({ ok: false, error: "AccessDenied", rawBody: "stderr blob" });
    assert.deepEqual(r, {
      content: [{ type: "text", text: "Error: AccessDenied\n\nstderr blob" }],
      isError: true,
    });
  });

  it("composes kind line + summary + rawBody in that order", () => {
    const r = toMcpResult({ ok: false, error: "boom", errorKind: "timeout", rawBody: "raw" });
    assert.equal(r.content[0].text, "errorKind: timeout\nError: boom\n\nraw");
  });

  it("does not regress the rawBody doubling guard", () => {
    // The v2.0.1 fix compares rawBody against the SUMMARY alone. The kind line
    // is composed after that check, so adding it must not make the containment
    // test miss and re-append the stderr.
    const stderr = "aws: [ERROR]: The config profile (nope) could not be found";
    const r = toMcpResult({
      ok: false,
      error: `No credentials found for profile 'nope'. Check ~/.aws/config and ~/.aws/credentials. Underlying error: ${stderr}`,
      errorKind: "no_creds",
      rawBody: `${stderr}\r\n`,
    });
    const text = r.content[0].text;
    assert.equal(text.split("could not be found").length - 1, 1, `stderr must appear exactly once: ${text}`);
    assert.equal(text.startsWith("errorKind: no_creds\nError: No credentials found"), true);
    assert.equal(text.includes("\n\n"), false, "nothing appended, so no separator");
  });

  it("never renders `suggestion`, which its producer already embeds in `error`", () => {
    // The guard against reintroducing the v2.0.1 doubling defect on a second
    // field: runAwsCall puts the sentence in `error` AND on the field.
    const suggestion = "Check IAM permissions for this operation.";
    const r = toMcpResult({
      ok: false,
      error: `boom\n\nSuggestion: ${suggestion}`,
      errorKind: "nonzero_exit",
      suggestion,
    });
    assert.equal(r.content[0].text.split("Suggestion:").length - 1, 1);
  });
});

describe("toMcpResult — ok:true (success) branches", () => {
  it("serializes data as pretty JSON (2-space indent) when present", () => {
    const data = { Buckets: [{ Name: "b1" }], Owner: { ID: "abc" } };
    const r = toMcpResult({ ok: true, data });
    assert.equal(r.content[0].text, JSON.stringify(data, null, 2));
    // Pretty-printed: contains the 2-space indentation, not a single line.
    assert.match(r.content[0].text, /\n {2}"Buckets"/);
    // Success results carry no isError flag.
    assert.equal(r.isError, undefined);
    assert.equal("isError" in r, false);
  });

  it("uses { success: true } fallback when there is no data and no rawBody", () => {
    const r = toMcpResult({ ok: true });
    assert.equal(r.content[0].text, JSON.stringify({ success: true }, null, 2));
    assert.equal(r.isError, undefined);
  });

  it("emits BOTH data and rawBody when a handler sets both", () => {
    // Regression: this used to be `response.rawBody ?? JSON.stringify(data)`,
    // which silently DROPPED data whenever rawBody was also present. A handler
    // returning a parsed summary alongside the raw CLI output had the summary
    // thrown away and the model saw only the raw text.
    const r = toMcpResult({ ok: true, data: { kept: true }, rawBody: "raw output text" });
    assert.equal(r.content[0].text, `${JSON.stringify({ kept: true }, null, 2)}\n\nraw output text`);
    assert.match(r.content[0].text, /"kept": true/);
    assert.match(r.content[0].text, /raw output text/);
    assert.equal(r.isError, undefined);
  });

  it("emits rawBody alone when there is no data", () => {
    const r = toMcpResult({ ok: true, rawBody: "raw output text" });
    assert.equal(r.content[0].text, "raw output text");
    // No blank-line separator when there is only one part.
    assert.equal(r.content[0].text.includes("\n\n"), false);
  });

  it("emits data alone when there is no rawBody", () => {
    const r = toMcpResult({ ok: true, data: { only: 1 } });
    assert.equal(r.content[0].text, JSON.stringify({ only: 1 }, null, 2));
  });

  it("still uses the { success: true } fallback when data is null AND rawBody is present", () => {
    // null data is "no data" (matching the old `?? { success: true }`), so the
    // rawBody is the only part -- not `null\n\nraw`.
    const r = toMcpResult({ ok: true, data: null, rawBody: "raw" });
    assert.equal(r.content[0].text, "raw");
  });

  it("treats data:null as absent, so a null-data success serializes { success: true }", () => {
    // Preserved from the old `response.data ?? { success: true }`: null and
    // undefined both mean "no data", and with no rawBody either there is
    // nothing to report, so the fallback stands in.
    const r = toMcpResult({ ok: true, data: null });
    assert.equal(r.content[0].text, JSON.stringify({ success: true }, null, 2));
  });
});

describe("errorToMcpResult — thrown-handler catch path", () => {
  const realErr = console.error;
  let captured: string[] = [];

  afterEach(() => {
    console.error = realErr;
    captured = [];
  });

  function stubConsoleError(): string[] {
    captured = [];
    console.error = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    return captured;
  }

  it("maps an Error to message-only text and logs message + stack to stderr", () => {
    const logs = stubConsoleError();
    const err = new Error("boom");
    const r = errorToMcpResult(err, "aws_call");

    assert.deepEqual(r, {
      content: [{ type: "text", text: "Error: boom" }],
      isError: true,
    });

    // Two console.error calls: the labelled message line, then the stack.
    assert.equal(logs.length, 2);
    assert.equal(logs[0], "[aws-mcp] handler 'aws_call' threw: boom");
    assert.ok(logs[1].includes("boom"));
    // The second log is the stack, which includes the function/file frames.
    assert.match(logs[1], /Error: boom/);
  });

  it("does NOT log rawStdout/rawStderr from an AwsCallResult-shaped thrown object", () => {
    // The deliberate choice at index.ts: log only `message` + `stack`, never the
    // whole err object — so a re-thrown AwsCallResult-shaped value with
    // rawStdout/rawStderr fields never leaks those into operator stderr.
    const logs = stubConsoleError();
    const awsShaped = Object.assign(new Error("aws blew up"), {
      rawStdout: "SECRET-STDOUT-PAYLOAD",
      rawStderr: "SECRET-STDERR-PAYLOAD",
    });

    const r = errorToMcpResult(awsShaped, "aws_call");

    // Surfaced MCP text is message-only — no raw fields.
    assert.equal(r.content[0].text, "Error: aws blew up");
    assert.equal(r.content[0].text.includes("SECRET-STDOUT-PAYLOAD"), false);
    assert.equal(r.content[0].text.includes("SECRET-STDERR-PAYLOAD"), false);

    // And nothing logged to stderr contains the raw fields either.
    const joined = logs.join("\n");
    assert.equal(joined.includes("SECRET-STDOUT-PAYLOAD"), false);
    assert.equal(joined.includes("SECRET-STDERR-PAYLOAD"), false);
    // The message itself is still logged.
    assert.ok(joined.includes("aws blew up"));
  });

  it("stringifies a non-Error throw via String(err) and logs no stack", () => {
    const logs = stubConsoleError();
    const r = errorToMcpResult("plain string failure", "aws_call");

    assert.deepEqual(r, {
      content: [{ type: "text", text: "Error: plain string failure" }],
      isError: true,
    });
    // Non-Error has no .stack -> only the single labelled message line is logged.
    assert.equal(logs.length, 1);
    assert.equal(logs[0], "[aws-mcp] handler 'aws_call' threw: plain string failure");
  });
});

// Light type-level pin: ToolResult is the input contract toMcpResult maps from.
// Referencing it here keeps the import meaningful if the export ever moves.
const _typePin: ToolResult = { ok: true };
void _typePin;

/**
 * Tool registry snapshot. Catches:
 *   - a tool file exporting an empty `xxxTools` array (forgotten export)
 *   - a tool file exporting the same name as an existing tool (accidental
 *     duplicate; would silently overwrite in the registration loop)
 *   - a typo in src/index.ts's allTools concatenation referencing a
 *     non-existent array (catches at module load via the spread)
 *   - a stale pinned total when a tool is added or removed without
 *     updating this test
 *
 * The per-array non-empty assertion is the load-bearing shape: a
 * total-only check would let a tool "trade" between arrays (one gains,
 * one loses) and still pass. Pinning each one catches the most common
 * regression -- a tool file shipped with an empty `xxxTools = []` --
 * directly.
 *
 * If this test fails because you ADDED a tool, update the count below
 * and re-run. If it fails because a name collided, the duplicate-check
 * loop at the bottom of the test will name both indexes.
 */
describe("tool registry snapshot", () => {
  it("allTools has 28 entries, every individual array contributes, every name is unique", () => {
    // The per-array imports mirror the spread order in src/index.ts
    // exactly. A typo in either place is caught at module load (spread) or
    // at the corresponding import (tsc).
    const groups: ReadonlyArray<readonly [string, readonly Tool[]]> = [
      ["authTools", authTools],
      ["sessionTools", sessionTools],
      ["callTools", callTools],
      ["profilesTools", profilesTools],
      ["paginateTools", paginateTools],
      ["assumeTools", assumeTools],
      ["logsTools", logsTools],
      ["metricsTools", metricsTools],
      ["resourceTools", resourceTools],
      ["multiRegionTools", multiRegionTools],
      ["multiAccountTools", multiAccountTools],
      ["iamSimulateTools", iamSimulateTools],
      ["lambdaTools", lambdaTools],
      ["docsTools", docsTools],
      ["scriptTools", scriptTools],
    ];

    for (const [name, arr] of groups) {
      assert.ok(
        arr.length >= 1,
        `${name} is empty -- forgot to export the tool, or renamed without updating the registry`,
      );
    }

    // Total: pinned. Update this number whenever a tool is added or removed.
    const sumOfGroups = groups.reduce((n, [, arr]) => n + arr.length, 0);
    assert.equal(sumOfGroups, 28, "sum of per-group tool counts drifted from the pinned total");

    // allTools (the actual export consumed by the MCP registration loop) must
    // equal the per-group sum. A typo in src/index.ts referencing a wrong
    // array name (e.g. `...resourcTools` instead of `...resourceTools`) would
    // surface here because the spread at module load would throw -- but
    // double-check that the export's length matches too.
    assert.equal(allTools.length, sumOfGroups, "allTools export length != sum of per-group arrays");

    // No two tools share a name. A duplicate `name: "aws_call"` somewhere
    // would silently overwrite in the registration loop (Map-keyed by name)
    // and the second tool would never be reachable; this surfaces it.
    const seen = new Map<string, number>();
    for (let i = 0; i < allTools.length; i++) {
      const t = allTools[i];
      const prior = seen.get(t.name);
      if (prior !== undefined) {
        assert.fail(`Duplicate tool name '${t.name}' at index ${i} (first seen at index ${prior})`);
      }
      seen.set(t.name, i);
    }
  });
});

describe("findDuplicateToolNames", () => {
  // src/index.ts runs this over allTools at MODULE LOAD and throws on a hit,
  // so a name collision can no longer ship as a tool that registers, counts
  // toward the ready line, and is simply unreachable over MCP (server.tool is
  // keyed by name -- the later registration shadows the earlier one, and the
  // SDK says nothing). The assertion above proves the real registry is clean;
  // these prove the detector itself works, which a clean registry cannot.
  const stub = (name: string): Tool =>
    ({
      name,
      description: "",
      annotations: {},
      inputSchema: {},
      handler: async () => ({ ok: true }),
    }) as unknown as Tool;

  it("returns an empty array for a registry with unique names", () => {
    assert.deepEqual(findDuplicateToolNames([stub("a"), stub("b"), stub("c")]), []);
  });

  it("returns an empty array for an empty registry", () => {
    assert.deepEqual(findDuplicateToolNames([]), []);
  });

  it("names the collision once, however many times it repeats", () => {
    assert.deepEqual(findDuplicateToolNames([stub("a"), stub("b"), stub("a"), stub("a")]), ["a"]);
  });

  it("reports every distinct collision", () => {
    assert.deepEqual(findDuplicateToolNames([stub("a"), stub("b"), stub("a"), stub("b"), stub("c")]), ["a", "b"]);
  });

  it("agrees with the live registry (which must be collision-free)", () => {
    assert.deepEqual(findDuplicateToolNames(allTools), []);
  });
});

// ---------------------------------------------------------------------------
// buildToolContext — the per-call ToolContext the registration loop hands to
// every tool handler.
//
// Worth direct coverage rather than leaning on the registration loop (which
// sits behind the entry-point check and is unreachable from an import), for
// two reasons:
//
//   1. Progress is opt-in per the MCP spec, so the no-token path MUST be a
//      silent no-op. Handlers call reportProgress unconditionally and never
//      branch on client support, so anything but a no-op here becomes a throw
//      inside every handler that reports at once.
//   2. The token-presence guard is undefined/null, NOT truthiness. A client
//      that numbers its tokens from zero sends progressToken 0, which is falsy;
//      a regression to a truthiness check would silently disable progress for
//      that client with no error emitted anywhere. Same for an empty-string
//      token.
// ---------------------------------------------------------------------------

/** The only notification shape buildToolContext is allowed to emit. */
type ProgressNotification = {
  method: "notifications/progress";
  params: { progressToken: string | number; progress: number; total?: number; message?: string };
};

/**
 * Recording stand-in for the SDK's sendNotification. `impl` replaces the
 * returned promise so a test can make the send reject; the notification is
 * recorded either way, which is how "the send was attempted but its failure was
 * swallowed" is distinguished from "the send was skipped".
 */
function recordingSender(impl?: () => Promise<void>) {
  const sent: ProgressNotification[] = [];
  const send = (n: ProgressNotification): Promise<void> => {
    sent.push(n);
    return impl ? impl() : Promise.resolve();
  };
  return { sent, send };
}

/**
 * Drain the microtask queue plus a couple of macrotask turns, which is when
 * Node decides a rejected promise has no handler and emits unhandledRejection.
 */
async function drainTicks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("buildToolContext — falsy-but-PRESENT progress tokens", () => {
  // The highest-value cases in this file. Both tokens below are falsy, both are
  // legal per the MCP spec (progressToken is string | number, and a client
  // numbering requests from zero produces exactly this), and both would be
  // silently dropped by a truthiness guard while every other test here kept
  // passing.

  it("progressToken 0 is PRESENT: the notification is emitted with the number 0 verbatim", () => {
    const { sent, send } = recordingSender();
    const ctx = buildToolContext({ _meta: { progressToken: 0 }, sendNotification: send });

    ctx.reportProgress(1, 4, "region 1/4");

    assert.equal(sent.length, 1, "a truthiness guard on the token would silently send nothing here");
    assert.ok(Object.is(sent[0].params.progressToken, 0), "the token must round-trip as the number 0, unconverted");
    assert.deepEqual(sent[0], {
      method: "notifications/progress",
      params: { progressToken: 0, progress: 1, total: 4, message: "region 1/4" },
    });
  });

  it("an empty-string progressToken is PRESENT: emitted with the empty string verbatim", () => {
    const { sent, send } = recordingSender();
    const ctx = buildToolContext({ _meta: { progressToken: "" }, sendNotification: send });

    ctx.reportProgress(2);

    assert.equal(sent.length, 1, "a truthiness guard on the token would silently send nothing here");
    assert.equal(typeof sent[0].params.progressToken, "string");
    assert.deepEqual(sent[0], {
      method: "notifications/progress",
      params: { progressToken: "", progress: 2 },
    });
  });

  it("progress 0 is emitted too — the first tick of a long call is a real update", () => {
    const { sent, send } = recordingSender();
    const ctx = buildToolContext({ _meta: { progressToken: 0 }, sendNotification: send });

    ctx.reportProgress(0);

    assert.deepEqual(sent[0].params, { progressToken: 0, progress: 0 });
  });
});

describe("buildToolContext — emitted notification shape", () => {
  it("emits method notifications/progress with the token and progress, and NO total/message keys", () => {
    const { sent, send } = recordingSender();
    const ctx = buildToolContext({ _meta: { progressToken: "tok-1" }, sendNotification: send });

    ctx.reportProgress(3);

    assert.equal(sent.length, 1);
    // deepEqual is deepSTRICTequal under node:assert/strict, which DOES
    // distinguish { progress: 3 } from { progress: 3, total: undefined } — the
    // params are spread conditionally, and this is what proves it.
    assert.deepEqual(sent[0], {
      method: "notifications/progress",
      params: { progressToken: "tok-1", progress: 3 },
    });
    // Spelled out as well, so a failure names WHICH key leaked instead of
    // dumping two near-identical objects.
    assert.equal("total" in sent[0].params, false, "total must be ABSENT, not present-and-undefined");
    assert.equal("message" in sent[0].params, false, "message must be ABSENT, not present-and-undefined");
  });

  it("includes total ONLY when supplied — including total 0, since the check is !== undefined", () => {
    const { sent, send } = recordingSender();
    const ctx = buildToolContext({ _meta: { progressToken: 1 }, sendNotification: send });

    ctx.reportProgress(0, 0);

    assert.deepEqual(sent[0].params, { progressToken: 1, progress: 0, total: 0 });
    assert.equal("total" in sent[0].params, true, "total 0 is a supplied denominator, not an omitted one");
    assert.equal("message" in sent[0].params, false);
  });

  it("includes message ONLY when supplied, with no total alongside it", () => {
    const { sent, send } = recordingSender();
    const ctx = buildToolContext({ _meta: { progressToken: 1 }, sendNotification: send });

    ctx.reportProgress(7, undefined, "polling Cloud Control");

    assert.deepEqual(sent[0].params, { progressToken: 1, progress: 7, message: "polling Cloud Control" });
    assert.equal("total" in sent[0].params, false, "an explicit undefined total must not materialize the key");
  });

  it("includes both when both are supplied", () => {
    const { sent, send } = recordingSender();
    const ctx = buildToolContext({ _meta: { progressToken: "t" }, sendNotification: send });

    ctx.reportProgress(12, 32, "region 12/32");

    assert.deepEqual(sent[0], {
      method: "notifications/progress",
      params: { progressToken: "t", progress: 12, total: 32, message: "region 12/32" },
    });
  });

  it("DROPS an empty-string message — documented asymmetry with total, not a token-style trap", () => {
    // total uses !== undefined while message uses a truthiness check. An empty
    // message carries nothing a client can render, so dropping it is harmless;
    // pinned here so an edit that unifies the two has to notice the difference
    // deliberately.
    const { sent, send } = recordingSender();
    const ctx = buildToolContext({ _meta: { progressToken: 1 }, sendNotification: send });

    ctx.reportProgress(5, 10, "");

    assert.deepEqual(sent[0].params, { progressToken: 1, progress: 5, total: 10 });
    assert.equal("message" in sent[0].params, false);
  });

  it("emits one notification per call, in call order, with independent params objects", () => {
    const { sent, send } = recordingSender();
    const ctx = buildToolContext({ _meta: { progressToken: "tok" }, sendNotification: send });

    ctx.reportProgress(1, 3, "a");
    ctx.reportProgress(2, 3, "b");
    ctx.reportProgress(3, 3, "c");

    assert.equal(sent.length, 3);
    assert.deepEqual(
      sent.map((n) => n.params.progress),
      [1, 2, 3],
      "monotonic progress from the handler must reach the wire in the same order",
    );
    assert.deepEqual(
      sent.map((n) => n.params.message),
      ["a", "b", "c"],
    );
    assert.ok(sent.every((n) => n.method === "notifications/progress"));
    assert.ok(
      sent.every((n) => n.params.progressToken === "tok"),
      "every call carries the request's own token",
    );
    // Each call builds a fresh params object — no shared buffer a later call
    // could mutate out from under an in-flight send.
    assert.notEqual(sent[0].params, sent[1].params);
  });
});

describe("buildToolContext — no progressToken means reportProgress is a silent no-op", () => {
  it("sends nothing when _meta is absent entirely", () => {
    const { sent, send } = recordingSender();
    const ctx = buildToolContext({ sendNotification: send });

    assert.doesNotThrow(() => ctx.reportProgress(1, 2, "msg"));

    assert.deepEqual(sent, [], "the MCP spec forbids progress for a request that carried no token");
  });

  it("sends nothing when _meta exists but carries no progressToken", () => {
    const { sent, send } = recordingSender();
    const ctx = buildToolContext({ _meta: {}, sendNotification: send });

    assert.doesNotThrow(() => ctx.reportProgress(1));

    assert.deepEqual(sent, []);
  });

  it("treats an explicit undefined progressToken as absent", () => {
    const { sent, send } = recordingSender();
    const ctx = buildToolContext({ _meta: { progressToken: undefined }, sendNotification: send });

    assert.doesNotThrow(() => ctx.reportProgress(1));

    assert.deepEqual(sent, []);
  });

  it("treats a null progressToken as absent — the guard checks null explicitly", () => {
    // The declared type is string | number, but a client can put anything on
    // the wire. The null arm of the guard is what stops a literal
    // progressToken:null reaching the transport as a "valid" token.
    const { sent, send } = recordingSender();
    const ctx = buildToolContext({ _meta: { progressToken: null as unknown as number }, sendNotification: send });

    assert.doesNotThrow(() => ctx.reportProgress(1, 2, "msg"));

    assert.deepEqual(sent, []);
  });
});

describe("buildToolContext — no sendNotification means reportProgress is a silent no-op", () => {
  it("does not throw when a token is present but there is no sender", () => {
    const ctx = buildToolContext({ _meta: { progressToken: 42 } });

    assert.doesNotThrow(() => ctx.reportProgress(1));
    assert.doesNotThrow(() => ctx.reportProgress(2, 5, "msg"));
  });

  it("does not throw when extra is undefined entirely", () => {
    const ctx = buildToolContext(undefined);

    assert.doesNotThrow(() => ctx.reportProgress(1));
    assert.doesNotThrow(() => ctx.reportProgress(2, 5, "msg"));
    assert.equal(ctx.reportProgress(3), undefined, "reportProgress returns void on every path");
  });

  it("returns a usable ToolContext on EVERY path — a handler can always call reportProgress", () => {
    const { send } = recordingSender();
    const paths: ToolContext[] = [
      buildToolContext(undefined),
      buildToolContext({}),
      buildToolContext({ sendNotification: send }),
      buildToolContext({ _meta: { progressToken: 0 } }),
      buildToolContext({ _meta: { progressToken: 0 }, sendNotification: send }),
    ];

    for (const ctx of paths) {
      assert.equal(typeof ctx.reportProgress, "function");
      assert.doesNotThrow(() => ctx.reportProgress(1, 2, "msg"));
    }
  });
});

describe("buildToolContext — a failing sendNotification never fails the tool call", () => {
  it("swallows a rejected send: reportProgress does not throw and no unhandled rejection escapes", async () => {
    const { sent, send } = recordingSender(() => Promise.reject(new Error("transport gone")));
    const ctx = buildToolContext({ _meta: { progressToken: 9 }, sendNotification: send });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      assert.doesNotThrow(() => ctx.reportProgress(1));
      assert.doesNotThrow(() => ctx.reportProgress(2, 10, "still going"));
      await drainTicks();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    assert.deepEqual(unhandled, [], "the .catch() on the fire-and-forget send is what keeps this empty");
    // Swallowing the failure is not the same as skipping the work: both sends
    // were still attempted.
    assert.equal(sent.length, 2);
  });

  it("keeps working after a send fails — one dropped update does not poison the context", async () => {
    let calls = 0;
    const { sent, send } = recordingSender(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("blip")) : Promise.resolve();
    });
    const ctx = buildToolContext({ _meta: { progressToken: "t" }, sendNotification: send });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      ctx.reportProgress(1);
      ctx.reportProgress(2);
      await drainTicks();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    assert.deepEqual(unhandled, []);
    assert.deepEqual(
      sent.map((n) => n.params.progress),
      [1, 2],
    );
  });
});

describe("buildToolContext — signal passthrough", () => {
  it("forwards extra.signal by identity on the progress-enabled path", () => {
    const { send } = recordingSender();
    const controller = new AbortController();

    const ctx = buildToolContext({ signal: controller.signal, _meta: { progressToken: 7 }, sendNotification: send });

    assert.equal(ctx.signal, controller.signal, "the same AbortSignal object, not a copy");
  });

  it("forwards extra.signal on the NO-OP path too — no token means no progress, not no signal", () => {
    // Easy to lose: the early return builds its own object literal, so the
    // signal has to be repeated there. A long-running handler on a client that
    // never sends a progressToken still needs to see cancellation.
    const controller = new AbortController();

    const ctx = buildToolContext({ signal: controller.signal });

    assert.equal(ctx.signal, controller.signal);
    assert.equal(ctx.signal?.aborted, false);
    controller.abort();
    assert.equal(ctx.signal?.aborted, true, "it is the live signal, so a later abort is visible through ctx");
  });

  it("forwards an ALREADY-aborted signal unchanged", () => {
    const controller = new AbortController();
    controller.abort();

    const ctx = buildToolContext({ signal: controller.signal, _meta: { progressToken: 1 } });

    assert.equal(ctx.signal, controller.signal);
    assert.equal(ctx.signal?.aborted, true);
  });

  it("is undefined when extra is undefined", () => {
    const ctx = buildToolContext(undefined);

    assert.equal(ctx.signal, undefined);
  });

  it("is undefined when extra carries no signal, on both paths", () => {
    const { send } = recordingSender();

    assert.equal(buildToolContext({}).signal, undefined);
    assert.equal(buildToolContext({ _meta: { progressToken: 1 }, sendNotification: send }).signal, undefined);
  });
});
