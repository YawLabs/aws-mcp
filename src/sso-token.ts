/**
 * Reads of the AWS CLI's IAM Identity Center token cache (`~/.aws/sso/cache`).
 *
 * Two readers live here, with deliberately different contracts:
 *
 *   - findCachedSsoToken: METADATA only (expiresAt, minutesLeft, startUrl). What
 *     aws_whoami / aws_login_complete / aws_refresh_if_expiring_soon show the
 *     model. Moved here unchanged from tools/auth.ts.
 *
 *   - readSsoAccessToken: the bearer token itself, for the two `aws sso list-*`
 *     calls account/role discovery makes. INTERNAL. The token is a credential --
 *     anyone holding it can enumerate and assume every role the user has -- so
 *     it must never reach a ToolResult, an error string or a log line. Only
 *     src/sso-discovery.ts and src/tools/sso-setup.ts may touch it; a static
 *     guard test (sso-token.test.ts) fails the build if any other tool module
 *     imports it.
 *
 * The cache directory is always under the home directory -- there is no
 * override variable for it, unlike AWS_CONFIG_FILE -- and it is resolved per
 * call: Node's homedir() re-reads HOME (POSIX) / USERPROFILE (Windows) every
 * time, the same lookup botocore's expanduser makes, so a per-user gateway that
 * sets those for the process gets the per-user cache.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Real SSO cache files are a few KB (JWT + metadata). 64 KB is a generous
// cap that still keeps a malformed or malicious giant file from blocking the
// event loop on readFileSync.
const MAX_SSO_CACHE_FILE_BYTES = 64 * 1024;

/**
 * Clock-skew cushion on the expiry check.
 *
 * Without one, a client clock even slightly fast makes `expiresAtMs <= now`
 * true for a token the SSO endpoint would still honor, so the cached token is
 * silently discarded and the caller is pushed through a pointless re-login.
 * Deliberately small: it must not keep a genuinely dead token alive long
 * enough that the NEXT CLI call fails with a confusing sso_expired. It only
 * covers seconds-scale skew -- a clock minutes off still needs fixing at the
 * OS level.
 */
const EXPIRY_SKEW_GRACE_MS = 60_000;

/**
 * How much life a token must have left for readSsoAccessToken to hand it out.
 * The opposite direction from EXPIRY_SKEW_GRACE_MS on purpose: that one keeps
 * a STATUS reading honest; this one is about to make API calls with the token,
 * and a token with seconds left would race them -- the first list-accounts
 * succeeds, the per-account role calls fail as Unauthorized, and the result is
 * a confusing half-list. Better to ask for a fresh login up front.
 */
const ACCESS_TOKEN_MIN_REMAINING_MS = 60_000;

/** Where the CLI caches SSO tokens. Resolved per call; see the file header. */
export function defaultCacheDir(): string {
  return join(homedir(), ".aws", "sso", "cache");
}

/**
 * Parse a cache file's `expiresAt` into epoch millis, or NaN.
 *
 * botocore's LEGACY SSO cache writer formats the field with strftime
 * `%Y-%m-%dT%H:%M:%S%Z`, which renders as `2026-08-30T12:00:00UTC` -- not an
 * ISO-8601 spelling, and `new Date()` returns NaN for it (with or without a
 * space before `UTC`). The modern `sso-session` path writes `...Z` and parses
 * fine, so this only bit profiles using the inline `sso_start_url` style:
 * every cache file was skipped, findCachedSsoToken returned null, and
 * aws_refresh_if_expiring_soon spawned a fresh login on every call while
 * reporting "No cached SSO token found".
 */
function parseExpiresAt(raw: unknown): number {
  if (typeof raw !== "string") return Number.NaN;
  const direct = new Date(raw).getTime();
  if (Number.isFinite(direct)) return direct;
  // Rewrite only the trailing `UTC` designator; anything else is left alone so
  // a genuinely malformed value still lands in the warn path below.
  const normalized = raw.replace(/\s*UTC$/, "Z");
  return normalized === raw ? Number.NaN : new Date(normalized).getTime();
}

/**
 * Warn-once dedupe for cache files whose `expiresAt` will not parse. Keyed by
 * file path plus raw value so a NEW bad file is still reported, while the
 * common case (the same bad file re-read on every aws_whoami) warns exactly
 * once. Mirrors the parseTestPrefixArgs dedupe in aws-cli.ts.
 */
const warnedUnparseableExpiry = new Set<string>();

/** For tests -- drop the warn-once dedupe so the warning can be re-observed. */
export function _resetUnparseableExpiryDedupe(): void {
  warnedUnparseableExpiry.clear();
}

/**
 * Surface an unparseable expiry instead of silently skipping the file. Goes to
 * stderr (console.warn), never stdout -- stdout is the MCP protocol channel.
 * The value is a timestamp, not credential material, so echoing it is safe.
 */
function warnUnparseableExpiry(path: string, raw: unknown): void {
  const key = `${path} :: ${String(raw)}`;
  if (warnedUnparseableExpiry.has(key)) return;
  warnedUnparseableExpiry.add(key);
  console.warn(
    `[aws-mcp] SSO cache file ${path} has an expiresAt this server cannot parse (${JSON.stringify(raw)}); treating it as no cached token. Re-run 'aws sso login' to rewrite the cache.`,
  );
}

interface FindTokenOptions {
  /**
   * If set, only return tokens whose `startUrl` matches. Prevents the
   * multi-org misread where the first valid token in the cache belongs to a
   * different SSO instance than the profile the caller asked about.
   */
  startUrl?: string;
}

/**
 * Best-effort read of a non-expired SSO token from the CLI cache. When
 * `startUrl` is supplied, only tokens belonging to that SSO instance are
 * eligible -- callers with a known profile should always pass it to avoid
 * the multi-org hazard. When multiple eligible tokens exist (a re-login
 * leaves the previous one in the cache until it expires), returns the one
 * with the LATEST `expiresAt` so callers see the freshest minutesLeft.
 *
 * Exported with an optional `cacheDir` argument so tests can point it at a tmpdir.
 */
export function findCachedSsoToken(
  cacheDir: string = defaultCacheDir(),
  opts: FindTokenOptions = {},
): { expiresAt: string; minutesLeft: number; startUrl?: string } | null {
  try {
    const files = readdirSync(cacheDir).filter((f) => f.endsWith(".json"));
    const now = Date.now();
    let best: { expiresAtIso: string; expiresAtMs: number; startUrl?: string } | null = null;
    for (const f of files) {
      try {
        const path = join(cacheDir, f);
        if (statSync(path).size > MAX_SSO_CACHE_FILE_BYTES) continue;
        const contents = JSON.parse(readFileSync(path, "utf-8"));
        if (!contents.accessToken || !contents.expiresAt) continue;
        if (opts.startUrl && contents.startUrl !== opts.startUrl) continue;
        const expiresAtMs = parseExpiresAt(contents.expiresAt);
        if (!Number.isFinite(expiresAtMs)) {
          // Not a silent skip: an unreadable expiry looks exactly like an
          // empty cache to every caller, so say so once on stderr.
          warnUnparseableExpiry(path, contents.expiresAt);
          continue;
        }
        if (expiresAtMs <= now - EXPIRY_SKEW_GRACE_MS) continue;
        if (!best || expiresAtMs > best.expiresAtMs) {
          best = { expiresAtIso: contents.expiresAt, expiresAtMs, startUrl: contents.startUrl };
        }
      } catch {
        // skip malformed cache file
      }
    }
    if (best) {
      return {
        expiresAt: best.expiresAtIso,
        // Clamped at 0: with EXPIRY_SKEW_GRACE_MS a token accepted here can
        // already be a few seconds past its stamped expiry, and a negative
        // minutesLeft would be a new shape for every caller. 0 still trips
        // every `minutesLeft < threshold` refresh check.
        minutesLeft: Math.max(0, Math.floor((best.expiresAtMs - now) / 60_000)),
        startUrl: best.startUrl,
      };
    }
  } catch {
    // no cache dir
  }
  return null;
}

/** One cache file's usable token, or null. Never throws. */
function readTokenFile(path: string, startUrl: string): { accessToken: string; expiresAt: string; ms: number } | null {
  try {
    if (statSync(path).size > MAX_SSO_CACHE_FILE_BYTES) return null;
    const c = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    if (typeof c.accessToken !== "string" || c.accessToken.length === 0) return null;
    if (typeof c.expiresAt !== "string") return null;
    // Exact string compare, as the CLI does: the token cache is keyed on the
    // start URL as typed, and a token for another Identity Center instance --
    // even one sitting in the sha1-named file after a session was repointed --
    // must never be sent to this one.
    if (c.startUrl !== startUrl) return null;
    const ms = parseExpiresAt(c.expiresAt);
    if (!Number.isFinite(ms)) {
      warnUnparseableExpiry(path, c.expiresAt);
      return null;
    }
    if (ms - Date.now() < ACCESS_TOKEN_MIN_REMAINING_MS) return null;
    return { accessToken: c.accessToken, expiresAt: c.expiresAt, ms };
  } catch {
    return null;
  }
}

/**
 * INTERNAL. Never import from src/tools/*.ts except sso-setup.ts; never put the
 * return value in a ToolResult.
 *
 * The bearer token for `sso-session <ssoSession>`, or null when there is no
 * usable one (absent, for a different start URL, expired or within a minute of
 * it).
 *
 * Lookup order mirrors the CLI: `sha1(<session name>).json` is the modern
 * sso-session cache key, so it is tried first. If it is missing or unusable the
 * whole directory is scanned for a file whose `startUrl` matches exactly,
 * picking the latest expiry -- which covers a token written by an older CLI or
 * by the legacy (start-URL-keyed) flow for the same instance.
 */
export function readSsoAccessToken(
  sel: { ssoSession: string; startUrl: string },
  cacheDir: string = defaultCacheDir(),
): { accessToken: string; expiresAt: string } | null {
  const keyed = join(cacheDir, `${createHash("sha1").update(sel.ssoSession, "utf8").digest("hex")}.json`);
  const direct = readTokenFile(keyed, sel.startUrl);
  if (direct) return { accessToken: direct.accessToken, expiresAt: direct.expiresAt };
  let best: { accessToken: string; expiresAt: string; ms: number } | null = null;
  try {
    for (const f of readdirSync(cacheDir)) {
      if (!f.endsWith(".json")) continue;
      const t = readTokenFile(join(cacheDir, f), sel.startUrl);
      if (t && (!best || t.ms > best.ms)) best = t;
    }
  } catch {
    // no cache dir
  }
  return best ? { accessToken: best.accessToken, expiresAt: best.expiresAt } : null;
}
