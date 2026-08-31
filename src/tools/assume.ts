import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runAwsCall, truncateForErrorMsg } from "../aws-cli.js";
import { upsertProfile } from "../aws-credentials.js";
import { getProfile, getRegion, isValidProfileName } from "../session.js";
import type { Tool, ToolContext, ToolResult } from "./tool.js";

/**
 * Pick a target profile name. We prefix user-chosen names with 'mcp-' to
 * make it obvious which profiles this tool writes, and to keep an unprefixed
 * name (`prod`, `default`) from being written over by accident.
 *
 * The prefix is a NAMING convention, not a collision guard: nothing stops a
 * user from having their own `mcp-*` profile, and mergeProfileBody overwrites
 * the three managed keys in place when the target section already exists. The
 * handler surfaces a `warning` in that case rather than pretending it can't
 * happen.
 */
function resolveTargetProfile(input: { targetProfile?: string; sessionName: string }): string {
  if (input.targetProfile) {
    return input.targetProfile.startsWith("mcp-") ? input.targetProfile : `mcp-${input.targetProfile}`;
  }
  // Apply the same no-double-prefix guard for the sessionName fallback: a
  // sessionName of 'mcp-session' must yield 'mcp-session', not 'mcp-mcp-session'.
  return input.sessionName.startsWith("mcp-") ? input.sessionName : `mcp-${input.sessionName}`;
}

/**
 * Where to write the assumed-role profile.
 *
 * botocore resolves the shared credentials file from AWS_SHARED_CREDENTIALS_FILE
 * (expanding a leading `~`) before falling back to ~/.aws/credentials. Honoring
 * it here keeps our write and the CLI's later read pointed at the same file: a
 * user who had it set was previously handed a profile written where the CLI
 * never looks, so the returned hint named a profile that did not exist from the
 * CLI's point of view. It is also the remedy the EACCES message below suggests
 * -- ignoring the variable made that advice a no-op.
 */
function resolveCredentialsPath(): string {
  const fromEnv = process.env.AWS_SHARED_CREDENTIALS_FILE?.trim();
  if (!fromEnv) return join(homedir(), ".aws", "credentials");
  // Mirror botocore's expanduser() so `~/creds` means <home>/creds rather than
  // a literal `~` directory next to the cwd.
  if (fromEnv === "~") return homedir();
  if (fromEnv.startsWith("~/") || fromEnv.startsWith("~\\")) return join(homedir(), fromEnv.slice(2));
  return fromEnv;
}

/**
 * The raw diagnostic to quote after "Underlying error:" when this tool
 * REPLACES runAwsCall's message with a source-profile-specific one.
 *
 * Deliberately the stderr, not `result.error`. runAwsCall's auth-class messages
 * are themselves "<remedy>. Underlying error: <stderr>", so quoting the whole
 * thing nested a SECOND remedy inside ours -- and a differently scoped one: the
 * arms below are about the SOURCE profile, while runAwsCall names whichever
 * profile the CLI was invoked with. A caller reading "refresh the source
 * profile ... Underlying error: ... call aws_login_start with profile='X'" gets
 * two instructions naming two profiles for one failure.
 *
 * stdout is never used here, unlike rawBodyOf in resource.ts: `aws sts
 * assume-role` writes the credential blob to stdout, and it may flush a partial
 * one before failing, so stdout must not reach an error envelope.
 */
function underlyingOf(result: { rawStderr?: string; error: string }): string {
  const stderr = result.rawStderr?.trim();
  // No stderr should not happen on the auth-class kinds (they are classified BY
  // matching stderr), but falling back to the summary beats an empty clause.
  return stderr ? truncateForErrorMsg(stderr) : result.error;
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
      "Call STS AssumeRole and stash the returned temporary credentials as a named profile in the shared credentials file ($AWS_SHARED_CREDENTIALS_FILE when set, otherwise ~/.aws/credentials; the resolved path is returned as credentialsPath). Subsequent calls to aws_call / aws_whoami / aws_paginate can use profile='mcp-<sessionName>' (or your overridden targetProfile name). The raw secret key / session token are NOT returned to the caller — only the profile name, expiration, and assumed identity. Use for cross-account access: a source profile (your SSO identity) assumes a role in another account. Default timeout is 120s (raise via timeoutMs for slow SAML / credential_process setups on cold start).",
    annotations: {
      title: "Assume an IAM role and stash creds as a profile",
      // Writes the shared credentials file, overwriting the three managed keys
      // in place when the target section already exists -- the handler returns
      // a `warning` for exactly that case, so the stomp is acknowledged rather
      // than hypothetical. That is a destructive update to a file the user owns
      // and other tooling reads, so the hint says so. Same reasoning applied to
      // aws_call / aws_multi_region / aws_resource_update in v2.0.1.
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      roleArn: z
        .string()
        .regex(
          /^arn:aws[a-z-]*:iam::[0-9]{12}:role\/.+$/,
          "roleArn must match arn:aws[partition]:iam::<12-digit-account>:role/<name>",
        )
        .describe("Target role ARN, e.g. 'arn:aws:iam::123456789012:role/CrossAccountAdmin'."),
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
    handler: async (input: unknown, ctx?: ToolContext): Promise<ToolResult> => {
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
      // Validate sourceProfile up front so the error names sourceProfile
      // explicitly. Without this, an invalid sourceProfile would still get
      // caught inside runAwsCall, but the resulting message would say
      // "Check the 'profile' arg or AWS_PROFILE env var" -- confusing for
      // an aws_assume_role caller who passed `sourceProfile`.
      if (!isValidProfileName(sourceProfile)) {
        return {
          ok: false,
          error: `Invalid sourceProfile name '${sourceProfile}'. Must be 1-128 chars from [A-Za-z0-9_+=,.@:-]; the first char must be a letter, digit, or one of _+,.@: (not '-' or '='). Check the 'sourceProfile' arg or AWS_PROFILE env var.`,
        };
      }
      // The resolved name lands as a `[name]` section header in the shared
      // credentials file. Reject INI-breakers (brackets, newlines, `=`) up
      // front so a hostile or fat-fingered targetProfile can't corrupt the
      // credentials file. useRegion is validated inside runAwsCall via
      // isValidRegionName; this guards the remaining write path that
      // doesn't pass through runAwsCall.
      if (!isValidProfileName(targetProfile)) {
        return {
          ok: false,
          error: `Invalid targetProfile name '${targetProfile}'. Must be 1-128 chars from [A-Za-z0-9_+=,.@:-]; the first char must be a letter, digit, or one of _+,.@: (not '-' or '='). Pick a different targetProfile or sessionName.`,
        };
      }
      // Defense-in-depth ARN check: the schema regex already rejects obvious
      // bad inputs, but the handler re-validates so that callers bypassing
      // schema parsing (e.g. direct handler calls in tests or internal callers)
      // get a clear error instead of a confusing CLI failure. Mirrors the
      // isValidProfileName checks above. The regex is the same pattern used in
      // the schema; keeping it in one place as a named constant would require
      // exporting it -- duplicating a 30-char literal is the lower-friction
      // choice given the "no new exports for trivial helpers" convention here.
      if (!/^arn:aws[a-z-]*:iam::[0-9]{12}:role\/.+$/.test(i.roleArn)) {
        return {
          ok: false,
          error: `Invalid roleArn '${i.roleArn}'. Must match arn:aws[partition]:iam::<12-digit-account>:role/<name>, e.g. 'arn:aws:iam::123456789012:role/CrossAccountAdmin'.`,
        };
      }

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

      const timeoutMs = i.timeoutMs ?? 120_000;
      // ONE report, and only one. The work here is a single STS round-trip
      // that either returns or times out -- there is no second step to
      // observe, so any "step 2 of 3" would be invented. What the caller
      // genuinely gains is the difference between "hung" and "waiting on a
      // slow IdP for up to N seconds", which this one line says.
      //
      // No `total`: with a single indivisible call there is no honest
      // denominator (1/1 would claim completion before the call returns), and
      // the spec permits progress without one.
      ctx?.reportProgress(
        0,
        undefined,
        `Calling sts:AssumeRole for ${i.roleArn} as source profile '${sourceProfile}' (timeout ${Math.round(timeoutMs / 1000)}s)`,
      );

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
        // Resolved above so the progress message quotes the same number.
        timeoutMs,
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
        // expired_creds reaches here when the SOURCE profile is itself a
        // temporary session (role chaining, or a profile fed by an earlier
        // assume). runAwsCall's message already names both remedies and keeps
        // the underlying stderr; this arm exists only to name the source
        // profile, which the CLI's stderr does not reliably identify.
        if (result.kind === "expired_creds") {
          return {
            ok: false,
            error: `Temporary credentials for source profile '${sourceProfile}' have expired. Refresh that profile (aws_login_start if it is SSO-backed, otherwise re-run its assume) before assuming. Underlying error: ${underlyingOf(result)}`,
          };
        }
        // invalid_creds is NOT an expiry and NOT a missing profile: the source
        // profile's credentials resolved and STS REJECTED them (a rotated or
        // deleted access key, a key for the wrong partition, or a drifted
        // clock breaking SigV4). Refreshing a session cannot fix that, so this
        // arm must not say "re-authenticate" the way the two above do, nor
        // "no credentials found" -- the remedy is to fix the credentials that
        // profile resolves to. Like its siblings, this arm exists only to name
        // the SOURCE profile, which the CLI's stderr does not reliably do.
        if (result.kind === "invalid_creds") {
          return {
            ok: false,
            error: `Credentials for source profile '${sourceProfile}' were rejected by AWS (they resolved, but the service refused them -- a rotated or deleted access key, the wrong partition/account, or a drifted machine clock). Fix the credentials for that profile before assuming. Underlying error: ${underlyingOf(result)}`,
          };
        }
        // `aws sts assume-role --output json` writes the credential blob to
        // STDOUT on success. On a non-zero exit the CLI still may have flushed
        // a partial JSON fragment to stdout before failing; surfacing it as
        // rawBody risks leaking secret material into error envelopes. Stick
        // to stderr for this op specifically; if stderr is empty the upstream
        // error string ("aws CLI exited with code X and no stderr") already
        // carries enough signal for the caller.
        return { ok: false, error: result.error, rawBody: result.rawStderr };
      }

      const data = (result.data ?? {}) as AssumeRoleCliResponse;
      const creds = data.Credentials;
      if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
        return { ok: false, error: "STS AssumeRole succeeded but returned incomplete credentials." };
      }

      const credentialsPath = resolveCredentialsPath();
      let existed = false;
      try {
        ({ existed } = await upsertProfile(credentialsPath, targetProfile, {
          aws_access_key_id: creds.AccessKeyId,
          aws_secret_access_key: creds.SecretAccessKey,
          aws_session_token: creds.SessionToken,
        }));
      } catch (err) {
        // acquireLock / openSync inside upsertProfile can throw a raw NodeJS
        // ErrnoException when the credentials parent is read-only (EACCES /
        // EROFS / EPERM). Surfacing the raw errno names the `.lock` sidecar
        // instead of the credentials file and gives the caller no actionable
        // hint. Translate the permission-class errnos to a friendly ToolResult;
        // any other error propagates unchanged so the existing thrown-error
        // path is preserved.
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "EROFS" || code === "EPERM") {
          const hint = process.env.AWS_SHARED_CREDENTIALS_FILE?.trim()
            ? "That path comes from AWS_SHARED_CREDENTIALS_FILE -- point it at a writable file, or unset it to fall back to ~/.aws/credentials."
            : "Check directory permissions, or set AWS_SHARED_CREDENTIALS_FILE to a writable path.";
          return {
            ok: false,
            error: `Cannot write ${credentialsPath} (permission denied). ${hint}`,
          };
        }
        throw err;
      }

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
          // Only present when we overwrote a section that was already there.
          // The 'mcp-' prefix makes collisions unlikely, not impossible -- the
          // user may keep their own mcp-* profile, or re-assume into the same
          // sessionName -- and the three managed keys are replaced in place
          // either way.
          ...(existed
            ? {
                warning: `Profile '${targetProfile}' already existed in ${credentialsPath}; its aws_access_key_id, aws_secret_access_key and aws_session_token were overwritten. Other keys in that section (region, output, ...) were left as-is.`,
              }
            : {}),
          hint: `Pass profile='${targetProfile}' to subsequent aws_call / aws_whoami / aws_paginate calls to use these credentials. They expire at ${expiration ?? "unknown"}.`,
        },
      };
    },
  },
];
