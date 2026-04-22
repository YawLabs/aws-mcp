/**
 * AWS SSO login via the `--no-browser` device-code flow.
 *
 * The pain this solves: `aws sso login` tries to open the OS default browser.
 * From an AI-assistant-spawned subprocess, that handoff drops silently on
 * Windows (wrong user session / sandbox). The `--no-browser` flag prints a
 * URL + short code to stdout instead — we parse them and surface them so the
 * user clicks one link in the window they're already in. Zero context switch.
 *
 * The token ends up cached in `~/.aws/sso/cache/<hash>.json` the same way a
 * normal `aws sso login` would, so the rest of the SDK ecosystem picks it up
 * transparently.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

const KILL_ESCALATION_MS = 2_000;

function killProc(proc: ChildProcess): void {
  try {
    proc.kill("SIGTERM");
  } catch {
    // proc may already be dead
  }
  // SIGTERM is ignored on Windows; escalate if the process is still around
  // after a short grace period.
  setTimeout(() => {
    if (!proc.killed && proc.exitCode === null) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // best effort
      }
    }
  }, KILL_ESCALATION_MS).unref();
}

export interface LoginStartResult {
  ok: true;
  sessionId: string;
  verificationUrl: string;
  userCode: string;
  profile: string;
}

export interface LoginStartError {
  ok: false;
  error: string;
  rawOutput?: string;
}

export interface LoginWaitResult {
  ok: boolean;
  exitCode: number | null;
  error?: string;
  rawOutput?: string;
}

interface LoginSession {
  profile: string;
  proc: ChildProcess;
  verificationUrl: string;
  userCode: string;
  stdoutBuf: string;
  stderrBuf: string;
  completion: Promise<LoginWaitResult>;
}

const sessions = new Map<string, LoginSession>();

// Exported for tests — these regexes are load-bearing when the aws CLI output
// format shifts between versions, so they need direct coverage.
export const URL_RE = /https:\/\/device\.sso[.\w-]*\.amazonaws\.com\/[^\s]*/;
export const CODE_RE = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;
const URL_WAIT_MS = 15_000;

export function parseLoginOutput(text: string): { url: string | null; code: string | null } {
  const urlMatch = text.match(URL_RE);
  const codeMatch = text.match(CODE_RE);
  return {
    url: urlMatch ? urlMatch[0] : null,
    code: codeMatch ? codeMatch[1] : null,
  };
}

/**
 * Test-injection knobs. In production we always spawn the real `aws` binary
 * with the default timeout. Tests override `command`/`prefixArgs` to point at
 * a controlled fake (see src/testing/fake-aws.ts) and shrink `urlWaitMs` so
 * timeout cases don't take 15 seconds.
 */
export interface SsoLoginOptions {
  command?: string;
  prefixArgs?: string[];
  urlWaitMs?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Spawn `aws sso login --no-browser`, wait for the URL + code to appear in
 * stdout, then return them. The subprocess keeps running in the background —
 * call `waitForLogin(sessionId)` to block until the user completes auth.
 */
export function startSsoLogin(
  profile: string,
  opts: SsoLoginOptions = {},
): Promise<LoginStartResult | LoginStartError> {
  const command = opts.command ?? "aws";
  const prefixArgs = opts.prefixArgs ?? [];
  const urlWaitMs = opts.urlWaitMs ?? URL_WAIT_MS;
  const spawnEnv = opts.env;

  return new Promise((resolve) => {
    const args = [...prefixArgs, "sso", "login", "--no-browser"];
    if (profile) {
      args.push("--profile", profile);
    }

    let proc: ChildProcess;
    try {
      proc = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        ...(spawnEnv ? { env: spawnEnv } : {}),
      });
    } catch (err) {
      resolve({
        ok: false,
        error: `Failed to spawn '${command}': ${err instanceof Error ? err.message : String(err)}. Is the AWS CLI installed and on PATH?`,
      });
      return;
    }

    let stdoutBuf = "";
    let stderrBuf = "";
    let urlSeen: string | null = null;
    let codeSeen: string | null = null;
    let settled = false;
    let completionResolve: (r: LoginWaitResult) => void;
    const completion = new Promise<LoginWaitResult>((res) => {
      completionResolve = res;
    });
    // Per-stream UTF-8 decoders so multi-byte chars split across chunks
    // (possible in localized CLI output) don't decode to U+FFFD.
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    const urlTimeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        killProc(proc);
        resolve({
          ok: false,
          error: `Timed out after ${urlWaitMs / 1000}s waiting for 'aws sso login' to print a verification URL. The AWS CLI may be misconfigured, or the profile '${profile}' may not be set up for SSO.`,
          rawOutput: stdoutBuf + stderrBuf,
        });
      }
    }, urlWaitMs);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += stdoutDecoder.write(chunk);
      if (!urlSeen) {
        const m = stdoutBuf.match(URL_RE);
        if (m) urlSeen = m[0];
      }
      if (!codeSeen) {
        const m = stdoutBuf.match(CODE_RE);
        if (m) codeSeen = m[1];
      }
      if (urlSeen && codeSeen && !settled) {
        settled = true;
        clearTimeout(urlTimeout);
        const sessionId = randomUUID();
        const session: LoginSession = {
          profile,
          proc,
          verificationUrl: urlSeen,
          userCode: codeSeen,
          stdoutBuf,
          stderrBuf,
          completion,
        };
        sessions.set(sessionId, session);
        resolve({
          ok: true,
          sessionId,
          verificationUrl: urlSeen,
          userCode: codeSeen,
          profile: profile || "default",
        });
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += stderrDecoder.write(chunk);
    });

    proc.on("exit", (code) => {
      stdoutBuf += stdoutDecoder.end();
      stderrBuf += stderrDecoder.end();
      const result: LoginWaitResult = {
        ok: code === 0,
        exitCode: code,
        rawOutput: stdoutBuf + (stderrBuf ? `\n---stderr---\n${stderrBuf}` : ""),
      };
      if (code !== 0) {
        result.error = `aws sso login exited with code ${code}${stderrBuf ? `: ${stderrBuf.trim()}` : ""}`;
      }
      completionResolve(result);

      if (!settled) {
        settled = true;
        clearTimeout(urlTimeout);
        resolve({
          ok: false,
          error: result.error ?? "aws sso login exited before printing a verification URL",
          rawOutput: result.rawOutput,
        });
      }
    });

    proc.on("error", (err) => {
      // Also resolve `completion` so any waitForLogin caller that already has
      // the sessionId doesn't hang forever when the subprocess errors after
      // URL+code were emitted (settled=true, session registered).
      const errorMsg = `Failed to run 'aws': ${err.message}. Is the AWS CLI installed and on PATH?`;
      completionResolve({
        ok: false,
        exitCode: null,
        error: errorMsg,
        rawOutput: stdoutBuf + (stderrBuf ? `\n---stderr---\n${stderrBuf}` : ""),
      });
      if (!settled) {
        settled = true;
        clearTimeout(urlTimeout);
        resolve({
          ok: false,
          error: errorMsg,
        });
      }
    });
  });
}

/**
 * Block until the specified login session finishes (user completed auth in
 * browser, or subprocess exited with an error).
 */
export async function waitForLogin(sessionId: string): Promise<LoginWaitResult> {
  const session = sessions.get(sessionId);
  if (!session) {
    return {
      ok: false,
      exitCode: null,
      error: `No active login session with id '${sessionId}'. Call aws_login_start first.`,
    };
  }
  try {
    const result = await session.completion;
    return result;
  } finally {
    sessions.delete(sessionId);
  }
}

/** For tests — drop any in-flight sessions. Not exported via the MCP surface. */
export function _clearSessions(): void {
  for (const session of sessions.values()) {
    session.proc.kill();
  }
  sessions.clear();
}
