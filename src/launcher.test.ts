import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Same one-level hop src/release-metadata.test.ts uses: this file is authored in
// src/ and executed from dist/, so resolving off import.meta.url reaches the repo
// root regardless of cwd.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = resolve(repoRoot, "bin", "aws-mcp.mjs");
const PACKAGE_VERSION = (JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf-8")) as { version: string })
  .version;

type Plan = "in-process" | "discover" | "handoff-node";
type RuntimePlan = (ctx: { mode: string; hostOam: string | undefined }) => Plan;
type Candidate = { path: string; version: number[] | null };
type PickNewest = (candidates: Candidate[]) => Candidate | null;

/** Pull named declarations out of the launcher source, loudly. */
function extract(patterns: RegExp[]): string {
  const source = readFileSync(LAUNCHER, "utf-8");
  return patterns
    .map((pattern) => {
      const match = source.match(pattern);
      if (!match) throw new Error(`could not extract ${pattern} from bin/aws-mcp.mjs -- renamed or reformatted?`);
      return match[0];
    })
    .join("\n");
}

const OAM_MIN_DECL = /const OAM_MIN = \[[^\]]*\];/;
const ATLEAST_DECL = /function atLeast\(v, min\) \{[\s\S]*?\n\}/;

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
  const pieces = extract([
    OAM_MIN_DECL,
    /function parseVersion\(text\) \{[\s\S]*?\n\}/,
    ATLEAST_DECL,
    /function runtimePlan\(\{ mode, hostOam \}\) \{[\s\S]*?\n\}/,
  ]);
  return new Function(`${pieces}\nreturn runtimePlan;`)() as RuntimePlan;
}

function loadPickNewest(): { pickNewest: PickNewest; floor: number[] } {
  const pieces = extract([OAM_MIN_DECL, ATLEAST_DECL, /function pickNewest\(candidates\) \{[\s\S]*?\n\}/]);
  return new Function(`${pieces}\nreturn { pickNewest, floor: OAM_MIN };`)() as {
    pickNewest: PickNewest;
    floor: number[];
  };
}

describe("launcher runtimePlan()", () => {
  const runtimePlan = loadRuntimePlan();

  it("serves in-process when already hosted on an oam at or above the floor", () => {
    // The bug this exists for: a host that launches `oam run bin/aws-mcp.mjs`
    // got a SECOND oam, because the launcher discovered and spawned one without
    // asking what it was already running on. `auto` and `oam` both have to take
    // the shortcut -- `oam` demands oam, and the host already is one.
    //
    // 0.16.3 pins the floor as inclusive (it IS the supported release), and
    // 0.100.0 pins a numeric compare: it sorts BEFORE 0.16.3 as a string, so a
    // compare over the raw text would treat a newer oam as too old.
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of ["0.16.3", "0.16.4", "0.100.0", "1.0.0", "0.16.3-dev"]) {
        assert.equal(runtimePlan({ mode, hostOam }), "in-process", `mode=${mode} hostOam=${hostOam}`);
      }
    }
  });

  it("never serves in-process on a host oam below the floor", () => {
    // Below the floor the host must hand off. Serving there was the bug: an oam
    // older than 0.9.0 runs this server's CLI arguments through a shell, and
    // anything older than the latest release is not what the server is
    // verified on.
    for (const mode of ["auto", "oam"]) {
      // 0.16.2 is the just-below case that matters on each bump: the previous
      // release stops being served the moment the floor moves past it.
      for (const hostOam of ["0.16.2", "0.15.2", "0.9.0", "0.8.2", "0.0.1"]) {
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

  it("runs AWS_MCP_RUNTIME=node on Node: in-process on a Node host, handed off from any oam host", () => {
    assert.equal(runtimePlan({ mode: "node", hostOam: undefined }), "in-process");
    for (const hostOam of ["0.8.2", "0.15.2", "1.0.0", "dev"]) {
      assert.equal(runtimePlan({ mode: "node", hostOam }), "handoff-node", `hostOam=${hostOam}`);
    }
  });
});

describe("launcher pickNewest()", () => {
  const { pickNewest, floor } = loadPickNewest();
  const at = (path: string, version: number[] | null): Candidate => ({ path, version });

  it("pins the floor to the latest oam release", () => {
    assert.deepEqual(floor, [0, 16, 3]);
  });

  it("takes the newest usable oam, not the first one found", () => {
    // The bug: discovery stopped at the first binary that existed, so an older
    // copy in an earlier location (the installed dir is searched before PATH)
    // hid a newer one later.
    const chosen = pickNewest([at("installed", [0, 16, 3]), at("path-a", [0, 17, 0]), at("path-b", [0, 16, 9])]);
    assert.equal(chosen?.path, "path-a");
  });

  it("compares numerically and keeps search order on a tie", () => {
    assert.equal(pickNewest([at("a", [0, 16, 3]), at("b", [0, 100, 0])])?.path, "b");
    assert.equal(pickNewest([at("first", [0, 16, 3]), at("second", [0, 16, 3])])?.path, "first");
  });

  it("skips binaries below the floor or with no readable version", () => {
    assert.equal(pickNewest([at("old", [0, 9, 0]), at("broken", null), at("good", [0, 16, 3])])?.path, "good");
    assert.equal(pickNewest([at("old", [0, 16, 2]), at("broken", null)]), null);
    assert.equal(pickNewest([]), null);
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
 * path, the pinned Node answers `--version` with v22.x, which clears the floor,
 * so it is chosen and the launcher spawns `node run <entry>` -- which has no
 * `run` subcommand, prints no version and exits non-zero. A usable OAM_BIN is
 * taken before discovery runs, so a real oam on the developer's box is never
 * reached either.
 *
 * Env is a whitelist so an AWS_MCP_* var exported by the developer's shell
 * cannot change what is being asserted.
 */
function runLauncher(
  hostOam: string | undefined,
  extraEnv: Record<string, string> = {},
  extraPreload = "",
): Promise<LauncherRun> {
  // Every run also reports, at exit, what the LAUNCHER process's argv[1] ended
  // up as. runInProcess points it at dist/index.js; a handoff leaves it on the
  // launcher. That is the only way to tell "served in-process" from "handed
  // off to a child that printed the same version".
  const exitMarker = `import { writeSync } from "node:fs"; process.on("exit", () => { try { writeSync(2, "LAUNCHER_ARGV1=" + process.argv[1] + "\\n"); } catch {} });`;
  const posing =
    hostOam === undefined
      ? ""
      : `Object.defineProperty(process.versions, "oam", { value: ${JSON.stringify(hostOam)}, enumerable: true });`;
  const preload = ["--import", `data:text/javascript,${encodeURIComponent(`${exitMarker}${posing}${extraPreload}`)}`];
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
      const run = await runLauncher("0.16.3", extraEnv);
      assert.equal(servedInProcess(run), true, `${JSON.stringify(extraEnv)} -> ${JSON.stringify(run)}`);
      assert.match(run.stderr, /LAUNCHER_ARGV1=.*dist[\\/]index\.js/);
    }
  });

  it("still discovers when the host oam is below the floor", { timeout }, async () => {
    const run = await runLauncher("0.16.2");
    assert.equal(servedInProcess(run), false, `a below-floor host must not shortcut, got ${JSON.stringify(run)}`);
    assert.notEqual(run.code, 0);
    // A spawned child failing, not the launcher diagnosing: every launcher
    // message starts with `aws-mcp: `.
    assert.doesNotMatch(run.stderr, /^aws-mcp: /m);
  });
});

describe("launcher with no usable oam", () => {
  const timeout = 45_000;

  /**
   * An environment with no oam anywhere: HOME and LOCALAPPDATA point at an
   * empty directory, so the installed locations are empty, and PATH holds only
   * the directory of the Node running this test. Keeps a real oam on the
   * developer's box out of reach.
   */
  function isolated(extra: Record<string, string> = {}): Record<string, string> {
    const empty = mkdtempSync(join(tmpdir(), "aws-mcp-launcher-home-"));
    return {
      PATH: dirname(process.execPath),
      USERPROFILE: empty,
      HOME: empty,
      LOCALAPPDATA: empty,
      ...extra,
    };
  }

  it("names an OAM_BIN that does not exist instead of falling back silently", { timeout }, async () => {
    const run = await runLauncher(undefined, isolated({ OAM_BIN: join(tmpdir(), "no-such-dir", "oam.exe") }));
    assert.equal(run.code, 0, JSON.stringify(run));
    assert.equal(run.stdout.trim(), PACKAGE_VERSION);
    assert.match(run.stderr, /^aws-mcp: OAM_BIN=.*does not exist; using Node instead\.$/m);
  });

  it("hands a below-floor oam host off to Node rather than serving on it", { timeout }, async () => {
    const run = await runLauncher("0.9.0", isolated({ OAM_BIN: join(tmpdir(), "no-such-dir", "oam.exe") }));
    assert.equal(run.code, 0, JSON.stringify(run));
    assert.equal(run.stdout.trim(), PACKAGE_VERSION, "the Node child must still serve");
    assert.match(
      run.stderr,
      /this process is oam 0\.9\.0, older than 0\.16\.3, and no newer oam was found; running on .*node/,
    );
    // Served by the child, not in the launcher process: argv[1] was never
    // pointed at dist/index.js.
    assert.match(run.stderr, /LAUNCHER_ARGV1=.*aws-mcp\.mjs/);
  });

  it("refuses to serve on a below-floor oam host when there is no Node either", { timeout }, async () => {
    const empty = isolated();
    const noNode = mkdtempSync(join(tmpdir(), "aws-mcp-launcher-nopath-"));
    const run = await runLauncher("0.9.0", { ...empty, PATH: noNode, OAM_BIN: join(noNode, "oam.exe") });
    assert.equal(run.code, 1, JSON.stringify(run));
    assert.equal(run.stdout.trim(), "", "nothing may be served");
    assert.match(run.stderr, /no Node was found on PATH/);
  });

  it("hands AWS_MCP_RUNTIME=node off to Node even on a supported oam host", { timeout }, async () => {
    const run = await runLauncher("0.15.2", isolated({ AWS_MCP_RUNTIME: "node" }));
    assert.equal(run.code, 0, JSON.stringify(run));
    assert.equal(run.stdout.trim(), PACKAGE_VERSION);
    assert.match(run.stderr, /LAUNCHER_ARGV1=.*aws-mcp\.mjs/);
  });

  it("still falls back when the chosen oam fails to spawn on an oam host", { timeout }, async () => {
    // The chosen binary passed its --version probe and then could not be
    // spawned (deleted or replaced in between). A failed spawn emits 'error'
    // and then 'close' with the negative errno, and on an oam host the launcher
    // waits for 'close' -- so an unguarded close handler exited the launcher
    // mid-fallback and nothing served. The preload makes the FIRST spawn target
    // a path that does not exist; the Node fallback spawns normally.
    const failFirstSpawn = [
      'import childProcess from "node:child_process";',
      'import { syncBuiltinESMExports } from "node:module";',
      "const realSpawn = childProcess.spawn;",
      "let failed = false;",
      "childProcess.spawn = function (cmd, args, opts) {",
      "  if (failed) return realSpawn.call(this, cmd, args, opts);",
      "  failed = true;",
      '  return realSpawn.call(this, cmd + ".does-not-exist", args, opts);',
      "};",
      "syncBuiltinESMExports();",
    ].join("\n");
    const run = await runLauncher("0.9.0", isolated({ OAM_BIN: process.execPath }), failFirstSpawn);
    assert.equal(run.code, 0, JSON.stringify(run));
    assert.equal(run.stdout.trim(), PACKAGE_VERSION, "the Node fallback must still serve");
    assert.match(run.stderr, /failed to launch oam at .*using Node instead/);
  });
});
