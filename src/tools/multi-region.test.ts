import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { _resetSession } from "../session.js";
import { multiRegionTools, runWithConcurrency } from "./multi-region.js";

const tool = multiRegionTools.find((t) => t.name === "aws_multi_region");
if (!tool) throw new Error("multiRegionTools missing aws_multi_region");

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AWS = join(__dirname, "..", "testing", "fake-aws.js");

// The handler calls runAwsCall directly; route those subprocess spawns at
// the fake aws shim via the documented test env-var hook (see aws-cli.ts).
// Without this the handler shells to the real aws binary, which the test
// environment doesn't have configured.
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
});

describe("aws_multi_region schema", () => {
  it("accepts a minimal call with two regions", () => {
    const r = tool.inputSchema.safeParse({
      service: "s3api",
      operation: "list-buckets",
      regions: ["us-east-1", "us-west-2"],
    });
    assert.equal(r.success, true);
  });

  it("rejects empty regions array", () => {
    const r = tool.inputSchema.safeParse({ service: "s3api", operation: "list-buckets", regions: [] });
    assert.equal(r.success, false);
  });

  it("rejects more than 32 regions", () => {
    const regions = Array.from({ length: 33 }, (_, i) => `us-east-${i + 1}`);
    const r = tool.inputSchema.safeParse({ service: "s3api", operation: "list-buckets", regions });
    assert.equal(r.success, false);
  });

  it("rejects out-of-range concurrency", () => {
    assert.equal(
      tool.inputSchema.safeParse({
        service: "s3api",
        operation: "list-buckets",
        regions: ["us-east-1"],
        concurrency: 100,
      }).success,
      false,
    );
  });
});

describe("runWithConcurrency", () => {
  it("preserves input order in results", async () => {
    const inputs = [1, 2, 3, 4, 5];
    const r = await runWithConcurrency(inputs, 2, async (n) => n * 10);
    assert.deepEqual(r, [10, 20, 30, 40, 50]);
  });

  it("caps in-flight tasks at the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const r = await runWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return n;
    });
    assert.deepEqual(r, [1, 2, 3, 4, 5, 6]);
    assert.equal(peak, 2);
  });

  it("returns empty array for empty input without spinning workers", async () => {
    const r = await runWithConcurrency([], 4, async () => "x");
    assert.deepEqual(r, []);
  });
});

describe("aws_multi_region handler", () => {
  it("invalid region IDs fail per-region and don't poison the batch", async () => {
    const result = await tool.handler({
      service: "s3api",
      operation: "list-buckets",
      regions: ["us-east-1", "--profile-evil", "us-west-2"],
    } as never);
    assert.equal(result.ok, true);
    const data = result.data as {
      regionCount: number;
      okCount: number;
      errorCount: number;
      results: { region: string; ok: boolean; errorKind?: string }[];
    };
    assert.equal(data.regionCount, 3);
    const evil = data.results.find((r) => r.region === "--profile-evil");
    assert.ok(evil);
    assert.equal(evil.ok, false);
    assert.equal(evil.errorKind, "bad_input");
  });

  it("propagates per-region runAwsCall failures through the result envelope (partial failure)", async () => {
    // End-to-end: the handler invokes runAwsCall per region. The
    // mr_partial_failure scenario routes us-west-2 to sso_expired and any
    // other region to a successful JSON payload. The result envelope must
    // surface okCount=1, errorCount=1, and each entry's {region, ok,
    // errorKind?, error?, command} shape -- the "partial failure is
    // expected and surfaced" contract the tool's docstring leans on.
    const prevScenario = process.env.AWS_MCP_FAKE_SCENARIO;
    process.env.AWS_MCP_FAKE_SCENARIO = "mr_partial_failure";
    try {
      const result = await tool.handler({
        service: "s3api",
        operation: "list-buckets",
        regions: ["us-east-1", "us-west-2"],
      } as never);
      assert.equal(result.ok, true);
      const data = result.data as {
        regionCount: number;
        okCount: number;
        errorCount: number;
        results: {
          region: string;
          ok: boolean;
          data?: unknown;
          command?: string;
          error?: string;
          errorKind?: string;
        }[];
      };
      assert.equal(data.regionCount, 2);
      assert.equal(data.okCount, 1);
      assert.equal(data.errorCount, 1);

      const east = data.results.find((r) => r.region === "us-east-1");
      const west = data.results.find((r) => r.region === "us-west-2");
      assert.ok(east, "us-east-1 entry missing");
      assert.ok(west, "us-west-2 entry missing");

      // Success entry: ok=true, data carries the parsed JSON, command is set,
      // error/errorKind absent.
      assert.equal(east.ok, true);
      assert.ok(east.command && east.command.length > 0, "success entry must carry command");
      const eastData = east.data as { Buckets: { Name: string }[] };
      assert.equal(eastData.Buckets[0].Name, "bucket-us-east-1");
      assert.equal(east.error, undefined);
      assert.equal(east.errorKind, undefined);

      // Failure entry: ok=false, errorKind=sso_expired, error message present,
      // command surfaced so the caller can see what was attempted.
      assert.equal(west.ok, false);
      assert.equal(west.errorKind, "sso_expired");
      assert.ok(west.error && west.error.length > 0, "failure entry must carry an error message");
      assert.ok(west.command && west.command.length > 0, "failure entry must surface the command attempted");
      assert.equal(west.data, undefined);
    } finally {
      if (prevScenario === undefined) delete process.env.AWS_MCP_FAKE_SCENARIO;
      else process.env.AWS_MCP_FAKE_SCENARIO = prevScenario;
    }
  });

  it("dedupes repeated regions before dispatching", async () => {
    const result = await tool.handler({
      service: "s3api",
      operation: "list-buckets",
      regions: ["us-east-1", "us-east-1", "us-west-2"],
    } as never);
    assert.equal(result.ok, true);
    const data = result.data as { regionCount: number; results: { region: string }[] };
    assert.equal(data.regionCount, 2);
    assert.deepEqual(
      data.results.map((r) => r.region),
      ["us-east-1", "us-west-2"],
    );
  });
});
