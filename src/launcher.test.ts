import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Same one-level hop src/release-metadata.test.ts uses: this file is authored in
// src/ and executed from dist/, so resolving off import.meta.url reaches the repo
// root regardless of cwd.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = resolve(repoRoot, "bin", "aws-mcp.mjs");
const PACKAGE_VERSION = (JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf-8")) as { version: string })
  .version;

type Plan = "in-process" | "discover";
type RuntimePlan = (ctx: { mode: string; hostOam: string | undefined }) => Plan;

/**
 * Evaluate the REAL `runtimePlan` source, together with the declarations it
 * closes over, without importing the launcher.
 *
 * Why not import it: the launcher's module body resolves a runtime at import
 * time and either spawns oam or imports the server, so importing it from a
 * test would launch a server. Making it importable would mean gating that body
 * behind an entry-point check -- a behaviour change to a shipped runtime
 * artifact whose failure mode (the guard reads false under an npm shim, and the
 * launcher silently does nothing) is worse than the gap this closes. This is
 * the same idiom tailscale-mcp's launcher test uses.
 *
 * Extracting the text exercises the shipped logic rather than a copy that can
 * drift, and a failed extraction is a loud assertion, not a silent skip.
 */
function loadRuntimePlan(): RuntimePlan {
  const source = readFileSync(LAUNCHER, "utf-8");
  const pieces = [
    /const OAM_MIN = \[[^\]]*\];/,
    /function parseVersion\(text\) \{[\s\S]*?\n\}/,
    /function atLeast\(v, min\) \{[\s\S]*?\n\}/,
    /function runtimePlan\(\{ mode, hostOam \}\) \{[\s\S]*?\n\}/,
  ].map((pattern) => {
    const match = source.match(pattern);
    if (!match) throw new Error(`could not extract ${pattern} from bin/aws-mcp.mjs -- renamed or reformatted?`);
    return match[0];
  });
  return new Function(`${pieces.join("\n")}\nreturn runtimePlan;`)() as RuntimePlan;
}

describe("launcher runtimePlan()", () => {
  const runtimePlan = loadRuntimePlan();

  it("serves in-process when already hosted on an oam at or above the floor", () => {
    // The bug this exists for: a host that launches `oam run bin/aws-mcp.mjs`
    // got a SECOND oam, because the launcher discovered and spawned one without
    // asking what it was already running on. `auto` and `oam` both have to take
    // the shortcut -- `oam` demands oam, and the host already is one.
    //
    // 0.9.0 pins the floor as inclusive (it IS the supported release), and
    // 0.10.0 pins a numeric compare: it sorts BEFORE 0.9.0 as a string, so a
    // compare over the raw text would spawn a nested oam on every 0.10+ host.
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of ["0.9.0", "0.10.0", "0.15.1", "1.0.0", "0.16.0-dev"]) {
        assert.equal(runtimePlan({ mode, hostOam }), "in-process", `mode=${mode} hostOam=${hostOam}`);
      }
    }
  });

  it("leaves a host oam below the floor on the discovery path", () => {
    // Same floor as a discovered binary. Below it, behaviour is exactly what it
    // was before the shortcut existed -- and that floor is not cosmetic here:
    // below 0.9.0 oam's execFile ran arguments through a shell, and this server
    // shells out to the aws CLI on nearly every tool.
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of ["0.8.9", "0.8.2", "0.0.1"]) {
        assert.equal(runtimePlan({ mode, hostOam }), "discover", `mode=${mode} hostOam=${hostOam}`);
      }
    }
  });

  it("discovers as before on Node, where process.versions has no oam key", () => {
    // An unreadable value must not count as "new enough" either: that would
    // skip discovery on a host that never proved it is a supported oam.
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of [undefined, "", "dev"]) {
        assert.equal(runtimePlan({ mode, hostOam }), "discover", `mode=${mode} hostOam=${hostOam}`);
      }
    }
  });

  it("runs AWS_MCP_RUNTIME=node in-process whatever the host is", () => {
    for (const hostOam of [undefined, "0.8.2", "0.15.1"]) {
      assert.equal(runtimePlan({ mode: "node", hostOam }), "in-process", `hostOam=${hostOam}`);
    }
  });
});

type LauncherRun = { stdout: string; stderr: string; code: number | null };

/**
 * Run the REAL bin under Node, optionally posing as oam by preloading a
 * `process.versions.oam` key, and return what it wrote.
 *
 * The unit tests above prove the decision; these prove the launcher WIRES it
 * -- that the call site actually reads `process.versions.oam` -- which no
 * amount of testing `runtimePlan` in isolation can. A real oam cannot be
 * assumed on every box this suite runs on, and the preload changes exactly the
 * one fact the launcher branches on.
 *
 * OAM_BIN is pinned to the Node binary running this test, which makes the two
 * outcomes unmistakable without a real oam. In-process, `--version` reaches
 * dist/index.js and prints the package version with exit 0. On the discovery
 * path, findOam returns that pinned Node, `node --version` clears the floor,
 * and the launcher spawns `node run <entry>` -- which has no `run` subcommand,
 * prints no version and exits non-zero. It also keeps a real oam installed on
 * the developer's box out of reach, since findOam checks the override first and
 * never scans past it.
 *
 * Env is a whitelist so an AWS_MCP_* var exported by the developer's shell
 * cannot change what is being asserted.
 */
function runLauncher(hostOam: string | undefined, extraEnv: Record<string, string> = {}): Promise<LauncherRun> {
  const preload =
    hostOam === undefined
      ? []
      : [
          "--import",
          `data:text/javascript,${encodeURIComponent(
            `Object.defineProperty(process.versions, "oam", { value: ${JSON.stringify(hostOam)}, enumerable: true });`,
          )}`,
        ];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [...preload, LAUNCHER, "--version"], {
      env: { PATH: process.env.PATH ?? "", OAM_BIN: process.execPath, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    // `close` rather than `exit`, so both pipes have drained before asserting.
    child.on("close", (code) => resolvePromise({ stdout, stderr, code }));
  });
}

describe("launcher on an oam host", () => {
  // No skip-without-a-build guard: this suite only ever runs as dist/*.test.js
  // after `npm run build`, and the same build that emitted this file emitted
  // the dist/index.js the in-process path imports.
  //
  // Each case boots one to three Node processes, and a bare Node start has been
  // measured at ~11s on a contended Windows box.
  const timeout = 45_000;

  const servedInProcess = (run: LauncherRun) => run.code === 0 && run.stdout.trim() === PACKAGE_VERSION;

  it("control: on plain Node the launcher still discovers and spawns", { timeout }, async () => {
    // Without this, the in-process cases below would also pass for a launcher
    // that ALWAYS runs in-process and never uses oam at all.
    const run = await runLauncher(undefined);
    assert.equal(servedInProcess(run), false, `expected a spawn, got ${JSON.stringify(run)}`);
    assert.notEqual(run.code, 0);
  });

  it("serves in-process instead of spawning a nested oam", { timeout }, async () => {
    const envs: Record<string, string>[] = [{}, { AWS_MCP_RUNTIME: "oam" }];
    for (const extraEnv of envs) {
      const run = await runLauncher("0.15.1", extraEnv);
      assert.equal(servedInProcess(run), true, `${JSON.stringify(extraEnv)} -> ${JSON.stringify(run)}`);
    }
  });

  it("still discovers when the host oam is below the floor", { timeout }, async () => {
    const run = await runLauncher("0.8.9");
    assert.equal(servedInProcess(run), false, `a below-floor host must not shortcut, got ${JSON.stringify(run)}`);
    assert.notEqual(run.code, 0);
    // A spawned child failing, not the launcher diagnosing: every launcher
    // message starts with `aws-mcp: `.
    assert.doesNotMatch(run.stderr, /^aws-mcp: /m);
  });
});
