import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { _resetSession } from "../session.js";
import { capAggregateResults, multiRegionTools, type RegionResult, runWithConcurrency } from "./multi-region.js";
import type { ToolContext } from "./tool.js";

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

  it("places each result at its INPUT index even when completion order differs from dispatch order", async () => {
    // Guards the indexed assignment `results[i] = ...` against a refactor to
    // `results.push(...)`. With concurrency high enough to run everything in
    // parallel and DECREASING per-task delays, the tasks complete in REVERSE
    // dispatch order: input[0] sleeps longest and finishes LAST, input[4]
    // sleeps shortest and finishes FIRST. A `.push()` implementation would
    // produce results ordered by completion (reverse), so the assertion below
    // would see the wrong values at each index. Indexed assignment keeps the
    // result aligned to the input position regardless of timing.
    const inputs = [0, 1, 2, 3, 4];
    const completionOrder: number[] = [];
    const r = await runWithConcurrency(inputs, inputs.length, async (n, index) => {
      // Earlier inputs wait longer: index 0 -> 50ms, index 4 -> 10ms.
      await new Promise((resolve) => setTimeout(resolve, (inputs.length - index) * 10));
      completionOrder.push(n);
      return `result-for-${n}`;
    });
    // Results align to INPUT order, not completion order.
    assert.deepEqual(r, ["result-for-0", "result-for-1", "result-for-2", "result-for-3", "result-for-4"]);
    // Sanity: completion order really did differ from dispatch order (reverse),
    // so the assertion above genuinely exercises out-of-order completion rather
    // than coincidentally-ordered timing.
    assert.deepEqual(completionOrder, [4, 3, 2, 1, 0]);
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

  it("catches synchronous throws from runAwsCall when input bypasses Zod (aws_script bridge case)", async () => {
    // The aws_script bridge (script.ts) unwraps and re-dispatches without
    // Zod re-validation, so a script can hand the handler an input shape
    // that Zod would have rejected -- e.g. `operation` missing entirely.
    // runAwsCall does `opts.operation.trim()` before its bad-input check,
    // which throws synchronously when operation is undefined. Without the
    // per-task try/catch in the region worker, that rejection escapes
    // Promise.all and the whole multi_region call rejects instead of
    // returning a per-region result array. With the catch, each region
    // surfaces ok:false, errorKind:'unexpected'.
    const result = await tool.handler({
      service: "s3api",
      // operation deliberately omitted -- mirrors aws_script bypassing Zod
      regions: ["us-east-1", "us-west-2"],
    } as never);
    assert.equal(result.ok, true);
    const data = result.data as {
      regionCount: number;
      okCount: number;
      errorCount: number;
      results: { region: string; ok: boolean; error?: string; errorKind?: string }[];
    };
    assert.equal(data.regionCount, 2);
    assert.equal(data.okCount, 0);
    assert.equal(data.errorCount, 2);
    for (const r of data.results) {
      assert.equal(r.ok, false);
      assert.equal(r.errorKind, "unexpected");
      assert.ok(r.error && r.error.length > 0, `region ${r.region} must carry an error message`);
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

describe("aws_multi_region input bounds (regression)", () => {
  // These bounds live in the Zod schema, which only runs at the MCP boundary
  // (index.ts registers via inputSchema.shape). Handlers reached directly --
  // the aws_script bridge, tests, internal callers -- never saw them. A
  // concurrency of 0 made runWithConcurrency spawn zero workers, so
  // Promise.all([]) resolved instantly and every slot of `results` stayed a
  // hole: the caller got ok:true plus a full-length array of nulls, having run
  // nothing at all.
  for (const concurrency of [0, -1, Number.NaN]) {
    it(`clamps a concurrency of ${String(concurrency)} instead of running nothing`, async () => {
      // The handler spawns real subprocesses, so point them at the fake-aws
      // shim -- same save/restore shape the partial-failure test above uses.
      const prevScenario = process.env.AWS_MCP_FAKE_SCENARIO;
      process.env.AWS_MCP_FAKE_SCENARIO = "call_json_success";
      try {
        const res = await tool.handler({
          service: "s3api",
          operation: "list-buckets",
          regions: ["us-east-1", "us-west-2"],
          profile: "default",
          concurrency,
        });
        assert.equal(res.ok, true);
        const data = res.data as { okCount: number; errorCount: number; results: Array<{ region: string } | null> };
        assert.ok(
          data.results.every((r) => r !== null),
          "every result slot must be filled, not a hole",
        );
        assert.equal(data.okCount, 2);
        assert.equal(data.errorCount, 0);
      } finally {
        if (prevScenario === undefined) delete process.env.AWS_MCP_FAKE_SCENARIO;
        else process.env.AWS_MCP_FAKE_SCENARIO = prevScenario;
      }
    });
  }

  it("rejects more regions than MAX_REGIONS rather than truncating", async () => {
    const regions = Array.from({ length: 40 }, (_, n) => `us-east-${n + 1}`);
    const res = await tool.handler({
      service: "s3api",
      operation: "list-buckets",
      regions,
      profile: "default",
    });
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /Too many regions: 40 requested, max 32/);
  });

  it("counts the RAW list, not the deduped one, so it agrees with the schema", async () => {
    // 40 entries, 10 of them duplicates -> 30 distinct. The schema's
    // .max(32) applies to the raw array and rejects this, so the handler must
    // too; counting distinct regions here would make the same call succeed via
    // a direct handler invocation and fail through the MCP boundary.
    const regions = [
      ...Array.from({ length: 30 }, (_, n) => `us-east-${n + 1}`),
      ...Array.from({ length: 10 }, (_, n) => `us-east-${n + 1}`),
    ];
    assert.equal(regions.length, 40);
    assert.equal(new Set(regions).size, 30);
    assert.equal(
      tool.inputSchema.safeParse({ service: "s3api", operation: "list-buckets", regions }).success,
      false,
      "precondition: the schema rejects this raw list",
    );
    const res = await tool.handler({ service: "s3api", operation: "list-buckets", regions, profile: "default" });
    assert.equal(res.ok, false, "handler must agree with the schema");
    assert.match(res.error ?? "", /Too many regions: 40 requested, max 32/);
  });
});

describe("capAggregateResults -- aggregate response budget", () => {
  // Per-CALL output is capped in aws-cli.ts (5MB of stdout kills the
  // subprocess), but the BATCH had no ceiling: 32 regions x 5MB each is 160MB
  // held in `results` and serialized into one MCP response.
  const bigData = { blob: "x".repeat(4096) };
  const okEntry = (region: string): RegionResult => ({ region, ok: true, command: `aws s3api ...`, data: bigData });

  it("leaves a batch under the budget untouched", () => {
    const input = [okEntry("us-east-1"), okEntry("us-west-2")];
    const out = capAggregateResults(input, 1_000_000, (r) => r.region);
    assert.deepEqual(out.truncatedIds, []);
    assert.deepEqual(out.results, input);
  });

  it("drops data from the entries past the budget and names them", () => {
    const input = Array.from({ length: 8 }, (_, n) => okEntry(`us-east-${n + 1}`));
    // Room for roughly the first two entries.
    const out = capAggregateResults(input, 9_000, (r) => r.region);
    assert.ok(out.truncatedIds.length > 0, "some entries must be trimmed");
    assert.ok(out.truncatedIds.length < input.length, "the early entries must survive intact");
    assert.equal(out.results[0].data, bigData, "the first entry keeps its payload");
    for (const r of out.results) {
      if (out.truncatedIds.includes(r.region)) {
        assert.equal(r.data, undefined, `${r.region} must lose its data`);
        assert.equal(r.truncated, true, `${r.region} must be flagged truncated`);
        assert.equal(r.ok, true, "truncation must not restate a successful call as a failure");
        assert.equal(r.command, "aws s3api ...", "the command attempted is still surfaced");
      } else {
        assert.equal(r.truncated, undefined);
      }
    }
    const total = Buffer.byteLength(JSON.stringify(out.results), "utf8");
    assert.ok(total <= 9_000 + 512, `capped payload should be near the budget, got ${total}`);
  });

  it("keeps an entry that lands EXACTLY on the budget, and drops it one byte short", () => {
    // The keep test is `used + size <= maxBytes`. The cases above clear or blow
    // the budget by a wide margin, so flipping that to `<` (or the budget to
    // `used + size < maxBytes`) passes them all while silently dropping a
    // payload that fit perfectly. Compute the exact fit and pin both sides.
    const a = okEntry("us-east-1");
    const b = okEntry("us-west-2");
    const exactFit = Buffer.byteLength(JSON.stringify(a), "utf8") + Buffer.byteLength(JSON.stringify(b), "utf8");

    const fits = capAggregateResults([a, b], exactFit, (r) => r.region);
    assert.deepEqual(fits.truncatedIds, [], "an exact fit must not truncate anything");
    assert.equal(fits.results[0].data, bigData);
    assert.equal(fits.results[1].data, bigData, "the entry landing exactly on the budget must keep its payload");
    assert.equal(fits.results[1].truncated, undefined);

    const oneByteShort = capAggregateResults([a, b], exactFit - 1, (r) => r.region);
    assert.deepEqual(oneByteShort.truncatedIds, ["us-west-2"], "one byte short drops exactly the last entry");
    assert.equal(oneByteShort.results[0].data, bigData, "the first entry still fits");
    assert.equal(oneByteShort.results[1].data, undefined);
    assert.equal(oneByteShort.results[1].truncated, true);
  });

  it("never drops an error entry -- losing the reason a region failed is worse than the bytes", () => {
    const input: RegionResult[] = [
      okEntry("us-east-1"),
      okEntry("us-east-2"),
      { region: "eu-west-1", ok: false, error: "SSO session expired", errorKind: "sso_expired" },
    ];
    const out = capAggregateResults(input, 1, (r) => r.region);
    const err = out.results.find((r) => r.region === "eu-west-1");
    assert.equal(err?.error, "SSO session expired");
    assert.equal(err?.errorKind, "sso_expired");
    assert.equal(err?.truncated, undefined);
    assert.deepEqual(out.truncatedIds, ["us-east-1", "us-east-2"]);
  });
});

describe("runWithConcurrency contract (regression)", () => {
  it("names the offending index when fn rejects", async () => {
    await assert.rejects(
      () =>
        runWithConcurrency([1, 2, 3], 1, async (n) => {
          if (n === 2) throw new Error("boom");
          return n;
        }),
      /task at index 1 rejected, but fn must always resolve/,
    );
  });

  it("preserves the original error as `cause`", async () => {
    const original = new Error("boom");
    await assert.rejects(
      () =>
        runWithConcurrency([1], 1, async () => {
          throw original;
        }),
      (err: Error) => {
        assert.equal((err as Error & { cause?: unknown }).cause, original);
        return true;
      },
    );
  });

  it("floors a non-positive concurrency at 1 instead of returning holes", async () => {
    const r = await runWithConcurrency([1, 2, 3], 0, async (n) => n * 10);
    assert.deepEqual(r, [10, 20, 30]);
  });
});

describe("aws_multi_region aggregate cap -- end-to-end envelope", () => {
  it("flags truncated/truncatedRegions/maxTotalResultBytes and still counts what the CALLS did", async () => {
    // capAggregateResults is unit-tested with a hand-built budget; the handler's
    // own wiring -- the real 5 MB constant, the top-level envelope, and the
    // ordering of the okCount/errorCount tally against the cap -- was not.
    //
    // obs2_mr_big_payload emits ~2.75 MB per successful region (under the 5 MB
    // per-CALL stdout cap) and fails us-west-2 with an expired SSO token. Three
    // regions in dedup'd input order: us-east-1 fits, the error entry is small
    // and never dropped, and eu-west-1 pushes the aggregate past 5 MB.
    const prevScenario = process.env.AWS_MCP_FAKE_SCENARIO;
    process.env.AWS_MCP_FAKE_SCENARIO = "obs2_mr_big_payload";
    try {
      const res = await tool.handler({
        service: "s3api",
        operation: "list-buckets",
        regions: ["us-east-1", "us-west-2", "eu-west-1"],
        profile: "default",
      } as never);
      assert.equal(res.ok, true);
      const data = res.data as {
        regionCount: number;
        okCount: number;
        errorCount: number;
        truncated?: boolean;
        truncatedRegions?: string[];
        maxTotalResultBytes?: number;
        results: { region: string; ok: boolean; data?: unknown; error?: string; truncated?: boolean }[];
      };

      assert.equal(data.truncated, true, "the envelope must tell the caller the batch was capped");
      assert.deepEqual(data.truncatedRegions, ["eu-west-1"], "only the region past the budget loses its data");
      assert.equal(data.maxTotalResultBytes, 5 * 1024 * 1024, "the envelope names the budget that was applied");

      // The counts describe the CALLS, not the survivors: eu-west-1's call
      // succeeded and is still counted ok even though its payload was dropped.
      assert.equal(data.regionCount, 3);
      assert.equal(data.okCount, 2, "a truncated-but-successful call still counts as ok");
      assert.equal(data.errorCount, 1);

      const east = data.results.find((r) => r.region === "us-east-1");
      assert.ok(east?.data, "the first region's payload fits and is kept");
      const west = data.results.find((r) => r.region === "us-west-2");
      assert.equal(west?.ok, false);
      assert.equal(west?.truncated, undefined, "an error entry is never truncated");
      assert.ok(west?.error && west.error.length > 0, "the failure reason survives the cap");
      const eu = data.results.find((r) => r.region === "eu-west-1");
      assert.equal(eu?.ok, true, "truncation must not restate a successful call as a failure");
      assert.equal(eu?.truncated, true);
      assert.equal(eu?.data, undefined, "the over-budget payload is dropped, not string-truncated");
    } finally {
      if (prevScenario === undefined) delete process.env.AWS_MCP_FAKE_SCENARIO;
      else process.env.AWS_MCP_FAKE_SCENARIO = prevScenario;
    }
  });
});

describe("aws_multi_region -- progress reporting", () => {
  // Fanning out across up to 32 regions is the second-longest wait this server
  // imposes, and unlike the CCAPI poll loop it has a REAL denominator: the
  // deduped region list. So these reports carry (completed, total).
  interface ProgressCall {
    progress: number;
    total?: number;
    message?: string;
  }
  const recordingCtx = (): { ctx: ToolContext; calls: ProgressCall[] } => {
    const calls: ProgressCall[] = [];
    return {
      ctx: {
        reportProgress: (progress, total, message) => {
          calls.push({ progress, total, message });
        },
      },
      calls,
    };
  };
  const withScenario = async (scenario: string, fn: () => Promise<void>): Promise<void> => {
    const prev = process.env.AWS_MCP_FAKE_SCENARIO;
    process.env.AWS_MCP_FAKE_SCENARIO = scenario;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.AWS_MCP_FAKE_SCENARIO;
      else process.env.AWS_MCP_FAKE_SCENARIO = prev;
    }
  };

  it("reports one update per region, monotonically, with the region count as total", async () => {
    await withScenario("call_json_success", async () => {
      const { ctx, calls } = recordingCtx();
      const regions = ["us-east-1", "us-west-2", "eu-west-1"];
      const res = await tool.handler({ service: "s3api", operation: "list-buckets", regions, profile: "default" }, ctx);

      assert.equal(res.ok, true);
      assert.equal(calls.length, 3, "one report per region");
      assert.deepEqual(
        calls.map((c) => c.progress),
        [1, 2, 3],
        "the completion counter is the progress value",
      );
      for (let n = 1; n < calls.length; n++) {
        assert.ok(calls[n].progress > calls[n - 1].progress, "progress must increase monotonically");
      }
      for (const c of calls) {
        assert.equal(c.total, 3, "the denominator IS known here -- the deduped region count");
      }
      // Each report names the region that settled; across the batch that is
      // every region, in whatever order they finished.
      const named = regions.filter((r) => calls.some((c) => (c.message ?? "").startsWith(`${r}:`)));
      assert.deepEqual(named.sort(), [...regions].sort(), "every region is named in exactly one message");
    });
  });

  it("reports on COMPLETION, not dispatch -- each message carries the region's settled outcome", async () => {
    // The real proof that the report fires after the region settles: the
    // ok/failed label is unknowable at dispatch time. mr_partial_failure fails
    // us-west-2 (expired SSO) and succeeds everywhere else, so a
    // dispatch-time report could not produce these two different labels.
    await withScenario("mr_partial_failure", async () => {
      const { ctx, calls } = recordingCtx();
      const res = await tool.handler(
        { service: "s3api", operation: "list-buckets", regions: ["us-east-1", "us-west-2"], profile: "default" },
        ctx,
      );

      assert.equal(res.ok, true);
      const data = res.data as { okCount: number; errorCount: number };
      assert.equal(data.okCount, 1);
      assert.equal(data.errorCount, 1);

      assert.equal(calls.length, 2);
      const east = calls.find((c) => (c.message ?? "").startsWith("us-east-1:"));
      const west = calls.find((c) => (c.message ?? "").startsWith("us-west-2:"));
      assert.match(east?.message ?? "", /us-east-1: ok/, "the successful region is reported as ok");
      assert.match(west?.message ?? "", /us-west-2: failed/, "the failed region is reported as failed");
      // The counter never runs ahead of what has settled: the last report is
      // the total, and no report exceeds it.
      assert.equal(Math.max(...calls.map((c) => c.progress)), 2);
      for (const c of calls) {
        assert.ok(c.progress <= (c.total ?? 0), "completed can never exceed total");
      }
    });
  });

  it("uses the DEDUPED region count as the denominator", async () => {
    // regionCount in the envelope is the deduped count, and the progress total
    // has to agree with it -- otherwise a caller who repeated a region watches
    // a bar that stops short of its own total.
    await withScenario("call_json_success", async () => {
      const { ctx, calls } = recordingCtx();
      const res = await tool.handler(
        {
          service: "s3api",
          operation: "list-buckets",
          regions: ["us-east-1", "us-east-1", "us-west-2"],
          profile: "default",
        },
        ctx,
      );

      const data = res.data as { regionCount: number };
      assert.equal(data.regionCount, 2);
      assert.equal(calls.length, 2, "the duplicate is collapsed before dispatch, so it never reports");
      for (const c of calls) {
        assert.equal(c.total, 2, "total tracks regionCount, not the raw input length");
      }
      assert.equal(calls[calls.length - 1].progress, 2, "the run ends exactly on the total");
    });
  });

  it("a no-op ctx (the no-progressToken path) changes nothing about the result", async () => {
    await withScenario("call_json_success", async () => {
      const input = {
        service: "s3api",
        operation: "list-buckets",
        regions: ["us-east-1", "us-west-2"],
        profile: "default",
      };
      const reported = await tool.handler(input, { reportProgress: () => {} });
      const bare = await tool.handler(input);

      assert.equal(reported.ok, true);
      assert.deepEqual(reported.data, bare.data, "the envelope must not depend on whether progress was reported");
    });
  });

  it("a throwing reportProgress cannot abandon the batch", async () => {
    // runWithConcurrency's contract is that `fn` MUST resolve: a rejection
    // fails the whole Promise.all and abandons every other in-flight region.
    // Progress is advisory, so a client-side notification failure must never
    // cost the caller their results.
    await withScenario("call_json_success", async () => {
      const res = await tool.handler(
        { service: "s3api", operation: "list-buckets", regions: ["us-east-1", "us-west-2"], profile: "default" },
        {
          reportProgress: () => {
            throw new Error("transport exploded");
          },
        },
      );

      assert.equal(res.ok, true);
      const data = res.data as { okCount: number; results: unknown[] };
      assert.equal(data.okCount, 2, "every region still ran and reported its result");
      assert.equal(data.results.length, 2);
    });
  });
});
