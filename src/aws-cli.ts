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
import { killProc, procHasExited } from "./kill-proc.js";
import { getProfile, getRegion } from "./session.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024; // 5 MB per stream
// Cap the stderr we surface as an error message to avoid flooding the MCP
// response. Full stderr still lands in rawStderr for diagnosis.
const MAX_ERROR_MSG_BYTES = 8 * 1024;

// Also defends against argv injection: leading-hyphen input like "--profile evil"
// would otherwise become a flag to `aws`.
export const SAFE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * --cli-input-json can carry secrets (IAM passwords, access keys, tags with
 * PII). Keep the flag visible in displayCommand so users see the shape of
 * what ran, but replace the JSON payload with a length stub.
 */
export function redactDisplayArgs(args: readonly string[]): string[] {
  const out = [...args];
  const idx = out.indexOf("--cli-input-json");
  if (idx >= 0 && idx < out.length - 1) {
    out[idx + 1] = `<redacted len=${out[idx + 1].length}>`;
  }
  return out;
}

export function truncateForErrorMsg(text: string): string {
  if (text.length <= MAX_ERROR_MSG_BYTES) return text;
  const omitted = text.length - MAX_ERROR_MSG_BYTES;
  return `${text.slice(0, MAX_ERROR_MSG_BYTES)}\n\n[truncated; ${omitted} bytes omitted]`;
}

export interface AwsCallOptions {
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
  // Test-injection knobs, mirrored from startSsoLogin. Not exposed via MCP.
  command?: string;
  prefixArgs?: string[];
  env?: NodeJS.ProcessEnv;
}

export type AwsCallFailureKind =
  | AuthErrorKind // "sso_expired" | "no_creds" | "other"
  | "bad_input"
  | "spawn_failure"
  | "timeout"
  | "output_too_large"
  | "nonzero_exit";

export interface AwsCallSuccess {
  ok: true;
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
    args.push("--query", opts.query);
  }
  if (opts.params !== undefined && Object.keys(opts.params).length > 0) {
    args.push("--cli-input-json", JSON.stringify(opts.params));
  }

  const displayCommand = [command, ...redactDisplayArgs(args)].join(" ");

  return new Promise<AwsCallResult>((resolve) => {
    let proc: ChildProcess;
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
    // Per-stream UTF-8 decoders so a multi-byte character split across two
    // chunks doesn't decode to U+FFFD. AWS resource names / tags / S3 keys
    // routinely contain non-ASCII.
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    const settle = (result: AwsCallResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timeoutHandle = setTimeout(() => {
      // procHasExited closes the microsecond race where the subprocess exited
      // cleanly in the last few microseconds with its 'exit' callback queued
      // behind us in this same loop iteration -- libuv sets exitCode/signalCode
      // synchronously BEFORE dispatching 'exit', so if either is populated we
      // defer to the queued exit callback and a natural success isn't
      // overwritten with a timeout error. See kill-proc.ts:procHasExited.
      if (killed) return;
      if (procHasExited(proc)) return;
      killed = true;
      timedOut = true;
      killProc(proc);
    }, timeoutMs);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        if (!killed) {
          killed = true;
          tooLarge = true;
          killProc(proc);
        }
        return;
      }
      stdoutBuf += stdoutDecoder.write(chunk);
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_OUTPUT_BYTES) return;
      stderrBuf += stderrDecoder.write(chunk);
    });

    proc.on("error", (err) => {
      clearTimeout(timeoutHandle);
      settle({
        ok: false,
        kind: "spawn_failure",
        error: `Failed to run '${command}': ${err.message}. Is the AWS CLI installed and on PATH?`,
        command: displayCommand,
      });
    });

    proc.on("exit", (code) => {
      clearTimeout(timeoutHandle);
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
        } catch {
          // Some operations emit plain strings even with --output json (e.g.
          // --query expressions that extract scalars). Preserve the text.
          settle({ ok: true, data: trimmed, command: displayCommand, rawStdout: stdoutBuf });
        }
      } else {
        settle({ ok: true, data: stdoutBuf, command: displayCommand, rawStdout: stdoutBuf });
      }
    });
  });
}
