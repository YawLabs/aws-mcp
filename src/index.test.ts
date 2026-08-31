import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { allTools, errorToMcpResult, findDuplicateToolNames, toMcpResult } from "./index.js";
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
  it("allTools has 25 entries, every individual array contributes, every name is unique", () => {
    // The per-array imports mirror the spread order in src/index.ts:100-118
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
      ["iamSimulateTools", iamSimulateTools],
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
    assert.equal(sumOfGroups, 25, "sum of per-group tool counts drifted from the pinned total");

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
