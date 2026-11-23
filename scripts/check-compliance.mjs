#!/usr/bin/env node
// Grade the built server with @yawlabs/mcp-compliance, on each runtime the
// launcher can pick, before a release.
//
// yaw-mcp grades the servers it fronts with @yawlabs/mcp-compliance
// (`yaw-mcp audit`) and can refuse to spawn one graded below its floor
// (YAW_MCP_MIN_COMPLIANCE), so this repo runs the suite here rather than finding
// out from a user's refused spawn. The devDependency is pinned to the range the
// Yaw MCP floor release pins, so its audit grades with the same rubric; which
// range and which release is scripts/check-yaw-mcp-floor.mjs's to say
// (YAW_MCP_COMPLIANCE_RANGE, YAW_MCP_MIN), and that script fails on drift.
//
//   node scripts/check-compliance.mjs        both legs: AWS_MCP_RUNTIME=node, then =oam
//
// Each leg runs `mcp-compliance test --strict -- node bin/aws-mcp.mjs`, so the
// published launcher is what gets graded, and a required-test failure fails it.
//
// The oam leg grades the oam the LAUNCHER would choose, found the way it finds
// one (chooseLegOam below), and pins it with OAM_BIN so the banner names the
// version that was actually graded. Probing bare `oam` on PATH instead skipped
// the leg when oam was installed but not on PATH, named a different oam than
// the one graded when both existed, and turned a below-floor PATH oam into a
// compliance FAILURE rather than a skip.
//
// Exit status, which release.sh reads:
//   0  every leg ran and passed
//   1  a leg ran and failed
//   2  a leg could not run (the package is not installed, no oam at or above
//      the launcher's floor for the oam leg) -- printed as a WARNING naming what
//      was skipped, never a silent pass, and release.sh reports it as a warning
//      rather than a green step.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions, isMainModule, readFloor } from "./check-oam-floor.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(repoRoot, "bin", "aws-mcp.mjs");

function complianceBin() {
  // Read off disk, not require.resolve: the package's `exports` map does not
  // expose package.json, so resolving it throws ERR_PACKAGE_PATH_NOT_EXPORTED.
  const pkgPath = join(repoRoot, "node_modules", "@yawlabs", "mcp-compliance", "package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["mcp-compliance"];
    return rel ? { path: join(dirname(pkgPath), rel), version: pkg.version } : null;
  } catch {
    return null;
  }
}

/** `<oam> --version` -> [major, minor, patch], or null when it cannot be read. */
function oamVersion(cmd) {
  try {
    const out = execFileSync(cmd, ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      windowsHide: true,
    });
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  } catch {
    return null;
  }
}

/**
 * The oam bin/aws-mcp.mjs would run under AWS_MCP_RUNTIME=oam, or null when it
 * would find none at or above `floor`. Same order and rule as the launcher's
 * chooseOam/discoverOamPaths: a usable OAM_BIN as given; else OAM_INSTALL_DIR,
 * %LOCALAPPDATA%\oam\bin (Windows), ~/.oam/bin, then PATH, `.exe` only on
 * Windows, and the NEWEST at or above the floor, a tie keeping search order.
 * Every input is a parameter so the choice is testable without real binaries.
 */
export function chooseLegOam({
  env = process.env,
  floor,
  home = homedir(),
  isWin = process.platform === "win32",
  probe = oamVersion,
  exists = existsSync,
}) {
  const usable = (v) => v !== null && compareVersions(v, floor) >= 0;
  if (env.OAM_BIN && exists(env.OAM_BIN)) {
    const version = probe(env.OAM_BIN);
    if (usable(version)) return { path: env.OAM_BIN, version };
  }
  const exe = isWin ? "oam.exe" : "oam";
  const installed = [join(home, ".oam", "bin", exe)];
  if (isWin) installed.unshift(join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "oam", "bin", exe));
  if (env.OAM_INSTALL_DIR) installed.unshift(join(env.OAM_INSTALL_DIR, exe));
  const onPath = (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, exe));
  const seen = new Set();
  let best = null;
  for (const candidate of [...installed, ...onPath]) {
    const key = isWin ? candidate.toLowerCase() : candidate;
    if (seen.has(key) || !exists(candidate)) continue;
    seen.add(key);
    const version = probe(candidate);
    if (!usable(version)) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { path: candidate, version };
  }
  return best;
}

function main() {
  const skipped = [];
  let failed = false;

  const bin = complianceBin();
  if (!bin) {
    console.warn("WARNING: @yawlabs/mcp-compliance is not installed (run npm ci); compliance was NOT checked.");
    process.exit(2);
  }
  if (!existsSync(join(repoRoot, "dist", "index.js"))) {
    console.error("check-compliance: dist/index.js is missing -- run `npm run build` first.");
    process.exit(1);
  }

  for (const runtime of ["node", "oam"]) {
    const env = { ...process.env, AWS_MCP_RUNTIME: runtime };
    if (runtime === "oam") {
      const floor = readFloor(repoRoot);
      const oam = chooseLegOam({ floor });
      if (!oam) {
        skipped.push(
          `AWS_MCP_RUNTIME=oam (no oam ${floor.join(".")} or newer where the launcher looks: OAM_BIN, OAM_INSTALL_DIR, the installed dirs, PATH)`,
        );
        continue;
      }
      env.OAM_BIN = oam.path;
      console.log(
        `\n=== mcp-compliance ${bin.version}, AWS_MCP_RUNTIME=oam (oam ${oam.version.join(".")} at ${oam.path}) ===`,
      );
    } else {
      console.log(`\n=== mcp-compliance ${bin.version}, AWS_MCP_RUNTIME=node (${process.version}) ===`);
    }
    const r = spawnSync(process.execPath, [bin.path, "test", "--strict", "--", process.execPath, launcher], {
      cwd: repoRoot,
      stdio: "inherit",
      env,
      windowsHide: true,
    });
    if (r.error || r.status !== 0) {
      console.error(`check-compliance: AWS_MCP_RUNTIME=${runtime} failed (${r.error?.message ?? `exit ${r.status}`})`);
      failed = true;
    }
  }

  if (failed) process.exit(1);
  if (skipped.length > 0) {
    console.warn(`WARNING: compliance legs NOT run: ${skipped.join("; ")}`);
    process.exit(2);
  }
  console.log("\ncheck-compliance: every leg passed.");
}

// Only run when invoked directly, so chooseLegOam stays importable for tests.
if (isMainModule(process.argv[1], import.meta.url)) main();
