import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runAwsCall } from "../aws-cli.js";
import { _resetSession } from "../session.js";
import { extractNextToken, paginateTools, wrapQueryForPagination } from "./paginate.js";

const tool = paginateTools.find((t) => t.name === "aws_paginate");
if (!tool) throw new Error("paginateTools missing aws_paginate");

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AWS = join(__dirname, "..", "testing", "fake-aws.js");

afterEach(() => {
  _resetSession();
});

describe("extractNextToken", () => {
  it("returns the token when NextToken is a non-empty string", () => {
    assert.equal(extractNextToken({ Buckets: [], NextToken: "abc==" }), "abc==");
  });

  it("returns null when NextToken is missing", () => {
    assert.equal(extractNextToken({ Buckets: [] }), null);
  });

  it("returns null when NextToken is empty string", () => {
    assert.equal(extractNextToken({ NextToken: "" }), null);
  });

  it("returns null when NextToken is not a string (defensive)", () => {
    assert.equal(extractNextToken({ NextToken: 42 }), null);
    assert.equal(extractNextToken({ NextToken: null }), null);
  });

  it("returns null for non-object inputs", () => {
    assert.equal(extractNextToken(null), null);
    assert.equal(extractNextToken(undefined), null);
    assert.equal(extractNextToken("string"), null);
    assert.equal(extractNextToken(42), null);
  });
});

describe("aws_paginate schema", () => {
  it("accepts a minimal call with just service + operation", () => {
    const r = tool.inputSchema.safeParse({ service: "s3api", operation: "list-buckets" });
    assert.equal(r.success, true);
  });

  it("accepts maxItems and startingToken", () => {
    const r = tool.inputSchema.safeParse({
      service: "s3api",
      operation: "list-objects-v2",
      maxItems: 50,
      startingToken: "xyz",
    });
    assert.equal(r.success, true);
  });

  it("rejects zero or negative maxItems", () => {
    assert.equal(
      tool.inputSchema.safeParse({ service: "s3api", operation: "list-buckets", maxItems: 0 }).success,
      false,
    );
    assert.equal(
      tool.inputSchema.safeParse({ service: "s3api", operation: "list-buckets", maxItems: -1 }).success,
      false,
    );
  });
});

describe("runAwsCall with extraFlags (pagination plumbing)", () => {
  it("places --max-items and --starting-token after the operation tokens", async () => {
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-objects-v2",
      extraFlags: ["--max-items", "50", "--starting-token", "abc=="],
      command: process.execPath,
      prefixArgs: [FAKE_AWS],
      env: { ...process.env, AWS_MCP_FAKE_SCENARIO: "call_echo_args" },
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const { argv } = r.data as { argv: string[] };
    const opIdx = argv.indexOf("list-objects-v2");
    const maxIdx = argv.indexOf("--max-items");
    const tokenIdx = argv.indexOf("--starting-token");
    const outputIdx = argv.indexOf("--output");
    assert.ok(maxIdx > opIdx && maxIdx < outputIdx, "--max-items must sit between operation and --output");
    assert.equal(argv[maxIdx + 1], "50");
    assert.equal(argv[tokenIdx + 1], "abc==");
  });

  it("surfaces NextToken from stdout when a page is truncated", async () => {
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      extraFlags: ["--max-items", "2"],
      command: process.execPath,
      prefixArgs: [FAKE_AWS],
      env: { ...process.env, AWS_MCP_FAKE_SCENARIO: "paginate_has_more" },
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(extractNextToken(r.data), "eyJuZXh0IjoiYWJjIn0=");
  });

  it("returns no NextToken on a final-page response", async () => {
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      extraFlags: ["--max-items", "2", "--starting-token", "abc"],
      command: process.execPath,
      prefixArgs: [FAKE_AWS],
      env: { ...process.env, AWS_MCP_FAKE_SCENARIO: "paginate_last_page" },
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(extractNextToken(r.data), null);
  });
});

describe("wrapQueryForPagination", () => {
  it("wraps a simple projection so NextToken survives", () => {
    assert.equal(wrapQueryForPagination("Buckets[].Name"), "{NextToken: NextToken, items: Buckets[].Name}");
  });

  it("wraps a multiselect-hash projection", () => {
    assert.equal(
      wrapQueryForPagination("Reservations[].Instances[].{Id:InstanceId,State:State.Name}"),
      "{NextToken: NextToken, items: Reservations[].Instances[].{Id:InstanceId,State:State.Name}}",
    );
  });
});

const tokenTool = paginateTools.find((t) => t.name === "aws_paginate");
if (!tokenTool) throw new Error("paginateTools missing aws_paginate");

describe("aws_paginate handler — query+NextToken round-trip via fake-aws", () => {
  it("unwraps `items` and surfaces nextToken when query is supplied (truncated page)", async () => {
    // The handler always calls runAwsCall with the real `aws` binary. Fake out
    // the binary by routing through process.execPath + fake-aws via a per-test
    // env var the wrapper can't normally inject -- handler doesn't expose
    // command/prefixArgs, so we exercise the wrap+unwrap path through
    // runAwsCall directly with the same wrapped query the handler builds.
    const wrapped = wrapQueryForPagination("Buckets[].Name");
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      query: wrapped,
      extraFlags: ["--max-items", "2"],
      command: process.execPath,
      prefixArgs: [FAKE_AWS],
      env: { ...process.env, AWS_MCP_FAKE_SCENARIO: "paginate_query_wrapped_has_more" },
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const data = r.data as { NextToken?: string; items?: string[] };
    assert.equal(data.NextToken, "eyJuZXh0IjoiYWJjIn0=");
    assert.deepEqual(data.items, ["bucket-1", "bucket-2"]);
  });

  it("returns null nextToken on a final-page response with a wrapped query", async () => {
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      query: wrapQueryForPagination("Buckets[].Name"),
      extraFlags: ["--max-items", "2"],
      command: process.execPath,
      prefixArgs: [FAKE_AWS],
      env: { ...process.env, AWS_MCP_FAKE_SCENARIO: "paginate_query_wrapped_last_page" },
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const data = r.data as { NextToken?: string | null; items?: string[] };
    assert.equal(data.NextToken, null);
    assert.deepEqual(data.items, ["bucket-3"]);
  });
});
