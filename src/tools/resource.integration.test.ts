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
import { describe, it } from "node:test";
import { resourceTools } from "./resource.js";

const LIVE = process.env.AWS_MCP_LIVE_TESTS === "1";
const LIVE_PROFILE = process.env.AWS_MCP_LIVE_PROFILE;
const LIVE_REGION = process.env.AWS_MCP_LIVE_REGION;

const getTool = (name: string) => {
  const t = resourceTools.find((x) => x.name === name);
  if (!t) throw new Error(`resourceTools missing ${name}`);
  return t;
};

const getRes = getTool("aws_resource_get");
const createRes = getTool("aws_resource_create");
const updateRes = getTool("aws_resource_update");
const deleteRes = getTool("aws_resource_delete");
const statusRes = getTool("aws_resource_status");

const commonOpts = (): { profile?: string; region?: string; timeoutMs: number } => ({
  ...(LIVE_PROFILE ? { profile: LIVE_PROFILE } : {}),
  ...(LIVE_REGION ? { region: LIVE_REGION } : {}),
  timeoutMs: 30_000,
});

interface ProgressEvent {
  OperationStatus: string;
  ErrorCode?: string;
  StatusMessage?: string;
  Identifier?: string;
  RequestToken: string;
}

interface MutationResult {
  ok: boolean;
  data?: { progressEvent?: ProgressEvent };
  error?: string;
}

interface TerminalState {
  operationStatus: string;
  errorCode?: string;
  statusMessage?: string;
  identifier?: string;
}

async function waitUntilTerminal(requestToken: string, maxMs = 60_000, pollMs = 1_000): Promise<TerminalState> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const r = (await statusRes.handler({ requestToken, ...commonOpts() })) as MutationResult;
    if (!r.ok) throw new Error(`status polling failed: ${r.error}`);
    const ev = r.data?.progressEvent;
    if (!ev) throw new Error("progressEvent missing from status response");
    if (ev.OperationStatus !== "IN_PROGRESS" && ev.OperationStatus !== "PENDING") {
      return {
        operationStatus: ev.OperationStatus,
        errorCode: ev.ErrorCode,
        statusMessage: ev.StatusMessage,
        identifier: ev.Identifier,
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
      const createToken = create.data?.progressEvent?.RequestToken;
      assert.ok(createToken, "create should return a RequestToken");

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
      const updateToken = update.data?.progressEvent?.RequestToken;
      assert.ok(updateToken, "update should return a RequestToken");
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
          const delToken = del.ok ? del.data?.progressEvent?.RequestToken : undefined;
          if (delToken) {
            await waitUntilTerminal(delToken).catch(() => undefined);
          }
        } catch {
          // ignore
        }
      }
    }
  });
});
