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

describe("aws_paginate handler — end-to-end via AWS_MCP_TEST_AWS_* env override", () => {
  // The handler doesn't accept command/prefixArgs (would expose argv injection
  // via MCP). The runAwsCall wrapper honors AWS_MCP_TEST_AWS_COMMAND and
  // AWS_MCP_TEST_AWS_PREFIX_ARGS as a test-only fallback so we can drive the
  // full handler -- including the wrap-on-the-way-in / unwrap-on-the-way-out
  // path -- without exposing those knobs through the MCP surface. If a
  // future regression swaps wrap and unwrap, this test catches it.
  const beforeEachEnv = (): void => {
    process.env.AWS_MCP_TEST_AWS_COMMAND = process.execPath;
    process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS = JSON.stringify([FAKE_AWS]);
    _resetSession();
  };
  const afterEachEnv = (): void => {
    delete process.env.AWS_MCP_TEST_AWS_COMMAND;
    delete process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS;
    delete process.env.AWS_MCP_FAKE_SCENARIO;
    _resetSession();
  };

  it("handler wraps the user query, parses the wrapped response, and surfaces unwrapped items + nextToken", async () => {
    beforeEachEnv();
    try {
      process.env.AWS_MCP_FAKE_SCENARIO = "paginate_query_wrapped_has_more";
      const r = (await tool.handler({
        service: "s3api",
        operation: "list-buckets",
        query: "Buckets[].Name",
        maxItems: 2,
      })) as {
        ok: boolean;
        data?: { result?: unknown; nextToken?: string | null; hasMore?: boolean };
      };
      assert.equal(r.ok, true);
      assert.deepEqual(r.data?.result, ["bucket-1", "bucket-2"]);
      assert.equal(r.data?.nextToken, "eyJuZXh0IjoiYWJjIn0=");
      assert.equal(r.data?.hasMore, true);
    } finally {
      afterEachEnv();
    }
  });

  it("handler returns hasMore=false on the final page (NextToken=null inside the wrap)", async () => {
    beforeEachEnv();
    try {
      process.env.AWS_MCP_FAKE_SCENARIO = "paginate_query_wrapped_last_page";
      const r = (await tool.handler({
        service: "s3api",
        operation: "list-buckets",
        query: "Buckets[].Name",
        maxItems: 2,
      })) as {
        ok: boolean;
        data?: { result?: unknown; nextToken?: string | null; hasMore?: boolean };
      };
      assert.equal(r.ok, true);
      assert.deepEqual(r.data?.result, ["bucket-3"]);
      assert.equal(r.data?.nextToken, null);
      assert.equal(r.data?.hasMore, false);
    } finally {
      afterEachEnv();
    }
  });

  it("handler without query uses the raw response and reads top-level NextToken", async () => {
    beforeEachEnv();
    try {
      process.env.AWS_MCP_FAKE_SCENARIO = "paginate_has_more";
      const r = (await tool.handler({ service: "s3api", operation: "list-buckets", maxItems: 2 })) as {
        ok: boolean;
        data?: { result?: { Buckets?: Array<{ Name: string }> }; nextToken?: string | null; hasMore?: boolean };
      };
      assert.equal(r.ok, true);
      assert.deepEqual(r.data?.result?.Buckets, [{ Name: "bucket-1" }, { Name: "bucket-2" }]);
      assert.equal(r.data?.nextToken, "eyJuZXh0IjoiYWJjIn0=");
      assert.equal(r.data?.hasMore, true);
    } finally {
      afterEachEnv();
    }
  });

  it("handler surfaces ok:false + rawBody (from stderr) when the underlying CLI call fails", async () => {
    // Drive an access-denied failure through the FULL handler. The
    // call_access_denied scenario writes the AWS error to stderr and exits
    // 255, so runAwsCall returns ok:false with rawStderr populated. The
    // handler's failure branch must propagate ok:false and surface the
    // stderr blob under rawBody (the `result.rawStderr ?? result.rawStdout`
    // half of the envelope) -- the error path callers rely on to see what
    // AWS actually said.
    beforeEachEnv();
    try {
      process.env.AWS_MCP_FAKE_SCENARIO = "call_access_denied";
      const r = (await tool.handler({ service: "s3api", operation: "list-buckets", maxItems: 2 })) as {
        ok: boolean;
        error?: string;
        rawBody?: string;
        data?: unknown;
      };
      assert.equal(r.ok, false);
      assert.ok(r.error && r.error.length > 0, "failure must carry an error message");
      // rawBody comes from the CLI's stderr, which carries the AccessDenied text.
      assert.match(r.rawBody ?? "", /AccessDenied|Access Denied/);
      // No data envelope on the failure path.
      assert.equal(r.data, undefined);
    } finally {
      afterEachEnv();
    }
  });
});
