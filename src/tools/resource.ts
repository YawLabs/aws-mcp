import { z } from "zod";
import { runAwsCall } from "../aws-cli.js";
import type { Tool, ToolResult } from "./tool.js";

/**
 * AWS Cloud Control API (CCAPI) gives us a single typed CRUD surface over any
 * resource type with a CloudFormation schema -- hundreds of services, covering
 * most control-plane resources. One tool per verb handles Lambda, S3, IAM, RDS,
 * SSM, etc. without per-service bundles.
 *
 * We shell to `aws cloudcontrol <verb>` so the pattern matches aws_call (zero
 * SDK weight, coverage matches whatever the installed CLI knows). Safety:
 * leading-hyphen defense on every user-supplied free-text field (typeName,
 * identifier, requestToken, clientToken) stops argv-injection; JSON payloads
 * (desiredState, patchDocument, resourceModel) are serialized into single argv
 * entries so they can't leak flags.
 *
 * Mutation verbs return a ProgressEvent with OperationStatus=IN_PROGRESS and a
 * RequestToken. Callers poll aws_resource_status with that token until the
 * status is SUCCESS, FAILED, or CANCEL_COMPLETE.
 */

// <Namespace>::<Service>::<Resource> where each segment is PascalCase
// alphanumeric. Matches AWS::*, Custom::*, and third-party registry types.
export const TYPE_NAME_RE = /^[A-Z][A-Za-z0-9]*::[A-Z][A-Za-z0-9]*::[A-Z][A-Za-z0-9]*$/;

/**
 * Identifier shapes are open-ended (ARNs, bucket names, composite ids, ...).
 * Only enforce argv-safety: non-empty, bounded length, no leading hyphen, no
 * ASCII control chars. AWS resource identifiers don't exceed 2048 in practice.
 */
export function isValidIdentifier(id: string): boolean {
  if (id.length === 0 || id.length > 2048) return false;
  if (id.startsWith("-")) return false;
  for (let i = 0; i < id.length; i++) {
    if (id.charCodeAt(i) < 0x20) return false;
  }
  return true;
}

/**
 * Opaque-token validator for RequestToken and ClientToken. AWS docs cap both
 * at 128 chars. Only enforce argv-safety + bounded length.
 */
export function isValidOpaqueToken(token: string): boolean {
  if (token.length === 0 || token.length > 128) return false;
  if (token.startsWith("-")) return false;
  for (let i = 0; i < token.length; i++) {
    if (token.charCodeAt(i) < 0x20) return false;
  }
  return true;
}

/**
 * CCAPI returns Properties as a JSON-encoded string (not a parsed object).
 * Parse it into an object for the caller; preserve the raw string on parse
 * failure so callers still see *something* diagnosable.
 */
export function parseResourceProperties(raw: unknown): {
  Identifier?: string;
  Properties: unknown;
  propertiesRaw?: string;
} {
  if (!raw || typeof raw !== "object") return { Properties: raw };
  const rec = raw as Record<string, unknown>;
  const identifier = typeof rec.Identifier === "string" ? rec.Identifier : undefined;
  const rawProps = rec.Properties;
  if (typeof rawProps !== "string") {
    return { Identifier: identifier, Properties: rawProps };
  }
  try {
    return { Identifier: identifier, Properties: JSON.parse(rawProps) };
  } catch {
    return { Identifier: identifier, Properties: rawProps, propertiesRaw: rawProps };
  }
}

function validateTypeName(typeName: string): string | null {
  if (!TYPE_NAME_RE.test(typeName)) {
    return `Invalid typeName '${typeName}'. Must be '<Namespace>::<Service>::<Resource>' in PascalCase, e.g. 'AWS::Lambda::Function', 'AWS::S3::Bucket'.`;
  }
  return null;
}

function validateIdentifier(id: string): string | null {
  if (!isValidIdentifier(id)) {
    const preview = id.length > 40 ? `${id.slice(0, 40)}...` : id;
    return `Invalid identifier '${preview}'. Must be 1-2048 chars, not start with '-', and contain no control characters.`;
  }
  return null;
}

function validateOpaqueToken(token: string, fieldName: string): string | null {
  if (!isValidOpaqueToken(token)) {
    return `Invalid ${fieldName}. Must be 1-128 chars, not start with '-', and contain no control characters.`;
  }
  return null;
}

const baseFields = {
  profile: z.string().optional().describe("Override session profile for this call."),
  region: z.string().optional().describe("Override session region for this call."),
  timeoutMs: z.number().int().positive().optional().describe("Timeout in milliseconds. Default 60000."),
};

export const resourceTools: readonly Tool[] = [
  {
    name: "aws_resource_get",
    description:
      "Read a single AWS resource via Cloud Control API. Covers hundreds of resource types with a CloudFormation schema. `typeName` is '<Namespace>::<Service>::<Resource>' (e.g. 'AWS::Lambda::Function'); `identifier` is the primary key for that type (function name, bucket name, IAM role name, ARN, or composite id). Returns parsed Properties. For resources not covered by CCAPI or for data-plane operations, use aws_call.",
    annotations: {
      title: "Get an AWS resource by type + identifier",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      typeName: z
        .string()
        .describe("CloudFormation type name, e.g. 'AWS::Lambda::Function', 'AWS::S3::Bucket', 'AWS::IAM::Role'."),
      identifier: z
        .string()
        .min(1)
        .describe("Primary identifier for the resource (function name, bucket name, ARN, or composite id)."),
      ...baseFields,
    }),
    handler: async (input: unknown): Promise<ToolResult> => {
      const i = input as {
        typeName: string;
        identifier: string;
        profile?: string;
        region?: string;
        timeoutMs?: number;
      };
      const tnErr = validateTypeName(i.typeName);
      if (tnErr) return { ok: false, error: tnErr };
      const idErr = validateIdentifier(i.identifier);
      if (idErr) return { ok: false, error: idErr };

      const result = await runAwsCall({
        service: "cloudcontrol",
        operation: "get-resource",
        profile: i.profile,
        region: i.region,
        timeoutMs: i.timeoutMs,
        outputFormat: "json",
        extraFlags: ["--type-name", i.typeName, "--identifier", i.identifier],
      });

      if (!result.ok) {
        return { ok: false, error: result.error, rawBody: result.rawStderr ?? result.rawStdout };
      }

      const raw = result.data as { TypeName?: string; ResourceDescription?: unknown } | null;
      const parsed = parseResourceProperties(raw?.ResourceDescription);
      return {
        ok: true,
        data: {
          command: result.command,
          typeName: raw?.TypeName ?? i.typeName,
          identifier: parsed.Identifier,
          properties: parsed.Properties,
          ...(parsed.propertiesRaw ? { propertiesRaw: parsed.propertiesRaw } : {}),
        },
      };
    },
  },

  {
    name: "aws_resource_list",
    description:
      "List resources of a given type via Cloud Control API, paginated. Returns an array of {identifier, properties}, a `nextToken` (null when exhausted), and `hasMore`. Some types need parent identifiers (e.g. nested resources under a cluster); pass those as `resourceModel`.",
    annotations: {
      title: "List AWS resources of a type (paginated)",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      typeName: z.string().describe("CloudFormation type name, e.g. 'AWS::Lambda::Function'."),
      resourceModel: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Parent identifier properties for nested types, e.g. {ClusterArn: '...'}."),
      maxResults: z.number().int().positive().max(100).optional().describe("Page size (1-100). Default 100."),
      nextToken: z
        .string()
        .optional()
        .describe("Resume cursor from the previous call's `nextToken`. Omit for the first page."),
      ...baseFields,
    }),
    handler: async (input: unknown): Promise<ToolResult> => {
      const i = input as {
        typeName: string;
        resourceModel?: Record<string, unknown>;
        maxResults?: number;
        nextToken?: string;
        profile?: string;
        region?: string;
        timeoutMs?: number;
      };
      const tnErr = validateTypeName(i.typeName);
      if (tnErr) return { ok: false, error: tnErr };
      if (i.nextToken !== undefined) {
        const ntErr = validateOpaqueToken(i.nextToken, "nextToken");
        if (ntErr) return { ok: false, error: ntErr };
      }

      const extraFlags: string[] = ["--type-name", i.typeName, "--max-results", String(i.maxResults ?? 100)];
      if (i.nextToken) extraFlags.push("--next-token", i.nextToken);
      if (i.resourceModel && Object.keys(i.resourceModel).length > 0) {
        extraFlags.push("--resource-model", JSON.stringify(i.resourceModel));
      }

      const result = await runAwsCall({
        service: "cloudcontrol",
        operation: "list-resources",
        profile: i.profile,
        region: i.region,
        timeoutMs: i.timeoutMs,
        outputFormat: "json",
        extraFlags,
      });

      if (!result.ok) {
        return { ok: false, error: result.error, rawBody: result.rawStderr ?? result.rawStdout };
      }

      const raw = result.data as { ResourceDescriptions?: unknown[]; NextToken?: string } | null;
      const descriptions = Array.isArray(raw?.ResourceDescriptions) ? raw.ResourceDescriptions : [];
      const resources = descriptions.map((d) => {
        const p = parseResourceProperties(d);
        return { identifier: p.Identifier, properties: p.Properties };
      });
      const nextToken = typeof raw?.NextToken === "string" && raw.NextToken.length > 0 ? raw.NextToken : null;
      return {
        ok: true,
        data: {
          command: result.command,
          typeName: i.typeName,
          resources,
          nextToken,
          hasMore: nextToken !== null,
        },
      };
    },
  },

  {
    name: "aws_resource_create",
    description:
      "Create an AWS resource via Cloud Control API. Async: returns a ProgressEvent with OperationStatus=IN_PROGRESS and a `RequestToken`. Poll aws_resource_status with the token until status is SUCCESS or FAILED. `desiredState` is the resource properties JSON matching the CloudFormation schema for `typeName`.",
    annotations: {
      title: "Create an AWS resource (async via CCAPI)",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      typeName: z.string().describe("CloudFormation type name, e.g. 'AWS::SSM::Parameter'."),
      desiredState: z
        .record(z.string(), z.unknown())
        .describe(
          "Resource properties matching the CFN schema. E.g. for AWS::SSM::Parameter: {Name: '/my/param', Type: 'String', Value: 'hello'}.",
        ),
      clientToken: z
        .string()
        .optional()
        .describe("Idempotency token (max 128 chars). Prevents duplicate creation on retry."),
      ...baseFields,
    }),
    handler: async (input: unknown): Promise<ToolResult> => {
      const i = input as {
        typeName: string;
        desiredState: Record<string, unknown>;
        clientToken?: string;
        profile?: string;
        region?: string;
        timeoutMs?: number;
      };
      const tnErr = validateTypeName(i.typeName);
      if (tnErr) return { ok: false, error: tnErr };
      if (i.clientToken !== undefined) {
        const ctErr = validateOpaqueToken(i.clientToken, "clientToken");
        if (ctErr) return { ok: false, error: ctErr };
      }

      const extraFlags: string[] = ["--type-name", i.typeName, "--desired-state", JSON.stringify(i.desiredState)];
      if (i.clientToken) extraFlags.push("--client-token", i.clientToken);

      const result = await runAwsCall({
        service: "cloudcontrol",
        operation: "create-resource",
        profile: i.profile,
        region: i.region,
        timeoutMs: i.timeoutMs,
        outputFormat: "json",
        extraFlags,
      });

      if (!result.ok) {
        return { ok: false, error: result.error, rawBody: result.rawStderr ?? result.rawStdout };
      }

      const raw = result.data as { ProgressEvent?: Record<string, unknown> } | null;
      return {
        ok: true,
        data: { command: result.command, progressEvent: raw?.ProgressEvent ?? null },
      };
    },
  },

  {
    name: "aws_resource_update",
    description:
      "Update an AWS resource via Cloud Control API using RFC 6902 JSON Patch. Async: returns a ProgressEvent with OperationStatus=IN_PROGRESS. Poll aws_resource_status until complete. Typical patch: [{op: 'replace', path: '/MemorySize', value: 512}].",
    annotations: {
      title: "Update an AWS resource (async via CCAPI)",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      typeName: z.string().describe("CloudFormation type name."),
      identifier: z.string().min(1).describe("Primary identifier for the resource."),
      patchDocument: z
        .array(
          z.object({
            op: z.enum(["add", "remove", "replace", "move", "copy", "test"]),
            path: z.string(),
            value: z.unknown().optional(),
            from: z.string().optional(),
          }),
        )
        .min(1)
        .describe("RFC 6902 JSON Patch document (array of operations). At least one entry."),
      clientToken: z.string().optional().describe("Idempotency token (max 128 chars)."),
      ...baseFields,
    }),
    handler: async (input: unknown): Promise<ToolResult> => {
      const i = input as {
        typeName: string;
        identifier: string;
        patchDocument: unknown[];
        clientToken?: string;
        profile?: string;
        region?: string;
        timeoutMs?: number;
      };
      const tnErr = validateTypeName(i.typeName);
      if (tnErr) return { ok: false, error: tnErr };
      const idErr = validateIdentifier(i.identifier);
      if (idErr) return { ok: false, error: idErr };
      if (i.clientToken !== undefined) {
        const ctErr = validateOpaqueToken(i.clientToken, "clientToken");
        if (ctErr) return { ok: false, error: ctErr };
      }

      const extraFlags: string[] = [
        "--type-name",
        i.typeName,
        "--identifier",
        i.identifier,
        "--patch-document",
        JSON.stringify(i.patchDocument),
      ];
      if (i.clientToken) extraFlags.push("--client-token", i.clientToken);

      const result = await runAwsCall({
        service: "cloudcontrol",
        operation: "update-resource",
        profile: i.profile,
        region: i.region,
        timeoutMs: i.timeoutMs,
        outputFormat: "json",
        extraFlags,
      });

      if (!result.ok) {
        return { ok: false, error: result.error, rawBody: result.rawStderr ?? result.rawStdout };
      }

      const raw = result.data as { ProgressEvent?: Record<string, unknown> } | null;
      return {
        ok: true,
        data: { command: result.command, progressEvent: raw?.ProgressEvent ?? null },
      };
    },
  },

  {
    name: "aws_resource_delete",
    description:
      "Delete an AWS resource via Cloud Control API. Async: returns a ProgressEvent with OperationStatus=IN_PROGRESS. Poll aws_resource_status until complete. Destructive -- double-check `identifier` before calling.",
    annotations: {
      title: "Delete an AWS resource (async via CCAPI)",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      typeName: z.string().describe("CloudFormation type name."),
      identifier: z.string().min(1).describe("Primary identifier for the resource."),
      clientToken: z.string().optional().describe("Idempotency token (max 128 chars)."),
      ...baseFields,
    }),
    handler: async (input: unknown): Promise<ToolResult> => {
      const i = input as {
        typeName: string;
        identifier: string;
        clientToken?: string;
        profile?: string;
        region?: string;
        timeoutMs?: number;
      };
      const tnErr = validateTypeName(i.typeName);
      if (tnErr) return { ok: false, error: tnErr };
      const idErr = validateIdentifier(i.identifier);
      if (idErr) return { ok: false, error: idErr };
      if (i.clientToken !== undefined) {
        const ctErr = validateOpaqueToken(i.clientToken, "clientToken");
        if (ctErr) return { ok: false, error: ctErr };
      }

      const extraFlags: string[] = ["--type-name", i.typeName, "--identifier", i.identifier];
      if (i.clientToken) extraFlags.push("--client-token", i.clientToken);

      const result = await runAwsCall({
        service: "cloudcontrol",
        operation: "delete-resource",
        profile: i.profile,
        region: i.region,
        timeoutMs: i.timeoutMs,
        outputFormat: "json",
        extraFlags,
      });

      if (!result.ok) {
        return { ok: false, error: result.error, rawBody: result.rawStderr ?? result.rawStdout };
      }

      const raw = result.data as { ProgressEvent?: Record<string, unknown> } | null;
      return {
        ok: true,
        data: { command: result.command, progressEvent: raw?.ProgressEvent ?? null },
      };
    },
  },

  {
    name: "aws_resource_status",
    description:
      "Poll the status of an async Cloud Control API request (create/update/delete). Pass the `requestToken` returned by those tools. Returns the current ProgressEvent with OperationStatus: PENDING | IN_PROGRESS | SUCCESS | FAILED | CANCEL_IN_PROGRESS | CANCEL_COMPLETE.",
    annotations: {
      title: "Get the status of an async CCAPI request",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      requestToken: z.string().min(1).describe("RequestToken from a previous create/update/delete call."),
      ...baseFields,
    }),
    handler: async (input: unknown): Promise<ToolResult> => {
      const i = input as { requestToken: string; profile?: string; region?: string; timeoutMs?: number };
      const rtErr = validateOpaqueToken(i.requestToken, "requestToken");
      if (rtErr) return { ok: false, error: rtErr };

      const result = await runAwsCall({
        service: "cloudcontrol",
        operation: "get-resource-request-status",
        profile: i.profile,
        region: i.region,
        timeoutMs: i.timeoutMs,
        outputFormat: "json",
        extraFlags: ["--request-token", i.requestToken],
      });

      if (!result.ok) {
        return { ok: false, error: result.error, rawBody: result.rawStderr ?? result.rawStdout };
      }

      const raw = result.data as { ProgressEvent?: Record<string, unknown> } | null;
      return {
        ok: true,
        data: { command: result.command, progressEvent: raw?.ProgressEvent ?? null },
      };
    },
  },
];
