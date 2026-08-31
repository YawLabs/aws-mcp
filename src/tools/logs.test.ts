import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  isValidLogStreamName,
  LOG_GROUP_RE,
  LOG_STREAM_NAME_RE,
  logsTools,
  MAX_SINCE_MS,
  parseLogsJsonOutput,
  RELATIVE_TIME_RE,
  relativeTimeMs,
  resolveLogGroupName,
} from "./logs.js";

const tool = logsTools.find((t) => t.name === "aws_logs_tail");
if (!tool) throw new Error("logsTools missing aws_logs_tail");

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
  delete process.env.AWS_MCP_FAKE_SCENARIO;
});

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

describe("resolveLogGroupName", () => {
  it("passes a bare group name through unchanged", () => {
    assert.equal(resolveLogGroupName("/aws/lambda/my-fn"), "/aws/lambda/my-fn");
    assert.equal(resolveLogGroupName("my-custom-group"), "my-custom-group");
  });

  it("extracts the group name from a log-group ARN (the console's copy-button shape)", () => {
    // LOG_GROUP_RE rejects ':', so a pasted ARN used to bounce with a shape
    // error even though the group it names is perfectly valid.
    assert.equal(
      resolveLogGroupName("arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/my-fn"),
      "/aws/lambda/my-fn",
    );
  });

  it("tolerates the trailing ':*' that IAM policies and the console carry", () => {
    assert.equal(
      resolveLogGroupName("arn:aws:logs:eu-west-1:123456789012:log-group:/aws/ecs/my-service:*"),
      "/aws/ecs/my-service",
    );
  });

  it("accepts non-commercial partitions", () => {
    assert.equal(resolveLogGroupName("arn:aws-us-gov:logs:us-gov-west-1:123456789012:log-group:app/svc"), "app/svc");
  });

  it("holds an ARN-extracted name to the same argv-safety contract as a bare one", () => {
    // The extracted name still runs through LOG_GROUP_RE, so a hostile or
    // malformed group inside an otherwise well-formed ARN is still rejected.
    assert.equal(resolveLogGroupName("arn:aws:logs:us-east-1:123456789012:log-group:-force"), null);
    assert.equal(resolveLogGroupName("arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/foo;rm"), null);
  });

  it("rejects near-miss ARNs and non-group inputs", () => {
    assert.equal(resolveLogGroupName("arn:aws:logs:us-east-1:12345:log-group:/aws/lambda/fn"), null); // short account
    assert.equal(resolveLogGroupName("arn:aws:s3:::my-bucket"), null); // wrong service
    assert.equal(resolveLogGroupName("--force"), null);
    assert.equal(resolveLogGroupName(""), null);
  });
});

describe("relativeTimeMs (shared with aws_metrics_query)", () => {
  // The pattern lives here and metrics.ts imports it -- previously the two
  // files each carried a byte-identical copy.
  it("converts each documented unit", () => {
    assert.equal(relativeTimeMs("30s"), 30_000);
    assert.equal(relativeTimeMs("15m"), 15 * 60_000);
    assert.equal(relativeTimeMs("2h"), 2 * 3_600_000);
    assert.equal(relativeTimeMs("1d"), 86_400_000);
    assert.equal(relativeTimeMs("1w"), 7 * 86_400_000);
  });

  it("returns null for anything RELATIVE_TIME_RE rejects", () => {
    for (const bad of ["5", "m", "5x", "15M", "5 m", "-5m", ""]) {
      assert.equal(relativeTimeMs(bad), null, `expected '${bad}' to be rejected`);
      assert.doesNotMatch(bad, RELATIVE_TIME_RE);
    }
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

  it("accepts legitimate stream-name prefixes (used for logStreamNamePrefix)", () => {
    // A prefix is a partial stream name; the handler validates
    // logStreamNamePrefix with this same predicate. A slashed date prefix
    // like '2026/04/21/' must pass.
    for (const prefix of ["2026/04/21/", "app/service/", "main-"]) {
      assert.ok(isValidLogStreamName(prefix), `expected prefix ${prefix} to be valid`);
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

  it("allows embedded spaces (AWS permits them; only leading whitespace is blocked)", () => {
    // CloudWatch's CreateLogStream pattern is [^:*]*, which allows spaces.
    // Our validator blocks a leading space (argv-safety) but must not forbid
    // spaces elsewhere -- a future 'fix' removing the space carve-out would
    // reject real stream names.
    assert.equal(isValidLogStreamName("stream with space"), true);
    assert.equal(isValidLogStreamName("my stream/2026"), true);
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
    for (const since of ["5m", "30s", "2h", "1d", "1w"]) {
      assert.equal(
        tool.inputSchema.safeParse({ logGroupName: "/aws/lambda/my-fn", since }).success,
        true,
        `expected ${since} to parse`,
      );
    }
  });

  it("rejects uppercase unit suffixes (aws logs tail accepts lowercase only)", () => {
    // The CLI rejects "15M"/"2H"/etc.; the schema must too, else we Zod-OK
    // an input the CLI then errors on. Anchored case so a future `/i` flip
    // gets caught here rather than at runtime.
    for (const since of ["15M", "2H", "1D", "1W", "30S"]) {
      assert.equal(
        tool.inputSchema.safeParse({ logGroupName: "/aws/lambda/my-fn", since }).success,
        false,
        `expected ${since} to be rejected (uppercase unit)`,
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

  it("rejects a hostile logStreamNamePrefix (leading hyphen)", async () => {
    for (const prefix of ["-rf", "--force"]) {
      const r = (await tool.handler({
        logGroupName: "/aws/lambda/my-fn",
        logStreamNamePrefix: prefix,
      })) as { ok: boolean; error?: string };
      assert.equal(r.ok, false, `expected ${prefix} to be rejected`);
      assert.match(r.error ?? "", /Invalid logStreamNamePrefix/);
    }
  });

  it("rejects a logStreamNamePrefix with control characters", async () => {
    const r = (await tool.handler({
      logGroupName: "/aws/lambda/my-fn",
      logStreamNamePrefix: "bad\x01prefix",
    })) as { ok: boolean; error?: string };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid logStreamNamePrefix/);
  });

  it("accepts a log-group ARN where a bare name is expected", async () => {
    // Reaches the spawn path, so only assert that validation let it through --
    // the ARN branch itself is pinned by the resolveLogGroupName cases above.
    const r = (await tool.handler({
      logGroupName: "arn:aws:logs:us-east-1:123456789012:log-group:-force",
    })) as { ok: boolean; error?: string };
    assert.equal(r.ok, false, "a hostile group name inside an ARN is still rejected");
    assert.match(r.error ?? "", /Invalid logGroupName/);
    assert.match(r.error ?? "", /log-group ARN/, "the error must name the ARN form as accepted input");
  });

  it("rejects a zero-width since window", async () => {
    // '0m' matched the shape regex, spawned the CLI, and came back ok:true with
    // eventCount:0 -- indistinguishable from 'the log group is quiet'.
    for (const since of ["0m", "0s", "0h", "0d", "0w"]) {
      const r = (await tool.handler({ logGroupName: "/aws/lambda/my-fn", since })) as {
        ok: boolean;
        error?: string;
      };
      assert.equal(r.ok, false, `expected ${since} to be rejected`);
      assert.match(r.error ?? "", /zero-width window/);
    }
  });

  it("rejects a since window beyond the maximum", async () => {
    // 'aws logs tail' drains FilterLogEvents internally; the 60s timeout and
    // the 5MB stdout cap only fire AFTER the API calls are spent.
    const r = (await tool.handler({ logGroupName: "/aws/lambda/my-fn", since: "520w" })) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /maximum is 30 days/);
    assert.equal(MAX_SINCE_MS, 30 * 86_400_000, "error text above is anchored to MAX_SINCE_MS");
  });

  it("still runs the windows the description documents (boundary: 4w in, 5w out)", async () => {
    // The cap must not shrink the vocabulary the tool advertises ('1w', '3d').
    // 4w (28 days) is inside the 30-day ceiling and runs; 5w (35 days) is not.
    process.env.AWS_MCP_FAKE_SCENARIO = "logs_tail_empty";
    const inside = (await tool.handler({ logGroupName: "/aws/lambda/my-fn", since: "4w" })) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(inside.ok, true, "28 days must still be allowed");
    const outside = (await tool.handler({ logGroupName: "/aws/lambda/my-fn", since: "5w" })) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(outside.ok, false, "35 days is over the ceiling");
    assert.match(outside.error ?? "", /maximum is 30 days/);
  });

  it("rejects a filterPattern that starts with '-'", async () => {
    // filterPattern lands as the value position after --filter-pattern in
    // argv, so a leading '-' is not actually exploitable -- but the file
    // header comment promises uniform leading-hyphen defense across every
    // free-text field. Real CloudWatch filter patterns never start with '-'
    // (they start with a literal word, a quote, or '[' for structured
    // matching), so the reject costs nothing and keeps the invariant honest.
    const r = (await tool.handler({
      logGroupName: "/aws/lambda/my-fn",
      filterPattern: "-x",
    })) as { ok: boolean; error?: string };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /filterPattern/);
    assert.match(r.error ?? "", /must not start with '-'/);
  });
});
