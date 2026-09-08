/**
 * Integration tests for the SSO login subprocess flow. These spawn a real
 * child process (no mocking), pointed at a controlled fake aws binary via
 * startSsoLogin's command/prefixArgs/env overrides.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  _clearCliVersionCache,
  _clearSessions,
  _hasSession,
  findActiveSessionByProfile,
  startSsoLogin,
  waitForLogin,
} from "./sso.js";

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

/**
 * Poll `predicate` until it holds or the deadline passes. Replaces
 * `await sleep(400)`-style waits that assume the `happy` fake's ~200ms exit
 * has landed.
 *
 * Why this exists: `node --test` runs test FILES in parallel (one child
 * process each, defaulting to the CPU count). A fixed sleep sized against the
 * fake's 200ms exit is fine on an idle machine and unreliable under a
 * 26-file/12-core run, where scheduling delay routinely pushes the real exit
 * past the sleep. Verified 2026-08-07: the full suite serialized with
 * `--test-concurrency=1` was 711/711 green across a full run, while the same
 * suite in parallel failed ~2 of 3 runs on a DIFFERENT timing test each time.
 * Waiting on the condition instead of the clock removes the load coupling
 * without weakening the assertion -- a predicate that never holds still fails,
 * it just fails on a real timeout rather than on an unlucky scheduler.
 */
async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitUntil timed out after ${timeoutMs}ms waiting for: ${label}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
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
    // Generous urlWaitMs on purpose. This asserts WHICH path wins (the exit
    // handler, not the URL timeout), and the fake exits after 50ms -- so a
    // healthy run settles in ~100ms and never approaches this bound. At 2000ms
    // it lost the race under a loaded parallel run where the child had not
    // finished booting yet, and reported a timeout instead of the exit.
    const result = await startSsoLogin("test-profile", fakeOpts("exits_before_url", 10_000));
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

  // The proc.on('error') branch at sso.ts:383-409 has TWO reachable states:
  //
  //   (1) error BEFORE URL+code arrive (settled=false, no session registered):
  //       covered by "settles via the async proc.on('error') handler before
  //       URL+code arrive" above -- a nonexistent binary emits ENOENT on the
  //       proc itself, the handler resolves the START promise with "Failed to
  //       run ...".
  //
  //   (2) error AFTER URL+code arrive (settled=true, session registered): the
  //       handler instead resolves `completion` so a waitForLogin caller that
  //       already holds the sessionId doesn't hang. This state is NOT
  //       deterministically triggerable from real subprocess input. Node fires
  //       'error' on the ChildProcess for spawn failure (ENOENT/EACCES) or a
  //       failed kill -- none of which can occur AFTER the child has already
  //       spawned and written URL+code to stdout. Tearing the child's stdio
  //       surfaces errors on proc.stdout/proc.stderr (separate EventEmitters),
  //       not on `proc` itself, so it never reaches this handler. Forcing the
  //       state would require a synthetic EventEmitter masquerading as a
  //       ChildProcess and re-implementing the spawn wiring -- a brittle mock
  //       of Node internals, not a behavioral test. Per the test brief we do
  //       NOT force it. The completion-resolve path is instead exercised
  //       indirectly: the 'exit' handler (sso.ts:323-381) is the common case
  //       that resolves `completion` after a registered session, and it is
  //       covered by the early_exit_failure / TTL tests below.
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
    // Uses `happy_hold` (NOT `happy`): the fake stays alive until killed, so
    // the session's `completed` flag stays false deterministically. With
    // `happy` the 200ms exit could fire before the synchronous
    // findActiveSessionByProfile assertion below, mark the session completed,
    // and exclude it -- a load-dependent flake. `happy_hold` emits the
    // identical URL+code stdout, so the parsed verificationUrl/userCode match.
    const start = await startSsoLogin("dedupe-profile", fakeOpts("happy_hold", 5000));
    assert.equal(start.ok, true);
    if (!start.ok) return;
    const active = findActiveSessionByProfile("dedupe-profile");
    assert.ok(active, "expected an active session for dedupe-profile");
    assert.equal(active.sessionId, start.sessionId);
    assert.equal(active.verificationUrl, start.verificationUrl);
    assert.equal(active.userCode, start.userCode);
    // A different profile should NOT see this session.
    assert.equal(findActiveSessionByProfile("some-other-profile"), null);
    // No waitForLogin here -- the fake won't exit on its own. afterEach's
    // _clearSessions() kills the held subprocess and clears the session map,
    // so teardown is prompt (a SIGTERM/SIGKILL, not the 10-min sleep).
  });

  it("stops returning a session after waitForLogin resolves it", async () => {
    const start = await startSsoLogin("transient-profile", fakeOpts("happy", 5000));
    assert.equal(start.ok, true);
    if (!start.ok) return;
    await waitForLogin(start.sessionId);
    assert.equal(findActiveSessionByProfile("transient-profile"), null);
  });

  it("excludes completed sessions before waitForLogin is called", async () => {
    // The 'happy' fake exits ~200ms after emitting URL+code, which flips the
    // session to completed. This test is about the POST-exit exclusion.
    const start = await startSsoLogin("post-exit-profile", fakeOpts("happy", 5000));
    assert.equal(start.ok, true);
    if (!start.ok) return;
    // NOTE: deliberately no "still alive" assertion here. It used to sit at
    // this line and was the flakiest assertion in the suite -- it only holds if
    // this synchronous check wins a race against the fake's 200ms exit, which
    // it loses under a parallel full-suite run. The live-session property is
    // covered deterministically by the `happy_hold` test above, which uses a
    // fake that cannot exit on its own.
    await waitUntil(
      () => findActiveSessionByProfile("post-exit-profile") === null,
      "the completed session to be excluded from findActiveSessionByProfile",
    );
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
    // Uses `happy_hold`, NOT `happy`. `happy_hold` emits URL+code and then
    // stays alive until killed, so the TTL killswitch is the ONLY thing that
    // can end it -- which is exactly the behavior under test. With `happy`
    // (exits 0 at ~200ms) this raced: a 20ms TTL beats a 200ms exit on an idle
    // machine, but under a parallel full-suite run the TTL callback can be
    // delayed past 200ms, the fake exits 0 on its own, the exitCode guard in
    // _ttlKillswitchTick correctly declines to kill an already-dead proc, and
    // the wait reports natural SUCCESS -- failing an assertion that demanded
    // expiry. The kill path is now load-independent.
    const start = await startSsoLogin("ttl-stuck-profile", fakeOptsWithTtl("happy_hold", 20, 5000));
    assert.equal(start.ok, true);
    if (!start.ok) return;
    const wait = await waitForLogin(start.sessionId);
    assert.equal(wait.ok, false);
    assert.match(wait.error ?? "", /SSO login session expired/);
  });

  it("a subprocess that finishes BEFORE the TTL fires reports natural success (clearTimeout suppresses TTL)", async () => {
    // 'happy' exits 0 at ~200ms; the exit handler fires first, clears the
    // timer, and reports success. Verifies the killswitch isn't gratuitously
    // punishing a normal-cadence login.
    //
    // The TTL is deliberately enormous relative to the exit. For a test whose
    // premise is "the TTL must NOT fire", the only thing a tight TTL buys is a
    // race -- and it costs nothing to remove, because the test never WAITS for
    // the TTL: it waits for the natural exit, which clears the (unref'd) timer.
    const start = await startSsoLogin("ttl-quick-profile", fakeOptsWithTtl("happy", 30_000, 5000));
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
    //   refused" to stderr, sleeps 50ms, then exits 1. The exit handler runs
    //   at ~50ms, clearTimeout suppresses the TTL, ttlExpired stays false, and
    //   the wait result must report "exited with code 1", NOT "session
    //   expired". A bug in the ttlExpired logic (e.g. setting it on every
    //   exit) would surface here as a misclassification.
    //
    //   The TTL was 200ms against that 50ms exit -- a 4x margin, the tightest
    //   in this file, and the last surviving flake after the happy_hold
    //   migration. Under a parallel full-suite run the exit slips past 200ms,
    //   the killswitch fires, and the result flips to "session expired",
    //   failing the doesNotMatch below. Measured: 2 failures in 4 consecutive
    //   full runs. Same reasoning as the sibling test above -- this test never
    //   waits for the TTL, so a huge TTL costs nothing and removes the race.
    //
    // The microsecond TTL-vs-exit race window (proc.exitCode set but
    // 'exit' event not yet dispatched when the TTL callback runs) is
    // closed by the exitCode/signalCode guard in the TTL callback by
    // inspection -- driving that exact ordering deterministically would
    // require timer mocks. The aws-cli.ts:199-200 guard uses the same
    // pattern and is similarly verified by inspection.
    const start = await startSsoLogin("ttl-natural-fail-profile", fakeOptsWithTtl("early_exit_failure", 30_000, 5000));
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

  it("same profile, DIFFERENT opts -> distinct subprocesses (dedupe key includes opts)", async () => {
    // Pre-widening, the dedupe key was `profile` alone, so a second caller
    // with different opts (different fake scenario, different urlWaitMs)
    // would silently share the first caller's promise -- the second's opts
    // were ignored. After widening to hash(profile + canonical opts),
    // distinct opts must produce distinct subprocesses even when the
    // profile is identical. Pins the fix.
    const [a, b] = await Promise.all([
      startSsoLogin("opts-divergence-profile", fakeOpts("happy", 5000)),
      // Same profile string but different urlWaitMs -> different opts hash.
      startSsoLogin("opts-divergence-profile", fakeOpts("happy", 4000)),
    ]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    if (!a.ok || !b.ok) return;
    assert.notEqual(
      a.sessionId,
      b.sessionId,
      "different opts must produce distinct subprocesses (and distinct sessionIds)",
    );
    await Promise.all([waitForLogin(a.sessionId), waitForLogin(b.sessionId)]);
  });

  it("same profile, SAME env entries in DIFFERENT insertion order -> ONE subprocess (env hash is order-independent)", async () => {
    // Counterpart to the opts-divergence test above. dedupeKey canonicalizes
    // opts.env via Object.entries(...).sort() (sso.ts:106), so two callers
    // whose env carries the SAME key/value pairs but in different INSERTION
    // order must hash to the same key and share one subprocess. Without the
    // sort, JSON.stringify of the entries array would be insertion-ordered and
    // the two callers would spuriously spawn distinct subprocesses. We build
    // the same fakeOpts (identical urlWaitMs etc.) but hand each a freshly
    // ordered env object: one with AWS_MCP_FAKE_SCENARIO appended last, one
    // with a leading reorder marker -- both containing an identical set of
    // entries, just inserted in a different sequence.
    const baseScenario = "happy";
    // Pull a couple of stable keys out of process.env to reorder around the
    // scenario key. Using literal keys keeps the entry SET identical across
    // both objects regardless of what process.env contains.
    const shared = { AWS_MCP_FAKE_SCENARIO: baseScenario, AWS_MCP_REORDER_A: "1", AWS_MCP_REORDER_B: "2" };
    const optsForward = {
      command: process.execPath,
      prefixArgs: [FAKE_AWS],
      urlWaitMs: 5000,
      // Insertion order: SCENARIO, then A, then B.
      env: {
        AWS_MCP_FAKE_SCENARIO: shared.AWS_MCP_FAKE_SCENARIO,
        AWS_MCP_REORDER_A: shared.AWS_MCP_REORDER_A,
        AWS_MCP_REORDER_B: shared.AWS_MCP_REORDER_B,
      },
    };
    const optsReversed = {
      command: process.execPath,
      prefixArgs: [FAKE_AWS],
      urlWaitMs: 5000,
      // Same three entries, reversed insertion order: B, then A, then SCENARIO.
      env: {
        AWS_MCP_REORDER_B: shared.AWS_MCP_REORDER_B,
        AWS_MCP_REORDER_A: shared.AWS_MCP_REORDER_A,
        AWS_MCP_FAKE_SCENARIO: shared.AWS_MCP_FAKE_SCENARIO,
      },
    };
    const [a, b] = await Promise.all([
      startSsoLogin("env-reorder-profile", optsForward),
      startSsoLogin("env-reorder-profile", optsReversed),
    ]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    if (!a.ok || !b.ok) return;
    assert.equal(
      a.sessionId,
      b.sessionId,
      "reordered-but-identical env entries must hash to the same dedupe key (one shared subprocess)",
    );
    assert.equal(a.verificationUrl, b.verificationUrl);
    assert.equal(a.userCode, b.userCode);
    await waitForLogin(a.sessionId);
  });
});

describe("completed-session reaping (bounds the sessions Map)", () => {
  // The reap exists because `sessions` was otherwise drained ONLY by
  // waitForLogin. A caller that runs aws_login_start and never
  // aws_login_complete left its entry -- plus the ChildProcess handle and the
  // captured stdout/stderr buffers -- alive for the life of the process. The
  // TTL killswitch kills the SUBPROCESS but does not reap the MAP ENTRY, so
  // the abandoned case it exists for still leaked.
  //
  // Production's grace window is 10 minutes, so these drive it through the
  // `completedReapMs` seam (mirrors `sessionTtlMs`). The observable is
  // waitForLogin: while the entry lives it returns the PRESERVED completion
  // result; once reaped it reports the unknown-session error.

  it("reaps an abandoned completed session out of the map", async () => {
    // 'happy' exits ~200ms after URL+code, which completes the session. Nobody
    // calls waitForLogin -- that IS the abandoned case, and before the reap it
    // meant the entry lived for the whole process lifetime.
    //
    // Observe via _hasSession, NOT waitForLogin: waitForLogin CLAIMS the entry,
    // so polling with it would delete the very thing under test and go green
    // whether or not the reap works.
    const start = await startSsoLogin("reaped-profile", { ...fakeOpts("happy", 5000), completedReapMs: 40 });
    assert.equal(start.ok, true);
    if (!start.ok) return;
    assert.ok(_hasSession(start.sessionId), "precondition: the session is registered");
    // Poll rather than sleep -- the ~200ms exit plus the 40ms grace is real
    // wall-clock, and a fixed sleep would reintroduce the load-coupled flake
    // this suite was just cleaned of.
    await waitUntil(() => !_hasSession(start.sessionId), "the abandoned session to be reaped out of the sessions map");
  });

  it("does NOT reap before the grace window -- a late aws_login_complete still works", async () => {
    // The grace window is the whole reason the reap isn't immediate: a user who
    // finishes auth slowly must still be able to claim the result. A generous
    // window means the claim below cannot race the reap.
    const start = await startSsoLogin("grace-profile", { ...fakeOpts("happy", 5000), completedReapMs: 30_000 });
    assert.equal(start.ok, true);
    if (!start.ok) return;
    // Let the subprocess exit (completing the session) without claiming it.
    await waitUntil(
      () => findActiveSessionByProfile("grace-profile") === null,
      "the subprocess to exit and complete the session",
    );
    assert.ok(_hasSession(start.sessionId), "a completed session must survive its grace window");
    const wait = await waitForLogin(start.sessionId);
    assert.equal(wait.ok, true, "a completed-but-unreaped session must still be claimable");
    assert.equal(wait.exitCode, 0);
  });

  it("claiming a session cancels its reap: no late side effect after the window elapses", async () => {
    // Hygiene guard, not a behavioral one -- waitForLogin already deleted the
    // entry, and session ids are UUIDs so a stray reap could not collide with a
    // later session. What this pins is that the post-claim state stays stable
    // across the moment the cancelled reap would have fired.
    const start = await startSsoLogin("claimed-profile", { ...fakeOpts("happy", 5000), completedReapMs: 30 });
    assert.equal(start.ok, true);
    if (!start.ok) return;
    const first = await waitForLogin(start.sessionId);
    assert.equal(first.ok, true);
    assert.equal(_hasSession(start.sessionId), false, "the claim removes the entry immediately");
    // Let the (now-cancelled) reap window pass.
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    assert.equal(_hasSession(start.sessionId), false);
    const second = await waitForLogin(start.sessionId);
    assert.equal(second.ok, false);
    assert.match(second.error ?? "", /No active login session/);
    assert.equal(findActiveSessionByProfile("claimed-profile"), null);
  });
});

describe("startSsoLogin — PKCE / device-code flow selection", () => {
  it("passes --use-device-code when the probed CLI is >= 2.22.0", async () => {
    // Self-contained: the probe cache is shared by every test in this file, so
    // clear it here rather than depending on execution order.
    _clearCliVersionCache();
    const start = await startSsoLogin("test-profile", fakeOpts("device_code_flag_echo", 5000));
    assert.equal(start.ok, true);
    if (!start.ok) return;
    const wait = await waitForLogin(start.sessionId);
    assert.match(wait.rawOutput ?? "", /ARGV:.*--use-device-code/);
    // Ordering matters: the flag must not land where --profile expects a value.
    assert.match(wait.rawOutput ?? "", /--no-browser --use-device-code --profile test-profile/);
  });

  it("omits --use-device-code when the probed CLI predates 2.22.0", async () => {
    // Self-contained: the probe cache is shared by every test in this file, so
    // clear it here rather than depending on execution order.
    _clearCliVersionCache();
    const opts = fakeOpts("device_code_flag_echo", 5000);
    const start = await startSsoLogin("test-profile", {
      ...opts,
      env: { ...opts.env, AWS_MCP_FAKE_CLI_VERSION: "2.21.9" },
    });
    assert.equal(start.ok, true);
    if (!start.ok) return;
    const wait = await waitForLogin(start.sessionId);
    // Positive first -- a bare doesNotMatch would also pass if rawOutput were
    // empty or the scenario stopped echoing its argv at all.
    assert.match(wait.rawOutput ?? "", /ARGV:sso login --no-browser --profile test-profile/);
    assert.doesNotMatch(wait.rawOutput ?? "", /--use-device-code/);
  });

  it("names the PKCE flow instead of timing out when no short code is printed", async () => {
    // urlWaitMs is deliberately long: a pass here must come from the PKCE
    // detector firing, not from the URL timeout expiring first.
    const result = await startSsoLogin("test-profile", {
      ...fakeOpts("pkce_no_device_code", 10_000),
      useDeviceCode: true,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /PKCE authorization-code flow/);
    assert.match(result.error, /did not honor it/);
    assert.doesNotMatch(result.error, /Timed out/);
    assert.match(result.rawOutput ?? "", /oidc\.us-east-1\.amazonaws\.com\/authorize/);
  });

  it("detects the PKCE banner when it lands on stderr instead of stdout", async () => {
    const result = await startSsoLogin("test-profile", {
      ...fakeOpts("pkce_no_device_code_stderr", 10_000),
      useDeviceCode: true,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /PKCE authorization-code flow/);
    assert.doesNotMatch(result.error, /Timed out/);
  });

  it("blames the CLI version when the flag was skipped", async () => {
    const result = await startSsoLogin("test-profile", {
      ...fakeOpts("pkce_no_device_code", 10_000),
      useDeviceCode: false,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /older than 2\.22\.0/);
  });

  it("treats an unparseable `aws --version` as device-code-capable", async () => {
    // Self-contained: the probe cache is shared by every test in this file, so
    // clear it here rather than depending on execution order.
    _clearCliVersionCache();
    const opts = fakeOpts("device_code_flag_echo", 5000);
    const start = await startSsoLogin("test-profile", {
      ...opts,
      env: { ...opts.env, AWS_MCP_FAKE_CLI_VERSION: "none" },
    });
    assert.equal(start.ok, true);
    if (!start.ok) return;
    const wait = await waitForLogin(start.sessionId);
    assert.match(wait.rawOutput ?? "", /--use-device-code/);
  });
});

describe("startSsoLogin — CLI version probe", () => {
  /**
   * Throwaway dir plus a probe-spawn counter path. The counter file is
   * APPENDED to (one byte per `aws --version` invocation), so its SIZE is the
   * number of times the probe actually spawned -- which is the thing these
   * tests are about. Same side-channel shape as AWS_MCP_FAKE_ARGV_OUT
   * elsewhere in the suite.
   */
  function counterOpts(scenario: string, extraEnv: Record<string, string> = {}, urlWaitMs = 10_000) {
    const dir = mkdtempSync(join(tmpdir(), "aws-mcp-version-probe-"));
    const countPath = join(dir, "probe-count");
    const base = fakeOpts(scenario, urlWaitMs);
    return {
      dir,
      probeCount: (): number => (existsSync(countPath) ? statSync(countPath).size : 0),
      opts: { ...base, env: { ...base.env, AWS_MCP_FAKE_VERSION_COUNT_OUT: countPath, ...extraEnv } },
    };
  }

  it("spawns 'aws --version' once for a binary, not once per login", async () => {
    _clearCliVersionCache();
    const { dir, probeCount, opts } = counterOpts("device_code_flag_echo");
    try {
      const a = await startSsoLogin("probe-cache-a", opts);
      const b = await startSsoLogin("probe-cache-b", opts);
      assert.equal(a.ok, true);
      assert.equal(b.ok, true);
      // Sanity first: proves the counter side channel is live, so the ===1
      // below is a real measurement and not a file that never got written.
      assert.ok(probeCount() >= 1, "probe never spawned -- counter side channel is broken");
      assert.equal(probeCount(), 1, "second login re-probed; the version cache is not being consulted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shares one in-flight probe across concurrent logins for different profiles", async () => {
    // The cache stores the PROMISE, not the resolved value, so two callers
    // racing on the same tick collapse onto one subprocess. This is the probe's
    // analogue of the pendingStarts guard; aws_login_start and
    // aws_refresh_if_expiring_soon firing together is the motivating case.
    _clearCliVersionCache();
    const { dir, probeCount, opts } = counterOpts("device_code_flag_echo");
    try {
      const [a, b] = await Promise.all([startSsoLogin("race-a", opts), startSsoLogin("race-b", opts)]);
      assert.equal(a.ok, true);
      assert.equal(b.ok, true);
      assert.equal(probeCount(), 1, "concurrent logins each spawned their own probe");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("probes separately when PATH changes, since PATH decides which binary resolves", async () => {
    // Both PATHs stay valid -- the fake is invoked by absolute path, so PATH is
    // not load-bearing for the spawn. Only the cache key should differ.
    _clearCliVersionCache();
    const { dir, probeCount, opts } = counterOpts("device_code_flag_echo");
    const basePath = process.env.PATH ?? "";
    try {
      const first = await startSsoLogin("path-a", {
        ...opts,
        env: { ...opts.env, PATH: `${basePath}${delimiter}/nonexistent-a` },
      });
      const second = await startSsoLogin("path-b", {
        ...opts,
        env: { ...opts.env, PATH: `${basePath}${delimiter}/nonexistent-b` },
      });
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      assert.equal(probeCount(), 2, "a different PATH reused another binary's cached verdict");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bounds a hung 'aws --version' and falls back to assume-modern", async () => {
    // The fake never answers and never exits, so the only thing that can
    // release this is the probe's own timeout -- the single bound on probe
    // latency, which sits IN FRONT of the user-facing URL wait.
    _clearCliVersionCache();
    const { dir, opts } = counterOpts("device_code_flag_echo", { AWS_MCP_FAKE_CLI_VERSION: "hang" }, 10_000);
    try {
      const started = Date.now();
      const start = await startSsoLogin("hung-probe", opts);
      const elapsed = Date.now() - started;
      assert.equal(start.ok, true);
      if (!start.ok) return;
      // Lower bound pins that the timeout is what released us. Upper bound
      // pins that it is a SHORT timeout, with generous headroom because this
      // file runs inside a loaded parallel test run.
      assert.ok(elapsed >= 2000, `released before the probe timeout could fire (${elapsed}ms)`);
      // The upper bound is deliberately loose. `elapsed` is spawn latency PLUS
      // the probe timeout, and only the second term is the thing under test:
      // spawning the fake costs 700-4200ms on a loaded Windows ARM64 runner
      // (measured), so a bound sized against the timeout alone fails on machine
      // speed rather than on a real regression. Observed doing exactly that at
      // 8000ms, roughly one full-suite run in five.
      //
      // What this still catches is the regression that matters -- someone
      // raising the probe timeout to a user-visible duration -- because the
      // probe sits IN FRONT of the URL wait, and 30s is far past anything a
      // caller would tolerate. Sharpening it back down means bounding spawn
      // latency separately, not tightening this number.
      assert.ok(elapsed < 30_000, `probe timeout is far longer than intended (${elapsed}ms)`);
      const wait = await waitForLogin(start.sessionId);
      assert.match(wait.rawOutput ?? "", /ARGV:sso login --no-browser --use-device-code/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses the version when the CLI prints it on stderr", async () => {
    // Asserting the flag is OMITTED is the strong form: if the stderr pipe were
    // ignored, the probe would see empty output, parse null, and assume-modern
    // -- which ADDS the flag. Only an actually-parsed 2.21.9 drops it.
    _clearCliVersionCache();
    const { dir, opts } = counterOpts("device_code_flag_echo", {
      AWS_MCP_FAKE_VERSION_STREAM: "stderr",
      AWS_MCP_FAKE_CLI_VERSION: "2.21.9",
    });
    try {
      const start = await startSsoLogin("stderr-version", opts);
      assert.equal(start.ok, true);
      if (!start.ok) return;
      const wait = await waitForLogin(start.sessionId);
      assert.match(wait.rawOutput ?? "", /ARGV:sso login --no-browser --profile stderr-version/);
      assert.doesNotMatch(wait.rawOutput ?? "", /--use-device-code/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops probe output past the byte cap, which degrades to assume-modern", async () => {
    // Two halves so the cap is provably the cause: same version string both
    // times, only the preceding volume of noise differs.
    _clearCliVersionCache();
    const small = counterOpts("device_code_flag_echo", {
      AWS_MCP_FAKE_CLI_VERSION: "2.21.9",
      AWS_MCP_FAKE_VERSION_NOISE_BYTES: "1024",
    });
    try {
      const start = await startSsoLogin("cap-under", small.opts);
      assert.equal(start.ok, true);
      if (!start.ok) return;
      const wait = await waitForLogin(start.sessionId);
      assert.doesNotMatch(
        wait.rawOutput ?? "",
        /--use-device-code/,
        "1 KB of noise should not have lost the version line",
      );
    } finally {
      rmSync(small.dir, { recursive: true, force: true });
    }

    _clearCliVersionCache();
    const huge = counterOpts("device_code_flag_echo", {
      AWS_MCP_FAKE_CLI_VERSION: "2.21.9",
      AWS_MCP_FAKE_VERSION_NOISE_BYTES: String(256 * 1024),
    });
    try {
      const start = await startSsoLogin("cap-over", huge.opts);
      assert.equal(start.ok, true);
      if (!start.ok) return;
      const wait = await waitForLogin(start.sessionId);
      // Past the cap the version line is never appended, so parsing yields
      // null and supportsDeviceCodeFlag(null) assumes modern -- flag present.
      assert.match(wait.rawOutput ?? "", /--use-device-code/, "version line past the cap should be dropped");
    } finally {
      rmSync(huge.dir, { recursive: true, force: true });
    }
  });
});

/**
 * clampRawOutput -- the gate on how much unfiltered `aws sso login` output
 * reaches the model.
 *
 * Every rawOutput/error string sso.ts hands back runs through it, and
 * tools/auth.ts forwards those straight into `rawBody` (auth.ts:345, :386,
 * :482). It is not exported, so the only way to exercise it is through a real
 * subprocess whose stdout length we control exactly -- hence the sso2_raw_*
 * fake scenarios rather than a unit test.
 *
 * Determinism: the fake writes filler FIRST and the URL+code banner LAST.
 * startSsoLogin settles only once both the URL and the code have been parsed,
 * so `start.ok === true` is proof the whole payload is already buffered; the
 * fake then holds for 250ms before exiting, so the 'exit' handler that computes
 * rawOutput cannot be racing a still-queued stdout chunk. No sleeps, no polling.
 */
describe("clampRawOutput -- the raw `aws sso login` output forwarded to the model", () => {
  // Mirrors MAX_RAW_OUTPUT_CHARS (sso.ts:42), which is module-private. The
  // duplication is deliberate and load-bearing: if the cap moves, these tests
  // must be a conscious update rather than silently re-deriving whatever the
  // source now does.
  const MAX_RAW_OUTPUT_CHARS = 4_000;
  // Mirrors the tail `sso2_raw_sized` / `sso2_raw_surrogate_boundary` append
  // (src/testing/fake-aws.ts). Byte-for-byte, or the exact-equality assertions
  // below fail -- which is the intended drift alarm.
  const SSO2_TAIL = "\nhttps://device.sso.us-east-1.amazonaws.com/\nABCD-EFGH\n";

  // startSsoLogin's options type is module-private; name it structurally rather
  // than re-declaring a parallel shape that could drift.
  type LoginOpts = NonNullable<Parameters<typeof startSsoLogin>[1]>;

  /** Build opts that make the fake emit EXACTLY `totalChars` of stdout. */
  function sizedRawOpts(totalChars: number): { expected: string; opts: LoginOpts } {
    const filler = totalChars - SSO2_TAIL.length;
    assert.ok(filler >= 0, `totalChars must be >= ${SSO2_TAIL.length} (the tail's own length)`);
    // urlWaitMs is deliberately long: these tests must settle on the parsed
    // URL+code, never on the URL timeout (a different clampRawOutput call site
    // with a different input).
    const base = fakeOpts("sso2_raw_sized", 10_000);
    return {
      expected: `${"x".repeat(filler)}${SSO2_TAIL}`,
      opts: { ...base, env: { ...base.env, AWS_MCP_FAKE_SSO2_FILLER: String(filler) } },
    };
  }

  async function rawOutputFor(profile: string, opts: LoginOpts): Promise<string> {
    const start = await startSsoLogin(profile, opts);
    assert.equal(start.ok, true, start.ok ? "" : `start failed: ${start.error}`);
    if (!start.ok) throw new Error("unreachable");
    const wait = await waitForLogin(start.sessionId);
    assert.equal(wait.ok, true, `expected a clean exit, got: ${wait.error}`);
    assert.ok(wait.rawOutput !== undefined, "rawOutput must be present on a clean exit");
    return wait.rawOutput;
  }

  it("passes output under the cap through unchanged", async () => {
    const { expected, opts } = sizedRawOpts(MAX_RAW_OUTPUT_CHARS - 1_000);
    const raw = await rawOutputFor("clamp-under-profile", opts);
    assert.equal(raw.length, MAX_RAW_OUTPUT_CHARS - 1_000, "a sub-cap payload must not change length");
    assert.equal(raw, expected, "a sub-cap payload must be forwarded byte-identical");
    assert.doesNotMatch(raw, /truncated/, "nothing under the cap may carry the truncation marker");
  });

  it("does NOT truncate at exactly the cap (the boundary is inclusive)", async () => {
    // The off-by-one that matters: `text.length <= MAX_RAW_OUTPUT_CHARS`
    // returns early. A `<` here would append a "[truncated 0 chars ...]" marker
    // to output that lost nothing.
    const { expected, opts } = sizedRawOpts(MAX_RAW_OUTPUT_CHARS);
    const raw = await rawOutputFor("clamp-boundary-profile", opts);
    assert.equal(raw.length, MAX_RAW_OUTPUT_CHARS, "output exactly at the cap must pass through at its own length");
    assert.equal(raw, expected);
    assert.doesNotMatch(raw, /truncated/, "exactly at the cap is NOT over the cap");
  });

  it("keeps the head and reports the exact omitted count when over the cap", async () => {
    const OVER = 1_234;
    const { expected, opts } = sizedRawOpts(MAX_RAW_OUTPUT_CHARS + OVER);
    const raw = await rawOutputFor("clamp-over-profile", opts);
    // Whole-string equality: pins the head, the marker wording, and the count
    // in one assertion, so a change to any of the three is visible.
    assert.equal(
      raw,
      `${expected.slice(0, MAX_RAW_OUTPUT_CHARS)}\n... [truncated ${OVER} chars of 'aws sso login' output]`,
    );
    // Spelled out separately because the count is the part a reader has to
    // trust: head + omitted must reconstruct the original length exactly.
    const omitted = Number(raw.match(/truncated (\d+) chars/)?.[1]);
    assert.equal(omitted, OVER);
    assert.equal(MAX_RAW_OUTPUT_CHARS + omitted, expected.length, "head + omitted must account for every input char");
    // The head is the head, not the tail: the URL+code banner sat past the cap
    // and is gone, while the leading filler survived.
    assert.equal(raw.slice(0, MAX_RAW_OUTPUT_CHARS), "x".repeat(MAX_RAW_OUTPUT_CHARS));
    assert.doesNotMatch(raw, /device\.sso/, "the tail past the cap must be dropped, not kept");
  });

  it("splits a surrogate pair at the cut, leaving a lone high surrogate (actual behavior)", async () => {
    // FINDING, documented rather than asserted-as-correct: clampRawOutput cuts
    // with a bare `text.slice(0, MAX_RAW_OUTPUT_CHARS)` (sso.ts:48).
    // String#slice counts UTF-16 code units, so a non-BMP character straddling
    // the boundary is severed and the head ends in a LONE HIGH SURROGATE.
    // aws-cli.ts:truncateForErrorMsg (aws-cli.ts:131-141) backs the cut off by
    // one unit for exactly this case; the clamp here does not. Both strings end
    // up in the same MCP response body, so the divergence is real.
    //
    // The fake places U+20BB7 (4 UTF-8 bytes, 2 UTF-16 units) at indices
    // 3999/4000 so the cut lands mid-pair every run -- nothing here is timing
    // dependent.
    const raw = await rawOutputFor("clamp-surrogate-profile", fakeOpts("sso2_raw_surrogate_boundary", 10_000));
    const payload = `${"x".repeat(3_999)}${"\u{20BB7}".repeat(8)}${SSO2_TAIL}`;
    const omitted = payload.length - MAX_RAW_OUTPUT_CHARS;
    assert.equal(
      raw,
      `${payload.slice(0, MAX_RAW_OUTPUT_CHARS)}\n... [truncated ${omitted} chars of 'aws sso login' output]`,
    );
    const boundary = raw.charCodeAt(MAX_RAW_OUTPUT_CHARS - 1);
    assert.ok(
      boundary >= 0xd800 && boundary <= 0xdbff,
      `expected the cut to land on a HIGH surrogate, got U+${boundary.toString(16).toUpperCase()}`,
    );
    // Nothing pairs with it: the very next code unit is the marker's newline,
    // so the head is not well-formed UTF-16.
    assert.equal(
      raw.charCodeAt(MAX_RAW_OUTPUT_CHARS),
      0x0a,
      "the marker follows the high surrogate directly -- its low surrogate was cut away",
    );
    // The count is still measured in code units, so it is off by one relative
    // to "characters" in the human sense. Pinned so the arithmetic is explicit.
    assert.equal(omitted, payload.length - MAX_RAW_OUTPUT_CHARS);
  });
});
