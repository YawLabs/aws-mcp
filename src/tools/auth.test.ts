import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { classifyAuthError, findCachedSsoToken } from "./auth.js";

describe("classifyAuthError", () => {
  it("detects SSOTokenProviderFailure by name", () => {
    const err = new Error("No cached SSO token found");
    err.name = "SSOTokenProviderFailure";
    assert.equal(classifyAuthError(err).kind, "sso_expired");
  });

  it("detects ExpiredTokenException by name", () => {
    const err = new Error("The security token included in the request is expired");
    err.name = "ExpiredTokenException";
    assert.equal(classifyAuthError(err).kind, "sso_expired");
  });

  it("detects SSO expiry by message content", () => {
    const err = new Error("The SSO session associated with this profile has expired or is otherwise invalid");
    assert.equal(classifyAuthError(err).kind, "sso_expired");
  });

  it("detects 'token is expired' phrasing", () => {
    const err = new Error("Provided token is expired");
    assert.equal(classifyAuthError(err).kind, "sso_expired");
  });

  it("detects missing credentials", () => {
    const err = new Error("Could not load credentials from any providers");
    err.name = "CredentialsProviderError";
    assert.equal(classifyAuthError(err).kind, "no_creds");
  });

  it("falls back to 'other' for unrelated errors", () => {
    const err = new Error("connect ECONNREFUSED 169.254.169.254:80");
    assert.equal(classifyAuthError(err).kind, "other");
  });

  it("handles non-Error inputs", () => {
    assert.equal(classifyAuthError("a bare string error").kind, "other");
    assert.equal(classifyAuthError(undefined).kind, "other");
  });

  it("preserves the original message in the returned object", () => {
    const err = new Error("Some specific failure text");
    assert.equal(classifyAuthError(err).message, "Some specific failure text");
  });
});

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
});
