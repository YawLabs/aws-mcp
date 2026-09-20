/**
 * Live aws_iam_simulate integration test -- runs against a real AWS account.
 *
 * READ-ONLY: SimulatePrincipalPolicy evaluates policies and mutates nothing, so
 * there is no cleanup and nothing can be left behind. The buckets it names need
 * not exist; the simulator answers about the ARN, not about the resource.
 *
 * It lives in its OWN file on purpose. iam-simulate.test.ts has a file-level
 * before() that routes EVERY spawn to fake-aws.js through
 * AWS_MCP_TEST_AWS_COMMAND / _PREFIX_ARGS, so a "live" test placed there would
 * quietly pass against the fake -- which is the whole class of bug this suite
 * keeps finding. Nothing here sets those vars.
 *
 * What it is for: the 2026-07-30 response shape was verified from AWS's API
 * reference and by replaying the documented XML through the real aws CLI against
 * a local stub. Neither of those observes what AWS actually SENDS. This does:
 * whether one action against two resources yields per-resource rows with the
 * caller's own ARNs, and whether a resource-less call reports '*'.
 *
 * Gated behind BOTH AWS_MCP_LIVE_TESTS=1 and AWS_MCP_LIVE_IAM_PRINCIPAL_ARN, so
 * a normal `npm test` reports the block as skipped.
 *
 * Prereqs when running live:
 *   - aws CLI v2 on PATH
 *   - iam:SimulatePrincipalPolicy on the caller
 *   - AWS_MCP_LIVE_IAM_PRINCIPAL_ARN set to an IAM user, group or ROLE ARN --
 *     not the STS session ARN aws_whoami reports (the handler rejects that, and
 *     says how to look the role up). Get it with:
 *       aws iam get-role --role-name <role> --query Role.Arn
 *   - Profile / region: default to the usual AWS_PROFILE / AWS_REGION chain, or
 *     set AWS_MCP_LIVE_PROFILE / AWS_MCP_LIVE_REGION to override just for this
 *     test, as resource.integration.test.ts does.
 *
 * Run THIS FILE ONLY -- a bare `AWS_MCP_LIVE_TESTS=1 npm test` also fires
 * resource.integration.test.ts's live Cloud Control create/delete:
 *   npm run build && AWS_MCP_LIVE_TESTS=1 \
 *     AWS_MCP_LIVE_IAM_PRINCIPAL_ARN=arn:aws:iam::<account>:role/<role> \
 *     AWS_MCP_LIVE_PROFILE=<profile> \
 *     node --test dist/tools/iam-simulate.integration.test.js
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { iamSimulateTools } from "./iam-simulate.js";

const LIVE = process.env.AWS_MCP_LIVE_TESTS === "1";
const LIVE_PRINCIPAL = process.env.AWS_MCP_LIVE_IAM_PRINCIPAL_ARN;
const LIVE_PROFILE = process.env.AWS_MCP_LIVE_PROFILE;
const LIVE_REGION = process.env.AWS_MCP_LIVE_REGION;

const tool = iamSimulateTools.find((t) => t.name === "aws_iam_simulate");
if (!tool) throw new Error("iamSimulateTools missing aws_iam_simulate");

const commonOpts = (): { profile?: string; region?: string; timeoutMs: number } => ({
  ...(LIVE_PROFILE ? { profile: LIVE_PROFILE } : {}),
  ...(LIVE_REGION ? { region: LIVE_REGION } : {}),
  timeoutMs: 30_000,
});

const DECISIONS = ["allowed", "explicitDeny", "implicitDeny"];

interface SimulateData {
  summary: { allowed: number; denied: number; unknown: number; total: number };
  results: { action: string; resource: string; decision: string }[];
  marker: string | null;
  hasMore: boolean;
}

describe("aws_iam_simulate -- live SimulatePrincipalPolicy (read-only)", { skip: !LIVE || !LIVE_PRINCIPAL }, () => {
  it("returns one row per resource, each naming the ARN that was asked about", async () => {
    // Random bucket names so nothing depends on the account's contents. The
    // decision may be any of the three; what is under test is the SHAPE.
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const resources = [
      `arn:aws:s3:::aws-mcp-shape-probe-a-${suffix}/k`,
      `arn:aws:s3:::aws-mcp-shape-probe-b-${suffix}/k`,
    ];
    const r = await tool.handler({
      principalArn: LIVE_PRINCIPAL,
      actions: ["s3:GetObject"],
      resources,
      ...commonOpts(),
    } as never);
    assert.equal(r.ok, true, `live simulate failed: ${r.error}`);
    const data = r.data as SimulateData;
    assert.equal(data.results.length, 2, "one action x two resources must be two rows, not one");
    assert.deepEqual(
      data.results.map((row) => row.resource).sort(),
      [...resources].sort(),
      "each row must name a resource the caller passed, never IAM's ARN template",
    );
    for (const row of data.results) {
      assert.ok(DECISIONS.includes(row.decision), `decision outside IAM's enum: ${row.decision}`);
    }
    assert.equal(data.summary.total, 2);
    // The CLI follows IAM's pagination itself, so a first call is complete.
    assert.equal(data.hasMore, false);
    assert.equal(data.marker, null);
  });

  it("reports '*' for a resource-less call", async () => {
    const r = await tool.handler({
      principalArn: LIVE_PRINCIPAL,
      actions: ["s3:ListAllMyBuckets"],
      ...commonOpts(),
    } as never);
    assert.equal(r.ok, true, `live simulate failed: ${r.error}`);
    const data = r.data as SimulateData;
    assert.equal(data.results.length, 1);
    assert.equal(data.results[0].resource, "*", "AWS applies ['*'] server-side; the row must say so");
    assert.ok(DECISIONS.includes(data.results[0].decision));
    assert.equal(data.hasMore, false);
    assert.equal(data.marker, null);
  });
});
