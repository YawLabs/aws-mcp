import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

  it("creates the file when missing", () => {
    upsertProfile(path, "mcp-dev", CREDS);
    const text = readFileSync(path, "utf-8");
    assert.match(text, /\[mcp-dev\]/);
    assert.match(text, /AKIA-NEW-1/);
  });

  it("modifies in place without destroying other profiles", () => {
    writeFileSync(
      path,
      `[default]
aws_access_key_id = DEFAULT
aws_secret_access_key = default-secret
`,
    );
    upsertProfile(path, "mcp-dev", CREDS);
    const text = readFileSync(path, "utf-8");
    assert.match(text, /\[default\]/);
    assert.match(text, /DEFAULT/);
    assert.match(text, /\[mcp-dev\]/);
    assert.match(text, /AKIA-NEW-1/);
  });

  it("applies 0600 perms on Unix (skipped on Windows)", () => {
    if (platform() === "win32") return;
    upsertProfile(path, "mcp-dev", CREDS);
    const mode = statSync(path).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  });

  it("second upsert updates the same profile (not appends)", () => {
    upsertProfile(path, "mcp-dev", CREDS);
    upsertProfile(path, "mcp-dev", {
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
});

/**
 * The race documented at aws-credentials.ts:160-168 ("two callers updating
 * DIFFERENT profiles in the file at the same time, the second caller's read
 * happened before the first caller's rename, so the first caller's profile
 * changes are lost"). With no file lock or single-writer queue, two
 * cross-process callers each read the empty file, each compute their own
 * single-profile output, and the second rename clobbers the first. The
 * synchronous filesystem ops inside `upsertProfile` cannot interleave WITHIN
 * a single Node process -- but separate forked child processes scheduled by
 * the OS absolutely can interleave, and that's exactly the scenario the
 * comment describes.
 *
 * This test pins the documented contract: today the loss is observable
 * across a stress budget. If a future patch adds a file lock or
 * single-writer queue, this test should start failing -- at which point
 * the comment AND the test should be revised together.
 */
describe("upsertProfile — concurrent cross-process race on different profiles", () => {
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
      process.on("message", (msg) => {
        if (msg && msg.type === "go") {
          try {
            upsertProfile(filePath, profile, {
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
      // Surface unexpected failures (anything that ISN'T the documented
      // EPERM-on-rename race) so a bug doesn't hide as "race observed".
      for (const r of [ra, rb]) {
        if (r.code !== 0 && !/EPERM|rename/.test(r.stderr)) {
          throw new Error(`unexpected child failure (code=${r.code}): ${r.stderr}`);
        }
      }
    })();
  }

  it("documented loss: across N concurrent runs at least one trial drops a profile", async () => {
    // Stress the race documented at aws-credentials.ts:160-168. Each trial:
    // two children with pre-imported `upsertProfile`, both waiting on a go
    // signal; the parent fires both signals back-to-back so the window of
    // overlap is just the synchronous read-modify-rename inside the
    // function. Across many trials, the OS scheduler will at some point
    // interleave the two reads before either rename, demonstrating the
    // documented loss.
    //
    // If this assertion ever fails (i.e. EVERY trial preserves both
    // profiles), the race may have been fixed -- update the comment at
    // aws-credentials.ts:160-168 and revisit this test.
    const TRIALS = 80;
    let observedLoss = 0;
    let bothPresent = 0;
    for (let i = 0; i < TRIALS; i++) {
      try {
        rmSync(path, { force: true });
      } catch {}
      await runConcurrentPair("alpha", "beta", i);
      // After both children exit (possibly one with EPERM on rename), the
      // file may contain only one profile -- that's the documented loss.
      // The file always exists because at least one child won the rename.
      const text = readFileSync(path, "utf-8");
      const hasAlpha = /\[alpha\]/.test(text);
      const hasBeta = /\[beta\]/.test(text);
      if (hasAlpha && hasBeta) bothPresent++;
      else observedLoss++;
      if (observedLoss > 0) break; // one is enough to demonstrate the race
    }
    assert.ok(
      observedLoss > 0,
      `expected concurrent upsertProfile to drop a profile in at least one of ${TRIALS} trials ` +
        `(both-present=${bothPresent}, loss=${observedLoss}). If this fails, the race may have been ` +
        `fixed -- update the comment at aws-credentials.ts:160-168 and revisit this test.`,
    );
  });
});
