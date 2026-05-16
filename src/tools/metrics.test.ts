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

  it("picks 300s for ranges between 3h and 24h", () => {
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

  it("omits Dimensions when none are given", () => {
    const out = buildMetricDataQueries([{ id: "x", namespace: "AWS/SQS", metricName: "NumberOfMessagesReceived" }], 60);
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
