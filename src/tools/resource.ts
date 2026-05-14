import { z } from "zod";
import { type AwsCallFailureKind, type AwsCallResult, runAwsCall } from "../aws-cli.js";
import { getProfile } from "../session.js";
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
 * RequestToken. By default we surface that event and let the caller poll via
 * aws_resource_status. Pass `awaitCompletion: true` to have the server poll on
 * the caller's behalf until the operation reaches SUCCESS / FAILED /
 * CANCEL_COMPLETE -- one tool call covers the full lifecycle.
 *
 * Every CCAPI response also flat-promotes the most useful ProgressEvent fields
 * (`requestToken`, `operationStatus`, `identifier`, `errorCode`,
 * `statusMessage`, `retryAfter`) to the top level, alongside the raw event.
 * That spares callers a second round-trip just to drill into the envelope.
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

/**
 * CCAPI ProgressEvent terminal states. Anything else (PENDING, IN_PROGRESS,
 * CANCEL_IN_PROGRESS) is still in flight.
 */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["SUCCESS", "FAILED", "CANCEL_COMPLETE"]);

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_WAIT_MS = 5 * 60_000;
const MIN_POLL_INTERVAL_MS = 500;
const MAX_POLL_INTERVAL_MS = 30_000;
const MIN_MAX_WAIT_MS = 1_000;
const MAX_MAX_WAIT_MS = 30 * 60_000;

export interface ProgressFields {
  requestToken: string | null;
  operationStatus: string | null;
  identifier: string | null;
  errorCode: string | null;
  statusMessage: string | null;
  retryAfter: string | null;
}

/**
 * Pull the fields callers actually want off a raw ProgressEvent. Returns null
 * for anything missing or non-string so the response shape is predictable.
 */
export function extractProgressFields(progressEvent: unknown): ProgressFields {
  const pe = progressEvent && typeof progressEvent === "object" ? (progressEvent as Record<string, unknown>) : {};
  const str = (k: string): string | null => {
    const v = pe[k];
    return typeof v === "string" && v.length > 0 ? v : null;
  };
  return {
    requestToken: str("RequestToken"),
    operationStatus: str("OperationStatus"),
    identifier: str("Identifier"),
    errorCode: str("ErrorCode"),
    statusMessage: str("StatusMessage"),
    retryAfter: str("RetryAfter"),
  };
}

interface PollResult {
  ok: boolean;
  progressEvent: Record<string, unknown> | null;
  command: string;
  attempts: number;
  elapsedMs: number;
  error?: string;
  // Mirrors AwsCallFailureKind from runAwsCall when the underlying CLI call
  // fails. buildMutationResponse uses this to enrich the message with a
  // "re-login then check aws_resource_status with requestToken='X'" hint
  // when the auth lapsed mid-flight; the mutation may still complete
  // server-side regardless.
  kind?: AwsCallFailureKind;
  rawBody?: string;
}

type AwsCaller = typeof runAwsCall | ((opts: Parameters<typeof runAwsCall>[0]) => Promise<AwsCallResult>);

/**
 * Loop `cloudcontrol get-resource-request-status` until the operation reaches
 * a terminal state, runs out of budget, or the CLI errors. Honors the
 * ProgressEvent.RetryAfter hint when present, otherwise paces with
 * `pollIntervalMs`. Always caps the wait at the remaining maxWaitMs budget so
 * we don't overshoot.
 *
 * Exposed with an injectable `awsCall` argument purely so unit tests can drive
 * the loop with scripted responses; production code uses the default.
 */
export async function pollUntilTerminal(
  opts: {
    requestToken: string;
    profile?: string;
    region?: string;
    timeoutMs?: number;
    pollIntervalMs: number;
    maxWaitMs: number;
  },
  awsCall: AwsCaller = runAwsCall,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<PollResult> {
  const start = Date.now();
  let attempts = 0;
  let lastEvent: Record<string, unknown> | null = null;
  let lastCommand = "";
  while (true) {
    attempts++;
    const result = await awsCall({
      service: "cloudcontrol",
      operation: "get-resource-request-status",
      profile: opts.profile,
      region: opts.region,
      timeoutMs: opts.timeoutMs,
      outputFormat: "json",
      extraFlags: ["--request-token", opts.requestToken],
    });
    if (!result.ok) {
      return {
        ok: false,
        progressEvent: lastEvent,
        command: result.command ?? lastCommand,
        attempts,
        elapsedMs: Date.now() - start,
        error: result.error,
        kind: result.kind,
        rawBody: result.rawStderr ?? result.rawStdout,
      };
    }
    lastCommand = result.command;
    const raw = result.data as { ProgressEvent?: Record<string, unknown> } | null;
    lastEvent = raw?.ProgressEvent ?? null;
    const status =
      lastEvent && typeof lastEvent.OperationStatus === "string" ? (lastEvent.OperationStatus as string) : null;
    if (status && TERMINAL_STATUSES.has(status)) {
      return { ok: true, progressEvent: lastEvent, command: lastCommand, attempts, elapsedMs: Date.now() - start };
    }
    const elapsed = Date.now() - start;
    if (elapsed >= opts.maxWaitMs) {
      return {
        ok: false,
        progressEvent: lastEvent,
        command: lastCommand,
        attempts,
        elapsedMs: elapsed,
        error: `Polled for ${Math.round(elapsed / 1000)}s without reaching a terminal state (last status: ${status ?? "unknown"}). Increase maxWaitMs, or call aws_resource_status with requestToken='${opts.requestToken}' to keep checking.`,
      };
    }
    let waitMs = opts.pollIntervalMs;
    const retryAfterRaw =
      lastEvent && typeof lastEvent.RetryAfter === "string" ? (lastEvent.RetryAfter as string) : null;
    if (retryAfterRaw) {
      const target = Date.parse(retryAfterRaw);
      if (!Number.isNaN(target)) {
        const ra = target - Date.now();
        if (ra > 0) waitMs = ra;
      }
    }
    waitMs = Math.min(waitMs, opts.maxWaitMs - elapsed);
    if (waitMs > 0) await sleep(waitMs);
  }
}

/**
 * Shared mutation post-processing: flat-promote ProgressEvent fields, and
 * (when awaitCompletion is set) poll until terminal so the caller doesn't
 * have to. Either way, the raw `progressEvent` is preserved alongside the
 * flat fields for callers that need extra context.
 */
async function buildMutationResponse(
  initial: { command: string; data: unknown },
  i: {
    profile?: string;
    region?: string;
    timeoutMs?: number;
    awaitCompletion?: boolean;
    pollIntervalMs?: number;
    maxWaitMs?: number;
  },
): Promise<ToolResult> {
  const raw = initial.data as { ProgressEvent?: Record<string, unknown> } | null;
  const progressEvent = raw?.ProgressEvent ?? null;
  const fields = extractProgressFields(progressEvent);
  const initialStatus = fields.operationStatus ?? "";
  const alreadyTerminal = TERMINAL_STATUSES.has(initialStatus);

  if (i.awaitCompletion && fields.requestToken && !alreadyTerminal) {
    const polled = await pollUntilTerminal({
      requestToken: fields.requestToken,
      profile: i.profile,
      region: i.region,
      timeoutMs: i.timeoutMs,
      pollIntervalMs: i.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      maxWaitMs: i.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
    });
    if (!polled.ok) {
      // Auth-class failures during the poll loop deserve a recovery hint that
      // includes the requestToken: the underlying mutation may still
      // complete server-side, so after re-logging in the caller can check
      // its final state via aws_resource_status. Without this, the bare
      // poll error buries the recovery path in stderr text.
      if (polled.kind === "sso_expired" || polled.kind === "no_creds") {
        const useProfile = i.profile ?? getProfile();
        const reLoginHint =
          polled.kind === "sso_expired"
            ? `SSO session expired while awaiting completion. Call aws_login_start with profile='${useProfile}' to re-authenticate, then call aws_resource_status with requestToken='${fields.requestToken}' to check whether the mutation completed server-side.`
            : `No credentials available while awaiting completion. After fixing credentials for profile '${useProfile}', call aws_resource_status with requestToken='${fields.requestToken}' to check whether the mutation completed server-side. Underlying error: ${polled.error}`;
        return { ok: false, error: reLoginHint, rawBody: polled.rawBody };
      }
      return { ok: false, error: polled.error ?? "Poll failed", rawBody: polled.rawBody };
    }
    const finalFields = extractProgressFields(polled.progressEvent);
    return {
      ok: true,
      data: {
        command: polled.command,
        ...finalFields,
        progressEvent: polled.progressEvent,
        awaited: { attempts: polled.attempts, elapsedMs: polled.elapsedMs },
      },
    };
  }

  return {
    ok: true,
    data: { command: initial.command, ...fields, progressEvent },
  };
}

const baseFields = {
  profile: z.string().optional().describe("Override session profile for this call."),
  region: z.string().optional().describe("Override session region for this call."),
  timeoutMs: z.number().int().positive().optional().describe("Timeout in milliseconds. Default 60000."),
};

const awaitFields = {
  awaitCompletion: z
    .boolean()
    .optional()
    .describe(
      "If true, poll get-resource-request-status until the operation reaches SUCCESS / FAILED / CANCEL_COMPLETE and return the final ProgressEvent. Default false (returns immediately with IN_PROGRESS, caller polls via aws_resource_status).",
    ),
  pollIntervalMs: z
    .number()
    .int()
    .min(MIN_POLL_INTERVAL_MS)
    .max(MAX_POLL_INTERVAL_MS)
    .optional()
    .describe(
      `Poll interval in ms when awaitCompletion is true (range ${MIN_POLL_INTERVAL_MS}-${MAX_POLL_INTERVAL_MS}). Default ${DEFAULT_POLL_INTERVAL_MS}. ProgressEvent.RetryAfter overrides when CCAPI returns one.`,
    ),
  maxWaitMs: z
    .number()
    .int()
    .min(MIN_MAX_WAIT_MS)
    .max(MAX_MAX_WAIT_MS)
    .optional()
    .describe(
      `Maximum total wait in ms when awaitCompletion is true (range ${MIN_MAX_WAIT_MS}-${MAX_MAX_WAIT_MS}). Default ${DEFAULT_MAX_WAIT_MS}. On timeout, returns the last seen status with a hint to keep polling.`,
    ),
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
      "Create an AWS resource via Cloud Control API. Async by default: returns a ProgressEvent with OperationStatus=IN_PROGRESS and a `requestToken` (top-level) -- poll aws_resource_status with that token, or pass `awaitCompletion: true` to have the server poll for you and return the terminal event. `desiredState` is the resource properties JSON matching the CloudFormation schema for `typeName`.",
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
      ...awaitFields,
    }),
    handler: async (input: unknown): Promise<ToolResult> => {
      const i = input as {
        typeName: string;
        desiredState: Record<string, unknown>;
        clientToken?: string;
        profile?: string;
        region?: string;
        timeoutMs?: number;
        awaitCompletion?: boolean;
        pollIntervalMs?: number;
        maxWaitMs?: number;
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

      return buildMutationResponse({ command: result.command, data: result.data }, i);
    },
  },

  {
    name: "aws_resource_update",
    description:
      "Update an AWS resource via Cloud Control API using RFC 6902 JSON Patch. Async by default: returns a ProgressEvent with OperationStatus=IN_PROGRESS and a top-level `requestToken`. Pass `awaitCompletion: true` to have the server poll until terminal. Typical patch: [{op: 'replace', path: '/MemorySize', value: 512}].",
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
      ...awaitFields,
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
        awaitCompletion?: boolean;
        pollIntervalMs?: number;
        maxWaitMs?: number;
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

      return buildMutationResponse({ command: result.command, data: result.data }, i);
    },
  },

  {
    name: "aws_resource_delete",
    description:
      "Delete an AWS resource via Cloud Control API. Async by default: returns a ProgressEvent with OperationStatus=IN_PROGRESS and a top-level `requestToken`. Pass `awaitCompletion: true` to have the server poll until terminal. Destructive -- double-check `identifier` before calling.",
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
      ...awaitFields,
    }),
    handler: async (input: unknown): Promise<ToolResult> => {
      const i = input as {
        typeName: string;
        identifier: string;
        clientToken?: string;
        profile?: string;
        region?: string;
        timeoutMs?: number;
        awaitCompletion?: boolean;
        pollIntervalMs?: number;
        maxWaitMs?: number;
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

      return buildMutationResponse({ command: result.command, data: result.data }, i);
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
      const progressEvent = raw?.ProgressEvent ?? null;
      const fields = extractProgressFields(progressEvent);
      return {
        ok: true,
        data: { command: result.command, ...fields, progressEvent },
      };
    },
  },

  {
    name: "aws_resource_diff",
    description:
      "Dry-run a CCAPI update: fetch the current resource state, simulate applying a JSON Patch in memory, and return before/after plus a flat list of changed paths. No mutation is sent to AWS. Use this before aws_resource_update to verify the patch does what you expect. Supports the add/remove/replace subset of RFC 6902 (covers the vast majority of CCAPI updates); 'move'/'copy'/'test' are not implemented and fail with a clear error.",
    annotations: {
      title: "Preview a CCAPI update without applying it",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      typeName: z.string().describe("CloudFormation type name, e.g. 'AWS::Lambda::Function'."),
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
        .describe("RFC 6902 JSON Patch (the same shape aws_resource_update accepts)."),
      ...baseFields,
    }),
    handler: async (input: unknown): Promise<ToolResult> => {
      const i = input as {
        typeName: string;
        identifier: string;
        patchDocument: JsonPatchOp[];
        profile?: string;
        region?: string;
        timeoutMs?: number;
      };
      const tnErr = validateTypeName(i.typeName);
      if (tnErr) return { ok: false, error: tnErr };
      const idErr = validateIdentifier(i.identifier);
      if (idErr) return { ok: false, error: idErr };

      const getResult = await runAwsCall({
        service: "cloudcontrol",
        operation: "get-resource",
        profile: i.profile,
        region: i.region,
        timeoutMs: i.timeoutMs,
        outputFormat: "json",
        extraFlags: ["--type-name", i.typeName, "--identifier", i.identifier],
      });
      if (!getResult.ok) {
        return { ok: false, error: getResult.error, rawBody: getResult.rawStderr ?? getResult.rawStdout };
      }
      const raw = getResult.data as { ResourceDescription?: unknown } | null;
      const parsed = parseResourceProperties(raw?.ResourceDescription);
      const before = parsed.Properties;

      let after: unknown;
      try {
        after = applyJsonPatch(before, i.patchDocument);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `Patch application failed: ${msg}` };
      }

      const changes = summarizePatch(i.patchDocument, before, after);

      return {
        ok: true,
        data: {
          command: getResult.command,
          typeName: i.typeName,
          identifier: parsed.Identifier ?? i.identifier,
          before,
          after,
          changes,
          changeCount: changes.length,
        },
      };
    },
  },
];

/**
 * RFC 6902 JSON Patch (subset) -- only add/remove/replace. move/copy/test
 * are intentionally unimplemented; CCAPI updates use the basic three in
 * practice and the move/copy semantics require extra round-trips through
 * the path resolver that aren't worth the complexity for a preview tool.
 */
export interface JsonPatchOp {
  op: "add" | "remove" | "replace" | "move" | "copy" | "test";
  path: string;
  value?: unknown;
  from?: string;
}

/**
 * Parse an RFC 6901 JSON Pointer into a token array. "/foo/bar" -> ["foo","bar"].
 * Empty string is the root (returns []). Escapes: `~1` -> `/`, `~0` -> `~`,
 * applied in that order.
 */
export function parseJsonPointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    throw new Error(`Invalid JSON Pointer '${pointer}': must start with '/' or be empty.`);
  }
  return pointer
    .slice(1)
    .split("/")
    .map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Apply a JSON Patch document to `original` and return a fresh deep-cloned
 * result. Original is not mutated. Throws on bad paths, unimplemented ops,
 * or array-bounds violations -- callers catch and translate.
 */
export function applyJsonPatch(original: unknown, ops: readonly JsonPatchOp[]): unknown {
  let doc = clone(original);
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.op === "move" || op.op === "copy" || op.op === "test") {
      throw new Error(`op '${op.op}' at index ${i} is not implemented in aws_resource_diff (use add/remove/replace).`);
    }
    const tokens = parseJsonPointer(op.path);
    if (tokens.length === 0) {
      // Whole-document replace/add/remove.
      if (op.op === "remove") {
        throw new Error(`Cannot remove the document root at index ${i}.`);
      }
      doc = clone(op.value);
      continue;
    }
    const parentTokens = tokens.slice(0, -1);
    const lastToken = tokens[tokens.length - 1];

    // Walk to the parent, creating nothing along the way -- if an
    // intermediate segment is missing, the patch is malformed.
    let parent: unknown = doc;
    for (let t = 0; t < parentTokens.length; t++) {
      const segment = parentTokens[t];
      if (Array.isArray(parent)) {
        const idx = Number.parseInt(segment, 10);
        if (!Number.isInteger(idx) || idx < 0 || idx >= parent.length) {
          throw new Error(`Path '${op.path}' segment '${segment}' is out of array bounds at index ${i}.`);
        }
        parent = parent[idx];
      } else if (isObj(parent)) {
        if (!(segment in parent)) {
          throw new Error(`Path '${op.path}' segment '${segment}' does not exist at index ${i}.`);
        }
        parent = parent[segment];
      } else {
        throw new Error(`Path '${op.path}' traverses a non-container value at index ${i}.`);
      }
    }

    if (Array.isArray(parent)) {
      // Array semantics: "-" means "after the last element"; otherwise the
      // last token must be a non-negative integer.
      if (lastToken === "-") {
        if (op.op === "remove") {
          throw new Error(`Cannot remove '-' (end-of-array) at index ${i}.`);
        }
        parent.push(clone(op.value));
        continue;
      }
      const idx = Number.parseInt(lastToken, 10);
      if (!Number.isInteger(idx) || idx < 0) {
        throw new Error(`Path '${op.path}' has non-integer array index '${lastToken}' at index ${i}.`);
      }
      if (op.op === "add") {
        if (idx > parent.length) {
          throw new Error(`Add index ${idx} out of bounds for array of length ${parent.length} at index ${i}.`);
        }
        parent.splice(idx, 0, clone(op.value));
      } else if (op.op === "remove") {
        if (idx >= parent.length) {
          throw new Error(`Remove index ${idx} out of bounds for array of length ${parent.length} at index ${i}.`);
        }
        parent.splice(idx, 1);
      } else {
        // replace
        if (idx >= parent.length) {
          throw new Error(`Replace index ${idx} out of bounds for array of length ${parent.length} at index ${i}.`);
        }
        parent[idx] = clone(op.value);
      }
    } else if (isObj(parent)) {
      if (op.op === "remove") {
        if (!(lastToken in parent)) {
          throw new Error(`Cannot remove missing key '${lastToken}' at index ${i}.`);
        }
        delete parent[lastToken];
      } else if (op.op === "replace") {
        if (!(lastToken in parent)) {
          throw new Error(`Cannot replace missing key '${lastToken}' at index ${i} (use 'add' to create it).`);
        }
        parent[lastToken] = clone(op.value);
      } else {
        // add: creates or overwrites
        parent[lastToken] = clone(op.value);
      }
    } else {
      throw new Error(`Path '${op.path}' parent is not a container at index ${i}.`);
    }
  }
  return doc;
}

export interface PatchChange {
  op: "add" | "remove" | "replace";
  path: string;
  before?: unknown;
  after?: unknown;
}

/**
 * Walk the patch and resolve the before/after value at each op's path so the
 * agent gets a compact diff list without having to compare full Properties
 * trees by hand. For ops we don't implement, the entry surfaces the op name
 * verbatim with no before/after.
 */
export function summarizePatch(ops: readonly JsonPatchOp[], before: unknown, after: unknown): PatchChange[] {
  const out: PatchChange[] = [];
  for (const op of ops) {
    if (op.op === "move" || op.op === "copy" || op.op === "test") {
      // Surface as a no-op for visibility; applyJsonPatch already threw on
      // these so we only reach this branch if a caller calls summarizePatch
      // directly (e.g. for tests).
      out.push({ op: "replace", path: op.path });
      continue;
    }
    const beforeAt = resolvePointer(before, op.path);
    let afterAt = resolvePointer(after, op.path);
    // RFC 6901 reserves "-" as the position past the last array element. It
    // names a target slot, not a value, so resolvePointer naturally returns
    // undefined -- leaving the changes entry useless for `add /Tags/-`-style
    // appends. Fall back to the op's own value: that IS the value that just
    // landed at the end of the array.
    if (op.op === "add" && afterAt === undefined && op.path.endsWith("/-")) {
      afterAt = op.value;
    }
    out.push({ op: op.op, path: op.path, before: beforeAt, after: afterAt });
  }
  return out;
}

/**
 * Resolve a JSON Pointer against a document, returning undefined for any
 * missing segment. Used by summarizePatch to fetch before/after values
 * without throwing on missing keys -- a 'remove' op naturally has no
 * after value.
 */
export function resolvePointer(doc: unknown, pointer: string): unknown {
  let tokens: string[];
  try {
    tokens = parseJsonPointer(pointer);
  } catch {
    return undefined;
  }
  let cur: unknown = doc;
  for (const t of tokens) {
    if (Array.isArray(cur)) {
      if (t === "-") return undefined;
      const idx = Number.parseInt(t, 10);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
    } else if (isObj(cur)) {
      if (!(t in cur)) return undefined;
      cur = cur[t];
    } else {
      return undefined;
    }
  }
  return cur;
}
