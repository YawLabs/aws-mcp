/**
 * IAM Identity Center account/role discovery: `aws sso list-accounts` once,
 * then `aws sso list-account-roles` per account, driven by the sso-session's
 * cached bearer token.
 *
 * The token is the whole security story here. It is a credential -- whoever
 * holds it can enumerate and assume every role the user has -- so:
 *
 *   - it travels to the CLI in a 0600 `--cli-input-json file://` temp file in a
 *     fresh mkdtemp directory, deleted in `finally`. Never on argv, where every
 *     local user on a shared gateway host could read it from the process list;
 *   - nothing from a call's AwsCallResult is forwarded except the parsed
 *     accountId / accountName / roleName -- not rawStdout, rawStderr, `command`
 *     or `commandArgv` (redacted or not);
 *   - every error string built here passes through scrubToken, a literal
 *     replaceAll, as a last-ditch guard;
 *   - the sentinel-token test in sso-setup.test.ts JSON.stringify's every tool
 *     result and asserts the token appears nowhere.
 *
 * Both calls are unsigned bearer-token APIs: no AWS credentials, so no profile.
 * The child gets envWithoutProfile() and runAwsCall's omitProfile, so a stale
 * AWS_PROFILE inherited from the operator's shell cannot fail them with
 * ProfileNotFound.
 *
 * Authority stays with Identity Center / IAM. This module only READS what the
 * user is assigned; it decides nothing.
 */

import { closeSync, fchmodSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAwsCall } from "./aws-cli.js";
import { isCliSafeFilePath } from "./aws-spawn.js";
import { parseAwsError } from "./errors.js";
import { assertPrivateMode } from "./private-file.js";
import { envWithoutProfile, isValidAccountId } from "./sso-config.js";

/** list-account-roles fan-out width. The portal API throttles per user; six
 *  in flight keeps a 100-account org to a few seconds without tripping it. */
const ROLE_CONCURRENCY = 6;
/** Whole-call budget. Accounts not reached by then come back with a rolesError
 *  instead of the call hanging for minutes on a very large org. */
const OVERALL_DEADLINE_MS = 120_000;
/** Defensive pagination cap. The CLI auto-paginates, so a nextToken should
 *  never come back at all; if one does, 50 pages is far past any real org. */
const MAX_PAGES = 50;
/** Default per-call timeout, matching runAwsCall's. */
const PER_CALL_TIMEOUT_MS = 60_000;

export interface DiscoveredRole {
  roleName: string;
}

export interface DiscoveredAccount {
  accountId: string;
  accountName: string;
  roles: DiscoveredRole[];
  /** Set when this account's role listing failed; the others still return. */
  rolesError: string | null;
}

export type DiscoveryResult =
  | { ok: true; accounts: DiscoveredAccount[] }
  | { ok: false; errorKind: string; error: string };

export interface DiscoveryOptions {
  ssoSession: string;
  startUrl: string;
  ssoRegion: string;
  /** The bearer token from readSsoAccessToken. Never logged, never returned. */
  accessToken: string;
  accountIds?: readonly string[];
  includeRoles: boolean;
  /** Test seam for the overall deadline. */
  deadlineMs?: number;
  /** Test seam for the list-account-roles fan-out width. */
  concurrency?: number;
  /**
   * Aborts when the MCP client cancels the request (ToolContext.signal). Once
   * aborted, no further `aws sso` call is LAUNCHED and the result is a
   * `cancelled` error. A call already in flight runs to its own timeout:
   * runAwsCall takes no signal, so it cannot be killed early.
   */
  signal?: AbortSignal;
  /**
   * Called once per account as its role listing settles (ToolContext's
   * reportProgress, typically). `done` rises 1..total. The message carries the
   * account ID and an outcome only -- never the token.
   */
  onProgress?: (done: number, total: number, message: string) => void;
}

/** Last-ditch guard: no string leaving this module may contain the token. */
export function scrubToken(text: string, token: string): string {
  return token.length > 0 ? text.split(token).join("<redacted-token>") : text;
}

function cancelledResult(done: number, total: number | null): DiscoveryResult {
  const where =
    total === null ? "before the account list was read" : `after ${done} of ${total} account(s) had their roles listed`;
  return {
    ok: false,
    errorKind: "cancelled",
    error: `Cancelled by the client ${where}. No further aws sso calls were started; re-run aws_sso_list_assignments (or aws_sso_generate_profiles) to get the full result.`,
  };
}

function noTokenMessage(o: { ssoSession: string; startUrl: string }, rejected: boolean): string {
  return `${rejected ? "The IAM Identity Center token was rejected (expired, revoked, or not scoped for account access). " : ""}No valid IAM Identity Center token for sso-session '${o.ssoSession}' (start URL ${o.startUrl}). Call aws_login_start with ssoSession='${o.ssoSession}' and complete the login, then retry.`;
}

/** The text of a failed CLI call, reduced to `Code: message` when it parses,
 *  and always scrubbed. */
function describeFailure(stderr: string, fallback: string, token: string): string {
  const parsed = parseAwsError(stderr);
  const text = parsed.code
    ? `${parsed.code}: ${parsed.message ?? ""}`.trim()
    : stderr.trim().split(/\r?\n/)[0] || fallback;
  // Scrub BEFORE cutting: a cut through the token leaves a fragment the
  // whole-token split can never match, leaking a long token prefix.
  return scrubToken(text, token).slice(0, 500);
}

type CallOutcome = { ok: true; data: Record<string, unknown> } | { ok: false; unauthorized: boolean; message: string };

/**
 * One `aws sso <operation>` call with `input` (token included) delivered in a
 * private temp file.
 *
 * The file is created exclusively (`wx`), fchmod-ed to 0600 on the fd and
 * VERIFIED 0600 (assertPrivateMode) before the token is written, in a fresh
 * mkdtemp directory -- the same sequence runAwsCall uses for its own large
 * params file, for the same reasons (see aws-cli.ts and private-file.ts). The
 * directory is removed in `finally`, which runs only after runAwsCall has
 * settled, i.e. after the CLI has read the file and exited.
 *
 * The `file://` value is exempted from runAwsCall's paramfile guard by its exact
 * string (trustedParamFileArgs) -- a path this function minted, never one a
 * caller supplied. `--cli-input-json` is in REDACTED_VALUE_FLAGS, so even the
 * path shows only as a length stub in `command`, which is not forwarded anyway.
 */
async function ssoCall(
  operation: "list-accounts" | "list-account-roles",
  input: Record<string, string>,
  o: { ssoRegion: string; accessToken: string; timeoutMs: number },
): Promise<CallOutcome> {
  const base = tmpdir();
  if (!isCliSafeFilePath(base)) {
    // The CLI runs expandvars(expanduser()) on a file:// path, so a temp dir
    // containing `$`/`%` or starting with `~` would point it somewhere else.
    return {
      ok: false,
      unauthorized: false,
      message: `The temp directory (${base}) contains '$' or '%' or starts with '~', which the AWS CLI expands in a file:// path. Point TMP/TEMP (Windows) or TMPDIR at a plain directory.`,
    };
  }
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(base, "aws-mcp-sso-"));
    const path = join(dir, "in.json");
    const fd = openSync(path, "wx", 0o600);
    try {
      fchmodSync(fd, 0o600);
      assertPrivateMode(fd, path, "Point TMPDIR, TMP or TEMP at a native filesystem such as /tmp.");
      // ASCII-only by construction (token, digits, base64 nextToken), so the
      // code-page caveat on runAwsCall's own params file does not apply.
      writeSync(fd, JSON.stringify(input));
    } finally {
      closeSync(fd);
    }
    const fileArg = `file://${path}`;
    const r = await runAwsCall({
      service: "sso",
      operation,
      region: o.ssoRegion,
      omitProfile: true,
      env: envWithoutProfile(process.env),
      outputFormat: "json",
      timeoutMs: o.timeoutMs,
      extraFlags: ["--cli-input-json", fileArg],
      trustedParamFileArgs: [fileArg],
    });
    if (r.ok) {
      const data = r.data && typeof r.data === "object" ? (r.data as Record<string, unknown>) : {};
      return { ok: true, data };
    }
    const stderr = r.rawStderr || r.rawStdout || "";
    const unauthorized = /UnauthorizedException|ForbiddenException/.test(stderr) || r.kind === "sso_expired";
    // r.error is NOT used verbatim: for omitProfile calls runAwsCall's auth
    // branches name a profile this call never used (see AwsCallOptions).
    const fallback =
      r.kind === "timeout" ? "timed out" : r.kind === "spawn_failure" ? r.error : `aws sso ${operation} failed`;
    return {
      ok: false,
      unauthorized,
      message: describeFailure(stderr, scrubToken(fallback, o.accessToken), o.accessToken),
    };
  } catch (err) {
    return {
      ok: false,
      unauthorized: false,
      message: scrubToken(
        `Could not write the token input file: ${err instanceof Error ? err.message : String(err)}`,
        o.accessToken,
      ),
    };
  } finally {
    if (dir !== null) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best effort; see the same note on runAwsCall's params dir.
      }
    }
  }
}

/**
 * Run `operation` to completion, following any nextToken defensively.
 * `listKey` is the response array (accountList / roleList).
 */
async function listAll(
  operation: "list-accounts" | "list-account-roles",
  baseInput: Record<string, string>,
  listKey: string,
  o: { ssoRegion: string; accessToken: string; deadline: number; signal?: AbortSignal },
): Promise<
  | { ok: true; items: unknown[] }
  | (CallOutcome & { ok: false })
  | { ok: false; badOutput: string }
  | { ok: false; cancelled: true }
> {
  const items: unknown[] = [];
  const seenTokens = new Set<string>();
  let nextToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const remaining = o.deadline - Date.now();
    if (o.signal?.aborted) return { ok: false, cancelled: true };
    if (remaining <= 0) return { ok: false, unauthorized: false, message: "deadline exceeded" };
    const input = nextToken ? { ...baseInput, nextToken } : baseInput;
    const r = await ssoCall(operation, input, { ...o, timeoutMs: Math.min(PER_CALL_TIMEOUT_MS, remaining) });
    if (!r.ok) return r;
    const list = r.data[listKey];
    if (Array.isArray(list)) items.push(...list);
    const nt = r.data.nextToken;
    if (typeof nt !== "string" || nt.length === 0) return { ok: true, items };
    if (seenTokens.has(nt)) {
      return { ok: false, badOutput: `aws sso ${operation} returned the same nextToken twice; stopping.` };
    }
    seenTokens.add(nt);
    nextToken = nt;
  }
  return { ok: false, badOutput: `aws sso ${operation} returned more than ${MAX_PAGES} pages; stopping.` };
}

/**
 * Every account (and, with includeRoles, every role) the sso-session's token
 * can see. A failure of list-accounts fails the whole call; a failure of one
 * account's list-account-roles is reported on that account and the rest still
 * come back -- the partial-failure shape aws_multi_account uses.
 */
export async function listAssignments(o: DiscoveryOptions): Promise<DiscoveryResult> {
  const deadline = Date.now() + (o.deadlineMs ?? OVERALL_DEADLINE_MS);
  const common = { ssoRegion: o.ssoRegion, accessToken: o.accessToken, deadline, signal: o.signal };
  if (o.signal?.aborted) return cancelledResult(0, null);
  const accountsRes = await listAll("list-accounts", { accessToken: o.accessToken }, "accountList", common);
  if (!accountsRes.ok) {
    if ("cancelled" in accountsRes) return cancelledResult(0, null);
    if ("badOutput" in accountsRes) {
      return { ok: false, errorKind: "bad_output", error: scrubToken(accountsRes.badOutput, o.accessToken) };
    }
    if (accountsRes.unauthorized) return { ok: false, errorKind: "sso_expired", error: noTokenMessage(o, true) };
    return {
      ok: false,
      errorKind: "nonzero_exit",
      error: scrubToken(`aws sso list-accounts failed: ${accountsRes.message}`, o.accessToken),
    };
  }

  const wanted = o.accountIds ? new Set(o.accountIds) : null;
  const accounts: DiscoveredAccount[] = [];
  for (const raw of accountsRes.items) {
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Record<string, unknown>;
    // Copy out ONLY these two fields. emailAddress is dropped on purpose
    // (maintainer decision: PII-ish, and nothing here needs it).
    const accountId = typeof a.accountId === "string" ? a.accountId : "";
    const accountName = typeof a.accountName === "string" ? a.accountName : "";
    if (wanted && !wanted.has(accountId)) continue;
    accounts.push({
      accountId,
      accountName,
      roles: [],
      // An ID that is not 12 digits cannot be written into a profile, and is
      // not worth a role call; say so instead of dropping it silently.
      rolesError: isValidAccountId(accountId) ? null : "account ID is not a 12-digit number",
    });
  }

  if (o.signal?.aborted) return cancelledResult(0, accounts.length);

  if (o.includeRoles) {
    const total = accounts.length;
    let next = 0;
    let done = 0;
    const settled = (acct: DiscoveredAccount): void => {
      // On COMPLETION, never on dispatch (same rule as aws_multi_account): with
      // six in flight, counting at dispatch would reach `total` early. No lock
      // needed -- workers interleave only at await boundaries.
      done++;
      try {
        o.onProgress?.(
          done,
          total,
          `${acct.accountId}: ${acct.rolesError === null ? `${acct.roles.length} role(s)` : "failed"} (${done}/${total})`,
        );
      } catch {
        // Progress is advisory; a throwing notifier must not abandon the sweep.
      }
    };
    const worker = async (): Promise<void> => {
      while (next < accounts.length) {
        // Checked before CLAIMING an account, so a cancelled request launches
        // no further CLI call -- the client has already stopped listening.
        if (o.signal?.aborted) return;
        const acct = accounts[next++];
        if (acct.rolesError !== null) {
          settled(acct);
          continue;
        }
        if (Date.now() >= deadline) {
          acct.rolesError = "deadline exceeded";
          settled(acct);
          continue;
        }
        const r = await listAll(
          "list-account-roles",
          { accessToken: o.accessToken, accountId: acct.accountId },
          "roleList",
          common,
        );
        if (r.ok) {
          for (const role of r.items) {
            const rn = role && typeof role === "object" ? (role as Record<string, unknown>).roleName : undefined;
            if (typeof rn === "string") acct.roles.push({ roleName: rn });
          }
        } else if ("cancelled" in r) {
          // Aborted between pages of this account: it is not settled, and the
          // whole call comes back cancelled below.
          return;
        } else if ("badOutput" in r) {
          acct.rolesError = scrubToken(r.badOutput, o.accessToken);
        } else if (r.unauthorized) {
          acct.rolesError = "token rejected (UnauthorizedException); call aws_login_start again";
        } else {
          acct.rolesError = r.message;
        }
        settled(acct);
      }
    };
    const width = Math.max(1, o.concurrency ?? ROLE_CONCURRENCY);
    await Promise.all(Array.from({ length: Math.min(width, accounts.length) }, worker));
    if (o.signal?.aborted) return cancelledResult(done, total);
  }
  return { ok: true, accounts };
}
