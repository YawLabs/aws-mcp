import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runAwsCall, SAFE_NAME_RE } from "./aws-cli.js";

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
