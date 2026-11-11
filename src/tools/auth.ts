import { readFileSync } from "node:fs";
import { z } from "zod";
import { runAwsCall } from "../aws-cli.js";
import { EMPTY_CONFIG_FILE_ERROR, resolveAwsConfigPath } from "../aws-paths.js";
import { planConfigUpserts, withLockedAtomicWrite } from "../ini-file.js";
import { getProfile, getRegion } from "../session.js";
import {
  cancelLogin,
  findActiveSession,
  findActiveSessionByProfile,
  getLoginTarget,
  type LoginTarget,
  startSsoLogin,
  waitForLogin,
} from "../sso.js";
import {
  envWithoutProfile,
  normalizeStartUrl,
  regionProblem,
  renderSessionSpec,
  ssoSessionNameProblem,
} from "../sso-config.js";
import { _resetUnparseableExpiryDedupe, findCachedSsoToken } from "../sso-token.js";
import { parseSsoSessions, resolveProfileStartUrl } from "./profiles.js";
import type { Tool, ToolResult } from "./tool.js";

// The token-cache readers moved to src/sso-token.ts (shared with the Identity
// Center discovery tools). Re-exported so existing importers -- the test suites
// among them -- keep working unchanged.
export { _resetUnparseableExpiryDedupe, findCachedSsoToken };

// Test seam for the aws_login_start fresh-spawn branch. The handler calls
// `_startSsoLoginImpl(useProfile)` rather than `startSsoLogin` directly so a
// test can inject an implementation that supplies the fake-aws shim opts
// (startSsoLogin reads no AWS_MCP_TEST_* env vars, so there is no in-process
// way to point its bare call at the fake otherwise). In production this is
// the real startSsoLogin with no opts -- behavior is byte-identical to a
// direct call. Follows the same `_`-prefixed exported-hook convention as
// _resetSession / _clearSessions / _ttlKillswitchTick.
//
// The profile path calls it with a bare profile string and nothing else, so its
// production call is still exactly `startSsoLogin(profile)`. The sso-session
// path passes a LoginTarget plus the child env it needs (envWithoutProfile), so
// an injected test implementation can see -- and must forward -- that env.
interface StartExtra {
  env?: NodeJS.ProcessEnv;
  /** See SsoLoginOptions.dedupeTag. */
  dedupeTag?: string;
}
type StartImpl = (target: LoginTarget | string, extra?: StartExtra) => ReturnType<typeof startSsoLogin>;
const defaultStartImpl: StartImpl = (target, extra) => (extra ? startSsoLogin(target, extra) : startSsoLogin(target));
let _startSsoLoginImpl: StartImpl = defaultStartImpl;

/** For tests -- inject a startSsoLogin implementation (e.g. one that passes fakeOpts). */
export function _setStartSsoLoginImpl(fn: StartImpl): void {
  _startSsoLoginImpl = fn;
}

/** For tests -- restore the production startSsoLogin call. Run in afterEach so the seam can't bleed across tests. */
export function _resetStartSsoLoginImpl(): void {
  _startSsoLoginImpl = defaultStartImpl;
}

/**
 * Project a cached-token record down to exactly the three fields the MCP
 * surface exposes: { expiresAt, minutesLeft, startUrl }. Both aws_whoami and
 * aws_login_complete route their `ssoToken` response through this so a future
 * field added to the findCachedSsoToken return type can't leak out of either
 * path. Keeps the emitted shape stable and identical across both tools.
 */
function projectSsoToken(
  cachedToken: { expiresAt: string; minutesLeft: number; startUrl?: string } | null,
): { expiresAt: string; minutesLeft: number; startUrl?: string } | null {
  if (!cachedToken) return null;
  return {
    expiresAt: cachedToken.expiresAt,
    minutesLeft: cachedToken.minutesLeft,
    startUrl: cachedToken.startUrl,
  };
}

/**
 * Resolve a profile's SSO start URL by reading the AWS config file (the same
 * one the CLI reads: AWS_CONFIG_FILE, else ~/.aws/config). Returns null if the
 * config file isn't readable or the profile isn't SSO-backed; callers then
 * fall back to the legacy "first valid token" behavior.
 */
function startUrlForProfile(profile: string): string | undefined {
  try {
    const text = readFileSync(resolveAwsConfigPath(), "utf-8");
    return resolveProfileStartUrl(text, profile) ?? undefined;
  } catch {
    return undefined;
  }
}

type SessionBlockOutcome = "created" | "existing" | "updated";

/**
 * Make sure `[sso-session <name>]` exists in the AWS config file before the
 * login spawns -- `aws sso login --sso-session X` reads its start URL and region
 * from that block, so there is nothing to log in to without it.
 *
 * Runs entirely under the config file's lock (withLockedAtomicWrite), so the
 * decision below is made against the same text it replaces:
 *   - absent + startUrl/ssoRegion given  -> create the managed block
 *   - absent, not given                  -> error
 *   - present, same values (or omitted)  -> reuse ("existing"), no write
 *   - present, different, managed        -> rewrite only the managed keys
 *   - present, different, hand-written   -> refuse; never touch a user's block
 *
 * A failed login later does NOT roll the block back: it is harmless and
 * idempotent (the next start reports "existing"), and a rollback would race a
 * concurrent start.
 */
async function ensureSsoSessionBlock(
  name: string,
  startUrl: string | undefined,
  ssoRegion: string | undefined,
): Promise<
  | { ok: true; outcome: SessionBlockOutcome; startUrl: string; ssoRegion: string; configPath: string }
  | { ok: false; error: string }
> {
  const configPath = resolveAwsConfigPath();
  if (configPath === "") return { ok: false, error: EMPTY_CONFIG_FILE_ERROR };
  let result:
    | { ok: true; outcome: SessionBlockOutcome; startUrl: string; ssoRegion: string; configPath: string }
    | { ok: false; error: string } = { ok: false, error: "internal: session block not evaluated" };
  try {
    await withLockedAtomicWrite(
      configPath,
      (text) => {
        const block = parseSsoSessions(text).find((b) => b.name === name);
        if (!block) {
          if (startUrl === undefined || ssoRegion === undefined) {
            result = {
              ok: false,
              error: `No [sso-session ${name}] in ${configPath}. Pass startUrl and ssoRegion to create it.`,
            };
            return null;
          }
          result = { ok: true, outcome: "created", startUrl, ssoRegion, configPath };
          return planConfigUpserts(text, [renderSessionSpec(name, startUrl, ssoRegion)]).text;
        }
        if (startUrl === undefined || ssoRegion === undefined) {
          if (!block.ssoStartUrl || !block.ssoRegion) {
            result = {
              ok: false,
              error: `[sso-session ${name}] in ${configPath} has no sso_start_url / sso_region. Pass startUrl and ssoRegion, or fix the block.`,
            };
            return null;
          }
          result = {
            ok: true,
            outcome: "existing",
            startUrl: block.ssoStartUrl,
            ssoRegion: block.ssoRegion,
            configPath,
          };
          return null;
        }
        if (block.ssoStartUrl === startUrl && block.ssoRegion === ssoRegion) {
          result = { ok: true, outcome: "existing", startUrl, ssoRegion, configPath };
          return null;
        }
        if (!block.managed) {
          result = {
            ok: false,
            error: `[sso-session ${name}] in ${configPath} was not created by aws-mcp and has sso_start_url=${block.ssoStartUrl ?? "(unset)"} / sso_region=${block.ssoRegion ?? "(unset)"}. Pick a different ssoSession name, or edit the file yourself.`,
          };
          return null;
        }
        const planned = planConfigUpserts(text, [renderSessionSpec(name, startUrl, ssoRegion)]);
        result = { ok: true, outcome: "updated", startUrl, ssoRegion, configPath };
        return planned.outcomes[0] === "unchanged" ? null : planned.text;
      },
      // The config holds no secrets: create it 0600 like the CLI's own files,
      // but do not refuse on a mount that cannot honour the mode.
      { requirePrivate: false, ensureDir: true },
    );
  } catch (err) {
    return {
      ok: false,
      error: `Could not update ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return result;
}

/** Read an sso-session block's start URL from the config, or undefined. */
function startUrlForSsoSession(name: string): string | undefined {
  try {
    const text = readFileSync(resolveAwsConfigPath(), "utf-8");
    return parseSsoSessions(text).find((b) => b.name === name)?.ssoStartUrl;
  } catch {
    return undefined;
  }
}

/**
 * sessionId -> the start URL + region its `aws sso login --sso-session` child
 * read at launch. The child reads the config once, so a login started before
 * the block was repointed is a login to the OLD Identity Center instance and
 * must not be handed out as the login for the new one. Entries for sessions
 * that are gone are pruned on every sso-session start.
 */
const sessionLoginConfig = new Map<string, string>();

function loginConfigKey(startUrl: string, ssoRegion: string): string {
  return `${startUrl}|${ssoRegion}`;
}

/**
 * aws_login_start's sso-session branch: validate, ensure the block, then reuse
 * an in-flight login or spawn `aws sso login --sso-session <name>` with the
 * profile selectors stripped from the child env.
 */
async function startSessionLogin(i: {
  ssoSession: string;
  startUrl?: string;
  ssoRegion?: string;
}): Promise<ToolResult> {
  const nameErr = ssoSessionNameProblem(i.ssoSession);
  if (nameErr) return { ok: false, errorKind: "bad_input", error: nameErr };
  let startUrl: string | undefined;
  if (i.startUrl !== undefined) {
    const norm = normalizeStartUrl(i.startUrl);
    if (!norm.ok) return { ok: false, errorKind: "bad_input", error: norm.error };
    startUrl = norm.url;
  }
  if (i.ssoRegion !== undefined) {
    const regionErr = regionProblem("ssoRegion", i.ssoRegion);
    if (regionErr) return { ok: false, errorKind: "bad_input", error: regionErr };
  }

  const block = await ensureSsoSessionBlock(i.ssoSession, startUrl, i.ssoRegion);
  if (!block.ok) return { ok: false, error: block.error };

  const target: LoginTarget = { kind: "sso-session", name: i.ssoSession };
  const common = {
    ssoSession: i.ssoSession,
    startUrl: block.startUrl,
    ssoRegion: block.ssoRegion,
    configPath: block.configPath,
    sessionBlock: block.outcome,
  };
  for (const id of sessionLoginConfig.keys()) {
    if (getLoginTarget(id) === null) sessionLoginConfig.delete(id);
  }
  const wantConfig = loginConfigKey(block.startUrl, block.ssoRegion);
  let active = findActiveSession(target);
  // Reuse only a login whose child read the block as it is NOW. One started
  // against a different URL/region (the block was just repointed, or an
  // unknown login after an update) is abandoned: its device code would sign
  // the user in to the wrong instance.
  while (active) {
    const had = sessionLoginConfig.get(active.sessionId);
    const stale = had !== undefined ? had !== wantConfig : block.outcome === "updated";
    if (!stale) break;
    cancelLogin(
      active.sessionId,
      `Superseded: [sso-session ${i.ssoSession}] was repointed to ${block.startUrl} (${block.ssoRegion}) while this login was in flight. Use the sessionId from the latest aws_login_start.`,
    );
    sessionLoginConfig.delete(active.sessionId);
    active = findActiveSession(target);
  }
  if (active) {
    return {
      ok: true,
      data: {
        sessionId: active.sessionId,
        ...common,
        verificationUrl: active.verificationUrl,
        userCode: active.userCode,
        reused: true,
        instructions: `A login is already in progress for sso-session '${i.ssoSession}'. Open ${active.verificationUrl} in your browser, enter code ${active.userCode}, then call aws_login_complete with sessionId='${active.sessionId}' to confirm.`,
      },
    };
  }
  const result = await _startSsoLoginImpl(target, { env: envWithoutProfile(process.env), dedupeTag: wantConfig });
  if (!result.ok) return { ok: false, error: result.error, rawBody: result.rawOutput };
  sessionLoginConfig.set(result.sessionId, wantConfig);
  return {
    ok: true,
    data: {
      sessionId: result.sessionId,
      ...common,
      verificationUrl: result.verificationUrl,
      userCode: result.userCode,
      instructions: `Open ${result.verificationUrl} in your browser, enter code ${result.userCode}, then call aws_login_complete with sessionId='${result.sessionId}' to confirm.`,
    },
  };
}

/**
 * Run `aws sts get-caller-identity` for `profile` + `region` via runAwsCall.
 * Returns the parsed identity (Account/UserId/Arn) on success, or the
 * already-classified failure shape (sso_expired / no_creds / other) so
 * callers can render the same fix-it hints aws_call uses.
 *
 * Perf tradeoff: this routes through the AWS CLI subprocess (~250-600 ms
 * cold-start cost on each call) instead of the in-process @aws-sdk/client-sts
 * (~30-100 ms warm). The price buys consistency -- aws_whoami's failure
 * hints are now byte-identical to aws_call's, so an agent that sees
 * "SSO session expired for profile X. Call aws_login_start..." gets the
 * same recovery path regardless of which tool surfaced it. Callers that
 * whoami before every action will feel the cost; for those, prefer
 * caching the identity for the duration of an agent step.
 */
async function getCallerIdentity(
  profile: string,
  region: string,
): Promise<
  | { ok: true; account?: string; userId?: string; arn?: string }
  | { ok: false; kind: string; error: string; suggestion?: string; rawBody?: string }
> {
  const result = await runAwsCall({
    service: "sts",
    operation: "get-caller-identity",
    profile,
    region,
    outputFormat: "json",
  });
  if (!result.ok) {
    return {
      ok: false,
      kind: result.kind,
      error: result.error,
      suggestion: result.suggestion,
      // `||`, not `??`: on a non-zero exit with empty stderr, rawStderr is ""
      // (present but useless), and `??` would hand back that empty string
      // instead of falling through to whatever the CLI managed to print on
      // stdout. Same reasoning as the `profile || getProfile()` sites below.
      rawBody: result.rawStderr || result.rawStdout,
    };
  }
  const data = (result.data ?? {}) as { Account?: unknown; UserId?: unknown; Arn?: unknown };
  return {
    ok: true,
    account: typeof data.Account === "string" ? data.Account : undefined,
    userId: typeof data.UserId === "string" ? data.UserId : undefined,
    arn: typeof data.Arn === "string" ? data.Arn : undefined,
  };
}

export const authTools: readonly Tool[] = [
  {
    name: "aws_whoami",
    description:
      "Show the current AWS identity (account, role ARN, user ID) plus SSO token status and time remaining. Use this first to verify auth before running other AWS operations. Returns a structured fix-it message if SSO is expired.",
    annotations: {
      title: "Show current AWS identity",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      profile: z.string().optional().describe("AWS profile name. Defaults to $AWS_PROFILE or 'default'."),
      region: z.string().optional().describe("AWS region. Defaults to $AWS_REGION or us-east-1."),
    }),
    handler: async (input: unknown): Promise<ToolResult> => {
      const { profile, region } = input as { profile?: string; region?: string };
      // `||` (not `??`) is intentional here and at the sibling sites below: an
      // empty-string profile is not a real profile, so it must fall through to
      // getProfile() (session/env/'default'), not slot in as "". Don't "tidy"
      // this to `??` -- that would let `profile: ""` override the default with
      // an unusable value.
      const useProfile = profile || getProfile();
      const useRegion = region || getRegion();

      const identity = await getCallerIdentity(useProfile, useRegion);
      if (!identity.ok) {
        // runAwsCall already shaped the error text for sso_expired / no_creds
        // (matching what aws_call surfaces). Pass it through so this tool's
        // hints stay consistent with every other tool's hints.
        return {
          ok: false,
          error: identity.error,
          errorKind: identity.kind,
          suggestion: identity.suggestion,
          rawBody: identity.rawBody,
        };
      }
      // startUrlForProfile returns undefined for non-SSO profiles (no
      // sso_start_url in ~/.aws/config). When that happens, the startUrl
      // filter is absent and findCachedSsoToken falls back to the legacy
      // "any valid token" behavior (returns the freshest non-expired token
      // regardless of which SSO instance it belongs to). This is best-effort
      // -- callers with non-SSO profiles get a token hint when one is cached
      // from any SSO login, and no hint when the cache is empty. The
      // multi-org misread is only a risk when two SSO instances share one
      // cache; a non-SSO profile has no SSO instance to misread against.
      const cachedToken = findCachedSsoToken(undefined, { startUrl: startUrlForProfile(useProfile) });

      return {
        ok: true,
        data: {
          account: identity.account,
          userId: identity.userId,
          arn: identity.arn,
          profile: useProfile,
          region: useRegion,
          ssoToken: projectSsoToken(cachedToken),
        },
      };
    },
  },
  {
    name: "aws_login_start",
    description:
      "Start an AWS SSO login via the device-code flow (no browser spawned from this process). Returns a verification URL and short code -- surface these to the user so they can open the URL in their own browser and paste the code. After they auth, call aws_login_complete with the returned sessionId to confirm completion. For a user with NO profile yet, pass ssoSession plus startUrl and ssoRegion instead of profile: this writes a managed [sso-session] block to the AWS config file (never touching one the user wrote) and logs in to IAM Identity Center directly; then use aws_sso_list_assignments and aws_sso_generate_profiles.",
    annotations: {
      title: "Start AWS SSO login (device code)",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    // Cross-field rules live in the handler, not in .refine(): Tool.inputSchema
    // is a ZodObject, and a refine would turn it into ZodEffects.
    inputSchema: z.object({
      profile: z
        .string()
        .optional()
        .describe(
          "AWS profile configured for SSO. Defaults to $AWS_PROFILE or 'default'. Mutually exclusive with ssoSession.",
        ),
      ssoSession: z
        .string()
        .optional()
        .describe(
          "Log in to an IAM Identity Center sso-session directly, without any profile. Use with startUrl + ssoRegion to create the [sso-session] block on first use; omit them to log in to an existing block.",
        ),
      startUrl: z.string().optional().describe("Identity Center start URL (https://...). Only with ssoSession."),
      ssoRegion: z
        .string()
        .optional()
        .describe("Region of the Identity Center instance, e.g. us-east-1. Only with ssoSession."),
    }),
    handler: async (input: unknown): Promise<ToolResult> => {
      const raw = input as {
        profile?: string;
        ssoSession?: string;
        startUrl?: string;
        ssoRegion?: string;
      };
      // "" is absent, as at every `profile || getProfile()` site: a client that
      // fills unused optional string fields with "" must still get a profile
      // login, not a cross-field bad_input.
      const profile = raw.profile || undefined;
      const ssoSession = raw.ssoSession || undefined;
      const startUrl = raw.startUrl || undefined;
      const ssoRegion = raw.ssoRegion || undefined;
      if (ssoSession !== undefined || startUrl !== undefined || ssoRegion !== undefined) {
        if (profile !== undefined) {
          return { ok: false, errorKind: "bad_input", error: "Pass either profile or ssoSession, not both." };
        }
        if (ssoSession === undefined) {
          return { ok: false, errorKind: "bad_input", error: "startUrl and ssoRegion are only valid with ssoSession." };
        }
        if ((startUrl === undefined) !== (ssoRegion === undefined)) {
          return {
            ok: false,
            errorKind: "bad_input",
            error:
              "Pass startUrl and ssoRegion together (to create or repoint the block), or neither (to use the existing block).",
          };
        }
        return startSessionLogin({ ssoSession, startUrl, ssoRegion });
      }
      const useProfile = profile || getProfile();

      // If a login is already in flight for this profile, surface its
      // existing URL + code instead of spawning a second subprocess. A
      // rapid-fire caller (common: refresh + start on the same tick) would
      // otherwise leave two aws subprocesses racing for the same token cache.
      const active = findActiveSessionByProfile(useProfile);
      if (active) {
        return {
          ok: true,
          data: {
            sessionId: active.sessionId,
            profile: active.profile,
            verificationUrl: active.verificationUrl,
            userCode: active.userCode,
            reused: true,
            instructions: `A login is already in progress for profile '${useProfile}'. Open ${active.verificationUrl} in your browser, enter code ${active.userCode}, then call aws_login_complete with sessionId='${active.sessionId}' to confirm.`,
          },
        };
      }

      const result = await _startSsoLoginImpl(useProfile);
      if (!result.ok) {
        return {
          ok: false,
          error: result.error,
          rawBody: result.rawOutput,
        };
      }
      return {
        ok: true,
        data: {
          sessionId: result.sessionId,
          profile: result.profile,
          verificationUrl: result.verificationUrl,
          userCode: result.userCode,
          instructions: `Open ${result.verificationUrl} in your browser, enter code ${result.userCode}, then call aws_login_complete with sessionId='${result.sessionId}' to confirm.`,
        },
      };
    },
  },
  {
    name: "aws_login_complete",
    description:
      "Block until the SSO login started by aws_login_start finishes (user completed auth in browser, or subprocess exited with error). Returns the new identity on success, or a structured error. For an ssoSession login there is no profile yet, so it returns the token status and points to aws_sso_list_assignments instead of an identity.",
    annotations: {
      title: "Wait for AWS SSO login to finish",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      sessionId: z.string().describe("The sessionId returned by aws_login_start."),
      profile: z
        .string()
        .optional()
        .describe("Profile to verify identity against after login. Defaults to $AWS_PROFILE or 'default'."),
      region: z.string().optional().describe("Region for the post-login identity check."),
    }),
    handler: async (input: unknown): Promise<ToolResult> => {
      const { sessionId, profile, region } = input as { sessionId: string; profile?: string; region?: string };
      // Read BEFORE waitForLogin, which claims (deletes) the session entry.
      const target = getLoginTarget(sessionId);
      const waitResult = await waitForLogin(sessionId);
      if (!waitResult.ok) {
        return {
          ok: false,
          error: waitResult.error ?? `aws sso login exited with code ${waitResult.exitCode}`,
          rawBody: waitResult.rawOutput,
        };
      }

      if (target?.kind === "sso-session") {
        // No sts get-caller-identity: there is no profile to run it as (it
        // would fail, or worse answer as whatever AWS_PROFILE points at). The
        // token-cache status is the honest confirmation for this kind.
        const startUrl = startUrlForSsoSession(target.name);
        const cachedToken = startUrl ? findCachedSsoToken(undefined, { startUrl }) : null;
        return {
          ok: true,
          data: {
            loggedIn: true,
            ssoSession: target.name,
            startUrl,
            ssoToken: projectSsoToken(cachedToken),
            next: `Call aws_sso_list_assignments with ssoSession='${target.name}' to see your accounts and roles.`,
            ...(profile !== undefined || region !== undefined
              ? {
                  note: "profile / region are ignored for an ssoSession login: there is no profile to check an identity against yet.",
                }
              : {}),
          },
        };
      }

      const useProfile = profile || getProfile();
      const useRegion = region || getRegion();
      const identity = await getCallerIdentity(useProfile, useRegion);
      if (!identity.ok) {
        return {
          ok: false,
          error: `Login subprocess succeeded but identity check failed: ${identity.error}`,
          errorKind: identity.kind,
          suggestion: identity.suggestion,
          rawBody: identity.rawBody,
        };
      }
      const cachedToken = findCachedSsoToken(undefined, { startUrl: startUrlForProfile(useProfile) });
      return {
        ok: true,
        data: {
          loggedIn: true,
          account: identity.account,
          userId: identity.userId,
          arn: identity.arn,
          profile: useProfile,
          region: useRegion,
          ssoToken: projectSsoToken(cachedToken),
        },
      };
    },
  },
  {
    name: "aws_refresh_if_expiring_soon",
    description:
      "Proactive SSO token check. If the cached token has fewer than `thresholdMinutes` left (default 10), this kicks off aws_login_start and returns the verification URL + code in one round-trip. If plenty of time remains, returns `status: 'ok'` with the minutes left. Use at the start of a multi-step AWS workflow to avoid mid-session expiry. `status: 'ok'` is a point-in-time reading of the cache, not a lease: nothing re-checks afterwards, so a token that lapses mid-workflow still surfaces as an sso_expired error from the next aws_call / aws_whoami. Raise `thresholdMinutes` to cover the expected length of the workflow rather than treating 'ok' as a guarantee.",
    annotations: {
      title: "Refresh SSO token if it's expiring soon",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      thresholdMinutes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Trigger refresh when the token has fewer than this many minutes left. Default 10."),
      profile: z.string().optional().describe("AWS profile configured for SSO. Defaults to $AWS_PROFILE or 'default'."),
    }),
    handler: async (input: unknown): Promise<ToolResult> => {
      const { thresholdMinutes, profile } = input as { thresholdMinutes?: number; profile?: string };
      const threshold = thresholdMinutes ?? 10;
      const useProfile = profile || getProfile();
      const startUrl = startUrlForProfile(useProfile);
      const cachedToken = findCachedSsoToken(undefined, { startUrl });

      if (cachedToken && cachedToken.minutesLeft >= threshold) {
        return {
          ok: true,
          data: {
            status: "ok",
            minutesLeft: cachedToken.minutesLeft,
            expiresAt: cachedToken.expiresAt,
            profile: useProfile,
          },
        };
      }

      // Reuse an in-flight login for this profile rather than spawning a
      // second aws sso login subprocess (two racing writers into the same
      // token cache is a footgun).
      const active = findActiveSessionByProfile(useProfile);
      if (active) {
        return {
          ok: true,
          data: {
            status: "refreshing",
            reason: "A login is already in progress for this profile.",
            sessionId: active.sessionId,
            profile: active.profile,
            verificationUrl: active.verificationUrl,
            userCode: active.userCode,
            reused: true,
            instructions: `Open ${active.verificationUrl} in your browser, enter code ${active.userCode}, then call aws_login_complete with sessionId='${active.sessionId}' to confirm.`,
          },
        };
      }

      // Route through the same test-injection seam as aws_login_start so
      // a test can swap in a fake-aws shim and exercise this branch
      // without a real SSO subprocess. Sibling to the _startSsoLoginImpl
      // call above; if a future test wants the refresh flow to use a
      // different scenario than the start flow, the same _setStartSsoLoginImpl
      // call covers both paths uniformly.
      const loginResult = await _startSsoLoginImpl(useProfile);
      if (!loginResult.ok) {
        return { ok: false, error: loginResult.error, rawBody: loginResult.rawOutput };
      }
      return {
        ok: true,
        data: {
          status: "refreshing",
          reason: cachedToken
            ? `Token has ${cachedToken.minutesLeft} min left (threshold ${threshold}).`
            : "No cached SSO token found.",
          sessionId: loginResult.sessionId,
          profile: loginResult.profile,
          verificationUrl: loginResult.verificationUrl,
          userCode: loginResult.userCode,
          instructions: `Open ${loginResult.verificationUrl} in your browser, enter code ${loginResult.userCode}, then call aws_login_complete with sessionId='${loginResult.sessionId}' to confirm.`,
        },
      };
    },
  },
];
