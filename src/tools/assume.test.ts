import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assumeTools } from "./assume.js";

const tool = assumeTools.find((t) => t.name === "aws_assume_role");
if (!tool) throw new Error("assumeTools missing aws_assume_role");

describe("aws_assume_role schema", () => {
  it("accepts a minimal valid input (roleArn + sessionName)", () => {
    const r = tool.inputSchema.safeParse({
      roleArn: "arn:aws:iam::123456789012:role/Admin",
      sessionName: "my-session",
    });
    assert.equal(r.success, true);
  });

  it("accepts all optional fields", () => {
    const r = tool.inputSchema.safeParse({
      roleArn: "arn:aws:iam::123456789012:role/Admin",
      sessionName: "my-session",
      durationSeconds: 7200,
      externalId: "xyz",
      sourceProfile: "dev",
      targetProfile: "mcp-prod",
      region: "us-west-2",
    });
    assert.equal(r.success, true);
  });

  it("rejects sessionName with invalid characters", () => {
    const r = tool.inputSchema.safeParse({
      roleArn: "arn:aws:iam::123:role/A",
      sessionName: "bad name/slash",
    });
    assert.equal(r.success, false);
  });

  it("rejects sessionName shorter than 2 chars", () => {
    const r = tool.inputSchema.safeParse({
      roleArn: "arn:aws:iam::123:role/A",
      sessionName: "x",
    });
    assert.equal(r.success, false);
  });

  it("rejects durationSeconds below the STS minimum (900)", () => {
    const r = tool.inputSchema.safeParse({
      roleArn: "arn:aws:iam::123:role/A",
      sessionName: "sess",
      durationSeconds: 300,
    });
    assert.equal(r.success, false);
  });

  it("rejects durationSeconds above the STS maximum (43200)", () => {
    const r = tool.inputSchema.safeParse({
      roleArn: "arn:aws:iam::123:role/A",
      sessionName: "sess",
      durationSeconds: 50_000,
    });
    assert.equal(r.success, false);
  });

  it("requires roleArn and sessionName", () => {
    assert.equal(tool.inputSchema.safeParse({}).success, false);
    assert.equal(tool.inputSchema.safeParse({ roleArn: "x" }).success, false);
    assert.equal(tool.inputSchema.safeParse({ sessionName: "x" }).success, false);
  });
});
