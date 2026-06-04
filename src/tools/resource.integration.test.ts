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
