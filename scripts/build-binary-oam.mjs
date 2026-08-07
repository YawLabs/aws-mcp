#!/usr/bin/env node
// Build a self-contained single-file binary of the @yawlabs/aws-mcp sidecar
// using `oam compile` instead of Node SEA.
//
// Same contract as scripts/build-binary.mjs -- same entry, same output path
// (bin/<platform>-<arch>/<binName>[.exe]) -- so scripts/stage-release-asset.mjs
// and the release flow consume either one unchanged. Run ONE or the OTHER, not
// both: they write to the same path.
//
// Why this exists: `oam compile` embeds a pre-bundled file into oam's runtime
// carrier, which is smaller than the Node SEA carrier and needs no postject
// injection step or fuse sentinel. Measured on win32-arm64 at aws-mcp 1.6.0:
//   Node SEA  79,989,248 bytes (76.28 MB)
//   oam compile 61,447,168 bytes (58.60 MB)
// plus ~493 KB of embedded V8 bytecode that the SEA path does not produce.
//
// CRITICAL: the bundle handed to `oam compile` MUST be CJS.
// `oam compile` runs the embedded file as CommonJS. Feeding it the ESM bundle
// that build.mjs writes to dist/index.js produces a binary that dies at startup
// with `SyntaxError: Cannot use import statement outside a module`, because
// esbuild's ESM banner (`import { createRequire } from 'node:module'`) is the
// first statement. So we re-bundle as CJS here with the same banner/define pair
// build-binary.mjs uses for SEA, rather than reusing dist/index.js.
//
// This script ONLY reads node_modules (via esbuild's resolver) and writes to
// build-tmp/ and bin/<platform>-<arch>/. It does NOT mutate package.json,
// package-lock.json, src/, or node_modules, and it never runs `npm install`.

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const isWin = process.platform === 'win32';

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));
const { version } = pkg;
// Binary name = the package's first `bin` command, so this script stays
// copy-paste generic across @yawlabs/* servers -- no per-repo rename.
const binName = Object.keys(pkg.bin ?? {})[0] ?? pkg.name.split('/').pop();
const binEntry = Object.values(pkg.bin ?? {})[0] ?? pkg.main ?? 'dist/index.js';
const srcEntry = binEntry.replace(/^\.\//, '').replace(/^dist\//, 'src/').replace(/\.[cm]?js$/, '.ts');

const platformDir = `${process.platform}-${process.arch}`;
const binDir = join(repoRoot, 'bin', platformDir);
const tmpDir = join(repoRoot, 'build-tmp');
const bundlePath = join(tmpDir, 'oam-bundle.cjs');
const exeName = isWin ? `${binName}.exe` : binName;
const outExe = join(binDir, exeName);

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, { stdio: 'inherit', cwd: repoRoot, ...opts });
}

function fmtSize(p) {
  const bytes = statSync(p).size;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB (${bytes} bytes)`;
}

mkdirSync(tmpDir, { recursive: true });
mkdirSync(binDir, { recursive: true });

// 1. Bundle everything into one CJS file. Mirrors build-binary.mjs step 1 --
// see the CRITICAL note above for why CJS is not optional here.
await esbuild.build({
  entryPoints: [join(repoRoot, srcEntry)],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // esbuild leaves import.meta.url EMPTY in cjs output, so a server that reads
  // it (createRequire(import.meta.url) to find package.json) would crash at
  // load. Polyfill it to the carrier's own path.
  banner: { js: "const __seaImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  define: { __VERSION__: JSON.stringify(version), 'import.meta.url': '__seaImportMetaUrl' },
  external: ['cpu-features'],
  outfile: bundlePath,
});
console.log(`bundle: ${fmtSize(bundlePath)}`);

// 2. Embed the bundle into oam's runtime carrier. Unlike the SEA path there is
// no separate blob-generation or postject-injection step -- compile writes the
// finished executable directly.
rmSync(outExe, { force: true });
run('oam', ['compile', bundlePath, '-o', outExe]);
if (!isWin) chmodSync(outExe, 0o755);

// 3. macOS: ad-hoc re-sign. Apple Silicon SIGKILLs a Mach-O with no/invalid
// signature at exec, and `--sign -` is the free ad-hoc identity. Best-effort:
// if oam already emits a signed binary this is a harmless no-op. Kept in step
// with build-binary.mjs, whose remove/re-sign dance this mirrors.
if (process.platform === 'darwin') {
  try {
    run('codesign', ['--sign', '-', '--force', '--timestamp=none', outExe]);
    run('codesign', ['--verify', '--verbose', outExe]);
  } catch {
    console.log('(codesign step failed -- continuing; verify the binary launches before shipping)');
  }
}

// 4. Smoke: --verify proves a signature, not that the thing runs. Actually
// launch it, exactly as build-binary.mjs does on darwin, but on every platform
// since oam compile is the newer path and deserves the check everywhere.
run(outExe, ['--version']);

console.log('');
console.log(`OK  ${outExe}`);
console.log(`    ${fmtSize(outExe)}`);
console.log('');
console.log('NOTE: this binary embeds oam\'s runtime (V8, ICU and others). If you');
console.log("      redistribute it, ship oam's LICENSE, NOTICE and THIRD_PARTY_LICENSES.md");
console.log('      alongside it.');
console.log('');
console.log('Verify with:');
console.log(`    "${outExe}" --version`);
