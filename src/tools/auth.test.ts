import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { authTools, findCachedSsoToken } from "./auth.js";

describe("findCachedSsoToken", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "aws-mcp-test-"));
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("returns null when cache dir is empty", () => {
    assert.equal(findCachedSsoToken(cacheDir), null);
  });

  it("returns null when cache dir does not exist", () => {
    rmSync(cacheDir, { recursive: true, force: true });
    assert.equal(findCachedSsoToken(cacheDir), null);
  });

  it("returns the token when a valid non-expired token file exists", () => {
    const future = new Date(Date.now() + 3600_000).toISOString(); // +1h
    writeFileSync(
      join(cacheDir, "abc123.json"),
      JSON.stringify({
        accessToken: "secret-token",
        expiresAt: future,
        startUrl: "https://d-xxxxxxxxxx.awsapps.com/start",
      }),
    );
    const result = findCachedSsoToken(cacheDir);
    assert.ok(result);
    assert.equal(result.expiresAt, future);
    assert.equal(result.startUrl, "https://d-xxxxxxxxxx.awsapps.com/start");
    assert.ok(result.minutesLeft >= 59 && result.minutesLeft <= 60);
  });

  it("ignores expired tokens", () => {
    const past = new Date(Date.now() - 3600_000).toISOString(); // -1h
    writeFileSync(join(cacheDir, "abc123.json"), JSON.stringify({ accessToken: "secret-token", expiresAt: past }));
    assert.equal(findCachedSsoToken(cacheDir), null);
  });

  it("picks a valid token even if an expired one is also present", () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    const future = new Date(Date.now() + 3600_000).toISOString();
    writeFileSync(join(cacheDir, "expired.json"), JSON.stringify({ accessToken: "old", expiresAt: past }));
    writeFileSync(
      join(cacheDir, "valid.json"),
      JSON.stringify({ accessToken: "new", expiresAt: future, startUrl: "https://x.awsapps.com/start" }),
    );
    const result = findCachedSsoToken(cacheDir);
    assert.ok(result);
    assert.equal(result.startUrl, "https://x.awsapps.com/start");
  });

  it("ignores malformed JSON files without crashing", () => {
    writeFileSync(join(cacheDir, "broken.json"), "{ not json");
    const future = new Date(Date.now() + 3600_000).toISOString();
    writeFileSync(join(cacheDir, "good.json"), JSON.stringify({ accessToken: "t", expiresAt: future }));
    const result = findCachedSsoToken(cacheDir);
    assert.ok(result);
  });

  it("ignores files that lack required fields", () => {
    writeFileSync(join(cacheDir, "partial.json"), JSON.stringify({ accessToken: "t" }));
    assert.equal(findCachedSsoToken(cacheDir), null);
  });

  it("skips non-json files in the cache directory", () => {
    writeFileSync(join(cacheDir, "ignore-me.txt"), "not a token");
    mkdirSync(join(cacheDir, "subdir"));
    assert.equal(findCachedSsoToken(cacheDir), null);
  });

  it("skips .json files larger than the cap without blocking", () => {
    // A pathological oversized file should not be parsed. Real tokens are a
    // few KB; the cap is 64 KB. Write 128 KB and expect it ignored.
    writeFileSync(join(cacheDir, "huge.json"), "x".repeat(128 * 1024));
    const future = new Date(Date.now() + 3600_000).toISOString();
    writeFileSync(join(cacheDir, "good.json"), JSON.stringify({ accessToken: "t", expiresAt: future }));
    const result = findCachedSsoToken(cacheDir);
    assert.ok(result, "small valid token should still be found");
    assert.equal(result.expiresAt, future);
  });
});

describe("aws_refresh_if_expiring_soon schema", () => {
  const tool = authTools.find((t) => t.name === "aws_refresh_if_expiring_soon");
  if (!tool) throw new Error("aws_refresh_if_expiring_soon not registered");

  it("accepts an empty object (all defaults)", () => {
    assert.equal(tool.inputSchema.safeParse({}).success, true);
  });

  it("accepts thresholdMinutes and profile", () => {
    assert.equal(tool.inputSchema.safeParse({ thresholdMinutes: 15, profile: "prod" }).success, true);
  });

  it("rejects zero or negative thresholdMinutes", () => {
    assert.equal(tool.inputSchema.safeParse({ thresholdMinutes: 0 }).success, false);
    assert.equal(tool.inputSchema.safeParse({ thresholdMinutes: -5 }).success, false);
  });

  it("rejects non-integer thresholdMinutes", () => {
    assert.equal(tool.inputSchema.safeParse({ thresholdMinutes: 5.5 }).success, false);
  });
});
