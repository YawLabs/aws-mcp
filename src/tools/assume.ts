import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runAwsCall } from "../aws-cli.js";
import { upsertProfile } from "../aws-credentials.js";
import { getProfile, getRegion } from "../session.js";
import type { Tool, ToolResult } from "./tool.js";

/**
 * Pick a target profile name. We prefix user-chosen names with 'mcp-' to
 * make it obvious which profiles this tool writes, and to avoid stomping
 * on a pre-existing profile the user cares about.
 */
function resolveTargetProfile(input: { targetProfile?: string; sessionName: string }): string {
  if (input.targetProfile) {
    return input.targetProfile.startsWith("mcp-") ? input.targetProfile : `mcp-${input.targetProfile}`;
  }
  return `mcp-${input.sessionName}`;
}

/**
 * Shape returned by `aws sts assume-role --output json`. We only consume
 * Credentials + AssumedRoleUser; the CLI also includes PackedPolicySize
 * and ResponseMetadata that we ignore.
 */
interface AssumeRoleCliResponse {
  Credentials?: {
    AccessKeyId?: string;
    SecretAccessKey?: string;
    SessionToken?: string;
    // ISO 8601 string when --output json is used. The SDK returned a Date,
    // but the CLI emits the string directly so we don't need to convert.
    Expiration?: string;
  };
  AssumedRoleUser?: {
    Arn?: string;
    AssumedRoleId?: string;
  };
}

export const assumeTools: readonly Tool[] = [
  {
    name: "aws_assume_role",
    description:
      "Call STS AssumeRole and stash the returned temporary credentials as a named profile in ~/.aws/credentials. Subsequent calls to aws_call / aws_whoami / aws_paginate can use profile='mcp-<sessionName>' (or your overridden targetProfile name). The raw secret key / session token are NOT returned to the caller — only the profile name, expiration, and assumed identity. Use for cross-account access: a source profile (your SSO identity) assumes a role in another account. Default timeout is 120s (raise via timeoutMs for slow SAML / credential_process setups on cold start).",
    annotations: {
      title: "Assume an IAM role and stash creds as a profile",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      roleArn: z.string().describe("Target role ARN, e.g. 'arn:aws:iam::123456789012:role/CrossAccountAdmin'."),
      sessionName: z
        .string()
        .min(2)
        .max(64)
        .regex(/^[\w+=,.@-]+$/, "sessionName must match [\\w+=,.@-]")
        .describe("Role session name (shows up in CloudTrail). Alphanumeric + +=,.@- only."),
      durationSeconds: z
        .number()
        .int()
        .min(900)
        .max(43_200)
        .optional()
        .describe("Session duration in seconds (900-43200). Default 3600."),
      externalId: z.string().optional().describe("External ID (only required if the role's trust policy demands it)."),
      sourceProfile: z
        .string()
        .optional()
        .describe("Profile to use as the assuming identity. Defaults to session profile / $AWS_PROFILE / 'default'."),
      targetProfile: z
        .string()
        .optional()
        .describe(
          "Profile name to write the temp creds under. Default 'mcp-<sessionName>'. Auto-prefixed with 'mcp-' if missing.",
        ),
      region: z.string().optional().describe("Region for the STS call. Defaults to session region / $AWS_REGION."),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Timeout in milliseconds for the underlying STS AssumeRole CLI call. Default 120000 (120s) -- gives cold-start SAML / credential_process setups headroom over runAwsCall's 60s default. Raise further for unusually slow IdPs.",
        ),
    }),
    handler: async (input: unknown): Promise<ToolResult> => {
      const i = input as {
        roleArn: string;
        sessionName: string;
        durationSeconds?: number;
        externalId?: string;
        sourceProfile?: string;
        targetProfile?: string;
        region?: string;
        timeoutMs?: number;
      };
      const sourceProfile = i.sourceProfile || getProfile();
      const useRegion = i.region || getRegion();
      const targetProfile = resolveTargetProfile({ targetProfile: i.targetProfile, sessionName: i.sessionName });

      // Shell out to `aws sts assume-role` rather than using the in-process
      // SDK. The SDK's fromNodeProviderChain occasionally diverges from the
      // CLI for profiles that use `credential_process` (the standard SAML
      // escape hatch) or non-Identity-Center SSO -- mirroring how every
      // other tool in this server reaches AWS keeps the "SAML works because
      // we shell out" story consistent. Inputs are sent via --cli-input-json
      // (no argv positionals), so RoleArn / RoleSessionName / ExternalId
      // can't pose as flags.
      const params: Record<string, unknown> = {
        RoleArn: i.roleArn,
        RoleSessionName: i.sessionName,
        DurationSeconds: i.durationSeconds ?? 3600,
      };
      if (i.externalId !== undefined) {
        params.ExternalId = i.externalId;
      }

      const result = await runAwsCall({
        service: "sts",
        operation: "assume-role",
        params,
        profile: sourceProfile,
        region: useRegion,
        outputFormat: "json",
        // SAML / credential_process flows can exceed runAwsCall's 60s default
        // on cold start (federated IdP round-trip, MFA prompt forwarding).
        // 120s is the assume-role-specific floor; callers can override.
        timeoutMs: i.timeoutMs ?? 120_000,
      });

      if (!result.ok) {
        // runAwsCall already classified auth-class failures; rewrite the
        // sso_expired hint to name the source profile (the CLI's stderr
        // mentions whichever profile it failed to load, but the caller
        // cares about the assuming identity specifically).
        if (result.kind === "sso_expired") {
          return {
            ok: false,
            error: `SSO session expired for source profile '${sourceProfile}'. Call aws_login_start with profile='${sourceProfile}' before assuming.`,
          };
        }
        return { ok: false, error: result.error, rawBody: result.rawStderr ?? result.rawStdout };
      }

      const data = (result.data ?? {}) as AssumeRoleCliResponse;
      const creds = data.Credentials;
      if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
        return { ok: false, error: "STS AssumeRole succeeded but returned incomplete credentials." };
      }

      const credentialsPath = join(homedir(), ".aws", "credentials");
      upsertProfile(credentialsPath, targetProfile, {
        aws_access_key_id: creds.AccessKeyId,
        aws_secret_access_key: creds.SecretAccessKey,
        aws_session_token: creds.SessionToken,
      });

      const expiration = creds.Expiration;
      return {
        ok: true,
        data: {
          profile: targetProfile,
          credentialsPath,
          expiration,
          assumedRoleArn: data.AssumedRoleUser?.Arn,
          assumedRoleId: data.AssumedRoleUser?.AssumedRoleId,
          sourceProfile,
          hint: `Pass profile='${targetProfile}' to subsequent aws_call / aws_whoami / aws_paginate calls to use these credentials. They expire at ${expiration ?? "unknown"}.`,
        },
      };
    },
  },
];
