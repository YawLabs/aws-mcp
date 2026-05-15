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

function fakeOptsWithTtl(scenario: string, sessionTtlMs: number, urlWaitMs = 500) {
  return { ...fakeOpts(scenario, urlWaitMs), sessionTtlMs };
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

  it("settles via the async proc.on('error') handler before URL+code arrive", async () => {
    // Reliable trigger: Node's child_process.spawn for a nonexistent binary
    // returns a ChildProcess on both POSIX and Windows, then emits the
    // 'error' event asynchronously (ENOENT). The sync-throw codepath at
    // sso.ts:199-205 produces "Failed to spawn ..."; the async handler at
    // sso.ts:345-371 produces "Failed to run ...". Asserting the async
    // message variant pins the async handler. Lives in sso.integration
    // because it requires a real subprocess spawn -- the alternative would
    // be to factor the handler body into an exported helper like
    // _ttlKillswitchTick, but the existing real-subprocess "command doesn't
    // exist" test next door makes this the closer fit.
    const start = await startSsoLogin("async-err-profile", {
      command: "this-binary-does-not-exist-async-trigger-yyy",
      urlWaitMs: 2000,
    });
    assert.equal(start.ok, false);
    if (start.ok) return;
    assert.match(
      start.error,
      /Failed to run/,
      "async error handler should produce 'Failed to run', not 'Failed to spawn'",
    );
    assert.match(start.error, /AWS CLI installed and on PATH/);
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

describe("startSsoLogin — TTL killswitch", () => {
  it("a stuck subprocess past the TTL is killed and the wait reports session expired", async () => {
    // The 'happy' fake emits URL+code immediately, then sleeps 200ms before
    // exiting 0. With sessionTtlMs=20ms the killswitch fires mid-sleep,
    // SIGTERM lands, and the exit handler -- the SOLE writer of the
    // completion result -- reports the expiry. Closes the prior race where
    // the TTL handler resolved completion directly while the subprocess
    // was simultaneously about to exit 0 with a successful token cache.
    const start = await startSsoLogin("ttl-stuck-profile", fakeOptsWithTtl("happy", 20, 5000));
    assert.equal(start.ok, true);
    if (!start.ok) return;
    const wait = await waitForLogin(start.sessionId);
    assert.equal(wait.ok, false);
    assert.match(wait.error ?? "", /SSO login session expired/);
  });

  it("a subprocess that finishes BEFORE the TTL fires reports natural success (clearTimeout suppresses TTL)", async () => {
    // 'happy' exits 0 at ~200ms; with sessionTtlMs=5000ms the exit handler
    // fires first, clears the timer, and reports success. Verifies the
    // killswitch isn't gratuitously punishing a normal-cadence login.
    const start = await startSsoLogin("ttl-quick-profile", fakeOptsWithTtl("happy", 5000, 5000));
    assert.equal(start.ok, true);
    if (!start.ok) return;
    const wait = await waitForLogin(start.sessionId);
    assert.equal(wait.ok, true);
    assert.equal(wait.exitCode, 0);
  });

  it("a natural non-zero exit before TTL fires reports the natural error, not 'session expired'", async () => {
    // Regression coverage for the new exit-handler logic. The exit handler
    // is now the sole writer of the completion result and decides between
    // three branches (expiry / success / natural error) based on
    // ttlExpired and code. This test pins the natural-error branch:
    //
    //   'early_exit_failure' prints URL+code, writes "Error: connection
    //   refused" to stderr, sleeps 50ms, then exits 1. With TTL=200ms,
    //   the exit handler runs at ~50ms, clearTimeout suppresses the TTL,
    //   ttlExpired stays false, and the wait result must report
    //   "exited with code 1", NOT "session expired". A bug in the
    //   ttlExpired logic (e.g. setting it on every exit) would surface
    //   here as a misclassification.
    //
    // The microsecond TTL-vs-exit race window (proc.exitCode set but
    // 'exit' event not yet dispatched when the TTL callback runs) is
    // closed by the exitCode/signalCode guard in the TTL callback by
    // inspection -- driving that exact ordering deterministically would
    // require timer mocks. The aws-cli.ts:199-200 guard uses the same
    // pattern and is similarly verified by inspection.
    const start = await startSsoLogin("ttl-natural-fail-profile", fakeOptsWithTtl("early_exit_failure", 200, 5000));
    assert.equal(start.ok, true);
    if (!start.ok) return;
    const wait = await waitForLogin(start.sessionId);
    assert.equal(wait.ok, false);
    assert.equal(wait.exitCode, 1);
    assert.doesNotMatch(wait.error ?? "", /session expired/i);
    assert.match(wait.error ?? "", /exited with code 1/);
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
