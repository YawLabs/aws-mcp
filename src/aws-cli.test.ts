import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import {
  _resetParseTestPrefixArgsDedupe,
  parseTestPrefixArgs,
  redactDisplayArgs,
  runAwsCall,
  SAFE_NAME_RE,
  truncateForErrorMsg,
} from "./aws-cli.js";

describe("SAFE_NAME_RE", () => {
  it("accepts typical kebab-case service/operation names", () => {
    for (const name of ["s3", "s3api", "ec2", "list-buckets", "get-caller-identity", "describe-log-streams"]) {
      assert.match(name, SAFE_NAME_RE, `expected ${name} to match`);
    }
  });

  it("rejects leading hyphens (argv-injection defense)", () => {
    assert.doesNotMatch("-s3", SAFE_NAME_RE);
    assert.doesNotMatch("--profile", SAFE_NAME_RE);
    assert.doesNotMatch("-", SAFE_NAME_RE);
  });

  it("rejects uppercase and whitespace", () => {
    assert.doesNotMatch("S3", SAFE_NAME_RE);
    assert.doesNotMatch("list_Buckets", SAFE_NAME_RE);
    assert.doesNotMatch("s3 api", SAFE_NAME_RE);
    assert.doesNotMatch("s3\tapi", SAFE_NAME_RE);
  });

  it("rejects shell-meaningful characters", () => {
    assert.doesNotMatch("s3;rm", SAFE_NAME_RE);
    assert.doesNotMatch("s3|cat", SAFE_NAME_RE);
    assert.doesNotMatch("s3$foo", SAFE_NAME_RE);
    assert.doesNotMatch("s3`echo`", SAFE_NAME_RE);
    assert.doesNotMatch("s3.api", SAFE_NAME_RE);
    assert.doesNotMatch("s3/api", SAFE_NAME_RE);
    assert.doesNotMatch("s3\\api", SAFE_NAME_RE);
  });

  it("rejects empty string", () => {
    assert.doesNotMatch("", SAFE_NAME_RE);
  });
});

describe("runAwsCall — input validation (no spawn)", () => {
  it("rejects invalid service name", async () => {
    const r = await runAwsCall({ service: "-s3", operation: "list-buckets" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "bad_input");
    assert.match(r.error, /Invalid service/);
  });

  it("rejects service containing shell metacharacters", async () => {
    const r = await runAwsCall({ service: "s3;rm -rf /", operation: "list-buckets" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "bad_input");
  });

  it("rejects operation that looks like a flag", async () => {
    const r = await runAwsCall({ service: "s3", operation: "--profile evil" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "bad_input");
    assert.match(r.error, /Invalid operation token/);
  });

  it("rejects empty operation", async () => {
    const r = await runAwsCall({ service: "s3", operation: "" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "bad_input");
  });

  it("rejects whitespace-only operation", async () => {
    const r = await runAwsCall({ service: "s3", operation: "   " });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "bad_input");
  });

  it("rejects profile that looks like a flag (argv-injection defense)", async () => {
    const r = await runAwsCall({ service: "s3", operation: "list-buckets", profile: "--query=foo" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "bad_input");
    assert.match(r.error, /Invalid profile name/);
  });

  it("rejects region that looks like a flag", async () => {
    const r = await runAwsCall({ service: "s3", operation: "list-buckets", region: "--profile=evil" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "bad_input");
    assert.match(r.error, /Invalid region/);
  });

  it("rejects profile with whitespace / newlines", async () => {
    const r = await runAwsCall({ service: "s3", operation: "list-buckets", profile: "evil\nname" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "bad_input");
    assert.match(r.error, /Invalid profile name/);
  });

  it("catches malicious AWS_PROFILE env var (resolved-value validation)", async () => {
    // setProfile validates at write time, but env vars bypass it -- getProfile
    // returns whatever AWS_PROFILE says. The validator inside runAwsCall is
    // the backstop that catches a hostile env-var fallback.
    const saved = process.env.AWS_PROFILE;
    process.env.AWS_PROFILE = "--query=evil";
    try {
      const r = await runAwsCall({ service: "s3", operation: "list-buckets" });
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.equal(r.kind, "bad_input");
      assert.match(r.error, /AWS_PROFILE/);
    } finally {
      if (saved === undefined) delete process.env.AWS_PROFILE;
      else process.env.AWS_PROFILE = saved;
    }
  });

  it("rejects query expressions longer than 2048 chars", async () => {
    const longQuery = "a".repeat(2049);
    const r = await runAwsCall({ service: "s3", operation: "list-buckets", query: longQuery });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "bad_input");
    assert.match(r.error, /query expression too long/);
    assert.match(r.error, /2049/);
  });

  it("accepts query expressions at exactly the 2048-char limit", async () => {
    // At exactly 2048 the validation passes; the call may still fail for other
    // reasons (no real CLI), but the rejection shape must NOT be bad_input.
    const exactQuery = "a".repeat(2048);
    const r = await runAwsCall({
      service: "s3",
      operation: "list-buckets",
      query: exactQuery,
      // Use a non-existent command so the call fails fast without touching
      // the real AWS CLI, but not as bad_input.
      command: "__no_such_binary__",
    });
    // The rejection may be spawn_failure or similar -- the important thing is
    // it is not bad_input from the length check.
    if (!r.ok) {
      assert.notEqual(r.kind, "bad_input", "2048-char query must not be rejected by the length cap");
    }
  });
});

describe("redactDisplayArgs", () => {
  it("replaces the value after --cli-input-json with a length stub", () => {
    const payload = JSON.stringify({ Password: "hunter2", Username: "admin" });
    const args = ["s3api", "put-object", "--cli-input-json", payload, "--profile", "prod"];
    const redacted = redactDisplayArgs(args);
    assert.ok(!redacted.some((a) => a.includes("hunter2")), "password must not appear");
    assert.ok(!redacted.some((a) => a.includes("admin")), "username must not appear");
    assert.equal(redacted[3], `<redacted len=${payload.length}>`);
    // Non-payload args pass through unchanged.
    assert.deepEqual(redacted.slice(0, 3), ["s3api", "put-object", "--cli-input-json"]);
    assert.deepEqual(redacted.slice(4), ["--profile", "prod"]);
  });

  it("returns the input unchanged when --cli-input-json is absent", () => {
    const args = ["s3api", "list-buckets", "--profile", "prod"];
    assert.deepEqual(redactDisplayArgs(args), args);
  });

  it("does not crash when --cli-input-json has no following token", () => {
    const args = ["s3api", "list-buckets", "--cli-input-json"];
    assert.deepEqual(redactDisplayArgs(args), args);
  });

  it("redacts ALL occurrences of --cli-input-json, not just the first", () => {
    // Both occurrences carry secrets; only redacting the first leaves the
    // second payload exposed in the displayCommand string.
    const payload1 = JSON.stringify({ SecretKey: "abc123" });
    const payload2 = JSON.stringify({ Password: "hunter2" });
    const args = [
      "s3api",
      "put-object",
      "--cli-input-json",
      payload1,
      "--cli-input-json",
      payload2,
      "--profile",
      "prod",
    ];
    const redacted = redactDisplayArgs(args);
    assert.ok(!redacted.some((a) => a.includes("abc123")), "first payload secret must not appear");
    assert.ok(!redacted.some((a) => a.includes("hunter2")), "second payload secret must not appear");
    assert.equal(redacted[3], `<redacted len=${payload1.length}>`);
    assert.equal(redacted[5], `<redacted len=${payload2.length}>`);
    // Flag tokens and other args pass through.
    assert.equal(redacted[2], "--cli-input-json");
    assert.equal(redacted[4], "--cli-input-json");
    assert.equal(redacted[6], "--profile");
    assert.equal(redacted[7], "prod");
  });
});

describe("truncateForErrorMsg", () => {
  it("returns input unchanged when under cap", () => {
    assert.equal(truncateForErrorMsg("short error"), "short error");
  });

  it("truncates and annotates long input", () => {
    const huge = "x".repeat(10 * 1024);
    const result = truncateForErrorMsg(huge);
    assert.ok(result.length < huge.length);
    assert.match(result, /\[truncated; \d+ bytes omitted\]/);
  });
});

describe("parseTestPrefixArgs", () => {
  // The dedupe set is module-level state; clear it between tests so each
  // case starts from a clean "no values warned yet" baseline.
  afterEach(() => {
    _resetParseTestPrefixArgsDedupe();
    mock.restoreAll();
  });

  it("returns undefined for undefined input without warning", () => {
    const warn = mock.method(console, "warn", () => {});
    assert.equal(parseTestPrefixArgs(undefined), undefined);
    assert.equal(warn.mock.callCount(), 0);
  });

  it("returns undefined for malformed JSON and warns once", () => {
    const warn = mock.method(console, "warn", () => {});
    assert.equal(parseTestPrefixArgs("{not json"), undefined);
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0] as string, /isn't valid JSON/);
  });

  it("returns undefined for valid JSON that is not a string array", () => {
    const warn = mock.method(console, "warn", () => {});
    // Object payload -- valid JSON, wrong shape.
    assert.equal(parseTestPrefixArgs('{"foo":"bar"}'), undefined);
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0] as string, /must parse to a string array/);
  });

  it("returns undefined for a JSON array containing a non-string element", () => {
    const warn = mock.method(console, "warn", () => {});
    assert.equal(parseTestPrefixArgs('["ok", 42]'), undefined);
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0] as string, /must parse to a string array/);
  });

  it("dedupes per malformed value: same input called twice warns ONCE total", () => {
    const warn = mock.method(console, "warn", () => {});
    parseTestPrefixArgs("{not json");
    parseTestPrefixArgs("{not json");
    parseTestPrefixArgs("{not json");
    assert.equal(warn.mock.callCount(), 1, "expected exactly one warn for repeated identical malformed input");
  });

  it("warns again for a NEW malformed value even when a different value was malformed earlier", () => {
    // Closes the "warn-once is per-value, not per-process" property: an
    // earlier malformed value should not silence the warn for a fresh one.
    const warn = mock.method(console, "warn", () => {});
    parseTestPrefixArgs("{not json");
    assert.equal(warn.mock.callCount(), 1);
    parseTestPrefixArgs('{"foo":"bar"}'); // different malformed value
    assert.equal(warn.mock.callCount(), 2, "expected a fresh warn for a new malformed value");
    parseTestPrefixArgs('{"foo":"bar"}'); // and that new value is now itself deduped
    assert.equal(warn.mock.callCount(), 2);
  });

  it("returns the parsed array for a valid string-array JSON without warning", () => {
    const warn = mock.method(console, "warn", () => {});
    assert.deepEqual(parseTestPrefixArgs('["a","b"]'), ["a", "b"]);
    assert.equal(warn.mock.callCount(), 0);
  });
});
