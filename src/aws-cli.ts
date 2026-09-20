/**
 * Subprocess dispatch for arbitrary aws CLI operations. The aws binary is
 * already a hard dependency (we spawn it for SSO login); delegating API calls
 * to it too means zero extra SDK packages to bundle and exactly the coverage
 * the CLI offers. Session profile/region apply by default so `aws_session_set`
 * actually sticks.
 *
 * The safety story: spawn uses an argv array (no shell), and service/operation
 * strings are regex-validated as kebab-case so user-supplied input can't pose
 * as a flag to `aws`. Params go through --cli-input-json. An extraFlags value
 * that begins `file://` or `fileb://` is refused unless the caller minted it
 * itself, because the CLI would replace such a value with the contents of that
 * local file before signing the request (see isParamFileUri).
 *
 * Every child runs with the CLI settings this server depends on pinned in its
 * environment (aws-spawn.ts PINNED_CLI_ENV): the error format the classifier
 * reads, auto-prompt off, and UTF-8 output. Those are settings a user can put
 * in ~/.aws/config that break this server rather than their own terminal. The
 * binary itself is resolved to an absolute path from the child environment's
 * PATH, or from AWS_MCP_AWS_CLI, and never from the working directory -- which
 * belongs to the MCP host, not to us. A call that carries params also pins
 * --cli-binary-format base64, the one such setting with no environment variable.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { awsChildEnv, isCliSafeFilePath, resolveAwsCommand } from "./aws-spawn.js";
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
/**
 * Ceiling on timeoutMs, because node stores a timer delay in a signed 32-bit
 * int. A larger delay does not wait longer -- node warns
 * (`TimeoutOverflowWarning: ... does not fit into a 32-bit signed integer.
 * Timeout duration was set to 1.`) and fires the timer after 1 ms, so asking for
 * 30 days timed the call out at once. Measured on node 22.22.2 with
 * `setTimeout(fn, 2 ** 31 + 1000)`.
 *
 * 2,147,483,647 ms is about 24.8 days, so clamping costs no caller anything real.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Params longer than this travel in a temp file rather than on the command line.
 *
 * Well under both OS limits -- Windows caps a whole command line at 32,767
 * characters and Linux one argument at 131,072 (both measured; a 40,000-character
 * argv entry throws ENAMETOOLONG synchronously here on node 22.22.2) -- because
 * the params JSON is not the only thing on the line, and a value just under the
 * cap would fail depending on how long the profile and region happen to be.
 * Everything below the threshold stays inline, which keeps `command` strings,
 * the fake CLI's argv parsing and 59 existing test references unchanged.
 */
export const INLINE_CLI_INPUT_JSON_MAX_CHARS = 8_192;
const CLI_INPUT_TEMP_PREFIX = "aws-mcp-input-";
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
 * The AWS CLI's paramfile loader (`awscli/paramfile.py`, registered as a
 * `load-cli-arg` handler) replaces any operation-parameter value beginning
 * `file://` or `fileb://` with the contents of that local file, before the
 * request is signed. It runs `os.path.expanduser` then `os.path.expandvars` on
 * the path first, so `~/...`, `$HOME/...` and `%USERPROFILE%/...` all resolve,
 * and it unwraps a one-element list, so a single-value `nargs='+'` argument is
 * expanded too. v2 stores the `no_paramfile` setting but never reads it, so
 * there is no per-parameter opt-out: refusing the value is the only defense.
 *
 * The match is the loader's own `str.startswith` -- exact, case-sensitive, no
 * leading whitespace. Verified on aws-cli 2.34.3 and 2.22.0 against a loopback
 * stub: `FILE://x`, `' file://x'` and `file:/x` all reach AWS as themselves, so
 * matching them too would make the rejection message a false claim about the
 * CLI and would narrow input that works today.
 *
 * `http(s)://` is deliberately absent. Only CLI v1 fetches a URL parameter
 * (`cli_follow_urlparam`, which v2 ignores), and this server does not support
 * v1 -- while an `https://` value is a legitimate Cloud Control identifier: an
 * `AWS::SQS::Queue`'s primary identifier IS its queue URL.
 */
const PARAM_FILE_PREFIX_RE = /^fileb?:\/\//;

/** True when the AWS CLI would swap `value` for the contents of a local file. */
export function isParamFileUri(value: string): boolean {
  return PARAM_FILE_PREFIX_RE.test(value);
}

/**
 * Rejection message for a tool validating its OWN input field, where the
 * convention is to name the field and leave errorKind unset. runAwsCall's
 * backstop below writes its own message, because there it is an argv entry
 * rather than a named input.
 */
export function paramFileUriMessage(fieldName: string): string {
  return `Invalid ${fieldName}: must not start with 'file://' or 'fileb://'. The AWS CLI replaces such a value with the contents of a local file before sending the request.`;
}

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

/**
 * Re-encode a JSON string so every byte is ASCII, with non-ASCII characters as
 * `\uXXXX` escapes.
 *
 * For the params temp file, because the CLI reads a `file://` param file as TEXT
 * in the locale's preferred encoding (`awscli/compat.py` `compat_open` ->
 * `getpreferredencoding`), which on Windows is the ANSI code page, not UTF-8.
 * Measured against a loopback stub on 2.34.3 and 2.22.0: a UTF-8 file holding
 * `café-日本-😀` reached the endpoint as `cafÃ©-æ—¥æœ¬-ðŸ˜€` with exit 0 --
 * silent corruption -- while the same payload written with `\u` escapes arrived
 * exactly. Escaping needs no environment variable to be right, which is why it
 * is kept even though PYTHONUTF8=1 makes an older CLI read the file as UTF-8.
 *
 * Surrogate halves are escaped individually, which is valid JSON and parses back
 * to the same astral character. Only the inside of a JSON string can hold a
 * non-ASCII character, so this never touches the structure.
 */
export function toAsciiJson(json: string): string {
  return json.replace(/[\u007f-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * The longest entry in an assembled argv, and the flag that carries it, for the
 * "too long for the command line" message. A value has a flag when the entry
 * before it starts with `--`; a positional (lambda's outfile, say) does not.
 */
function longestArgvValue(args: readonly string[]): { flag: string; length: number } {
  let at = 0;
  for (let i = 1; i < args.length; i++) {
    if (args[i].length > args[at].length) at = i;
  }
  const previous = at > 0 ? args[at - 1] : undefined;
  return {
    flag: previous?.startsWith("--") ? previous : "an argument",
    length: args.length === 0 ? 0 : args[at].length,
  };
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
  // --starting-token here. Each entry is appended verbatim to argv, except that
  // an entry beginning `file://` or `fileb://` is refused unless it is listed in
  // trustedParamFileArgs.
  extraFlags?: string[];
  /**
   * Exact argv entries this caller minted itself, compared by `===`. The
   * paramfile guard skips those values and nothing else, so every other value
   * in the same call stays guarded.
   *
   * The only user today is tools/lambda.ts, whose
   * `--payload fileb://<mkdtemp>/payload.json` names a path the server wrote --
   * the caller controls the file's contents, never its location. Never put a
   * caller-supplied string here: a whole-call opt-out would unguard the rest of
   * that argv too, `--qualifier` included.
   */
  trustedParamFileArgs?: readonly string[];
  // Test-injection knobs, mirrored from startSsoLogin. Not exposed via MCP.
  command?: string;
  prefixArgs?: string[];
  /**
   * Environment for the child process.
   *
   * REPLACES the parent environment rather than merging into it -- that is
   * node's spawn semantics, not a choice made here -- so a caller that only
   * wants to ADD a variable has to spread `process.env` itself. Every existing
   * caller does.
   *
   * Started life as a test-injection knob alongside command/prefixArgs (the
   * suites use it to point one spawn at a fake-aws scenario). It is now also a
   * production path: aws_multi_account hands each per-account spawn its own
   * assumed-role credentials this way, so the credentials live for the lifetime
   * of one subprocess instead of being written into the shared credentials
   * file.
   *
   * The pinned CLI settings (aws-spawn.ts PINNED_CLI_ENV) are layered on top of
   * whatever is passed here and cannot be overridden from it -- by design: they
   * exist because those settings change the output this module parses. Anything
   * else set here survives, which is what keeps aws_multi_account's credentials
   * and tools/lambda.ts's AWS_MAX_ATTEMPTS=1 reaching the child.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Leave `--profile` off argv entirely. For callers that supply credentials
   * through `env` rather than by naming a profile.
   *
   * Load-bearing, not cosmetic. botocore drops the ENVIRONMENT credential
   * provider from its resolution chain the moment a profile is set as a session
   * INSTANCE variable, and the CLI's `--profile` flag is exactly that
   * (create_credential_resolver: `disable_env_vars =
   * session.instance_variables().get('profile') is not None`, then
   * `providers.remove(env_provider)`). The AWS_PROFILE env var does NOT trip it,
   * because it resolves through the config chain rather than as an instance
   * variable -- so the flag is the specific thing that has to go. Passing both
   * `env` credentials and `--profile` does not error: it silently ignores the
   * credentials and runs as the profile, which for a cross-account fan-out means
   * every "account" in the batch quietly answering from the operator's own.
   *
   * Caveat for any future caller: the auth-class failure messages further down
   * still name the profile this function RESOLVED, and an omitProfile call never
   * used it. Rewrite those to name the identity you actually supplied
   * (aws_multi_account names the account) or the reader gets sent to
   * re-authenticate something unrelated to the failure.
   */
  omitProfile?: boolean;
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
   * without JSON quoting). Otherwise only genuinely scalar-looking stdout takes
   * the string branch -- text that opens with `{` or `[` and fails to parse is a
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
  /**
   * The one-line remedy parseAwsError derived from a recognized AWS error code,
   * when it recognized one. Present on the `nonzero_exit` branch only: the
   * auth-class branches above it build their own remedy into `error` and name
   * the profile (which parseAwsError cannot), so a second, differently worded
   * suggestion beside it would be two instructions for one failure -- the defect
   * v2.0.1 fixed in aws_assume_role and aws_resource_*.
   *
   * Still embedded in `error` as well, and that duplication is deliberate rather
   * than an oversight to tidy up: aws_multi_region carries only per-region
   * `error` TEXT (RegionResult has no suggestion field), so moving the sentence
   * out of the message would silently drop the remedy from every multi-region
   * failure. Read this field instead of splitting the string; toMcpResult does
   * not re-render it.
   */
  suggestion?: string;
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

/**
 * Local CLI commands that print credentials or recorded traffic to stdout, keyed
 * by `<service> <operation>`.
 *
 * These are the one class of `aws` command IAM cannot gate: they send no request,
 * so there is no policy to deny them, and whatever they print lands in the
 * model's context and the host's transcript. Measured on aws-cli 2.34.3 against a
 * throwaway credentials file: `configure export-credentials` returns
 * `{"Version":1,"AccessKeyId":"AKIA...","SecretAccessKey":"..."}` -- the full
 * secret, not the masked form `configure list` shows -- and for a static-key
 * profile those are long-lived keys no STS call would ever hand out. `history
 * show` / `list` replay the requests and responses the CLI recorded locally.
 *
 * `configure get` cannot be reached through these tools today (it needs a
 * positional `varname`, and `configure` rejects `--cli-input-json`, so the call
 * fails with ParamValidation before any secret is read), but it reads the same
 * values by name and is listed so that stays true if a positional path is ever
 * added.
 *
 * This is an accident guard, not an authority boundary -- the escape hatch is the
 * operator's own shell, which is where reading your own keys belongs. It does not
 * revisit the project's "IAM is the authority" decision: that is about AWS API
 * calls, where scoping credentials is the right gate, and none of these makes one.
 */
const LOCAL_DISCLOSURE_COMMANDS = new Map<string, string>([
  [
    "configure export-credentials",
    "prints that profile's resolved credentials, including the full secret access key and any long-lived keys from ~/.aws/credentials",
  ],
  ["configure get", "reads any value out of your AWS config by name, including the stored secret access key"],
  ["history show", "replays the requests and responses the AWS CLI recorded locally, which can include credentials"],
  ["history list", "lists the AWS CLI commands recorded locally, with their arguments"],
]);

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
  // Checked after the shape rules, so a malformed name still gets the message
  // about its shape. Each of these commands is the service plus ONE token, and
  // only that pair is matched: a caller who appends anything ("export-credentials
  // json") still names the same command, and the CLI ignores or rejects the extra
  // rather than doing something else.
  const command = `${service} ${operationTokens[0]}`;
  const disclosure = LOCAL_DISCLOSURE_COMMANDS.get(command);
  if (disclosure) {
    return `Refusing to run '${command}': it ${disclosure}, and that output would land in this conversation. It sends no request to AWS, so no IAM policy can limit it. Run it yourself in a terminal if you need those values.`;
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
  //
  // Skipped for omitProfile callers because the value never reaches argv for
  // them, and the check exists only to keep it from posing as a flag. Running
  // it anyway would fail a call that uses no profile at all whenever the
  // operator's shell happens to carry a malformed AWS_PROFILE.
  if (!opts.omitProfile && !isValidProfileName(profile)) {
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
  // The paramfile backstop (see isParamFileUri). It covers every tool's argv
  // values -- including the ones that come back from AWS, such as the request
  // token awaitCompletion polls with -- from one place, so a new extraFlags
  // call site is guarded before anyone remembers to guard it.
  //
  // extraFlags is the whole scope, deliberately:
  //   - `query` goes to --query, a GLOBAL arg the loader does not run on
  //     (verified: a `file://` query is a JMESPath parse error, no request);
  //   - `params` is JSON.stringify'd, so the value always starts with `{` and
  //     its nested members are passed through literally;
  //   - `prefixArgs` are test-only injection;
  //   - `service` and the operation tokens match SAFE_NAME_RE, which has no `/`.
  // Scanning opts.extraFlags rather than the assembled argv is also what keeps
  // a future server-minted `--cli-input-json file://<temp>` transport out of it.
  //
  // Both argv spellings are covered: `--flag value` as two entries, and
  // `--flag=value` as one, the second by the segment after the first `=` --
  // that is where the loader looks. Verified on aws-cli 2.34.3 against a
  // loopback stub: `--identifier=file://<path>` reaches the endpoint as the
  // file's contents, while the near misses stay near misses there too
  // (`=FILE://` and `=file:/` travel literally). No tool builds the combined
  // form today; the scan covers it so the first one that does is guarded.
  const extra = opts.extraFlags ?? [];
  const trusted = opts.trustedParamFileArgs;
  for (let idx = 0; idx < extra.length; idx++) {
    const value = extra[idx];
    if (trusted?.includes(value)) continue;
    // A trusted whole entry is listed as the whole entry, so check both
    // spellings against the list: a caller minting `--payload=fileb://<tmp>`
    // exempts that string, not the bare `fileb://<tmp>` inside it.
    const eq = value.startsWith("--") ? value.indexOf("=") : -1;
    const inner = eq > 0 ? value.slice(eq + 1) : null;
    const combined = inner !== null && isParamFileUri(inner) && !trusted?.includes(inner);
    if (!combined && !isParamFileUri(value)) continue;
    // Name the flag when there is one, so the caller learns WHICH field it was.
    // A positional entry (lambda's outfile, say) has no flag to name.
    const shown = combined ? (inner as string) : value;
    const where = combined
      ? `the value of ${value.slice(0, eq)}`
      : idx > 0 && extra[idx - 1].startsWith("--")
        ? `the value of ${extra[idx - 1]}`
        : "a command-line argument";
    const preview = shown.length > 60 ? `${shown.slice(0, 60)}...` : shown;
    return Promise.resolve({
      ok: false,
      kind: "bad_input",
      error: `Refusing '${preview}' as ${where}: the AWS CLI would replace a value starting with 'file://' or 'fileb://' with the contents of that local file and send them to AWS.`,
    });
  }
  const outputFormat = opts.outputFormat ?? "json";
  // Clamped, not rejected: a caller asking for more than 24.8 days wants "do not
  // time this out", and the clamp gives it -- where the raw value gave the
  // opposite (see MAX_TIMEOUT_MS).
  const timeoutMs = Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

  // The --query length check, hoisted out of the argv block below so it runs
  // BEFORE the binary is resolved: an over-long JMESPath expression is the
  // caller's bad_input whether or not this machine has an AWS CLI, and
  // reporting it as spawn_failure would send the reader after the wrong thing.
  // Same empty-query rule as the push below -- a whitespace-only query is not
  // passed and so is not measured.
  const query = opts.query !== undefined && opts.query.trim().length > 0 ? opts.query : undefined;
  if (query !== undefined && query.length > 2048) {
    return Promise.resolve({
      ok: false,
      kind: "bad_input",
      error: `query expression too long (${query.length} chars; max 2048). Simplify the JMESPath expression.`,
    });
  }

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
  const prefixArgs = opts.prefixArgs ?? envPrefixArgs ?? [];

  // WHICH binary runs, resolved to an absolute path -- never the bare name
  // `aws`. On Windows a bare spawn searches the process's working directory
  // before PATH (libuv's search_path, unless the host set
  // NoDefaultCurrentDirectoryInExePath, which not every MCP host does), and on
  // POSIX an empty or `.` PATH entry means the working directory to execvp --
  // and that directory belongs to the MCP host, typically the user's open
  // project. See aws-spawn.ts resolveAwsCommand, which also reads the
  // AWS_MCP_AWS_CLI override.
  const resolution = resolveAwsCommand({ explicit: opts.command ?? envCommand, env: opts.env ?? process.env });
  if (!resolution.ok) {
    // No `command` in the envelope: nothing was assembled and nothing ran, so
    // there is no invocation to show -- the same shape as every other failure
    // this function returns before the spawn.
    return Promise.resolve({ ok: false, kind: "spawn_failure", error: resolution.error });
  }
  const command = resolution.command;

  const args: string[] = [
    ...prefixArgs,
    opts.service,
    ...operationTokens,
    ...(opts.extraFlags ?? []),
    "--output",
    outputFormat,
    // Conditional so the flag is ABSENT, not empty, for omitProfile callers --
    // see AwsCallOptions.omitProfile for why its mere presence would discard
    // the credentials such a caller passed in `env`. The default path keeps the
    // exact `--output F --profile P --region R` order the fake-aws scenarios
    // index into (several read the token after `--region`).
    ...(opts.omitProfile ? [] : ["--profile", profile]),
    "--region",
    region,
  ];
  if (query !== undefined) {
    args.push("--query", query);
  }
  // The temp directory holding this call's params file, when one was needed.
  // Removed in settle() -- the CLI reads the file while it starts up, long before
  // it exits -- and on the synchronous-throw path below.
  let inputDir: string | null = null;
  const removeInputDir = (): void => {
    if (inputDir === null) return;
    try {
      rmSync(inputDir, { recursive: true, force: true });
    } catch {
      // Best effort. A server killed hard between the write and the settle can
      // leave one 0600 params.json in the user's temp dir; tools/lambda.ts has
      // the same exposure for its payload file.
    }
    inputDir = null;
  };

  // Set when the params went to a file: the argv index of the `file://` value and
  // the inline JSON to show there instead, so `command` reads the same whichever
  // transport carried the payload and the redaction stub keeps reporting the
  // payload's length rather than a temp path's.
  let paramsDisplay: { index: number; inline: string } | null = null;
  if (opts.params !== undefined && Object.keys(opts.params).length > 0) {
    const json = JSON.stringify(opts.params);
    // The one CLI setting that cannot be pinned through the environment:
    // `cli_binary_format` is config-only, and with the common
    // `raw-in-base64-out` value the CLI base64-encodes a blob parameter AGAIN.
    // Measured on 2.34.3 and 2.22.0 against a loopback stub: `dynamodb put-item`
    // with `B: "aGVsbG8="` put `YUdWc2JHOD0=` on the wire, so AWS stored the
    // base64 text instead of the bytes, silently. Both CLIs accept the flag (it
    // exists in every 2.x) and the flag beats the config.
    //
    // Only on calls that CARRY params, and immediately before --cli-input-json,
    // for three reasons: a blob can only arrive inside that payload (extraFlags
    // carry CCAPI JSON strings, pagination tokens and lambda's fileb://, which is
    // raw regardless); AWS CLI v1 has no such global option, so pinning it on
    // every call would turn "unsupported but mostly working" into "nothing
    // works"; and here it leaves the contiguous `--output F --profile P --region
    // R` block that fake-aws and lambdaOutfileFromArgv index into alone.
    args.push("--cli-binary-format", "base64");
    if (json.length <= INLINE_CLI_INPUT_JSON_MAX_CHARS) {
      args.push("--cli-input-json", json);
    } else {
      // Above the threshold the payload cannot ride on the command line at all
      // on Windows, and the failure used to be `spawn ENAMETOOLONG. Is the AWS
      // CLI installed and on PATH?` -- a message about a PATH that was fine. A
      // CloudFormation template body (up to 51,200 bytes), a Step Functions
      // definition or an SSM document all reach this size legitimately.
      const dir = tmpdir();
      if (!isCliSafeFilePath(dir)) {
        // Checked before writing, so the caller hears about TMP/TEMP rather than
        // a CLI error about a path it never wrote: the CLI runs
        // expandvars(expanduser()) on a file:// path (awscli/paramfile.py).
        return Promise.resolve({
          ok: false,
          kind: "bad_input",
          error:
            `The request params are ${json.length} characters, so they must travel in a temp file, but the temp ` +
            `directory (${dir}) contains '$' or '%' or starts with '~', which the AWS CLI expands in a file:// path. ` +
            `Point TMP/TEMP (Windows) or TMPDIR at a plain directory.`,
        });
      }
      let paramsFile: string;
      try {
        inputDir = mkdtempSync(join(dir, CLI_INPUT_TEMP_PREFIX));
        paramsFile = join(inputDir, "params.json");
        // 0600 and `wx`: the payload can hold credentials or a SecureString
        // value, and it lives in a directory mkdtemp created for this call alone
        // (0700 on POSIX, the per-user %TEMP% ACL on Windows).
        writeFileSync(paramsFile, toAsciiJson(json), { mode: 0o600, flag: "wx" });
      } catch (err) {
        removeInputDir();
        return Promise.resolve({
          ok: false,
          kind: "spawn_failure",
          error: `Could not write the request params to a temp file: ${err instanceof Error ? err.message : String(err)}.`,
        });
      }
      args.push("--cli-input-json", `file://${paramsFile}`);
      paramsDisplay = { index: args.length - 1, inline: json };
    }
  }

  const displayArgs =
    paramsDisplay === null ? args : args.map((value, i) => (i === paramsDisplay.index ? paramsDisplay.inline : value));

  // Display string for logging / the MCP response, shell-quoted per entry so
  // it survives a paste into a POSIX shell. The real invocation still uses the
  // argv array above (no shell involved), so the quoting here is purely about
  // what the caller SEES -- and the caller is a model that will paste it.
  // `resolution.display`, not `command`: for a resolved or overridden binary
  // that is the literal `aws`, because the absolute path is noise to the reader
  // (and, for the override, the operator's own file layout). A test seam's
  // command still shows itself.
  const displayCommand = [resolution.display, ...redactDisplayArgs(displayArgs)].map(shellQuoteArg).join(" ");

  return new Promise<AwsCallResult>((resolve) => {
    let proc: ChildProcess;
    // This catch is reachable, which the comment here used to deny. Node throws
    // synchronously for every spawn errno except EACCES, EAGAIN, EMFILE, ENFILE
    // and ENOENT -- so an argv too long for the OS lands here: measured
    // ENAMETOOLONG for a 40,000-character argv entry on Windows (node 22.22.2)
    // and E2BIG for a 131,072-character one on Linux. A `.cmd` path gives EINVAL
    // the same way. ENOENT, the failure that actually happens when no CLI is
    // there, still arrives async on the 'error' event below.
    //
    // It also buys the envelope: a throw inside a Promise executor REJECTS the
    // promise, and every caller of runAwsCall consumes an AwsCallResult without
    // try/catch, so without this the exotic cases would surface as unhandled
    // rejections instead.
    try {
      proc = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        // `env` is always passed now, because the pins have to be there whether
        // or not the caller brought an environment of its own. awsChildEnv
        // layers them over a copy of `opts.env ?? process.env`, so the
        // REPLACE-the-parent semantics AwsCallOptions.env documents are
        // unchanged for everything else in it.
        env: awsChildEnv(opts.env ?? process.env),
      });
    } catch (err) {
      removeInputDir();
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENAMETOOLONG" || code === "E2BIG") {
        // bad_input, not spawn_failure: the caller's own value is what does not
        // fit, and runAwsCall already answers an over-long --query the same way.
        // After the params temp file above, only an extraFlags payload (a large
        // CCAPI --desired-state or --patch-document) can still get here.
        const longest = longestArgvValue(args);
        resolve({
          ok: false,
          kind: "bad_input",
          error:
            `The request is too large to pass to the AWS CLI on its command line (spawn ${code}): the longest value ` +
            `is ${longest.flag} at ${longest.length} characters. Windows caps a whole command line at 32,767 ` +
            `characters and Linux caps one argument at 131,072. Params over ${INLINE_CLI_INPUT_JSON_MAX_CHARS} ` +
            `characters already travel in a temp file -- shrink or split this value.`,
          command: displayCommand,
        });
        return;
      }
      resolve({
        ok: false,
        kind: "spawn_failure",
        error: `Failed to spawn '${command}': ${err instanceof Error ? err.message : String(err)}.${
          code === "ENOENT" ? " Is the AWS CLI installed and on PATH?" : ""
        }`,
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
      // Also the single place the params temp file goes away. Safe here rather
      // than at 'exit': the CLI reads a file:// param while it starts up, and
      // every settle path is either past the child's death or a timeout that has
      // already killed it.
      removeInputDir();
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
        // Only the nonzero_exit branch below assigns this -- the auth-class
        // branches build their own profile-aware remedy into errorMsg instead.
        // See AwsCallFailure.suggestion.
        let suggestion: string | undefined;
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
          suggestion = parsed.suggestion;
          errorMsg = parsed.suggestion ? `${baseMsg}\n\nSuggestion: ${parsed.suggestion}` : baseMsg;
        }
        settle({
          ok: false,
          kind,
          // Conditional spread: omit the key entirely rather than emitting
          // `suggestion: undefined` on the auth-class branches, which have no
          // suggestion to give.
          ...(suggestion !== undefined ? { suggestion } : {}),
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
          if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
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
      // The PATH hint only where PATH could be the answer. ENOENT after a
      // successful resolution means the file went away between the stat and the
      // spawn, or a test seam named a binary that does not exist; any other
      // errno (EACCES, EINVAL for a script shim) is not about PATH at all, and
      // the old unconditional sentence sent readers to check one that was fine.
      const enoent = (err as NodeJS.ErrnoException).code === "ENOENT";
      settle({
        ok: false,
        kind: "spawn_failure",
        error: `Failed to run '${command}': ${err.message}.${enoent ? " Is the AWS CLI installed and on PATH?" : ""}`,
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
