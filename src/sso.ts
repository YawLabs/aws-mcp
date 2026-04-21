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

const URL_RE = /https:\/\/device\.sso[.\w-]*\.amazonaws\.com\/[^\s]*/;
const CODE_RE = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;
const URL_WAIT_MS = 15_000;

/**
 * Spawn `aws sso login --no-browser`, wait for the URL + code to appear in
 * stdout, then return them. The subprocess keeps running in the background —
 * call `waitForLogin(sessionId)` to block until the user completes auth.
 */
export function startSsoLogin(profile: string): Promise<LoginStartResult | LoginStartError> {
  return new Promise((resolve) => {
    const args = ["sso", "login", "--no-browser"];
    if (profile) {
      args.push("--profile", profile);
    }

    let proc: ChildProcess;
    try {
      proc = spawn("aws", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({
        ok: false,
        error: `Failed to spawn 'aws': ${err instanceof Error ? err.message : String(err)}. Is the AWS CLI installed and on PATH?`,
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

    const urlTimeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        resolve({
          ok: false,
          error: `Timed out after ${URL_WAIT_MS / 1000}s waiting for 'aws sso login' to print a verification URL. The AWS CLI may be misconfigured, or the profile '${profile}' may not be set up for SSO.`,
          rawOutput: stdoutBuf + stderrBuf,
        });
      }
    }, URL_WAIT_MS);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
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
      stderrBuf += chunk.toString();
    });

    proc.on("exit", (code) => {
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
      if (!settled) {
        settled = true;
        clearTimeout(urlTimeout);
        resolve({
          ok: false,
          error: `Failed to run 'aws': ${err.message}. Is the AWS CLI installed and on PATH?`,
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
