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
import { awsChildEnv, envLookup, resolveAwsCommand } from "./aws-spawn.js";
import { killProc, procHasExited } from "./kill-proc.js";
import { isValidProfileName } from "./session.js";

// Matches aws-cli.ts — a runaway CLI shouldn't be able to balloon memory via
// stderr. 5 MB is ample for any legit sso login session.
const MAX_STDERR_BYTES = 5 * 1024 * 1024;

/**
 * Cap on the raw `aws sso login` output echoed back through `rawOutput` (and
 * from there into model-visible text by tools/auth.ts). Clean output is a URL
 * and a six-character code, so this never trims a healthy login -- it bounds
 * the unfiltered-CLI-output channel a misbehaving or chatty `aws` opens into
 * the model's context. MAX_STDERR_BYTES already bounds MEMORY; this bounds
 * what we forward.
 */
const MAX_RAW_OUTPUT_CHARS = 4_000;

function clampRawOutput(text: string): string {
  if (text.length <= MAX_RAW_OUTPUT_CHARS) return text;
  // Keep the head: the URL + code banner and the CLI's own error preamble both
  // land at the top, and a runaway tail is exactly what we are cutting.
  return `${text.slice(0, MAX_RAW_OUTPUT_CHARS)}\n... [truncated ${text.length - MAX_RAW_OUTPUT_CHARS} chars of 'aws sso login' output]`;
}

/**
 * What an `aws sso login` authenticates: a named profile (the original flow),
 * or an `[sso-session <name>]` block directly, with no profile at all (the
 * IAM Identity Center bootstrap -- a brand-new user has no profile yet, only a
 * start URL). The two share every bit of the spawn/parse/TTL/reap machinery
 * below; only the argv flag and the dedupe identity differ.
 */
export type LoginTarget = { kind: "profile"; name: string } | { kind: "sso-session"; name: string };

/** A bare string is a profile name, so every existing caller keeps working. */
function toTarget(target: LoginTarget | string): LoginTarget {
  return typeof target === "string" ? { kind: "profile", name: target } : target;
}

/** "profile 'x'" / "sso-session 'x'", for messages. */
function describeTarget(t: LoginTarget): string {
  return `${t.kind} '${t.name}'`;
}

/** The argv selector for a target. */
function targetFlag(t: LoginTarget): [string, string] {
  return t.kind === "profile" ? ["--profile", t.name] : ["--sso-session", t.name];
}

interface LoginStartResult {
  ok: true;
  sessionId: string;
  verificationUrl: string;
  userCode: string;
  /** The target's name. Kept under this key for the profile flow's callers. */
  profile: string;
  target: LoginTarget;
}

interface LoginStartError {
  ok: false;
  error: string;
  rawOutput?: string;
}

interface LoginWaitResult {
  ok: boolean;
  exitCode: number | null;
  error?: string;
  rawOutput?: string;
}

interface LoginSession {
  target: LoginTarget;
  proc: ChildProcess;
  verificationUrl: string;
  userCode: string;
  stdoutBuf: string;
  stderrBuf: string;
  completion: Promise<LoginWaitResult>;
  ttlTimer: NodeJS.Timeout | null;
  // True once the subprocess has exited. A completed session still holds the
  // wait result for waitForLogin to consume, but is excluded from
  // findActiveSession so a follow-up aws_login_start spawns fresh
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
  // Set by cancelLogin before the proc is killed, so the exit handler phrases
  // the wait result as "superseded" (with this reason) instead of a bare
  // non-zero exit. Same handshake as ttlExpired.
  supersededReason: string | null;
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
export function _dedupeKey(target: LoginTarget, opts: SsoLoginOptions): string {
  const payload = JSON.stringify({
    // `kind` keeps profile 'x' and sso-session 'x' from sharing one subprocess:
    // they are different logins (different argv, different token cache entry),
    // and a dedupe that merged them would hand one caller the other's URL+code.
    kind: target.kind,
    profile: target.name,
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
    versionProbeTimeoutMs: opts.versionProbeTimeoutMs ?? null,
    dedupeTag: opts.dedupeTag ?? null,
    env: opts.env ? Object.entries(opts.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) : null,
  });
  return createHash("sha256").update(payload).digest("hex");
}

// Exported for tests — these regexes are load-bearing when the aws CLI output
// format shifts between versions, so they need direct coverage.
// The CLI can print a regional device URL, a tenant portal device URL, or an
// AWS sign-in URL. Preserve its complete link while keeping the host allowlist
// explicit; portal and sign-in authorization pages are not device-code
// verification URLs, so both of those hosts must end their path in `device`.
// Matching a non-device URL would latch `urlSeen` and suppress the PKCE
// fallback, turning a precise error into the generic URL-wait timeout.
export const URL_RE =
  /https:\/\/(?:device\.sso[.\w-]*\.amazonaws\.com\/[^\s<>"']*|[a-z0-9-]+\.awsapps\.com\/start\/?#\/device(?:\?[^\s<>"']*)?(?=$|[\s<>"'])|(?:[a-z0-9-]+\.)*signin\.aws\/(?:[^\s<>"'?#/]+\/)*device(?:\?[^\s<>"']*)?(?=$|[\s<>"']))/i;
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

export interface CliVersion {
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
  return versionAtLeast(v, DEVICE_CODE_MIN_CLI);
}

/**
 * Build the argv tail for `aws sso login` (everything after any test prefix).
 *
 * The name is always non-empty here: startSsoLogin rejects an empty one at the
 * isValidProfileName gate (PROFILE_NAME_RE requires >=1 char) before this runs,
 * so the selector flag is unconditional. `--profile` / `--sso-session` comes
 * after `--use-device-code` and the name goes LAST, so the value can never be
 * read as a flag. A bare string is a profile name (the existing unit tests).
 */
export function _buildLoginArgs(target: LoginTarget | string, useDeviceCode: boolean): string[] {
  const args = ["sso", "login", "--no-browser"];
  if (useDeviceCode) args.push("--use-device-code");
  args.push(...targetFlag(toTarget(target)));
  return args;
}

/**
 * First AWS CLI version with `aws sso login --sso-session` (and the
 * `[sso-session]` config block it reads). An sso-session login on an older CLI
 * is refused up front with an upgrade message rather than left to fail with an
 * argparse error the model would have to decode.
 */
export const SSO_SESSION_MIN_CLI = { major: 2, minor: 9, patch: 0 } as const;

function versionAtLeast(v: CliVersion, min: CliVersion): boolean {
  if (v.major !== min.major) return v.major > min.major;
  if (v.minor !== min.minor) return v.minor > min.minor;
  return v.patch >= min.patch;
}

/** Can this CLI run `--sso-session`? Unparseable -> assume modern, the same
 *  asymmetry as supportsDeviceCodeFlag: a wrong "yes" fails loudly in the CLI's
 *  own output, a wrong "no" would block a working install. */
export function supportsSsoSession(v: CliVersion | null): boolean {
  return v === null || versionAtLeast(v, SSO_SESSION_MIN_CLI);
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
 * probe key -> in-flight/settled parsed-version promise (null = unknown).
 * Cached because the answer is a property of the binary on PATH, not of the
 * login attempt: paying a spawn per login would put ~200-400ms on the one
 * interaction where the user is already waiting.
 */
const cliVersions = new Map<string, Promise<CliVersion | null>>();

/** Test seam — drop the cached `aws --version` probe. */
export function _clearCliVersionCache(): void {
  cliVersions.clear();
}

/**
 * `aws --version`, parsed. Resolves null for "unknown" (spawn failure, timeout,
 * unparseable output); every consumer treats unknown as "assume modern". Was
 * `probeDeviceCodeSupport` returning a boolean; it returns the version now so
 * the same single cached probe also answers the 2.9.0 `--sso-session` gate.
 */
function probeCliVersion(
  command: string,
  prefixArgs: string[],
  env?: NodeJS.ProcessEnv,
  timeoutMs: number = VERSION_PROBE_TIMEOUT_MS,
): Promise<CliVersion | null> {
  // `command` is an absolute path by the time it gets here (doStartSsoLogin
  // resolves it), so PATH no longer decides which binary this answer is about.
  // It stays in the key anyway: it is a cheap identity input, and a caller that
  // changed PATH is asking about a different install often enough that sharing
  // one verdict would be the wrong default. Same rule dedupeKey follows.
  // (envLookup because a Windows env object may spell it `Path`.)
  const key = JSON.stringify([command, prefixArgs, envLookup(env ?? {}, "PATH") ?? null]);
  const cached = cliVersions.get(key);
  if (cached) return cached;

  const probe = new Promise<CliVersion | null>((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(command, [...prefixArgs, "--version"], {
        stdio: ["ignore", "pipe", "pipe"],
        // Same pins as every other aws child (aws-spawn.ts). Not because
        // `--version` needs them -- it answers exit 0 even with `cli_auto_prompt
        // = on` in config, measured on 2.34.3 and 2.22.0 -- but because the
        // probe exists to predict what the LOGIN spawn will do, and one helper
        // for every child is what keeps the two environments from drifting.
        env: awsChildEnv(env ?? process.env),
        // Matches every spawn in bin/aws-mcp.mjs, which passes it on its version
        // probe and both launch paths. libuv only adds CREATE_NO_WINDOW when asked,
        // so without it a console window can flash for each aws child -- bounded
        // honestly: a console app inherits its parent's console, so this is visible
        // only when the server itself has none, which is a GUI-subsystem MCP host
        // launching it detached. ASSERTED, not measured: discriminating it needs a
        // console-less parent plus a window probe, and MainWindowHandle is
        // unreliable under ConPTY here. Inert on POSIX.
        windowsHide: true,
      });
    } catch {
      // Can't even spawn — let the login attempt itself report the missing
      // binary, with the flag included per the asymmetry above.
      resolve(null);
      return;
    }

    let out = "";
    let outBytes = 0;
    let done = false;
    const finish = (value: CliVersion | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      killProc(proc);
      finish(null);
    }, timeoutMs);
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
    proc.on("error", () => finish(null));
    // 'close' rather than 'exit' so both pipes have flushed before parsing.
    proc.on("close", () => {
      out += stdoutDecoder.end() + stderrDecoder.end();
      finish(parseAwsCliVersion(out));
    });
  });

  cliVersions.set(key, probe);
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
interface SsoLoginOptions {
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
  /**
   * Bound on the `aws --version` probe. Production leaves it at the tight 2s
   * default, sized against a real `aws` binary. Tests point the probe at a Node
   * fake whose cold start alone can pass 2s under a parallel run, and a probe
   * that times out silently answers "assume modern" -- so a test asserting a
   * PARSED version needs room for the fake to actually answer.
   */
  versionProbeTimeoutMs?: number;
  /**
   * Extra dedupe-key input. The sso-session path passes the block's start URL
   * and region: a start that read one URL must not be handed to a caller that
   * just repointed the block at another (the CLI reads the config at launch,
   * so the in-flight login is for the OLD instance).
   */
  dedupeTag?: string;
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
  targetIn: LoginTarget | string,
  opts: SsoLoginOptions = {},
): Promise<LoginStartResult | LoginStartError> {
  const target = toTarget(targetIn);
  // Argv-safety: the resolved value lands in `aws sso login --profile X` (or
  // `--sso-session X`). Reject up front so a malicious name can't pose as a
  // flag, AND so an invalid name never enters the pendingStarts dedupe map
  // (where a cached rejection would block legitimate retries for the same key).
  // Both kinds share one rule: an sso-session name lands in the same argv slot
  // and in an INI header, so it needs everything a profile name does.
  if (!isValidProfileName(target.name)) {
    return Promise.resolve({
      ok: false,
      error: `Invalid ${target.kind === "profile" ? "profile" : "sso-session"} name '${target.name}'. Must be 1-128 chars from [A-Za-z0-9_+=,.@:-]; the first char must be a letter, digit, or one of _+,.@: (not '-' or '=').`,
    });
  }
  const key = _dedupeKey(target, opts);
  const pending = pendingStarts.get(key);
  if (pending) return pending;
  const promise = doStartSsoLogin(target, opts);
  pendingStarts.set(key, promise);
  void promise.finally(() => {
    if (pendingStarts.get(key) === promise) {
      pendingStarts.delete(key);
    }
  });
  return promise;
}

async function doStartSsoLogin(
  target: LoginTarget,
  opts: SsoLoginOptions,
): Promise<LoginStartResult | LoginStartError> {
  // Same resolution as every aws_call, so `aws sso login` cannot be a different
  // binary than the rest of the server runs -- and so AWS_MCP_AWS_CLI covers
  // the login too. Resolved before the version probe: with no CLI to run there
  // is nothing to probe, and the caller gets the resolver's message instead of
  // waiting out the probe and then the URL timeout.
  const resolution = resolveAwsCommand({ explicit: opts.command, env: opts.env ?? process.env });
  if (!resolution.ok) return { ok: false, error: resolution.error };
  const command = resolution.command;
  const prefixArgs = opts.prefixArgs ?? [];
  const urlWaitMs = opts.urlWaitMs ?? URL_WAIT_MS;
  const sessionTtlMs = opts.sessionTtlMs ?? SESSION_TTL_MS;
  const completedReapMs = opts.completedReapMs ?? COMPLETED_SESSION_REAP_MS;
  const spawnEnv = opts.env;
  // The version is needed for the device-code flag (unless a test pinned it)
  // and, for an sso-session target, for the 2.9.0 gate -- which a pinned
  // useDeviceCode must not skip, or a too-old CLI would get past it in exactly
  // the configuration the gate exists for.
  const needVersion = opts.useDeviceCode === undefined || target.kind === "sso-session";
  const version = needVersion ? await probeCliVersion(command, prefixArgs, spawnEnv, opts.versionProbeTimeoutMs) : null;
  if (target.kind === "sso-session" && !supportsSsoSession(version)) {
    const v = version ? `${version.major}.${version.minor}.${version.patch}` : "unknown";
    const min = SSO_SESSION_MIN_CLI;
    return {
      ok: false,
      error: `aws CLI ${v} predates --sso-session (${min.major}.${min.minor}.${min.patch}). Upgrade the AWS CLI v2 (2.22.0 or newer recommended).`,
    };
  }
  const useDeviceCode = opts.useDeviceCode ?? supportsDeviceCodeFlag(version);

  return new Promise((resolve) => {
    const args = [...prefixArgs, ..._buildLoginArgs(target, useDeviceCode)];

    let proc: ChildProcess;
    try {
      proc = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        // The pins matter most here: with `cli_auto_prompt = on` in the user's
        // config the CLI wants a console before it does anything, so
        // `aws sso login` exits without ever printing a URL and this tool has
        // nothing to show. See aws-spawn.ts PINNED_CLI_ENV.
        env: awsChildEnv(spawnEnv ?? process.env),
        // Matches every spawn in bin/aws-mcp.mjs, which passes it on its version
        // probe and both launch paths. libuv only adds CREATE_NO_WINDOW when asked,
        // so without it a console window can flash for each aws child -- bounded
        // honestly: a console app inherits its parent's console, so this is visible
        // only when the server itself has none, which is a GUI-subsystem MCP host
        // launching it detached. ASSERTED, not measured: discriminating it needs a
        // console-less parent plus a window probe, and MainWindowHandle is
        // unreliable under ConPTY here. Inert on POSIX.
        windowsHide: true,
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
          error: `Timed out after ${urlWaitMs / 1000}s waiting for 'aws sso login' to print a verification URL. The AWS CLI may be misconfigured, or the ${describeTarget(target)} may not be set up for SSO.`,
          rawOutput: clampRawOutput(stdoutBuf + stderrBuf),
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
        } Upgrade the AWS CLI to 2.22.0 or newer, or run 'aws sso login --use-device-code ${targetFlag(target).join(" ")}' in a terminal and retry.`,
        rawOutput: clampRawOutput(stdoutBuf + stderrBuf),
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
        // Re-read the URL from the full buffer. `urlSeen` latched on the first
        // chunk that matched, and a pipe chunk can end mid-URL (URL_RE accepts
        // end-of-buffer as a terminator), dropping e.g. `?user_code=...`. The
        // code always prints after the URL, so by now the URL line is whole.
        urlSeen = stdoutBuf.match(URL_RE)?.[0] ?? urlSeen;
        const sessionId = randomUUID();
        // Deliberate handoff: the TTL killswitch is armed HERE, at the same
        // moment the urlWaitMs timeout is cleared, so the subprocess is under
        // exactly one deadline at all times. Before this point a hung `aws`
        // (spawned but never printing) is bounded by urlTimeout, which kills
        // the proc and settles the start Promise; after it, by this timer.
        // The coupling is why arming late is safe -- move either half and a
        // subprocess can end up with no deadline at all.
        const ttlTimer = setTimeout(() => _ttlKillswitchTick(sessions.get(sessionId), proc), sessionTtlMs);
        ttlTimer.unref();
        const session: LoginSession = {
          target,
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
          supersededReason: null,
        };
        registeredSession = session;
        registeredSessionId = sessionId;
        sessions.set(sessionId, session);
        resolve({
          ok: true,
          sessionId,
          verificationUrl: urlSeen,
          userCode: codeSeen,
          profile: target.name,
          target,
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
      const supersededReason = registeredSession?.supersededReason ?? null;
      finalizeSession();
      const rawOutput = clampRawOutput(stdoutBuf + (stderrBuf ? `\n---stderr---\n${stderrBuf}` : ""));
      let result: LoginWaitResult;
      if (supersededReason !== null && code !== 0) {
        result = { ok: false, exitCode: code, error: supersededReason, rawOutput };
      } else if (ttlExpired && code !== 0) {
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
          // Clamped for the same reason as rawOutput: this string is forwarded
          // to the model as `error`, and stderrBuf is bounded only by the 5 MB
          // memory cap.
          error: `aws sso login exited with code ${code}${stderrBuf ? `: ${clampRawOutput(stderrBuf.trim())}` : ""}`,
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
      // Names the binary that failed rather than the literal `aws`, now that it
      // is a resolved absolute path -- and keeps the PATH hint only for ENOENT,
      // the one errno PATH could explain (see the same rule in aws-cli.ts).
      const enoent = (err as NodeJS.ErrnoException).code === "ENOENT";
      const errorMsg = `Failed to run '${command}': ${err.message}.${
        enoent ? " Is the AWS CLI installed and on PATH?" : ""
      }`;
      completionResolve({
        ok: false,
        exitCode: null,
        error: errorMsg,
        rawOutput: clampRawOutput(stdoutBuf + (stderrBuf ? `\n---stderr---\n${stderrBuf}` : "")),
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

interface ActiveSession {
  sessionId: string;
  /** The target's name (kept under this key for the profile flow's callers). */
  profile: string;
  target: LoginTarget;
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
export function findActiveSession(target: LoginTarget): ActiveSession | null {
  for (const [sessionId, s] of sessions) {
    // Kind AND name: a live sso-session login 'x' is not a login for profile
    // 'x', and re-surfacing its code to a profile caller would complete the
    // wrong login.
    if (s.target.kind === target.kind && s.target.name === target.name && !s.completed) {
      return {
        sessionId,
        profile: s.target.name,
        target: s.target,
        verificationUrl: s.verificationUrl,
        userCode: s.userCode,
      };
    }
  }
  return null;
}

/**
 * Abandon a live login: mark it completed (so findActiveSession stops handing
 * out its URL+code at once) and kill its subprocess. A later waitForLogin on it
 * resolves with `reason` as the error. Returns false when there was no live
 * session to cancel.
 */
export function cancelLogin(sessionId: string, reason: string): boolean {
  const s = sessions.get(sessionId);
  if (!s || s.completed) return false;
  s.supersededReason = reason;
  s.completed = true;
  if (s.ttlTimer) {
    clearTimeout(s.ttlTimer);
    s.ttlTimer = null;
  }
  killProc(s.proc);
  return true;
}

/** The profile flow's original lookup; aws_refresh_if_expiring_soon and the
 *  profile path of aws_login_start still call it. */
export function findActiveSessionByProfile(profile: string): ActiveSession | null {
  return findActiveSession({ kind: "profile", name: profile });
}

/**
 * What a login session is for, read WITHOUT claiming it. aws_login_complete
 * needs this before waitForLogin consumes the entry: an sso-session login has no
 * profile to run the post-login identity check against, so the handler branches
 * on it.
 */
export function getLoginTarget(sessionId: string): LoginTarget | null {
  return sessions.get(sessionId)?.target ?? null;
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
