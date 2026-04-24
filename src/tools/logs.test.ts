import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isValidLogStreamName, LOG_GROUP_RE, LOG_STREAM_NAME_RE, logsTools, parseLogsJsonOutput } from "./logs.js";

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

  it("handles null/undefined as an empty array", () => {
    assert.deepEqual(parseLogsJsonOutput(null), []);
    assert.deepEqual(parseLogsJsonOutput(undefined), []);
  });

  it("wraps an already-parsed single object in a 1-element array", () => {
    // runAwsCall's JSON.parse succeeds when there's exactly one event on one
    // line, so `data` arrives as an object rather than a string.
    const single = { timestamp: "2026-04-21T00:00:00Z", message: "only" };
    const parsed = parseLogsJsonOutput(single);
    assert.deepEqual(parsed, [single]);
  });

  it("returns an already-parsed array unchanged", () => {
    const input = [{ a: 1 }, { b: 2 }];
    assert.equal(parseLogsJsonOutput(input), input);
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
});

describe("isValidLogStreamName", () => {
  it("accepts real-world AWS stream name shapes", () => {
    for (const name of [
      "2026/04/21/[$LATEST]abc",
      "main-stream",
      "app/service/v2",
      "x",
      "stream_with_underscores",
      "stream.with.dots",
      "MixedCASE-123",
    ]) {
      assert.ok(isValidLogStreamName(name), `expected ${name} to be valid`);
    }
  });

  it("rejects leading hyphen (argv-injection defense)", () => {
    assert.equal(isValidLogStreamName("-force"), false);
    assert.equal(isValidLogStreamName("--profile"), false);
  });

  it("rejects ':' and '*' (AWS forbids these)", () => {
    assert.equal(isValidLogStreamName("bad:name"), false);
    assert.equal(isValidLogStreamName("bad*name"), false);
    assert.equal(isValidLogStreamName(":leading-colon"), false);
  });

  it("rejects control characters and whitespace leads", () => {
    assert.equal(isValidLogStreamName("bad\x01name"), false);
    assert.equal(isValidLogStreamName(" leading-space"), false);
    assert.equal(isValidLogStreamName("tab\tinside"), false);
  });

  it("rejects embedded DEL and high control chars", () => {
    assert.equal(isValidLogStreamName("has\x00null"), false);
    assert.equal(isValidLogStreamName("has\x1fus"), false);
  });

  it("rejects empty string and over-length names", () => {
    assert.equal(isValidLogStreamName(""), false);
    assert.equal(isValidLogStreamName("a".repeat(513)), false);
    assert.equal(isValidLogStreamName("a".repeat(512)), true);
  });

  it("LOG_STREAM_NAME_RE alone still rejects structural issues", () => {
    // Keep coverage on the raw regex in case callers reach for it directly.
    assert.doesNotMatch("-bad", LOG_STREAM_NAME_RE);
    assert.match("2026/04/21/[$LATEST]abc", LOG_STREAM_NAME_RE);
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

  it("rejects logStreamNames containing a flag-like entry", async () => {
    const r = (await tool.handler({
      logGroupName: "/aws/lambda/my-fn",
      logStreamNames: ["good", "--force"],
    })) as { ok: boolean; error?: string };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid logStreamName/);
  });

  it("rejects logStreamNames containing forbidden characters", async () => {
    const r = (await tool.handler({
      logGroupName: "/aws/lambda/my-fn",
      logStreamNames: ["bad:name"],
    })) as { ok: boolean; error?: string };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid logStreamName/);
  });
});
