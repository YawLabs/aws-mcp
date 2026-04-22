import { z } from "zod";
import { runAwsCall } from "../aws-cli.js";

type ToolResult = { ok: boolean; data?: unknown; error?: string; rawBody?: string };

export const callTools = [
  {
    name: "aws_call",
    description:
      "Run an arbitrary AWS API operation via the aws CLI. Use kebab-case service and operation names as in `aws help` (service='s3api', operation='list-buckets'). Pass params as a JSON object using the AWS API's PascalCase keys (e.g. {Bucket: 'foo'}); they go through --cli-input-json. Session profile/region (from aws_session_set) are used by default; override per-call when needed. For high-level wrappers like 'aws s3 cp' or 'aws ec2 wait', use your shell — this tool targets the low-level API. Returns parsed JSON output by default, plus the literal command that was run.",
    annotations: {
      title: "Call an AWS API operation",
      // The operation being called determines read-only/destructive — annotate
      // conservatively since we can't introspect.
      readOnlyHint: false,
      destructiveHint: false,
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
        profile?: string;
        region?: string;
        outputFormat?: "json" | "text" | "table" | "yaml";
        timeoutMs?: number;
      };
      const result = await runAwsCall({
        service: i.service,
        operation: i.operation,
        params: i.params,
        profile: i.profile,
        region: i.region,
        outputFormat: i.outputFormat,
        timeoutMs: i.timeoutMs,
      });
      if (!result.ok) {
        return {
          ok: false,
          error: result.error,
          rawBody: result.rawStderr ?? result.rawStdout,
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
] as const;
