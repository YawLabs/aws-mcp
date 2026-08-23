/**
 * AWS SSO login via the `--no-browser` device-code flow.
 *
 * The pain this solves: `aws sso login` tries to open the OS default browser.
 * From an AI-assistant-spawned subprocess, that handoff drops silently on
 * Windows (wrong user session / sandbox). The `--no-browser` flag prints a
 * URL + short code to stdout instead — we parse them and surface them so the
 * user clicks one link in the window they're already in. Zero context switch.
 *
 * `--no-browser` alone is NOT enough on a current AWS CLI. From v2.22.0 the
 * default grant became the PKCE authorization-code flow, which prints only an
 * `https://oidc.<region>.amazonaws.com/authorize?...` URL and no short code —
 * so the parse below finds nothing and the start call dies on its 15s URL
 * timeout. `--use-device-code` asks for the device-authorization grant that
 * still emits the URL + code pair. That flag only exists from 2.22.0, so
 * `probeDeviceCodeSupport` reads `aws --version` once per binary and omits it
 * on older CLIs, where the device grant is already the default.
 *
 * The token ends up cached in `~/.aws/sso/cache/<hash>.json` the same way a
 * normal `aws sso login` would, so the rest of the SDK ecosystem picks it up
 * transparently.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { killProc, procHasExited } from "./kill-proc.js";
import { isValidProfileName } from "./session.js";

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
  // Reap timer, armed once the subprocess exits. `sessions` is otherwise only
  // ever drained by waitForLogin (fire-once) -- so a caller that runs
  // aws_login_start and never aws_login_complete leaves its entry, the
  // ChildProcess handle, and the captured stdout/stderr buffers alive for the
  // life of the process. The TTL killswitch kills the SUBPROCESS but does not
  // reap the MAP ENTRY, so the abandoned case it exists for still leaked.
  // The grace window keeps a just-exited session claimable by a late
  // aws_login_complete; after that the entry is dropped. Cleared by
  // waitForLogin and _clearSessions.
  reapTimer: NodeJS.Timeout | null;
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
 * Dedupe-key -> in-flight startSsoLogin promise. Guards against the race
 * where two callers (e.g. aws_login_start + aws_refresh_if_expiring_soon
 * firing on the same tick) both pass findActiveSessionByProfile -- which
 * only sees sessions AFTER URL+code arrive, ~seconds later -- and each
 * spawn their own `aws sso login` subprocess. With the dedupe map both
 * await the same promise and only one subprocess ever runs.
 *
 * The key is `sha256(profile + canonicalized opts)` so that:
 *   - Two callers with identical profile AND opts share the same subprocess.
 *   - Two callers with the same profile but DIFFERENT opts get distinct
 *     subprocesses (previously a silent-override hazard -- the second
 *     caller's opts were ignored).
 * Production callers always use opts = {} (the default), so they collapse
 * to a single per-profile key. Tests that pass distinct opts get distinct
 * keys, which is the intended behavior.
 */
const pendingStarts = new Map<string, Promise<LoginStartResult | LoginStartError>>();

/**
 * Canonicalize (profile, opts) into a stable hash. JSON.stringify alone is
 * not deterministic on object key order in the general case, but the inputs
 * here have a fixed shape and we sort env entries explicitly. The hash keeps
 * the map key compact even when `opts.env` carries process.env.
 */
function dedupeKey(profile: string, opts: SsoLoginOptions): string {
  const payload = JSON.stringify({
    profile,
    command: opts.command ?? null,
    prefixArgs: opts.prefixArgs ?? null,
    urlWaitMs: opts.urlWaitMs ?? null,
    sessionTtlMs: opts.sessionTtlMs ?? null,
    // Included for the same reason as every sibling field: two callers passing
    // DIFFERENT opts must not silently share one subprocess (the second
    // caller's opts would be dropped). Omitting a new opt here is the specific
    // regression this list exists to prevent.
    completedReapMs: opts.completedReapMs ?? null,
    useDeviceCode: opts.useDeviceCode ?? null,
    env: opts.env ? Object.entries(opts.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) : null,
  });
  return createHash("sha256").update(payload).digest("hex");
}

// Exported for tests — these regexes are load-bearing when the aws CLI output
// format shifts between versions, so they need direct coverage.
export const URL_RE = /https:\/\/device\.sso[.\w-]*\.amazonaws\.com\/[^\s]*/;
export const CODE_RE = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;
// The authorize URL the PKCE flow prints instead. Never a success shape for
// this server — no short code accompanies it — so matching it buys nothing but
// the ability to fail with the real cause instead of a generic URL timeout.
export const PKCE_URL_RE = /https:\/\/oidc\.[\w.-]+\.amazonaws\.com\/authorize\b[^\s]*/;
const URL_WAIT_MS = 15_000;
// Cap on how long a session can sit unclaimed. Real SSO device-auth flows
// complete in seconds-to-a-minute; 10 min is a forgiving upper bound that
// still keeps a forgotten aws subprocess from pinning the server forever.
const SESSION_TTL_MS = 10 * 60_000;
// How long a COMPLETED session stays claimable by waitForLogin before its
// `sessions` entry is dropped. Distinct from SESSION_TTL_MS (which bounds how
// long a session may sit UNCLAIMED with a live subprocess); this one bounds how
// long a dead session's record lingers. Generous enough that a normal
// aws_login_start -> user auths -> aws_login_complete round-trip never races
// it, short enough that abandoned logins can't accumulate.
const COMPLETED_SESSION_REAP_MS = 10 * 60_000;

export function parseLoginOutput(text: string): { url: string | null; code: string | null } {
  const urlMatch = text.match(URL_RE);
  const codeMatch = text.match(CODE_RE);
  return {
    url: urlMatch ? urlMatch[0] : null,
    code: codeMatch ? codeMatch[1] : null,
  };
}

/**
 * First AWS CLI version that understands `aws sso login --use-device-code`.
 * 2.22.0 is also the release that made the PKCE authorization-code flow the
 * default, so the flag and the need for it arrived together.
 */
export const DEVICE_CODE_MIN_CLI = { major: 2, minor: 22, patch: 0 } as const;

interface CliVersion {
  major: number;
  minor: number;
  patch: number;
}

/** Parse `aws-cli/2.34.3 Python/3.13.11 Windows/11 exe/AMD64` into its triple. */
export function parseAwsCliVersion(text: string): CliVersion | null {
  const m = text.match(/aws-cli\/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * Whether to pass `--use-device-code`.
 *
 * An unparseable version resolves to `true` on purpose. The two failure modes
 * are not symmetric: omitting the flag on a modern CLI produces the silent
 * 15-second URL timeout this whole probe exists to prevent, while passing it
 * to a pre-2.22 CLI fails immediately with `Unknown options: --use-device-code`
 * sitting in `rawOutput`. Prefer the loud failure.
 */
export function supportsDeviceCodeFlag(v: CliVersion | null): boolean {
  if (!v) return true;
  if (v.major !== DEVICE_CODE_MIN_CLI.major) return v.major > DEVICE_CODE_MIN_CLI.major;
  if (v.minor !== DEVICE_CODE_MIN_CLI.minor) return v.minor > DEVICE_CODE_MIN_CLI.minor;
  return v.patch >= DEVICE_CODE_MIN_CLI.patch;
}

/**
 * Build the argv tail for `aws sso login` (everything after any test prefix).
 *
 * The empty-profile guard is vestigial — startSsoLogin rejects an empty
 * profile at the isValidProfileName gate (PROFILE_NAME_RE requires >=1 char),
 * so `profile` is always non-empty by the time this runs. Kept because the
 * `profile || "default"` fallback at the resolve site mirrors it.
 */
export function _buildLoginArgs(profile: string, useDeviceCode: boolean): string[] {
  const args = ["sso", "login", "--no-browser"];
  if (useDeviceCode) args.push("--use-device-code");
  if (profile) args.push("--profile", profile);
  return args;
}

// Deliberately tight. This runs IN FRONT of the 15s URL wait on the one call
// where the user is sitting there waiting, and `aws --version` answers in well
// under a second on any healthy install — so a slow probe is a broken probe,
// and the timeout resolves to "assume modern" anyway.
const VERSION_PROBE_TIMEOUT_MS = 2_000;

// A version line is ~50 bytes. Cap far above that so a misbehaving `aws` shim
// can't balloon memory inside the probe window — same reasoning as
// MAX_STDERR_BYTES on the login path.
const MAX_VERSION_PROBE_BYTES = 64 * 1024;

/**
 * probe key -> in-flight/settled device-code-support promise.
 * Cached because the answer is a property of the binary on PATH, not of the
 * login attempt: paying a spawn per login would put ~200-400ms on the one
 * interaction where the user is already waiting.
 */
const deviceCodeSupport = new Map<string, Promise<boolean>>();

/** Test seam — drop the cached `aws --version` probe. */
export function _clearCliVersionCache(): void {
  deviceCodeSupport.clear();
}

function probeDeviceCodeSupport(command: string, prefixArgs: string[], env?: NodeJS.ProcessEnv): Promise<boolean> {
  // PATH is part of the key because it decides WHICH `aws` a bare command name
  // resolves to -- two callers with different PATHs are asking about different
  // binaries. Same rule dedupeKey follows: anything that changes the subprocess
  // belongs in the key. (Windows env objects may spell it `Path`.)
  const key = JSON.stringify([command, prefixArgs, env?.PATH ?? env?.Path ?? null]);
  const cached = deviceCodeSupport.get(key);
  if (cached) return cached;

  const probe = new Promise<boolean>((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(command, [...prefixArgs, "--version"], {
        stdio: ["ignore", "pipe", "pipe"],
        ...(env ? { env } : {}),
      });
    } catch {
      // Can't even spawn — let the login attempt itself report the missing
      // binary, with the flag included per the asymmetry above.
      resolve(true);
      return;
    }

    let out = "";
    let outBytes = 0;
    let done = false;
    const finish = (value: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      killProc(proc);
      finish(true);
    }, VERSION_PROBE_TIMEOUT_MS);
    timer.unref();

    // One decoder per stream, not one shared: interleaved partial multi-byte
    // sequences from two pipes would corrupt each other through a single
    // decoder. Matches how the login path below handles its own two pipes.
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const append = (chunk: Buffer, decoder: StringDecoder): void => {
      outBytes += chunk.length;
      if (outBytes > MAX_VERSION_PROBE_BYTES) return;
      out += decoder.write(chunk);
    };

    // aws v2 prints --version to stdout; some older builds used stderr. Read
    // both rather than guessing which one this install writes to.
    proc.stdout?.on("data", (c: Buffer) => append(c, stdoutDecoder));
    proc.stderr?.on("data", (c: Buffer) => append(c, stderrDecoder));
    proc.on("error", () => finish(true));
    // 'close' rather than 'exit' so both pipes have flushed before parsing.
    proc.on("close", () => {
      out += stdoutDecoder.end() + stderrDecoder.end();
      finish(supportsDeviceCodeFlag(parseAwsCliVersion(out)));
    });
  });

  deviceCodeSupport.set(key, probe);
  return probe;
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
  /**
   * Grace window before a COMPLETED session's map entry is reaped. Exists for
   * the same reason as `sessionTtlMs`: the production value is 10 minutes, so
   * without a knob the reap is simply not testable. Mirrors that seam exactly
   * -- production never sets it.
   */
  completedReapMs?: number;
  /**
   * Force `--use-device-code` on or off instead of probing `aws --version`.
   * Production leaves this unset. Tests use it to pin argv construction
   * without standing up a version-reporting fake.
   */
  useDeviceCode?: boolean;
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
  // Argv-safety: the resolved value lands in `aws sso login --profile X`.
  // Reject up front so a malicious `profile` can't pose as a flag, AND so
  // an invalid profile never enters the pendingStarts dedupe map (where a
  // cached rejection would block legitimate retries for the same key).
  if (!isValidProfileName(profile)) {
    return Promise.resolve({
      ok: false,
      error: `Invalid profile name '${profile}'. Must be 1-128 chars from [A-Za-z0-9_+=,.@:-]; the first char must be a letter, digit, or one of _+,.@: (not '-' or '=').`,
    });
  }
  const key = dedupeKey(profile, opts);
  const pending = pendingStarts.get(key);
  if (pending) return pending;
  const promise = doStartSsoLogin(profile, opts);
  pendingStarts.set(key, promise);
  void promise.finally(() => {
    if (pendingStarts.get(key) === promise) {
      pendingStarts.delete(key);
    }
  });
  return promise;
}

async function doStartSsoLogin(profile: string, opts: SsoLoginOptions): Promise<LoginStartResult | LoginStartError> {
  const command = opts.command ?? "aws";
  const prefixArgs = opts.prefixArgs ?? [];
  const urlWaitMs = opts.urlWaitMs ?? URL_WAIT_MS;
  const sessionTtlMs = opts.sessionTtlMs ?? SESSION_TTL_MS;
  const completedReapMs = opts.completedReapMs ?? COMPLETED_SESSION_REAP_MS;
  const spawnEnv = opts.env;
  const useDeviceCode = opts.useDeviceCode ?? (await probeDeviceCodeSupport(command, prefixArgs, spawnEnv));

  return new Promise((resolve) => {
    const args = [...prefixArgs, ..._buildLoginArgs(profile, useDeviceCode)];

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
    // Captured alongside registeredSession so the exit/error handlers can arm
    // the reap timer, which needs the key to delete from `sessions`.
    let registeredSessionId: string | null = null;
    /**
     * Shared by the 'exit' and 'error' handlers -- the subprocess is gone, so:
     * stop the TTL killswitch, stop findActiveSessionByProfile from handing out
     * this session's now-stale URL+code, and arm the reap that bounds the
     * `sessions` Map. Idempotent: 'error' can fire after 'exit', and re-arming
     * would orphan the first timer.
     */
    const finalizeSession = (): void => {
      if (!registeredSession) return;
      if (registeredSession.ttlTimer) {
        clearTimeout(registeredSession.ttlTimer);
        registeredSession.ttlTimer = null;
      }
      registeredSession.completed = true;
      if (registeredSession.reapTimer !== null || registeredSessionId === null) return;
      const sid = registeredSessionId;
      const reap = setTimeout(() => {
        sessions.delete(sid);
      }, completedReapMs);
      // unref so a pending reap can't hold the event loop open at shutdown --
      // same treatment as ttlTimer.
      reap.unref();
      registeredSession.reapTimer = reap;
    };
    // The wait result computed by the 'exit' handler, stashed so the 'close'
    // handler can phrase the start-failure fallback from it. 'close' always
    // fires after 'exit' (Node guarantee), so this is set whenever the
    // fallback below reads it.
    let exitResult: LoginWaitResult | null = null;
    let completionResolve!: (r: LoginWaitResult) => void;
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

    /**
     * Settle early when the CLI picked the authorization-code flow.
     *
     * Riding out the URL timeout instead would report "the profile may not be
     * set up for SSO", which sends the operator down entirely the wrong path.
     * Scans BOTH buffers and is called from BOTH pipe handlers: the device-code
     * banner is a stdout fact we rely on, but which stream carries the PKCE
     * banner is not something this server should be betting on.
     */
    const checkPkceFallback = (): boolean => {
      if (urlSeen || settled) return false;
      if (!PKCE_URL_RE.test(stdoutBuf + stderrBuf)) return false;
      settled = true;
      clearTimeout(urlTimeout);
      killProc(proc);
      resolve({
        ok: false,
        error: `'aws sso login' used the PKCE authorization-code flow, which prints a verification URL but no short code for this server to surface. ${
          useDeviceCode
            ? "aws-mcp passed --use-device-code and this AWS CLI did not honor it."
            : "aws-mcp omitted --use-device-code because this AWS CLI reported a version older than 2.22.0."
        } Upgrade the AWS CLI to 2.22.0 or newer, or run 'aws sso login --use-device-code --profile ${profile}' in a terminal and retry.`,
        rawOutput: stdoutBuf + stderrBuf,
      });
      return true;
    };

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
      if (checkPkceFallback()) return;
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
          reapTimer: null,
          ttlExpired: false,
          ttlMs: sessionTtlMs,
        };
        registeredSession = session;
        registeredSessionId = sessionId;
        sessions.set(sessionId, session);
        resolve({
          ok: true,
          sessionId,
          verificationUrl: urlSeen,
          userCode: codeSeen,
          // `|| "default"` is vestigial -- see the empty-profile note above;
          // `profile` is always non-empty here (startSsoLogin rejects "").
          profile: profile || "default",
        });
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) return;
      stderrBuf += stderrDecoder.write(chunk);
      checkPkceFallback();
    });

    proc.on("exit", (code) => {
      stdoutBuf += stdoutDecoder.end();
      stderrBuf += stderrDecoder.end();
      // Subprocess is gone -- the long TTL killswitch is no longer load-bearing.
      // Mark the session completed so findActiveSessionByProfile stops handing
      // out its (now stale) URL+code to follow-up aws_login_start callers.
      const ttlExpired = registeredSession?.ttlExpired === true;
      const ttlMs = registeredSession?.ttlMs ?? SESSION_TTL_MS;
      finalizeSession();
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
      exitResult = result;
      completionResolve(result);
      // The start-failure fallback (when the proc exits before URL+code ever
      // arrive) lives in the 'close' handler below, NOT here. 'exit' can be
      // dispatched before the stdout 'data' event that carries the URL banner
      // (the OS reaps the process while a final chunk is still queued on the
      // pipe), which would spuriously fail an otherwise-healthy start. 'close'
      // fires only after the stdio streams flush, so any pending 'data' event
      // has already run and `settled` reflects the real outcome.
    });

    proc.on("close", () => {
      // Start-failure fallback: the subprocess closed without ever emitting a
      // parseable URL+code, so the start Promise was never resolved by the
      // stdout handler. 'close' guarantees all 'data' events have already
      // fired, so a still-false `settled` here means there genuinely was no
      // URL+code (not just a not-yet-delivered chunk). exitResult is set by
      // the 'exit' handler, which always runs before 'close'.
      if (!settled) {
        settled = true;
        clearTimeout(urlTimeout);
        resolve({
          ok: false,
          error: exitResult?.error ?? "aws sso login exited before printing a verification URL",
          rawOutput: exitResult?.rawOutput,
        });
      }
    });

    proc.on("error", (err) => {
      // Also resolve `completion` so any waitForLogin caller that already has
      // the sessionId doesn't hang forever when the subprocess errors after
      // URL+code were emitted (settled=true, session registered).
      finalizeSession();
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
      error: `No active login session with id '${sessionId}'. It may have already completed (waitForLogin is fire-once -- the session is dropped after the first call resolves) or it may never have started. If a prior aws_login_complete already returned success for this id, the login is done; run aws_whoami to confirm rather than starting over. Otherwise call aws_login_start first.`,
    };
  }
  try {
    const result = await session.completion;
    return result;
  } finally {
    if (session.ttlTimer) clearTimeout(session.ttlTimer);
    // The reap timer only exists to bound sessions nobody claims; this call IS
    // the claim, so drop it rather than leaving a timer pointing at a key we're
    // about to delete.
    if (session.reapTimer) clearTimeout(session.reapTimer);
    sessions.delete(sessionId);
  }
}

/**
 * For tests — is `sessionId` still present in the sessions map?
 *
 * Needed because the map's SIZE is the thing the reap bounds, and nothing else
 * exposes it non-destructively: findActiveSessionByProfile hides a completed
 * session whether or not it has been reaped, and waitForLogin CLAIMS (deletes)
 * the entry, so polling with it would destroy the state under observation and
 * pass for the wrong reason. Underscore prefix = tests only, same convention as
 * _clearSessions / _resetSession / _ttlKillswitchTick.
 */
export function _hasSession(sessionId: string): boolean {
  return sessions.has(sessionId);
}

/** For tests — drop any in-flight sessions. Not exported via the MCP surface. */
export function _clearSessions(): void {
  for (const session of sessions.values()) {
    if (session.ttlTimer) clearTimeout(session.ttlTimer);
    if (session.reapTimer) clearTimeout(session.reapTimer);
    killProc(session.proc);
  }
  sessions.clear();
  pendingStarts.clear();
}
