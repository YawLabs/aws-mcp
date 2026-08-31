import { z } from "zod";
import { type AwsCallFailure, type AwsCallFailureKind, type AwsCallResult, runAwsCall } from "../aws-cli.js";
import { getProfile } from "../session.js";
import { extractNextToken } from "./paginate.js";
import type { Tool, ToolContext, ToolResult } from "./tool.js";

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
 * Opaque-token validator for RequestToken and ClientToken -- and ONLY those
 * two. AWS docs cap both at 128 chars. Only enforce argv-safety + bounded
 * length.
 *
 * Explicitly not for pagination cursors. A CCAPI NextToken is a different
 * thing that happens to be another opaque string: AWS documents ListResources
 * NextToken at up to 2048 chars, and real ones are base64 blobs well past 128.
 * Cursors go through `validateCursorToken` below.
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

export function validateOpaqueToken(token: string, fieldName: string): string | null {
  if (!isValidOpaqueToken(token)) {
    return `Invalid ${fieldName}. Must be 1-128 chars, not start with '-', and contain no control characters.`;
  }
  return null;
}

/**
 * Argv-safety guard for PAGINATION cursors (CCAPI `nextToken`, the CLI's
 * `--starting-token`). Same leading-hyphen / control-char defense as
 * `validateOpaqueToken`, but bounded at 2048 rather than 128: these carry a
 * base64 continuation blob, not a request id. The 128 cap was borrowed from
 * the RequestToken/ClientToken limit and rejected page 2 of every list -- an
 * entirely expected input failing loudly.
 */
export function validateCursorToken(token: string, fieldName: string): string | null {
  if (!isValidIdentifier(token)) {
    return `Invalid ${fieldName}. Must be 1-2048 chars, not start with '-', and contain no control characters.`;
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

interface ProgressFields {
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

/**
 * Pick the diagnostic body off a failed CLI call. Truthiness, not `??`: an
 * EMPTY-STRING stderr is "no stderr", and `??` would hand back that empty
 * string and drop a stdout body that does carry the diagnostic. Some `aws`
 * invocations route their message to stdout on a nonzero exit (a wrapper
 * swallowing stderr, stderr closed). Same rule aws_call documents at
 * call.ts:80.
 */
function rawBodyOf(result: AwsCallFailure): string | undefined {
  return result.rawStderr ? result.rawStderr : result.rawStdout;
}

/**
 * Every verb in this file shells the same way -- service "cloudcontrol", JSON
 * output, session profile/region/timeout passed through. One helper so a new
 * verb can't drift from the others, and so the failure shape below is written
 * once instead of seven times.
 */
async function ccapiCall(
  operation: string,
  extraFlags: string[],
  i: { profile?: string; region?: string; timeoutMs?: number },
): Promise<AwsCallResult> {
  return runAwsCall({
    service: "cloudcontrol",
    operation,
    profile: i.profile,
    region: i.region,
    timeoutMs: i.timeoutMs,
    outputFormat: "json",
    extraFlags,
  });
}

/** The one failure shape for a failed `ccapiCall`. Typed on the failure arm, so callers must narrow first. */
function ccapiFailure(result: AwsCallFailure): ToolResult {
  return { ok: false, error: result.error, rawBody: rawBodyOf(result) };
}

/**
 * Shared handler preamble: argv-safety on the free-text fields every CCAPI
 * verb shares. Returns the first error message, or null when the input is
 * clean. `identifier` and `clientToken` are checked only when present, so the
 * verbs that don't take them can call this unchanged.
 */
function validateCommonFields(i: { typeName: string; identifier?: string; clientToken?: string }): string | null {
  const tnErr = validateTypeName(i.typeName);
  if (tnErr) return tnErr;
  if (i.identifier !== undefined) {
    const idErr = validateIdentifier(i.identifier);
    if (idErr) return idErr;
  }
  if (i.clientToken !== undefined) {
    const ctErr = validateOpaqueToken(i.clientToken, "clientToken");
    if (ctErr) return ctErr;
  }
  return null;
}

/** Pull the ProgressEvent out of a CCAPI mutation/status response body. */
function unwrapProgressEvent(data: unknown): Record<string, unknown> | null {
  const raw = data as { ProgressEvent?: Record<string, unknown> } | null;
  return raw?.ProgressEvent ?? null;
}

/**
 * The shared success shape for anything that returns a ProgressEvent: the
 * command, the flat-promoted fields, and the raw event. `extra` carries the
 * extra keys the awaited path adds.
 */
function progressResponse(
  command: string,
  progressEvent: Record<string, unknown> | null,
  extra?: Record<string, unknown>,
): ToolResult {
  return {
    ok: true,
    data: { command, ...extractProgressFields(progressEvent), progressEvent, ...extra },
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
  /**
   * True when the loop stopped because the CLIENT cancelled the request
   * (ctx.signal aborted), not because the operation finished or the budget ran
   * out. Distinct from every other `ok: false` arm: nothing failed, and the
   * AWS-side operation is still running -- see the message `cancelledResult`
   * builds.
   */
  cancelled?: boolean;
}

/**
 * The shape `pollUntilTerminal` needs from its caller: `runAwsCall` itself, or
 * a test double with the same signature. This used to be a union of
 * `typeof runAwsCall` and this signature, but the second member subsumes the
 * first -- `runAwsCall` already satisfies it -- so the union was one type
 * written twice.
 */
type AwsCaller = (opts: Parameters<typeof runAwsCall>[0]) => Promise<AwsCallResult>;

/**
 * Default pacing between polls: an ordinary timer that ALSO resolves early
 * when the client cancels.
 *
 * The abort wiring is not decoration. `pollIntervalMs` goes up to 30s and
 * ProgressEvent.RetryAfter can push a single wait higher still, so a
 * cancellation that arrives one tick into a sleep would otherwise sit
 * unobserved for the rest of it -- "stop promptly" has to cover the sleep, not
 * just the check at the top of the loop.
 *
 * Resolving (rather than rejecting) on abort keeps the cancellation decision in
 * ONE place: the loop's own `signal.aborted` check, which knows how to build
 * the result. A rejecting sleep would need a second, duplicate handler here.
 *
 * `signal` is optional so the scripted `(ms) => void` doubles the tests inject
 * still satisfy the parameter type.
 */
function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Loop `cloudcontrol get-resource-request-status` until the operation reaches
 * a terminal state, runs out of budget, or the CLI errors. Honors the
 * ProgressEvent.RetryAfter hint when present, otherwise paces with
 * `pollIntervalMs`. Always caps the wait at the remaining maxWaitMs budget so
 * we don't overshoot.
 *
 * Budget is checked BEFORE each call rather than after it. The old order
 * (sleep to the remaining budget, then call at the loop top, then check
 * elapsed) always spent one extra AWS call past maxWaitMs: the final sleep
 * lands exactly on the budget, and the loop then re-entered and called
 * anyway.
 *
 * One-shot guarantee, preserved: the check is skipped on the first pass, so
 * the loop never returns without making at least one request. A
 * maxWaitMs <= elapsed (notably maxWaitMs of 0, which a direct internal caller
 * can pass -- the tool path's Zod floor of MIN_MAX_WAIT_MS only guards the
 * public surface) returns ok:false after exactly one call, surfacing whatever
 * status that single poll observed.
 *
 * Reports one progress update per poll attempt when `opts.ctx` is present, and
 * stops early if `ctx.signal` aborts -- this is the longest-running path in the
 * server (up to 30 minutes), so a caller left with no output at all cannot tell
 * it from a hung process.
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
    // Rides in the opts bag rather than a fourth positional parameter: the
    // production caller passes opts alone and takes the awsCall/sleep
    // defaults, so a trailing parameter would force it to re-state both just
    // to reach the context.
    ctx?: ToolContext;
  },
  awsCall: AwsCaller = runAwsCall,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void> = sleepUnlessAborted,
): Promise<PollResult> {
  const start = Date.now();
  let attempts = 0;
  let lastEvent: Record<string, unknown> | null = null;
  let lastCommand = "";
  let lastStatus: string | null = null;
  const outOfBudget = (): PollResult => {
    const elapsed = Date.now() - start;
    return {
      ok: false,
      progressEvent: lastEvent,
      command: lastCommand,
      attempts,
      elapsedMs: elapsed,
      error: `Polled for ${Math.round(elapsed / 1000)}s without reaching a terminal state (last status: ${lastStatus ?? "unknown"}). Increase maxWaitMs, or call aws_resource_status with requestToken='${opts.requestToken}' to keep checking.`,
    };
  };
  // The client hung up. Deliberately NOT phrased as a success or as a plain
  // failure: nothing went wrong, we simply stopped watching, and the AWS-side
  // operation is still running -- so the message says so and hands back the
  // requestToken to resume with.
  const cancelledResult = (): PollResult => {
    const elapsed = Date.now() - start;
    return {
      ok: false,
      cancelled: true,
      progressEvent: lastEvent,
      command: lastCommand,
      attempts,
      elapsedMs: elapsed,
      error: `Cancelled by the client after ${Math.round(elapsed / 1000)}s and ${attempts} poll(s) (last status: ${lastStatus ?? "unknown"}). Polling stopped; the AWS operation itself was NOT cancelled and is likely still running -- call aws_resource_status with requestToken='${opts.requestToken}' to check how it ended.`,
    };
  };
  while (true) {
    // Cancellation outranks the budget check, and unlike it applies on the
    // FIRST pass too: the one-shot guarantee exists so a caller always gets a
    // result, and a cancelled request has no caller left to receive one.
    if (opts.ctx?.signal?.aborted) return cancelledResult();
    // Budget first, call second -- `attempts > 0` keeps the one-shot
    // guarantee for the first pass. Checking after the call meant the loop
    // always burned one request past maxWaitMs.
    if (attempts > 0 && Date.now() - start >= opts.maxWaitMs) return outOfBudget();
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
        rawBody: rawBodyOf(result),
      };
    }
    lastCommand = result.command;
    lastEvent = unwrapProgressEvent(result.data);
    lastStatus =
      lastEvent && typeof lastEvent.OperationStatus === "string" ? (lastEvent.OperationStatus as string) : null;
    const elapsed = Date.now() - start;
    // One report per attempt, AFTER the call returns so the message can name
    // the status this attempt actually observed rather than the previous one.
    // No `total`: the loop ends when AWS says the operation is done, so any
    // denominator would be invented (maxWaitMs bounds the WAIT, not the work).
    // `attempts` is the progress value, and it only ever increments -- the
    // monotonicity the MCP spec requires falls out of the loop counter.
    opts.ctx?.reportProgress(
      attempts,
      undefined,
      `Poll ${attempts}: ${lastStatus ?? "unknown"} after ${Math.round(elapsed / 1000)}s`,
    );
    if (lastStatus && TERMINAL_STATUSES.has(lastStatus)) {
      return { ok: true, progressEvent: lastEvent, command: lastCommand, attempts, elapsedMs: Date.now() - start };
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
    // Hand the signal to the sleep so a cancellation arriving mid-wait wakes
    // us immediately; the loop's own check at the top then builds the result.
    if (waitMs > 0) await sleep(waitMs, opts.ctx?.signal);
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
  ctx?: ToolContext,
): Promise<ToolResult> {
  const progressEvent = unwrapProgressEvent(initial.data);
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
      ctx,
    });
    if (!polled.ok) {
      // Auth-class failures during the poll loop deserve a recovery hint that
      // includes the requestToken: the underlying mutation may still
      // complete server-side, so after re-logging in the caller can check
      // its final state via aws_resource_status. Without this, the bare
      // poll error buries the recovery path in stderr text.
      if (
        polled.kind === "sso_expired" ||
        polled.kind === "expired_creds" ||
        polled.kind === "invalid_creds" ||
        polled.kind === "no_creds"
      ) {
        const useProfile = i.profile ?? getProfile();
        // The recovery path is the same for every auth-class kind -- the
        // mutation may still complete server-side, so the requestToken has to
        // reach the caller. Only the "how do I re-authenticate" clause differs.
        // expired_creds is origin-agnostic (SSO, assume-role, or web-identity
        // can all produce an expired temporary session), so it names both
        // remedies rather than assuming SSO the way sso_expired can.
        // invalid_creds is NOT an expiry: the credentials resolved and AWS
        // REJECTED them (rotated/deleted key, wrong partition, clock skew), so
        // its remedy is "fix the credentials", never "re-authenticate" (there
        // is no session to refresh) and never "no credentials found" (there
        // were credentials -- they were refused). A key rotated mid-poll used
        // to fall through to the bare poll error and drop the requestToken,
        // the same defect expired_creds had.
        const recovery = `call aws_resource_status with requestToken='${fields.requestToken}' to check whether the mutation completed server-side.`;
        // Quote the RAW diagnostic, not `polled.error`. The poll error is
        // itself "<remedy>. Underlying error: <stderr>", so embedding it nested
        // a second remedy inside ours -- and ours is the one that matters here,
        // because only it carries the requestToken. Falls back to the summary
        // if there is no raw body, so the clause is never empty.
        const underlying = polled.rawBody?.trim() || polled.error;
        let reLoginHint: string;
        if (polled.kind === "sso_expired") {
          reLoginHint = `SSO session expired while awaiting completion. Call aws_login_start with profile='${useProfile}' to re-authenticate, then ${recovery}`;
        } else if (polled.kind === "expired_creds") {
          reLoginHint = `Temporary credentials for profile '${useProfile}' expired while awaiting completion. Re-authenticate (aws_login_start for an SSO profile, or re-run the assume for an STS session), then ${recovery} Underlying error: ${underlying}`;
        } else if (polled.kind === "invalid_creds") {
          reLoginHint = `Credentials for profile '${useProfile}' were rejected by AWS while awaiting completion (they resolved, but the service refused them -- a rotated or deleted access key, the wrong partition, or a drifted clock). Fix the credentials for this profile, then ${recovery} Underlying error: ${underlying}`;
        } else {
          reLoginHint = `No credentials available while awaiting completion. After fixing credentials for profile '${useProfile}', ${recovery} Underlying error: ${underlying}`;
        }
        return { ok: false, error: reLoginHint, rawBody: polled.rawBody };
      }
      // Also the client-cancelled arm (`polled.cancelled`): it carries no
      // AwsCallFailureKind, so it lands here and surfaces pollUntilTerminal's
      // own message, which already names the cancellation and the
      // requestToken to resume with. Deliberately not reported as ok:true --
      // the operation had not reached a terminal state when we stopped
      // watching, and saying otherwise would be a fake success.
      return { ok: false, error: polled.error ?? "Poll failed", rawBody: polled.rawBody };
    }
    return progressResponse(polled.command, polled.progressEvent, {
      awaited: { attempts: polled.attempts, elapsedMs: polled.elapsedMs },
    });
  }

  // Not-awaited shape. When the caller ASKED to await and we got here anyway,
  // say why: awaitCompletion with no RequestToken in the response used to
  // return this shape silently, so the caller saw an IN_PROGRESS event and no
  // hint that the wait it requested never happened. (An already-terminal
  // response needs no signal -- there was nothing left to wait for.)
  const awaitSkipped =
    i.awaitCompletion && !fields.requestToken && !alreadyTerminal
      ? {
          awaitSkipped:
            "awaitCompletion was requested but the response carried no requestToken, so there was nothing to poll. The operation may still be in flight -- re-read the resource, or re-issue with a clientToken to make the retry idempotent.",
        }
      : undefined;

  return progressResponse(initial.command, progressEvent, awaitSkipped);
}

const baseFields = {
  profile: z.string().optional().describe("Override session profile for this call."),
  region: z.string().optional().describe("Override session region for this call."),
  timeoutMs: z.number().int().positive().optional().describe("Timeout in milliseconds. Default 60000."),
};

/**
 * RFC 6902 defines `add` and `replace` as carrying a value; only `remove`
 * doesn't. `value: z.unknown().optional()` accepted an op without one, and
 * `{op: 'add', path: '/X'}` then produced `X: undefined` -- which disappears
 * on the next JSON serialization, so the "change" silently evaporated (sent
 * to CCAPI as a value-less patch on the update path, and dropped from the
 * simulated `after` document on the diff path). Reject it at the schema so
 * the model gets a field-level error instead of a no-op.
 */
const patchOpHasValue = (op: { op: string; value?: unknown }): boolean =>
  !(op.op === "add" || op.op === "replace") || op.value !== undefined;
const PATCH_VALUE_REQUIRED = "ops 'add' and 'replace' require a 'value' field (use 'remove' to delete a path).";

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
      const vErr = validateCommonFields(i);
      if (vErr) return { ok: false, error: vErr };

      const result = await ccapiCall("get-resource", ["--type-name", i.typeName, "--identifier", i.identifier], i);
      if (!result.ok) return ccapiFailure(result);

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
      const cursorErr = i.nextToken !== undefined ? validateCursorToken(i.nextToken, "nextToken") : null;
      const vErr = validateCommonFields(i) ?? cursorErr;
      if (vErr) return { ok: false, error: vErr };

      const extraFlags: string[] = ["--type-name", i.typeName, "--max-results", String(i.maxResults ?? 100)];
      if (i.nextToken) extraFlags.push("--next-token", i.nextToken);
      if (i.resourceModel && Object.keys(i.resourceModel).length > 0) {
        extraFlags.push("--resource-model", JSON.stringify(i.resourceModel));
      }

      const result = await ccapiCall("list-resources", extraFlags, i);
      if (!result.ok) return ccapiFailure(result);

      const raw = result.data as { ResourceDescriptions?: unknown[]; NextToken?: string } | null;
      const descriptions = Array.isArray(raw?.ResourceDescriptions) ? raw.ResourceDescriptions : [];
      const resources = descriptions.map((d) => {
        const p = parseResourceProperties(d);
        // propertiesRaw rides along on an unparseable Properties string, the
        // same as aws_resource_get -- it is the only diagnosable thing left
        // when the parse failed, and dropping it here made the two verbs
        // disagree about the shape of the same resource.
        return {
          identifier: p.Identifier,
          properties: p.Properties,
          ...(p.propertiesRaw ? { propertiesRaw: p.propertiesRaw } : {}),
        };
      });
      const nextToken = extractNextToken(raw);
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
    handler: async (input: unknown, ctx?: ToolContext): Promise<ToolResult> => {
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
      const vErr = validateCommonFields(i);
      if (vErr) return { ok: false, error: vErr };

      const extraFlags: string[] = ["--type-name", i.typeName, "--desired-state", JSON.stringify(i.desiredState)];
      if (i.clientToken) extraFlags.push("--client-token", i.clientToken);

      const result = await ccapiCall("create-resource", extraFlags, i);
      if (!result.ok) return ccapiFailure(result);

      return buildMutationResponse({ command: result.command, data: result.data }, i, ctx);
    },
  },

  {
    name: "aws_resource_update",
    description:
      "Update an AWS resource via Cloud Control API using RFC 6902 JSON Patch. Async by default: returns a ProgressEvent with OperationStatus=IN_PROGRESS and a top-level `requestToken`. Pass `awaitCompletion: true` to have the server poll until terminal. Typical patch: [{op: 'replace', path: '/MemorySize', value: 512}].",
    annotations: {
      title: "Update an AWS resource (async via CCAPI)",
      // destructiveHint is true because a CCAPI update is not reliably
      // in-place: patching a property CloudFormation marks as requiring
      // replacement makes the provider DELETE and re-create the resource --
      // new physical id, and any data on it gone. The caller cannot tell which
      // properties those are from here, so the hint has to assume the worst.
      // `false` would assert "only additive updates" and suppress the host's
      // confirmation prompt on exactly that case.
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      typeName: z.string().describe("CloudFormation type name."),
      identifier: z.string().min(1).describe("Primary identifier for the resource."),
      patchDocument: z
        .array(
          z
            .object({
              op: z.enum(["add", "remove", "replace", "move", "copy", "test"]),
              path: z.string(),
              value: z.unknown().optional(),
              from: z.string().optional(),
            })
            .refine(patchOpHasValue, { message: PATCH_VALUE_REQUIRED, path: ["value"] }),
        )
        .min(1)
        .describe(
          "RFC 6902 JSON Patch document (array of operations). At least one entry. 'add' and 'replace' must carry a `value`.",
        ),
      clientToken: z.string().optional().describe("Idempotency token (max 128 chars)."),
      ...baseFields,
      ...awaitFields,
    }),
    handler: async (input: unknown, ctx?: ToolContext): Promise<ToolResult> => {
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
      const vErr = validateCommonFields(i);
      if (vErr) return { ok: false, error: vErr };

      const extraFlags: string[] = [
        "--type-name",
        i.typeName,
        "--identifier",
        i.identifier,
        "--patch-document",
        JSON.stringify(i.patchDocument),
      ];
      if (i.clientToken) extraFlags.push("--client-token", i.clientToken);

      const result = await ccapiCall("update-resource", extraFlags, i);
      if (!result.ok) return ccapiFailure(result);

      return buildMutationResponse({ command: result.command, data: result.data }, i, ctx);
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
    handler: async (input: unknown, ctx?: ToolContext): Promise<ToolResult> => {
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
      const vErr = validateCommonFields(i);
      if (vErr) return { ok: false, error: vErr };

      const extraFlags: string[] = ["--type-name", i.typeName, "--identifier", i.identifier];
      if (i.clientToken) extraFlags.push("--client-token", i.clientToken);

      const result = await ccapiCall("delete-resource", extraFlags, i);
      if (!result.ok) return ccapiFailure(result);

      return buildMutationResponse({ command: result.command, data: result.data }, i, ctx);
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

      const result = await ccapiCall("get-resource-request-status", ["--request-token", i.requestToken], i);
      if (!result.ok) return ccapiFailure(result);

      return progressResponse(result.command, unwrapProgressEvent(result.data));
    },
  },

  {
    name: "aws_resource_diff",
    description:
      "Dry-run a CCAPI update: fetch the current resource state, simulate applying a JSON Patch in memory, and return before/after plus a flat list of changed paths. No mutation is sent to AWS. Use this before aws_resource_update to verify the patch does what you expect. Supports the add/remove/replace subset of RFC 6902 (covers the vast majority of CCAPI updates); 'move'/'copy'/'test' are rejected at schema validation -- use aws_resource_update directly if you need those (CCAPI accepts them, this preview tool just doesn't simulate them locally).",
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
          z
            .object({
              // Diff simulates patches locally via applyJsonPatch; only the
              // add/remove/replace subset is implemented. Reject the other
              // three RFC 6902 ops here so the model gets schema-validation
              // feedback instead of a runtime "not implemented" error
              // surfaced as a generic "Patch application failed". The
              // sibling aws_resource_update tool accepts the full op set
              // because CCAPI does -- only this preview tool is restricted.
              op: z.enum(["add", "remove", "replace"]),
              path: z.string(),
              value: z.unknown().optional(),
              from: z.string().optional(),
            })
            .refine(patchOpHasValue, { message: PATCH_VALUE_REQUIRED, path: ["value"] }),
        )
        .min(1)
        .describe(
          "RFC 6902 JSON Patch (add/remove/replace subset); 'add' and 'replace' must carry a `value`. For move/copy/test, use aws_resource_update directly.",
        ),
      ...baseFields,
    }),
    handler: async (input: unknown): Promise<ToolResult> => {
      const i = input as {
        typeName: string;
        identifier: string;
        patchDocument: SimulatedJsonPatchOp[];
        profile?: string;
        region?: string;
        timeoutMs?: number;
      };
      const vErr = validateCommonFields(i);
      if (vErr) return { ok: false, error: vErr };

      const getResult = await ccapiCall("get-resource", ["--type-name", i.typeName, "--identifier", i.identifier], i);
      if (!getResult.ok) return ccapiFailure(getResult);

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
 * Full RFC 6902 op set. Used by aws_resource_update, which JSON.stringifies
 * the patch straight to CCAPI (CCAPI accepts move/copy/test) and never runs
 * the local simulator, so the wide op union is correct there.
 *
 * The local simulator (applyJsonPatch / summarizePatch, used by
 * aws_resource_diff) only implements add/remove/replace -- those callers take
 * the narrow SimulatedJsonPatchOp below, which makes the unimplemented ops
 * type-unrepresentable rather than relying on a runtime throw alone. The
 * runtime throw in _applyJsonPatchInPlace stays as defense for any caller
 * that widens to JsonPatchOp.
 *
 * Kept exported deliberately: resource-diff.test.ts imports it to construct
 * the move/copy/test ops that pin that runtime throw. Narrowing it to a local
 * type would leave the throw with no way to be exercised.
 */
export interface JsonPatchOp {
  op: "add" | "remove" | "replace" | "move" | "copy" | "test";
  path: string;
  value?: unknown;
  from?: string;
}

/**
 * The add/remove/replace subset the local patch simulator actually
 * implements. aws_resource_diff's Zod schema only admits these three ops, so
 * its handler narrows to this type before calling applyJsonPatch /
 * summarizePatch.
 */
export interface SimulatedJsonPatchOp {
  op: "add" | "remove" | "replace";
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
export function applyJsonPatch(original: unknown, ops: readonly SimulatedJsonPatchOp[]): unknown {
  // Clone once at entry so callers' inputs stay immutable, then delegate to
  // the in-place helper. The helper is also called directly by
  // summarizePatch's per-op replay (it owns its own working copy, so the
  // extra clone here would be wasted -- see _applyJsonPatchInPlace).
  const doc = clone(original);
  return _applyJsonPatchInPlace(doc, ops);
}

/**
 * INTERNAL. Apply ops by mutating `doc` directly. Used by `applyJsonPatch`
 * (which clones first) and by `summarizePatch` (which owns a single
 * working copy across op replays, so cloning per call would be O(N*D)
 * instead of O(N+D)). Public callers must use `applyJsonPatch`.
 *
 * Note: when `doc` is a primitive and a whole-document op fires, this
 * function cannot mutate the binding visible to the caller -- the
 * `applyJsonPatch` wrapper handles this by reassigning its local `doc`.
 * The in-place helper returns the (possibly new) root so callers can
 * still observe a whole-document replacement.
 */
function _applyJsonPatchInPlace(doc: unknown, ops: readonly JsonPatchOp[]): unknown {
  let root = doc;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.op === "move" || op.op === "copy" || op.op === "test") {
      throw new Error(`op '${op.op}' at index ${i} is not implemented in aws_resource_diff (use add/remove/replace).`);
    }
    const tokens = parseJsonPointer(op.path);
    for (const seg of tokens) {
      if (seg === "__proto__" || seg === "constructor" || seg === "prototype") {
        throw new Error(`Path '${op.path}' contains reserved segment '${seg}' at op index ${i}.`);
      }
    }
    if (tokens.length === 0) {
      // Whole-document replace/add/remove. RFC 6902 says `add` at the root
      // REPLACES the document when one exists (not an error) -- same effective
      // semantics as `replace`. We collapse both ops to the same reassignment
      // so a future reviewer doesn't "fix" the add branch to throw on a
      // pre-existing root.
      if (op.op === "remove") {
        throw new Error(`Cannot remove the document root at index ${i}.`);
      }
      root = clone(op.value);
      continue;
    }
    const parentTokens = tokens.slice(0, -1);
    const lastToken = tokens[tokens.length - 1];

    // Walk to the parent. For `add` ops only, missing intermediate OBJECT
    // segments are auto-materialized as `{}` -- CCAPI accepts patches like
    // `/Environment/Variables/NEW_KEY` even when `/Environment` doesn't
    // exist yet, and rejecting them would force every caller to pre-stage
    // empty containers. Array indices are NEVER auto-created (ambiguous --
    // splice or assign? what fills the gap?); `replace` and `remove` still
    // require an existing target so a typo can't silently create state.
    let parent: unknown = root;
    for (let t = 0; t < parentTokens.length; t++) {
      const segment = parentTokens[t];
      if (Array.isArray(parent)) {
        const idx = Number.parseInt(segment, 10);
        if (!Number.isInteger(idx) || idx < 0) {
          throw new Error(`Path '${op.path}' segment '${segment}' is not a valid array index at op index ${i}.`);
        }
        if (idx >= parent.length) {
          // Intermediate segment: caller is trying to traverse INTO a
          // not-yet-existing array element. Name the segment, array
          // length, and the not-yet-existing element so the message is
          // actionable (and distinct from the final-token bounds errors
          // below that say "Add/Remove/Replace index ...").
          throw new Error(
            `Path '${op.path}' cannot traverse into intermediate array element at segment '${segment}': array has length ${parent.length}, so index ${idx} does not exist yet (at op index ${i}).`,
          );
        }
        parent = parent[idx];
      } else if (isObj(parent)) {
        if (!Object.hasOwn(parent, segment)) {
          if (op.op === "add") {
            parent[segment] = {};
            parent = parent[segment];
            // Descend into the freshly-created container and skip the shared
            // `parent = parent[segment]` below -- we already advanced parent
            // here, so re-running it would be a redundant (harmless) re-read.
            continue;
          }
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
        if (!Object.hasOwn(parent, lastToken)) {
          throw new Error(`Cannot remove missing key '${lastToken}' at index ${i}.`);
        }
        delete parent[lastToken];
      } else if (op.op === "replace") {
        if (!Object.hasOwn(parent, lastToken)) {
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
  return root;
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
 * trees by hand. Takes the add/remove/replace subset (SimulatedJsonPatchOp);
 * the other RFC 6902 ops are type-unrepresentable here.
 *
 * `after` is captured per-op by replaying the patch one step at a time, so
 * the snapshot reflects what THIS op produced rather than the final
 * post-patch state. This matters when multiple ops touch the same path
 * (sequential `replace` on /X, or `remove` then `add` at /X) -- the naive
 * `resolvePointer(finalAfter, op.path)` would report the final value for
 * every op and bury the intermediate steps.
 *
 * `before` is still resolved against the original pre-patch document --
 * that's what the user asked to mutate, and reporting "before relative to
 * the prior op" would conflate change-tracking with replay-tracking.
 */
export function summarizePatch(ops: readonly SimulatedJsonPatchOp[], before: unknown, after: unknown): PatchChange[] {
  // Replay ops one at a time against a working copy so we can snapshot the
  // value at op[i]'s path AFTER op[i] applies but BEFORE op[i+1] applies.
  // Fall back to the final `after` doc if replay throws -- summarizePatch
  // is best-effort observability, not a second validation pass.
  //
  // Perf: clone `before` ONCE, then use the internal in-place helper to
  // mutate the working copy across ops. The previous implementation called
  // the public `applyJsonPatch` once per op, and each call deep-cloned the
  // full document at entry -- O(N * D) for an N-op patch on a D-byte doc.
  // The in-place replay is O(N + D). Correctness still holds because each
  // op's `after` snapshot is taken right after its single op mutates the
  // working copy, before the next op runs.
  //
  // No try/catch around this clone: `before` is JSON.parse output from
  // parseResourceProperties, so it is acyclic and round-trippable by
  // construction. The guard could only ever have fired for a hand-built
  // cyclic document from a direct caller, and it answered that by silently
  // degrading the entire replay -- a throw is the more useful signal.
  let working: unknown = clone(before);
  let replayOk = true;

  const out: PatchChange[] = [];
  for (const op of ops) {
    // ops is SimulatedJsonPatchOp[], so move/copy/test are type-unrepresentable
    // here -- no unimplemented-op branch is needed. The runtime throw in
    // _applyJsonPatchInPlace remains the defense for any caller that widens to
    // JsonPatchOp.
    const beforeAt = resolvePointer(before, op.path);

    let afterAt: unknown;
    if (replayOk) {
      try {
        // _applyJsonPatchInPlace returns the (possibly new) root -- it
        // only differs from the input ref on whole-document ops, but we
        // always reassign so primitive-root replacements survive.
        working = _applyJsonPatchInPlace(working, [op]);
        afterAt = resolvePointer(working, op.path);
      } catch {
        // DEFENSIVE-ONLY / effectively unreachable in normal operation: the
        // caller (aws_resource_diff) already ran the full patch via
        // applyJsonPatch before calling summarizePatch, so replaying the same
        // ops one-at-a-time here cannot throw where the full run succeeded.
        // This branch only fires if a direct summarizePatch caller passes a
        // patch that was never validated by applyJsonPatch. Stop replaying and
        // fall back to the final-state snapshot for the remaining ops.
        replayOk = false;
        afterAt = resolvePointer(after, op.path);
      }
    } else {
      afterAt = resolvePointer(after, op.path);
    }

    // `remove` succeeded means the value is gone from the working copy.
    // resolvePointer returns undefined, which is exactly what we want to
    // surface -- no special-casing.

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
      // Object.hasOwn, not `in`: `in` walks the prototype chain, so a pointer
      // like '/constructor' or '/toString' would resolve to an INHERITED value
      // instead of undefined. Not reachable through aws_resource_diff (the
      // reserved-segment guard in _applyJsonPatchInPlace throws on those paths
      // first), but summarizePatch and resolvePointer are both exported, and a
      // direct caller shouldn't be able to read prototype members out of a
      // document that doesn't own them.
      if (!Object.hasOwn(cur, t)) return undefined;
      cur = cur[t];
    } else {
      return undefined;
    }
  }
  return cur;
}
