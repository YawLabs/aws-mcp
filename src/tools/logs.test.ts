import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { runAwsCall } from "../aws-cli.js";
import {
  DEFAULT_MAX_EVENTS,
  DEFAULT_QUERY_LIMIT,
  flattenQueryRows,
  isValidLogStreamName,
  isValidQueryId,
  LOG_GROUP_RE,
  LOG_STREAM_NAME_RE,
  logsTools,
  MAX_MAX_EVENTS,
  MAX_QUERY_LIMIT,
  MAX_QUERY_LOG_GROUPS,
  MAX_QUERY_RANGE_MS,
  MAX_SINCE_MS,
  parseLogsJsonOutput,
  pollQueryUntilTerminal,
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

  it("accepts maxEvents across its documented range", () => {
    for (const maxEvents of [1, 10, DEFAULT_MAX_EVENTS, MAX_MAX_EVENTS]) {
      assert.equal(
        tool.inputSchema.safeParse({ logGroupName: "/aws/lambda/my-fn", maxEvents }).success,
        true,
        `expected maxEvents=${maxEvents} to parse`,
      );
    }
  });

  it("rejects maxEvents outside 1..MAX_MAX_EVENTS and non-integers", () => {
    // Both sides of the ceiling in one test, so a future `.max()` edit fails
    // here rather than at runtime.
    for (const maxEvents of [0, -1, 1.5, MAX_MAX_EVENTS + 1, "500"]) {
      assert.equal(
        tool.inputSchema.safeParse({ logGroupName: "/aws/lambda/my-fn", maxEvents }).success,
        false,
        `expected maxEvents=${JSON.stringify(maxEvents)} to be rejected`,
      );
    }
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
    const r = (await tool.handler({ logGroupName: "--force" })) as {
      ok: boolean;
      error?: string;
      errorKind?: string;
      suggestion?: string;
    };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid logGroupName/);
    // NEGATIVE contract: this guard returns before runAwsCall (the describe
    // name says "no spawn"), so nothing classified the failure. An ABSENT
    // errorKind means "unclassified" -- never "nonzero_exit", and never a
    // manufactured "bad_input".
    assert.equal(r.errorKind, undefined);
    assert.equal(r.suggestion, undefined);
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

  it("accepts EXACTLY the maximum window and rejects one day more (30d in, 31d out)", async () => {
    // The 4w/5w case above brackets the ceiling but straddles it by 2 days on
    // one side and 5 on the other, so an off-by-one in the comparison (`>=`
    // instead of `>`) survives it. The cap is inclusive: sinceMs > MAX_SINCE_MS
    // rejects, so exactly 30 days must still run.
    assert.equal(relativeTimeMs("30d"), MAX_SINCE_MS, "precondition: '30d' is exactly the ceiling");
    process.env.AWS_MCP_FAKE_SCENARIO = "logs_tail_empty";
    const atMax = (await tool.handler({ logGroupName: "/aws/lambda/my-fn", since: "30d" })) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(atMax.ok, true, `exactly 30 days must be allowed, got: ${atMax.error ?? ""}`);
    const overMax = (await tool.handler({ logGroupName: "/aws/lambda/my-fn", since: "31d" })) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(overMax.ok, false, "31 days is one day over the ceiling");
    assert.match(overMax.error ?? "", /maximum is 30 days/);
    assert.match(overMax.error ?? "", /asks for a 31-day window/);
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

// ---------------------------------------------------------------------------
// aws_logs_query
// ---------------------------------------------------------------------------

const queryTool = logsTools.find((t) => t.name === "aws_logs_query");
if (!queryTool) throw new Error("logsTools missing aws_logs_query");

const okQuery = (over: Record<string, unknown> = {}) => ({
  logGroupNames: ["/aws/lambda/my-fn"],
  queryString: "fields @timestamp, @message",
  ...over,
});

describe("aws_logs_query schema", () => {
  it("requires logGroupNames (1..MAX_QUERY_LOG_GROUPS) and a non-empty queryString", () => {
    assert.equal(queryTool.inputSchema.safeParse({}).success, false);
    assert.equal(queryTool.inputSchema.safeParse(okQuery({ logGroupNames: [] })).success, false);
    assert.equal(queryTool.inputSchema.safeParse(okQuery({ queryString: "" })).success, false);
    assert.equal(queryTool.inputSchema.safeParse(okQuery()).success, true);

    const names = (n: number) => Array.from({ length: n }, (_, i) => `/g/${i}`);
    assert.equal(
      queryTool.inputSchema.safeParse(okQuery({ logGroupNames: names(MAX_QUERY_LOG_GROUPS) })).success,
      true,
    );
    assert.equal(
      queryTool.inputSchema.safeParse(okQuery({ logGroupNames: names(MAX_QUERY_LOG_GROUPS + 1) })).success,
      false,
    );
  });

  it("restricts queryLanguage to CWLI | PPL -- SQL names its log groups inside the query string", () => {
    // AWS: "The exception is queries using the OpenSearch Service SQL query
    // language, where you specify the log group names inside the querystring
    // instead of here." This tool always sends logGroupNames, so SQL is routed
    // to aws_call rather than silently conflicting.
    for (const queryLanguage of ["CWLI", "PPL"]) {
      assert.equal(queryTool.inputSchema.safeParse(okQuery({ queryLanguage })).success, true, queryLanguage);
    }
    assert.equal(queryTool.inputSchema.safeParse(okQuery({ queryLanguage: "SQL" })).success, false);
  });

  it("bounds limit at MAX_QUERY_LIMIT, which is GetQueryResults' single-call ceiling", () => {
    // NOT StartQuery's documented 100,000: one GetQueryResults call returns at
    // most 10,000 rows, and the remainder is only reachable through pagination
    // members the installed CLI's model does not carry.
    for (const limit of [1, DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT]) {
      assert.equal(queryTool.inputSchema.safeParse(okQuery({ limit })).success, true, String(limit));
    }
    for (const limit of [0, -1, 1.5, MAX_QUERY_LIMIT + 1]) {
      assert.equal(queryTool.inputSchema.safeParse(okQuery({ limit })).success, false, String(limit));
    }
  });

  it("declares read-only, non-destructive annotations", () => {
    assert.deepEqual(queryTool.annotations, {
      title: "Run a CloudWatch Logs Insights query and wait for results",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
  });
});

describe("isValidQueryId", () => {
  it("accepts a bounded, argv-safe id and rejects the rest", () => {
    assert.equal(isValidQueryId("f1e2d3c4-1234-5678-9abc-def012345678"), true);
    assert.equal(isValidQueryId("a".repeat(256)), true);
    assert.equal(isValidQueryId(""), false);
    assert.equal(isValidQueryId("a".repeat(257)), false);
    assert.equal(isValidQueryId("-x"), false, "leading hyphen could masquerade as a flag");
    assert.equal(isValidQueryId("a\nb"), false, "control characters are rejected");
    // A SPACE is allowed, matching isValidIdentifier / isValidOpaqueToken in
    // resource.ts: the value goes into a single argv entry and never through a
    // shell, so an embedded space cannot split it into a second argument. Only
    // control characters (< 0x20) and a leading hyphen are dangerous there.
    assert.equal(isValidQueryId("a b"), true);
  });
});

describe("flattenQueryRows", () => {
  it("flattens {field,value} pairs into objects and collects fields in first-seen order", () => {
    const { rows, fields } = flattenQueryRows([
      [
        { field: "@message", value: "a" },
        { field: "@ptr", value: "p" },
      ],
      [{ field: "@message", value: "b" }],
    ]);
    assert.deepEqual(fields, ["@message", "@ptr"]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]["@message"], "a");
    assert.equal(rows[0]["@ptr"], "p");
    assert.equal(rows[1]["@message"], "b");
  });

  it("skips a non-string field name and nulls a non-string value", () => {
    const { rows, fields } = flattenQueryRows([
      [
        { field: 42, value: "x" },
        { field: "@m", value: { nested: true } },
      ],
    ]);
    assert.deepEqual(fields, ["@m"]);
    assert.equal(rows[0]["@m"], null);
  });

  it("a literal __proto__ field becomes an OWN property and does not poison Object.prototype", () => {
    // Field names come from the caller's own log data -- Insights discovers JSON
    // keys automatically -- so "__proto__" is reachable input, not a hypothetical.
    const { rows } = flattenQueryRows([[{ field: "__proto__", value: "pwned" }]]);
    assert.deepEqual(Object.keys(rows[0]), ["__proto__"]);
    // Both rules fire on the next line and they contradict each other here:
    // useLiteralKeys wants dot notation, noProto forbids naming __proto__ at all.
    // Naming it IS the test -- it asserts an OWN property was created rather than
    // the prototype setter being reached -- so both are suppressed deliberately.
    // biome-ignore lint/suspicious/noProto: naming __proto__ is the assertion itself
    // biome-ignore lint/complexity/useLiteralKeys: bracket form is required by the line above
    assert.equal(JSON.parse(JSON.stringify(rows[0]))["__proto__"], "pwned");
    assert.equal(Object.getPrototypeOf({}), Object.prototype);
    // biome-ignore lint/suspicious/noProto: the control proving Object.prototype was not polluted
    assert.equal(({} as Record<string, unknown>).__proto__, Object.prototype);
  });

  it("returns empty rows and fields for non-array input", () => {
    assert.deepEqual(flattenQueryRows(null), { rows: [], fields: [] });
    assert.deepEqual(flattenQueryRows("nope"), { rows: [], fields: [] });
  });

  it("drops a non-array ROW entirely rather than emitting an empty object", () => {
    // The consequential one of the malformed shapes: rowCount feeds the
    // `truncated` comparison, so a discarded row silently shrinking the count
    // is indistinguishable from "the query matched fewer records" -- and an
    // empty object in its place would be a row the caller cannot read.
    const { rows, fields } = flattenQueryRows([
      [{ field: "@m", value: "a" }],
      "not-a-row",
      null,
      [{ field: "@m", value: "b" }],
    ]);
    assert.equal(rows.length, 2);
    assert.deepEqual(fields, ["@m"]);
  });

  it("collapses a field repeated within one row to the LAST value, with one fields entry", () => {
    // Documented in the function's own doc comment ("Two pairs with the same
    // field name in one row collapse to the last"), and nothing held the code
    // to it. The single fields entry is the other half: `seen` must dedupe.
    const { rows, fields } = flattenQueryRows([
      [
        { field: "@m", value: "first" },
        { field: "@m", value: "second" },
      ],
    ]);
    assert.equal(rows[0]["@m"], "second");
    assert.deepEqual(fields, ["@m"], "one entry, not two");
  });

  it("skips every unusable pair shape, including an EMPTY-STRING field name", () => {
    // The empty-string `field` is the branch worth having here; the non-string
    // half of the same condition is already pinned above.
    const { rows, fields } = flattenQueryRows([
      [null, "pair", 7, { field: "", value: "x" }, { field: "@ok", value: "y" }],
    ]);
    // Rows are Object.create(null), so deepStrictEqual against an object
    // literal fails on the prototype check -- assert through Object.keys, the
    // way the __proto__ case above does.
    assert.deepEqual(Object.keys(rows[0]), ["@ok"]);
    assert.deepEqual(fields, ["@ok"]);
  });
});

describe("pollQueryUntilTerminal", () => {
  // A scripted GetQueryResults caller: one response per call, in order.
  const scriptedCaller = (statuses: Array<string | null>, results: unknown[][] = []) => {
    const calls: Array<Parameters<typeof runAwsCall>[0]> = [];
    let n = 0;
    const call = async (opts: Parameters<typeof runAwsCall>[0]) => {
      calls.push(opts);
      const status = statuses[Math.min(n, statuses.length - 1)];
      const rows = results[Math.min(n, results.length - 1)] ?? [];
      n++;
      return {
        ok: true as const,
        data: { ...(status === null ? {} : { status }), results: rows, statistics: {} },
        command: "aws logs get-query-results",
        rawStdout: "",
      };
    };
    return { call, calls };
  };

  it("keeps polling through Scheduled and Running, and returns on Complete", async () => {
    const { call, calls } = scriptedCaller(["Scheduled", "Running", "Complete"]);
    const slept: number[] = [];
    const r = await pollQueryUntilTerminal(
      { queryId: "q1", pollIntervalMs: 1234, maxWaitMs: 60_000 },
      call,
      async (ms: number) => {
        slept.push(ms);
      },
    );
    assert.equal(r.reason, "terminal");
    assert.equal(r.status, "Complete");
    assert.equal(r.attempts, 3);
    assert.deepEqual(slept, [1234, 1234], "one sleep BETWEEN polls, none before the first or after the last");
    for (const c of calls) {
      assert.equal(c.service, "logs");
      assert.equal(c.operation, "get-query-results");
      assert.deepEqual(c.extraFlags, ["--query-id", "q1"]);
    }
  });

  it("treats every non-in-flight status as terminal, including unrecognized and missing", async () => {
    // The allowlist is Scheduled/Running: anything else stops. A status AWS adds
    // after this release lands here rather than spinning to the budget.
    for (const status of ["Failed", "Timeout", "Cancelled", "Frobnicated", null]) {
      const { call } = scriptedCaller([status]);
      const r = await pollQueryUntilTerminal(
        { queryId: "q1", pollIntervalMs: 10, maxWaitMs: 60_000 },
        call,
        async () => {},
      );
      assert.equal(r.reason, "terminal", String(status));
      assert.equal(r.attempts, 1, String(status));
      assert.equal(r.status, status, String(status));
    }
  });

  it("stops at the budget without making a call past maxWaitMs, and names the queryId", async () => {
    const { call, calls } = scriptedCaller(["Running"]);
    let now = 0;
    const r = await pollQueryUntilTerminal(
      { queryId: "q-budget", pollIntervalMs: 20, maxWaitMs: 100 },
      call,
      async (ms: number) => {
        now += ms;
      },
    );
    assert.equal(r.reason, "budget");
    assert.equal(calls.length, r.attempts, "no AWS call after the budget expired");
    assert.match(r.error ?? "", /q-budget/);
    assert.match(r.error ?? "", /maxWaitMs/);
    assert.match(r.error ?? "", /7 days/, "the resume hint must survive onto the budget arm");
    assert.ok(now >= 0);
  });

  it("makes ZERO AWS calls when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let called = 0;
    const r = await pollQueryUntilTerminal(
      {
        queryId: "q-cancel",
        pollIntervalMs: 10,
        maxWaitMs: 60_000,
        ctx: { reportProgress: () => {}, signal: controller.signal },
      },
      async () => {
        called++;
        throw new Error("must not be called");
      },
      async () => {},
    );
    assert.equal(r.reason, "cancelled");
    assert.equal(r.attempts, 0);
    assert.equal(called, 0, "the signal is checked BEFORE the first pass, not after it");
    // Never a fake success, and honest about what was and was not cancelled.
    assert.match(r.error ?? "", /NOT cancelled/);
    assert.match(r.error ?? "", /q-cancel/);
  });

  it("wakes immediately when cancellation arrives mid-sleep", async () => {
    // The real abortable sleep, with an interval far longer than the test can
    // wait: if the sleep were not abortable this would run for 30s.
    const controller = new AbortController();
    const { call } = scriptedCaller(["Running"]);
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    const r = await pollQueryUntilTerminal(
      {
        queryId: "q-midsleep",
        pollIntervalMs: 30_000,
        maxWaitMs: 60_000,
        ctx: { reportProgress: () => {}, signal: controller.signal },
      },
      call,
    );
    assert.equal(r.reason, "cancelled");
    assert.ok(Date.now() - started < 5_000, "must wake on abort, not wait out the 30s interval");
    assert.match(r.error ?? "", /NOT cancelled/);
    assert.match(r.error ?? "", /q-midsleep/);
  });

  it("reports one progress update per attempt, monotonic, with no total", async () => {
    // No honest denominator exists -- the query ends when AWS says so -- so the
    // v2.1.0 rule applies: omit `total` rather than manufacture one.
    const { call } = scriptedCaller(["Scheduled", "Running", "Complete"]);
    const seen: Array<{ progress: number; total?: number; message?: string }> = [];
    const r = await pollQueryUntilTerminal(
      {
        queryId: "q1",
        pollIntervalMs: 1,
        maxWaitMs: 60_000,
        ctx: {
          reportProgress: (progress: number, total?: number, message?: string) =>
            seen.push({ progress, total, message }),
        },
      },
      call,
      async () => {},
    );
    assert.equal(r.attempts, 3);
    assert.equal(seen.length, 3);
    assert.deepEqual(
      seen.map((s) => s.progress),
      [1, 2, 3],
    );
    for (const s of seen) assert.equal(s.total, undefined, "no fabricated denominator");
    assert.match(seen[0].message ?? "", /Scheduled/);
    assert.match(seen[2].message ?? "", /Complete/);
  });

  it("behaves identically with no ctx at all", async () => {
    const { call } = scriptedCaller(["Complete"]);
    const r = await pollQueryUntilTerminal(
      { queryId: "q1", pollIntervalMs: 1, maxWaitMs: 60_000 },
      call,
      async () => {},
    );
    assert.equal(r.reason, "terminal");
    assert.equal(r.attempts, 1);
  });

  it("clamps the inter-poll sleep to the REMAINING budget, never the raw interval", async () => {
    // The budget test above looks like it covers this but does not: its `now`
    // accumulator is never compared against anything (its closing assertion is
    // vacuous) and the loop reads real Date.now(). The only other test that
    // inspects sleep durations uses maxWaitMs 60000 against pollIntervalMs
    // 1234, where the clamp never binds. This is a single-threaded stdio
    // server, so a 30s sleep past a sub-second budget blocks every other tool
    // call for the overshoot.
    const { call } = scriptedCaller(["Running"]);
    const slept: number[] = [];
    const r = await pollQueryUntilTerminal(
      { queryId: "q-clamp", pollIntervalMs: 30_000, maxWaitMs: 200 },
      call,
      async (ms: number) => {
        slept.push(ms);
        // Sleep for REAL so the wall clock advances into the budget (the loop
        // has no injectable clock), but cap what is actually waited: a
        // regressed clamp would otherwise hang this test for the full 30s
        // instead of failing on the recorded value.
        await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5)));
      },
    );
    assert.equal(r.reason, "budget");
    assert.ok(slept.length > 0, "the loop must have slept at least once for this to assert anything");
    // Deliberately NOT a fixed slept.length or an exact value -- with no
    // injectable clock the iteration count is wall-clock dependent. The
    // ceiling is the invariant.
    for (const ms of slept) {
      assert.ok(ms <= 200, `slept ${ms}ms against a 200ms budget`);
    }
  });

  it("still makes exactly ONE call when the budget is already spent", async () => {
    // The one-shot guarantee: the budget check is skipped while attempts === 0,
    // so a caller always gets a result. Not reachable through the schema (the
    // maxWaitMs floor is 1000), so this is a unit-level invariant of the
    // exported function -- and it is what the `attempts > 0` guard is for.
    const { call, calls } = scriptedCaller(["Running"]);
    const slept: number[] = [];
    const r = await pollQueryUntilTerminal(
      { queryId: "q-zero-budget", pollIntervalMs: 30_000, maxWaitMs: 0 },
      call,
      async (ms: number) => {
        slept.push(ms);
      },
    );
    assert.equal(r.reason, "budget");
    assert.equal(r.attempts, 1);
    assert.equal(calls.length, 1);
    assert.deepEqual(slept, [], "waitMs <= 0 skips the sleep entirely");
  });

  it("returns call_failed with the kind, the suggestion, and the STDOUT fallback on empty stderr", async () => {
    // scriptedCaller always succeeds, so this return has only ever run through
    // one integration scenario -- whose stderr is non-empty and whose kind is
    // auth-class. `rawBody: result.rawStderr || result.rawStdout` is a `||` on
    // purpose: rawStderr is "" (not nullish) on a nonzero exit with empty
    // stderr, and `??` would hand back that "" so the handler's `underlying`
    // would silently fall back to the summary and lose the only raw diagnostic
    // a poll failure has.
    const reported: number[] = [];
    const failing = async () => ({
      ok: false as const,
      kind: "nonzero_exit" as const,
      error: "boom\n\nSuggestion: fix it",
      suggestion: "fix it",
      command: "aws logs get-query-results",
      rawStderr: "",
      rawStdout: "diagnostic on stdout",
    });
    const r = await pollQueryUntilTerminal(
      {
        queryId: "q-callfail",
        pollIntervalMs: 1,
        maxWaitMs: 60_000,
        ctx: { reportProgress: (progress: number) => reported.push(progress) },
      },
      failing,
      async () => {},
    );
    assert.equal(r.reason, "call_failed");
    assert.equal(r.kind, "nonzero_exit");
    // The suggestion carry is the v2.2.1 fix, and this return is the only place
    // it is observable.
    assert.equal(r.suggestion, "fix it");
    assert.equal(r.rawBody, "diagnostic on stdout");
    assert.equal(r.command, "aws logs get-query-results");
    assert.equal(r.attempts, 1, "the attempt is counted before the failure returns");
    assert.deepEqual(reported, [], "the arm returns BEFORE reportProgress");
  });
});

describe("aws_logs_query handler — the 90-day window cap", () => {
  it("rejects a window far past the ceiling, and classifies nothing", async () => {
    // startTime is an unbounded free string in the schema, so this line is the
    // only thing between a fat-fingered window and a real Insights bill --
    // Insights charges by the uncompressed bytes SCANNED, matched or not.
    const r = (await queryTool.handler(okQuery({ startTime: "520w" }))) as {
      ok: boolean;
      error?: string;
      errorKind?: string;
      suggestion?: string;
    };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /maximum is 90/);
    assert.equal(MAX_QUERY_RANGE_MS, 90 * 86_400_000, "error text above is anchored to MAX_QUERY_RANGE_MS");
    // Returns before runAwsCall, so nothing classified it -- the same negative
    // contract the aws_logs_tail no-spawn suite asserts.
    assert.equal(r.errorKind, undefined);
    assert.equal(r.suggestion, undefined);
  });

  it("accepts EXACTLY the maximum window and rejects one day more (90d in, 91d out)", async () => {
    // The cap is inclusive -- `rangeMs > MAX_QUERY_RANGE_MS` rejects -- so
    // exactly 90 days must still run, and a `>` -> `>=` flip is invisible
    // without this pair. startTime and endTime both resolve from the SAME
    // `now` inside the handler, so '90d' -> 'now' is exactly 90 days with no
    // skew between the two reads.
    process.env.AWS_MCP_FAKE_SCENARIO = "logs_query_complete";
    const atMax = (await queryTool.handler(okQuery({ startTime: "90d", endTime: "now", pollIntervalMs: 500 }))) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(atMax.ok, true, `exactly 90 days must be allowed, got: ${atMax.error ?? ""}`);

    const overMax = (await queryTool.handler(okQuery({ startTime: "91d", endTime: "now" }))) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(overMax.ok, false, "91 days is one day over the ceiling");
    assert.match(overMax.error ?? "", /requested window is 91 days/);
    assert.match(overMax.error ?? "", /maximum is 90/);
  });
});

describe("aws_logs_query handler — input validation (no spawn)", () => {
  it("rejects a flag-like logGroupNames entry and classifies nothing", async () => {
    const r = (await queryTool.handler(okQuery({ logGroupNames: ["/aws/lambda/ok", "--force"] }))) as {
      ok: boolean;
      error?: string;
      errorKind?: string;
      suggestion?: string;
    };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid logGroupName/);
    // An ABSENT errorKind means "unclassified" -- never a manufactured value.
    assert.equal(r.errorKind, undefined);
    assert.equal(r.suggestion, undefined);
  });

  it("rejects a bare-number startTime -- '5' is not '5m'", async () => {
    // Date reads "5" as a date, not a duration, so a dropped unit would
    // silently become a 25-year window with nothing rejecting it locally.
    const r = (await queryTool.handler(okQuery({ startTime: "5" }))) as { ok: boolean; error?: string };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid startTime/);
  });

  it("rejects an offset-less ISO date-time as endTime", async () => {
    // Reached only because startTime defaults to '1h' and passes first.
    const r = (await queryTool.handler(okQuery({ endTime: "2026-05-16T10:00:00" }))) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid endTime/);
  });

  it("rejects an endTime at or before startTime", async () => {
    // A separate literal from the identical rejection in metrics.ts, and only
    // the metrics copy was tested.
    const r = (await queryTool.handler(okQuery({ startTime: "now", endTime: "1h" }))) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /must be after startTime/);
  });
});
