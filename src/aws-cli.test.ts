import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactDisplayArgs, runAwsCall, SAFE_NAME_RE, truncateForErrorMsg } from "./aws-cli.js";

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
