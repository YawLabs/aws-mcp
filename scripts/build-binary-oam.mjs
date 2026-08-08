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
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
// Resolve the TypeScript entry directly rather than deriving it from `bin`.
// `bin` points at the oam runtime LAUNCHER (bin/<name>.mjs), so the old
// derivation produced `bin/<name>.ts` -- a path that has never existed -- and
// esbuild failed with "Could not resolve". Prefer the conventional source
// entry, falling back to the dist path for a repo that does not use it.
const distEntry = pkg.main ?? 'dist/index.js';
const srcEntry = existsSync(join(repoRoot, 'src/index.ts'))
  ? 'src/index.ts'
  : distEntry.replace(/^\.\//, '').replace(/^dist\//, 'src/').replace(/\.[cm]?js$/, '.ts');

// The target being built for. Everything downstream -- the bin/<platform-arch>/
// directory, the .exe suffix, the carrier -- keys off THIS, not the build host,
// because `oam compile --carrier` (oam 0.8.3+) can produce a binary for a
// platform we are not running on. Deriving the output path from the host
// instead would file a cross-built ELF as bin/win32-arm64/<name>.exe and ship
// it as the Windows asset.
const HOST_TARGET = `${process.platform}-${process.arch}`;
const TARGET = (process.env.AWS_MCP_BINARY_TARGET ?? HOST_TARGET).toLowerCase();
const isCross = TARGET !== HOST_TARGET;
const targetIsWin = TARGET.startsWith('win32-');

const platformDir = TARGET;
const binDir = join(repoRoot, 'bin', platformDir);
const tmpDir = join(repoRoot, 'build-tmp');
const bundlePath = join(tmpDir, 'oam-bundle.cjs');
const exeName = targetIsWin ? `${binName}.exe` : binName;
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
// ---------------------------------------------------------------- cross-build
//
// `oam compile` embeds the RUNNING oam as its carrier, so without help it can
// only ever produce a binary for the build host. oam 0.8.3 added `--carrier`:
// the embedded payload is platform-independent (appending to an executable's
// tail is tolerated identically by PE, ELF and Mach-O), so only the carrier is
// target-specific. Point `--carrier` at another target's oam release binary and
// one machine can ship every target.
//
//   AWS_MCP_BINARY_TARGET=linux-x64 node scripts/build-binary-oam.mjs
//
// The carrier is fetched from the published oam release and verified against
// that release's SHA256SUMS. That check is not optional: the carrier becomes the
// bulk of a binary we then ship, so an unverified download would be a supply
// chain hole opened by our own build script. A missing or mismatched entry
// aborts rather than warning.
const OAM_ASSETS = {
  'win32-x64': 'oam-x86_64-pc-windows-msvc.exe',
  'win32-arm64': 'oam-aarch64-pc-windows-msvc.exe',
  'darwin-arm64': 'oam-aarch64-apple-darwin',
  'darwin-x64': 'oam-x86_64-apple-darwin',
  'linux-x64': 'oam-x86_64-unknown-linux-gnu',
};

/** Fetch the published oam release binary for `target`, verified against SHA256SUMS. */
async function fetchOamCarrier(target) {
  const asset = OAM_ASSETS[target];
  if (!asset) {
    console.error(
      `build-binary-oam: no oam release asset known for target '${target}'.\n` +
        `Known targets: ${Object.keys(OAM_ASSETS).join(', ')}`,
    );
    process.exit(1);
  }
  // OAM_VERSION pins the release; default tracks latest. Pin it in CI so a
  // rebuild of an old tag does not silently acquire a newer runtime.
  const tag = process.env.OAM_VERSION ?? 'latest';
  const base =
    tag === 'latest'
      ? 'https://github.com/YawLabs/oam/releases/latest/download'
      : `https://github.com/YawLabs/oam/releases/download/${tag}`;
  const dest = join(tmpDir, asset);

  console.log(`> fetch ${base}/${asset}`);
  const res = await fetch(`${base}/${asset}`);
  if (!res.ok) {
    console.error(`build-binary-oam: downloading ${asset} failed (HTTP ${res.status})`);
    process.exit(1);
  }
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));

  const sumsRes = await fetch(`${base}/SHA256SUMS`);
  if (!sumsRes.ok) {
    console.error(
      `build-binary-oam: could not fetch SHA256SUMS (HTTP ${sumsRes.status}); refusing to use an unverified carrier`,
    );
    process.exit(1);
  }
  const want = (await sumsRes.text())
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .find(([, name]) => name?.replace(/^\*/, '') === asset)?.[0];
  if (!want) {
    console.error(`build-binary-oam: ${asset} has no entry in SHA256SUMS; refusing to use an unverified carrier`);
    process.exit(1);
  }
  const got = createHash('sha256').update(readFileSync(dest)).digest('hex');
  if (got !== want) {
    console.error(`build-binary-oam: SHA256 mismatch for ${asset}\n  expected ${want}\n  got      ${got}`);
    process.exit(1);
  }
  console.log(`  sha256 ok (${got.slice(0, 16)}...)`);
  // The downloaded asset is not marked executable on POSIX, and oam has to be
  // able to read it as a carrier regardless -- chmod keeps it usable if someone
  // reaches for it directly.
  try {
    chmodSync(dest, 0o755);
  } catch {}
  return dest;
}

const carrierArgs = isCross ? ['--carrier', await fetchOamCarrier(TARGET)] : [];
run('oam', ['compile', bundlePath, '-o', outExe, ...carrierArgs]);
if (isCross) {
  // Building it is proven for every target; RUNNING it is only proven where we
  // can execute it. Say which one happened rather than implying both.
  console.log(`NOTE: cross-built for ${TARGET} -- not executed here. Smoke it on that target.`);
}
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
