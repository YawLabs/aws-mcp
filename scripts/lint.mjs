#!/usr/bin/env node
/**
 * Run biome against a binary that actually works on this host.
 *
 * Everywhere except Windows ARM64 this is a thin passthrough to the platform
 * binary npm installed. It exists for the one host where that binary is
 * unusable: on MINGW64-ARM64 the native `@biomejs/cli-win32-arm64` build
 * SEGFAULTS on every invocation path -- `npm run lint` (exit 139), the
 * `.bin/biome` shim (139), `biome.cmd` from PowerShell (STATUS_ACCESS_VIOLATION
 * 0xC0000005), and `node node_modules/@biomejs/biome/bin/biome` (silent, no
 * output at all). The crash is inside the arm64 executable, so no wrapper or
 * shell change dodges it.
 *
 * The x64 build runs fine under Windows' x64 emulation and produces a real,
 * authoritative result -- verified 2026-08-22 at biome 2.4.12, where it caught
 * two genuine formatter diffs that every arm64 invocation had silently missed.
 * So on that host this script provisions the x64 package into a gitignored
 * cache and runs THAT.
 *
 * Why this is a script and not a devDependency: npm refuses to install
 * `@biomejs/cli-win32-x64` on an arm64 host (EBADPLATFORM), which is precisely
 * the situation we are working around, so it cannot be declared normally. The
 * install below passes `--force` for that reason and `--no-save` so the
 * workaround never leaks into package.json.
 *
 * Why it matters here specifically: this repo ships no CI by design, so there
 * is no runner to arbitrate formatting later. Whatever this script reports is
 * the ONLY lint signal that exists before `release.sh` publishes to npm.
 *
 * Escape hatches, in case the platform assumption ages badly:
 *   AWS_MCP_BIOME_BIN=<path>   use exactly this binary, skip all detection
 *   AWS_MCP_BIOME_NATIVE=1     force the normal platform binary on any host
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const exe = isWindows ? ".exe" : "";

/**
 * The biome version to provision, read from biome.json's `$schema` URL rather
 * than hardcoded. The schema URL is what biome validates the config against, so
 * sourcing the version from it is what guarantees the emulated binary and the
 * repo config agree -- a hardcoded constant here would drift silently on the
 * next biome bump and "lint clean" would stop meaning what it says.
 */
function biomeVersionFromConfig() {
  const schema = JSON.parse(readFileSync(join(repoRoot, "biome.json"), "utf8")).$schema;
  const match = typeof schema === "string" ? schema.match(/schemas\/(\d+\.\d+\.\d+)\//) : null;
  if (!match) {
    throw new Error(
      `Could not read a version out of biome.json's $schema (${String(schema)}). ` +
        "Expected the shape https://biomejs.dev/schemas/<x.y.z>/schema.json.",
    );
  }
  return match[1];
}

/** The platform binary npm installed for THIS host, or null when absent. */
function nativeBinary() {
  const pkg = `@biomejs/cli-${process.platform}-${process.arch}`;
  const direct = join(repoRoot, "node_modules", ...pkg.split("/"), `biome${exe}`);
  if (existsSync(direct)) return direct;
  // musl and other suffixed variants (cli-linux-x64-musl) don't match the plain
  // name above; fall back to the shim npm links, which is correct everywhere the
  // native binary is not itself broken.
  const shim = join(repoRoot, "node_modules", ".bin", isWindows ? "biome.cmd" : "biome");
  return existsSync(shim) ? shim : null;
}

/**
 * Provision (once) and return the emulated x64 binary. Installs into
 * node_modules/.cache, which is already gitignored via node_modules/ and is
 * wiped by `npm ci` -- the next run simply re-installs it.
 */
function emulatedX64Binary(version) {
  const prefix = join(repoRoot, "node_modules", ".cache", "biome-x64");
  const bin = join(prefix, "node_modules", "@biomejs", "cli-win32-x64", "biome.exe");
  if (existsSync(bin)) return bin;

  console.error(`[lint] the win32-arm64 biome binary segfaults on this host; provisioning x64 ${version} under emulation`);
  const install = spawnSync(
    "npm",
    ["i", "--no-save", "--force", "--prefix", prefix, `@biomejs/cli-win32-x64@${version}`],
    { stdio: "inherit", shell: isWindows },
  );
  if (install.status !== 0 || !existsSync(bin)) {
    throw new Error(
      `Failed to provision @biomejs/cli-win32-x64@${version} (npm exited ${install.status}).\n` +
        "This repo has no CI, so there is no other lint signal. Fix the install, or set\n" +
        "AWS_MCP_BIOME_BIN=<path to a working biome> to point this script at one.",
    );
  }
  return bin;
}

function resolveBinary() {
  if (process.env.AWS_MCP_BIOME_BIN) return process.env.AWS_MCP_BIOME_BIN;

  const brokenNative = isWindows && process.arch === "arm64" && process.env.AWS_MCP_BIOME_NATIVE !== "1";
  if (brokenNative) return emulatedX64Binary(biomeVersionFromConfig());

  const native = nativeBinary();
  if (!native) {
    throw new Error("No biome binary found in node_modules -- run `npm install` first.");
  }
  return native;
}

let binary;
try {
  binary = resolveBinary();
} catch (err) {
  console.error(`[lint] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// Exit with biome's own status so `npm run lint` stays a usable gate, and so a
// non-zero result is a real finding rather than this wrapper's opinion.
const run = spawnSync(binary, process.argv.slice(2), { stdio: "inherit", shell: false });
if (run.error) {
  console.error(`[lint] could not execute ${binary}: ${run.error.message}`);
  process.exit(1);
}
if (run.signal) {
  console.error(
    `[lint] biome was killed by ${run.signal} (${binary}).\n` +
      "On Windows ARM64 that is the known native-binary crash; this script normally\n" +
      "routes around it, so check AWS_MCP_BIOME_BIN / AWS_MCP_BIOME_NATIVE overrides.",
  );
  process.exit(1);
}
process.exit(run.status ?? 1);
