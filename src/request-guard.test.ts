import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { allTools, declaredArgumentsByTool } from "./index.js";
import {
  guardUndeclaredArguments,
  rejectOversizedUndeclaredArguments,
  UNDECLARED_ARGUMENTS_LIMIT_BYTES,
} from "./request-guard.js";

const declared = declaredArgumentsByTool(allTools);
const ONE_MB = "A".repeat(1_048_576);

function call(name: string, args: unknown, id: number | string = 7): JSONRPCMessage {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } } as JSONRPCMessage;
}

describe("rejectOversizedUndeclaredArguments", () => {
  it("refuses a 1 MB undeclared argument with a JSON-RPC -32602 carrying the request id", () => {
    // The exact probe @yawlabs/mcp-compliance's security-oversized-input sends.
    const refusal = rejectOversizedUndeclaredArguments(call("aws_whoami", { data: ONE_MB }, "abc"), declared);
    assert.ok(refusal && "error" in refusal, "expected a JSON-RPC error");
    assert.equal(refusal.id, "abc");
    assert.equal(refusal.error.code, -32602);
    assert.match(refusal.error.message, /aws_whoami: undeclared argument\(s\) "data" carry 1048578 bytes/);
    assert.match(refusal.error.message, /Declared arguments: profile, region\./);
  });

  it("sums every undeclared key against the limit", () => {
    const half = "B".repeat(UNDECLARED_ARGUMENTS_LIMIT_BYTES / 2);
    assert.ok(rejectOversizedUndeclaredArguments(call("aws_whoami", { a: half, b: half }), declared));
    assert.equal(rejectOversizedUndeclaredArguments(call("aws_whoami", { a: half }), declared), undefined);
  });

  it("lets a small stray argument through, to be ignored as before", () => {
    assert.equal(
      rejectOversizedUndeclaredArguments(call("aws_whoami", { __injected_param__: "malicious_value" }), declared),
      undefined,
    );
  });

  it("never measures DECLARED arguments, however large", () => {
    // The legitimate big inputs: a multi-MB Lambda payload, aws_script code, an
    // aws_call params document, an aws_resource_create desired state.
    const sixMb = "P".repeat(6 * 1024 * 1024);
    const cases: Array<[string, Record<string, unknown>]> = [
      ["aws_lambda_invoke", { functionName: "f", payload: { blob: sixMb } }],
      ["aws_script", { code: `return 1; // ${ONE_MB}` }],
      ["aws_call", { service: "iam", operation: "put-role-policy", params: { PolicyDocument: ONE_MB } }],
      ["aws_resource_create", { typeName: "AWS::S3::Bucket", desiredState: { Tags: ONE_MB } }],
    ];
    for (const [name, args] of cases) {
      assert.equal(rejectOversizedUndeclaredArguments(call(name, args), declared), undefined, name);
    }
  });

  it("leaves unknown tools, non-object arguments, notifications and other methods to the SDK", () => {
    assert.equal(rejectOversizedUndeclaredArguments(call("no_such_tool", { data: ONE_MB }), declared), undefined);
    assert.equal(rejectOversizedUndeclaredArguments(call("aws_whoami", ONE_MB), declared), undefined);
    assert.equal(rejectOversizedUndeclaredArguments(call("aws_whoami", [ONE_MB]), declared), undefined);
    const notification = {
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "aws_whoami", arguments: { data: ONE_MB } },
    } as JSONRPCMessage;
    assert.equal(rejectOversizedUndeclaredArguments(notification, declared), undefined);
    const other = { jsonrpc: "2.0", id: 1, method: "tools/list", params: { data: ONE_MB } } as JSONRPCMessage;
    assert.equal(rejectOversizedUndeclaredArguments(other, declared), undefined);
  });
});

describe("guardUndeclaredArguments", () => {
  function fakeTransport() {
    const sent: JSONRPCMessage[] = [];
    const transport: Transport = {
      start: async () => {},
      close: async () => {},
      send: async (m: JSONRPCMessage) => {
        sent.push(m);
      },
    };
    return { transport, sent };
  }

  it("answers an oversized call itself and never hands it to the protocol handler", async () => {
    const { transport, sent } = fakeTransport();
    guardUndeclaredArguments(transport, declared);
    const seen: JSONRPCMessage[] = [];
    // The protocol layer assigns onmessage during connect(); the guard wraps it.
    transport.onmessage = (m) => {
      seen.push(m);
    };

    transport.onmessage?.(call("aws_whoami", { data: ONE_MB }, 1));
    const ok = call("aws_whoami", { profile: "p" }, 2);
    transport.onmessage?.(ok);
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(seen, [ok]);
    assert.equal(sent.length, 1);
    assert.equal((sent[0] as { id: number }).id, 1);
    assert.equal((sent[0] as { error: { code: number } }).error.code, -32602);
  });

  it("keeps an unset handler unset", () => {
    const { transport } = fakeTransport();
    guardUndeclaredArguments(transport, declared);
    transport.onmessage = undefined;
    assert.equal(transport.onmessage, undefined);
  });
});
