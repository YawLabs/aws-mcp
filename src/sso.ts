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
import { killProc, procHasExited } from "./kill-proc.js";

// Matches aws-cli.ts — a runaway CLI shouldn't be able to balloon memory via
// stderr. 5 MB is ample for any legit sso login session.
const MAX_STDERR_BYTES = 5 * 1024 * 1024;

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
  ttlTimer: NodeJS.Timeout | null;
  // True once the subprocess has exited. A completed session still holds the
  // wait result for waitForLogin to consume, but is excluded from
  // findActiveSessionByProfile so a follow-up aws_login_start spawns fresh
  // instead of re-surfacing stale URL+code.
  completed: boolean;
  // Set by the TTL killswitch BEFORE the proc is killed. The exit handler
  // (sole writer of `completionResolve`) reads this to phrase the wait
  // result as a TTL expiry instead of a generic non-zero exit. If the
  // subprocess wins the race and exits 0 anyway -- user finished auth
  // microseconds before SIGTERM landed -- we still report success.
  ttlExpired: boolean;
  // The TTL value used for this session. Captured at session-creation time
  // so the expiry message can quote the actual configured value (tests
  // shrink it via SsoLoginOptions.sessionTtlMs).
  ttlMs: number;
}

const sessions = new Map<string, LoginSession>();

/**
 * Profile -> in-flight startSsoLogin promise. Guards against the race where
 * two callers (e.g. aws_login_start + aws_refresh_if_expiring_soon firing on
 * the same tick) both pass findActiveSessionByProfile -- which only sees
 * sessions AFTER URL+code arrive, ~seconds later -- and each spawn their own
 * `aws sso login` subprocess. With the dedupe map both await the same promise
 * and only one subprocess ever runs.
 *
 * Caveat: dedup key is `profile` only. Two concurrent calls for the same
 * profile with DIFFERENT `opts` will share the first call's promise, so the
 * second call's `command/prefixArgs/env/urlWaitMs/sessionTtlMs` overrides
 * are silently ignored. Production never passes opts (only tests do), so
 * this is unreachable in production. If a test ever needs distinct opts
 * per concurrent call for the same profile, dedupe on the full opts shape
 * or use distinct profile names per case.
 */
const pendingStarts = new Map<string, Promise<LoginStartResult | LoginStartError>>();

// Exported for tests — these regexes are load-bearing when the aws CLI output
// format shifts between versions, so they need direct coverage.
export const URL_RE = /https:\/\/device\.sso[.\w-]*\.amazonaws\.com\/[^\s]*/;
export const CODE_RE = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;
const URL_WAIT_MS = 15_000;
// Cap on how long a session can sit unclaimed. Real SSO device-auth flows
// complete in seconds-to-a-minute; 10 min is a forgiving upper bound that
// still keeps a forgotten aws subprocess from pinning the server forever.
const SESSION_TTL_MS = 10 * 60_000;

export function parseLoginOutput(text: string): { url: string | null; code: string | null } {
  const urlMatch = text.match(URL_RE);
  const codeMatch = text.match(CODE_RE);
  return {
    url: urlMatch ? urlMatch[0] : null,
    code: codeMatch ? codeMatch[1] : null,
  };
}

/**
 * Body of the TTL killswitch's setTimeout, extracted so the guard logic
 * (the four bail conditions plus the kill) can be unit-tested directly.
 * Forcing the proc.exitCode-set / 'exit'-event-not-yet-dispatched race in
 * an integration test would require timer mocks; this seam lets sso.test.ts
 * pin every branch with a synthetic session + ChildProcess shape.
 *
 *   - bails when the session has been deleted
 *   - bails when the exit handler has already marked the session completed
 *   - bails when proc.exitCode or proc.signalCode is set (the microsecond
 *     race window: libuv reaped the proc, but the queued 'exit' event hasn't
 *     dispatched yet -- defer to the queued exit handler)
 *   - otherwise: marks ttlExpired so the exit handler can phrase its result
 *     as a TTL expiry, then issues SIGTERM via killFn
 *
 * `killFn` is injectable so tests can verify whether the kill fires without
 * actually spawning a process. Underscore prefix = exported for tests, not
 * for production callers.
 */
export function _ttlKillswitchTick(
  s: { completed: boolean; ttlExpired: boolean } | undefined,
  proc: ChildProcess,
  killFn: (p: ChildProcess) => void = killProc,
): void {
  if (!s || s.completed) return;
  if (procHasExited(proc)) return;
  s.ttlExpired = true;
  killFn(proc);
}

/**
 * Test-injection knobs. In production we always spawn the real `aws` binary
 * with the default timeout. Tests override `command`/`prefixArgs` to point at
 * a controlled fake (see src/testing/fake-aws.ts), shrink `urlWaitMs` so
 * timeout cases don't take 15 seconds, and shrink `sessionTtlMs` so the
 * TTL killswitch can fire deterministically.
 */
export interface SsoLoginOptions {
  command?: string;
  prefixArgs?: string[];
  urlWaitMs?: number;
  env?: NodeJS.ProcessEnv;
  sessionTtlMs?: number;
}

/**
 * Spawn `aws sso login --no-browser`, wait for the URL + code to appear in
 * stdout, then return them. The subprocess keeps running in the background —
 * call `waitForLogin(sessionId)` to block until the user completes auth.
 *
 * Dedup guarantee: concurrent calls for the same profile receive the same
 * pending Promise. Only one `aws sso login` subprocess ever spawns per
 * profile per in-flight start.
 */
export function startSsoLogin(
  profile: string,
  opts: SsoLoginOptions = {},
): Promise<LoginStartResult | LoginStartError> {
  const pending = pendingStarts.get(profile);
  if (pending) return pending;
  const promise = doStartSsoLogin(profile, opts);
  pendingStarts.set(profile, promise);
  void promise.finally(() => {
    if (pendingStarts.get(profile) === promise) {
      pendingStarts.delete(profile);
    }
  });
  return promise;
}

function doStartSsoLogin(profile: string, opts: SsoLoginOptions): Promise<LoginStartResult | LoginStartError> {
  const command = opts.command ?? "aws";
  const prefixArgs = opts.prefixArgs ?? [];
  const urlWaitMs = opts.urlWaitMs ?? URL_WAIT_MS;
  const sessionTtlMs = opts.sessionTtlMs ?? SESSION_TTL_MS;
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
    let stderrBytes = 0;
    let urlSeen: string | null = null;
    let codeSeen: string | null = null;
    let settled = false;
    // The session record is only registered once URL+code arrive. The exit
    // handler reads it through this reference so it can clear ttlTimer and
    // flip `completed` without having to look up by sessionId.
    let registeredSession: LoginSession | null = null;
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
        const ttlTimer = setTimeout(() => _ttlKillswitchTick(sessions.get(sessionId), proc), sessionTtlMs);
        ttlTimer.unref();
        const session: LoginSession = {
          profile,
          proc,
          verificationUrl: urlSeen,
          userCode: codeSeen,
          stdoutBuf,
          stderrBuf,
          completion,
          ttlTimer,
          completed: false,
          ttlExpired: false,
          ttlMs: sessionTtlMs,
        };
        registeredSession = session;
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
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) return;
      stderrBuf += stderrDecoder.write(chunk);
    });

    proc.on("exit", (code) => {
      stdoutBuf += stdoutDecoder.end();
      stderrBuf += stderrDecoder.end();
      // Subprocess is gone -- the long TTL killswitch is no longer load-bearing.
      // Mark the session completed so findActiveSessionByProfile stops handing
      // out its (now stale) URL+code to follow-up aws_login_start callers.
      const ttlExpired = registeredSession?.ttlExpired === true;
      const ttlMs = registeredSession?.ttlMs ?? SESSION_TTL_MS;
      if (registeredSession) {
        if (registeredSession.ttlTimer) {
          clearTimeout(registeredSession.ttlTimer);
          registeredSession.ttlTimer = null;
        }
        registeredSession.completed = true;
      }
      const rawOutput = stdoutBuf + (stderrBuf ? `\n---stderr---\n${stderrBuf}` : "");
      let result: LoginWaitResult;
      if (ttlExpired && code !== 0) {
        // TTL killswitch fired and the subprocess exited non-zero (or via
        // signal). Surface the expiry, not the underlying signal/exit code.
        // Note: even after a TTL kill, the AWS CLI may have written a valid
        // token to the cache before SIGTERM landed. Callers who hit this
        // should retry aws_whoami before re-logging in.
        result = {
          ok: false,
          exitCode: code,
          error: `SSO login session expired after ${ttlMs / 60_000} minutes without aws_login_complete.`,
          rawOutput,
        };
      } else if (code === 0) {
        // code === 0 with ttlExpired === true is rare but possible. The
        // exitCode guard in the TTL callback closes the "proc already
        // exited when TTL fired" window entirely. The remaining race is
        // narrower: TTL fired while the proc was still alive, we set
        // ttlExpired and called killProc, but the proc happened to be in
        // the act of finishing successfully (writing the token cache,
        // exiting 0) and beat our SIGTERM to the punch. Either way, the
        // user's auth went through -- report success.
        result = { ok: true, exitCode: code, rawOutput };
      } else {
        result = {
          ok: false,
          exitCode: code,
          error: `aws sso login exited with code ${code}${stderrBuf ? `: ${stderrBuf.trim()}` : ""}`,
          rawOutput,
        };
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
      if (registeredSession) {
        if (registeredSession.ttlTimer) {
          clearTimeout(registeredSession.ttlTimer);
          registeredSession.ttlTimer = null;
        }
        registeredSession.completed = true;
      }
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

export interface ActiveSession {
  sessionId: string;
  profile: string;
  verificationUrl: string;
  userCode: string;
}

/**
 * Return the first live login session for `profile`, if any. Callers (e.g.
 * aws_login_start, aws_refresh_if_expiring_soon) use this to avoid spawning a
 * second `aws sso login` subprocess when one is already pending — they can
 * just re-surface the existing URL + code.
 *
 * Completed sessions are excluded: once the subprocess has exited, the URL
 * and code are stale; a follow-up start should spawn fresh rather than hand
 * out a finished session's verification details.
 */
export function findActiveSessionByProfile(profile: string): ActiveSession | null {
  for (const [sessionId, s] of sessions) {
    if (s.profile === profile && !s.completed) {
      return {
        sessionId,
        profile: s.profile,
        verificationUrl: s.verificationUrl,
        userCode: s.userCode,
      };
    }
  }
  return null;
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
    if (session.ttlTimer) clearTimeout(session.ttlTimer);
    sessions.delete(sessionId);
  }
}

/** For tests — drop any in-flight sessions. Not exported via the MCP surface. */
export function _clearSessions(): void {
  for (const session of sessions.values()) {
    if (session.ttlTimer) clearTimeout(session.ttlTimer);
    killProc(session.proc);
  }
  sessions.clear();
  pendingStarts.clear();
}
