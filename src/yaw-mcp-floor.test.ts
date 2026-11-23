import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// The same one-level hop src/oam-floor.test.ts uses: authored in src/, executed
// from dist/, so resolving off import.meta.url reaches the repo root either way.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = join(repoRoot, "scripts", "check-yaw-mcp-floor.mjs");

// The floor itself, from the checker, so the passing fixtures below follow a
// bump instead of going red until hand-edited.
const { YAW_MCP_MIN, YAW_MCP_COMPLIANCE_RANGE } = (await import(pathToFileURL(CHECKER).href)) as {
  YAW_MCP_MIN: string;
  YAW_MCP_COMPLIANCE_RANGE: string;
};

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A synthetic repo carrying only the files the checker reads. */
function fixture(files: { compliance?: string; readme?: string; claudeMd?: string }): string {
  const root = mkdtempSync(join(tmpdir(), "aws-mcp-yaw-floor-"));
  dirs.push(root);
  const devDependencies = files.compliance === undefined ? {} : { "@yawlabs/mcp-compliance": files.compliance };
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", devDependencies }));
  if (files.readme !== undefined) writeFileSync(join(root, "README.md"), files.readme);
  if (files.claudeMd !== undefined) writeFileSync(join(root, "CLAUDE.md"), files.claudeMd);
  return root;
}

/** Offline on purpose: these cases are about drift, not the registry. */
function runChecker(root: string): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [CHECKER, "--offline", "--root", root], {
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("the Yaw MCP floor is consistent across this repo", () => {
  it("the real repo agrees with itself", () => {
    const r = runChecker(repoRoot);
    assert.equal(r.code, 0, `check-yaw-mcp-floor reported drift in this repo:\n${r.out}`);
    assert.match(r.out, /no drift/);
  });
});

describe("check-yaw-mcp-floor catches drift", () => {
  it("passes a tree with the pinned range and a current claim", () => {
    const root = fixture({
      compliance: YAW_MCP_COMPLIANCE_RANGE,
      readme: `Tested with Yaw MCP ${YAW_MCP_MIN} or newer.\n`,
    });
    const r = runChecker(root);
    assert.equal(r.code, 0, r.out);
  });

  it("flags a @yawlabs/mcp-compliance devDependency on another range", () => {
    const root = fixture({ compliance: "^0.19.0" });
    const r = runChecker(root);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /DRIFT: package\.json pins @yawlabs\/mcp-compliance \^0\.19\.0/);
  });

  it("does not require the devDependency at all", () => {
    const r = runChecker(fixture({ readme: `Tested with Yaw MCP ${YAW_MCP_MIN} or newer.\n` }));
    assert.equal(r.code, 0, r.out);
  });

  it("flags a README claim naming the previous floor, with file and line", () => {
    // 0.0.1 can never be the floor, so this stays a stale claim through any bump.
    const root = fixture({
      compliance: YAW_MCP_COMPLIANCE_RANGE,
      readme: "# x\n\nTested with Yaw MCP 0.0.1 or newer.\n",
    });
    const r = runChecker(root);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /README\.md:3 +says 0\.0\.1/);
  });

  it("flags a stale yaw-mcp claim in CLAUDE.md", () => {
    const root = fixture({ claudeMd: "Needs yaw-mcp 1.0.17 or newer.\n" });
    const r = runChecker(root);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /CLAUDE\.md:1 +says 1\.0\.17/);
  });

  it("does NOT flag historical mentions of older releases", () => {
    const root = fixture({
      readme:
        "Cutting @yawlabs/mcp 1.0.17 moved the grader.\n" +
        "0.20.2 is the one Yaw MCP 1.1.12 requires.\n" +
        "Yaw MCP keeps the first 100,000 bytes by default.\n" +
        "yaw-mcp set aws env.AWS_PROFILE --secret\n",
    });
    const r = runChecker(root);
    assert.equal(r.code, 0, r.out);
  });
});
