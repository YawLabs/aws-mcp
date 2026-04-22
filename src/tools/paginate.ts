import { z } from "zod";
import { runAwsCall } from "../aws-cli.js";

type ToolResult = { ok: boolean; data?: unknown; error?: string; rawBody?: string };

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

export const paginateTools = [
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

      const result = await runAwsCall({
        service: i.service,
        operation: i.operation,
        params: i.params,
        profile: i.profile,
        region: i.region,
        outputFormat: "json",
        timeoutMs: i.timeoutMs,
        extraFlags,
      });

      if (!result.ok) {
        return { ok: false, error: result.error, rawBody: result.rawStderr ?? result.rawStdout };
      }

      const nextToken = extractNextToken(result.data);
      return {
        ok: true,
        data: {
          command: result.command,
          result: result.data,
          nextToken,
          hasMore: nextToken !== null,
        },
      };
    },
  },
] as const;
