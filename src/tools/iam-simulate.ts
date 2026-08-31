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
 * Maps to `aws iam simulate-principal-policy`. The response is flattened to
 * {action, resource, decision, matchedStatementIds, missingContextValues,
 * organizationsDecision, permissionsBoundaryDecision} per EvaluationResult,
 * and the raw EvaluationResults array is NOT echoed back alongside it --
 * returning both doubled the payload of every response.
 *
 * That drop is lossy, so be precise about what survives. Promoted: EvalDecision
 * (as `decision`), EvalActionName, EvalResourceName, MissingContextValues, and
 * the two decision details reduced to "allowed" / "denied" strings
 * (AllowedByOrganizations -> organizationsDecision, AllowedByPermissionsBoundary
 * -> permissionsBoundaryDecision). NOT promoted, and no longer reachable from
 * this tool: the MatchedStatements BODIES. `matchedStatementIds` carries each
 * match's SourcePolicyId (or a synthesized `inline` / `inline#L<n>` id when it
 * has none) and nothing else -- SourcePolicyType, StartPosition and EndPosition
 * are dropped. Also dropped: EvalDecisionDetails, ResourceSpecificResults, and
 * any field AWS adds to EvaluationResult in future. A caller that needs one of
 * those has to go around this tool (aws_call on iam simulate-principal-policy).
 *
 * IAM paginates this API (IsTruncated + Marker). The response surfaces
 * `hasMore` + `marker`, and `marker` is accepted as an input to resume --
 * matching the nextToken convention in metrics.ts / paginate.ts / resource.ts.
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

/**
 * Pull the fields callers actually want off the raw EvaluationResults[]
 * array. The CLI nests source-policy IDs inside MatchedStatements[]; we
 * surface just the IDs flat so the agent can read "decided by
 * AdminAccess#statement-2" at a glance. The caller does NOT preserve the raw
 * array alongside this -- what this function drops is dropped from the
 * response (see the header comment for the exact promoted / dropped list).
 */
export function parseSimulationResults(raw: unknown): SimulationResult[] {
  if (!Array.isArray(raw)) return [];
  const out: SimulationResult[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const er = r as Record<string, unknown>;
    const action = typeof er.EvalActionName === "string" ? er.EvalActionName : "";
    const resource = typeof er.EvalResourceName === "string" ? er.EvalResourceName : "*";
    const decision = typeof er.EvalDecision === "string" ? er.EvalDecision : "unknown";

    const result: SimulationResult = { action, resource, decision };

    const matched = Array.isArray(er.MatchedStatements) ? er.MatchedStatements : [];
    const ids: string[] = [];
    for (const m of matched) {
      if (!m || typeof m !== "object") continue;
      const ms = m as Record<string, unknown>;
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
      // counts are unaffected -- they read EvalDecision, not these IDs.
      const sourceType = ms.SourcePolicyType;
      if (typeof sourceType !== "string") continue;
      const startPos = ms.StartPosition;
      if (startPos && typeof startPos === "object") {
        const line = (startPos as Record<string, unknown>).Line;
        if (typeof line === "number") {
          ids.push(`inline#L${line}`);
          continue;
        }
      }
      ids.push("inline");
    }
    if (ids.length > 0) result.matchedStatementIds = ids;

    const missing = Array.isArray(er.MissingContextValues) ? er.MissingContextValues : [];
    if (missing.length > 0) {
      result.missingContextValues = missing.filter((v): v is string => typeof v === "string");
    }

    const orgDetail = er.OrganizationsDecisionDetail;
    if (orgDetail && typeof orgDetail === "object") {
      const allowed = (orgDetail as Record<string, unknown>).AllowedByOrganizations;
      if (typeof allowed === "boolean") {
        result.organizationsDecision = allowed ? "allowed" : "denied";
      }
    }

    const pbDetail = er.PermissionsBoundaryDecisionDetail;
    if (pbDetail && typeof pbDetail === "object") {
      const allowed = (pbDetail as Record<string, unknown>).AllowedByPermissionsBoundary;
      if (typeof allowed === "boolean") {
        result.permissionsBoundaryDecision = allowed ? "allowed" : "denied";
      }
    }

    out.push(result);
  }
  return out;
}

export const iamSimulateTools: readonly Tool[] = [
  {
    name: "aws_iam_simulate",
    description:
      "Simulate IAM permissions for a principal: can principal X do actions Y on resources Z? Wraps `iam simulate-principal-policy`. Returns one entry per (action, resource) pair with `decision` (allowed / explicitDeny / implicitDeny / unknown -- unknown is the malformed-response fallback when EvalDecision is missing or unrecognised), `matchedStatementIds` (which IAM statements decided), and `missingContextValues` (context keys the policy needed but you didn't provide -- common for tag-based policies). IAM paginates large batches: when it truncates, `hasMore` is true and `marker` carries the resume cursor -- call again with `marker` set to get the rest, and treat `summary` as covering only the page you have. Use this BEFORE a risky operation to avoid a 403; pairs with the post-failure Suggestion you get from aws_call. Requires iam:SimulatePrincipalPolicy on the caller.",
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
          "ARN of the principal whose policies you want to evaluate, e.g. 'arn:aws:iam::123456789012:user/jeff' or 'arn:aws:iam::123456789012:role/my-role'.",
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
          "Resume cursor from a previous call's `marker`. Omit for the first page. Forwarded as IAM's Marker; only meaningful when a prior call returned `hasMore: true`.",
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
        return { ok: false, error: result.error, rawBody: result.rawStderr || result.rawStdout };
      }

      const raw = result.data as { EvaluationResults?: unknown[]; IsTruncated?: unknown; Marker?: unknown } | null;
      const results = parseSimulationResults(raw?.EvaluationResults);
      // IAM paginates: a batch of actions x resources can come back truncated
      // with a Marker to resume from. Reading only EvaluationResults reported
      // `summary.total` as if it were the whole answer -- a silent undercount
      // on exactly the large batches a caller is least able to eyeball.
      const marker = typeof raw?.Marker === "string" && raw.Marker.length > 0 ? raw.Marker : null;
      const hasMore = raw?.IsTruncated === true || marker !== null;
      const allowed = results.filter((r) => r.decision === "allowed").length;
      // Count unknown separately so it isn't silently folded into denied.
      // unknown is the malformed-response fallback (EvalDecision missing or
      // unrecognised); real denies are explicitDeny + implicitDeny only.
      const unknown = results.filter((r) => r.decision === "unknown").length;
      const denied = results.length - allowed - unknown;

      return {
        ok: true,
        data: {
          command: result.command,
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
