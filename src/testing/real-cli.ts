/**
 * Shared harness for the `*.realcli.test.ts` suites. Those suites drive the AWS
 * CLI v2 installed on this machine -- not the fake in fake-aws.ts -- against an
 * HTTP endpoint inside the test process, so what the fake says the CLI prints
 * gets checked against what the real one prints. The fake can only repeat what
 * it was told; `aws_logs_tail` shipped parsing a format the real CLI has never
 * produced because the fake was the only CLI the suite ever ran.
 *
 * Test-only. Nothing reachable from src/index.ts imports this file, and esbuild
 * bundles from src/index.ts alone, so it never lands in dist/index.js, the
 * bundle the package publishes.
 *
 * Nothing here may reach AWS or read the developer's own credentials:
 *   - startLoopbackStub listens on 127.0.0.1 only, and every call a suite makes
 *     is pointed at it with --endpoint-url.
 *   - isolateAwsEnv scrubs every AWS_* / PYTHON* variable and every proxy
 *     setting from process.env, points the CLI at throwaway config and
 *     credentials files holding fake static keys, and sends everything not
 *     bound for the loopback through a proxy on 127.0.0.1:1, where nothing
 *     listens. A request that escapes the endpoint override -- a credential
 *     provider, a region-derived hostname -- fails to connect instead of
 *     leaving the machine.
 *
 * Two gates. Suites that are fast and deterministic run on every `npm test` and
 * skip when detectRealAwsCli finds no CLI v2. Suites that wait out real
 * timeouts and the CLI's own retry backoff also need AWS_MCP_REAL_CLI_TESTS=1
 * (REAL_CLI_SLOW).
 *
 * Rules for every real-CLI call:
 *   - never pass `command` and never set AWS_MCP_TEST_AWS_COMMAND, so the CLI
 *     under test is the one runAwsCall picks for itself;
 *   - route the call at the stub;
 *   - run inside isolateAwsEnv;
 *   - have the suite show, in a preflight, that the stub received at least one
 *     request. Without that, a suite whose calls never arrive passes every
 *     "zero requests" assertion without testing anything.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAwsCommand } from "../aws-spawn.js";

/**
 * True when AWS_MCP_REAL_CLI_TESTS=1. Gates the real-CLI suites that are too
 * slow for every `npm test`: they wait out real read timeouts and the CLI's
 * retry backoff, plant binaries, or rewrite config.
 */
export const REAL_CLI_SLOW: boolean = process.env.AWS_MCP_REAL_CLI_TESTS === "1";

export interface RealAwsCli {
  /** The absolute path runAwsCall will spawn, straight from resolveAwsCommand. */
  command: string;
  /** The line `aws --version` printed, for a suite title. */
  versionLine: string;
  version: [number, number, number];
}

// Generous on purpose: this runs at module load, and a cold start of the
// frozen CLI on a machine busy with a parallel `node --test` run is slow.
const VERSION_PROBE_TIMEOUT_MS = 30_000;
const AWS_CLI_VERSION_RE = /aws-cli\/(\d+)\.(\d+)\.(\d+)/;

/**
 * Pull the version out of `aws --version` output, e.g.
 * `aws-cli/2.34.3 Python/3.13.11 Windows/11 exe/ARM64`. Null when no line
 * carries an `aws-cli/X.Y.Z` token.
 */
export function parseAwsCliVersion(output: string): { versionLine: string; version: [number, number, number] } | null {
  for (const line of output.split(/\r?\n/)) {
    const m = AWS_CLI_VERSION_RE.exec(line);
    if (m) return { versionLine: line.trim(), version: [Number(m[1]), Number(m[2]), Number(m[3])] };
  }
  return null;
}

/**
 * True when `version` is at least `min`. Exported because several real-CLI
 * cases branch on a CLI version rather than skipping -- the output-encoding
 * pin and FilterLogEvents' startFromHead both changed behavior at a known
 * release -- and because it is the comparison that decides whether a suite
 * runs at all, so it gets direct coverage.
 */
export function meetsMinVersion(version: readonly number[], min: readonly [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i] !== min[i]) return version[i] > min[i];
  }
  return true;
}

/**
 * Find the AWS CLI v2 a real-CLI call would run, by resolving it exactly the way
 * runAwsCall does -- resolveAwsCommand over `opts.env` (default process.env),
 * AWS_MCP_AWS_CLI included -- and then running `--version` on the path it
 * returns. `ok: false` when there is no CLI, it cannot be started, it is not v2,
 * or it is older than `minVersion`; `reason` says which, for a skip message.
 *
 * Sharing the resolver is the point: a suite that found its CLI some other way
 * could skip while runAwsCall runs something else, or run against a binary the
 * server would refuse. The resolver's own not-found message already names an
 * `aws.cmd` shim it had to pass over, which is why there is no separate
 * explanation here.
 */
export function detectRealAwsCli(
  opts: { env?: NodeJS.ProcessEnv; minVersion?: [number, number, number] } = {},
): { ok: true; cli: RealAwsCli } | { ok: false; reason: string } {
  const env = opts.env ?? process.env;
  const resolution = resolveAwsCommand({ env });
  if (!resolution.ok) return { ok: false, reason: resolution.error };
  const command = resolution.command;
  const r = spawnSync(command, ["--version"], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: VERSION_PROBE_TIMEOUT_MS,
  });
  if (r.error) {
    // The resolver stat-ed this path a moment ago, so a failure here is the file
    // going away, a permission problem, or a binary this runtime will not start.
    return { ok: false, reason: `'${command} --version' could not run: ${r.error.message}` };
  }
  const output = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  if (r.status !== 0) {
    return { ok: false, reason: `'${command} --version' exited with code ${r.status}: ${output.trim().slice(0, 300)}` };
  }
  const parsed = parseAwsCliVersion(output);
  if (!parsed) {
    return { ok: false, reason: `'${command} --version' printed no aws-cli version: ${output.trim().slice(0, 300)}` };
  }
  if (parsed.version[0] !== 2) {
    return { ok: false, reason: `'${command} --version' printed "${parsed.versionLine}", which is not AWS CLI v2` };
  }
  if (opts.minVersion && !meetsMinVersion(parsed.version, opts.minVersion)) {
    return {
      ok: false,
      reason: `aws-cli ${parsed.version.join(".")} is older than ${opts.minVersion.join(".")}, which this suite needs`,
    };
  }
  return { ok: true, cli: { command, ...parsed } };
}

export interface StubRequest {
  method: string;
  /** The request target as sent, query string included. */
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export type StubHandler = (req: StubRequest, res: ServerResponse) => void | Promise<void>;

export interface LoopbackStub {
  /** `http://127.0.0.1:<port>`, ready for --endpoint-url. */
  url: string;
  port: number;
  /** Every request received, in arrival order, recorded before the handler runs. */
  requests: StubRequest[];
  /** Stop listening and destroy every open connection, keep-alive ones included. */
  close(): Promise<void>;
}

/**
 * An HTTP server on 127.0.0.1 and an OS-assigned port, so parallel test files
 * never collide. Each request is recorded once its body has arrived, then
 * handed to `handler`, which owns the response.
 */
export async function startLoopbackStub(handler: StubHandler): Promise<LoopbackStub> {
  const requests: StubRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const recorded: StubRequest = {
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(recorded);
      Promise.resolve()
        .then(() => handler(recorded, res))
        .catch((err: unknown) => {
          // A throwing handler is a bug in the test. Answer at once so the CLI
          // call fails where the test can see it, instead of hanging until the
          // CLI's read timeout.
          if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
          res.end(`loopback stub handler threw: ${err instanceof Error ? err.message : String(err)}`);
        });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        // server.close() alone waits for idle keep-alive sockets to time out,
        // which the CLI's connection pool leaves open.
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** Where isolateAwsEnv sends every request not bound for the loopback: a port nothing listens on. */
export const DEAD_PROXY_URL = "http://127.0.0.1:1";

// Syntactically plausible, recognizably fake, and deliberately not the AKIA
// shape, so no secret scanner mistakes them for a leaked key. The CLI signs
// with whatever it is given; the stub never checks a signature.
export const FAKE_ACCESS_KEY_ID = "AWSMCPREALCLIFAKEKEY";
export const FAKE_SECRET_ACCESS_KEY = "aws-mcp-real-cli-fake-secret-not-a-key";

const DEFAULT_CONFIG = "[default]\nregion = us-east-1\n";
const DEFAULT_CREDENTIALS = `[default]\naws_access_key_id = ${FAKE_ACCESS_KEY_ID}\naws_secret_access_key = ${FAKE_SECRET_ACCESS_KEY}\n`;

const PROXY_VARS: ReadonlySet<string> = new Set(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]);

/**
 * The one AWS_* variable the scrub keeps. It names which `aws` binary to run and
 * carries no credentials, and keeping it is what makes
 * `AWS_MCP_AWS_CLI=<old aws.exe> npm test` run these suites against that CLI --
 * the release check that a fix works on an older 2.x as well as the installed
 * one. Scrubbing it would have left the operator watching a suite titled with
 * the old version while every call ran the new one.
 *
 * AWS_MCP_TEST_AWS_COMMAND is deliberately NOT here: it is an in-process test
 * seam that bypasses resolution, and a real-CLI suite must not use it.
 */
const KEPT_AWS_VARS: ReadonlySet<string> = new Set(["AWS_MCP_AWS_CLI"]);

export interface IsolatedAwsEnv {
  /** Private temp directory holding the two files below; removed by restore(). */
  dir: string;
  configFile: string;
  credentialsFile: string;
  /** Put process.env back exactly as it was and remove `dir`. Idempotent. */
  restore(): void;
}

/**
 * Rewrite process.env so a CLI spawned from this process can only talk to the
 * loopback, with fake credentials:
 *   1. delete every variable whose upper-case name starts with AWS_ (this
 *      covers AWS_MCP_TEST_*) or PYTHON, and every spelling of HTTP_PROXY,
 *      HTTPS_PROXY, ALL_PROXY and NO_PROXY -- except AWS_MCP_AWS_CLI, which
 *      names the binary to run rather than an identity (KEPT_AWS_VARS);
 *   2. set HTTP_PROXY and HTTPS_PROXY to DEAD_PROXY_URL, NO_PROXY to the
 *      loopback, AWS_EC2_METADATA_DISABLED=true, AWS_REGION=us-east-1, an
 *      empty AWS_PAGER, and AWS_CONFIG_FILE / AWS_SHARED_CREDENTIALS_FILE to
 *      new files in a private temp dir -- `opts.config` / `opts.credentials`
 *      when given, else a `[default]` profile with fake static keys;
 *   3. apply `opts.set` last, so it can override any of the above.
 *
 * Mutates the live process.env on purpose: runAwsCall's spawn inherits it, and
 * so does every child the CLI starts. `node --test` runs each test file in its
 * own process, so the change cannot leak into another file; within a file,
 * call restore() in an `after` hook.
 */
export function isolateAwsEnv(
  opts: { config?: string; credentials?: string; set?: Readonly<Record<string, string>> } = {},
): IsolatedAwsEnv {
  const snapshot: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) snapshot[key] = value;
  }

  const dir = mkdtempSync(join(tmpdir(), "aws-mcp-realcli-"));
  const configFile = join(dir, "config");
  const credentialsFile = join(dir, "credentials");
  writeFileSync(configFile, opts.config ?? DEFAULT_CONFIG);
  writeFileSync(credentialsFile, opts.credentials ?? DEFAULT_CREDENTIALS);

  for (const key of Object.keys(process.env)) {
    const upper = key.toUpperCase();
    if (KEPT_AWS_VARS.has(upper)) continue;
    if (upper.startsWith("AWS_") || upper.startsWith("PYTHON") || PROXY_VARS.has(upper)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, {
    HTTP_PROXY: DEAD_PROXY_URL,
    HTTPS_PROXY: DEAD_PROXY_URL,
    NO_PROXY: "127.0.0.1,localhost",
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_REGION: "us-east-1",
    AWS_PAGER: "",
    AWS_CONFIG_FILE: configFile,
    AWS_SHARED_CREDENTIALS_FILE: credentialsFile,
    ...opts.set,
  });

  let restored = false;
  return {
    dir,
    configFile,
    credentialsFile,
    restore() {
      if (restored) return;
      restored = true;
      // Delete before re-setting. On Windows the names are case-insensitive,
      // so deleting our HTTP_PROXY also clears the slot for a snapshot
      // `http_proxy`, which the loop below then recreates in its own spelling.
      for (const key of Object.keys(process.env)) {
        if (!Object.hasOwn(snapshot, key)) delete process.env[key];
      }
      Object.assign(process.env, snapshot);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
