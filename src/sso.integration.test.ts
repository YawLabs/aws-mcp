/**
 * Integration tests for the SSO login subprocess flow. These spawn a real
 * child process (no mocking), pointed at a controlled fake aws binary via
 * startSsoLogin's command/prefixArgs/env overrides.
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { _clearSessions, _hasSession, findActiveSessionByProfile, startSsoLogin, waitForLogin } from "./sso.js";

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
