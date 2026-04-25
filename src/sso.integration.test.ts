/**
 * Integration tests for the SSO login subprocess flow. These spawn a real
 * child process (no mocking), pointed at a controlled fake aws binary via
 * startSsoLogin's command/prefixArgs/env overrides.
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { _clearSessions, findActiveSessionByProfile, startSsoLogin, waitForLogin } from "./sso.js";

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

describe("findActiveSessionByProfile — dedupe helper", () => {
  it("returns null when no session is active for the profile", () => {
    assert.equal(findActiveSessionByProfile("nobody"), null);
  });

  it("returns the live session's URL/code for the matching profile", async () => {
    const start = await startSsoLogin("dedupe-profile", fakeOpts("happy", 5000));
    assert.equal(start.ok, true);
    if (!start.ok) return;
    const active = findActiveSessionByProfile("dedupe-profile");
    assert.ok(active, "expected an active session for dedupe-profile");
    assert.equal(active.sessionId, start.sessionId);
    assert.equal(active.verificationUrl, start.verificationUrl);
    assert.equal(active.userCode, start.userCode);
    // A different profile should NOT see this session.
    assert.equal(findActiveSessionByProfile("some-other-profile"), null);
    await waitForLogin(start.sessionId);
  });

  it("stops returning a session after waitForLogin resolves it", async () => {
    const start = await startSsoLogin("transient-profile", fakeOpts("happy", 5000));
    assert.equal(start.ok, true);
    if (!start.ok) return;
    await waitForLogin(start.sessionId);
    assert.equal(findActiveSessionByProfile("transient-profile"), null);
  });

  it("excludes completed sessions before waitForLogin is called", async () => {
    // The 'happy' fake exits 200ms after emitting URL+code. Wait for the exit
    // to fire (which marks completed=true) before querying.
    const start = await startSsoLogin("post-exit-profile", fakeOpts("happy", 5000));
    assert.equal(start.ok, true);
    if (!start.ok) return;
    // While the subprocess is still alive, the session is active.
    assert.ok(findActiveSessionByProfile("post-exit-profile"));
    // Wait for the fake to exit (~200ms) plus a small margin.
    await new Promise<void>((resolve) => setTimeout(resolve, 400));
    // After exit but before waitForLogin: session is in the map but completed.
    // findActiveSessionByProfile must skip it so a follow-up aws_login_start
    // doesn't re-surface stale URL+code.
    assert.equal(findActiveSessionByProfile("post-exit-profile"), null);
    // waitForLogin still works -- the completion result is preserved.
    const wait = await waitForLogin(start.sessionId);
    assert.equal(wait.ok, true);
  });
});

describe("startSsoLogin — concurrent dedup", () => {
  it("two concurrent calls for the same profile share one subprocess", async () => {
    const [a, b] = await Promise.all([
      startSsoLogin("race-profile", fakeOpts("happy", 5000)),
      startSsoLogin("race-profile", fakeOpts("happy", 5000)),
    ]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    if (!a.ok || !b.ok) return;
    // Same profile -> same in-flight promise -> same sessionId.
    assert.equal(a.sessionId, b.sessionId);
    assert.equal(a.verificationUrl, b.verificationUrl);
    assert.equal(a.userCode, b.userCode);
    await waitForLogin(a.sessionId);
  });

  it("a fresh start after the previous completes spawns a new subprocess", async () => {
    const first = await startSsoLogin("re-spawn-profile", fakeOpts("happy", 5000));
    assert.equal(first.ok, true);
    if (!first.ok) return;
    await waitForLogin(first.sessionId);
    // Pending dedup map self-cleans on settle -- the next call must NOT reuse.
    const second = await startSsoLogin("re-spawn-profile", fakeOpts("happy", 5000));
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.notEqual(first.sessionId, second.sessionId);
    await waitForLogin(second.sessionId);
  });
});
