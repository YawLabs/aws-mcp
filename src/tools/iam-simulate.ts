import { z } from "zod";
import { runAwsCall } from "../aws-cli.js";
import type { Tool, ToolResult } from "./tool.js";

/**
 * aws_iam_simulate wraps IAM Policy Simulator (SimulatePrincipalPolicy) so the
 * agent can answer "can principal X do Y on Z?" BEFORE attempting the
 * operation. Pairs naturally with the structured-error suggestions on
 * aws_call: after a 403 you get "Check IAM permissions for lambda:CreateFunction";
 * before risking the call you ask aws_iam_simulate the same question and get
 * the same answer with the IAM statement that decided it.
 *
 * Maps to `aws iam simulate-principal-policy`. The response is flattened to ONE
 * ROW PER (action, resource) -- {action, resource, decision,
 * matchedStatementIds, missingContextValues, organizationsDecision,
 * permissionsBoundaryDecision} -- and the raw EvaluationResults array is NOT
 * echoed back alongside it; returning both doubled the payload of every
 * response.
 *
 * Those rows come from each EvaluationResult's ResourceSpecificResults, because
 * the top-level fields no longer answer per resource. On 2026-07-30 IAM changed
 * SimulatePrincipalPolicy server-side, which affects every CLI version. The API
 * reference now says the simulator "returns a single EvaluationResult per
 * action, regardless of how many resource ARNs are provided", that the top-level
 * EvalDecision "reflects the most restrictive decision across all resources ...
 * To see the decision for each individual resource, use ResourceSpecificResults",
 * and that EvalResourceName is "The ARN template for the simulated resource type
 * (for example, arn:${Partition}:s3:::${BucketName}/${KeyName}) ... not a
 * specific customer-provided resource ARN". The same reference says the older
 * one-result-per-resource shape returned N results "each containing the same
 * aggregate decision" -- so ResourceSpecificResults is the right per-resource
 * source in BOTH shapes, and this is one code path with no version sniffing.
 * When AWS gives no per-resource breakdown at all, the action's own top-level
 * result becomes a single fallback row, so no action can drop out of `results`.
 *
 * That flattening is lossy, so be precise about what survives.
 *
 * Promoted per resource, off a ResourceSpecificResults entry: EvalResourceName
 * (as `resource`), EvalResourceDecision (as `decision`), MatchedStatements ids,
 * MissingContextValues, and the entry's own PermissionsBoundaryDecisionDetail /
 * OrganizationsDecisionDetail when it carries them. A '*' entry with no missing
 * keys of its own takes the top-level list, because the API reports the keys for
 * a '*' simulation there.
 *
 * Promoted per action: EvalActionName, plus the action-level Organizations /
 * permissions-boundary detail carried onto each resource row -- except that an
 * `allowed` row always reads "allowed", since an SCP or boundary deny cannot
 * coexist with an allow. AWS reports both details per ACTION, so on a
 * multi-resource call a row that is not allowed can carry a deny another
 * resource earned. The fallback row IS the action-level answer, so it reads the
 * top-level details verbatim. A fallback row's `resource` is '*' when the call
 * named no resources (AWS applies ['*'] server-side) and AWS's own
 * EvalResourceName otherwise.
 *
 * NOT promoted, and no longer reachable from this tool: the MatchedStatements
 * BODIES. `matchedStatementIds` carries each match's SourcePolicyId (or a
 * synthesized `inline` / `inline#L<n>` id when it has none) and nothing else --
 * SourcePolicyType, StartPosition and EndPosition are dropped. Also dropped:
 * EvalDecisionDetails at both levels; once per-resource entries exist, the
 * top-level aggregate EvalDecision, MatchedStatements, MissingContextValues and
 * the ARN-template EvalResourceName; and any field AWS adds to EvaluationResult
 * in future. A caller that needs one of those has to go around this tool
 * (aws_call on iam simulate-principal-policy).
 *
 * IAM paginates this API (IsTruncated + Marker), but the CLI follows that itself
 * and prints the merged pages, so a FIRST call is always complete and `hasMore`
 * is false. Supplying a Marker inside --cli-input-json turns the CLI's
 * auto-pagination off and hands back that single raw page, IsTruncated and all.
 * So `hasMore` + `marker` are only ever non-trivial on a call that resumed from
 * `marker`. They are kept because they match the nextToken convention in
 * metrics.ts / paginate.ts / resource.ts, and they stay correct on a resume.
 * [verified against aws-cli/2.34.3 driving a 3-page local stub, 2026-09-19]
 *
 * Note: the caller (whoever's credentials this MCP server is using) needs
 * iam:SimulatePrincipalPolicy on the principal being simulated. The
 * structured-error parsing in aws-cli.ts already handles the AccessDenied
 * case if the caller lacks that permission.
 */

// ARN format: arn:<partition>:<service>:<region>:<account>:<resource>.
//   - partition: required, 1-32 chars (aws, aws-cn, aws-us-gov)
//   - service: required, 1-32 chars (an ARN without a service is malformed)
//   - region: optional (global services like IAM omit it)
//   - account: empty OR exactly 12 digits (AWS account IDs are always 12).
//     The previous {0,32} accepted any digit-count, so 3-digit "accounts"
//     and arbitrary-length runs passed -- AWS rejects them but the error
//     wasn't actionable.
//   - resource: required, no leading colon/whitespace, bounded length.
const ARN_RE = /^arn:[a-z0-9-]{1,32}:[a-z0-9-]{1,32}:[a-z0-9-]{0,32}:(?:[0-9]{12})?:[^:\s][^\s]{0,1024}$/;

// The STS session ARN an SSO or assume-role session holds. It passes ARN_RE --
// any service segment does -- but PolicySourceArn is "The ARN of a user, group,
// or role" (botocore's iam model), so IAM rejects it. aws_whoami returns exactly
// this shape for every SSO session, which makes it the ARN a caller reaches for
// first. Capture 1 is the ROLE NAME, which is what `iam get-role` takes.
// Scoped to assumed-role sessions; federated-user sessions are rare here.
const STS_ASSUMED_ROLE_RE = /^arn:[a-z0-9-]{1,32}:sts::[0-9]{12}:assumed-role\/([^/\s]+)\/\S+$/;

// IAM action format: `<service>:<Action>` -- service is lowercase
// kebab/alphanumeric; action is PascalCase or wildcard. Defensive but
// generous: lets through anything that looks structurally valid, AWS
// gives a clearer error for the rest.
const ACTION_RE = /^[a-z][a-z0-9-]{0,32}:[A-Za-z0-9*]{1,128}$/;

// Context entry types accepted by the IAM Policy Simulator. Same set the
// CLI accepts -- we mirror it as a Zod enum so a bad type fails fast in
// the schema rather than producing a confusing CLI error.
const CONTEXT_KEY_TYPES = [
  "string",
  "stringList",
  "numeric",
  "numericList",
  "boolean",
  "booleanList",
  "ip",
  "ipList",
  "binary",
  "binaryList",
  "date",
  "dateList",
] as const;

// PolicyEvaluationDecisionType is a closed enum in the IAM model, at both the
// action and the per-resource level. Anything else is a malformed response, and
// the README promises those count as `unknown` rather than as a deny.
const KNOWN_DECISIONS: ReadonlySet<string> = new Set(["allowed", "explicitDeny", "implicitDeny"]);

// Caps on the request shape. The evaluated result count is actions x
// resources, and every param travels in ONE argv entry (aws-cli.ts:317 pushes
// `--cli-input-json <json>` as a single argument). Linux caps a single argv
// entry at 128 KB and Windows caps the WHOLE command line at ~32 KB, so an
// unbounded resource list doesn't fail validation -- it fails as an opaque
// spawn error. MAX_RESOURCES mirrors the 50-entry actions cap; the byte guard
// below it covers the other axis, since one ARN may be up to 2048 chars.
const MAX_RESOURCES = 50;
const MAX_ARGV_JSON_CHARS = 24_000;

interface SimulationResult {
  action: string;
  resource: string;
  decision: string;
  matchedStatementIds?: string[];
  missingContextValues?: string[];
  organizationsDecision?: string;
  permissionsBoundaryDecision?: string;
}

interface ParseOptions {
  /**
   * True when the call named no resources, so AWS applied its own ['*']
   * server-side. A fallback row then reports `resource: "*"` instead of the
   * top-level EvalResourceName, which under the 2026-07-30 shape is an ARN
   * template rather than anything the caller asked about.
   */
  resourcesOmitted?: boolean;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function toDecision(v: unknown): string {
  return typeof v === "string" && KNOWN_DECISIONS.has(v) ? v : "unknown";
}

/**
 * Flatten a MatchedStatements[] array to the SourcePolicyIds callers read.
 * Used for both the action-level and the per-resource copy of the field.
 */
function statementIds(raw: unknown): string[] {
  const ids: string[] = [];
  for (const m of Array.isArray(raw) ? raw : []) {
    const ms = asRecord(m);
    if (!ms) continue;
    const sourceId = ms.SourcePolicyId;
    if (typeof sourceId === "string" && sourceId.length > 0) {
      ids.push(sourceId);
      continue;
    }
    // SourcePolicyId is present-but-malformed (null, a number, an array, ...).
    // Preserve the prior silent-drop behavior -- that's a CLI-shape error,
    // not an inline-policy signal. Only the absent / empty-string cases fall
    // through to the synthesize branch below.
    if (sourceId !== undefined && sourceId !== "") continue;
    // Inline-policy matches (and certain implicit sources) come back with
    // an ABSENT (or empty-string) SourcePolicyId but still carry
    // SourcePolicyType plus StartPosition.{Line,Column}. Synthesize an id
    // so the flat matchedStatementIds field doesn't silently drop the
    // match -- it is the only place the attribution surfaces now that the
    // raw EvaluationResults array is no longer echoed back. Decision/summary
    // counts are unaffected -- they read the decision, not these IDs.
    const sourceType = ms.SourcePolicyType;
    if (typeof sourceType !== "string") continue;
    const line = asRecord(ms.StartPosition)?.Line;
    ids.push(typeof line === "number" ? `inline#L${line}` : "inline");
  }
  return ids;
}

function stringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

/** Reduce an OrganizationsDecisionDetail / PermissionsBoundaryDecisionDetail to one word. */
function detailDecision(
  detail: unknown,
  key: "AllowedByOrganizations" | "AllowedByPermissionsBoundary",
): "allowed" | "denied" | undefined {
  const allowed = asRecord(detail)?.[key];
  if (typeof allowed !== "boolean") return undefined;
  return allowed ? "allowed" : "denied";
}

/**
 * Pick the Organizations / boundary detail for one EXPANDED (per-resource) row:
 * the entry's own value when it has one, else the action-level aggregate. An
 * allowed row reads "allowed" regardless, because an SCP or boundary deny
 * cannot coexist with an allow -- the aggregate deny was earned by some other
 * resource. The fallback row does not go through here; it IS the action-level
 * answer and reads the aggregate verbatim.
 */
function rowDetail(
  own: "allowed" | "denied" | undefined,
  aggregate: "allowed" | "denied" | undefined,
  rowDecision: string,
): "allowed" | "denied" | undefined {
  if (own !== undefined) return own;
  if (aggregate === undefined) return undefined;
  return rowDecision === "allowed" ? "allowed" : aggregate;
}

function buildRow(
  action: string,
  resource: string,
  decision: string,
  ids: string[],
  missing: string[],
  organizationsDecision?: string,
  permissionsBoundaryDecision?: string,
): SimulationResult {
  const row: SimulationResult = { action, resource, decision };
  if (ids.length > 0) row.matchedStatementIds = ids;
  if (missing.length > 0) row.missingContextValues = missing;
  if (organizationsDecision !== undefined) row.organizationsDecision = organizationsDecision;
  if (permissionsBoundaryDecision !== undefined) row.permissionsBoundaryDecision = permissionsBoundaryDecision;
  return row;
}

/**
 * Pull the fields callers actually want off the raw EvaluationResults[] array,
 * flattened to one row per (action, resource).
 *
 * Rows come from each result's ResourceSpecificResults, which is where IAM puts
 * the per-resource answers in both the pre- and post-2026-07-30 shapes (see the
 * header comment). A result with no usable per-resource entry falls back to its
 * own top-level fields, so EVERY EvaluationResult yields at least one row and no
 * action can vanish from `results` because AWS sent a shape we didn't expect.
 *
 * `opts.resourcesOmitted` says the call named no resources; the fallback row's
 * `resource` is then "*" rather than AWS's EvalResourceName.
 *
 * The CLI nests source-policy IDs inside MatchedStatements[]; we surface just
 * the IDs flat so the agent can read "decided by AdminAccess#statement-2" at a
 * glance. The caller does NOT preserve the raw array alongside this -- what
 * this function drops is dropped from the response (see the header comment for
 * the exact promoted / dropped list).
 */
export function parseSimulationResults(raw: unknown, opts: ParseOptions = {}): SimulationResult[] {
  if (!Array.isArray(raw)) return [];
  const out: SimulationResult[] = [];
  for (const r of raw) {
    const er = asRecord(r);
    if (!er) continue;
    const action = typeof er.EvalActionName === "string" ? er.EvalActionName : "";
    const orgAggregate = detailDecision(er.OrganizationsDecisionDetail, "AllowedByOrganizations");
    const pbAggregate = detailDecision(er.PermissionsBoundaryDecisionDetail, "AllowedByPermissionsBoundary");
    const parentMissing = stringList(er.MissingContextValues);

    // An entry with no usable EvalResourceName can't be attributed to a
    // resource, so it is skipped rather than emitted as a nameless row. If that
    // leaves none, the fallback below still speaks for the action.
    const perResource: { entry: Record<string, unknown>; resource: string }[] = [];
    for (const item of Array.isArray(er.ResourceSpecificResults) ? er.ResourceSpecificResults : []) {
      const entry = asRecord(item);
      const resource = entry?.EvalResourceName;
      if (!entry || typeof resource !== "string" || resource.length === 0) continue;
      perResource.push({ entry, resource });
    }

    if (perResource.length > 0) {
      for (const { entry, resource } of perResource) {
        const decision = toDecision(entry.EvalResourceDecision);
        let missing = stringList(entry.MissingContextValues);
        // The API reference reports the missing context keys for a '*'
        // simulation on the TOP-LEVEL result, and puts them in the per-resource
        // section only when the call named resources. So inherit for a '*'
        // entry alone: the top-level list is a union across every resource, and
        // copying it onto a specific ARN would blame that ARN for another's keys.
        if (missing.length === 0 && resource === "*") missing = parentMissing;
        out.push(
          buildRow(
            action,
            resource,
            decision,
            statementIds(entry.MatchedStatements),
            missing,
            rowDetail(
              detailDecision(entry.OrganizationsDecisionDetail, "AllowedByOrganizations"),
              orgAggregate,
              decision,
            ),
            rowDetail(
              detailDecision(entry.PermissionsBoundaryDecisionDetail, "AllowedByPermissionsBoundary"),
              pbAggregate,
              decision,
            ),
          ),
        );
      }
      continue;
    }

    // No per-resource breakdown: this top-level result IS the action-level
    // answer, so its details are read verbatim rather than derived.
    out.push(
      buildRow(
        action,
        opts.resourcesOmitted ? "*" : typeof er.EvalResourceName === "string" ? er.EvalResourceName : "*",
        toDecision(er.EvalDecision),
        statementIds(er.MatchedStatements),
        parentMissing,
        orgAggregate,
        pbAggregate,
      ),
    );
  }
  return out;
}

export const iamSimulateTools: readonly Tool[] = [
  {
    name: "aws_iam_simulate",
    description:
      "Simulate IAM permissions for a principal: can principal X do actions Y on resources Z? Wraps `iam simulate-principal-policy`. Returns one entry per (action, resource) pair -- one per action, with resource '*', when `resources` is omitted -- with `decision` (allowed / explicitDeny / implicitDeny / unknown -- unknown is the malformed-response fallback when the decision is missing or unrecognised), `matchedStatementIds` (which IAM statements decided), `missingContextValues` (context keys the policy needed but you didn't provide -- common for tag-based policies), `permissionsBoundaryDecision`, and `organizationsDecision` (whether SCPs allowed the action; AWS reports it per action, so on a multi-resource call a row that is not allowed can carry a deny that came from another resource). SCP statements never appear in matchedStatementIds, and keys only an SCP references are never reported missing -- pass e.g. aws:RequestedRegion in contextEntries yourself. 'allowed' is necessary, not sufficient: resource control policies (RCPs), the target resource's own policy, session policies and VPC endpoint policies are not evaluated. The CLI follows IAM's pagination itself, so `hasMore` is false unless you resumed with `marker`. Use this BEFORE a risky operation to avoid a 403; pairs with the post-failure Suggestion you get from aws_call. Requires iam:SimulatePrincipalPolicy on the caller.",
    annotations: {
      title: "Simulate IAM permissions for a principal",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      principalArn: z
        .string()
        .min(1)
        .describe(
          "ARN of the principal whose policies you want to evaluate, e.g. 'arn:aws:iam::123456789012:user/jeff' or 'arn:aws:iam::123456789012:role/my-role'. Must be the IAM user, group or role ARN -- not the STS session ARN aws_whoami reports for SSO / assumed-role sessions ('arn:aws:sts::<account>:assumed-role/<role>/<session>'); get the role's ARN with aws_call iam get-role.",
        ),
      actions: z
        .array(z.string().min(1))
        .min(1)
        .max(50)
        .describe(
          "IAM action names to test, e.g. ['lambda:CreateFunction', 's3:GetObject']. 1-50 entries. Wildcards (e.g. 's3:*') are accepted.",
        ),
      resources: z
        .array(z.string().min(1))
        .max(MAX_RESOURCES)
        .optional()
        .describe(
          `Resource ARNs to test against, e.g. ['arn:aws:s3:::my-bucket/*']. Up to ${MAX_RESOURCES} entries -- the simulator evaluates actions x resources, and the whole request travels as a single argv entry, so a larger batch dies as an opaque spawn error rather than a result. Split bigger batches across calls. When omitted, AWS applies its own default of ['*'] server-side (best-case 'is this action ever allowed?') -- this tool does not inject a ['*'] itself.`,
        ),
      contextEntries: z
        .array(
          z.object({
            contextKeyName: z.string().min(1),
            contextKeyType: z.enum(CONTEXT_KEY_TYPES),
            contextKeyValues: z.array(z.string()).min(1),
          }),
        )
        .optional()
        .describe(
          "Context keys for policies that depend on request context -- 'aws:RequestTag/Project' = 'foo', etc. Provide when the policy you're testing references condition keys; the response's `missingContextValues` will tell you which ones it wanted.",
        ),
      marker: z
        .string()
        .min(1)
        .max(1024)
        .optional()
        .describe(
          "Resume cursor from a previous call's `marker`. Omit it normally: on a first call the CLI already follows IAM's pagination and returns every page, so `hasMore` is false. Forwarded as IAM's Marker, which switches the CLI to returning that single page.",
        ),
      profile: z.string().optional().describe("Override session profile for this call."),
      region: z
        .string()
        .optional()
        .describe("Override session region for this call (IAM is global; affects API endpoint)."),
      timeoutMs: z.number().int().positive().optional().describe("Timeout in milliseconds. Default 60000."),
    }),
    handler: async (input: unknown): Promise<ToolResult> => {
      const i = input as {
        principalArn: string;
        actions: string[];
        resources?: string[];
        contextEntries?: { contextKeyName: string; contextKeyType: string; contextKeyValues: string[] }[];
        marker?: string;
        profile?: string;
        region?: string;
        timeoutMs?: number;
      };

      // Reject the STS session ARN before the generic shape check, so the caller
      // gets the lookup instead of IAM's own error. This tool does NOT rebuild
      // the role ARN: the session ARN drops the role's path, and SSO roles live
      // under aws-reserved/sso.amazonaws.com/. Handler validation, so no
      // errorKind and no spawn.
      const assumedRole = STS_ASSUMED_ROLE_RE.exec(i.principalArn);
      if (assumedRole) {
        return {
          ok: false,
          error: `principalArn '${i.principalArn}' is an STS assumed-role session ARN; the simulator needs the IAM role behind it. Look it up with aws_call {service: 'iam', operation: 'get-role', params: {RoleName: '${assumedRole[1]}'}} and pass Role.Arn. Don't rebuild it by hand: the session ARN drops the role's path (SSO roles live under aws-reserved/sso.amazonaws.com/).`,
        };
      }
      if (!ARN_RE.test(i.principalArn)) {
        return {
          ok: false,
          error: `Invalid principalArn '${i.principalArn}'. Expected ARN shape 'arn:<partition>:<service>:<region>:<account>:<resource>', e.g. 'arn:aws:iam::123:user/jeff'.`,
        };
      }
      for (const a of i.actions) {
        if (!ACTION_RE.test(a)) {
          return {
            ok: false,
            error: `Invalid action '${a}'. Expected '<service>:<Action>' (e.g. 'lambda:CreateFunction', 's3:*'). Service is kebab-case alphanumeric; action is alphanumeric or '*'.`,
          };
        }
      }
      if (i.resources) {
        if (i.resources.length > MAX_RESOURCES) {
          return {
            ok: false,
            error: `Too many resources: ${i.resources.length} requested, max ${MAX_RESOURCES}. The simulator evaluates actions x resources and the request travels as one argv entry; split the batch across calls.`,
          };
        }
        for (const r of i.resources) {
          // Permissive resource shape: an ARN, '*', or a placeholder string
          // the agent passes through. AWS validates server-side. We only
          // catch leading-hyphen + length so it can't pose as an argv flag.
          if (r.startsWith("-") || r.length > 2048) {
            return {
              ok: false,
              error: `Invalid resource '${r.slice(0, 60)}'. Must not start with '-' and be < 2048 chars.`,
            };
          }
        }
      }

      const params: Record<string, unknown> = {
        PolicySourceArn: i.principalArn,
        ActionNames: i.actions,
      };
      if (i.resources && i.resources.length > 0) {
        params.ResourceArns = i.resources;
      }
      if (i.contextEntries && i.contextEntries.length > 0) {
        params.ContextEntries = i.contextEntries.map((c) => ({
          ContextKeyName: c.contextKeyName,
          ContextKeyType: c.contextKeyType,
          ContextKeyValues: c.contextKeyValues,
        }));
      }
      if (i.marker !== undefined) {
        params.Marker = i.marker;
      }

      // The count caps above bound the LISTS; this bounds the BYTES they
      // serialize to. 50 resources at the 2048-char ceiling is ~100 KB in one
      // argv entry -- past both the Linux per-entry limit and the Windows
      // whole-command-line limit. Catch it here so the caller gets a reason
      // instead of a spawn failure with no useful message.
      const payloadChars = JSON.stringify(params).length;
      if (payloadChars > MAX_ARGV_JSON_CHARS) {
        return {
          ok: false,
          error: `Request too large: the simulation parameters serialize to ${payloadChars} characters, over the ${MAX_ARGV_JSON_CHARS} limit. They travel as a single argv entry (--cli-input-json), which the OS caps well below this. Use shorter/fewer resource ARNs, fewer actions, or split the batch across calls.`,
        };
      }

      const result = await runAwsCall({
        service: "iam",
        operation: "simulate-principal-policy",
        params,
        profile: i.profile,
        region: i.region,
        timeoutMs: i.timeoutMs,
        outputFormat: "json",
      });
      if (!result.ok) {
        // `||`, not `??`: an empty-string rawStderr is not nullish, so `??`
        // would hand back "" instead of falling back to stdout.
        return {
          ok: false,
          error: result.error,
          errorKind: result.kind,
          suggestion: result.suggestion,
          rawBody: result.rawStderr || result.rawStdout,
        };
      }

      const raw = result.data as { EvaluationResults?: unknown[]; IsTruncated?: unknown; Marker?: unknown } | null;
      // `resources: []` is treated as omitted above, so the two stay consistent.
      const results = parseSimulationResults(raw?.EvaluationResults, {
        resourcesOmitted: !(i.resources && i.resources.length > 0),
      });
      // IAM paginates this API, but the CLI follows IsTruncated/Marker itself and
      // prints the merged pages, so a FIRST call is already complete: hasMore
      // false, marker null. Supplying a Marker in --cli-input-json turns that
      // auto-pagination off and returns the single raw page, which is the only
      // way a response reaching here carries either field. Still read, because
      // a resumed page that is itself truncated does say so. [verified against
      // aws-cli/2.34.3 on a 3-page local stub, 2026-09-19]
      const marker = typeof raw?.Marker === "string" && raw.Marker.length > 0 ? raw.Marker : null;
      const hasMore = raw?.IsTruncated === true || marker !== null;
      const allowed = results.filter((r) => r.decision === "allowed").length;
      // Count unknown separately so it isn't silently folded into denied.
      // unknown is the malformed-response fallback -- the decision was missing,
      // or outside IAM's closed enum (see toDecision); real denies are
      // explicitDeny + implicitDeny only. summary counts (action, resource)
      // pairs, which is what `results` holds.
      const unknown = results.filter((r) => r.decision === "unknown").length;
      const denied = results.length - allowed - unknown;

      return {
        ok: true,
        data: {
          command: result.command,
          commandArgv: result.commandArgv,
          principalArn: i.principalArn,
          summary: { allowed, denied, unknown, total: results.length },
          results,
          marker,
          hasMore,
        },
      };
    },
  },
];
