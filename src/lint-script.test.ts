import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Same one-level hop src/release-metadata.test.ts uses, and for the same reason:
// this file is authored in src/ and executed from dist/, so resolving off
// import.meta.url reaches the repo root in both layouts regardless of cwd.
//
// The subject lives in scripts/, but the test cannot: `npm test` runs
// `node --test dist/**/*.test.js`, and tsconfig.json only includes src/. A test
// under scripts/ would be compiled by nothing and matched by nothing -- it would
// sit there looking like coverage while never running.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LINT_SCRIPT = join(repoRoot, "scripts", "lint.mjs");

/**
 * Drive scripts/lint.mjs end to end with node itself standing in for biome.
 *
 * AWS_MCP_BIOME_BIN is returned by resolveBinary() before any detection happens,
 * so none of the expensive machinery runs: no biome.json read, no x64 package
 * provisioned, no ~30MB download. Everything after the resolve -- the spawn, the
 * timeout branch, the crash classification, the exit -- runs exactly as it does
 * in a release. Arguments after the script path are forwarded verbatim to that
 * binary, so `node <args>` becomes a fake biome whose behavior the test dictates.
 *
 * The wrapper spawns with `stdio: "inherit"`, so the fake biome's output flows
 * through the wrapper's own pipes and lands in the captured stdout/stderr here.
 */
function runLint(fakeBiomeArgs: string[]): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [LINT_SCRIPT, ...fakeBiomeArgs], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, AWS_MCP_BIOME_BIN: process.execPath },
  });
  return { status: run.status, stdout: String(run.stdout), stderr: String(run.stderr) };
}

describe("lint wrapper (scripts/lint.mjs)", () => {
  // This pair is the whole reason the file has tests at all. release.sh:221 is
  // `npm run lint || fail "Lint failed"`, and this repo ships no CI by design --
  // so the wrapper's exit status IS the release gate, with nothing downstream to
  // catch it. Every other failure in scripts/lint.mjs is loud; this one is
  // silent. If the passthrough ever regressed to a constant 0 (an added
  // process.exit(0), a swallowed status, a try/catch around the spawn), the
  // release step would still print "Lint passed" and publish unlinted code.
  it("exits non-zero when biome does, so release.sh's lint gate still fails", () => {
    const result = runLint(["-e", "process.exit(3)"]);
    assert.equal(result.status, 3, "a non-zero biome status must propagate verbatim, not be swallowed or normalized");
  });

  it("exits zero when biome does, so a clean lint does not fail the release", () => {
    const result = runLint(["-e", "process.exit(0)"]);
    assert.equal(result.status, 0, `a clean biome run must exit 0; stderr was: ${result.stderr}`);
  });

  // The branch this repo's lint wrapper exists for. On Windows a native crash is
  // reported as an NTSTATUS in the exit CODE with signal left null, so the
  // `signal !== null` half of the check can never fire there -- the `>= 0xc0000000`
  // half is what catches the arm64 biome access violation the file's header
  // documents. Dropping it would not break the gate (3221225477 is still
  // non-zero), it would strip the diagnostic that tells an operator mid-release
  // they hit the known crash and should reach for the documented overrides.
  //
  // Windows-only on purpose: POSIX truncates child exit codes to & 0xFF, so
  // 3221225477 arrives as 5 and this branch is unreachable there. Substituting a
  // signal-killed child would exercise the other half of the condition, which is
  // a different behavior than the one under test.
  it("classifies a Windows NTSTATUS crash as a crash rather than passing the raw status through", {
    skip: process.platform === "win32" ? false : "NTSTATUS exit codes are truncated to & 0xFF off Windows",
  }, () => {
    const result = runLint(["-e", "process.exit(3221225477)"]);
    assert.equal(result.status, 1, "a crashed biome must exit 1, not the raw NTSTATUS");
    assert.match(
      result.stderr,
      /crashed with 0xc0000005/,
      `the crash must be reported with its NTSTATUS in hex; stderr was: ${result.stderr}`,
    );
  });

  // Pins `shell: needsShell` at the spawn: the shell is enabled ONLY for a
  // .cmd/.bat target, and everything else stays shell-free so arguments reach
  // biome verbatim. Turning it on unconditionally is the tempting "fix" for the
  // EINVAL that .cmd targets throw on Node 22 -- and it would make cmd.exe
  // re-split argv on whitespace, exactly the corruption the header records
  // measuring against npm (`--prefix "C:\a b\c"` arriving as three arguments).
  // A repo checked out under a path with a space is all it takes to hit it.
  it("passes arguments through without shell re-splitting", () => {
    const result = runLint(["-p", "JSON.stringify(process.argv.slice(1))", "check --write", "src/"]);
    assert.equal(result.status, 0, `fake biome should have exited 0; stderr was: ${result.stderr}`);
    assert.deepEqual(
      JSON.parse(result.stdout.trim()),
      ["check --write", "src/"],
      "an argument containing a space must arrive as one argument, not be split by a shell",
    );
  });
});
