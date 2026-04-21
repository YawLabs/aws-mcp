/**
 * Integration tests for the SSO login subprocess flow. These spawn a real
 * child process (no mocking), pointed at a controlled fake aws binary via
 * startSsoLogin's command/prefixArgs/env overrides.
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { _clearSessions, startSsoLogin, waitForLogin } from "./sso.js";

// This test file compiles to dist/sso.integration.test.js and the fake lives
// at dist/testing/fake-aws.js. Resolve relative to the compiled location.
const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AWS = join(__dirname, "testing", "fake-aws.js");

function fakeOpts(scenario: string, urlWaitMs = 500) {
  return {
    command: process.execPath,
    prefixArgs: [FAKE_AWS],
    urlWaitMs,
    env: { ...process.env, AWS_MCP_FAKE_SCENARIO: scenario },
  };
}

afterEach(() => {
  _clearSessions();
});

describe("startSsoLogin — happy path", () => {
  it("parses URL + code from fake output and returns a session", async () => {
    const result = await startSsoLogin("test-profile", fakeOpts("happy", 5000));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.verificationUrl, "https://device.sso.us-east-1.amazonaws.com/");
    assert.equal(result.userCode, "ABCD-EFGH");
    assert.equal(result.profile, "test-profile");
    assert.match(result.sessionId, /^[0-9a-f-]{36}$/);
  });

  it("waitForLogin resolves ok=true when the fake exits cleanly", async () => {
    const start = await startSsoLogin("test-profile", fakeOpts("happy", 5000));
    assert.equal(start.ok, true);
    if (!start.ok) return;
    const wait = await waitForLogin(start.sessionId);
    assert.equal(wait.ok, true);
    assert.equal(wait.exitCode, 0);
  });

  it("returns distinct sessionIds for concurrent logins", async () => {
    const [a, b] = await Promise.all([
      startSsoLogin("profile-a", fakeOpts("happy", 5000)),
      startSsoLogin("profile-b", fakeOpts("happy", 5000)),
    ]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    if (!a.ok || !b.ok) return;
    assert.notEqual(a.sessionId, b.sessionId);
    // Clean up both sessions
    await Promise.all([waitForLogin(a.sessionId), waitForLogin(b.sessionId)]);
  });
});

describe("startSsoLogin — failure paths", () => {
  it("returns an error when subprocess emits no URL within urlWaitMs", async () => {
    const result = await startSsoLogin("test-profile", fakeOpts("malformed", 300));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Timed out|exited before printing/);
  });

  it("returns an error when subprocess exits before emitting URL", async () => {
    const result = await startSsoLogin("test-profile", fakeOpts("exits_before_url", 2000));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /exited before printing|exited with code/);
  });

  it("returns an error when the command doesn't exist", async () => {
    const result = await startSsoLogin("test-profile", {
      command: "this-binary-does-not-exist-xyz123",
      urlWaitMs: 500,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Failed to (spawn|run)|ENOENT/);
  });

  it("returns the URL+code on start, but waitForLogin reports nonzero exit", async () => {
    const start = await startSsoLogin("test-profile", fakeOpts("early_exit_failure", 2000));
    assert.equal(start.ok, true);
    if (!start.ok) return;
    assert.equal(start.userCode, "ABCD-EFGH");
    const wait = await waitForLogin(start.sessionId);
    assert.equal(wait.ok, false);
    assert.equal(wait.exitCode, 1);
    assert.ok(wait.error);
  });
});

describe("waitForLogin — session management", () => {
  it("returns error for unknown sessionId", async () => {
    const result = await waitForLogin("00000000-0000-0000-0000-000000000000");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /No active login session/);
  });

  it("drops session after wait resolves (calling twice returns error)", async () => {
    const start = await startSsoLogin("test-profile", fakeOpts("happy", 5000));
    assert.equal(start.ok, true);
    if (!start.ok) return;
    const first = await waitForLogin(start.sessionId);
    assert.equal(first.ok, true);
    const second = await waitForLogin(start.sessionId);
    assert.equal(second.ok, false);
    assert.match(second.error ?? "", /No active login session/);
  });
});
