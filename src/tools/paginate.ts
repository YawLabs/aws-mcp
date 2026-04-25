import { z } from "zod";
import { runAwsCall } from "../aws-cli.js";
import type { Tool, ToolResult } from "./tool.js";

/**
 * When --max-items is passed and the underlying API truncates, the AWS CLI
 * always surfaces the resume token under the top-level `NextToken` key (even
 * when the raw API uses Marker / NextContinuationToken / nextToken). So a
 * single field check covers every paginated operation.
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

export const paginateTools: readonly Tool[] = [
  {
    name: "aws_paginate",
    description:
      "Fetch one page of a paginated AWS list/describe operation. Identical to aws_call plus `maxItems` (page size) and `startingToken` (resume cursor). Returns the parsed response, a `nextToken` (null when the list is exhausted), and `hasMore`. Call again with the returned nextToken as startingToken until hasMore is false. Use this instead of aws_call for operations that might exceed the 5 MB stdout cap: list-objects-v2, describe-instances, describe-log-streams, list-roles, etc.",
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
        .optional()
        .describe("Items per page. Default 100. Lower this if hitting the 5 MB output cap."),
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
      const maxItems = i.maxItems ?? 100;
      const extraFlags: string[] = ["--max-items", String(maxItems)];
      if (i.startingToken) {
        extraFlags.push("--starting-token", i.startingToken);
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
        return { ok: false, error: result.error, rawBody: result.rawStderr ?? result.rawStdout };
      }

      let resultBody: unknown;
      let nextToken: string | null;
      if (queryWrapped) {
        const wrapped = (result.data ?? {}) as { NextToken?: unknown; items?: unknown };
        nextToken = typeof wrapped.NextToken === "string" && wrapped.NextToken.length > 0 ? wrapped.NextToken : null;
        resultBody = wrapped.items ?? null;
      } else {
        nextToken = extractNextToken(result.data);
        resultBody = result.data;
      }

      return {
        ok: true,
        data: {
          command: result.command,
          result: resultBody,
          nextToken,
          hasMore: nextToken !== null,
        },
      };
    },
  },
];
