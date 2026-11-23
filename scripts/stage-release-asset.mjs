#!/usr/bin/env node
// Stage an oam-compiled binary as a named release asset + sha256 sidecar.
//
// build-binary-oam.mjs emits bin/<target>/<binName>(.exe), where <target> is
// AWS_MCP_BINARY_TARGET or the host's <platform>-<arch>. This reads the SAME
// target, so a cross-built binary can be staged too -- keyed on the host, a
// darwin or linux binary cross-built on Windows could never be found. It
// renames that to the public asset name the Scoop/Homebrew manifests point at
// (<binName>-<target>[.exe]) and writes a `<asset>.sha256` sidecar in sha256sum
// format (`<hex>  <asset>`) that Scoop's autoupdate `hash.url` reads.
//
// MANUAL and UNWIRED: release.sh does not call this, and releases carry no
// binary assets today; uploading the staged files is up to whoever runs it.
//
// Pure stdlib; writes only to dist-release/. Run after build-binary-oam.mjs,
// with the same AWS_MCP_BINARY_TARGET:
//   AWS_MCP_BINARY_TARGET=linux-x64 node scripts/stage-release-asset.mjs

import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
// The same target derivation as build-binary-oam.mjs.
const TARGET = (process.env.AWS_MCP_BINARY_TARGET ?? `${process.platform}-${process.arch}`).toLowerCase();
const ext = TARGET.startsWith("win32-") ? ".exe" : "";

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
// Binary name = first `bin` command -- keeps this generic across servers.
const binName = Object.keys(pkg.bin ?? {})[0] ?? pkg.name.split("/").pop();
const builtExe = join(repoRoot, "bin", TARGET, `${binName}${ext}`);
const assetName = `${binName}-${TARGET}${ext}`;

const outDir = join(repoRoot, "dist-release");
const outAsset = join(outDir, assetName);
const outSha = `${outAsset}.sha256`;

mkdirSync(outDir, { recursive: true });
rmSync(outAsset, { force: true });
copyFileSync(builtExe, outAsset);
// Preserve the executable bit for a POSIX target (copyFileSync drops it) so the
// staged asset is runnable after download. Keyed on the target, as the build is.
if (!ext) chmodSync(outAsset, 0o755);

const hex = createHash("sha256").update(readFileSync(outAsset)).digest("hex");
// sha256sum format so `sha256sum -c` and Scoop's hash.url sidecar both parse it.
writeFileSync(outSha, `${hex}  ${assetName}\n`);

console.log(`asset:  ${outAsset}`);
console.log(`sha256: ${hex}`);
