import { z } from "zod";
import { runAwsCall } from "../aws-cli.js";
import type { Tool, ToolResult } from "./tool.js";

export const callTools: readonly Tool[] = [
  {
    name: "aws_call",
    description:
      "Run an arbitrary AWS API operation via the aws CLI. Use kebab-case service and operation names as in `aws help` (service='s3api', operation='list-buckets'). Pass params as a JSON object using the AWS API's PascalCase keys (e.g. {Bucket: 'foo'}); they go through --cli-input-json. Session profile/region (from aws_session_set) are used by default; override per-call when needed. For high-level wrappers like 'aws s3 cp' or 'aws ec2 wait', use your shell — this tool targets the low-level API. Returns parsed JSON output by default, plus the literal command that was run.",
    annotations: {
      title: "Call an AWS API operation",
      // The operation being called determines read-only/destructive, and we
      // cannot introspect it -- `operation` is a free string resolved by the
      // CLI at spawn time. So annotate for the WORST case this tool can reach,
      // which is the whole AWS API: ec2 terminate-instances, s3api
      // delete-bucket, iam delete-user.
      //
      // destructiveHint MUST stay true. Per the MCP spec it defaults to true,
      // and `false` positively asserts "performs only additive updates" -- a
      // claim this tool cannot make. Hosts gate their confirmation prompt on
      // it, so `false` here suppressed the confirm on the single most powerful
      // tool in the server. A caller who wants a hint that means "read-only"
      // should reach for aws_paginate (readOnlyHint: true) instead.
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      service: z
        .string()
        .describe(
          "AWS service name in kebab-case: 's3api', 'ec2', 'iam', 'lambda', 'dynamodb', 'logs', 'sts', 'cloudformation', etc.",
        ),
      operation: z
        .string()
        .describe(
          "Operation name in kebab-case: 'list-buckets', 'describe-instances', 'get-caller-identity', 'put-object'.",
        ),
      params: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Operation parameters as a JSON object (AWS API schema, PascalCase keys). E.g. {Bucket: 'foo', Key: 'bar'}.",
        ),
      query: z
        .string()
        .optional()
        .describe(
          "JMESPath expression to extract a subset of the response (passed as --query). E.g. 'Buckets[].Name', 'Reservations[].Instances[].{Id:InstanceId,State:State.Name}'. Dramatically reduces output size; reach for this whenever you only need a few fields.",
        ),
      profile: z.string().optional().describe("Override session profile for this call."),
      region: z.string().optional().describe("Override session region for this call."),
      outputFormat: z
        .enum(["json", "text", "table", "yaml"])
        .optional()
        .describe("Output format. Default 'json' (parsed into structured data when possible)."),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Timeout in milliseconds. Default 60000 (60s). Raise for slow ops; lower to fail fast."),
    }),
    handler: async (input: unknown): Promise<ToolResult> => {
      const i = input as {
        service: string;
        operation: string;
        params?: Record<string, unknown>;
        query?: string;
        profile?: string;
        region?: string;
        outputFormat?: "json" | "text" | "table" | "yaml";
        timeoutMs?: number;
      };
      const result = await runAwsCall({
        service: i.service,
        operation: i.operation,
        params: i.params,
        query: i.query,
        profile: i.profile,
        region: i.region,
        outputFormat: i.outputFormat,
        timeoutMs: i.timeoutMs,
      });
      if (!result.ok) {
        return {
          ok: false,
          error: result.error,
          // runAwsCall already classified this failure; forwarding the kind is
          // what lets a caller branch on it without regexing the message.
          errorKind: result.kind,
          suggestion: result.suggestion,
          // Treat an empty-string rawStderr as "no stderr" so a nonzero exit
          // that wrote its diagnostic to stdout (rare but observed: some
          // `aws` operations route through stdout when stderr is closed or
          // when a wrapper script swallows stderr) still surfaces the
          // stdout body. Pinned by call.test.ts -- the failure-shape
          // contract is "diagnostic text first, stdout second" rather
          // than "stderr always wins even when empty".
          rawBody: result.rawStderr ? result.rawStderr : result.rawStdout,
        };
      }
      return {
        ok: true,
        data: {
          command: result.command,
          result: result.data,
        },
      };
    },
  },
];
