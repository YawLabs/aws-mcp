import assert from "node:assert/strict";
import { fork } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { upsertProfile, upsertProfileIntoText } from "./aws-credentials.js";

const CREDS = {
  aws_access_key_id: "AKIA-NEW-1",
  aws_secret_access_key: "secret-new-1",
  aws_session_token: "token-new-1",
};

describe("upsertProfileIntoText — new profile on empty file", () => {
  it("creates the section with all three keys", () => {
    const out = upsertProfileIntoText("", "mcp-dev", CREDS);
    assert.match(out, /\[mcp-dev\]/);
    assert.match(out, /aws_access_key_id = AKIA-NEW-1/);
    assert.match(out, /aws_secret_access_key = secret-new-1/);
    assert.match(out, /aws_session_token = token-new-1/);
  });
});

describe("upsertProfileIntoText — append to existing file", () => {
  it("preserves existing profiles and appends the new one", () => {
    const existing = `[default]
aws_access_key_id = OLD-DEFAULT
aws_secret_access_key = old-default-secret

[prod]
aws_access_key_id = OLD-PROD
aws_secret_access_key = old-prod-secret
`;
    const out = upsertProfileIntoText(existing, "mcp-staging", CREDS);
    assert.match(out, /\[default\]/);
    assert.match(out, /OLD-DEFAULT/);
    assert.match(out, /\[prod\]/);
    assert.match(out, /OLD-PROD/);
    assert.match(out, /\[mcp-staging\]/);
    assert.match(out, /AKIA-NEW-1/);
  });

  it("preserves comments in the preamble", () => {
    const existing = `# This is my credentials file
; Managed by me

[default]
aws_access_key_id = X
aws_secret_access_key = Y
`;
    const out = upsertProfileIntoText(existing, "mcp-new", CREDS);
    assert.match(out, /# This is my credentials file/);
    assert.match(out, /; Managed by me/);
    assert.match(out, /\[default\]/);
    assert.match(out, /\[mcp-new\]/);
  });
});

describe("upsertProfileIntoText — update existing profile", () => {
  it("replaces the three managed keys in place", () => {
    const existing = `[mcp-dev]
aws_access_key_id = OLD-KEY
aws_secret_access_key = old-secret
aws_session_token = old-token
`;
    const out = upsertProfileIntoText(existing, "mcp-dev", CREDS);
    assert.ok(!out.includes("OLD-KEY"));
    assert.ok(!out.includes("old-secret"));
    assert.ok(!out.includes("old-token"));
    assert.match(out, /AKIA-NEW-1/);
    assert.match(out, /secret-new-1/);
    assert.match(out, /token-new-1/);
  });

  it("preserves unrelated keys (region, output) in the same profile", () => {
    const existing = `[mcp-dev]
aws_access_key_id = OLD-KEY
aws_secret_access_key = old-secret
aws_session_token = old-token
region = eu-west-1
output = json
`;
    const out = upsertProfileIntoText(existing, "mcp-dev", CREDS);
    assert.match(out, /region = eu-west-1/);
    assert.match(out, /output = json/);
    assert.match(out, /AKIA-NEW-1/);
  });

  it("does not duplicate other profiles when updating one", () => {
    const existing = `[default]
aws_access_key_id = DEFAULT-KEY

[mcp-dev]
aws_access_key_id = OLD-KEY
aws_secret_access_key = old
aws_session_token = old

[prod]
aws_access_key_id = PROD-KEY
`;
    const out = upsertProfileIntoText(existing, "mcp-dev", CREDS);
    const defaultCount = (out.match(/\[default\]/g) ?? []).length;
    const prodCount = (out.match(/\[prod\]/g) ?? []).length;
    assert.equal(defaultCount, 1);
    assert.equal(prodCount, 1);
    assert.match(out, /DEFAULT-KEY/);
    assert.match(out, /PROD-KEY/);
  });

  it("adds missing managed keys when the profile exists with only some of them", () => {
    const existing = `[mcp-dev]
aws_access_key_id = OLD
region = us-east-1
`;
    const out = upsertProfileIntoText(existing, "mcp-dev", CREDS);
    assert.match(out, /aws_secret_access_key = secret-new-1/);
    assert.match(out, /aws_session_token = token-new-1/);
    assert.match(out, /region = us-east-1/);
  });

  it("preserves the blank-line gap between the updated profile and the next section when keys are missing", () => {
    // splitSections folds the blank lines between [mcp-dev] and [prod] into
    // mcp-dev's body. When we have to APPEND missing managed keys, the merge
    // must not collapse those trailing blanks -- the user expects [prod]
    // not to get glued onto [mcp-dev]'s last key.
    const existing = `[mcp-dev]
aws_access_key_id = OLD


[prod]
aws_access_key_id = PROD-KEY
`;
    const out = upsertProfileIntoText(existing, "mcp-dev", CREDS);
    // Two blank lines (\n\n) survive between aws_session_token and [prod].
    assert.match(out, /aws_session_token = token-new-1\n\n\n\[prod\]/);
    assert.match(out, /aws_access_key_id = PROD-KEY/);
  });
});

describe("upsertProfile — filesystem round-trip", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aws-mcp-creds-"));
    path = join(dir, "credentials");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the file when missing", async () => {
    await upsertProfile(path, "mcp-dev", CREDS);
    const text = readFileSync(path, "utf-8");
    assert.match(text, /\[mcp-dev\]/);
    assert.match(text, /AKIA-NEW-1/);
  });

  it("modifies in place without destroying other profiles", async () => {
    writeFileSync(
      path,
      `[default]
aws_access_key_id = DEFAULT
aws_secret_access_key = default-secret
`,
    );
    await upsertProfile(path, "mcp-dev", CREDS);
    const text = readFileSync(path, "utf-8");
    assert.match(text, /\[default\]/);
    assert.match(text, /DEFAULT/);
    assert.match(text, /\[mcp-dev\]/);
    assert.match(text, /AKIA-NEW-1/);
  });

  it("applies 0600 perms on Unix (skipped on Windows)", async () => {
    if (platform() === "win32") return;
    await upsertProfile(path, "mcp-dev", CREDS);
    const mode = statSync(path).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  });

  it("second upsert updates the same profile (not appends)", async () => {
    await upsertProfile(path, "mcp-dev", CREDS);
    await upsertProfile(path, "mcp-dev", {
      aws_access_key_id: "AKIA-V2",
      aws_secret_access_key: "secret-v2",
      aws_session_token: "token-v2",
    });
    const text = readFileSync(path, "utf-8");
    const sectionCount = (text.match(/\[mcp-dev\]/g) ?? []).length;
    assert.equal(sectionCount, 1);
    assert.ok(!text.includes("AKIA-NEW-1"));
    assert.match(text, /AKIA-V2/);
  });

  it("releases the lock after a successful upsert (no lingering <path>.lock)", async () => {
    await upsertProfile(path, "mcp-dev", CREDS);
    assert.ok(!existsSync(`${path}.lock`), "lock file should be unlinked after a clean upsert");
  });
});

/**
 * Direct coverage of the sidecar-lock subsystem (acquireLock + the atomic
 * write path inside upsertProfile). The cross-process race test below exercises
 * the lock end-to-end via the outcome (both profiles survive); these tests
 * target the individual lock behaviors -- stale recovery, acquire timeout,
 * non-EEXIST propagation, and tmp-file cleanup -- without needing two forked
 * children.
 *
 * The LOCK_* constants are not exported from aws-credentials.ts; the values
 * mirrored here (10_000ms max wait, 30_000ms stale threshold) are duplicated
 * from the source. If those constants change, these tests must change too --
 * an intentional coupling so a wait/stale-window edit is a conscious update.
 */
describe("upsertProfile — lock subsystem", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aws-mcp-lock-"));
    path = join(dir, "credentials");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("force-unlinks a stale lock (mtime older than LOCK_STALE_AFTER_MS) and succeeds", async () => {
    // Plant a lock file as if a prior writer crashed before releasing it.
    const lockPath = `${path}.lock`;
    writeFileSync(lockPath, "pid=99999 time=0\n");
    // Backdate mtime well past the 30s stale threshold so acquireLock's
    // stat-then-unlink stale-recovery branch fires on the first EEXIST.
    const staleSeconds = Math.floor(Date.now() / 1000) - 120; // 2 minutes ago
    utimesSync(lockPath, staleSeconds, staleSeconds);

    // Should NOT time out -- stale recovery unlinks the orphan and claims it.
    await upsertProfile(path, "mcp-dev", CREDS);

    const text = readFileSync(path, "utf-8");
    assert.match(text, /\[mcp-dev\]/);
    assert.match(text, /AKIA-NEW-1/);
    // The lock we planted was swept and the one we took was released.
    assert.ok(!existsSync(lockPath), "stale lock should be gone after a successful upsert");
  });

  it("throws 'failed to acquire lock' when a fresh lock is held past LOCK_MAX_WAIT_MS", {
    timeout: 20_000,
  }, async () => {
    // Hold the lock continuously with a CURRENT mtime so stale-recovery never
    // fires -- acquireLock sees EEXIST every iteration, backs off, and after
    // LOCK_MAX_WAIT_MS (10s) throws. We keep the fd open (and refresh mtime)
    // for the whole window so the held lock never looks stale.
    const lockPath = `${path}.lock`;
    const heldFd = openSync(lockPath, "wx"); // claim it the same way acquireLock does
    const keepFresh = setInterval(() => {
      try {
        const now = Date.now() / 1000;
        utimesSync(lockPath, now, now);
      } catch {
        // lock vanished -- nothing to refresh
      }
    }, 2_000);

    try {
      await assert.rejects(
        upsertProfile(path, "mcp-dev", CREDS),
        (err: Error) => {
          assert.match(err.message, /failed to acquire lock/);
          assert.match(err.message, new RegExp(lockPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
          return true;
        },
        "upsertProfile should reject with the lock-timeout error when the lock is held the whole window",
      );
      // The held lock is still ours; upsertProfile must not have written creds.
      assert.ok(!existsSync(path), "credentials file should not be written when the lock was never acquired");
    } finally {
      clearInterval(keepFresh);
      closeSync(heldFd);
    }
  });

  it("propagates the real errno (ENOENT) instead of a lock-timeout when the lock dir is missing", async () => {
    // Point at a path whose PARENT directory does not exist. openSync on
    // `<path>.lock` then fails with ENOENT (non-EEXIST), which acquireLock
    // rethrows immediately -- it must NOT mask it as "failed to acquire lock"
    // after a 10s wait.
    const missingParent = join(dir, "does-not-exist", "credentials");
    await assert.rejects(upsertProfile(missingParent, "mcp-dev", CREDS), (err: NodeJS.ErrnoException) => {
      assert.equal(err.code, "ENOENT", `expected ENOENT, got ${err.code}`);
      assert.doesNotMatch(
        err.message,
        /failed to acquire lock/,
        "non-EEXIST openSync failure must surface the real errno, not a misleading lock-timeout",
      );
      return true;
    });
  });

  it("leaves no .tmp-* file behind after a successful upsert (atomic-write cleanup)", async () => {
    await upsertProfile(path, "mcp-dev", CREDS);
    const leftovers = readdirSync(dir).filter((name) => name.includes(".tmp-"));
    assert.deepEqual(leftovers, [], `no .tmp-* files should remain, found: ${leftovers.join(", ")}`);
  });
});

/**
 * Cross-process concurrency guard. Before the sidecar lock was introduced,
 * two callers updating DIFFERENT profiles in the file at the same time
 * could lose one writer's changes (each reads the file first, then they
 * race to rename; the second rename clobbers the first). The lock added
 * in `upsertProfile` serializes the read-modify-rename window across
 * processes, so every trial below must preserve BOTH profiles.
 *
 * If this assertion starts failing -- the race can drop a profile again --
 * either the lock regressed (acquire/release missing, lock path wrong,
 * stale-recovery is too aggressive) or the OS-level open(O_EXCL) semantics
 * we rely on aren't being honored on the test platform.
 */
describe("upsertProfile — concurrent cross-process writers are serialized", () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // Resolve compiled module path; tests run from dist/. Convert to a file:// URL
  // because ESM `import` from a raw Windows path (`C:\...\file.js`) rejects with
  // ERR_UNSUPPORTED_ESM_URL_SCHEME (Node treats `C:` as an unknown scheme).
  const credsModuleUrl = pathToFileURL(join(__dirname, "aws-credentials.js")).href;

  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aws-mcp-race-"));
    path = join(dir, "credentials");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeShim(d: string, body: string): string {
    const p = join(d, `shim-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(p, body);
    return p;
  }

  /**
   * Fork a pair of children, wait for both to report ready, then send the
   * "go" message simultaneously. Each child imports `upsertProfile` ahead of
   * the go signal so the race window is just the synchronous read+write+
   * rename inside `upsertProfile`, not Node startup.
   */
  function runConcurrentPair(profileA: string, profileB: string, trial: number): Promise<void> {
    const childScript = `
      import { upsertProfile } from ${JSON.stringify(credsModuleUrl)};
      const filePath = process.env.RACE_PATH;
      const profile = process.env.RACE_PROFILE;
      const akid = process.env.RACE_AKID;
      // Pre-warm: synchronous import done above. Signal ready, then wait
      // for the go message before doing the read-modify-write.
      process.send({ type: "ready" });
      process.on("message", async (msg) => {
        if (msg && msg.type === "go") {
          try {
            await upsertProfile(filePath, profile, {
              aws_access_key_id: akid,
              aws_secret_access_key: "secret-" + profile,
              aws_session_token: "token-" + profile,
            });
            process.exit(0);
          } catch (e) {
            process.stderr.write(String(e && e.stack || e));
            process.exit(2);
          }
        }
      });
    `;
    const shimPath = writeShim(dir, childScript);

    function spawn(profile: string, akid: string) {
      return new Promise<{ child: ReturnType<typeof fork>; ready: Promise<void> }>((resolve) => {
        const child = fork(shimPath, [], {
          stdio: "pipe",
          env: { ...process.env, RACE_PATH: path, RACE_PROFILE: profile, RACE_AKID: akid },
        });
        const ready = new Promise<void>((res) => {
          child.once("message", (msg: { type?: string }) => {
            if (msg?.type === "ready") res();
          });
        });
        resolve({ child, ready });
      });
    }

    return (async () => {
      const a = await spawn(profileA, `AKIA-${profileA.toUpperCase()}-${trial}`);
      const b = await spawn(profileB, `AKIA-${profileB.toUpperCase()}-${trial}`);
      // Wait until both are imported and listening.
      await Promise.all([a.ready, b.ready]);
      // Capture both exits before signalling. On POSIX both children
      // should succeed; on Windows one child's renameSync can lose to the
      // other's with EPERM ("operation not permitted, rename ..."). That
      // failure mode IS the documented race surfacing -- we treat it as a
      // valid "child lost the race" outcome rather than a test error.
      const collect = (child: ReturnType<typeof fork>) =>
        new Promise<{ code: number; stderr: string }>((resolve) => {
          let stderr = "";
          child.stderr?.on("data", (d) => {
            stderr += d.toString();
          });
          child.on("exit", (code) => resolve({ code: code ?? -1, stderr }));
        });
      const exitA = collect(a.child);
      const exitB = collect(b.child);
      // Fire both go signals back-to-back. Even with this ordering, OS
      // scheduling on the children is what produces the interleave.
      a.child.send({ type: "go" });
      b.child.send({ type: "go" });
      const [ra, rb] = await Promise.all([exitA, exitB]);
      // With the lock in place, BOTH children should always succeed. A
      // non-zero exit here means the lock failed to serialize (regression)
      // or a real bug in the children -- either way surface the stderr so
      // the failure is debuggable instead of silently dropping a profile.
      for (const r of [ra, rb]) {
        if (r.code !== 0) {
          throw new Error(`child failed (code=${r.code}): ${r.stderr}`);
        }
      }
    })();
  }

  it("across N concurrent trials, every trial preserves BOTH profiles (lock fix)", async () => {
    // Pre-fix, this same harness lost a profile in nearly 100% of trials.
    // Post-fix, the lock serializes the read-modify-rename so every trial
    // must preserve both. TRIALS is sized for confidence without dragging
    // CI wall-clock too long -- each trial forks two children, waits for
    // both to acquire/release the lock, and verifies the file.
    //
    // If this fails: the lock regressed (e.g. acquire/release path removed
    // or the lock filename changed) OR the OS-level O_EXCL semantics aren't
    // being honored on the test platform.
    const TRIALS = 40;
    let observedLoss = 0;
    let bothPresent = 0;
    for (let i = 0; i < TRIALS; i++) {
      try {
        rmSync(path, { force: true });
      } catch {}
      try {
        rmSync(`${path}.lock`, { force: true });
      } catch {}
      await runConcurrentPair("alpha", "beta", i);
      const text = readFileSync(path, "utf-8");
      const hasAlpha = /\[alpha\]/.test(text);
      const hasBeta = /\[beta\]/.test(text);
      if (hasAlpha && hasBeta) bothPresent++;
      else observedLoss++;
    }
    assert.equal(
      observedLoss,
      0,
      `expected ZERO profile losses across ${TRIALS} concurrent trials (both-present=${bothPresent}, loss=${observedLoss}). The lock should serialize cross-process writers.`,
    );
  });
});
