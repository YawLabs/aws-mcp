/**
 * Live CCAPI integration test -- runs against a real AWS account.
 *
 * Gated behind AWS_MCP_LIVE_TESTS=1 so a normal `npm test` on an empty box
 * (or CI without AWS creds) skips this file entirely. Uses AWS::SSM::Parameter
 * as the throwaway resource type: cheap, simple schema, ~instant lifecycle,
 * and trivially cleaned up via Delete.
 *
 * Exercises the full aws_resource lifecycle end-to-end through the real aws
 * CLI: create -> poll status -> get -> update -> get -> delete -> poll status.
 * The `finally` block always runs delete + wait so a mid-test failure doesn't
 * leave a stray parameter behind.
 *
 * Prereqs when running live:
 *   - aws CLI v2 on PATH
 *   - A configured AWS profile with at minimum:
 *       ssm:PutParameter, ssm:GetParameter, ssm:DeleteParameter
 *       cloudformation:ListResources / the CCAPI permissions
 *       (`cloudcontrol:*Resource` action alias covers the CCAPI verbs)
 *   - Profile / region: default to the usual AWS_PROFILE / AWS_REGION chain,
 *     or set AWS_MCP_LIVE_PROFILE / AWS_MCP_LIVE_REGION to override just for
 *     this test without disturbing the rest of the suite.
 *
 * Run:
 *   AWS_MCP_LIVE_TESTS=1 AWS_MCP_LIVE_PROFILE=my-profile npm test
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { _resetSession } from "../session.js";
import { resourceTools } from "./resource.js";

const LIVE = process.env.AWS_MCP_LIVE_TESTS === "1";
const LIVE_PROFILE = process.env.AWS_MCP_LIVE_PROFILE;
const LIVE_REGION = process.env.AWS_MCP_LIVE_REGION;

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AWS = join(__dirname, "..", "testing", "fake-aws.js");

const getTool = (name: string) => {
  const t = resourceTools.find((x) => x.name === name);
  if (!t) throw new Error(`resourceTools missing ${name}`);
  return t;
};

const getRes = getTool("aws_resource_get");
const listRes = getTool("aws_resource_list");
const createRes = getTool("aws_resource_create");
const updateRes = getTool("aws_resource_update");
const deleteRes = getTool("aws_resource_delete");
const statusRes = getTool("aws_resource_status");
const diffRes = getTool("aws_resource_diff");

const commonOpts = (): { profile?: string; region?: string; timeoutMs: number } => ({
  ...(LIVE_PROFILE ? { profile: LIVE_PROFILE } : {}),
  ...(LIVE_REGION ? { region: LIVE_REGION } : {}),
  timeoutMs: 30_000,
});

interface MutationResult {
  ok: boolean;
  data?: {
    requestToken?: string | null;
    operationStatus?: string | null;
    identifier?: string | null;
    errorCode?: string | null;
    statusMessage?: string | null;
    awaited?: { attempts: number; elapsedMs: number };
  };
  error?: string;
}

interface TerminalState {
  operationStatus: string;
  errorCode?: string | null;
  statusMessage?: string | null;
  identifier?: string | null;
}

async function waitUntilTerminal(requestToken: string, maxMs = 60_000, pollMs = 1_000): Promise<TerminalState> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const r = (await statusRes.handler({ requestToken, ...commonOpts() })) as MutationResult;
    if (!r.ok) throw new Error(`status polling failed: ${r.error}`);
    const status = r.data?.operationStatus;
    if (!status) throw new Error("operationStatus missing from status response");
    if (status !== "IN_PROGRESS" && status !== "PENDING") {
      return {
        operationStatus: status,
        errorCode: r.data?.errorCode,
        statusMessage: r.data?.statusMessage,
        identifier: r.data?.identifier,
      };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`request ${requestToken} did not reach a terminal state within ${maxMs}ms`);
}

// node:test's describe() honors a skip option in the options object. When
// AWS_MCP_LIVE_TESTS is unset the whole block is reported as skipped rather
// than executed, so `npm test` in CI / local dev stays offline by default.
describe("aws_resource -- live CCAPI lifecycle", { skip: !LIVE }, () => {
  it("create -> get -> update -> get -> delete on AWS::SSM::Parameter", async () => {
    const paramName = `/aws-mcp-live-test/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let createdIdentifier: string | undefined;

    try {
      // --- CREATE ---
      const create = (await createRes.handler({
        typeName: "AWS::SSM::Parameter",
        desiredState: { Name: paramName, Type: "String", Value: "initial" },
        ...commonOpts(),
      })) as MutationResult;
      assert.equal(create.ok, true, `create failed: ${create.error}`);
      const createToken = create.data?.requestToken;
      assert.ok(createToken, "create should return a top-level requestToken");

      const createDone = await waitUntilTerminal(createToken);
      assert.equal(
        createDone.operationStatus,
        "SUCCESS",
        `create ended in ${createDone.operationStatus} (${createDone.errorCode ?? "?"}: ${createDone.statusMessage ?? ""})`,
      );
      createdIdentifier = createDone.identifier ?? paramName;

      // --- GET (initial) ---
      const get1 = (await getRes.handler({
        typeName: "AWS::SSM::Parameter",
        identifier: createdIdentifier,
        ...commonOpts(),
      })) as { ok: boolean; data?: { properties: { Value?: string } }; error?: string };
      assert.equal(get1.ok, true, `get failed: ${get1.error}`);
      assert.equal(get1.data?.properties.Value, "initial", "initial Value should match desiredState");

      // --- UPDATE ---
      const update = (await updateRes.handler({
        typeName: "AWS::SSM::Parameter",
        identifier: createdIdentifier,
        patchDocument: [{ op: "replace", path: "/Value", value: "updated" }],
        ...commonOpts(),
      })) as MutationResult;
      assert.equal(update.ok, true, `update failed: ${update.error}`);
      const updateToken = update.data?.requestToken;
      assert.ok(updateToken, "update should return a top-level requestToken");
      const updateDone = await waitUntilTerminal(updateToken);
      assert.equal(
        updateDone.operationStatus,
        "SUCCESS",
        `update ended in ${updateDone.operationStatus} (${updateDone.errorCode ?? "?"})`,
      );

      // --- GET (after update) ---
      const get2 = (await getRes.handler({
        typeName: "AWS::SSM::Parameter",
        identifier: createdIdentifier,
        ...commonOpts(),
      })) as { ok: boolean; data?: { properties: { Value?: string } }; error?: string };
      assert.equal(get2.ok, true, `second get failed: ${get2.error}`);
      assert.equal(get2.data?.properties.Value, "updated", "updated Value should reflect the JSON Patch");
    } finally {
      // Cleanup ALWAYS runs. If assertions in the try block fail, we still
      // delete the parameter so the next test run starts clean. Swallow
      // cleanup errors so the original assertion failure is what surfaces.
      if (createdIdentifier) {
        try {
          const del = (await deleteRes.handler({
            typeName: "AWS::SSM::Parameter",
            identifier: createdIdentifier,
            ...commonOpts(),
          })) as MutationResult;
          const delToken = del.ok ? del.data?.requestToken : undefined;
          if (delToken) {
            await waitUntilTerminal(delToken).catch(() => undefined);
          }
        } catch {
          // ignore
        }
      }
    }
  });

  it("create with awaitCompletion: true returns a terminal status in one call", async () => {
    const paramName = `/aws-mcp-live-test-await/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let createdIdentifier: string | undefined;
    try {
      const create = (await createRes.handler({
        typeName: "AWS::SSM::Parameter",
        desiredState: { Name: paramName, Type: "String", Value: "awaited" },
        awaitCompletion: true,
        pollIntervalMs: 1_000,
        maxWaitMs: 60_000,
        ...commonOpts(),
      })) as MutationResult;
      assert.equal(create.ok, true, `awaited create failed: ${create.error}`);
      assert.equal(
        create.data?.operationStatus,
        "SUCCESS",
        `awaited create ended in ${create.data?.operationStatus} (${create.data?.errorCode ?? "?"})`,
      );
      assert.ok(create.data?.awaited, "awaited block should be present when awaitCompletion is true");
      assert.ok((create.data?.awaited?.attempts ?? 0) >= 1);
      createdIdentifier = create.data?.identifier ?? paramName;
    } finally {
      if (createdIdentifier) {
        try {
          await deleteRes.handler({
            typeName: "AWS::SSM::Parameter",
            identifier: createdIdentifier,
            awaitCompletion: true,
            maxWaitMs: 60_000,
            ...commonOpts(),
          });
        } catch {
          // ignore
        }
      }
    }
  });
});

/**
 * Fake-aws-driven handler integration -- runs in a normal `npm test` (no
 * AWS_MCP_LIVE_TESTS, no real account). These exercise the handlers end-to-end
 * through runAwsCall by routing its spawn at the fake-aws shim via the
 * documented AWS_MCP_TEST_AWS_* env hook, the same mechanism resource.test.ts
 * uses for the awaitCompletion mid-poll auth-lapse tests. Distinct from the
 * unit-level argv/parse tests in resource.test.ts: these drive the FULL handler
 * including the Phase-1 stateful scenarios (pagination resume, create -> status
 * poll) rather than asserting flag placement.
 */
describe("aws_resource_list -- pagination via fake-aws", () => {
  const setEnv = (): void => {
    process.env.AWS_MCP_TEST_AWS_COMMAND = process.execPath;
    process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS = JSON.stringify([FAKE_AWS]);
    process.env.AWS_MCP_FAKE_SCENARIO = "ccapi_list_resources_paginated";
    _resetSession();
  };
  const clearEnv = (): void => {
    delete process.env.AWS_MCP_TEST_AWS_COMMAND;
    delete process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS;
    delete process.env.AWS_MCP_FAKE_SCENARIO;
    _resetSession();
  };

  interface ListResult {
    ok: boolean;
    data?: {
      resources: { identifier?: string; properties?: unknown }[];
      nextToken: string | null;
      hasMore: boolean;
    };
    error?: string;
  }

  it("first page (no nextToken) returns 2 parsed resources + a resume cursor + hasMore", async () => {
    setEnv();
    try {
      const r = (await listRes.handler({ typeName: "AWS::SSM::Parameter" })) as ListResult;
      assert.equal(r.ok, true, `list page 1 failed: ${r.error}`);
      const d = r.data;
      assert.ok(d, "page 1 data missing");
      // The fake scenario branches on --next-token in argv: absent -> page 1.
      assert.equal(d.resources.length, 2);
      assert.equal(d.resources[0].identifier, "/my/param-1");
      assert.equal(d.resources[1].identifier, "/my/param-2");
      // Properties arrive from CCAPI as a JSON-ENCODED STRING; the handler
      // (parseResourceProperties) must turn that back into an object.
      assert.deepEqual(d.resources[0].properties, { Name: "/my/param-1", Type: "String", Value: "v1" });
      assert.deepEqual(d.resources[1].properties, { Name: "/my/param-2", Type: "String", Value: "v2" });
      // Truncated page: a resume cursor under nextToken and hasMore=true.
      assert.equal(d.nextToken, "ccapi-list-cursor-page2");
      assert.equal(d.hasMore, true);
    } finally {
      clearEnv();
    }
  });

  it("second page (WITH nextToken) returns the final 2 resources, nextToken null, hasMore false", async () => {
    setEnv();
    try {
      // Passing nextToken puts --next-token in the argv, which flips the fake
      // scenario to the FINAL page (no top-level NextToken in its response).
      const r = (await listRes.handler({
        typeName: "AWS::SSM::Parameter",
        nextToken: "ccapi-list-cursor-page2",
      })) as ListResult;
      assert.equal(r.ok, true, `list page 2 failed: ${r.error}`);
      const d = r.data;
      assert.ok(d, "page 2 data missing");
      assert.equal(d.resources.length, 2);
      assert.equal(d.resources[0].identifier, "/my/param-3");
      assert.equal(d.resources[1].identifier, "/my/param-4");
      assert.deepEqual(d.resources[0].properties, { Name: "/my/param-3", Type: "String", Value: "v3" });
      assert.deepEqual(d.resources[1].properties, { Name: "/my/param-4", Type: "String", Value: "v4" });
      // Exhausted: no resume cursor, hasMore false.
      assert.equal(d.nextToken, null);
      assert.equal(d.hasMore, false);
    } finally {
      clearEnv();
    }
  });
});

describe("aws_resource_create -- awaitCompletion happy path via fake-aws", () => {
  const setEnv = (): void => {
    process.env.AWS_MCP_TEST_AWS_COMMAND = process.execPath;
    process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS = JSON.stringify([FAKE_AWS]);
    process.env.AWS_MCP_FAKE_SCENARIO = "ccapi_create_then_status_success";
    _resetSession();
  };
  const clearEnv = (): void => {
    delete process.env.AWS_MCP_TEST_AWS_COMMAND;
    delete process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS;
    delete process.env.AWS_MCP_FAKE_SCENARIO;
    _resetSession();
  };

  it("create -> status poll reaches terminal SUCCESS in one handler call", async () => {
    setEnv();
    try {
      // create-resource returns IN_PROGRESS (RequestToken req-tok-ok); the
      // status poll returns SUCCESS on the FIRST attempt, so buildMutationResponse
      // walks the poll loop exactly once. NOT the req-tok-abc / sso-expired flow.
      const r = (await createRes.handler({
        typeName: "AWS::SSM::Parameter",
        desiredState: { Name: "/my/p", Type: "String", Value: "v" },
        awaitCompletion: true,
        pollIntervalMs: 500,
        maxWaitMs: 5_000,
      })) as MutationResult;
      assert.equal(r.ok, true, `awaited create failed: ${r.error}`);
      assert.equal(r.data?.operationStatus, "SUCCESS");
      // The final ProgressEvent's RequestToken survives onto the flat field.
      assert.equal(r.data?.requestToken, "req-tok-ok");
      // awaitCompletion was honored: the awaited block is present and the
      // terminal status was reached on the first poll (attempts === 1).
      assert.ok(r.data?.awaited, "awaited block must be present when awaitCompletion is true");
      assert.equal(r.data?.awaited?.attempts, 1);
    } finally {
      clearEnv();
    }
  });
});

describe("aws_resource_create -- awaitCompletion short-circuits an already-terminal create via fake-aws", () => {
  const setEnv = (): void => {
    process.env.AWS_MCP_TEST_AWS_COMMAND = process.execPath;
    process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS = JSON.stringify([FAKE_AWS]);
    process.env.AWS_MCP_FAKE_SCENARIO = "ccapi_create_already_terminal";
    _resetSession();
  };
  const clearEnv = (): void => {
    delete process.env.AWS_MCP_TEST_AWS_COMMAND;
    delete process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS;
    delete process.env.AWS_MCP_FAKE_SCENARIO;
    _resetSession();
  };

  it("returns SUCCESS without polling when the initial create is already terminal", async () => {
    setEnv();
    try {
      // create-resource returns OperationStatus=SUCCESS on the FIRST response.
      // buildMutationResponse's `!alreadyTerminal` guard must skip the poll
      // loop entirely. The fake scenario's get-resource-request-status branch
      // ERRORS, so reaching it would flip ok to false -- a clean SUCCESS here
      // proves the short-circuit held.
      const r = (await createRes.handler({
        typeName: "AWS::SSM::Parameter",
        desiredState: { Name: "/my/p", Type: "String", Value: "v" },
        awaitCompletion: true,
        pollIntervalMs: 500,
        maxWaitMs: 5_000,
      })) as MutationResult;
      assert.equal(r.ok, true, `already-terminal create failed (poll should have been skipped): ${r.error}`);
      assert.equal(r.data?.operationStatus, "SUCCESS");
      assert.equal(r.data?.requestToken, "req-tok-term");
      // No `awaited` block: the short-circuit returns the flat fields directly
      // and never enters the poll branch that would attach one.
      assert.equal(r.data?.awaited, undefined, "awaited block must be ABSENT when the initial status is terminal");
    } finally {
      clearEnv();
    }
  });
});

/**
 * Shared fake-aws env plumbing for the handler-level blocks below. Identical
 * to the setEnv/clearEnv pairs above; hoisted because five describes need it
 * with a different scenario each.
 */
const withFakeAws = (scenario: string): void => {
  process.env.AWS_MCP_TEST_AWS_COMMAND = process.execPath;
  process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS = JSON.stringify([FAKE_AWS]);
  process.env.AWS_MCP_FAKE_SCENARIO = scenario;
  _resetSession();
};
const clearFakeAws = (): void => {
  delete process.env.AWS_MCP_TEST_AWS_COMMAND;
  delete process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS;
  delete process.env.AWS_MCP_FAKE_SCENARIO;
  _resetSession();
};

interface DiffResult {
  ok: boolean;
  data?: {
    command: string;
    typeName: string;
    identifier: string;
    before: unknown;
    after: unknown;
    changes: { op: string; path: string; before?: unknown; after?: unknown }[];
    changeCount: number;
  };
  error?: string;
}

describe("aws_resource_diff -- handler glue chain via fake-aws", () => {
  // Everything else about diff is unit-tested piecemeal (applyJsonPatch,
  // summarizePatch, resolvePointer) or schema-tested. The HANDLER that wires
  // them together -- ccapiCall get-resource -> parseResourceProperties ->
  // applyJsonPatch -> summarizePatch -> {before, after, changes, changeCount}
  // -- was never invoked. It is the pre-mutation preview the model consults
  // before aws_resource_update, so a glue bug here does not surface as an
  // error: it produces a plausible-looking `before`/`changes` that gets acted
  // on.

  it("returns before/after/changes for a multi-op patch without mutating anything", async () => {
    withFakeAws("res2_diff_get_ok");
    try {
      const r = (await diffRes.handler({
        typeName: "AWS::Lambda::Function",
        identifier: "my-fn",
        patchDocument: [
          { op: "replace", path: "/MemorySize", value: 512 },
          { op: "remove", path: "/Environment/Variables/DROP" },
          { op: "add", path: "/Tags/-", value: "beta" },
        ],
      })) as DiffResult;
      assert.equal(r.ok, true, `diff failed: ${r.error}`);
      const d = r.data;
      assert.ok(d, "diff data missing");

      // The get-resource call actually happened, and its command is echoed.
      assert.match(d.command, /cloudcontrol/);
      assert.match(d.command, /get-resource/);
      assert.equal(d.typeName, "AWS::Lambda::Function");
      // Identifier comes from the fetched ResourceDescription, not the input.
      assert.equal(d.identifier, "my-fn");

      // `before` is the CCAPI Properties STRING parsed back into an object.
      assert.deepEqual(d.before, {
        FunctionName: "my-fn",
        MemorySize: 256,
        Timeout: 3,
        Environment: { Variables: { KEEP: "yes", DROP: "gone" } },
        Tags: ["alpha"],
      });

      // `after` is the simulated post-patch document: scalar replaced, nested
      // key removed, array appended, untouched keys carried through.
      assert.deepEqual(d.after, {
        FunctionName: "my-fn",
        MemorySize: 512,
        Timeout: 3,
        Environment: { Variables: { KEEP: "yes" } },
        Tags: ["alpha", "beta"],
      });

      // No mutation is sent to AWS AND none happens locally either: the
      // `before` document the caller is shown must still be the pre-patch
      // state after applyJsonPatch ran over it.
      const before = d.before as {
        MemorySize: number;
        Environment: { Variables: Record<string, string> };
        Tags: string[];
      };
      assert.equal(before.MemorySize, 256);
      assert.equal(before.Environment.Variables.DROP, "gone");
      assert.deepEqual(before.Tags, ["alpha"]);

      // The flat change list, one entry per op, in patch order.
      assert.equal(d.changeCount, 3);
      assert.equal(d.changes.length, 3);
      assert.deepEqual(d.changes[0], { op: "replace", path: "/MemorySize", before: 256, after: 512 });
      assert.equal(d.changes[1].op, "remove");
      assert.equal(d.changes[1].path, "/Environment/Variables/DROP");
      assert.equal(d.changes[1].before, "gone");
      assert.equal(d.changes[1].after, undefined, "a removed path has no after value");
      assert.equal(d.changes[2].op, "add");
      assert.equal(d.changes[2].path, "/Tags/-");
      assert.equal(d.changes[2].before, undefined);
      // RFC 6901's "-" names a slot, not a value, so resolvePointer returns
      // undefined and summarizePatch falls back to the op's own value.
      assert.equal(d.changes[2].after, "beta");
    } finally {
      clearFakeAws();
    }
  });

  it("returns a 'Patch application failed' error when the patch cannot apply", async () => {
    withFakeAws("res2_diff_get_ok");
    try {
      // Same successful fetch; the failure is local. `replace` on a key that
      // does not exist throws inside applyJsonPatch, and the handler must
      // translate it rather than let it escape.
      const r = (await diffRes.handler({
        typeName: "AWS::Lambda::Function",
        identifier: "my-fn",
        patchDocument: [{ op: "replace", path: "/NoSuchKey", value: 1 }],
      })) as DiffResult;
      assert.equal(r.ok, false);
      assert.match(r.error ?? "", /^Patch application failed: /);
      // The underlying reason survives the translation.
      assert.match(r.error ?? "", /Cannot replace missing key 'NoSuchKey'/);
      assert.equal(r.data, undefined, "a failed patch must not return a partial before/after preview");
    } finally {
      clearFakeAws();
    }
  });
});

describe("resource verbs -- initial ccapiCall failure (ccapiFailure + rawBodyOf)", () => {
  // Every verb starts with `if (!result.ok) return ccapiFailure(result)`, and
  // nothing in the suite drove any of them into it -- so ccapiFailure and
  // rawBodyOf were both dead in test. The failure envelope is what the model
  // sees for an AccessDenied / throttle / bad-type call, which is the common
  // case in an under-permissioned account.

  const verbs: { name: string; tool: typeof getRes; input: Record<string, unknown> }[] = [
    { name: "aws_resource_get", tool: getRes, input: { typeName: "AWS::Lambda::Function", identifier: "my-fn" } },
    { name: "aws_resource_list", tool: listRes, input: { typeName: "AWS::Lambda::Function" } },
    {
      name: "aws_resource_create",
      tool: createRes,
      input: { typeName: "AWS::SSM::Parameter", desiredState: { Name: "/x", Type: "String", Value: "y" } },
    },
    {
      name: "aws_resource_update",
      tool: updateRes,
      input: {
        typeName: "AWS::Lambda::Function",
        identifier: "my-fn",
        patchDocument: [{ op: "replace", path: "/MemorySize", value: 512 }],
      },
    },
    { name: "aws_resource_delete", tool: deleteRes, input: { typeName: "AWS::S3::Bucket", identifier: "my-bucket" } },
    {
      name: "aws_resource_diff",
      tool: diffRes,
      input: {
        typeName: "AWS::Lambda::Function",
        identifier: "my-fn",
        patchDocument: [{ op: "replace", path: "/MemorySize", value: 512 }],
      },
    },
  ];

  for (const verb of verbs) {
    it(`${verb.name} returns the failure envelope with stderr as rawBody`, async () => {
      withFakeAws("res2_ccapi_initial_fail_stderr");
      try {
        const r = await verb.tool.handler(verb.input);
        assert.equal(r.ok, false, `${verb.name} should surface the CLI failure`);
        assert.match(r.error ?? "", /AccessDeniedException/);
        assert.equal(r.data, undefined, `${verb.name} must not return data on a failed call`);
        // rawBodyOf's first half: a populated stderr IS the diagnostic body.
        assert.match(r.rawBody ?? "", /not authorized to perform: cloudformation:GetResource/);
      } finally {
        clearFakeAws();
      }
    });
  }

  it("falls back to stdout for rawBody when stderr is EMPTY on a nonzero exit", async () => {
    // The `rawStderr ? rawStderr : rawStdout` half with no coverage anywhere in
    // the repo. Truthiness is the point: with `rawStderr ?? rawStdout` the
    // empty-string stderr wins and the only diagnostic bytes are dropped, so
    // the caller gets an error with no body at all.
    withFakeAws("res2_ccapi_initial_fail_stdout_only");
    try {
      const r = await getRes.handler({ typeName: "AWS::Lambda::Function", identifier: "my-fn" });
      assert.equal(r.ok, false);
      // Empty stderr means the classifier has nothing to match, so this lands
      // as a generic nonzero exit.
      assert.match(r.error ?? "", /exited with code 1 and no stderr/);
      assert.equal(typeof r.rawBody, "string", "rawBody must not be dropped when the diagnostic is on stdout");
      assert.match(r.rawBody ?? "", /ccapi-diagnostic-on-stdout-only/);
    } finally {
      clearFakeAws();
    }
  });
});

describe("propertiesRaw survives an unparseable CCAPI Properties string", () => {
  // parseResourceProperties keeps the raw string when JSON.parse fails, but
  // the unit test stops at that function. Both VERBS have to carry it onto
  // their own response entry -- get at the top level, list per-resource --
  // and list dropped it once already, which made the two verbs disagree about
  // the shape of the same resource.

  it("aws_resource_get surfaces propertiesRaw alongside the unparsed properties", async () => {
    withFakeAws("res2_props_unparseable");
    try {
      const r = await getRes.handler({ typeName: "AWS::SSM::Parameter", identifier: "/my/param-bad" });
      assert.equal(r.ok, true, `get failed: ${r.error}`);
      const d = r.data as { identifier?: string; properties?: unknown; propertiesRaw?: string };
      assert.equal(d.identifier, "/my/param-bad");
      assert.equal(d.properties, "{not-valid-json", "an unparseable Properties stays the raw string");
      assert.equal(d.propertiesRaw, "{not-valid-json");
    } finally {
      clearFakeAws();
    }
  });

  it("aws_resource_list surfaces propertiesRaw on the per-resource entry", async () => {
    withFakeAws("res2_props_unparseable");
    try {
      const r = await listRes.handler({ typeName: "AWS::SSM::Parameter" });
      assert.equal(r.ok, true, `list failed: ${r.error}`);
      const d = r.data as {
        resources: { identifier?: string; properties?: unknown; propertiesRaw?: string }[];
      };
      assert.equal(d.resources.length, 1);
      assert.equal(d.resources[0].identifier, "/my/param-bad");
      assert.equal(d.resources[0].properties, "{not-valid-json");
      assert.equal(d.resources[0].propertiesRaw, "{not-valid-json");
    } finally {
      clearFakeAws();
    }
  });

  it("neither verb attaches propertiesRaw when Properties parses cleanly", async () => {
    // The key is spread conditionally, so its ABSENCE on the normal path is
    // part of the contract -- a caller checking `if (propertiesRaw)` to detect
    // a parse failure would be wrong if it were always present.
    withFakeAws("ccapi_list_resources_paginated");
    try {
      const r = await listRes.handler({ typeName: "AWS::SSM::Parameter" });
      assert.equal(r.ok, true);
      const d = r.data as { resources: { propertiesRaw?: string }[] };
      for (const res of d.resources) {
        assert.equal(res.propertiesRaw, undefined);
      }
    } finally {
      clearFakeAws();
    }
  });
});

interface AwaitSkippedResult {
  ok: boolean;
  data?: {
    operationStatus?: string | null;
    requestToken?: string | null;
    awaited?: { attempts: number; elapsedMs: number };
    awaitSkipped?: string;
  };
  error?: string;
}

describe("aws_resource_create -- awaitCompletion with no requestToken (awaitSkipped)", () => {
  it("returns the not-awaited shape plus an explanatory awaitSkipped string", async () => {
    // A non-terminal ProgressEvent with no RequestToken: there is nothing to
    // poll, so the caller's requested wait silently never happened. Returning
    // the bare IN_PROGRESS shape looked identical to awaitCompletion:false,
    // which is why the explanation exists.
    withFakeAws("res2_create_no_request_token");
    try {
      const r = (await createRes.handler({
        typeName: "AWS::SSM::Parameter",
        desiredState: { Name: "/my/p", Type: "String", Value: "v" },
        awaitCompletion: true,
        pollIntervalMs: 500,
        maxWaitMs: 5_000,
      })) as AwaitSkippedResult;
      // The scenario ERRORS on get-resource-request-status, so ok:true also
      // proves no poll was attempted.
      assert.equal(r.ok, true, `create failed (a poll should never have been attempted): ${r.error}`);
      assert.equal(r.data?.operationStatus, "IN_PROGRESS");
      assert.equal(r.data?.requestToken, null, "no RequestToken in the event means the flat field is null");
      assert.equal(r.data?.awaited, undefined, "no poll ran, so there is no awaited block");
      assert.match(r.data?.awaitSkipped ?? "", /awaitCompletion was requested/);
      assert.match(r.data?.awaitSkipped ?? "", /no requestToken/);
      assert.match(r.data?.awaitSkipped ?? "", /clientToken/);
    } finally {
      clearFakeAws();
    }
  });

  it("does NOT attach awaitSkipped when awaitCompletion was never requested", async () => {
    // Same response, no awaitCompletion: nothing was skipped, so the key must
    // be absent rather than explaining a wait the caller never asked for.
    withFakeAws("res2_create_no_request_token");
    try {
      const r = (await createRes.handler({
        typeName: "AWS::SSM::Parameter",
        desiredState: { Name: "/my/p", Type: "String", Value: "v" },
      })) as AwaitSkippedResult;
      assert.equal(r.ok, true, `create failed: ${r.error}`);
      assert.equal(r.data?.operationStatus, "IN_PROGRESS");
      assert.equal(r.data?.awaitSkipped, undefined);
    } finally {
      clearFakeAws();
    }
  });
});
