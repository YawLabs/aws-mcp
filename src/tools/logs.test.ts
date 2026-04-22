import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LOG_GROUP_RE, logsTools, parseLogsJsonOutput } from "./logs.js";

const tool = logsTools.find((t) => t.name === "aws_logs_tail");
if (!tool) throw new Error("logsTools missing aws_logs_tail");

describe("LOG_GROUP_RE", () => {
  it("accepts common log group shapes", () => {
    for (const name of [
      "/aws/lambda/my-fn",
      "/aws/ecs/my-service",
      "/aws/apigateway/welcome",
      "my-custom-group",
      "app/service/v2",
      "group_with_underscores",
      "/aws/codebuild/project#1",
    ]) {
      assert.match(name, LOG_GROUP_RE, `expected ${name} to match`);
    }
  });

  it("rejects leading hyphen (argv-injection defense)", () => {
    assert.doesNotMatch("-force", LOG_GROUP_RE);
    assert.doesNotMatch("--profile", LOG_GROUP_RE);
  });

  it("rejects shell-meaningful characters", () => {
    assert.doesNotMatch("/aws/lambda/foo;rm", LOG_GROUP_RE);
    assert.doesNotMatch("/aws/lambda/$(echo)", LOG_GROUP_RE);
    assert.doesNotMatch("/aws/lambda/foo bar", LOG_GROUP_RE);
  });

  it("rejects empty string", () => {
    assert.doesNotMatch("", LOG_GROUP_RE);
  });
});

describe("parseLogsJsonOutput", () => {
  it("splits NDJSON into an array of events", () => {
    const raw =
      '{"timestamp":"2026-04-21T00:00:00Z","message":"hello"}\n{"timestamp":"2026-04-21T00:00:01Z","message":"world"}\n';
    const parsed = parseLogsJsonOutput(raw);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 2);
    assert.equal((parsed[0] as { message: string }).message, "hello");
  });

  it("handles an empty string as an empty array", () => {
    assert.deepEqual(parseLogsJsonOutput(""), []);
  });

  it("ignores trailing blank lines", () => {
    const raw = '{"a":1}\n\n{"b":2}\n\n';
    const parsed = parseLogsJsonOutput(raw);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 2);
  });

  it("falls back to the raw text when any line is malformed", () => {
    const raw = '{"a":1}\nnot json\n{"b":2}\n';
    assert.equal(parseLogsJsonOutput(raw), raw);
  });

  it("returns non-string input unchanged (already-parsed case)", () => {
    const input = [{ a: 1 }];
    assert.equal(parseLogsJsonOutput(input), input);
  });
});

describe("aws_logs_tail schema", () => {
  it("accepts a minimal valid call", () => {
    assert.equal(tool.inputSchema.safeParse({ logGroupName: "/aws/lambda/my-fn" }).success, true);
  });

  it("accepts typical since values", () => {
    for (const since of ["5m", "30s", "2h", "1d", "1w", "15M"]) {
      assert.equal(
        tool.inputSchema.safeParse({ logGroupName: "/aws/lambda/my-fn", since }).success,
        true,
        `expected ${since} to parse`,
      );
    }
  });

  it("rejects malformed since values", () => {
    for (const since of ["5", "m", "5minutes", "-5m", "5 m"]) {
      assert.equal(
        tool.inputSchema.safeParse({ logGroupName: "/aws/lambda/my-fn", since }).success,
        false,
        `expected ${since} to fail`,
      );
    }
  });

  it("accepts filterPattern, logStreamNames, logStreamNamePrefix", () => {
    const r = tool.inputSchema.safeParse({
      logGroupName: "/aws/lambda/my-fn",
      filterPattern: "ERROR",
      logStreamNames: ["2026/04/21/[$LATEST]abc"],
    });
    assert.equal(r.success, true);
  });

  it("rejects missing logGroupName", () => {
    assert.equal(tool.inputSchema.safeParse({}).success, false);
  });
});

describe("aws_logs_tail handler — input validation (no spawn)", () => {
  it("rejects logGroupName with a leading hyphen", async () => {
    const r = (await tool.handler({ logGroupName: "--force" })) as { ok: boolean; error?: string };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid logGroupName/);
  });

  it("rejects logGroupName with shell metachars", async () => {
    const r = (await tool.handler({ logGroupName: "/aws/lambda/foo;rm" })) as { ok: boolean; error?: string };
    assert.equal(r.ok, false);
  });

  it("rejects mutually exclusive logStreamNames + logStreamNamePrefix", async () => {
    const r = (await tool.handler({
      logGroupName: "/aws/lambda/my-fn",
      logStreamNames: ["s1"],
      logStreamNamePrefix: "pre",
    })) as { ok: boolean; error?: string };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /not both/);
  });
});
