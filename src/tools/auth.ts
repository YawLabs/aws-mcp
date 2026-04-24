import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { z } from "zod";
import { classifyAuthError } from "../errors.js";
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
 * eligible — callers with a known profile should always pass it to avoid
 * the multi-org hazard.
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
    for (const f of files) {
      try {
        const path = join(cacheDir, f);
        if (statSync(path).size > MAX_SSO_CACHE_FILE_BYTES) continue;
        const contents = JSON.parse(readFileSync(path, "utf-8"));
        if (!contents.accessToken || !contents.expiresAt) continue;
        if (opts.startUrl && contents.startUrl !== opts.startUrl) continue;
        const expiresAt = new Date(contents.expiresAt).getTime();
        if (expiresAt > now) {
          return {
            expiresAt: contents.expiresAt,
            minutesLeft: Math.floor((expiresAt - now) / 60_000),
            startUrl: contents.startUrl,
          };
        }
      } catch {
        // skip malformed cache file
      }
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

      try {
        const client = new STSClient({
          region: useRegion,
          credentials: fromNodeProviderChain({ profile: useProfile }),
        });
        const identity = await client.send(new GetCallerIdentityCommand({}));
        const cachedToken = findCachedSsoToken(undefined, { startUrl: startUrlForProfile(useProfile) });

        return {
          ok: true,
          data: {
            account: identity.Account,
            userId: identity.UserId,
            arn: identity.Arn,
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
      } catch (err) {
        const classified = classifyAuthError(err);
        if (classified.kind === "sso_expired") {
          return {
            ok: false,
            error: `SSO session expired for profile '${useProfile}'. Call aws_login_start with profile='${useProfile}' to re-authenticate, or run 'aws sso login --profile ${useProfile}' in your terminal.`,
          };
        }
        if (classified.kind === "no_creds") {
          return {
            ok: false,
            error: `No credentials found for profile '${useProfile}'. Check ~/.aws/config and ~/.aws/credentials. Underlying error: ${classified.message}`,
          };
        }
        return { ok: false, error: classified.message };
      }
    },
  },
  {
    name: "aws_login_start",
    description:
      "Start an AWS SSO login via the device-code flow (no browser spawned from this process). Returns a verification URL and short code — surface these to the user so they can open the URL in their own browser and paste the code. After they auth, call aws_login_complete with the returned sessionId to confirm completion.",
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
      try {
        const client = new STSClient({
          region: useRegion,
          credentials: fromNodeProviderChain({ profile: useProfile }),
        });
        const identity = await client.send(new GetCallerIdentityCommand({}));
        const cachedToken = findCachedSsoToken(undefined, { startUrl: startUrlForProfile(useProfile) });
        return {
          ok: true,
          data: {
            loggedIn: true,
            account: identity.Account,
            userId: identity.UserId,
            arn: identity.Arn,
            profile: useProfile,
            region: useRegion,
            ssoToken: cachedToken,
          },
        };
      } catch (err) {
        const classified = classifyAuthError(err);
        return {
          ok: false,
          error: `Login subprocess succeeded but identity check failed: ${classified.message}`,
        };
      }
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
