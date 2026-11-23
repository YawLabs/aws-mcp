import { z } from "zod";
import { type AwsCallFailure, runAwsCall } from "../aws-cli.js";
import { CLI_PARSE_EXIT_CODE, cliParseFailureHint } from "./call.js";
import { validateCursorToken } from "./resource.js";
import { failureToolResult, type Tool, type ToolResult } from "./tool.js";

/**
 * When --max-items is passed and the underlying API truncates, the AWS CLI
 * always surfaces the resume token under the top-level `NextToken` key (even
 * when the raw API uses Marker / NextContinuationToken / nextToken). So a
 * single field check covers every paginated operation when invoked via
 * aws_paginate (which always passes --max-items). Without --max-items the
 * raw API field names pass through verbatim (e.g. list-objects-v2 returns
 * NextContinuationToken), so this helper is NOT a general "find the next
 * token anywhere" reader -- it reads a top-level string `NextToken`. That is
 * exactly what three callers need: aws_paginate's --max-items envelope, plus
 * the natively-top-level `NextToken` that CCAPI list-resources
 * (aws_resource_list) and GetMetricData (aws_metrics_query) already return.
 */
export function extractNextToken(data: unknown): string | null {
  if (data && typeof data === "object" && "NextToken" in data) {
    const token = (data as { NextToken: unknown }).NextToken;
    if (typeof token === "string" && token.length > 0) return token;
  }
  return null;
}

/**
 * The aws CLI applies `--query` AFTER pagination merges, and the JMESPath
 * replaces the response object wholesale -- a query like `Buckets[].Name`
 * drops the top-level `NextToken` along with everything else. To keep
 * pagination working, we wrap the user's query into a multiselect-hash that
 * preserves NextToken alongside the projection:
 *
 *   user query:    Buckets[].Name
 *   wrapped query: {NextToken: NextToken, items: Buckets[].Name}
 *
 * The handler then unwraps `items` for the caller and reads NextToken from
 * the same envelope. JMESPath's identifier syntax allows arbitrary
 * sub-expressions on the right of each key, so any user query a raw `--query`
 * call would have accepted still works inside the wrapper.
 */
export function wrapQueryForPagination(userQuery: string): string {
  return `{NextToken: NextToken, items: ${userQuery}}`;
}

const DEFAULT_MAX_ITEMS = 100;
const MAX_MAX_ITEMS = 10_000;

/**
 * Defense-in-depth: the schema caps maxItems at 1-10_000 integers, but direct
 * (non-MCP) callers bypass schema validation. A plain Math.min/Math.max clamp
 * passes NaN and fractions straight through to `--max-items NaN` / `2.5`, a
 * CLI parse error, so anything that is not a finite number falls back to the
 * default and a fraction is truncated before the clamp.
 */
export function clampMaxItems(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_MAX_ITEMS;
  return Math.min(Math.max(1, Math.trunc(raw)), MAX_MAX_ITEMS);
}

// The CLI's answer to --max-items on an operation it does not paginate (`sts
// get-caller-identity`, `s3api head-object`). Captured on real 2.34.3:
//   "aws: [ERROR]: Unknown options: --max-items, --starting-token, abc, 100"
// -- flags first, then their values, joined with ", ". The lookahead keeps a
// longer flag name from matching.
const UNKNOWN_MAX_ITEMS_RE = /Unknown options: (?:[^\r\n]*[ ,])?--max-items(?=[\s,"'\\|]|$)/;

function notPaginatedHint(result: AwsCallFailure, service: string, operation: string): string | undefined {
  if (result.kind !== "nonzero_exit" || result.suggestion !== undefined) return undefined;
  if (result.exitCode !== CLI_PARSE_EXIT_CODE || !UNKNOWN_MAX_ITEMS_RE.test(result.rawStderr ?? "")) return undefined;
  const op = operation.trim().split(/\s+/).filter(Boolean).join(" ");
  return `\`aws ${service} ${op}\` is not a paginated operation: the CLI registers --max-items / --starting-token (which aws_paginate always sends) only on operations it can paginate. Call it through aws_call with the same service, operation and params.`;
}

export const paginateTools: readonly Tool[] = [
  {
    name: "aws_paginate",
    description:
      "Fetch one page of a paginated AWS list/describe operation. Takes aws_call's inputs (output is always JSON) plus `maxItems` (page size) and `startingToken` (resume cursor). Only for operations the CLI paginates: a non-paginated one (sts get-caller-identity) rejects --max-items, so call it with aws_call. When `query` is supplied it is wrapped server-side as {NextToken, items: <query>} so pagination survives a projection that would otherwise drop NextToken; the handler unwraps `items` before returning. Returns the parsed response, a `nextToken` (null when the list is exhausted), and `hasMore`. Call again with the returned nextToken as startingToken until hasMore is false. Use this instead of aws_call for operations that might exceed the 5 MB stdout cap: list-objects-v2, describe-instances, describe-log-streams, list-roles, etc.",
    annotations: {
      title: "Fetch one page of a paginated AWS operation",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      service: z.string().describe("AWS service in kebab-case: 's3api', 'ec2', 'iam', 'logs', etc."),
      operation: z
        .string()
        .describe("Paginated operation: 'list-objects-v2', 'describe-instances', 'list-roles', etc."),
      params: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Operation parameters (PascalCase keys) passed via --cli-input-json."),
      query: z
        .string()
        .optional()
        .describe(
          "JMESPath expression to extract fields from each page (--query). The query is wrapped server-side as {NextToken, items: <query>} so pagination still works even when the projection drops NextToken; the handler unwraps `items` before returning.",
        ),
      maxItems: z
        .number()
        .int()
        .positive()
        .max(10_000)
        .optional()
        .describe("Items per page (1-10000). Default 100. Lower this if hitting the 5 MB output cap."),
      startingToken: z
        .string()
        .optional()
        .describe("Resume cursor from the previous call's `nextToken`. Omit for the first page."),
      profile: z.string().optional().describe("Override session profile for this call."),
      region: z.string().optional().describe("Override session region for this call."),
      timeoutMs: z.number().int().positive().optional().describe("Timeout in milliseconds. Default 60000."),
    }),
    handler: async (input: unknown): Promise<ToolResult> => {
      const i = input as {
        service: string;
        operation: string;
        params?: Record<string, unknown>;
        query?: string;
        maxItems?: number;
        startingToken?: string;
        profile?: string;
        region?: string;
        timeoutMs?: number;
      };
      // startingToken lands in extraFlags as a bare --starting-token arg, so
      // argv-safety it the same way resource.ts guards its cursors: a
      // leading-hyphen or absurdly long token would otherwise leak as a flag,
      // and a `file://` / `fileb://` one would make the CLI send the contents of
      // a local file as the cursor.
      // Cursor bound (8192), NOT the 128-char RequestToken/ClientToken bound
      // -- real resume cursors are base64 blobs that run well past 128, and
      // the tighter cap rejected page 2 of every list. The CLI wraps a raw
      // token as base64 JSON for --starting-token, so a documented 4096-char
      // NextToken arrives here as 5,484 characters.
      //
      // An empty or whitespace-only token means "first page": models commonly
      // send "" for an optional string on the first call, and refusing it as
      // an invalid cursor failed a call that had nothing wrong with it.
      const startingToken =
        typeof i.startingToken === "string" && i.startingToken.trim() !== "" ? i.startingToken : undefined;
      if (startingToken !== undefined) {
        const stErr = validateCursorToken(startingToken, "startingToken");
        if (stErr) return { ok: false, error: stErr };
      }

      const extraFlags: string[] = ["--max-items", String(clampMaxItems(i.maxItems))];
      if (startingToken !== undefined) {
        extraFlags.push("--starting-token", startingToken);
      }

      const userQuery = i.query?.trim();
      const queryWrapped = userQuery ? wrapQueryForPagination(userQuery) : undefined;

      const result = await runAwsCall({
        service: i.service,
        operation: i.operation,
        params: i.params,
        query: queryWrapped,
        profile: i.profile,
        region: i.region,
        outputFormat: "json",
        timeoutMs: i.timeoutMs,
        extraFlags,
      });

      if (!result.ok) {
        // aws_call's parse-failure remedies first: they explain the more
        // fundamental problem (a command that cannot take params at all), and a
        // hand-written command rejects --max-items in the same breath.
        const hint =
          cliParseFailureHint(result, { ...i, tool: "aws_paginate" }) ??
          notPaginatedHint(result, i.service, i.operation);
        return failureToolResult(result, hint);
      }

      let resultBody: unknown;
      let nextToken: string | null;
      if (queryWrapped) {
        const wrapped = (result.data ?? {}) as { NextToken?: unknown; items?: unknown };
        nextToken = extractNextToken(wrapped);
        resultBody = wrapped.items ?? null;
      } else {
        nextToken = extractNextToken(result.data);
        resultBody = result.data;
      }

      return {
        ok: true,
        data: {
          command: result.command,
          commandArgv: result.commandArgv,
          result: resultBody,
          nextToken,
          hasMore: nextToken !== null,
        },
      };
    },
  },
];
