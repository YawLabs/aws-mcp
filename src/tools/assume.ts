import { homedir } from "node:os";
import { join } from "node:path";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { z } from "zod";
import { upsertProfile } from "../aws-credentials.js";
import { classifyAuthError } from "../errors.js";
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

export const assumeTools: readonly Tool[] = [
  {
    name: "aws_assume_role",
    description:
      "Call STS AssumeRole and stash the returned temporary credentials as a named profile in ~/.aws/credentials. Subsequent calls to aws_call / aws_whoami / aws_paginate can use profile='mcp-<sessionName>' (or your overridden targetProfile name). The raw secret key / session token are NOT returned to the caller — only the profile name, expiration, and assumed identity. Use for cross-account access: a source profile (your SSO identity) assumes a role in another account.",
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
      };
      const sourceProfile = i.sourceProfile || getProfile();
      const useRegion = i.region || getRegion();
      const targetProfile = resolveTargetProfile({ targetProfile: i.targetProfile, sessionName: i.sessionName });

      try {
        const client = new STSClient({
          region: useRegion,
          credentials: fromNodeProviderChain({ profile: sourceProfile }),
        });
        const result = await client.send(
          new AssumeRoleCommand({
            RoleArn: i.roleArn,
            RoleSessionName: i.sessionName,
            DurationSeconds: i.durationSeconds ?? 3600,
            ExternalId: i.externalId,
          }),
        );
        const creds = result.Credentials;
        if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
          return { ok: false, error: "STS AssumeRole succeeded but returned incomplete credentials." };
        }

        const credentialsPath = join(homedir(), ".aws", "credentials");
        upsertProfile(credentialsPath, targetProfile, {
          aws_access_key_id: creds.AccessKeyId,
          aws_secret_access_key: creds.SecretAccessKey,
          aws_session_token: creds.SessionToken,
        });

        return {
          ok: true,
          data: {
            profile: targetProfile,
            credentialsPath,
            expiration: creds.Expiration?.toISOString(),
            assumedRoleArn: result.AssumedRoleUser?.Arn,
            assumedRoleId: result.AssumedRoleUser?.AssumedRoleId,
            sourceProfile,
            hint: `Pass profile='${targetProfile}' to subsequent aws_call / aws_whoami / aws_paginate calls to use these credentials. They expire at ${creds.Expiration?.toISOString() ?? "unknown"}.`,
          },
        };
      } catch (err) {
        const classified = classifyAuthError(err);
        if (classified.kind === "sso_expired") {
          return {
            ok: false,
            error: `SSO session expired for source profile '${sourceProfile}'. Call aws_login_start with profile='${sourceProfile}' before assuming.`,
          };
        }
        return { ok: false, error: classified.message };
      }
    },
  },
];
