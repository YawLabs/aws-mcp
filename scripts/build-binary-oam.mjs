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
import {
  parseManifest,
  predatesSigning,
  verifyManifestSignature,
  verifyPresigningSums,
} from './lib/oam-release-verify.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

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
// that release's SIGNED RELEASE-MANIFEST (oam v0.18.0+): `ssh-keygen -Y verify`
// against the release keys vendored in scripts/oam-release-keys/, the manifest's
// tag checked against the one requested, and the carrier's sha256 taken from
// the manifest -- not from the unsigned SHA256SUMS served beside the binary,
// which only proves the two came from the same server. See
// scripts/lib/oam-release-verify.mjs. That check is not optional: the carrier
// becomes the bulk of a binary we then ship, so an unverified download would be
// a supply chain hole opened by our own build script. Every failure aborts
// rather than warning. Only a tag before v0.18.0, which has no manifest, uses
// its SHA256SUMS -- checked against the pinned digest vendored in
// scripts/oam-release-keys/presigning-sums, as oam's installers check it -- and
// says so.
const OAM_ASSETS = {
  'win32-x64': 'oam-x86_64-pc-windows-msvc.exe',
  'win32-arm64': 'oam-aarch64-pc-windows-msvc.exe',
  'darwin-arm64': 'oam-aarch64-apple-darwin',
  'darwin-x64': 'oam-x86_64-apple-darwin',
  'linux-x64': 'oam-x86_64-unknown-linux-gnu',
};

/** The launcher's floor, `const OAM_MIN = [x, y, z]` in the bin, as a tag. */
function launcherFloorTag() {
  const launcher = join(repoRoot, Object.values(pkg.bin ?? {})[0] ?? `bin/${binName}.mjs`);
  const m = /const OAM_MIN = \[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]/.exec(readFileSync(launcher, 'utf-8'));
  if (!m) {
    console.error(`build-binary-oam: could not read OAM_MIN from ${launcher}; set OAM_VERSION=vX.Y.Z`);
    process.exit(1);
  }
  return `v${m[1]}.${m[2]}.${m[3]}`;
}

async function download(url, dest) {
  console.log(`> fetch ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`build-binary-oam: downloading ${url} failed (HTTP ${res.status}); refusing to use an unverified carrier`);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (dest) writeFileSync(dest, buf);
  return buf;
}

/** Fetch the published oam release binary for `target`, verified against its signed RELEASE-MANIFEST. */
async function fetchOamCarrier(target) {
  const asset = OAM_ASSETS[target];
  if (!asset) {
    console.error(
      `build-binary-oam: no oam release asset known for target '${target}'.\n` +
        `Known targets: ${Object.keys(OAM_ASSETS).join(', ')}`,
    );
    process.exit(1);
  }
  // OAM_VERSION pins the release; the default is the launcher's floor
  // (OAM_MIN), the one oam release this server is verified on -- never
  // 'latest', which would let a rebuild silently acquire a newer runtime and
  // has no fixed tag for the manifest to be checked against.
  const rawTag = process.env.OAM_VERSION ?? launcherFloorTag();
  const tag = rawTag.startsWith('v') ? rawTag : `v${rawTag}`;
  let unsigned;
  try {
    unsigned = predatesSigning(tag);
  } catch (err) {
    console.error(`build-binary-oam: OAM_VERSION ${err.message}`);
    process.exit(1);
  }
  const base = `https://github.com/YawLabs/oam/releases/download/${tag}`;
  const dest = join(tmpDir, asset);
  await download(`${base}/${asset}`, dest);

  let want;
  if (unsigned) {
    // Releases before v0.18.0 carry no manifest. Their SHA256SUMS is checked
    // against the vendored pin for that tag, as oam's installers do.
    console.warn(`WARNING: oam ${tag} predates signed releases; checking its SHA256SUMS against the pinned digest.`);
    const sumsBytes = await download(`${base}/SHA256SUMS`);
    try {
      want = verifyPresigningSums({ sumsBytes, tag }).get(asset);
    } catch (err) {
      console.error(`build-binary-oam: ${err.message}; refusing to use an unverified carrier`);
      process.exit(1);
    }
  } else {
    const manifestPath = join(tmpDir, `RELEASE-MANIFEST-${tag}`);
    const sigPath = `${manifestPath}.sig`;
    await download(`${base}/RELEASE-MANIFEST`, manifestPath);
    await download(`${base}/RELEASE-MANIFEST.sig`, sigPath);
    try {
      const principal = verifyManifestSignature({ manifestPath, sigPath, tag });
      want = parseManifest(readFileSync(manifestPath, 'utf-8'), tag).get(asset);
      console.log(`  RELEASE-MANIFEST ${tag} signed by ${principal}`);
    } catch (err) {
      console.error(`build-binary-oam: ${err.message}; refusing to use an unverified carrier`);
      process.exit(1);
    }
  }
  if (!want) {
    console.error(
      `build-binary-oam: ${asset} has no entry in the ${unsigned ? 'pinned SHA256SUMS' : 'signed manifest'} for ${tag}; refusing to use an unverified carrier`,
    );
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
// Keyed on the TARGET, not the host. Keyed on the host, a POSIX asset
// cross-built on Windows shipped with no execute bit -- and the cross case is
// exactly where it matters, because a host build is already executable where it
// was made. chmod does not move a mode on a Windows host anyway, so keying this
// on the target is only ever additive.
if (!targetIsWin) chmodSync(outExe, 0o755);

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
//
// Except a cross build, which cannot be launched here by definition -- the NOTE
// above already says so. MEASURED 2026-09-20 on win32-arm64, oam 0.16.1:
// AWS_MCP_BINARY_TARGET=darwin-arm64 now completes (exit 0) and produces a real
// 64-bit arm64 Mach-O (magic feedfacf, cputype 0x0100000c, 62.77 MB). Unguarded,
// the last line of that SUCCESSFUL build threw -- ENOENT here rather than the
// ENOEXEC one might expect, because Windows refuses the image before it is ever a
// question of format -- so a caller checking the exit status threw away a good
// artifact. macOS is review-only on this account, which makes cross-building the
// only way a macOS binary can exist at all: this was the whole path to that
// asset, not an edge of it.
if (isCross) {
  console.log('SKIP smoke: ' + TARGET + ' cannot run on ' + HOST_TARGET + '. Run --version on that target: ' + outExe);
} else {
  run(outExe, ['--version']);
}

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
