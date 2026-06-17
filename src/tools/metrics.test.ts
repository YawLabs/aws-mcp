import assert from "node:assert/strict";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { _resetSession } from "../session.js";
import { buildMetricDataQueries, metricsTools, pickAutoPeriodSeconds, resolveTime } from "./metrics.js";

const tool = metricsTools.find((t) => t.name === "aws_metrics_query");
if (!tool) throw new Error("metricsTools missing aws_metrics_query");

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AWS = join(__dirname, "..", "testing", "fake-aws.js");

// Tests in this file mutate `process.env.AWS_MCP_FAKE_SCENARIO` and
// `AWS_MCP_FAKE_ARGV_OUT` per-case to steer fake-aws.ts. Two isolation
// layers keep these safe:
//   - WITHIN this file: node:test runs subtests sequentially by default,
//     so before/it/afterEach mutations don't bleed between cases. The
//     afterEach below clears both vars.
//   - ACROSS files: `node --test dist/**/*.test.js` spawns one worker
//     process per test file, so a sibling file mutating the same env vars
//     can't reach into this process. Cross-file isolation is structural,
//     not a fragile coordination contract.
// The matching note in testing/fake-aws.ts documents the constraint on the
// producer side.
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
  delete process.env.AWS_MCP_FAKE_ARGV_OUT;
});

describe("resolveTime", () => {
  const NOW = new Date("2026-05-16T12:00:00Z").getTime();

  it("returns now for 'now'", () => {
    assert.equal(resolveTime("now", NOW)?.toISOString(), "2026-05-16T12:00:00.000Z");
  });

  it("parses relative shorthand: minutes/hours/days/weeks", () => {
    assert.equal(resolveTime("15m", NOW)?.toISOString(), "2026-05-16T11:45:00.000Z");
    assert.equal(resolveTime("2h", NOW)?.toISOString(), "2026-05-16T10:00:00.000Z");
    assert.equal(resolveTime("1d", NOW)?.toISOString(), "2026-05-15T12:00:00.000Z");
    assert.equal(resolveTime("1w", NOW)?.toISOString(), "2026-05-09T12:00:00.000Z");
    assert.equal(resolveTime("30s", NOW)?.toISOString(), "2026-05-16T11:59:30.000Z");
  });

  it("parses ISO 8601 verbatim", () => {
    assert.equal(resolveTime("2026-05-01T00:00:00Z", NOW)?.toISOString(), "2026-05-01T00:00:00.000Z");
  });

  it("returns null on garbage input", () => {
    assert.equal(resolveTime("garbage", NOW), null);
    assert.equal(resolveTime("", NOW), null);
    assert.equal(resolveTime("5x", NOW), null); // unknown unit
    assert.equal(resolveTime("h", NOW), null); // missing number
  });
});

describe("pickAutoPeriodSeconds", () => {
  it("picks 60s for ranges up to 3h", () => {
    const start = new Date("2026-05-16T09:00:00Z").getTime();
    const end = new Date("2026-05-16T12:00:00Z").getTime();
    assert.equal(pickAutoPeriodSeconds(start, end), 60);
  });

  it("picks 300s for ranges up to 24h (exact boundary)", () => {
    // Code uses rangeMs <= PERIOD_24H_MS, so exactly 24h falls in this tier.
    const start = new Date("2026-05-15T12:00:00Z").getTime();
    const end = new Date("2026-05-16T12:00:00Z").getTime();
    assert.equal(pickAutoPeriodSeconds(start, end), 300);
  });

  it("picks 900s for ranges between 24h and 15d", () => {
    const start = new Date("2026-05-01T00:00:00Z").getTime();
    const end = new Date("2026-05-15T00:00:00Z").getTime();
    assert.equal(pickAutoPeriodSeconds(start, end), 900);
  });

  it("picks 3600s for ranges beyond 15d", () => {
    const start = new Date("2026-01-01T00:00:00Z").getTime();
    const end = new Date("2026-05-01T00:00:00Z").getTime();
    assert.equal(pickAutoPeriodSeconds(start, end), 3600);
  });

  it("handles zero/negative ranges as 60s (defensive)", () => {
    const t = new Date("2026-05-16T12:00:00Z").getTime();
    assert.equal(pickAutoPeriodSeconds(t, t), 60);
    assert.equal(pickAutoPeriodSeconds(t, t - 1000), 60);
  });
});

describe("buildMetricDataQueries", () => {
  it("shapes a metric-stat query with defaults (Stat=Average, Period=auto)", () => {
    const out = buildMetricDataQueries(
      [{ id: "cpu", namespace: "AWS/EC2", metricName: "CPUUtilization", dimensions: { InstanceId: "i-abc" } }],
      300,
    );
    assert.deepEqual(out, [
      {
        Id: "cpu",
        MetricStat: {
          Metric: {
            Namespace: "AWS/EC2",
            MetricName: "CPUUtilization",
            Dimensions: [{ Name: "InstanceId", Value: "i-abc" }],
          },
          Period: 300,
          Stat: "Average",
        },
      },
    ]);
  });

  it("honors explicit statistic + period + unit + label + returnData", () => {
    const out = buildMetricDataQueries(
      [
        {
          id: "lat",
          namespace: "AWS/Lambda",
          metricName: "Duration",
          statistic: "p99",
          period: 60,
          unit: "Milliseconds",
          label: "p99 latency",
          returnData: false,
        },
      ],
      300,
    );
    assert.deepEqual(out, [
      {
        Id: "lat",
        Label: "p99 latency",
        ReturnData: false,
        MetricStat: {
          Metric: { Namespace: "AWS/Lambda", MetricName: "Duration" },
          Period: 60,
          Stat: "p99",
          Unit: "Milliseconds",
        },
      },
    ]);
  });

  it("shapes an expression-only query (no MetricStat block)", () => {
    const out = buildMetricDataQueries([{ id: "sum", expression: "SUM([m1, m2])", label: "total" }], 300);
    assert.deepEqual(out, [{ Id: "sum", Label: "total", Expression: "SUM([m1, m2])" }]);
  });

  it("canonicalizes simple stats to PascalCase regardless of input casing", () => {
    // CloudWatch's MetricStat.Stat is case-sensitive on simple stats:
    // 'average' bounces server-side, 'Average' is accepted. The validator
    // accepts case-folded forms; the wire shaper must canonicalize.
    for (const input of ["average", "AVERAGE", "Average"]) {
      const out = buildMetricDataQueries(
        [{ id: "x", namespace: "AWS/EC2", metricName: "CPUUtilization", statistic: input }],
        60,
      );
      assert.equal(out[0].MetricStat?.Stat, "Average", `input '${input}' should canonicalize to 'Average'`);
    }
    const sumOut = buildMetricDataQueries(
      [{ id: "x", namespace: "AWS/EC2", metricName: "CPUUtilization", statistic: "sum" }],
      60,
    );
    assert.equal(sumOut[0].MetricStat?.Stat, "Sum");
  });

  it("canonicalizes extended stats to lowercase regardless of input casing", () => {
    // CloudWatch's MetricStat.Stat is also case-sensitive on extended stats,
    // but in the OPPOSITE direction: 'p99' is accepted, 'P99' bounces. The
    // validator's /i regex accepts both shapes; the wire shaper must lower.
    const cases: Array<[string, string]> = [
      ["P99", "p99"],
      ["P99.9", "p99.9"],
      ["Tm95", "tm95"],
      ["TC90", "tc90"],
      ["WM99", "wm99"],
      ["IQM", "iqm"],
    ];
    for (const [input, expected] of cases) {
      const out = buildMetricDataQueries(
        [{ id: "x", namespace: "AWS/EC2", metricName: "CPUUtilization", statistic: input }],
        60,
      );
      assert.equal(out[0].MetricStat?.Stat, expected, `input '${input}' should canonicalize to '${expected}'`);
    }
  });

  it("omits Dimensions when none are given", () => {
    const out = buildMetricDataQueries([{ id: "x", namespace: "AWS/SQS", metricName: "NumberOfMessagesReceived" }], 60);
    assert.equal((out[0].MetricStat?.Metric as { Dimensions?: unknown }).Dimensions, undefined);
  });

  it("omits Dimensions when q.dimensions is an empty object (was a CloudWatch ValidationError)", () => {
    // Object.entries({}) is [], and [] is truthy. A naive
    // `dimensions ? { Dimensions: dimensions } : {}` would emit
    // `Dimensions: []`, which CloudWatch rejects with a ValidationError.
    // Treat empty the same as undefined.
    const out = buildMetricDataQueries(
      [{ id: "x", namespace: "AWS/SQS", metricName: "NumberOfMessagesReceived", dimensions: {} }],
      60,
    );
    assert.equal((out[0].MetricStat?.Metric as { Dimensions?: unknown }).Dimensions, undefined);
  });
});

describe("aws_metrics_query schema", () => {
  it("accepts a minimal valid input (one metric-stat query)", () => {
    const r = tool.inputSchema.safeParse({
      queries: [{ id: "cpu", namespace: "AWS/EC2", metricName: "CPUUtilization" }],
    });
    assert.equal(r.success, true);
  });

  it("accepts an expression-only query", () => {
    const r = tool.inputSchema.safeParse({
      queries: [{ id: "expr", expression: "SUM([m1, m2])" }],
    });
    assert.equal(r.success, true);
  });

  it("rejects empty queries array", () => {
    const r = tool.inputSchema.safeParse({ queries: [] });
    assert.equal(r.success, false);
  });

  it("rejects more than 100 queries", () => {
    const queries = Array.from({ length: 101 }, (_, i) => ({
      id: `q${i}`,
      namespace: "AWS/EC2",
      metricName: "CPUUtilization",
    }));
    const r = tool.inputSchema.safeParse({ queries });
    assert.equal(r.success, false);
  });

  it("rejects query id that doesn't match /^[a-z][A-Za-z0-9_]*$/", () => {
    for (const id of ["Cpu", "1cpu", "cpu-1", "cpu.utilization"]) {
      const r = tool.inputSchema.safeParse({
        queries: [{ id, namespace: "AWS/EC2", metricName: "CPUUtilization" }],
      });
      assert.equal(r.success, false, `expected id '${id}' to be rejected`);
    }
  });

  it("rejects unknown scanBy value", () => {
    const r = tool.inputSchema.safeParse({
      queries: [{ id: "cpu", namespace: "AWS/EC2", metricName: "CPUUtilization" }],
      scanBy: "wrong",
    });
    assert.equal(r.success, false);
  });
});

describe("aws_metrics_query handler validation", () => {
  it("rejects duplicate query ids", async () => {
    const r = await tool.handler({
      queries: [
        { id: "cpu", namespace: "AWS/EC2", metricName: "CPUUtilization" },
        { id: "cpu", namespace: "AWS/EC2", metricName: "DiskReadOps" },
      ],
    } as never);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Duplicate query id/);
  });

  it("rejects a query that mixes metric-stat fields with expression", async () => {
    const r = await tool.handler({
      queries: [{ id: "bad", namespace: "AWS/EC2", expression: "SUM([m1])" }],
    } as never);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /mixes metric-stat fields/);
  });

  it("rejects a query with neither metric-stat nor expression", async () => {
    const r = await tool.handler({ queries: [{ id: "empty" }] } as never);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /neither metric-stat .* nor 'expression'/);
  });

  it("rejects a metric-stat query missing metricName", async () => {
    const r = await tool.handler({
      queries: [{ id: "partial", namespace: "AWS/EC2" }],
    } as never);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /must include BOTH 'namespace' and 'metricName'/);
  });

  it("rejects an invalid statistic", async () => {
    const r = await tool.handler({
      queries: [{ id: "cpu", namespace: "AWS/EC2", metricName: "CPUUtilization", statistic: "BadStat" }],
    } as never);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /invalid statistic/);
  });

  it("accepts extended percentile statistics (p99, p99.9, tm95)", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "metrics_empty";
    for (const stat of ["p99", "p99.9", "tm95", "tc90", "iqm"]) {
      const r = await tool.handler({
        queries: [{ id: "x", namespace: "AWS/EC2", metricName: "CPUUtilization", statistic: stat }],
      } as never);
      assert.equal(r.ok, true, `expected stat '${stat}' to be accepted`);
    }
  });

  it("rejects iqm with a numeric suffix (CloudWatch only accepts bare 'iqm')", async () => {
    // CloudWatch's IQM (interquartile mean) stat takes no numeric suffix.
    // 'iqm99' and 'iqm0.5' are rejected server-side; the validator must catch
    // them before the wire call so the error is actionable. Pinning this so a
    // future regex refactor that re-admits the suffix doesn't silently regress.
    for (const stat of ["iqm99", "iqm0.5", "iqm1", "IQM99"]) {
      const r = await tool.handler({
        queries: [{ id: "x", namespace: "AWS/EC2", metricName: "CPUUtilization", statistic: stat }],
      } as never);
      assert.equal(r.ok, false, `expected stat '${stat}' to be rejected`);
      assert.match(r.error ?? "", /invalid statistic/);
    }
  });

  it("accepts bare 'iqm' and 'IQM' (case-insensitive, no suffix)", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "metrics_empty";
    for (const stat of ["iqm", "IQM", "Iqm"]) {
      const r = await tool.handler({
        queries: [{ id: "x", namespace: "AWS/EC2", metricName: "CPUUtilization", statistic: stat }],
      } as never);
      assert.equal(r.ok, true, `expected stat '${stat}' to be accepted`);
    }
  });

  it("accepts simple statistics regardless of casing (average, AVERAGE, Average)", async () => {
    // The extended-stat regex is /i, so case-folding the simple list keeps the
    // two paths consistent -- 'average' was previously rejected while 'p99'
    // was accepted.
    process.env.AWS_MCP_FAKE_SCENARIO = "metrics_empty";
    for (const stat of ["average", "AVERAGE", "Average", "sum", "MAXIMUM"]) {
      const r = await tool.handler({
        queries: [{ id: "x", namespace: "AWS/EC2", metricName: "CPUUtilization", statistic: stat }],
      } as never);
      assert.equal(r.ok, true, `expected stat '${stat}' to be accepted`);
    }
  });

  it("echoes the effective profile + region in the response", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "metrics_empty";
    const r = await tool.handler({
      queries: [{ id: "cpu", namespace: "AWS/EC2", metricName: "CPUUtilization" }],
      profile: "prod",
      region: "us-west-2",
    } as never);
    assert.equal(r.ok, true);
    const data = r.data as { profile: string; region: string };
    assert.equal(data.profile, "prod");
    assert.equal(data.region, "us-west-2");
  });

  it("falls back to the session profile/region when no override is passed", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "metrics_empty";
    // No profile/region in the call -- handler resolves via getProfile() /
    // getRegion(). With no session override and no env vars set, these fall
    // back to "default" / "us-east-1" per session.ts.
    const prevProfile = process.env.AWS_PROFILE;
    const prevRegion = process.env.AWS_REGION;
    const prevDefaultRegion = process.env.AWS_DEFAULT_REGION;
    delete process.env.AWS_PROFILE;
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    try {
      const r = await tool.handler({
        queries: [{ id: "cpu", namespace: "AWS/EC2", metricName: "CPUUtilization" }],
      } as never);
      assert.equal(r.ok, true);
      const data = r.data as { profile: string; region: string };
      assert.equal(data.profile, "default");
      assert.equal(data.region, "us-east-1");
    } finally {
      if (prevProfile !== undefined) process.env.AWS_PROFILE = prevProfile;
      if (prevRegion !== undefined) process.env.AWS_REGION = prevRegion;
      if (prevDefaultRegion !== undefined) process.env.AWS_DEFAULT_REGION = prevDefaultRegion;
    }
  });

  it("surfaces nextToken + hasMore=true when CloudWatch truncates", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "metrics_paginated";
    const r = await tool.handler({
      queries: [{ id: "cpu", namespace: "AWS/EC2", metricName: "CPUUtilization" }],
    } as never);
    assert.equal(r.ok, true);
    const data = r.data as { nextToken: string | null; hasMore: boolean; series: Array<{ values: number[] }> };
    assert.equal(data.hasMore, true);
    assert.equal(typeof data.nextToken, "string");
    assert.ok((data.nextToken as string).length > 0);
    assert.equal(data.series[0].values.length, 2);
  });

  it("returns hasMore=false and nextToken=null on the resume call (last page)", async () => {
    // Same scenario, different shape: the fake inspects --cli-input-json for
    // a NextToken and switches behavior. Driving both pages through the same
    // scenario keeps the test self-contained.
    process.env.AWS_MCP_FAKE_SCENARIO = "metrics_paginated";
    const r = await tool.handler({
      queries: [{ id: "cpu", namespace: "AWS/EC2", metricName: "CPUUtilization" }],
      nextToken: "eyJtZXRyaWNzIjoiYWJjIn0=",
    } as never);
    assert.equal(r.ok, true);
    const data = r.data as { nextToken: string | null; hasMore: boolean; series: Array<{ values: number[] }> };
    assert.equal(data.hasMore, false);
    assert.equal(data.nextToken, null);
    assert.equal(data.series[0].values.length, 1);
  });

  it("forwards nextToken as CloudWatch's NextToken in --cli-input-json", async () => {
    const argvOut = join(tmpdir(), `metrics-resume-argv-${process.pid}-${Date.now()}.json`);
    process.env.AWS_MCP_FAKE_SCENARIO = "metrics_echo_argv";
    process.env.AWS_MCP_FAKE_ARGV_OUT = argvOut;
    try {
      const r = await tool.handler({
        queries: [{ id: "cpu", namespace: "AWS/EC2", metricName: "CPUUtilization" }],
        nextToken: "resume-cursor-xyz",
      } as never);
      assert.equal(r.ok, true);
      const argv = JSON.parse(readFileSync(argvOut, "utf-8")) as string[];
      const jsonIdx = argv.indexOf("--cli-input-json");
      assert.notEqual(jsonIdx, -1);
      const payload = JSON.parse(argv[jsonIdx + 1]) as { NextToken?: string };
      assert.equal(payload.NextToken, "resume-cursor-xyz");
    } finally {
      try {
        unlinkSync(argvOut);
      } catch {
        // best-effort
      }
    }
  });

  it("includes both colliding indices in the duplicate-id error", async () => {
    const r = await tool.handler({
      queries: [
        { id: "a", namespace: "AWS/EC2", metricName: "CPUUtilization" },
        { id: "cpu", namespace: "AWS/EC2", metricName: "CPUUtilization" },
        { id: "b", namespace: "AWS/EC2", metricName: "DiskReadOps" },
        { id: "cpu", namespace: "AWS/EC2", metricName: "DiskWriteOps" },
      ],
    } as never);
    assert.equal(r.ok, false);
    // Names BOTH offending indices (the new occurrence and the first one).
    assert.match(r.error ?? "", /queries\[3\]/);
    assert.match(r.error ?? "", /queries\[1\]/);
  });

  it("rejects invalid startTime", async () => {
    const r = await tool.handler({
      queries: [{ id: "cpu", namespace: "AWS/EC2", metricName: "CPUUtilization" }],
      startTime: "garbage",
    } as never);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid startTime/);
  });

  it("rejects when endTime is not after startTime", async () => {
    const r = await tool.handler({
      queries: [{ id: "cpu", namespace: "AWS/EC2", metricName: "CPUUtilization" }],
      startTime: "2026-05-16T12:00:00Z",
      endTime: "2026-05-16T11:00:00Z",
    } as never);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /endTime .* must be after startTime/);
  });

  it("rejects an explicit period that is not a positive multiple of 60", async () => {
    const r = await tool.handler({
      queries: [{ id: "cpu", namespace: "AWS/EC2", metricName: "CPUUtilization", period: 45 }],
    } as never);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /invalid period 45/);
    assert.match(r.error ?? "", /positive multiple of 60/);
  });

  it("rejects an explicit period+range that would exceed CloudWatch's datapoint cap", async () => {
    // 71 days at period=60s -> ceil(6,134,400 / 60) = 102,240 datapoints,
    // over the ~100,800 per-request ceiling.
    const r = await tool.handler({
      queries: [{ id: "cpu", namespace: "AWS/EC2", metricName: "CPUUtilization", period: 60 }],
      startTime: "2026-01-01T00:00:00Z",
      endTime: "2026-03-13T00:00:00Z",
    } as never);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /exceeding CloudWatch's per-request cap/);
    assert.match(r.error ?? "", /Widen the period or narrow the time range/);
  });

  it("accepts a valid explicit period (multiple of 60, under the datapoint cap)", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "metrics_empty";
    const r = await tool.handler({
      queries: [{ id: "cpu", namespace: "AWS/EC2", metricName: "CPUUtilization", period: 300 }],
      startTime: "1h",
    } as never);
    assert.equal(r.ok, true);
  });
});

describe("aws_metrics_query handler (fake-aws integration)", () => {
  it("returns shaped series for a successful query", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "metrics_success";
    const r = await tool.handler({
      queries: [
        { id: "cpu", namespace: "AWS/EC2", metricName: "CPUUtilization", dimensions: { InstanceId: "i-abc" } },
        { id: "expr", expression: "cpu * 2", label: "cpu_x2" },
      ],
      startTime: "1h",
    } as never);
    assert.equal(r.ok, true);
    const data = r.data as {
      command: string;
      startTime: string;
      endTime: string;
      periodSeconds: number;
      series: Array<{ id: string; label?: string; timestamps: string[]; values: number[]; statusCode?: string }>;
    };
    assert.equal(data.periodSeconds, 60); // 1h range -> 60s
    assert.equal(data.series.length, 2);
    assert.equal(data.series[0].id, "cpu");
    assert.equal(data.series[0].label, "CPUUtilization");
    assert.deepEqual(data.series[0].values, [42.5, 38.1, 35.7]);
    assert.equal(data.series[0].statusCode, "Complete");
    assert.equal(data.series[1].id, "expr");
  });

  it("echoes each query's effective period (explicit per-query period, not just the top-level auto-pick)", async () => {
    // cpu carries an explicit period that differs from the 1h auto-pick (60s);
    // expr is an expression with no period. The fake returns series ids cpu+expr.
    process.env.AWS_MCP_FAKE_SCENARIO = "metrics_success";
    const r = await tool.handler({
      queries: [
        { id: "cpu", namespace: "AWS/EC2", metricName: "CPUUtilization", period: 300 },
        { id: "expr", expression: "cpu * 2", label: "cpu_x2" },
      ],
      startTime: "1h",
    } as never);
    assert.equal(r.ok, true);
    const data = r.data as { periodSeconds: number; series: Array<{ id: string; period?: number }> };
    assert.equal(data.periodSeconds, 60); // top-level stays the auto-pick
    assert.equal(data.series[0].id, "cpu");
    assert.equal(data.series[0].period, 300); // explicit period echoed, not the 60s auto-pick
    assert.equal(data.series[1].id, "expr");
    assert.equal(data.series[1].period, undefined); // expression, no period sent -> omitted
  });

  it("inherits the auto-picked period for a metric-stat query that omits one", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "metrics_success";
    const r = await tool.handler({
      queries: [
        { id: "cpu", namespace: "AWS/EC2", metricName: "CPUUtilization" },
        { id: "expr", expression: "cpu * 2", label: "cpu_x2" },
      ],
      startTime: "1h",
    } as never);
    assert.equal(r.ok, true);
    const data = r.data as { periodSeconds: number; series: Array<{ period?: number }> };
    assert.equal(data.series[0].period, data.periodSeconds); // metric-stat inherits the auto-pick (60s)
    assert.equal(data.series[1].period, undefined); // expression still omits
  });

  it("echoes an expression query's EXPLICIT period (not omitted, not the auto-pick)", async () => {
    // An expression query can carry a period -- buildMetricDataQueries sends it
    // as base.Period -- so the per-series period must reflect it. This is the
    // branch the other two tests miss: expression WITH a period (q?.period fires
    // for an expression query, distinct from expression-without-period which is
    // omitted). The fake returns series ids cpu+expr regardless of input.
    process.env.AWS_MCP_FAKE_SCENARIO = "metrics_success";
    const r = await tool.handler({
      queries: [
        { id: "cpu", namespace: "AWS/EC2", metricName: "CPUUtilization" },
        { id: "expr", expression: "cpu * 2", period: 300, label: "cpu_x2" },
      ],
      startTime: "1h",
    } as never);
    assert.equal(r.ok, true);
    const data = r.data as { periodSeconds: number; series: Array<{ id: string; period?: number }> };
    assert.equal(data.periodSeconds, 60); // top-level stays the 1h auto-pick
    const expr = data.series.find((s) => s.id === "expr");
    assert.equal(expr?.period, 300); // explicit period on the expression query is echoed, not omitted
    const cpu = data.series.find((s) => s.id === "cpu");
    assert.equal(cpu?.period, 60); // metric-stat without a period still inherits the auto-pick
  });

  it("returns empty series + empty values when no datapoints exist", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "metrics_empty";
    const r = await tool.handler({
      queries: [{ id: "cpu", namespace: "AWS/EC2", metricName: "CPUUtilization" }],
    } as never);
    assert.equal(r.ok, true);
    const data = r.data as { series: Array<{ values: number[] }>; messages?: unknown };
    assert.equal(data.series.length, 1);
    assert.deepEqual(data.series[0].values, []);
    // Empty Messages -> we omit the field entirely from the response.
    assert.equal(data.messages, undefined);
  });

  it("surfaces messages when CloudWatch reports PartialData", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "metrics_partial_data";
    const r = await tool.handler({
      queries: [{ id: "cpu", namespace: "AWS/EC2", metricName: "CPUUtilization" }],
    } as never);
    assert.equal(r.ok, true);
    const data = r.data as {
      series: Array<{ statusCode?: string }>;
      messages?: Array<{ code?: string; value?: string }>;
    };
    assert.equal(data.series[0].statusCode, "PartialData");
    assert.ok(data.messages, "messages should be present when CloudWatch returned warnings");
    assert.equal(data.messages?.[0]?.code, "MaxMetricsExceeded");
  });

  it("surfaces an error envelope on a ValidationError from CloudWatch", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "metrics_bad_metric";
    const r = await tool.handler({
      queries: [{ id: "cpu", namespace: "AWS/EC2", metricName: "CPUUtilization" }],
    } as never);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /ValidationError/);
  });

  it("sends MetricDataQueries via --cli-input-json with PascalCase keys", async () => {
    // Verify the wire shape: the agent's flat input gets transformed to the
    // nested PascalCase CloudWatch expects, and lands inside a single
    // --cli-input-json argv entry (no per-field flags that could leak shell-
    // metacharacters from values).
    const argvOut = join(tmpdir(), `metrics-argv-${process.pid}-${Date.now()}.json`);
    process.env.AWS_MCP_FAKE_SCENARIO = "metrics_echo_argv";
    process.env.AWS_MCP_FAKE_ARGV_OUT = argvOut;
    try {
      const r = await tool.handler({
        queries: [
          { id: "cpu", namespace: "AWS/EC2", metricName: "CPUUtilization", dimensions: { InstanceId: "i-abc" } },
        ],
        startTime: "1h",
      } as never);
      assert.equal(r.ok, true);

      const argv = JSON.parse(readFileSync(argvOut, "utf-8")) as string[];
      const jsonIdx = argv.indexOf("--cli-input-json");
      assert.notEqual(jsonIdx, -1, "expected --cli-input-json in argv");
      const payload = JSON.parse(argv[jsonIdx + 1]) as {
        MetricDataQueries: Array<{
          Id: string;
          MetricStat: {
            Metric: { Namespace: string; MetricName: string; Dimensions: Array<{ Name: string; Value: string }> };
            Period: number;
            Stat: string;
          };
        }>;
        StartTime: string;
        EndTime: string;
        ScanBy: string;
      };
      assert.equal(payload.MetricDataQueries.length, 1);
      assert.equal(payload.MetricDataQueries[0].Id, "cpu");
      assert.equal(payload.MetricDataQueries[0].MetricStat.Metric.Namespace, "AWS/EC2");
      assert.equal(payload.MetricDataQueries[0].MetricStat.Metric.MetricName, "CPUUtilization");
      assert.deepEqual(payload.MetricDataQueries[0].MetricStat.Metric.Dimensions, [
        { Name: "InstanceId", Value: "i-abc" },
      ]);
      assert.equal(payload.MetricDataQueries[0].MetricStat.Stat, "Average"); // default
      assert.equal(payload.MetricDataQueries[0].MetricStat.Period, 60); // auto-picked for 1h
      assert.equal(payload.ScanBy, "TimestampDescending"); // default
      // Times should be valid ISO 8601.
      assert.ok(!Number.isNaN(new Date(payload.StartTime).getTime()));
      assert.ok(!Number.isNaN(new Date(payload.EndTime).getTime()));
    } finally {
      try {
        unlinkSync(argvOut);
      } catch {
        // best-effort
      }
    }
  });
});
