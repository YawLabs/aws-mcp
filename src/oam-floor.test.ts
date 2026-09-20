import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// The same one-level hop src/release-metadata.test.ts and src/lint-script.test.ts
// use: authored in src/, executed from dist/, so resolving off import.meta.url
// reaches the repo root in both layouts regardless of cwd. The subject lives in
// scripts/, which tsconfig does not include, so the test cannot live beside it.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = join(repoRoot, "scripts", "check-oam-floor.mjs");

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A synthetic repo carrying only the files the checker reads. */
function fixture(files: { launcher?: string; readme?: string; launcherTest?: string }): string {
  const root = mkdtempSync(join(tmpdir(), "aws-mcp-floor-"));
  dirs.push(root);
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "bin", "aws-mcp.mjs"), files.launcher ?? "const OAM_MIN = [0, 16, 3];\n");
  if (files.readme !== undefined) writeFileSync(join(root, "README.md"), files.readme);
  writeFileSync(
    join(root, "src", "launcher.test.ts"),
    files.launcherTest ?? "    assert.deepEqual(floor, [0, 16, 3]);\n",
  );
  return root;
}

/** Offline on purpose: these cases are about drift, and the network half is not
 *  theirs to exercise (nor should a unit test depend on GitHub being reachable). */
function runChecker(root: string): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [CHECKER, "--offline", "--root", root], {
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("the oam floor is consistent across this repo", () => {
  // This is the half of the staleness check that needs no network, so it runs on
  // every `npm test` -- which is what makes it gate a release, because release.sh
  // runs the suite. Nobody has to remember to run anything.
  it("the real repo agrees with itself", () => {
    const r = runChecker(repoRoot);
    assert.equal(r.code, 0, `check-oam-floor reported drift in this repo:\n${r.out}`);
    assert.match(r.out, /no drift/);
  });
});

describe("check-oam-floor catches drift", () => {
  // Every case here is a mistake that actually happened, or a false positive the
  // first version of this checker produced. A checker with no test that it FAILS
  // is worse than none: the first run of this one had a regex containing literal
  // backspace bytes, so it matched nothing and reported a clean repo.

  it("flags a README still claiming the previous floor", () => {
    const root = fixture({
      readme:
        "This server runs on oam.\n\nThe launcher never serves on an oam older than **0.15.2**, and picks the newest.\n",
    });
    const r = runChecker(root);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /DRIFT/);
    assert.match(r.out, /README\.md:3/, "the message must name the file and line");
    assert.match(r.out, /0\.15\.2/, "and the version it found");
  });

  it("flags a launcher test still pinning the previous floor", () => {
    const root = fixture({ launcherTest: "    assert.deepEqual(floor, [0, 15, 2]);\n" });
    const r = runChecker(root);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /pins the floor at 0\.15\.2, but OAM_MIN is 0\.16\.3/);
  });

  it("flags a floor claim that names no version at all being gone", () => {
    // Removing the pin is drift too: the suite then asserts nothing about the floor.
    const root = fixture({ launcherTest: "    // the floor assertion was deleted\n" });
    const r = runChecker(root);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /no longer pins the floor/);
  });

  it("does NOT flag a line naming a host version beside the floor", () => {
    // The launcher's own diagnostic is "this process is oam 0.9.0, older than
    // 0.16.3" -- two versions with different roles, both correct. The first
    // version of this checker flagged it.
    const root = fixture({
      launcherTest:
        "    assert.deepEqual(floor, [0, 16, 3]);\n" +
        "      /this process is oam 0\\.9\\.0, older than 0\\.16\\.3, and no newer oam was found/,\n",
    });
    const r = runChecker(root);
    assert.equal(r.code, 0, r.out);
  });

  it("does NOT flag AWS CLI versions, which are a different dependency", () => {
    // "CLI 2.35.3 or newer" and "2.25.0 or newer" are about the AWS CLI. The first
    // version of this checker produced five false positives from lines like these,
    // which is how a checker gets switched off.
    const root = fixture({
      readme:
        "- **Security:** CLI 2.35.3 or newer clears every published AWS CLI v2 advisory.\n" +
        "On CLIs older than 2.25.0, `~/.aws/config` is read as UTF-8.\n",
    });
    const r = runChecker(root);
    assert.equal(r.code, 0, r.out);
  });

  it("does NOT flag a line that is explicitly about the past", () => {
    // The startup numbers were "taken with oam 0.8.2, long before the current
    // 0.16.3 floor" -- an old version on that line is the point of the sentence.
    const root = fixture({
      readme: "The numbers below were taken with oam 0.8.2, long before the current 0.16.3 floor.\n",
    });
    const r = runChecker(root);
    assert.equal(r.code, 0, r.out);
  });

  it("fails loudly when OAM_MIN cannot be found at all", () => {
    const root = fixture({ launcher: "// somebody renamed the constant\n" });
    const r = runChecker(root);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /OAM_MIN/);
  });
});
