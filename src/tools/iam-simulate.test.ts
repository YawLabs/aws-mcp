import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { _resetSession } from "../session.js";
import { iamSimulateTools, parseSimulationResults } from "./iam-simulate.js";

const tool = iamSimulateTools.find((t) => t.name === "aws_iam_simulate");
if (!tool) throw new Error("iamSimulateTools missing aws_iam_simulate");

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AWS = join(__dirname, "..", "testing", "fake-aws.js");

let prevCommand: string | undefined;
let prevPrefixArgs: string | undefined;
before(() => {
  prevCommand = process.env.AWS_MCP_TEST_AWS_COMMAND;
  prevPrefixArgs = process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS;
  process.env.AWS_MCP_TEST_AWS_COMMAND = process.execPath;
  process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS = JSON.stringify([FAKE_AWS]);
});
after(() => {
  if (prevCommand === undefined) delete process.env.AWS_MCP_TEST_AWS_COMMAND;
  else process.env.AWS_MCP_TEST_AWS_COMMAND = prevCommand;
  if (prevPrefixArgs === undefined) delete process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS;
  else process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS = prevPrefixArgs;
});

afterEach(() => {
  _resetSession();
  delete process.env.AWS_MCP_FAKE_SCENARIO;
});

describe("aws_iam_simulate schema", () => {
  it("accepts a minimal valid input", () => {
    const r = tool.inputSchema.safeParse({
      principalArn: "arn:aws:iam::123456789012:user/jeff",
      actions: ["lambda:CreateFunction"],
    });
    assert.equal(r.success, true);
  });

  it("rejects empty actions", () => {
    const r = tool.inputSchema.safeParse({
      principalArn: "arn:aws:iam::123:user/jeff",
      actions: [],
    });
    assert.equal(r.success, false);
  });

  it("rejects more than 50 actions", () => {
    const actions = Array.from({ length: 51 }, (_, i) => `s3:Action${i}`);
    const r = tool.inputSchema.safeParse({ principalArn: "arn:aws:iam::123:user/x", actions });
    assert.equal(r.success, false);
  });

  it("rejects an unsupported contextKeyType", () => {
    const r = tool.inputSchema.safeParse({
      principalArn: "arn:aws:iam::123:user/x",
      actions: ["s3:GetObject"],
      contextEntries: [{ contextKeyName: "k", contextKeyType: "garbage", contextKeyValues: ["v"] }],
    });
    assert.equal(r.success, false);
  });
});

describe("aws_iam_simulate handler validation", () => {
  it("rejects a non-ARN principal", async () => {
    const r = await tool.handler({ principalArn: "not-an-arn", actions: ["s3:GetObject"] } as never);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /principalArn/);
  });

  it("rejects malformed action shapes", async () => {
    const r = await tool.handler({
      principalArn: "arn:aws:iam::123:user/x",
      actions: ["no-colon-here"],
    } as never);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid action/);
  });

  it("rejects resources with leading hyphen (argv-injection defense)", async () => {
    const r = await tool.handler({
      principalArn: "arn:aws:iam::123:user/x",
      actions: ["s3:GetObject"],
      resources: ["--evil"],
    } as never);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid resource/);
  });
});

describe("parseSimulationResults", () => {
  it("returns empty array for non-array input", () => {
    assert.deepEqual(parseSimulationResults(null), []);
    assert.deepEqual(parseSimulationResults(undefined), []);
    assert.deepEqual(parseSimulationResults("string"), []);
  });

  it("flattens SourcePolicyId from MatchedStatements", () => {
    const out = parseSimulationResults([
      {
        EvalActionName: "s3:GetObject",
        EvalResourceName: "arn:aws:s3:::my-bucket/*",
        EvalDecision: "allowed",
        MatchedStatements: [
          { SourcePolicyId: "ReadOnly", SourcePolicyType: "IAM Policy" },
          { SourcePolicyId: "ExtraAccess", SourcePolicyType: "IAM Policy" },
        ],
      },
    ]);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].matchedStatementIds, ["ReadOnly", "ExtraAccess"]);
  });

  it("surfaces missingContextValues only when non-empty", () => {
    const withCtx = parseSimulationResults([
      {
        EvalActionName: "a",
        EvalResourceName: "*",
        EvalDecision: "allowed",
        MissingContextValues: ["aws:RequestTag/X"],
      },
    ]);
    assert.deepEqual(withCtx[0].missingContextValues, ["aws:RequestTag/X"]);

    const withoutCtx = parseSimulationResults([
      { EvalActionName: "a", EvalResourceName: "*", EvalDecision: "allowed", MissingContextValues: [] },
    ]);
    assert.equal(withoutCtx[0].missingContextValues, undefined);
  });

  it("maps OrganizationsDecisionDetail.AllowedByOrganizations", () => {
    const out = parseSimulationResults([
      {
        EvalActionName: "a",
        EvalResourceName: "*",
        EvalDecision: "allowed",
        OrganizationsDecisionDetail: { AllowedByOrganizations: true },
      },
      {
        EvalActionName: "b",
        EvalResourceName: "*",
        EvalDecision: "explicitDeny",
        OrganizationsDecisionDetail: { AllowedByOrganizations: false },
      },
    ]);
    assert.equal(out[0].organizationsDecision, "allowed");
    assert.equal(out[1].organizationsDecision, "denied");
  });

  it("maps PermissionsBoundaryDecisionDetail.AllowedByPermissionsBoundary", () => {
    const out = parseSimulationResults([
      {
        EvalActionName: "a",
        EvalResourceName: "*",
        EvalDecision: "explicitDeny",
        PermissionsBoundaryDecisionDetail: { AllowedByPermissionsBoundary: false },
      },
    ]);
    assert.equal(out[0].permissionsBoundaryDecision, "denied");
  });

  it("falls back to '*' resource and 'unknown' decision on malformed entries", () => {
    const out = parseSimulationResults([{ EvalActionName: "a" }]);
    assert.equal(out[0].resource, "*");
    assert.equal(out[0].decision, "unknown");
  });
});

describe("aws_iam_simulate handler (fake-aws integration)", () => {
  it("returns summary + flattened results for a single allowed action", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "iam_simulate_allow";
    const r = await tool.handler({
      principalArn: "arn:aws:iam::123456789012:user/jeff",
      actions: ["lambda:CreateFunction"],
    } as never);
    assert.equal(r.ok, true);
    const data = r.data as {
      summary: { allowed: number; denied: number; total: number };
      results: { action: string; decision: string; matchedStatementIds?: string[] }[];
    };
    assert.deepEqual(data.summary, { allowed: 1, denied: 0, total: 1 });
    assert.equal(data.results[0].action, "lambda:CreateFunction");
    assert.equal(data.results[0].decision, "allowed");
    assert.deepEqual(data.results[0].matchedStatementIds, ["AdministratorAccess"]);
  });

  it("counts mixed allow/deny correctly and surfaces missing context", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "iam_simulate_mixed";
    const r = await tool.handler({
      principalArn: "arn:aws:iam::123:user/x",
      actions: ["s3:GetObject", "s3:DeleteObject"],
      resources: ["arn:aws:s3:::my-bucket/*"],
    } as never);
    assert.equal(r.ok, true);
    const data = r.data as {
      summary: { allowed: number; denied: number; total: number };
      results: { action: string; decision: string; missingContextValues?: string[] }[];
    };
    assert.deepEqual(data.summary, { allowed: 1, denied: 1, total: 2 });
    const deletes = data.results.find((res) => res.action === "s3:DeleteObject");
    assert.ok(deletes);
    assert.equal(deletes.decision, "explicitDeny");
    assert.deepEqual(deletes.missingContextValues, ["aws:RequestTag/Project"]);
  });

  it("reports implicitDeny with no matched statements", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "iam_simulate_implicit_deny";
    const r = await tool.handler({
      principalArn: "arn:aws:iam::123:user/x",
      actions: ["ec2:TerminateInstances"],
    } as never);
    assert.equal(r.ok, true);
    const data = r.data as {
      summary: { denied: number };
      results: { decision: string; matchedStatementIds?: string[] }[];
    };
    assert.equal(data.summary.denied, 1);
    assert.equal(data.results[0].decision, "implicitDeny");
    assert.equal(data.results[0].matchedStatementIds, undefined);
  });
});
