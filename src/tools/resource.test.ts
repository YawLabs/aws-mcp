import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { AwsCallResult } from "../aws-cli.js";
import { _resetSession } from "../session.js";
import {
  CURSOR_MAX_LEN,
  extractProgressFields,
  isTransientPollFailure,
  isValidIdentifier,
  isValidOpaqueToken,
  MAX_TRANSIENT_POLL_RETRIES,
  parseResourceProperties,
  pollUntilTerminal,
  resourceTools,
  TERMINAL_STATUSES,
  TYPE_NAME_RE,
  validateCursorToken,
  validateOpaqueToken,
} from "./resource.js";
import type { ToolContext } from "./tool.js";

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
const diffResource = getTool("aws_resource_diff");

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AWS = join(__dirname, "..", "testing", "fake-aws.js");

afterEach(() => {
  _resetSession();
});

// Build a fake CLI response that mimics `aws cloudcontrol get-resource-request-status`.
// Shared by the pollUntilTerminal describe blocks below.
function progressResponse(event: Record<string, unknown> | null): AwsCallResult {
  return {
    ok: true,
    data: { ProgressEvent: event },
    command: "aws cloudcontrol get-resource-request-status --request-token tok-1",
    commandArgv: ["aws", "cloudcontrol", "get-resource-request-status", "--request-token", "tok-1"],
    rawStdout: JSON.stringify({ ProgressEvent: event }),
  };
}

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

  it("accepts three-segment third-party registry namespaces", () => {
    for (const tn of ["MyCorp::Service::Thing", "ThirdParty::Service::Resource"]) {
      assert.match(tn, TYPE_NAME_RE);
    }
  });

  it("does NOT accept a two-segment CloudFormation custom resource type", () => {
    // Custom::MyResource is a CloudFormation custom resource, which Cloud
    // Control cannot address; the old comment and test name claimed support.
    assert.doesNotMatch("Custom::MyResource", TYPE_NAME_RE);
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

  it("rejects the paramfile prefixes the CLI would expand, and nothing wider", () => {
    // These predicates are documented as argv-safety checks and cited as such
    // from script.ts, so "valid" has to mean the CLI will send the value rather
    // than a local file's contents. The true cases are what the CLI passes
    // through literally -- an identifier may legitimately contain "file".
    assert.equal(isValidIdentifier("file://~/.aws/credentials"), false);
    assert.equal(isValidIdentifier("fileb://x"), false);
    assert.ok(isValidIdentifier("FILE://x"));
    assert.ok(isValidIdentifier("my-file-bucket"));
    assert.ok(isValidIdentifier("key1:value1|key2:value2"));
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

  it("rejects the paramfile prefixes", () => {
    assert.equal(isValidOpaqueToken("file://x"), false);
    assert.equal(isValidOpaqueToken("fileb://x"), false);
    assert.ok(isValidOpaqueToken("FILE://x"));
  });
});

describe("validateOpaqueToken", () => {
  it("names the field and the paramfile reason, not the shape rules", () => {
    // A `file://` token fails for a different reason than a malformed one, and
    // "must be 1-128 chars" would send the reader looking for a length problem.
    assert.match(validateOpaqueToken("file://x", "clientToken") ?? "", /^Invalid clientToken: must not start with/);
    assert.match(validateOpaqueToken("file://x", "clientToken") ?? "", /contents of a local file/);
    assert.match(validateOpaqueToken("fileb://x", "requestToken") ?? "", /^Invalid requestToken: must not start with/);
  });

  it("still reports the shape rules for an ordinary bad token", () => {
    assert.match(validateOpaqueToken("-evil", "clientToken") ?? "", /Must be 1-128 chars/);
  });
});

describe("validateCursorToken", () => {
  // Pagination cursors are NOT RequestToken/ClientToken: AWS documents
  // ListResources NextToken (HandlerNextToken) at up to 4096 chars, and the
  // CLI wraps a raw token as base64 JSON for --starting-token, which turns a
  // 4096-char token into 5,484. Validating them with the 128-char opaque-token
  // guard rejected page 2 of every list on entirely expected input, and 2048
  // was the same failure one limit higher.
  it("accepts a cursor longer than the 128-char opaque-token cap", () => {
    assert.equal(validateCursorToken("a".repeat(600), "nextToken"), null);
    assert.equal(validateCursorToken("a".repeat(2048), "nextToken"), null);
  });

  it("accepts the documented 4096-char NextToken, its wrapped form, and the 8192 boundary", () => {
    assert.equal(validateCursorToken("a".repeat(2049), "nextToken"), null, "the old 2048 cap is gone");
    assert.equal(validateCursorToken("a".repeat(4096), "nextToken"), null, "AWS's documented maximum");
    assert.equal(validateCursorToken("a".repeat(5484), "startingToken"), null, "4096 wrapped as base64 JSON");
    assert.equal(validateCursorToken("a".repeat(CURSOR_MAX_LEN), "nextToken"), null);
  });

  it("still rejects over-8192, empty, leading-hyphen, and control chars", () => {
    assert.match(validateCursorToken("a".repeat(CURSOR_MAX_LEN + 1), "nextToken") ?? "", /Invalid nextToken/);
    assert.match(validateCursorToken("a".repeat(CURSOR_MAX_LEN + 1), "nextToken") ?? "", /1-8192/);
    assert.match(validateCursorToken("", "nextToken") ?? "", /Invalid nextToken/);
    assert.match(validateCursorToken("-bad", "nextToken") ?? "", /Invalid nextToken/);
    assert.match(validateCursorToken("bad\x01", "nextToken") ?? "", /Invalid nextToken/);
  });

  it("names the field it was given", () => {
    assert.match(validateCursorToken("-bad", "startingToken") ?? "", /Invalid startingToken/);
  });

  it("rejects a paramfile cursor with the field named", () => {
    assert.match(validateCursorToken("file://x", "nextToken") ?? "", /^Invalid nextToken: must not start with/);
    assert.match(
      validateCursorToken("fileb://x", "startingToken") ?? "",
      /^Invalid startingToken: must not start with/,
    );
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

  it("requires a value on 'add' / 'replace' ops, not on 'remove'", () => {
    // `{op:'add', path:'/X'}` used to parse clean and then produce
    // `X: undefined`, which vanishes on serialization -- the "change" was a
    // silent no-op. RFC 6902 defines add/replace as carrying a value.
    for (const t of [updateResource, diffResource]) {
      for (const op of ["add", "replace"] as const) {
        const r = t.inputSchema.safeParse({
          typeName: "AWS::Lambda::Function",
          identifier: "my-fn",
          patchDocument: [{ op, path: "/MemorySize" }],
        });
        assert.equal(r.success, false, `${t.name} must reject a value-less '${op}'`);
      }
      // remove needs no value, and an explicit null IS a value.
      assert.equal(
        t.inputSchema.safeParse({
          typeName: "AWS::Lambda::Function",
          identifier: "my-fn",
          patchDocument: [{ op: "remove", path: "/MemorySize" }],
        }).success,
        true,
        `${t.name} must still accept a value-less 'remove'`,
      );
      assert.equal(
        t.inputSchema.safeParse({
          typeName: "AWS::Lambda::Function",
          identifier: "my-fn",
          patchDocument: [{ op: "replace", path: "/MemorySize", value: null }],
        }).success,
        true,
        `${t.name} must accept an explicit null value`,
      );
    }
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
 * Point every handler's runAwsCall at the fake-aws shim for the duration of
 * `fn`, through the documented AWS_MCP_TEST_AWS_* hook, and ALWAYS restore the
 * environment afterwards. process.env is file-global, so one test that forgot
 * its own `finally` would silently point every later handler test here at the
 * fake; owning the try/finally in one place makes that mistake impossible.
 */
async function withFakeAws<T>(
  scenario: string,
  fn: () => Promise<T>,
  extraEnv: Record<string, string> = {},
): Promise<T> {
  process.env.AWS_MCP_TEST_AWS_COMMAND = process.execPath;
  process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS = JSON.stringify([FAKE_AWS]);
  process.env.AWS_MCP_FAKE_SCENARIO = scenario;
  for (const [k, v] of Object.entries(extraEnv)) process.env[k] = v;
  _resetSession();
  try {
    return await fn();
  } finally {
    delete process.env.AWS_MCP_TEST_AWS_COMMAND;
    delete process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS;
    delete process.env.AWS_MCP_FAKE_SCENARIO;
    for (const k of Object.keys(extraEnv)) delete process.env[k];
    _resetSession();
  }
}

/**
 * The argv each HANDLER actually emits, read off `commandArgv` while the CLI is
 * the call_echo_args fake. Payload flags (--desired-state, --patch-document,
 * --resource-model) are redacted in commandArgv to `<redacted len=N>`, so a
 * payload is checked by its length: one entry whose length is the JSON's
 * proves it was serialized into a single argv entry.
 */
describe("handler argv shape (fake-aws call_echo_args)", () => {
  const argvOf = (r: { ok: boolean; data?: unknown; error?: string }): string[] => {
    assert.equal(r.ok, true, `handler failed: ${r.error}`);
    const argv = (r.data as { commandArgv?: string[] }).commandArgv;
    assert.ok(Array.isArray(argv), "every envelope carrying `command` carries `commandArgv`");
    return argv;
  };
  const valueAfter = (argv: string[], flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i < 0 ? undefined : argv[i + 1];
  };

  it("aws_resource_get puts --type-name and --identifier between the operation and --output", async () => {
    const argv = argvOf(
      await withFakeAws("call_echo_args", () =>
        getResource.handler({ typeName: "AWS::Lambda::Function", identifier: "my-fn" }),
      ),
    );
    const opIdx = argv.indexOf("get-resource");
    const outputIdx = argv.indexOf("--output");
    assert.ok(opIdx > 0);
    for (const flag of ["--type-name", "--identifier"]) {
      const at = argv.indexOf(flag);
      assert.ok(at > opIdx && at < outputIdx, `${flag} must sit between the operation and --output`);
    }
    assert.equal(valueAfter(argv, "--type-name"), "AWS::Lambda::Function");
    assert.equal(valueAfter(argv, "--identifier"), "my-fn");
  });

  it("aws_resource_create sends desiredState as ONE --desired-state entry, plus --client-token", async () => {
    const desiredState = { Name: "/my/p", Type: "String", Value: "v" };
    const argv = argvOf(
      await withFakeAws("call_echo_args", () =>
        createResource.handler({ typeName: "AWS::SSM::Parameter", desiredState, clientToken: "ct-1" }),
      ),
    );
    assert.ok(argv.includes("create-resource"));
    assert.equal(valueAfter(argv, "--desired-state"), `<redacted len=${JSON.stringify(desiredState).length}>`);
    assert.equal(valueAfter(argv, "--client-token"), "ct-1");
  });

  it("aws_resource_update sends --identifier, ONE --patch-document entry, and --client-token", async () => {
    const patchDocument = [{ op: "replace", path: "/MemorySize", value: 512 }];
    const argv = argvOf(
      await withFakeAws("call_echo_args", () =>
        updateResource.handler({
          typeName: "AWS::Lambda::Function",
          identifier: "my-fn",
          patchDocument,
          clientToken: "ct-2",
        }),
      ),
    );
    assert.ok(argv.includes("update-resource"));
    assert.equal(valueAfter(argv, "--identifier"), "my-fn");
    assert.equal(valueAfter(argv, "--patch-document"), `<redacted len=${JSON.stringify(patchDocument).length}>`);
    assert.equal(valueAfter(argv, "--client-token"), "ct-2");
  });

  it("aws_resource_delete sends --type-name and --identifier, and no --client-token unless given", async () => {
    const argv = argvOf(
      await withFakeAws("call_echo_args", () =>
        deleteResource.handler({ typeName: "AWS::S3::Bucket", identifier: "my-bucket" }),
      ),
    );
    assert.ok(argv.includes("delete-resource"));
    assert.equal(valueAfter(argv, "--type-name"), "AWS::S3::Bucket");
    assert.equal(valueAfter(argv, "--identifier"), "my-bucket");
    assert.equal(argv.includes("--client-token"), false);
  });

  it("aws_resource_list sends --max-results (default 100), --next-token and --resource-model", async () => {
    const resourceModel = { ClusterArn: "arn:aws:ecs:us-east-1:123456789012:cluster/c" };
    const argv = argvOf(
      await withFakeAws("call_echo_args", () =>
        listResource.handler({ typeName: "AWS::ECS::Service", nextToken: "cursor-2", resourceModel }),
      ),
    );
    assert.equal(valueAfter(argv, "--max-results"), "100");
    assert.equal(valueAfter(argv, "--next-token"), "cursor-2");
    assert.equal(valueAfter(argv, "--resource-model"), `<redacted len=${JSON.stringify(resourceModel).length}>`);
  });

  it("aws_resource_list treats an EMPTY nextToken as the first page instead of rejecting it", async () => {
    // The schema admits "", the handler used to validate it (1-8192 chars)
    // while forwarding only a truthy one -- so the common "echo an empty
    // cursor for page 1" shape failed with a length error.
    const r = await withFakeAws("call_echo_args", () =>
      listResource.handler({ typeName: "AWS::SSM::Parameter", nextToken: "", maxResults: 5 }),
    );
    const argv = argvOf(r);
    assert.equal(argv.includes("--next-token"), false);
    assert.equal(valueAfter(argv, "--max-results"), "5");
  });

  it("aws_resource_status sends the --request-token and carries commandArgv", async () => {
    const r = await withFakeAws("call_echo_args", () => statusResource.handler({ requestToken: "req-tok-echo" }));
    const argv = argvOf(r);
    assert.equal(valueAfter(argv, "--request-token"), "req-tok-echo");
    assert.equal(typeof (r.data as { command?: unknown }).command, "string");
  });
});

describe("TERMINAL_STATUSES", () => {
  it("contains the three CCAPI terminal states and nothing else", () => {
    assert.ok(TERMINAL_STATUSES.has("SUCCESS"));
    assert.ok(TERMINAL_STATUSES.has("FAILED"));
    assert.ok(TERMINAL_STATUSES.has("CANCEL_COMPLETE"));
    assert.equal(TERMINAL_STATUSES.has("IN_PROGRESS"), false);
    assert.equal(TERMINAL_STATUSES.has("PENDING"), false);
    assert.equal(TERMINAL_STATUSES.has("CANCEL_IN_PROGRESS"), false);
  });
});

describe("extractProgressFields", () => {
  it("flat-promotes the standard ProgressEvent fields", () => {
    const fields = extractProgressFields({
      RequestToken: "tok-1",
      OperationStatus: "IN_PROGRESS",
      Identifier: "my-fn",
      StatusMessage: "still going",
    });
    assert.equal(fields.requestToken, "tok-1");
    assert.equal(fields.operationStatus, "IN_PROGRESS");
    assert.equal(fields.identifier, "my-fn");
    assert.equal(fields.errorCode, null);
    assert.equal(fields.statusMessage, "still going");
    assert.equal(fields.retryAfter, null);
  });

  it("returns null for non-string or empty fields", () => {
    const fields = extractProgressFields({
      RequestToken: 42,
      OperationStatus: null,
      Identifier: "",
    });
    assert.equal(fields.requestToken, null);
    assert.equal(fields.operationStatus, null);
    assert.equal(fields.identifier, null);
  });

  it("handles null / undefined / non-object input without throwing", () => {
    for (const x of [null, undefined, "string", 42, []]) {
      const fields = extractProgressFields(x);
      assert.equal(fields.requestToken, null);
      assert.equal(fields.operationStatus, null);
    }
  });
});

describe("pollUntilTerminal", () => {
  it("returns immediately when the first poll is already terminal", async () => {
    let calls = 0;
    const awsCall = async (): Promise<AwsCallResult> => {
      calls++;
      return progressResponse({ OperationStatus: "SUCCESS", RequestToken: "tok-1", Identifier: "id-1" });
    };
    const r = await pollUntilTerminal(
      { requestToken: "tok-1", pollIntervalMs: 100, maxWaitMs: 5_000 },
      awsCall,
      async () => undefined,
    );
    assert.equal(r.ok, true);
    assert.equal(calls, 1);
    assert.equal(r.attempts, 1);
    assert.equal((r.progressEvent as Record<string, unknown>)?.OperationStatus, "SUCCESS");
  });

  it("polls until terminal status appears", async () => {
    const responses: Record<string, unknown>[] = [
      { OperationStatus: "PENDING", RequestToken: "tok-1" },
      { OperationStatus: "IN_PROGRESS", RequestToken: "tok-1" },
      { OperationStatus: "SUCCESS", RequestToken: "tok-1", Identifier: "id-1" },
    ];
    let i = 0;
    const awsCall = async (): Promise<AwsCallResult> => progressResponse(responses[i++]);
    const sleeps: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push(ms);
    };
    const r = await pollUntilTerminal({ requestToken: "tok-1", pollIntervalMs: 100, maxWaitMs: 5_000 }, awsCall, sleep);
    assert.equal(r.ok, true);
    assert.equal(r.attempts, 3);
    assert.equal((r.progressEvent as Record<string, unknown>)?.OperationStatus, "SUCCESS");
    // Two sleeps between three polls. Each sleep is the configured pollIntervalMs.
    assert.equal(sleeps.length, 2);
    assert.ok(
      sleeps.every((s) => s <= 100),
      `expected each sleep <= pollIntervalMs, got ${JSON.stringify(sleeps)}`,
    );
  });

  it("times out when the budget runs out and surfaces the last-seen status", async () => {
    const awsCall = async (): Promise<AwsCallResult> =>
      progressResponse({ OperationStatus: "IN_PROGRESS", RequestToken: "tok-1" });
    const r = await pollUntilTerminal(
      { requestToken: "tok-1", pollIntervalMs: 1, maxWaitMs: 0 },
      awsCall,
      async () => undefined,
    );
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /without reaching a terminal state/);
    assert.equal((r.progressEvent as Record<string, unknown>)?.OperationStatus, "IN_PROGRESS");
  });

  it("never issues an AWS call once the budget is spent", async (t) => {
    // The budget check used to run AFTER the call: the final sleep clamps to
    // land exactly on maxWaitMs, the loop re-entered, and one more request
    // went out past the deadline the caller set.
    //
    // Deterministic clock: Date.now is mocked and only the injected sleep
    // advances it. This used to race real timers against a 120 ms budget --
    // one event-loop stall under a parallel `node --test` run left a single
    // poll and failed the "several polls" assertion.
    let now = 1_000_000;
    t.mock.method(Date, "now", () => now);
    const start = now;
    const offsets: number[] = [];
    const awsCall = async (): Promise<AwsCallResult> => {
      offsets.push(now - start);
      return progressResponse({ OperationStatus: "IN_PROGRESS", RequestToken: "tok-1" });
    };
    const sleep = async (ms: number): Promise<void> => {
      now += ms;
    };
    const maxWaitMs = 120;
    const r = await pollUntilTerminal({ requestToken: "tok-1", pollIntervalMs: 20, maxWaitMs }, awsCall, sleep);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /without reaching a terminal state/);
    // Polls at 0, 20, ..., 100; the last sleep clamps to land on 120, and the
    // budget check then stops the loop -- the buggy order polled at 120 too.
    assert.deepEqual(offsets, [0, 20, 40, 60, 80, 100]);
  });

  it("propagates an error from the underlying CLI call", async () => {
    const awsCall = async (): Promise<AwsCallResult> => ({
      ok: false,
      kind: "nonzero_exit",
      error: "boom",
      command: "aws cloudcontrol get-resource-request-status",
      rawStderr: "stderr blob",
    });
    const r = await pollUntilTerminal(
      { requestToken: "tok-1", pollIntervalMs: 100, maxWaitMs: 5_000 },
      awsCall,
      async () => undefined,
    );
    assert.equal(r.ok, false);
    assert.equal(r.error, "boom");
    assert.equal(r.rawBody, "stderr blob");
    assert.equal(r.kind, "nonzero_exit");
  });

  it("propagates kind=sso_expired so buildMutationResponse can render a recovery hint", async () => {
    const awsCall = async (): Promise<AwsCallResult> => ({
      ok: false,
      kind: "sso_expired",
      error: "SSO session expired for profile 'p'.",
      command: "aws cloudcontrol get-resource-request-status",
      rawStderr: "Error loading SSO Token",
    });
    const r = await pollUntilTerminal(
      { requestToken: "tok-1", pollIntervalMs: 100, maxWaitMs: 5_000 },
      awsCall,
      async () => undefined,
    );
    assert.equal(r.ok, false);
    assert.equal(r.kind, "sso_expired");
  });

  it("honors RetryAfter (overrides pollIntervalMs)", async () => {
    const inOneSecond = new Date(Date.now() + 1_000).toISOString();
    const responses: Record<string, unknown>[] = [
      { OperationStatus: "IN_PROGRESS", RequestToken: "tok-1", RetryAfter: inOneSecond },
      { OperationStatus: "SUCCESS", RequestToken: "tok-1" },
    ];
    let i = 0;
    const awsCall = async (): Promise<AwsCallResult> => progressResponse(responses[i++]);
    const sleeps: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push(ms);
    };
    const r = await pollUntilTerminal(
      { requestToken: "tok-1", pollIntervalMs: 100, maxWaitMs: 60_000 },
      awsCall,
      sleep,
    );
    assert.equal(r.ok, true);
    assert.equal(sleeps.length, 1);
    // RetryAfter (~1000ms) should win over pollIntervalMs (100ms). Allow some
    // jitter in the date math by checking the floor only.
    assert.ok(sleeps[0] > 200, `expected sleep > pollIntervalMs (RetryAfter wins), got ${sleeps[0]}`);
  });

  it("clamps a RetryAfter that exceeds the remaining maxWaitMs budget", async () => {
    // RetryAfter points ~10s into the future, but maxWaitMs is only 1500ms.
    // The loop must NOT sleep the full RetryAfter (that would overshoot the
    // caller's budget and the next iteration's timeout check would only fire
    // 10s late). The `Math.min(waitMs, maxWaitMs - elapsed)` clamp caps the
    // wait at the remaining budget. On the first iteration elapsed is ~0, so
    // the clamp lands at maxWaitMs itself. This pins the clamp line: without
    // it the sleep would be ~10000, not <= 1500.
    const tenSecondsOut = new Date(Date.now() + 10_000).toISOString();
    const responses: Record<string, unknown>[] = [
      { OperationStatus: "IN_PROGRESS", RequestToken: "tok-1", RetryAfter: tenSecondsOut },
      { OperationStatus: "SUCCESS", RequestToken: "tok-1" },
    ];
    let i = 0;
    const awsCall = async (): Promise<AwsCallResult> => progressResponse(responses[i++]);
    const sleeps: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push(ms);
    };
    const r = await pollUntilTerminal({ requestToken: "tok-1", pollIntervalMs: 100, maxWaitMs: 1_500 }, awsCall, sleep);
    assert.equal(r.ok, true);
    assert.equal(sleeps.length, 1);
    // Clamped to the remaining budget, not the raw ~10000ms RetryAfter.
    assert.ok(sleeps[0] <= 1_500, `expected sleep clamped to <= maxWaitMs, got ${sleeps[0]}`);
    assert.ok(sleeps[0] < 10_000, `expected sleep below the raw RetryAfter (~10000ms), got ${sleeps[0]}`);
  });
});

describe("aws_resource_create handler — awaitCompletion mid-poll auth lapse (fake-aws)", () => {
  it("surfaces a structured re-login + aws_resource_status hint when SSO expires mid-poll", async () => {
    await withFakeAws("resource_create_then_status_sso_expired", async () => {
      const r = (await createResource.handler({
        typeName: "AWS::SSM::Parameter",
        desiredState: { Name: "/my/p", Type: "String", Value: "v" },
        profile: "tester",
        awaitCompletion: true,
        pollIntervalMs: 500,
        maxWaitMs: 2000,
      })) as { ok: boolean; error?: string };
      assert.equal(r.ok, false);
      // Recovery hint includes both the re-login pointer and the
      // requestToken from the IN_PROGRESS response so the caller can check
      // server-side state after re-authenticating.
      assert.match(r.error ?? "", /SSO session expired/);
      assert.match(r.error ?? "", /aws_login_start/);
      assert.match(r.error ?? "", /tester/);
      assert.match(r.error ?? "", /aws_resource_status/);
      assert.match(r.error ?? "", /req-tok-abc/);
    });
  });
});

describe("aws_resource_update + aws_resource_delete handlers — awaitCompletion mid-poll auth lapse (fake-aws)", () => {
  // Parallel to the create-side fake-aws test above. The
  // buildMutationResponse recovery hint is shared, but each verb has its own
  // initial CLI call (update-resource / delete-resource); these tests pin
  // both verbs' paths through the same hint shape.

  it("aws_resource_update surfaces the SSO recovery hint with the requestToken", async () => {
    await withFakeAws("resource_update_sso_expired_mid_poll", async () => {
      const r = (await updateResource.handler({
        typeName: "AWS::Lambda::Function",
        identifier: "my-fn",
        patchDocument: [{ op: "replace", path: "/MemorySize", value: 512 }],
        profile: "tester",
        awaitCompletion: true,
        pollIntervalMs: 500,
        maxWaitMs: 2000,
      })) as { ok: boolean; error?: string; errorKind?: string; suggestion?: string };
      assert.equal(r.ok, false);
      assert.match(r.error ?? "", /SSO session expired/);
      assert.match(r.error ?? "", /aws_login_start/);
      assert.match(r.error ?? "", /tester/);
      assert.match(r.error ?? "", /aws_resource_status/);
      // The token from the update-resource fake-aws response, not the
      // create-side one -- pins that the hint pulls from THIS handler's
      // ProgressEvent rather than a hardcoded constant.
      assert.match(r.error ?? "", /req-tok-upd/);
      // The recovery sentence is BUILT here, so its wording no longer matches
      // what any other tool emits. PollResult.kind rides along so a caller can
      // still branch on WHICH credential failure interrupted the wait instead
      // of parsing the sentence.
      assert.equal(r.errorKind, "sso_expired");
      assert.equal(r.suggestion, undefined);
    });
  });

  it("aws_resource_delete surfaces the SSO recovery hint with the requestToken", async () => {
    await withFakeAws("resource_delete_sso_expired_mid_poll", async () => {
      const r = (await deleteResource.handler({
        typeName: "AWS::S3::Bucket",
        identifier: "my-bucket",
        profile: "tester",
        awaitCompletion: true,
        pollIntervalMs: 500,
        maxWaitMs: 2000,
      })) as { ok: boolean; error?: string; errorKind?: string; suggestion?: string };
      assert.equal(r.ok, false);
      assert.match(r.error ?? "", /SSO session expired/);
      assert.match(r.error ?? "", /aws_login_start/);
      assert.match(r.error ?? "", /tester/);
      assert.match(r.error ?? "", /aws_resource_status/);
      assert.match(r.error ?? "", /req-tok-del/);
      assert.equal(r.errorKind, "sso_expired");
      assert.equal(r.suggestion, undefined);
    });
  });

  it("aws_resource_delete surfaces the no_creds recovery hint (different wording from sso_expired)", async () => {
    // kind=no_creds takes a separate branch in buildMutationResponse and
    // produces a different hint ("After fixing credentials..." rather than
    // "Call aws_login_start..."). Delete is the destructive verb, so it's
    // the most important to cover.
    await withFakeAws("resource_delete_no_creds_mid_poll", async () => {
      const r = (await deleteResource.handler({
        typeName: "AWS::S3::Bucket",
        identifier: "my-bucket",
        profile: "tester",
        awaitCompletion: true,
        pollIntervalMs: 500,
        maxWaitMs: 2000,
      })) as { ok: boolean; error?: string; errorKind?: string; suggestion?: string };
      assert.equal(r.ok, false);
      assert.match(r.error ?? "", /No credentials available/);
      assert.match(r.error ?? "", /fixing credentials/);
      assert.match(r.error ?? "", /tester/);
      assert.match(r.error ?? "", /aws_resource_status/);
      assert.match(r.error ?? "", /req-tok-del-nc/);
      // The SSO-specific text must NOT appear in the no_creds branch --
      // mixing them would mislead the caller about how to recover.
      assert.doesNotMatch(r.error ?? "", /SSO session expired/);
      assert.doesNotMatch(r.error ?? "", /aws_login_start/);
      // The structural half of that same distinction: the two hints differ in
      // prose AND in kind, so a caller need not tell them apart by wording.
      assert.equal(r.errorKind, "no_creds");
      assert.equal(r.suggestion, undefined);
    });
  });
});

describe("buildMutationResponse auth-recovery — expired_creds and invalid_creds arms (fake-aws)", () => {
  // The remaining two arms of the same recovery branch the sso_expired /
  // no_creds tests above cover. All four exist for one reason: the mutation
  // may already have landed server-side, so the requestToken MUST reach the
  // caller. Each arm differs only in how it says "fix your auth".

  it("aws_resource_update surfaces the expired_creds hint with the requestToken", async () => {
    await withFakeAws("resource_update_expired_creds_mid_poll", async () => {
      // ExpiredToken is the ORIGIN-AGNOSTIC expiry wrapper -- an assume-role
      // or web-identity session, not necessarily SSO -- so the hint names both
      // remedies rather than assuming SSO.
      const r = (await updateResource.handler({
        typeName: "AWS::Lambda::Function",
        identifier: "my-fn",
        patchDocument: [{ op: "replace", path: "/MemorySize", value: 512 }],
        profile: "tester",
        awaitCompletion: true,
        pollIntervalMs: 500,
        maxWaitMs: 2000,
      })) as { ok: boolean; error?: string; errorKind?: string; suggestion?: string };
      assert.equal(r.ok, false);
      assert.equal(r.errorKind, "expired_creds");
      assert.equal(r.suggestion, undefined);
      assert.match(r.error ?? "", /Temporary credentials for profile 'tester' expired while awaiting completion/);
      assert.match(r.error ?? "", /re-run the assume/);
      // The whole point of the arm: the recovery path survives the failure.
      assert.match(r.error ?? "", /aws_resource_status/);
      assert.match(r.error ?? "", /req-tok-upd-exp/);
      // The underlying CLI error is kept, not swallowed.
      assert.match(r.error ?? "", /Underlying error:/);
      assert.match(r.error ?? "", /ExpiredToken/);
      // Must NOT be rendered as the SSO arm: aws_login_start alone is wrong
      // advice for an STS session. (The nested underlying error legitimately
      // mentions aws_login_start as one of two remedies, so the discriminating
      // string is the SSO arm's own opening clause.)
      assert.doesNotMatch(r.error ?? "", /SSO session expired while awaiting completion/);
    });
  });

  it("aws_resource_create surfaces the invalid_creds hint with the requestToken", async () => {
    await withFakeAws("resource_create_invalid_creds_mid_poll", async () => {
      // A key rotated or deleted MID-POLL. The credentials resolved and AWS
      // REJECTED them, so this is neither an expiry (nothing to refresh) nor a
      // missing profile. Before the invalid_creds arm existed, this kind fell
      // through to the bare poll error and DROPPED the requestToken -- the
      // identical defect that was fixed for expired_creds.
      const r = (await createResource.handler({
        typeName: "AWS::SSM::Parameter",
        desiredState: { Name: "/my/p", Type: "String", Value: "v" },
        profile: "tester",
        awaitCompletion: true,
        pollIntervalMs: 500,
        maxWaitMs: 2000,
      })) as { ok: boolean; error?: string; errorKind?: string; suggestion?: string };
      assert.equal(r.ok, false);
      // These two are the load-bearing assertions: the bare poll error (what
      // the un-fixed code returned) carries neither.
      assert.match(r.error ?? "", /aws_resource_status/);
      assert.match(r.error ?? "", /req-tok-inv/);
      assert.equal(r.errorKind, "invalid_creds");
      assert.equal(r.suggestion, undefined);
      assert.match(r.error ?? "", /Fix the credentials for this profile/);
      assert.match(r.error ?? "", /tester/);
      assert.match(r.error ?? "", /Underlying error:/);
      // Wrong-remedy guards: invalid_creds is not an expiry and not a
      // missing-credentials case, so neither sibling's wording may appear.
      assert.doesNotMatch(r.error ?? "", /SSO session expired/);
      assert.doesNotMatch(r.error ?? "", /aws_login_start/);
      assert.doesNotMatch(r.error ?? "", /No credentials available/);
      assert.doesNotMatch(r.error ?? "", /expired while awaiting completion/);
    });
  });
});

describe("pollUntilTerminal — malformed/past RetryAfter falls back to pollIntervalMs", () => {
  // Companion to the "honors RetryAfter" test above. The RetryAfter parsing
  // path has two guards: Number.isNaN(Date.parse(raw)) and a past-time
  // check (ra <= 0). Both must fall back to the configured pollIntervalMs
  // rather than treating the bad value as a wait. Unit-style here so the
  // sleep duration is observable; fake-aws can't surface that.
  it("falls back to pollIntervalMs when RetryAfter is unparseable (Number.isNaN(Date.parse(...)))", async () => {
    const responses: Record<string, unknown>[] = [
      { OperationStatus: "IN_PROGRESS", RequestToken: "tok-1", RetryAfter: "not-a-date" },
      { OperationStatus: "SUCCESS", RequestToken: "tok-1" },
    ];
    let i = 0;
    const awsCall = async (): Promise<AwsCallResult> => progressResponse(responses[i++]);
    const sleeps: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push(ms);
    };
    const r = await pollUntilTerminal(
      { requestToken: "tok-1", pollIntervalMs: 250, maxWaitMs: 60_000 },
      awsCall,
      sleep,
    );
    assert.equal(r.ok, true);
    assert.equal(sleeps.length, 1);
    // Must be the pollIntervalMs verbatim, not the bad string interpreted
    // as a millisecond count (would be NaN) or coerced to 0.
    assert.equal(sleeps[0], 250);
  });

  it("falls back to pollIntervalMs when RetryAfter is in the past (target - now <= 0)", async () => {
    // Date.parse succeeds, but the resulting target is before Date.now(),
    // so the `ra > 0` guard rejects the override and pollIntervalMs wins.
    const inThePast = new Date(Date.now() - 60_000).toISOString();
    const responses: Record<string, unknown>[] = [
      { OperationStatus: "IN_PROGRESS", RequestToken: "tok-1", RetryAfter: inThePast },
      { OperationStatus: "SUCCESS", RequestToken: "tok-1" },
    ];
    let i = 0;
    const awsCall = async (): Promise<AwsCallResult> => progressResponse(responses[i++]);
    const sleeps: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push(ms);
    };
    const r = await pollUntilTerminal(
      { requestToken: "tok-1", pollIntervalMs: 300, maxWaitMs: 60_000 },
      awsCall,
      sleep,
    );
    assert.equal(r.ok, true);
    assert.equal(sleeps.length, 1);
    // pollIntervalMs verbatim -- past-date must NOT cause a 0-wait
    // tight-loop (which would still pass elapsedMs-style asserts but
    // pin the wrong branch).
    assert.equal(sleeps[0], 300);
  });
});

describe("schemas — awaitCompletion / pollIntervalMs / maxWaitMs", () => {
  it("aws_resource_create accepts awaitCompletion with bounded poll/maxWait", () => {
    assert.equal(
      createResource.inputSchema.safeParse({
        typeName: "AWS::SSM::Parameter",
        desiredState: { Name: "/x", Type: "String", Value: "y" },
        awaitCompletion: true,
        pollIntervalMs: 1500,
        maxWaitMs: 60_000,
      }).success,
      true,
    );
  });

  it("aws_resource_create rejects pollIntervalMs below the floor", () => {
    assert.equal(
      createResource.inputSchema.safeParse({
        typeName: "AWS::SSM::Parameter",
        desiredState: { Name: "/x", Type: "String", Value: "y" },
        pollIntervalMs: 100, // below 500ms floor
      }).success,
      false,
    );
  });

  it("aws_resource_create rejects pollIntervalMs above the ceiling", () => {
    assert.equal(
      createResource.inputSchema.safeParse({
        typeName: "AWS::SSM::Parameter",
        desiredState: { Name: "/x", Type: "String", Value: "y" },
        pollIntervalMs: 60_000, // above 30s ceiling
      }).success,
      false,
    );
  });

  it("aws_resource_create rejects maxWaitMs above the 30-min ceiling", () => {
    assert.equal(
      createResource.inputSchema.safeParse({
        typeName: "AWS::SSM::Parameter",
        desiredState: { Name: "/x", Type: "String", Value: "y" },
        maxWaitMs: 60 * 60_000, // 1h
      }).success,
      false,
    );
  });

  it("aws_resource_update and aws_resource_delete also accept awaitCompletion", () => {
    assert.equal(
      updateResource.inputSchema.safeParse({
        typeName: "AWS::Lambda::Function",
        identifier: "my-fn",
        patchDocument: [{ op: "replace", path: "/MemorySize", value: 512 }],
        awaitCompletion: true,
      }).success,
      true,
    );
    assert.equal(
      deleteResource.inputSchema.safeParse({
        typeName: "AWS::S3::Bucket",
        identifier: "my-bucket",
        awaitCompletion: true,
      }).success,
      true,
    );
  });
});

describe("pollUntilTerminal -- progress reporting", () => {
  // The awaitCompletion path is the longest-running thing this server does
  // (maxWaitMs tops out at 30 minutes). A caller that hears nothing for that
  // long cannot distinguish "still polling" from "hung", so the loop reports
  // once per attempt. These tests pin the SHAPE of those reports, not just
  // their existence.
  interface ProgressCall {
    progress: number;
    total?: number;
    message?: string;
  }
  const recordingCtx = (signal?: AbortSignal): { ctx: ToolContext; calls: ProgressCall[] } => {
    const calls: ProgressCall[] = [];
    return {
      ctx: {
        reportProgress: (progress, total, message) => {
          calls.push({ progress, total, message });
        },
        signal,
      },
      calls,
    };
  };

  it("reports once per poll attempt with monotonically increasing progress", async () => {
    const responses: Record<string, unknown>[] = [
      { OperationStatus: "PENDING", RequestToken: "tok-1" },
      { OperationStatus: "IN_PROGRESS", RequestToken: "tok-1" },
      { OperationStatus: "SUCCESS", RequestToken: "tok-1", Identifier: "id-1" },
    ];
    let i = 0;
    const awsCall = async (): Promise<AwsCallResult> => progressResponse(responses[i++]);
    const { ctx, calls } = recordingCtx();

    const r = await pollUntilTerminal(
      { requestToken: "tok-1", pollIntervalMs: 10, maxWaitMs: 5_000, ctx },
      awsCall,
      async () => undefined,
    );

    assert.equal(r.ok, true);
    assert.equal(r.attempts, 3);
    assert.equal(calls.length, 3, "one report per attempt, including the terminal one");
    assert.deepEqual(
      calls.map((c) => c.progress),
      [1, 2, 3],
      "progress is the attempt count, so it rises by construction",
    );
    for (let n = 1; n < calls.length; n++) {
      assert.ok(calls[n].progress > calls[n - 1].progress, "progress must increase monotonically within one call");
    }
  });

  it("omits `total` -- the denominator is genuinely unknown while polling", async () => {
    // maxWaitMs bounds how long we WAIT, not how much work there is: the
    // operation ends when AWS says so. Any total here would be invented, and
    // the MCP spec allows progress without one precisely for this case.
    const responses: Record<string, unknown>[] = [
      { OperationStatus: "IN_PROGRESS", RequestToken: "tok-1" },
      { OperationStatus: "SUCCESS", RequestToken: "tok-1" },
    ];
    let i = 0;
    const awsCall = async (): Promise<AwsCallResult> => progressResponse(responses[i++]);
    const { ctx, calls } = recordingCtx();

    await pollUntilTerminal(
      { requestToken: "tok-1", pollIntervalMs: 10, maxWaitMs: 5_000, ctx },
      awsCall,
      async () => undefined,
    );

    assert.equal(calls.length, 2);
    for (const c of calls) {
      assert.equal(c.total, undefined, "no fabricated denominator for open-ended polling");
    }
  });

  it("puts the elapsed time and the observed OperationStatus in the message", async () => {
    // What a human watching a 30-minute wait actually wants: how long it has
    // been, and what AWS last said. The status must be THIS attempt's, not the
    // previous one's -- hence the differing statuses below.
    const responses: Record<string, unknown>[] = [
      { OperationStatus: "PENDING", RequestToken: "tok-1" },
      { OperationStatus: "IN_PROGRESS", RequestToken: "tok-1" },
      { OperationStatus: "FAILED", RequestToken: "tok-1", ErrorCode: "NotUpdatable" },
    ];
    let i = 0;
    const awsCall = async (): Promise<AwsCallResult> => progressResponse(responses[i++]);
    const { ctx, calls } = recordingCtx();

    await pollUntilTerminal(
      { requestToken: "tok-1", pollIntervalMs: 10, maxWaitMs: 5_000, ctx },
      awsCall,
      async () => undefined,
    );

    assert.equal(calls.length, 3);
    assert.match(calls[0].message ?? "", /PENDING/);
    assert.match(calls[1].message ?? "", /IN_PROGRESS/);
    assert.match(calls[2].message ?? "", /FAILED/, "the terminal attempt reports the status it observed");
    for (const c of calls) {
      assert.match(c.message ?? "", /after \d+s/, `message must carry elapsed time, got: ${c.message}`);
    }
  });

  it("a no-op ctx (the no-progressToken path) changes nothing about the result", async () => {
    // buildToolContext hands back a no-op reportProgress when the client sent
    // no progressToken. Handlers call it unconditionally, so the no-op path is
    // the COMMON one -- it must not perturb the returned PollResult.
    const script = (): (() => Promise<AwsCallResult>) => {
      const responses: Record<string, unknown>[] = [
        { OperationStatus: "IN_PROGRESS", RequestToken: "tok-1" },
        { OperationStatus: "SUCCESS", RequestToken: "tok-1", Identifier: "id-1" },
      ];
      let i = 0;
      return async () => progressResponse(responses[i++]);
    };
    const project = (r: Awaited<ReturnType<typeof pollUntilTerminal>>) => ({
      ok: r.ok,
      attempts: r.attempts,
      command: r.command,
      progressEvent: r.progressEvent,
      error: r.error,
      cancelled: r.cancelled,
    });

    const withNoOp = await pollUntilTerminal(
      { requestToken: "tok-1", pollIntervalMs: 10, maxWaitMs: 5_000, ctx: { reportProgress: () => {} } },
      script(),
      async () => undefined,
    );
    const withNothing = await pollUntilTerminal(
      { requestToken: "tok-1", pollIntervalMs: 10, maxWaitMs: 5_000 },
      script(),
      async () => undefined,
    );

    // elapsedMs is wall-clock and excluded from the projection; everything
    // else the caller reads must be identical.
    assert.deepEqual(project(withNoOp), project(withNothing));
    assert.equal(withNoOp.ok, true);
  });
});

describe("pollUntilTerminal -- client cancellation", () => {
  it("stops polling early when the client cancels mid-wait", async () => {
    // The budget here is 60s and the operation never reaches a terminal state,
    // so an uncancelled loop would keep calling AWS for a full minute. The
    // abort lands during the second sleep; the call count proves the loop
    // stopped there instead of running the budget out.
    const controller = new AbortController();
    let calls = 0;
    const awsCall = async (): Promise<AwsCallResult> => {
      calls++;
      return progressResponse({ OperationStatus: "IN_PROGRESS", RequestToken: "tok-1" });
    };
    let sleeps = 0;
    const sleep = async (): Promise<void> => {
      sleeps++;
      // Stands in for the client hanging up while we are between polls.
      if (sleeps === 2) controller.abort();
    };

    const r = await pollUntilTerminal(
      {
        requestToken: "tok-1",
        pollIntervalMs: 1_000,
        maxWaitMs: 60_000,
        ctx: { reportProgress: () => {}, signal: controller.signal },
      },
      awsCall,
      sleep,
    );

    assert.equal(calls, 2, "polling must stop at the cancellation, not run the 60s budget out");
    assert.equal(r.ok, false, "an unfinished operation is not a success");
    assert.equal(r.cancelled, true, "the cancelled arm is distinct from a failure");
  });

  it("words the cancellation distinctly and hands back the requestToken", async () => {
    const controller = new AbortController();
    let sleeps = 0;
    const awsCall = async (): Promise<AwsCallResult> =>
      progressResponse({ OperationStatus: "IN_PROGRESS", RequestToken: "tok-abc" });
    const sleep = async (): Promise<void> => {
      sleeps++;
      if (sleeps === 1) controller.abort();
    };

    const r = await pollUntilTerminal(
      {
        requestToken: "tok-abc",
        pollIntervalMs: 100,
        maxWaitMs: 60_000,
        ctx: { reportProgress: () => {}, signal: controller.signal },
      },
      awsCall,
      sleep,
    );

    assert.equal(r.cancelled, true);
    assert.match(r.error ?? "", /Cancelled by the client/);
    // Must not be mistakable for the budget-exhausted arm, which says
    // "Polled for Ns without reaching a terminal state".
    assert.doesNotMatch(r.error ?? "", /without reaching a terminal state/);
    // The operation is still running server-side -- say so, and hand back the
    // token needed to find out how it ended.
    assert.match(r.error ?? "", /NOT cancelled/);
    assert.match(r.error ?? "", /aws_resource_status/);
    assert.match(r.error ?? "", /tok-abc/);
    // Last-seen status survives so the caller knows where it stopped.
    assert.equal((r.progressEvent as Record<string, unknown>)?.OperationStatus, "IN_PROGRESS");
  });

  it("makes no AWS call at all when the request was already cancelled", async () => {
    // The one-shot guarantee (always poll at least once) exists so a caller
    // always gets a result. A cancelled request has no caller left, so the
    // signal check runs on the first pass too and that exemption does not
    // apply.
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const awsCall = async (): Promise<AwsCallResult> => {
      calls++;
      return progressResponse({ OperationStatus: "SUCCESS", RequestToken: "tok-1" });
    };

    const r = await pollUntilTerminal(
      {
        requestToken: "tok-1",
        pollIntervalMs: 100,
        maxWaitMs: 60_000,
        ctx: { reportProgress: () => {}, signal: controller.signal },
      },
      awsCall,
      async () => undefined,
    );

    assert.equal(calls, 0, "a pre-cancelled request must not spend an AWS call");
    assert.equal(r.ok, false);
    assert.equal(r.cancelled, true);
    assert.equal(r.attempts, 0);
  });

  it("wakes out of the real (non-injected) sleep instead of waiting the interval out", async () => {
    // Uses the DEFAULT sleep, so this pins the abort wiring in
    // sleepUnlessAborted rather than a test double. pollIntervalMs is 5s: a
    // plain setTimeout would return no sooner than that, while an abort-aware
    // one returns as soon as the signal fires (~20ms here).
    const controller = new AbortController();
    let calls = 0;
    const awsCall = async (): Promise<AwsCallResult> => {
      calls++;
      if (calls === 1) setTimeout(() => controller.abort(), 20);
      return progressResponse({ OperationStatus: "IN_PROGRESS", RequestToken: "tok-1" });
    };

    const started = Date.now();
    const r = await pollUntilTerminal(
      {
        requestToken: "tok-1",
        pollIntervalMs: 5_000,
        maxWaitMs: 60_000,
        ctx: { reportProgress: () => {}, signal: controller.signal },
      },
      awsCall,
    );
    const took = Date.now() - started;

    assert.equal(r.cancelled, true);
    assert.equal(calls, 1);
    assert.ok(took < 2_000, `expected the sleep to abort early, took ${took}ms of a 5000ms interval`);
  });
});

describe("aws_resource_create handler — progress threading (fake-aws)", () => {
  // Proves the ctx actually reaches the poll loop through the handler ->
  // buildMutationResponse -> pollUntilTerminal chain. The unit tests above
  // call pollUntilTerminal directly, so a handler that dropped `ctx` on the
  // floor would leave every one of them green.

  it("reports poll progress through awaitCompletion, and a no-op ctx returns the same result", async () => {
    await withFakeAws("resource_create_then_status_success", async () => {
      const calls: { progress: number; total?: number; message?: string }[] = [];
      const input = {
        typeName: "AWS::SSM::Parameter",
        desiredState: { Name: "/my/p", Type: "String", Value: "v" },
        profile: "tester",
        awaitCompletion: true,
        pollIntervalMs: 500,
        maxWaitMs: 5_000,
      };

      const reported = await createResource.handler(input, {
        reportProgress: (progress, total, message) => {
          calls.push({ progress, total, message });
        },
      });
      assert.equal(reported.ok, true);
      // The scenario reaches SUCCESS on the first poll, so exactly one report.
      assert.equal(calls.length, 1, `expected one poll report, got ${JSON.stringify(calls)}`);
      assert.equal(calls[0].progress, 1);
      assert.equal(calls[0].total, undefined);
      assert.match(calls[0].message ?? "", /SUCCESS/);

      const silent = await createResource.handler(input, { reportProgress: () => {} });
      assert.equal(silent.ok, true);
      // Same envelope either way, minus the wall-clock `awaited` timings.
      const strip = (r: { data?: unknown }): Record<string, unknown> => {
        const d = { ...(r.data as Record<string, unknown>) };
        delete d.awaited;
        return d;
      };
      assert.deepEqual(strip(silent), strip(reported));
    });
  });
});

const THROTTLE_STDERR =
  "\nAn error occurred (ThrottlingException) when calling the GetResourceRequestStatus operation (reached max retries: 2): Rate exceeded\n";
const throttled = (): AwsCallResult => ({
  ok: false,
  kind: "nonzero_exit",
  error: "throttled",
  command: "aws cloudcontrol get-resource-request-status --request-token tok-1",
  commandArgv: ["aws", "cloudcontrol", "get-resource-request-status", "--request-token", "tok-1"],
  rawStderr: THROTTLE_STDERR,
});

describe("isTransientPollFailure", () => {
  const fail = (kind: string, rawStderr = ""): Parameters<typeof isTransientPollFailure>[0] =>
    ({ ok: false, kind, error: "x", rawStderr }) as Parameters<typeof isTransientPollFailure>[0];

  it("retries a throttle, a 5xx, a transport timeout, our own timeout and a spawn hiccup", () => {
    assert.equal(isTransientPollFailure(fail("nonzero_exit", THROTTLE_STDERR)), true);
    assert.equal(
      isTransientPollFailure(
        fail("nonzero_exit", "An error occurred (ServiceUnavailableException) when calling the X operation: down"),
      ),
      true,
    );
    assert.equal(
      isTransientPollFailure(fail("nonzero_exit", 'Read timeout on endpoint URL: "https://cloudcontrolapi"')),
      true,
    );
    assert.equal(isTransientPollFailure(fail("timeout")), true);
    assert.equal(isTransientPollFailure(fail("spawn_failure")), true);
  });

  it("never retries auth, validation, cancellation or a bad body", () => {
    for (const kind of ["sso_expired", "expired_creds", "invalid_creds", "no_creds", "cancelled", "malformed_json"]) {
      assert.equal(isTransientPollFailure(fail(kind, THROTTLE_STDERR)), false, kind);
    }
    assert.equal(
      isTransientPollFailure(
        fail("nonzero_exit", "An error occurred (ValidationException) when calling the X operation: bad"),
      ),
      false,
    );
  });
});

describe("pollUntilTerminal -- bounded transient retries", () => {
  it("absorbs transient failures and still reaches the terminal state", async () => {
    const script: AwsCallResult[] = [
      throttled(),
      progressResponse({ OperationStatus: "IN_PROGRESS", RequestToken: "tok-1" }),
      throttled(),
      throttled(),
      progressResponse({ OperationStatus: "SUCCESS", RequestToken: "tok-1" }),
    ];
    let i = 0;
    const r = await pollUntilTerminal(
      { requestToken: "tok-1", pollIntervalMs: 10, maxWaitMs: 60_000 },
      async () => script[i++],
      async () => undefined,
    );
    assert.equal(r.ok, true, r.error ?? "");
    assert.equal(r.attempts, 5);
    assert.equal(r.transientRetries, 3, "the streak resets on a good poll, so 3 total is fine");
  });

  it(`gives up after ${MAX_TRANSIENT_POLL_RETRIES} consecutive transient failures`, async () => {
    let calls = 0;
    const r = await pollUntilTerminal(
      { requestToken: "tok-1", pollIntervalMs: 10, maxWaitMs: 60_000 },
      async () => {
        calls++;
        return throttled();
      },
      async () => undefined,
    );
    assert.equal(r.ok, false);
    assert.equal(calls, MAX_TRANSIENT_POLL_RETRIES + 1);
    assert.equal(r.transientRetries, MAX_TRANSIENT_POLL_RETRIES);
    assert.equal(r.kind, "nonzero_exit");
  });

  it("does not retry a non-transient failure", async () => {
    let calls = 0;
    const r = await pollUntilTerminal(
      { requestToken: "tok-1", pollIntervalMs: 10, maxWaitMs: 60_000 },
      async () => {
        calls++;
        return {
          ok: false,
          kind: "nonzero_exit",
          error: "bad",
          rawStderr: "An error occurred (ValidationException) when calling the X operation: no",
        };
      },
      async () => undefined,
    );
    assert.equal(r.ok, false);
    assert.equal(calls, 1);
    assert.equal(r.transientRetries, 0);
  });

  it("does not retry when a poll interval no longer fits in the budget", async (t) => {
    let now = 5_000_000;
    t.mock.method(Date, "now", () => now);
    let calls = 0;
    const r = await pollUntilTerminal(
      { requestToken: "tok-1", pollIntervalMs: 50, maxWaitMs: 100 },
      async () => {
        calls++;
        return throttled();
      },
      async (ms: number) => {
        now += ms;
      },
    );
    // Retry at 0 -> sleep to 50 -> 50 + 50 is not < 100, so the second
    // failure is returned rather than retried past the deadline.
    assert.equal(r.ok, false);
    assert.equal(calls, 2);
    assert.equal(r.kind, "nonzero_exit");
  });
});

describe("awaited mutations -- non-auth poll failures keep the requestToken (fake-aws)", () => {
  const awaitedCreate = {
    typeName: "AWS::SSM::Parameter",
    desiredState: { Name: "/my/p", Type: "String", Value: "v" },
    awaitCompletion: true,
    pollIntervalMs: 20,
    maxWaitMs: 60_000,
  };
  // Each poll is a fresh fake-aws process, so the scenario counts polls in a
  // file; one per test, all under a directory removed when the block ends.
  const counterDir = mkdtempSync(join(tmpdir(), "aws-mcp-pollfail-"));
  after(() => rmSync(counterDir, { recursive: true, force: true }));
  let counterSeq = 0;
  const counterEnv = (): Record<string, string> => ({
    AWS_MCP_FAKE_POLL_COUNTER: join(counterDir, `polls-${++counterSeq}`),
  });
  const pollsOf = (env: Record<string, string>): number => Number(readFileSync(env.AWS_MCP_FAKE_POLL_COUNTER, "utf8"));

  it("a throttle that outlives the retries returns ok:false WITH the requestToken and last status", async () => {
    const env = counterEnv();
    const r = await withFakeAws(
      "resource_create_pollfail_throttle_always",
      () => createResource.handler(awaitedCreate),
      env,
    );
    assert.equal(r.ok, false);
    // The load-bearing assertions: the bare poll error carried neither.
    assert.match(r.error ?? "", /aws_resource_status with requestToken='req-tok-pf'/);
    assert.match(r.error ?? "", /last status: IN_PROGRESS/);
    assert.match(r.error ?? "", /identifier: \/my\/p/);
    assert.match(r.error ?? "", /already accepted/);
    assert.match(r.error ?? "", new RegExp(`after ${MAX_TRANSIENT_POLL_RETRIES} transient-failure retries`));
    // The underlying throttle is kept, not swallowed.
    assert.match(r.error ?? "", /ThrottlingException/);
    assert.equal(r.errorKind, "nonzero_exit");
    assert.equal(pollsOf(env), MAX_TRANSIENT_POLL_RETRIES + 1, "bounded: the cap plus the first try");
  });

  it("a throttle that clears within the retries completes the wait", async () => {
    const env = counterEnv();
    const r = await withFakeAws(
      "resource_create_pollfail_throttle_then_success",
      () => createResource.handler(awaitedCreate),
      env,
    );
    assert.equal(r.ok, true, r.error ?? "");
    const d = r.data as { operationStatus?: string; requestToken?: string; awaited?: { attempts: number } };
    assert.equal(d.operationStatus, "SUCCESS");
    assert.equal(d.requestToken, "req-tok-pf");
    assert.equal(d.awaited?.attempts, 3, "two throttles, then the SUCCESS poll");
    assert.equal(pollsOf(env), 3);
  });

  it("a non-transient poll failure is not retried, and still hands back the requestToken", async () => {
    const env = counterEnv();
    const r = await withFakeAws(
      "resource_create_pollfail_validation",
      () => createResource.handler(awaitedCreate),
      env,
    );
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /requestToken='req-tok-pf'/);
    assert.match(r.error ?? "", /ValidationException/);
    assert.doesNotMatch(r.error ?? "", /transient-failure retr/);
    assert.equal(r.errorKind, "nonzero_exit");
    assert.equal(pollsOf(env), 1);
  });
});

describe("create / update / delete / status envelopes carry commandArgv", () => {
  it("not awaited: commandArgv is the mutation's own argv", async () => {
    const r = await withFakeAws("resource_create_then_status_success", () =>
      createResource.handler({
        typeName: "AWS::SSM::Parameter",
        desiredState: { Name: "/my/p", Type: "String", Value: "v" },
      }),
    );
    assert.equal(r.ok, true, r.error ?? "");
    const d = r.data as { command: string; commandArgv?: string[] };
    assert.ok(Array.isArray(d.commandArgv));
    assert.ok(d.commandArgv.includes("create-resource"));
    assert.match(d.command, /create-resource/);
  });

  it("awaited: commandArgv is the last poll's argv, matching `command`", async () => {
    const r = await withFakeAws("resource_create_then_status_success", () =>
      createResource.handler({
        typeName: "AWS::SSM::Parameter",
        desiredState: { Name: "/my/p", Type: "String", Value: "v" },
        awaitCompletion: true,
        pollIntervalMs: 20,
        maxWaitMs: 60_000,
      }),
    );
    assert.equal(r.ok, true, r.error ?? "");
    const d = r.data as { command: string; commandArgv?: string[] };
    assert.ok(Array.isArray(d.commandArgv));
    assert.ok(d.commandArgv.includes("get-resource-request-status"));
    assert.ok(d.commandArgv.includes("req-tok-ok"));
    assert.match(d.command, /get-resource-request-status/);
  });

  it("aws_resource_status: commandArgv rides beside command", async () => {
    const r = await withFakeAws("resource_create_then_status_success", () =>
      statusResource.handler({ requestToken: "req-tok-ok" }),
    );
    assert.equal(r.ok, true, r.error ?? "");
    const d = r.data as { commandArgv?: string[]; operationStatus?: string };
    assert.ok(d.commandArgv?.includes("get-resource-request-status"));
    assert.equal(d.operationStatus, "SUCCESS");
  });
});

describe("tool descriptions say what ok:true does not mean", () => {
  it("every mutation verb and status says FAILED / CANCEL_COMPLETE did not apply", () => {
    for (const t of [createResource, updateResource, deleteResource, statusResource]) {
      assert.match(t.description, /FAILED or CANCEL_COMPLETE means (it|the mutation) did NOT apply/, t.name);
    }
  });
});

describe("aws_resource_update schema -- RFC 6902 required members", () => {
  const parse = (op: Record<string, unknown>) =>
    updateResource.inputSchema.safeParse({ typeName: "AWS::Lambda::Function", identifier: "f", patchDocument: [op] })
      .success;
  it("requires `value` on test, and `from` on move / copy", () => {
    assert.equal(parse({ op: "test", path: "/A" }), false);
    assert.equal(parse({ op: "test", path: "/A", value: 1 }), true);
    assert.equal(parse({ op: "move", path: "/B" }), false);
    assert.equal(parse({ op: "copy", path: "/B" }), false);
    assert.equal(parse({ op: "move", path: "/B", from: "/A" }), true);
    assert.equal(parse({ op: "copy", path: "/B", from: "/A" }), true);
    assert.equal(parse({ op: "remove", path: "/A" }), true);
  });
});
