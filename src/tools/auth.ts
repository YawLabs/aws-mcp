import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runAwsCall } from "../aws-cli.js";
import { getProfile, getRegion } from "../session.js";
import { findActiveSessionByProfile, startSsoLogin, waitForLogin } from "../sso.js";
import { resolveProfileStartUrl } from "./profiles.js";
import type { Tool, ToolResult } from "./tool.js";

// Real SSO cache files are a few KB (JWT + metadata). 64 KB is a generous
// cap that still keeps a malformed or malicious giant file from blocking the
// event loop on readFileSync.
const MAX_SSO_CACHE_FILE_BYTES = 64 * 1024;

export interface FindTokenOptions {
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
  cacheDir: string = join(homedir(), ".aws", "sso", "cache"),
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
        const expiresAtMs = new Date(contents.expiresAt).getTime();
        if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) continue;
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
        minutesLeft: Math.floor((best.expiresAtMs - now) / 60_000),
        startUrl: best.startUrl,
      };
    }
  } catch {
    // no cache dir
  }
  return null;
}

/**
 * Resolve a profile's SSO start URL by reading ~/.aws/config. Returns null
 * if the config file isn't readable or the profile isn't SSO-backed; callers
 * then fall back to the legacy "first valid token" behavior.
 */
function startUrlForProfile(profile: string): string | undefined {
  try {
    const text = readFileSync(join(homedir(), ".aws", "config"), "utf-8");
    return resolveProfileStartUrl(text, profile) ?? undefined;
  } catch {
    return undefined;
  }
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
  | { ok: false; kind: string; error: string; rawBody?: string }
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
      rawBody: result.rawStderr ?? result.rawStdout,
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
      const useProfile = profile || getProfile();
      const useRegion = region || getRegion();

      const identity = await getCallerIdentity(useProfile, useRegion);
      if (!identity.ok) {
        // runAwsCall already shaped the error text for sso_expired / no_creds
        // (matching what aws_call surfaces). Pass it through so this tool's
        // hints stay consistent with every other tool's hints.
        return { ok: false, error: identity.error, rawBody: identity.rawBody };
      }
      const cachedToken = findCachedSsoToken(undefined, { startUrl: startUrlForProfile(useProfile) });

      return {
        ok: true,
        data: {
          account: identity.account,
          userId: identity.userId,
          arn: identity.arn,
          profile: useProfile,
          region: useRegion,
          ssoToken: cachedToken
            ? {
                expiresAt: cachedToken.expiresAt,
                minutesLeft: cachedToken.minutesLeft,
                startUrl: cachedToken.startUrl,
              }
            : null,
        },
      };
    },
  },
  {
    name: "aws_login_start",
    description:
      "Start an AWS SSO login via the device-code flow (no browser spawned from this process). Returns a verification URL and short code -- surface these to the user so they can open the URL in their own browser and paste the code. After they auth, call aws_login_complete with the returned sessionId to confirm completion.",
    annotations: {
      title: "Start AWS SSO login (device code)",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      profile: z.string().optional().describe("AWS profile configured for SSO. Defaults to $AWS_PROFILE or 'default'."),
    }),
    handler: async (input: unknown): Promise<ToolResult> => {
      const { profile } = input as { profile?: string };
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

      const result = await startSsoLogin(useProfile);
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
      "Block until the SSO login started by aws_login_start finishes (user completed auth in browser, or subprocess exited with error). Returns the new identity on success, or a structured error.",
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
      const waitResult = await waitForLogin(sessionId);
      if (!waitResult.ok) {
        return {
          ok: false,
          error: waitResult.error ?? `aws sso login exited with code ${waitResult.exitCode}`,
          rawBody: waitResult.rawOutput,
        };
      }

      const useProfile = profile || getProfile();
      const useRegion = region || getRegion();
      const identity = await getCallerIdentity(useProfile, useRegion);
      if (!identity.ok) {
        return {
          ok: false,
          error: `Login subprocess succeeded but identity check failed: ${identity.error}`,
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
          ssoToken: cachedToken,
        },
      };
    },
  },
  {
    name: "aws_refresh_if_expiring_soon",
    description:
      "Proactive SSO token check. If the cached token has fewer than `thresholdMinutes` left (default 10), this kicks off aws_login_start and returns the verification URL + code in one round-trip. If plenty of time remains, returns `status: 'ok'` with the minutes left. Use at the start of a multi-step AWS workflow to avoid mid-session expiry.",
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

      const loginResult = await startSsoLogin(useProfile);
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
