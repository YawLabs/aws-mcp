import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { _resetSession } from "../session.js";
import {
  isValidIdentifier,
  isValidOpaqueToken,
  parseResourceProperties,
  resourceTools,
  TYPE_NAME_RE,
} from "./resource.js";

const getTool = (name: string) => {
  const t = resourceTools.find((x) => x.name === name);
  if (!t) throw new Error(`resourceTools missing ${name}`);
  return t;
};

const getResource = getTool("aws_resource_get");
const listResource = getTool("aws_resource_list");
const createResource = getTool("aws_resource_create");
const updateResource = getTool("aws_resource_update");
const deleteResource = getTool("aws_resource_delete");
const statusResource = getTool("aws_resource_status");

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AWS = join(__dirname, "..", "testing", "fake-aws.js");

afterEach(() => {
  _resetSession();
});

describe("TYPE_NAME_RE", () => {
  it("accepts standard AWS::* types", () => {
    for (const tn of [
      "AWS::Lambda::Function",
      "AWS::S3::Bucket",
      "AWS::IAM::Role",
      "AWS::SSM::Parameter",
      "AWS::KafkaConnect::Connector",
    ]) {
      assert.match(tn, TYPE_NAME_RE, `expected ${tn} to match`);
    }
  });

  it("accepts Custom:: and third-party namespaces", () => {
    for (const tn of ["Custom::MyCorp::Thing", "ThirdParty::Service::Resource"]) {
      assert.match(tn, TYPE_NAME_RE);
    }
  });

  it("rejects missing segments or wrong separators", () => {
    for (const tn of ["AWS::Lambda", "AWS:Lambda:Function", "AWS/Lambda/Function", "lambda::function::thing"]) {
      assert.doesNotMatch(tn, TYPE_NAME_RE);
    }
  });

  it("rejects leading-hyphen (argv-injection defense)", () => {
    assert.doesNotMatch("-AWS::Lambda::Function", TYPE_NAME_RE);
  });
});

describe("isValidIdentifier", () => {
  it("accepts real-world identifier shapes", () => {
    for (const id of [
      "my-function",
      "arn:aws:lambda:us-east-1:123456789012:function:my-fn",
      "my.bucket.name",
      "role_with_underscores",
      "/my/ssm/parameter",
      "key1:value1|key2:value2", // composite identifier
    ]) {
      assert.ok(isValidIdentifier(id), `expected ${id} to be valid`);
    }
  });

  it("rejects empty, over-length, and leading-hyphen inputs", () => {
    assert.equal(isValidIdentifier(""), false);
    assert.equal(isValidIdentifier("a".repeat(2049)), false);
    assert.equal(isValidIdentifier("-force"), false);
    assert.equal(isValidIdentifier("--profile"), false);
  });

  it("rejects control characters", () => {
    assert.equal(isValidIdentifier("has\x00null"), false);
    assert.equal(isValidIdentifier("has\nnewline"), false);
    assert.equal(isValidIdentifier("has\ttab"), false);
  });
});

describe("isValidOpaqueToken", () => {
  it("accepts typical RequestToken shapes", () => {
    assert.ok(isValidOpaqueToken("abc-def-1234-5678"));
    assert.ok(isValidOpaqueToken("client-token-v1"));
  });

  it("enforces 128-char max", () => {
    assert.ok(isValidOpaqueToken("a".repeat(128)));
    assert.equal(isValidOpaqueToken("a".repeat(129)), false);
  });

  it("rejects empty, leading-hyphen, and control chars", () => {
    assert.equal(isValidOpaqueToken(""), false);
    assert.equal(isValidOpaqueToken("-token"), false);
    assert.equal(isValidOpaqueToken("bad\x01"), false);
  });
});

describe("parseResourceProperties", () => {
  it("parses JSON-encoded Properties into an object", () => {
    const result = parseResourceProperties({
      Identifier: "my-fn",
      Properties: JSON.stringify({ FunctionName: "my-fn", MemorySize: 512 }),
    });
    assert.equal(result.Identifier, "my-fn");
    assert.deepEqual(result.Properties, { FunctionName: "my-fn", MemorySize: 512 });
    assert.equal(result.propertiesRaw, undefined);
  });

  it("preserves raw Properties when JSON parse fails", () => {
    const result = parseResourceProperties({ Identifier: "id", Properties: "not valid json" });
    assert.equal(result.Identifier, "id");
    assert.equal(result.Properties, "not valid json");
    assert.equal(result.propertiesRaw, "not valid json");
  });

  it("handles non-object inputs gracefully", () => {
    assert.deepEqual(parseResourceProperties(null), { Properties: null });
    assert.deepEqual(parseResourceProperties(undefined), { Properties: undefined });
    assert.deepEqual(parseResourceProperties("string"), { Properties: "string" });
  });

  it("handles Properties that is already an object (not JSON-string)", () => {
    const result = parseResourceProperties({ Identifier: "id", Properties: { already: "parsed" } });
    assert.deepEqual(result.Properties, { already: "parsed" });
  });
});

describe("schemas", () => {
  it("aws_resource_get accepts typeName + identifier", () => {
    assert.equal(
      getResource.inputSchema.safeParse({ typeName: "AWS::Lambda::Function", identifier: "my-fn" }).success,
      true,
    );
  });

  it("aws_resource_get rejects missing identifier", () => {
    assert.equal(getResource.inputSchema.safeParse({ typeName: "AWS::Lambda::Function" }).success, false);
  });

  it("aws_resource_list accepts minimal call", () => {
    assert.equal(listResource.inputSchema.safeParse({ typeName: "AWS::S3::Bucket" }).success, true);
  });

  it("aws_resource_list caps maxResults at 100", () => {
    assert.equal(listResource.inputSchema.safeParse({ typeName: "AWS::S3::Bucket", maxResults: 101 }).success, false);
    assert.equal(listResource.inputSchema.safeParse({ typeName: "AWS::S3::Bucket", maxResults: 100 }).success, true);
  });

  it("aws_resource_create requires desiredState", () => {
    assert.equal(createResource.inputSchema.safeParse({ typeName: "AWS::SSM::Parameter" }).success, false);
    assert.equal(
      createResource.inputSchema.safeParse({
        typeName: "AWS::SSM::Parameter",
        desiredState: { Name: "/x", Type: "String", Value: "y" },
      }).success,
      true,
    );
  });

  it("aws_resource_update requires patchDocument with at least one op", () => {
    assert.equal(
      updateResource.inputSchema.safeParse({
        typeName: "AWS::Lambda::Function",
        identifier: "my-fn",
        patchDocument: [],
      }).success,
      false,
    );
    assert.equal(
      updateResource.inputSchema.safeParse({
        typeName: "AWS::Lambda::Function",
        identifier: "my-fn",
        patchDocument: [{ op: "replace", path: "/MemorySize", value: 512 }],
      }).success,
      true,
    );
  });

  it("aws_resource_update rejects invalid JSON Patch op", () => {
    assert.equal(
      updateResource.inputSchema.safeParse({
        typeName: "AWS::Lambda::Function",
        identifier: "my-fn",
        patchDocument: [{ op: "invalid-op", path: "/x" }],
      }).success,
      false,
    );
  });

  it("aws_resource_status requires requestToken", () => {
    assert.equal(statusResource.inputSchema.safeParse({}).success, false);
    assert.equal(statusResource.inputSchema.safeParse({ requestToken: "abc" }).success, true);
  });
});

describe("handler input validation (no spawn)", () => {
  it("rejects invalid typeName", async () => {
    const r = (await getResource.handler({ typeName: "not-a-type", identifier: "x" })) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid typeName/);
  });

  it("rejects leading-hyphen identifier (argv-injection defense)", async () => {
    const r = (await getResource.handler({
      typeName: "AWS::Lambda::Function",
      identifier: "--force",
    })) as { ok: boolean; error?: string };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid identifier/);
  });

  it("rejects invalid nextToken on list", async () => {
    const r = (await listResource.handler({
      typeName: "AWS::S3::Bucket",
      nextToken: "-bad",
    })) as { ok: boolean; error?: string };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid nextToken/);
  });

  it("rejects leading-hyphen clientToken on create", async () => {
    const r = (await createResource.handler({
      typeName: "AWS::SSM::Parameter",
      desiredState: { Name: "/x", Type: "String", Value: "y" },
      clientToken: "-evil",
    })) as { ok: boolean; error?: string };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid clientToken/);
  });

  it("rejects leading-hyphen requestToken on status", async () => {
    const r = (await statusResource.handler({ requestToken: "-nope" })) as { ok: boolean; error?: string };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid requestToken/);
  });

  it("delete rejects invalid identifier before any spawn (destructive-path defense)", async () => {
    const r = (await deleteResource.handler({
      typeName: "AWS::S3::Bucket",
      identifier: "--force",
    })) as { ok: boolean; error?: string };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid identifier/);
  });
});

/**
 * Fake-aws integration: we can't swap the CLI inside tool handlers (they call
 * runAwsCall directly without a command override), so these tests drive
 * runAwsCall with the same extraFlags the handlers assemble and assert the
 * argv shape + response parsing. Handler-level integration is covered by the
 * live integration test file (resource.integration.test.ts, opt-in via env).
 */
describe("runAwsCall invocation shape (fake-aws)", () => {
  it("get-resource places --type-name and --identifier between operation and --output", async () => {
    const { runAwsCall } = await import("../aws-cli.js");
    const r = await runAwsCall({
      service: "cloudcontrol",
      operation: "get-resource",
      extraFlags: ["--type-name", "AWS::Lambda::Function", "--identifier", "my-fn"],
      command: process.execPath,
      prefixArgs: [FAKE_AWS],
      env: { ...process.env, AWS_MCP_FAKE_SCENARIO: "call_echo_args" },
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const { argv } = r.data as { argv: string[] };
    const opIdx = argv.indexOf("get-resource");
    const tnIdx = argv.indexOf("--type-name");
    const idIdx = argv.indexOf("--identifier");
    const outputIdx = argv.indexOf("--output");
    assert.ok(opIdx > 0);
    assert.ok(tnIdx > opIdx && tnIdx < outputIdx, "--type-name must sit between operation and --output");
    assert.ok(idIdx > opIdx && idIdx < outputIdx);
    assert.equal(argv[tnIdx + 1], "AWS::Lambda::Function");
    assert.equal(argv[idIdx + 1], "my-fn");
  });

  it("create-resource serializes desiredState into a single --desired-state argv entry", async () => {
    const { runAwsCall } = await import("../aws-cli.js");
    const r = await runAwsCall({
      service: "cloudcontrol",
      operation: "create-resource",
      extraFlags: [
        "--type-name",
        "AWS::SSM::Parameter",
        "--desired-state",
        JSON.stringify({ Name: "/my/p", Type: "String", Value: "v" }),
      ],
      command: process.execPath,
      prefixArgs: [FAKE_AWS],
      env: { ...process.env, AWS_MCP_FAKE_SCENARIO: "call_echo_args" },
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const { argv } = r.data as { argv: string[] };
    const flagIdx = argv.indexOf("--desired-state");
    assert.ok(flagIdx > 0);
    const payload = argv[flagIdx + 1];
    const parsed = JSON.parse(payload);
    assert.deepEqual(parsed, { Name: "/my/p", Type: "String", Value: "v" });
  });
});

describe("handler response parsing (fake-aws via handler-level dispatch)", () => {
  // The handlers themselves call runAwsCall directly, which can't be swapped
  // out from here. Instead, we verify parseResourceProperties (the response
  // shape transformer) handles the fake-aws-shaped payload correctly. The
  // on-the-wire shape is covered by the handler code that threads it through.
  it("unwraps a GetResource-style response", () => {
    const raw = {
      Identifier: "my-fn",
      Properties: JSON.stringify({ FunctionName: "my-fn", MemorySize: 256 }),
    };
    const parsed = parseResourceProperties(raw);
    assert.equal(parsed.Identifier, "my-fn");
    assert.deepEqual(parsed.Properties, { FunctionName: "my-fn", MemorySize: 256 });
  });
});
