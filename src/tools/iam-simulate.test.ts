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
      principalArn: "arn:aws:iam::123456789012:user/jeff",
      actions: [],
    });
    assert.equal(r.success, false);
  });

  it("rejects more than 50 actions", () => {
    const actions = Array.from({ length: 51 }, (_, i) => `s3:Action${i}`);
    const r = tool.inputSchema.safeParse({ principalArn: "arn:aws:iam::123456789012:user/x", actions });
    assert.equal(r.success, false);
  });

  it("rejects an unsupported contextKeyType", () => {
    const r = tool.inputSchema.safeParse({
      principalArn: "arn:aws:iam::123456789012:user/x",
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

  it("rejects an ARN with a wrong-length account ID (AWS account IDs are 12 digits)", async () => {
    // The pre-tightening regex matched [0-9]{0,32}, so 3-digit "accounts"
    // passed schema-shape validation only to fail server-side with a less
    // actionable error. Tightening to exactly-12-or-empty produces a clear
    // upfront rejection.
    const r = await tool.handler({
      principalArn: "arn:aws:iam::123:user/jeff",
      actions: ["s3:GetObject"],
    } as never);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /principalArn/);
  });

  it("accepts an ARN with an empty account segment (AWS-managed global resources)", async () => {
    // Some global-service ARNs legitimately have an empty account segment.
    // The new regex permits empty OR exactly 12 digits; this pins the
    // empty-case allowlist so a future tightening that requires non-empty
    // gets caught here. We expect this to PASS the principalArn check; it
    // may still fail downstream on a CLI call, but the validation step
    // returning a principalArn error would be wrong.
    const r = await tool.handler({
      principalArn: "arn:aws:iam:::role/some-global-role",
      actions: ["s3:GetObject"],
    } as never);
    // We only care that the principalArn check itself does NOT fire. The
    // call may still error on action / CLI, so just assert the error (if
    // any) doesn't mention principalArn.
    if (!r.ok) {
      assert.doesNotMatch(r.error ?? "", /Invalid principalArn/);
    }
  });

  it("rejects an ARN missing the service segment", async () => {
    // pre-tightening regex accepted [a-z0-9-]{0,32} for service, so an ARN
    // with an empty service ('arn:aws::us-east-1:123:resource') slipped
    // through. Service is required by the AWS spec.
    const r = await tool.handler({
      principalArn: "arn:aws::us-east-1:123456789012:user/jeff",
      actions: ["s3:GetObject"],
    } as never);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /principalArn/);
  });

  it("rejects malformed action shapes", async () => {
    const r = await tool.handler({
      principalArn: "arn:aws:iam::123456789012:user/x",
      actions: ["no-colon-here"],
    } as never);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid action/);
  });

  it("rejects resources with leading hyphen (argv-injection defense)", async () => {
    const r = await tool.handler({
      principalArn: "arn:aws:iam::123456789012:user/x",
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
      summary: { allowed: number; denied: number; unknown: number; total: number };
      results: { action: string; decision: string; matchedStatementIds?: string[] }[];
    };
    assert.deepEqual(data.summary, { allowed: 1, denied: 0, unknown: 0, total: 1 });
    assert.equal(data.results[0].action, "lambda:CreateFunction");
    assert.equal(data.results[0].decision, "allowed");
    assert.deepEqual(data.results[0].matchedStatementIds, ["AdministratorAccess"]);
  });

  it("counts mixed allow/deny correctly and surfaces missing context", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "iam_simulate_mixed";
    const r = await tool.handler({
      principalArn: "arn:aws:iam::123456789012:user/x",
      actions: ["s3:GetObject", "s3:DeleteObject"],
      resources: ["arn:aws:s3:::my-bucket/*"],
    } as never);
    assert.equal(r.ok, true);
    const data = r.data as {
      summary: { allowed: number; denied: number; unknown: number; total: number };
      results: { action: string; decision: string; missingContextValues?: string[] }[];
    };
    assert.deepEqual(data.summary, { allowed: 1, denied: 1, unknown: 0, total: 2 });
    const deletes = data.results.find((res) => res.action === "s3:DeleteObject");
    assert.ok(deletes);
    assert.equal(deletes.decision, "explicitDeny");
    assert.deepEqual(deletes.missingContextValues, ["aws:RequestTag/Project"]);
  });

  it("reports implicitDeny with no matched statements", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "iam_simulate_implicit_deny";
    const r = await tool.handler({
      principalArn: "arn:aws:iam::123456789012:user/x",
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

  it("advisory fields + SourcePolicyId filtering through the handler (Phase-1 scenario)", async () => {
    // iam_simulate_advisory_and_filter emits three EvaluationResults:
    //  [0] s3:GetObject  -- EvalDecision omitted -> decision "unknown" (denied
    //      bucket); sole MatchedStatements SourcePolicyId is the number 42, so
    //      the string-only filter drops it and matchedStatementIds is undefined.
    //  [1] lambda:InvokeFunction -- EvalDecision "allowed" (the one allowed
    //      entry); AllowedByOrganizations:false -> organizationsDecision
    //      "denied"; AllowedByPermissionsBoundary:true ->
    //      permissionsBoundaryDecision "allowed".
    //  [2] ec2:TerminateInstances -- EvalDecision "explicitDeny" (denied);
    //      MatchedStatements mixes string "KeepThis" + null + a missing
    //      SourcePolicyId. The null entry is malformed-but-present (CLI shape
    //      error) and stays dropped; the truly-missing-SourcePolicyId entry
    //      now synthesizes 'inline' from its SourcePolicyType (inline-policy
    //      matches normally come back without a SourcePolicyId).
    //      Result: ["KeepThis", "inline"].
    process.env.AWS_MCP_FAKE_SCENARIO = "iam_simulate_advisory_and_filter";
    const r = await tool.handler({
      principalArn: "arn:aws:iam::123456789012:user/jeff",
      actions: ["s3:GetObject", "lambda:InvokeFunction", "ec2:TerminateInstances"],
    } as never);
    assert.equal(r.ok, true);
    const data = r.data as {
      summary: { allowed: number; denied: number; unknown: number; total: number };
      results: {
        action: string;
        decision: string;
        matchedStatementIds?: string[];
        organizationsDecision?: string;
        permissionsBoundaryDecision?: string;
      }[];
    };

    // unknown (entry [0]) is now counted separately; explicitDeny (entry [2])
    // is the only real deny.
    assert.deepEqual(data.summary, { allowed: 1, denied: 1, unknown: 1, total: 3 });

    const get = data.results.find((res) => res.action === "s3:GetObject");
    assert.ok(get);
    assert.equal(get.decision, "unknown");
    // number SourcePolicyId (42) dropped by the string-only filter.
    assert.equal(get.matchedStatementIds, undefined);
    assert.equal(get.organizationsDecision, undefined);
    assert.equal(get.permissionsBoundaryDecision, undefined);

    const invoke = data.results.find((res) => res.action === "lambda:InvokeFunction");
    assert.ok(invoke);
    assert.equal(invoke.decision, "allowed");
    assert.equal(invoke.organizationsDecision, "denied");
    assert.equal(invoke.permissionsBoundaryDecision, "allowed");
    assert.deepEqual(invoke.matchedStatementIds, ["OrgAllowed"]);

    const terminate = data.results.find((res) => res.action === "ec2:TerminateInstances");
    assert.ok(terminate);
    assert.equal(terminate.decision, "explicitDeny");
    // string "KeepThis" kept; the present-but-null entry stays dropped
    // (malformed CLI shape); the entry truly missing SourcePolicyId now
    // synthesizes "inline" from its SourcePolicyType.
    assert.deepEqual(terminate.matchedStatementIds, ["KeepThis", "inline"]);
  });

  it("accepts a 2048-char resource and rejects a 2049-char one (length cap boundary)", async () => {
    // iam-simulate.ts:204 rejects resources longer than 2048 chars. The cap is
    // inclusive: exactly 2048 passes validation, 2049 fails. Both strings
    // start with a non-hyphen char so only the length branch is under test.
    process.env.AWS_MCP_FAKE_SCENARIO = "iam_simulate_advisory_and_filter";
    const at2048 = `arn:aws:s3:::${"a".repeat(2048 - "arn:aws:s3:::".length)}`;
    assert.equal(at2048.length, 2048);
    const passes = await tool.handler({
      principalArn: "arn:aws:iam::123456789012:user/jeff",
      actions: ["s3:GetObject"],
      resources: [at2048],
    } as never);
    // 2048 passes the resource check, so the handler runs the fake scenario.
    assert.equal(passes.ok, true);

    const at2049 = `${at2048}a`;
    assert.equal(at2049.length, 2049);
    const rejected = await tool.handler({
      principalArn: "arn:aws:iam::123456789012:user/jeff",
      actions: ["s3:GetObject"],
      resources: [at2049],
    } as never);
    assert.equal(rejected.ok, false);
    assert.match(rejected.error ?? "", /Invalid resource/);
  });

  it("translates contextEntries camelCase -> PascalCase in the CLI argv (regression guard)", async () => {
    // The schema accepts contextEntries: [{ contextKeyName, contextKeyType,
    // contextKeyValues }] from the model; the AWS CLI requires PascalCase
    // ContextKeyName / ContextKeyType / ContextKeyValues inside
    // --cli-input-json. iam-simulate.ts:221-225 does the case translation.
    // A refactor dropping the map would leave camelCase in the CLI payload;
    // the CLI would silently produce missingContextValues for every
    // tag-based policy sim -- a quiet false negative. We capture the argv
    // via the iam_sim_echo_argv fake-aws scenario (side-channel via
    // AWS_MCP_FAKE_ARGV_OUT, since the handler discards data.argv) and
    // assert the --cli-input-json JSON is PascalCase.
    const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const sideChannelDir = mkdtempSync(join(tmpdir(), "aws-mcp-argv-out-"));
    const argvOutPath = join(sideChannelDir, "argv.json");
    process.env.AWS_MCP_FAKE_ARGV_OUT = argvOutPath;
    process.env.AWS_MCP_FAKE_SCENARIO = "iam_sim_echo_argv";
    try {
      const r = await tool.handler({
        principalArn: "arn:aws:iam::123456789012:user/jeff",
        actions: ["s3:GetObject"],
        resources: ["arn:aws:s3:::my-bucket/*"],
        contextEntries: [
          {
            contextKeyName: "aws:RequestTag/Project",
            contextKeyType: "string",
            contextKeyValues: ["alpha", "beta"],
          },
        ],
      } as never);
      assert.equal(r.ok, true);

      const argv = JSON.parse(readFileSync(argvOutPath, "utf-8")) as string[];
      const cliInputIdx = argv.indexOf("--cli-input-json");
      assert.ok(cliInputIdx >= 0, "argv should contain --cli-input-json");
      const payloadRaw = argv[cliInputIdx + 1];
      assert.ok(typeof payloadRaw === "string", "--cli-input-json should be followed by a string");
      const payload = JSON.parse(payloadRaw) as {
        PolicySourceArn?: string;
        ActionNames?: string[];
        ResourceArns?: string[];
        ContextEntries?: { ContextKeyName?: string; ContextKeyType?: string; ContextKeyValues?: string[] }[];
      };
      assert.equal(payload.PolicySourceArn, "arn:aws:iam::123456789012:user/jeff");
      assert.deepEqual(payload.ActionNames, ["s3:GetObject"]);
      assert.deepEqual(payload.ResourceArns, ["arn:aws:s3:::my-bucket/*"]);
      assert.ok(Array.isArray(payload.ContextEntries), "ContextEntries should be PascalCase");
      assert.equal(payload.ContextEntries?.[0].ContextKeyName, "aws:RequestTag/Project");
      assert.equal(payload.ContextEntries?.[0].ContextKeyType, "string");
      assert.deepEqual(payload.ContextEntries?.[0].ContextKeyValues, ["alpha", "beta"]);
      // The regression we guard against: leaving camelCase in the payload.
      const entry = payload.ContextEntries?.[0] ?? {};
      assert.equal(Object.hasOwn(entry, "contextKeyName"), false, "camelCase contextKeyName must not leak");
      assert.equal(Object.hasOwn(entry, "contextKeyType"), false, "camelCase contextKeyType must not leak");
      assert.equal(Object.hasOwn(entry, "contextKeyValues"), false, "camelCase contextKeyValues must not leak");
    } finally {
      delete process.env.AWS_MCP_FAKE_ARGV_OUT;
      rmSync(sideChannelDir, { recursive: true, force: true });
    }
  });
});

describe("parseSimulationResults -- inline-policy matches (no SourcePolicyId)", () => {
  // Inline policies (and certain implicit sources) come back from IAM with
  // SourcePolicyType + StartPosition but no SourcePolicyId. Without a
  // fallback, the flat matchedStatementIds is empty and the agent sees an
  // allowed/denied decision with no statement attribution -- the flat field
  // the tool exists to provide is wrong. The fallback only fires on TRULY-
  // ABSENT SourcePolicyId; present-but-malformed (null, number) is still
  // dropped (those are CLI-shape errors, not inline-policy signals).
  it("synthesizes 'inline#L<line>' from SourcePolicyType + StartPosition.Line", () => {
    const out = parseSimulationResults([
      {
        EvalActionName: "s3:GetObject",
        EvalResourceName: "arn:aws:s3:::b/*",
        EvalDecision: "allowed",
        MatchedStatements: [
          { SourcePolicyType: "IAM Policy", StartPosition: { Line: 5, Column: 9 } },
          { SourcePolicyType: "IAM Policy", StartPosition: { Line: 12 } },
        ],
      },
    ]);
    assert.deepEqual(out[0].matchedStatementIds, ["inline#L5", "inline#L12"]);
  });

  it("falls back to bare 'inline' when StartPosition.Line is absent", () => {
    const out = parseSimulationResults([
      {
        EvalActionName: "s3:GetObject",
        EvalResourceName: "*",
        EvalDecision: "allowed",
        MatchedStatements: [{ SourcePolicyType: "IAM Policy" }],
      },
    ]);
    assert.deepEqual(out[0].matchedStatementIds, ["inline"]);
  });

  it("prefers a present SourcePolicyId over the fallback, regardless of SourcePolicyType", () => {
    const out = parseSimulationResults([
      {
        EvalActionName: "s3:GetObject",
        EvalResourceName: "*",
        EvalDecision: "allowed",
        MatchedStatements: [{ SourcePolicyId: "ReadOnly", SourcePolicyType: "IAM Policy", StartPosition: { Line: 1 } }],
      },
    ]);
    assert.deepEqual(out[0].matchedStatementIds, ["ReadOnly"]);
  });

  it("still drops MALFORMED-but-present SourcePolicyId (null / number)", () => {
    // CLI-shape errors stay invisible -- they are not inline-policy matches,
    // and surfacing 'inline' for them would mask the upstream bug.
    const out = parseSimulationResults([
      {
        EvalActionName: "s3:GetObject",
        EvalResourceName: "*",
        EvalDecision: "allowed",
        MatchedStatements: [
          { SourcePolicyId: null, SourcePolicyType: "IAM Policy" },
          { SourcePolicyId: 42, SourcePolicyType: "IAM Policy" },
        ],
      },
    ]);
    assert.equal(out[0].matchedStatementIds, undefined);
  });

  it("skips entries with no SourcePolicyType at all (cannot synthesize anything)", () => {
    const out = parseSimulationResults([
      {
        EvalActionName: "s3:GetObject",
        EvalResourceName: "*",
        EvalDecision: "allowed",
        MatchedStatements: [{ StartPosition: { Line: 5 } }],
      },
    ]);
    assert.equal(out[0].matchedStatementIds, undefined);
  });
});
