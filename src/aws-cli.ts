/**
 * Subprocess dispatch for arbitrary aws CLI operations. The aws binary is
 * already a hard dependency (we spawn it for SSO login); delegating API calls
 * to it too means zero extra SDK packages to bundle and exactly the coverage
 * the CLI offers. Session profile/region apply by default so `aws_session_set`
 * actually sticks.
 *
 * The safety story: spawn uses an argv array (no shell), and service/operation
 * strings are regex-validated as kebab-case so user-supplied input can't pose
 * as a flag to `aws`. Params go through --cli-input-json.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { type AuthErrorKind, classifyAuthError, parseAwsError } from "./errors.js";
import { KILL_ESCALATION_MS, killProc, procHasExited } from "./kill-proc.js";
import {
  getProfile,
  getRegion,
  invalidProfileMessage,
  invalidRegionMessage,
  isValidProfileName,
  isValidRegionName,
} from "./session.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024; // 5 MB per stream
// Cap the stderr we surface as an error message to avoid flooding the MCP
// response. Full stderr still lands in rawStderr for diagnosis.
//
// CHARS, not bytes: truncateForErrorMsg measures with String#length and cuts
// with String#slice, both of which count UTF-16 code units. MAX_OUTPUT_BYTES
// above genuinely counts bytes (it sums Buffer.length on raw chunks); this one
// does not, and the name says so. For non-ASCII stderr the two units diverge.
const MAX_ERROR_MSG_CHARS = 8 * 1024;

/**
 * How long to wait for the stdio pipes to close once the child itself is gone
 * (or once we have given up on it).
 *
 * 'close' is the correct NORMAL settle -- it is the only event that guarantees
 * every buffered byte has been read (see the 'close' handler below). But
 * 'close' fires when the LAST writer on those pipes goes away, and the child is
 * not necessarily the last writer: any descendant that inherited the stdio
 * handles keeps them open after `aws` itself dies. `aws ssm start-session` and
 * `aws ecs execute-command` do exactly that -- they hand off to
 * session-manager-plugin with the pipes inherited -- and both are reachable
 * from aws_call (validateNames permits them; there is no interactive-op
 * denylist). Without a bound, such a call never settles, not even at timeoutMs.
 *
 * Sized to be comfortably longer than a real pipe drain (microseconds to low
 * milliseconds, even for a 5 MB payload) so it can never preempt a legitimate
 * 'close' and truncate stdout, while still bounding the pathological case.
 */
const PIPE_CLOSE_GRACE_MS = 2_000;

// Also defends against argv injection: leading-hyphen input like "--profile evil"
// would otherwise become a flag to `aws`.
export const SAFE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Flags whose NEXT argv entry is a JSON blob that can carry secrets (IAM
 * passwords, access keys, SecureString parameter values, tags with PII).
 *
 * --cli-input-json is the aws_call / aws_assume_role / aws_metrics_query path.
 * The CCAPI tools in tools/resource.ts do NOT use --cli-input-json: they pass
 * their payloads as dedicated flags via extraFlags, so each one needs its own
 * entry here or the payload lands verbatim in displayCommand -- which is
 * returned to the caller as `data.command`. Observed leak before this set
 * existed: aws_resource_create on AWS::SSM::Parameter echoed the SecureString
 * Value back to the model in full.
 *
 * Keep this in sync with any new extraFlags entry that carries user data.
 */
const REDACTED_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--cli-input-json",
  "--desired-state", // aws_resource_create
  "--patch-document", // aws_resource_update
  "--resource-model", // aws_resource_list (parent identifiers)
]);

/**
 * Keep each redacted flag visible in displayCommand so users see the shape of
 * what ran, but replace its payload with a length stub.
 *
 * ALL occurrences of each flag are redacted -- a single call can theoretically
 * carry the same flag more than once (e.g. if callers splice extra flags), so
 * indexOf-stop-at-first is not sufficient.
 */
export function redactDisplayArgs(args: readonly string[]): string[] {
  const out = [...args];
  for (let i = 0; i < out.length - 1; i++) {
    if (REDACTED_VALUE_FLAGS.has(out[i])) {
      out[i + 1] = `<redacted len=${out[i + 1].length}>`;
    }
  }
  return out;
}

// Characters that need no quoting in a POSIX shell word. Deliberately
// conservative: anything outside this set gets single-quoted.
const SHELL_SAFE_ARG_RE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Quote one argv entry for a POSIX shell, so displayCommand is something the
 * reader can actually paste.
 *
 * The consumer of `data.command` is an LLM, which will paste it into a shell
 * far more readily than a human would. The argv entries reaching it are not
 * all shell-inert: isValidProfileName permits `:` and `@`, --query carries
 * arbitrary JMESPath (spaces, `[`, `]`, `*`), and the redaction stub itself
 * contains spaces and angle brackets. Joining those on a space produced a
 * string that either fails to run or -- with a `$(...)`-bearing value --
 * runs something the caller never asked for.
 *
 * Single-quoting is the safe form: inside single quotes a POSIX shell expands
 * nothing. An embedded single quote closes, escapes, and reopens ('\'').
 * cmd.exe and PowerShell quote differently, so this is still a display string
 * rather than a universal one -- but it is now correct wherever `aws` is
 * normally driven from.
 *
 * Exported for direct unit coverage: the quoting rules are the security
 * boundary here, so they get asserted head-on rather than only through a
 * spawned call.
 */
export function shellQuoteArg(arg: string): string {
  if (SHELL_SAFE_ARG_RE.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function truncateForErrorMsg(text: string): string {
  if (text.length <= MAX_ERROR_MSG_CHARS) return text;
  // Don't cut between a high and low surrogate -- slicing mid-pair emits a
  // lone surrogate, which JSON.stringify turns into a replacement char in the
  // MCP response. Back off one unit when the boundary lands on a high surrogate.
  let cut = MAX_ERROR_MSG_CHARS;
  const boundary = text.charCodeAt(cut - 1);
  if (boundary >= 0xd800 && boundary <= 0xdbff) cut -= 1;
  const omitted = text.length - cut;
  return `${text.slice(0, cut)}\n\n[truncated; ${omitted} chars omitted]`;
}

// Not exported: runAwsCall is the only consumer, and no .d.ts ships (the
// published `files` list is dist/index.js alone), so there is no external
// caller to name this type.
interface AwsCallOptions {
  service: string;
  operation: string;
  params?: Record<string, unknown>;
  profile?: string;
  region?: string;
  outputFormat?: "json" | "text" | "table" | "yaml";
  // JMESPath expression passed through --query. Filters/extracts server-side
  // in the CLI before our 5 MB cap kicks in; a well-chosen query on
  // list-objects-v2 can shrink a 4 MB response to a 2 KB one.
  query?: string;
  timeoutMs?: number;
  // Additional CLI-level flags (not API params) to inject before --profile.
  // Internal callers only -- e.g. aws_paginate adds --max-items and
  // --starting-token here. Each entry is appended verbatim to argv.
  extraFlags?: string[];
  // Set when the operation emits NEWLINE-DELIMITED JSON rather than one JSON
  // document -- `aws logs tail --format json` is the only such op today.
  //
  // Load-bearing for the malformed_json check below, not just documentation.
  // NDJSON opens with `{` and fails a whole-blob JSON.parse, which is exactly
  // the signature that check uses to catch a truncated payload. Without this
  // flag a perfectly complete multi-event log tail is reported as truncated.
  ndjson?: boolean;
  // Test-injection knobs, mirrored from startSsoLogin. Not exposed via MCP.
  command?: string;
  prefixArgs?: string[];
  env?: NodeJS.ProcessEnv;
}

// AuthErrorKind MINUS "other". classifyAuthError returns "other" for anything
// it doesn't recognize, but the exit handler below maps that case to
// "nonzero_exit" -- so "other" can never appear on an AwsCallResult, and
// including it here would give every consumer switch a permanently dead arm.
export type AwsCallFailureKind =
  | Exclude<AuthErrorKind, "other"> // "sso_expired" | "expired_creds" | "no_creds" | "invalid_creds"
  | "bad_input"
  | "spawn_failure"
  | "timeout"
  | "output_too_large"
  | "malformed_json"
  | "nonzero_exit";

// Not exported for the same reason as AwsCallOptions: consumers reference the
// AwsCallResult union, never this arm by name.
interface AwsCallSuccess {
  ok: true;
  /**
   * Parsed JSON value on a successful `--output json` run, OR a raw trimmed
   * string when the CLI emits non-JSON stdout despite `--output json` (e.g.
   * `--query` expressions that extract a scalar string/number return the value
   * without JSON quoting), or the raw NDJSON blob when the caller passed
   * `ndjson: true`. Otherwise only genuinely scalar-looking stdout takes the
   * string branch -- text that opens with `{` or `[` and fails to parse is a
   * truncated payload and settles as a `malformed_json` FAILURE, not a
   * success. Callers must type-guard before assuming a structured
   * object: `typeof data === "string"` vs `typeof data === "object"`.
   * For `--output text/table/yaml` this is always the raw stdout string.
   */
  data: unknown;
  command: string;
  rawStdout: string;
}

export interface AwsCallFailure {
  ok: false;
  kind: AwsCallFailureKind;
  error: string;
  command?: string;
  exitCode?: number | null;
  rawStdout?: string;
  rawStderr?: string;
}

export type AwsCallResult = AwsCallSuccess | AwsCallFailure;

// Module-level dedupe set: warn once per malformed value so a misconfigured
// dev env doesn't spam stderr on every aws call. Cleared per-process; tests
// that intentionally exercise this path can stub the var afresh each time.
const warnedMalformedPrefixArgs = new Set<string>();

/** Test-only: clear the malformed-value dedupe set so each test sees a fresh
 * "first warn fires" state. Underscore prefix = exported for tests only, not
 * for production callers. */
export function _resetParseTestPrefixArgsDedupe(): void {
  warnedMalformedPrefixArgs.clear();
}

// Exported for tests -- the dedupe + warn behavior is load-bearing (it shapes
// every aws_call when a dev sets AWS_MCP_TEST_AWS_PREFIX_ARGS wrong), so it
// gets direct unit coverage instead of being driven only through runAwsCall.
export function parseTestPrefixArgs(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    if (!warnedMalformedPrefixArgs.has(raw)) {
      warnedMalformedPrefixArgs.add(raw);
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[aws-mcp] AWS_MCP_TEST_AWS_PREFIX_ARGS is set but isn't valid JSON: ${msg}. Falling back to the real 'aws' binary.`,
      );
    }
    return undefined;
  }
  if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) {
    if (!warnedMalformedPrefixArgs.has(raw)) {
      warnedMalformedPrefixArgs.add(raw);
      console.warn(
        `[aws-mcp] AWS_MCP_TEST_AWS_PREFIX_ARGS must parse to a string array; got ${typeof parsed === "object" ? JSON.stringify(parsed) : typeof parsed}. Falling back to the real 'aws' binary.`,
      );
    }
    return undefined;
  }
  return parsed as string[];
}

function validateNames(service: string, operationTokens: string[]): string | null {
  if (!SAFE_NAME_RE.test(service)) {
    return `Invalid service '${service}'. Must be kebab-case alphanumeric (e.g. 's3api', 'ec2', 'lambda').`;
  }
  if (operationTokens.length === 0) {
    return "Operation is empty.";
  }
  for (const token of operationTokens) {
    if (!SAFE_NAME_RE.test(token)) {
      return `Invalid operation token '${token}'. Each token must be kebab-case alphanumeric.`;
    }
  }
  return null;
}

export function runAwsCall(opts: AwsCallOptions): Promise<AwsCallResult> {
  const operationTokens = opts.operation.trim().split(/\s+/).filter(Boolean);
  const validationError = validateNames(opts.service, operationTokens);
  if (validationError) {
    return Promise.resolve({ ok: false, kind: "bad_input", error: validationError });
  }

  const profile = opts.profile ?? getProfile();
  const region = opts.region ?? getRegion();
  // Argv-safety: the resolved values land in `aws --profile X --region Y`.
  // Validate AFTER resolution so this catches both explicit opts overrides
  // AND env-var fallback (AWS_PROFILE / AWS_REGION bypass setProfile/setRegion).
  if (!isValidProfileName(profile)) {
    return Promise.resolve({
      ok: false,
      kind: "bad_input",
      error: invalidProfileMessage(profile, "Check the 'profile' arg or AWS_PROFILE env var."),
    });
  }
  if (!isValidRegionName(region)) {
    return Promise.resolve({
      ok: false,
      kind: "bad_input",
      error: invalidRegionMessage(region, "Check the 'region' arg or AWS_REGION / AWS_DEFAULT_REGION env var."),
    });
  }
  const outputFormat = opts.outputFormat ?? "json";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Test-only override path: handler-level tests (e.g. tools/paginate.test.ts)
  // can't pass command/prefixArgs through the MCP-level handler signature, so
  // we honor these env vars as a fallback. Never set in production -- the
  // AWS_MCP_TEST_ prefix is unique enough that real env files won't collide.
  // Malformed JSON or non-string-array values fall back to the default
  // (real `aws` binary) rather than throwing, so a dev typo can't wedge
  // every aws call with a SyntaxError that bypasses the AwsCallResult
  // envelope. We do warn once per malformed value so the dev sees the
  // typo instead of debugging a confusing "Failed to spawn 'aws'" later.
  const envCommand = process.env.AWS_MCP_TEST_AWS_COMMAND;
  const envPrefixArgsRaw = process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS;
  const envPrefixArgs = parseTestPrefixArgs(envPrefixArgsRaw);
  const command = opts.command ?? envCommand ?? "aws";
  const prefixArgs = opts.prefixArgs ?? envPrefixArgs ?? [];

  const args: string[] = [
    ...prefixArgs,
    opts.service,
    ...operationTokens,
    ...(opts.extraFlags ?? []),
    "--output",
    outputFormat,
    "--profile",
    profile,
    "--region",
    region,
  ];
  if (opts.query !== undefined && opts.query.trim().length > 0) {
    if (opts.query.length > 2048) {
      return Promise.resolve({
        ok: false,
        kind: "bad_input",
        error: `query expression too long (${opts.query.length} chars; max 2048). Simplify the JMESPath expression.`,
      });
    }
    args.push("--query", opts.query);
  }
  if (opts.params !== undefined && Object.keys(opts.params).length > 0) {
    args.push("--cli-input-json", JSON.stringify(opts.params));
  }

  // Display string for logging / the MCP response, shell-quoted per entry so
  // it survives a paste into a POSIX shell. The real invocation still uses the
  // argv array above (no shell involved), so the quoting here is purely about
  // what the caller SEES -- and the caller is a model that will paste it.
  const displayCommand = [command, ...redactDisplayArgs(args)].map(shellQuoteArg).join(" ");

  return new Promise<AwsCallResult>((resolve) => {
    let proc: ChildProcess;
    // This catch is near-unreachable and stays deliberately. ENOENT -- the
    // failure that actually happens (no `aws` on PATH) -- arrives async on the
    // 'error' event below, not here; spawn only throws synchronously on
    // argument-shape errors (ERR_INVALID_ARG_TYPE and friends), which the
    // validation above already rules out for every production path.
    //
    // What it buys: a throw inside a Promise executor REJECTS the promise. Every
    // caller of runAwsCall consumes an AwsCallResult envelope and none of them
    // wrap the call in try/catch, so without this the one exotic case would
    // bypass the envelope entirely and surface as an unhandled rejection.
    try {
      proc = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        ...(opts.env ? { env: opts.env } : {}),
      });
    } catch (err) {
      resolve({
        ok: false,
        kind: "spawn_failure",
        error: `Failed to spawn '${command}': ${err instanceof Error ? err.message : String(err)}. Is the AWS CLI installed and on PATH?`,
        command: displayCommand,
      });
      return;
    }

    let stdoutBuf = "";
    let stderrBuf = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let killed = false;
    let timedOut = false;
    let tooLarge = false;
    let settled = false;
    // Handle + absolute deadline for the pipe-close fallback (armPipeCloseGrace
    // below). The deadline is only ever moved EARLIER: the kill sites arm a long
    // window because the child is still alive and killProc's SIGTERM grace plus
    // SIGKILL escalation both have to elapse first, and the 'exit' listener then
    // re-arms a short one because by then only the drain is left.
    let graceHandle: NodeJS.Timeout | null = null;
    let graceDeadline = Number.POSITIVE_INFINITY;
    // Per-stream UTF-8 decoders so a multi-byte character split across two
    // chunks doesn't decode to U+FFFD. AWS resource names / tags / S3 keys
    // routinely contain non-ASCII.
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    // The single choke point for resolving this promise. Also the single place
    // the two timers are cancelled, so no exit path can leave one armed.
    const settle = (result: AwsCallResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      if (graceHandle !== null) {
        clearTimeout(graceHandle);
        graceHandle = null;
      }
      resolve(result);
    };

    /**
     * Build the result from whatever the pipes have given us. Called by 'close'
     * on the normal path -- where it runs with a guaranteed-complete payload --
     * and by the pipe-close grace timer when 'close' is never going to fire.
     *
     * `code` is the child's exit code, or null when it was killed by a signal
     * or was never reaped at all; the nonzero_exit branch below already treats
     * both the same way.
     */
    const finishFromPipes = (code: number | null): void => {
      if (settled) return;
      // Flush any incomplete multi-byte sequence held in the decoder.
      stdoutBuf += stdoutDecoder.end();
      stderrBuf += stderrDecoder.end();

      if (timedOut) {
        settle({
          ok: false,
          kind: "timeout",
          error: `aws CLI timed out after ${Math.round(timeoutMs / 1000)}s. Raise timeoutMs or narrow the query (filters, --max-items).`,
          command: displayCommand,
          rawStdout: stdoutBuf,
          rawStderr: stderrBuf,
        });
        return;
      }
      if (tooLarge) {
        settle({
          ok: false,
          kind: "output_too_large",
          error: `aws CLI stdout exceeded ${MAX_OUTPUT_BYTES / 1024 / 1024} MB. Narrow the query or paginate (--max-items + --starting-token).`,
          command: displayCommand,
          rawStderr: stderrBuf,
        });
        return;
      }

      if (code !== 0) {
        const classified = classifyAuthError(new Error(stderrBuf));
        let errorMsg: string;
        let kind: AwsCallFailureKind;
        if (classified.kind === "sso_expired") {
          kind = "sso_expired";
          errorMsg = `SSO session expired for profile '${profile}'. Call aws_login_start with profile='${profile}' to re-authenticate.`;
        } else if (classified.kind === "expired_creds") {
          // Deliberately NOT sso_expired. AWS emits the ExpiredToken wrapper for
          // ANY expired temporary credential -- an assume-role session, a
          // web-identity session, an SSO-derived one. Telling an assume-role
          // user to run aws_login_start is wrong advice, so this message names
          // both remedies and keeps the underlying stderr (which the
          // aws_assume_role path otherwise drops entirely).
          kind = "expired_creds";
          errorMsg = `Temporary credentials for profile '${profile}' have expired. If this profile authenticates via AWS SSO, call aws_login_start with profile='${profile}'; if these credentials came from aws_assume_role or another STS session, request a fresh session (re-run the assume). Underlying error: ${truncateForErrorMsg(stderrBuf.trim())}`;
        } else if (classified.kind === "invalid_creds") {
          // Distinct from no_creds on purpose: credentials WERE found and sent,
          // and the service rejected them. "Check ~/.aws/credentials exists" is
          // the wrong advice here.
          kind = "invalid_creds";
          errorMsg = `Credentials for profile '${profile}' were rejected by AWS (they resolved, but the service refused them). Common causes: the access key was deleted or rotated, the profile points at the wrong partition/account, or the machine clock has drifted enough to break request signing. Underlying error: ${truncateForErrorMsg(stderrBuf.trim())}`;
        } else if (classified.kind === "no_creds") {
          kind = "no_creds";
          errorMsg = `No credentials found for profile '${profile}'. Check ~/.aws/config and ~/.aws/credentials. Underlying error: ${truncateForErrorMsg(stderrBuf.trim())}`;
        } else {
          kind = "nonzero_exit";
          const baseMsg = truncateForErrorMsg(stderrBuf.trim()) || `aws CLI exited with code ${code} and no stderr`;
          // Best-effort: pull a one-line "Suggestion: ..." onto the end when
          // we recognize a common AWS error shape. The raw stderr stays in
          // baseMsg untouched so the agent can still see the original text.
          const parsed = parseAwsError(stderrBuf);
          errorMsg = parsed.suggestion ? `${baseMsg}\n\nSuggestion: ${parsed.suggestion}` : baseMsg;
        }
        settle({
          ok: false,
          kind,
          error: errorMsg,
          command: displayCommand,
          exitCode: code,
          rawStdout: stdoutBuf,
          rawStderr: stderrBuf,
        });
        return;
      }

      if (outputFormat === "json") {
        const trimmed = stdoutBuf.trim();
        if (!trimmed) {
          settle({ ok: true, data: null, command: displayCommand, rawStdout: stdoutBuf });
          return;
        }
        try {
          settle({ ok: true, data: JSON.parse(trimmed), command: displayCommand, rawStdout: stdoutBuf });
        } catch (err) {
          // Two very different situations reach this catch, and collapsing them
          // into one ok:true was hiding the bad one.
          //
          // (a) Legitimately non-JSON stdout: some operations emit a plain
          //     scalar even under --output json (a --query expression that
          //     extracts a string/number returns it unquoted). Preserve the
          //     text -- that IS the successful result.
          //
          // (b) stdout that OPENS as a JSON object/array and fails to parse:
          //     a truncated or corrupted payload. Reporting that as ok:true
          //     hands the caller a string where the schema promises an object,
          //     and the truncation disappears silently.
          //
          // The first character separates them: no scalar starts with { or [.
          //
          // (c) NDJSON, when the caller declared it: every line is its own JSON
          //     document, so the blob opens with `{` and cannot parse as a
          //     whole. That is the format working correctly, not a truncation,
          //     so it takes the string branch and the caller splits the lines.
          if (!opts.ndjson && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
            const detail = err instanceof Error ? err.message : String(err);
            settle({
              ok: false,
              kind: "malformed_json",
              error: `aws CLI exited 0 but its stdout opens as JSON and failed to parse: ${detail}. The payload is most likely truncated. Retry, or narrow the response with --query / pagination. Raw stdout is preserved in rawStdout.`,
              command: displayCommand,
              exitCode: code,
              rawStdout: stdoutBuf,
              rawStderr: stderrBuf,
            });
            return;
          }
          settle({ ok: true, data: trimmed, command: displayCommand, rawStdout: stdoutBuf });
        }
      } else {
        settle({ ok: true, data: stdoutBuf, command: displayCommand, rawStdout: stdoutBuf });
      }
    };

    /**
     * Arm (or bring forward) the bounded fallback that settles when 'close' is
     * never going to fire. Idempotent, and only ever shortens the wait, so the
     * long window a kill site arms is superseded by the short one the 'exit'
     * listener arms once the child is confirmed reaped.
     *
     * Whichever of this timer and 'close' loses the race is free: settle()'s
     * `settled` flag makes the second arrival a no-op, so the normal path keeps
     * its full pipe flush and this only ever fires when there is nothing left
     * to wait for.
     */
    const armPipeCloseGrace = (delayMs: number): void => {
      if (settled) return;
      const deadline = Date.now() + delayMs;
      if (deadline >= graceDeadline) return;
      graceDeadline = deadline;
      if (graceHandle !== null) clearTimeout(graceHandle);
      graceHandle = setTimeout(() => finishFromPipes(proc.exitCode), delayMs);
      // A pending fallback must never be the reason this process stays alive.
      // It still fires when it matters: the un-closed stdio streams that cause
      // this situation are themselves ref'd handles holding the loop up.
      graceHandle.unref();
    };

    const timeoutHandle = setTimeout(() => {
      if (killed) return;
      // procHasExited closes the microsecond race where the subprocess exited
      // cleanly in the last few microseconds with its 'exit' callback queued
      // behind us in this same loop iteration -- libuv sets exitCode/signalCode
      // synchronously BEFORE dispatching 'exit', so if either is populated we
      // leave the natural result alone instead of overwriting it with a timeout
      // error. See kill-proc.ts:procHasExited.
      //
      // Returning here is safe even when the pipes are being held open by a
      // descendant, because the 'exit' listener below has already armed the
      // pipe-close grace, so this call still settles. Before that listener
      // existed this early return was the WORST hang of the two: the child was
      // reaped, nothing here ever attempted a kill, and 'close' never came.
      if (procHasExited(proc)) {
        armPipeCloseGrace(PIPE_CLOSE_GRACE_MS);
        return;
      }
      killed = true;
      timedOut = true;
      killProc(proc);
      // killProc guarantees the CHILD dies -- SIGTERM, then SIGKILL after
      // KILL_ESCALATION_MS, guarded on procHasExited rather than proc.killed so
      // the escalation genuinely fires (see kill-proc.ts). It does NOT guarantee
      // the stdio pipes CLOSE: a descendant that inherited them is not signalled
      // and keeps its ends open, so 'close' can simply never arrive. Child-exit
      // and pipe-close are different guarantees and only the first is delivered
      // here, which is why the settle needs its own bound. The window covers the
      // SIGTERM grace, the SIGKILL escalation and the drain; the 'exit' listener
      // shortens it the moment the child is actually reaped.
      armPipeCloseGrace(KILL_ESCALATION_MS + PIPE_CLOSE_GRACE_MS);
    }, timeoutMs);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        if (!killed) {
          killed = true;
          tooLarge = true;
          killProc(proc);
          // Same bound as the timeout kill site, for the same reason: killProc
          // gets rid of the child, not of a descendant holding the pipes open.
          armPipeCloseGrace(KILL_ESCALATION_MS + PIPE_CLOSE_GRACE_MS);
        }
        return;
      }
      stdoutBuf += stdoutDecoder.write(chunk);
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      // Deliberate asymmetry vs stdout: oversized stderr is silently truncated
      // -- we stop appending past MAX_OUTPUT_BYTES but do NOT set tooLarge and
      // do NOT kill the proc. stderr is diagnostic text (CLI warnings/errors),
      // not the data payload we parse, so an output_too_large failure here would
      // be noise. stdout is the parsed result, so only it trips that guard above.
      if (stderrBytes > MAX_OUTPUT_BYTES) return;
      stderrBuf += stderrDecoder.write(chunk);
    });

    proc.on("error", (err) => {
      settle({
        ok: false,
        kind: "spawn_failure",
        error: `Failed to run '${command}': ${err.message}. Is the AWS CLI installed and on PATH?`,
        command: displayCommand,
      });
    });

    // 'exit' is NOT the settle -- see the 'close' handler below for why it must
    // not be. It is here purely to BOUND the wait. Once the child is reaped the
    // only thing standing between us and a result is the pipe drain, so anything
    // still holding those pipes open is a descendant we have no way to wait on.
    // Arms the short window; if a kill site already armed the longer one to
    // cover the SIGKILL escalation, that is now moot and gets superseded.
    proc.on("exit", () => {
      armPipeCloseGrace(PIPE_CLOSE_GRACE_MS);
    });

    // 'close', not 'exit': 'exit' fires as soon as the child is reaped, while
    // its stdio pipes may still hold buffered data we have not read. Settling
    // there truncates stdout on a fast-exiting child and the JSON parse below
    // then fails on a payload that arrived complete. 'close' fires only once
    // every pipe has been drained and closed, so it stays the NORMAL settle.
    //
    // What it is not is a GUARANTEED one, and sso.ts is the pattern that fixes
    // that rather than the precedent for leaning on it. Its version probe does
    // settle on 'close', but it also calls finish(true) from INSIDE its own
    // timeout callback (sso.ts:284-293); its login path settles on 'exit'
    // (sso.ts:591) and uses 'close' only as a start-failure fallback
    // (sso.ts:646). Both sso.ts sites are bounded by something other than
    // 'close'. This was the only site whose timeout path depended on 'close'
    // alone -- which is exactly what let a descendant holding the pipes hang it
    // past its own timeout, forever. The bound now lives in armPipeCloseGrace.
    proc.on("close", (code) => {
      finishFromPipes(code);
    });
  });
}
