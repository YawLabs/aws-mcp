#!/usr/bin/env node
// Grade the built server with @yawlabs/mcp-compliance, on each runtime the
// launcher can pick, before a release.
//
// yaw-mcp grades every server it fronts with @yawlabs/mcp-compliance and can
// refuse to spawn one graded below its floor (YAW_MCP_MIN_COMPLIANCE), so this
// repo pins the same version line yaw-mcp grades with (devDependencies) and runs
// it here rather than finding out from a user's refused spawn.
//
//   node scripts/check-compliance.mjs        both legs: AWS_MCP_RUNTIME=node, then =oam
//
// Each leg runs `mcp-compliance test --strict -- node bin/aws-mcp.mjs`, so the
// published launcher is what gets graded, and a required-test failure fails it.
//
// Exit status, which release.sh reads:
//   0  every leg ran and passed
//   1  a leg ran and failed
//   2  a leg could not run (the package is not installed, no oam on PATH for the
//      oam leg) -- printed as a WARNING naming what was skipped, never a silent
//      pass, and release.sh reports it as a warning rather than a green step.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const launcher = join(repoRoot, 'bin', 'aws-mcp.mjs');

function complianceBin() {
  // Read off disk, not require.resolve: the package's `exports` map does not
  // expose package.json, so resolving it throws ERR_PACKAGE_PATH_NOT_EXPORTED.
  const pkgPath = join(repoRoot, 'node_modules', '@yawlabs', 'mcp-compliance', 'package.json');
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['mcp-compliance'];
    return rel ? { path: join(dirname(pkgPath), rel), version: pkg.version } : null;
  } catch {
    return null;
  }
}

function oamOnPath() {
  const r = spawnSync('oam', ['--version'], { encoding: 'utf-8', windowsHide: true, timeout: 10_000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

const skipped = [];
let failed = false;

const bin = complianceBin();
if (!bin) {
  console.warn('WARNING: @yawlabs/mcp-compliance is not installed (run npm ci); compliance was NOT checked.');
  process.exit(2);
}
if (!existsSync(join(repoRoot, 'dist', 'index.js'))) {
  console.error('check-compliance: dist/index.js is missing -- run `npm run build` first.');
  process.exit(1);
}

const legs = [{ runtime: 'node' }, { runtime: 'oam' }];
for (const { runtime } of legs) {
  if (runtime === 'oam') {
    const oam = oamOnPath();
    if (!oam) {
      skipped.push('AWS_MCP_RUNTIME=oam (no oam on PATH)');
      continue;
    }
    console.log(`\n=== mcp-compliance ${bin.version}, AWS_MCP_RUNTIME=oam (${oam}) ===`);
  } else {
    console.log(`\n=== mcp-compliance ${bin.version}, AWS_MCP_RUNTIME=node (${process.version}) ===`);
  }
  const r = spawnSync(process.execPath, [bin.path, 'test', '--strict', '--', process.execPath, launcher], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, AWS_MCP_RUNTIME: runtime },
    windowsHide: true,
  });
  if (r.error || r.status !== 0) {
    console.error(`check-compliance: AWS_MCP_RUNTIME=${runtime} failed (${r.error?.message ?? `exit ${r.status}`})`);
    failed = true;
  }
}

if (failed) process.exit(1);
if (skipped.length > 0) {
  console.warn(`WARNING: compliance legs NOT run: ${skipped.join('; ')}`);
  process.exit(2);
}
console.log('\ncheck-compliance: every leg passed.');
