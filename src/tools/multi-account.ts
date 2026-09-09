import { z } from "zod";
import { runAwsCall, truncateForErrorMsg } from "../aws-cli.js";
import { getProfile, getRegion, invalidRegionMessage, isValidProfileName, isValidRegionName } from "../session.js";
import { type AssumedRoleCredentials, assumeRoleCredentials, DEFAULT_ASSUME_TIMEOUT_MS } from "./assume.js";
import { type CappableResult, capAggregateResults, runWithConcurrency } from "./multi-region.js";
import type { Tool, ToolContext, ToolResult } from "./tool.js";

/**
 * aws_multi_account runs the same AWS operation across N accounts in parallel,
 * assuming the same role name in each.
 *
 * This is the multi-region fan-out moved onto the axis operators actually
 * organize by. It is NOT new reach: everything here is what you would get by
 * calling aws_assume_role in a loop and then aws_call once per account. What it
 * removes is the loop's worst property.
 *
 * aws_assume_role derives the profile NAME from `sessionName` and writes it into
 * the shared credentials file. Fan a sweep out over 40 accounts through it and
 * you either write 40 sections into a file the user's other tooling reads, or --
 * with one sessionName -- overwrite one profile 40 times, which is the case the
 * handler already returns a `warning` for. Either way a script that times out
 * halfway through leaves live credentials on disk for accounts the operator has
 * since moved on from, with no step that cleans them up.
 *
 * So this tool never touches the credentials file. Each account's session is
 * held in memory and handed to exactly one subprocess through its environment
 * (see credentialEnv below); when that process exits, the credentials are gone.
 * A batch killed mid-sweep leaves nothing behind. That is a correctness
 * property, not a convenience -- which is why it is asserted in the tests rather
 * than only described here.
 *
 * Honest positioning: an org that has already set up a Config aggregator, or
 * Resource Explorer, or a CloudTrail Lake data store, can answer some
 * cross-account inventory questions faster and cheaper than N AssumeRole calls.
 * This tool's claim is narrower -- ARBITRARY API operation, no setup, one call.
 *
 * Deliberately deferred, each a cheap additive follow-on rather than a design
 * gap:
 *   - `discoverFrom: 'organizations'` (list the accounts instead of being handed
 *     them). organizations:ListAccounts AccessDenies from a workload account,
 *     which is where most operators run this from, so shipping it as the
 *     headline path would fail for the majority.
 *   - `ouId`, to scope such a discovery to one organizational unit.
 *   - `regions[]`, for the accounts x regions cross-product. MAX_TOTAL_TASKS
 *     below is where that would be bounded.
 *   - `externalId` / `durationSeconds` pass-through to the assume, for
 *     third-party roles and long-running operations.
 */

const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 32;
const MAX_ACCOUNTS = 32;

// Ceiling on the number of dispatched units of work, checked after dedup.
//
// Today one account is one task, so with MAX_ACCOUNTS above this cannot fire --
// and it is here anyway, as the single place the fan-out WIDTH is bounded. The
// deferred accounts x regions cross-product multiplies the task count without
// changing the account count, and when it lands it needs a ceiling that already
// exists rather than one invented at that point (and applied, at that point, to
// a handler that had been unbounded). Kept as a real runtime check rather than a
// comment because handler-level guards are the only ones a direct, non-MCP
// caller passes through at all.
const MAX_TOTAL_TASKS = 32;

// Same aggregate budget aws_multi_region enforces, for the same reason: a single
// call's stdout is capped at 5 MB in aws-cli.ts, but 32 of them summed into one
// MCP response is not. Entries past the budget keep their status and lose their
// `data` -- dropped whole, never string-truncated, which would emit unparseable
// JSON.
const MAX_TOTAL_RESULT_BYTES = 5 * 1024 * 1024;

// AWS account IDs are exactly 12 digits. Validated per-account rather than in
// the schema alone so a direct handler caller gets the same per-account error
// the MCP boundary would have produced -- and so one malformed entry fails only
// itself instead of the batch.
const ACCOUNT_ID_RE = /^[0-9]{12}$/;

// IAM role name, optionally preceded by a path. AWS allows [\w+=,.@-]{1,64} for
// the name and a slash-delimited path in front of it; a role created at
// /engineering/ has ARN .../role/engineering/Auditor, so the slashes have to
// survive. The value lands inside --cli-input-json (never argv), so this is
// about building an ARN AWS will accept rather than argv safety. 512 is IAM's
// combined path+name limit.
const ROLE_NAME_RE = /^[\w+=,.@-]+(?:\/[\w+=,.@-]+)*$/;
const MAX_ROLE_NAME_LENGTH = 512;

// Shows up in CloudTrail in every target account, so it should say what did the
// assuming. Same charset the aws_assume_role schema enforces for sessionName.
const DEFAULT_SESSION_NAME = "aws-mcp-multi-account";
const SESSION_NAME_RE = /^[\w+=,.@-]{2,64}$/;

// Failure kinds that mean "the identity was not accepted". runAwsCall words
// these to name a PROFILE; see rewriteCredentialError for why that has to be
// replaced here rather than forwarded.
const CREDENTIAL_CLASS_KINDS: ReadonlySet<string> = new Set([
  "sso_expired",
  "expired_creds",
  "invalid_creds",
  "no_creds",
]);

const REDACTION_STUB = "<redacted assumed-role credential>";

/**
 * Per-account result. Mirrors RegionResult field for field with `accountId`
 * where that has `region`, so an operator who has read one tool's output can
 * read this one without learning a second envelope.
 *
 * Note what is NOT here: `rawBody`. aws_call forwards raw stderr/stdout on
 * failure, which is a reasonable trade when the caller owns the credentials the
 * call ran under. Here the call ran under credentials this tool minted, and a
 * raw body is the least predictable of the three text surfaces, so it is not
 * carried at all.
 */
export interface AccountResult extends CappableResult {
  accountId: string;
}

/**
 * Remove any occurrence of this account's minted credentials from a string
 * bound for the response.
 *
 * Defense in depth on top of a structural argument, not a substitute for it: the
 * credentials go to the child through its ENVIRONMENT, never argv, so
 * runAwsCall's `command` (built from argv, with --cli-input-json already
 * redacted) cannot contain them, and the AWS CLI does not print its resolved
 * credentials to stderr. Both of those are properties of code that can change.
 * Scrubbing the two strings this tool actually returns makes the invariant
 * enforced rather than argued, and gives the test something to assert against a
 * subprocess that deliberately tries to leak.
 *
 * All three values are scrubbed, including the access key ID. It is the less
 * secret half of the pair, but it identifies the session and there is no reader
 * of this envelope who needs it.
 *
 * split/join rather than a RegExp: credential material is arbitrary base64-ish
 * text containing `+` and `/`, and building a pattern out of it would need
 * escaping that is easy to get subtly wrong.
 */
function redactSecrets(text: string, creds: AssumedRoleCredentials): string {
  let out = text;
  for (const secret of [creds.sessionToken, creds.secretAccessKey, creds.accessKeyId]) {
    if (secret.length === 0) continue;
    out = out.split(secret).join(REDACTION_STUB);
  }
  return out;
}

/**
 * Build the environment for one account's operation subprocess.
 *
 * node's spawn REPLACES the child environment rather than merging, so this
 * starts from the parent's: the CLI needs PATH, HOME/USERPROFILE, any proxy or
 * AWS_CA_BUNDLE settings, and (under test) the AWS_MCP_TEST_* hooks.
 *
 * The deletions are the non-obvious part. Setting the three standard credential
 * variables is not by itself enough, because botocore's environment provider
 * reads several ALIASES and takes the first one present:
 *   - AWS_SECURITY_TOKEN is the legacy spelling of AWS_SESSION_TOKEN and is
 *     consulted ahead of it. A stale one inherited from the operator's shell
 *     would pair this account's access key with somebody else's token, and the
 *     resulting failure ("security token is invalid") points nowhere near the
 *     cause.
 *   - AWS_CREDENTIAL_EXPIRATION, if present, tells botocore when the
 *     environment credentials expire. A stale value makes freshly minted
 *     credentials look already-expired.
 *   - AWS_PROFILE / AWS_DEFAULT_PROFILE do not actually override environment
 *     credentials (only the CLI's `--profile` FLAG does that, which is what
 *     omitProfile suppresses), but an inherited SSO-backed profile name would
 *     still have the CLI resolving a token it has no reason to touch, and a
 *     child carrying a profile it must not use is a trap for the next reader.
 */
function credentialEnv(creds: AssumedRoleCredentials): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.AWS_ACCESS_KEY_ID = creds.accessKeyId;
  env.AWS_SECRET_ACCESS_KEY = creds.secretAccessKey;
  env.AWS_SESSION_TOKEN = creds.sessionToken;
  delete env.AWS_SECURITY_TOKEN;
  delete env.AWS_CREDENTIAL_EXPIRATION;
  delete env.AWS_PROFILE;
  delete env.AWS_DEFAULT_PROFILE;
  return env;
}

/**
 * Replace runAwsCall's identity-rejection messages for the per-account
 * operation call.
 *
 * Those messages all read "... for profile 'X' ...", where X is whatever
 * runAwsCall resolved from the session or the environment. This tool passes
 * `omitProfile: true`, so no profile reached argv and none was used -- the call
 * ran on the temporary session minted for this account. Forwarding the message
 * unchanged would tell the operator to go re-authenticate a profile that had
 * nothing to do with the failure, which is the same defect aws_assume_role
 * rewrites its own source-profile messages to avoid (tools/assume.ts).
 *
 * One arm for all four kinds rather than four bespoke remedies: with credentials
 * supplied directly there is no session to refresh and no profile to fix, so any
 * per-kind advice would be invented. Naming the account, naming the role, and
 * quoting the CLI's own diagnostic is the whole of what is honestly known.
 */
function rewriteCredentialError(
  kind: string,
  roleArn: string,
  accountId: string,
  result: { error: string; rawStderr?: string },
): string {
  const underlying = result.rawStderr?.trim() ? truncateForErrorMsg(result.rawStderr.trim()) : result.error;
  return `AWS did not accept the credentials for account ${accountId} (${kind}). The operation ran on the temporary session assumed via ${roleArn}, with no profile involved -- if the diagnostic below names a profile, that is the CLI's own default resolution talking and not the identity that failed. Underlying error: ${underlying}`;
}

export const multiAccountTools: readonly Tool[] = [
  {
    name: "aws_multi_account",
    description:
      "Run the same AWS API operation across multiple ACCOUNTS in parallel by assuming the same role name in each. Same shape as aws_call (service, operation, params?, query?, outputFormat?, region?, timeoutMs?) plus `accounts: string[]` of 12-digit account IDs and `roleName`. This is fan-out in one call, not new access: it is exactly what aws_assume_role in a loop would reach, minus the credentials-file churn -- each account's session is held in memory for the one subprocess that uses it and is NEVER written to ~/.aws/credentials, so a sweep that dies halfway leaves nothing on disk. If your org already runs a Config aggregator or Resource Explorer, those answer indexed inventory questions with less work; reach for this when you want an arbitrary API operation across accounts with no setup. Returns an array of `{accountId, ok, data?, command?, error?, errorKind?}` -- partial failure is expected and normal (the role may not exist in every account, trust policies differ, services vary). Duplicate account IDs collapse (first occurrence wins), so use the returned `accountCount`. The batch is capped at 5 MB of results: past that, entries keep their status but lose `data` and are flagged `truncated: true`, with the affected accounts listed in a top-level `truncatedAccounts`.",
    annotations: {
      title: "Run an AWS operation across multiple accounts in parallel",
      // Same reasoning as aws_call and aws_multi_region, and further still: the
      // operation is a free string this server cannot introspect, and it runs in
      // up to 32 accounts at once under an assumed role. destructiveHint MUST
      // stay true -- per the MCP spec `false` positively asserts "performs only
      // additive updates", which is a claim no arbitrary-operation tool can
      // make, and hosts gate their confirmation prompt on it. A caller who wants
      // a read-only-annotated tool should reach for aws_paginate.
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      service: z.string().describe("AWS service in kebab-case: 's3api', 'ec2', 'iam', etc."),
      operation: z
        .string()
        .describe("Operation in kebab-case: 'describe-instances', 'get-caller-identity', 'list-buckets', etc."),
      accounts: z
        .array(z.string().min(1))
        .min(1)
        .max(MAX_ACCOUNTS)
        .describe(
          `Target AWS account IDs, 12 digits each (e.g. ['111111111111','222222222222']). 1-${MAX_ACCOUNTS}. A malformed ID fails only its own entry and does not spawn a CLI call.`,
        ),
      roleName: z
        .string()
        .min(1)
        .max(MAX_ROLE_NAME_LENGTH)
        .describe(
          "Name of the role to assume in EVERY target account (e.g. 'OrganizationAccountAccessRole', 'ReadOnlyAuditor'). Combined with each account ID into arn:aws:iam::<account>:role/<roleName>. Include the IAM path if the role has one ('engineering/Auditor').",
        ),
      params: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Operation parameters (PascalCase keys) -- same shape as aws_call."),
      query: z.string().optional().describe("JMESPath expression for --query (server-side trimming per account)."),
      outputFormat: z.enum(["json", "text", "table", "yaml"]).optional().describe("Output format. Default 'json'."),
      region: z
        .string()
        .optional()
        .describe("Region for BOTH the sts:AssumeRole call and the operation. Defaults to the session region."),
      profile: z
        .string()
        .optional()
        .describe(
          "Profile to assume FROM -- your own identity, used for every sts:AssumeRole in the batch. Defaults to the session profile / $AWS_PROFILE. The target accounts never use a profile at all.",
        ),
      sessionName: z
        .string()
        .optional()
        .describe(
          `Role session name recorded in each target account's CloudTrail. Default '${DEFAULT_SESSION_NAME}'. Alphanumeric + +=,.@- only, 2-64 chars.`,
        ),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          `Timeout in ms applied PER aws CLI spawn. Each account makes two: the sts:AssumeRole and the operation. Unset, the assume gets ${DEFAULT_ASSUME_TIMEOUT_MS} ms (headroom for cold-start SAML / credential_process) and the operation gets the standard 60000 ms; setting this applies one value to both.`,
        ),
      concurrency: z
        .number()
        .int()
        .positive()
        .max(MAX_CONCURRENCY)
        .optional()
        .describe(`Max accounts in flight at once (1-${MAX_CONCURRENCY}). Default ${DEFAULT_CONCURRENCY}.`),
    }),
    handler: async (input: unknown, ctx?: ToolContext): Promise<ToolResult> => {
      const i = input as {
        service: string;
        operation: string;
        accounts: string[];
        roleName: string;
        params?: Record<string, unknown>;
        query?: string;
        outputFormat?: "json" | "text" | "table" | "yaml";
        region?: string;
        profile?: string;
        sessionName?: string;
        timeoutMs?: number;
        concurrency?: number;
      };

      // Defense-in-depth handler-level clamps, matching aws_multi_region: the
      // schema bounds `accounts` and `concurrency`, but callers that reach the
      // handler directly (the aws_script bridge, tests, future internal
      // callers) never see those bounds.
      //
      // Bound the RAW list BEFORE the dedup below, for the same two reasons
      // aws_multi_region does: checking the deduped count would make this
      // handler accept input the MCP boundary rejects (40 entries with 10
      // duplicates is 30 distinct), so one call would succeed or fail depending
      // on which entry point it came through -- and the dedup loop allocates
      // proportional to the input, so guarding after it does the unbounded work
      // first. Reject rather than truncate: silently dropping accounts the
      // caller asked about is worse than an explicit error.
      if (i.accounts.length > MAX_ACCOUNTS) {
        return {
          ok: false,
          error: `Too many accounts: ${i.accounts.length} requested, max ${MAX_ACCOUNTS}. Split the batch.`,
        };
      }

      // De-dupe preserving first occurrence, so result order is the dedup'd
      // input order.
      const seen = new Set<string>();
      const accounts: string[] = [];
      for (const a of i.accounts) {
        if (!seen.has(a)) {
          seen.add(a);
          accounts.push(a);
        }
      }

      if (accounts.length > MAX_TOTAL_TASKS) {
        return {
          ok: false,
          error: `Too many tasks: ${accounts.length} account-operations requested, max ${MAX_TOTAL_TASKS}. Split the batch.`,
        };
      }

      const roleName = i.roleName;
      if (roleName.length > MAX_ROLE_NAME_LENGTH || !ROLE_NAME_RE.test(roleName)) {
        return {
          ok: false,
          error: `Invalid roleName '${roleName}'. Must be 1-${MAX_ROLE_NAME_LENGTH} chars from [A-Za-z0-9_+=,.@-], optionally with '/'-separated IAM path segments (e.g. 'ReadOnlyAuditor' or 'engineering/Auditor').`,
        };
      }

      const sessionName = i.sessionName ?? DEFAULT_SESSION_NAME;
      if (!SESSION_NAME_RE.test(sessionName)) {
        return {
          ok: false,
          error: `Invalid sessionName '${sessionName}'. Must be 2-64 chars from [A-Za-z0-9_+=,.@-]; it is recorded in each target account's CloudTrail.`,
        };
      }

      // Validated here so the error names the argument the caller passed rather
      // than surfacing runAwsCall's generic "check the 'profile' arg or
      // AWS_PROFILE env var" once per account, N times over. Same reasoning as
      // the sourceProfile check in aws_assume_role.
      const sourceProfile = i.profile || getProfile();
      if (!isValidProfileName(sourceProfile)) {
        return {
          ok: false,
          error: `Invalid profile name '${sourceProfile}'. Must be 1-128 chars from [A-Za-z0-9_+=,.@:-]; the first char must be a letter, digit, or one of _+,.@: (not '-' or '='). Check the 'profile' arg or AWS_PROFILE env var.`,
        };
      }

      // Region is checked once up front instead of per account: unlike an
      // account ID it is a single value shared by the whole batch, so a bad one
      // is a batch-level input error, and letting it fail N identical times
      // would report a fleet-wide outage where there is a typo.
      const region = i.region || getRegion();
      if (!isValidRegionName(region)) {
        return {
          ok: false,
          error: invalidRegionMessage(region, "Check the 'region' arg or AWS_REGION / AWS_DEFAULT_REGION env var."),
        };
      }

      const requestedConcurrency = Number(i.concurrency ?? DEFAULT_CONCURRENCY);
      const concurrency = Number.isFinite(requestedConcurrency)
        ? Math.min(Math.max(1, Math.trunc(requestedConcurrency)), MAX_CONCURRENCY)
        : DEFAULT_CONCURRENCY;

      // Progress denominator: the DEDUPED account count, which is what actually
      // gets dispatched and what `accountCount` reports below.
      const total = accounts.length;
      let completed = 0;

      const runAccount = async (accountId: string): Promise<AccountResult> => {
        try {
          if (!ACCOUNT_ID_RE.test(accountId)) {
            return {
              accountId,
              ok: false,
              error: `Invalid account ID '${accountId}'. An AWS account ID is exactly 12 digits.`,
              errorKind: "bad_input",
            };
          }
          const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;

          const assumed = await assumeRoleCredentials({
            roleArn,
            sessionName,
            sourceProfile,
            region,
            ...(i.timeoutMs !== undefined ? { timeoutMs: i.timeoutMs } : {}),
          });
          if (!assumed.ok) {
            // The assume failed, so there are no credentials to redact against
            // and none were ever minted. assumeRoleCredentials already declines
            // to surface assume-role stdout for exactly this reason (a partial
            // credential blob can be flushed before a non-zero exit), so its
            // `error` is stderr-derived; `failure.rawBody` is deliberately not
            // carried into the per-account entry.
            return {
              accountId,
              ok: false,
              error: `Could not assume ${roleArn}: ${assumed.failure.error ?? "sts:AssumeRole failed with no error message."}`,
              ...(assumed.failure.errorKind !== undefined ? { errorKind: assumed.failure.errorKind } : {}),
            };
          }
          const creds = assumed.credentials;

          const r = await runAwsCall({
            service: i.service,
            operation: i.operation,
            params: i.params,
            query: i.query,
            region,
            outputFormat: i.outputFormat,
            timeoutMs: i.timeoutMs,
            // The two halves of the whole point of this tool. `env` carries the
            // credentials to exactly this subprocess and nowhere else;
            // `omitProfile` keeps `--profile` off argv, without which botocore
            // discards the environment provider and the call would silently run
            // as the OPERATOR's identity in every account. See
            // AwsCallOptions.omitProfile.
            env: credentialEnv(creds),
            omitProfile: true,
          });

          if (!r.ok) {
            const message = CREDENTIAL_CLASS_KINDS.has(r.kind)
              ? rewriteCredentialError(r.kind, roleArn, accountId, r)
              : r.error;
            return {
              accountId,
              ok: false,
              ...(r.command !== undefined ? { command: redactSecrets(r.command, creds) } : {}),
              error: redactSecrets(message, creds),
              errorKind: r.kind,
            };
          }
          // `data` is the operation's own response body and is passed through
          // unmodified. It is not a surface these credentials reach -- no AWS
          // API echoes the credentials a request was signed with. An operation
          // that MINTS credentials (iam create-access-key, sts
          // get-session-token) returns the caller's own requested output, which
          // is not this tool's to scrub.
          return { accountId, ok: true, command: redactSecrets(r.command, creds), data: r.data };
        } catch (err) {
          return {
            accountId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            errorKind: "unexpected",
          };
        }
      };

      const results = await runWithConcurrency(
        accounts,
        concurrency,
        async (accountId): Promise<AccountResult> => {
          const result = await runAccount(accountId);
          // On COMPLETION, never on dispatch -- the limiter keeps only
          // `concurrency` accounts in flight, so counting at dispatch would race
          // ahead of what has settled and reach `total` with a window still
          // running. `completed++` needs no lock: the workers interleave at await
          // boundaries on one thread.
          completed++;
          try {
            ctx?.reportProgress(
              completed,
              total,
              `${accountId}: ${result.ok ? "ok" : "failed"} (${completed}/${total})`,
            );
          } catch {
            // Progress is advisory, and runWithConcurrency's contract is that
            // `fn` MUST resolve -- a throw here would abandon every other
            // in-flight account over a notification.
          }
          return result;
        },
        {
          signal: ctx?.signal,
          // Same contract as aws_multi_region: accounts already swept keep their
          // results, accounts never claimed are represented rather than dropped.
          // It matters more here -- these entries never reached sts:AssumeRole, so
          // no credential was minted for them and there is nothing to redact.
          onCancelled: (accountId: string): AccountResult => ({
            accountId,
            ok: false,
            error:
              "Not attempted: the client cancelled the request before this account was started. No role was assumed and nothing was sent to AWS for it -- re-run to include it.",
            errorKind: "cancelled",
          }),
        },
      );

      // Counted BEFORE the aggregate cap runs: okCount/errorCount describe what
      // the CALLS did, which is unchanged by whether a payload fit the budget.
      const okCount = results.filter((r) => r.ok).length;
      const errCount = results.length - okCount;
      const capped = capAggregateResults(results, MAX_TOTAL_RESULT_BYTES, (r) => r.accountId);

      return {
        ok: true,
        data: {
          service: i.service,
          operation: i.operation,
          roleName,
          accountCount: accounts.length,
          okCount,
          errorCount: errCount,
          ...(capped.truncatedIds.length > 0
            ? {
                truncated: true,
                truncatedAccounts: capped.truncatedIds,
                maxTotalResultBytes: MAX_TOTAL_RESULT_BYTES,
              }
            : {}),
          results: capped.results,
        },
      };
    },
  },
];
