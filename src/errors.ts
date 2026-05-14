/**
 * Classify an unknown error from the AWS SDK or the aws CLI subprocess into
 * one of a small set of actionable kinds, so callers can surface the right
 * fix-it message (re-login / fix creds / show raw error).
 *
 * Both the SDK and the CLI get routed through here — the regexes cover both
 * sources. Patterns:
 *   - SDK throws Error subclasses named SSOTokenProviderFailure,
 *     ExpiredTokenException, CredentialsProviderError.
 *   - CLI prints stderr strings like "Error loading SSO Token: ...",
 *     "Unable to locate credentials", etc. We wrap CLI stderr in `new Error()`
 *     before calling classify, so it arrives as a plain Error.
 */

export type AuthErrorKind = "sso_expired" | "no_creds" | "other";

// All gaps are bounded with `[^\n]{0,N}` so the regex can't span unrelated
// log lines or run away on long stderr blobs that happen to mention both
// "sso/session/token" and "expired/invalid" far apart. The 80/40-char
// budgets are comfortably wider than every real CLI string seen in
// errors.test.ts; tighten further if a benign false-positive shows up.
const SSO_EXPIRED_RE =
  /SSOTokenProviderFailure|SSO[^\n]{0,80}session[^\n]{0,80}(?:expired|invalid)|token[^\n]{0,40}is\s+expired|no cached sso token|error loading sso token/i;
const NO_CREDS_RE = /CredentialsProviderError|could not load credentials|no identity|unable to locate credentials/i;

export function classifyAuthError(err: unknown): { kind: AuthErrorKind; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  const blob = `${name}: ${message}`;

  if (SSO_EXPIRED_RE.test(blob) || name === "ExpiredTokenException") {
    return { kind: "sso_expired", message };
  }
  if (NO_CREDS_RE.test(blob)) {
    return { kind: "no_creds", message };
  }
  return { kind: "other", message };
}

/**
 * Structured shape pulled out of common AWS CLI stderr blobs. Every field is
 * optional; the parser is best-effort. The agent uses these to decide whether
 * to retry, escalate to IAM, or fix the request -- raw stderr is preserved
 * separately for diagnosis.
 */
export interface ParsedAwsError {
  code?: string;
  operation?: string;
  message?: string;
  suggestion?: string;
}

// `An error occurred (Code) when calling the Operation operation: Message`
// -- the standard botocore / aws CLI shape. We bound the gap with `[\s\S]*?`
// non-greedy so the regex can't run away on a multi-line stderr blob that
// happens to contain another "An error occurred" later (rare; defensive).
const STD_ERROR_RE = /An error occurred \(([^)]+)\) when calling the (\S+) operation:\s*([\s\S]*?)(?:\n\n|$)/;
// "User: arn:aws:iam::123:user/foo is not authorized to perform: lambda:CreateFunction"
const NOT_AUTHORIZED_RE = /User:\s*(\S+)\s*is not authorized to perform:\s*(\S+)/i;
// "Could not connect to the endpoint URL: \"https://lambda.us-east-9.amazonaws.com/\""
const BAD_ENDPOINT_RE = /Could not connect to the endpoint URL[:\s]+"?([^"\s]+)"?/i;
// "Parameter validation failed: Missing required parameter ..."
const PARAM_VALIDATION_RE = /Parameter validation failed/i;

/**
 * Best-effort structured extraction of an AWS CLI stderr blob. Returns
 * { code?, operation?, message?, suggestion? }; missing fields are absent.
 * Auth-class errors are still classified separately by classifyAuthError --
 * this parser focuses on the post-auth API failure shapes.
 */
export function parseAwsError(stderr: string): ParsedAwsError {
  const trimmed = stderr.trim();
  if (!trimmed) return {};

  const m = STD_ERROR_RE.exec(trimmed);
  if (m) {
    const code = m[1];
    const operation = m[2];
    const message = m[3].trim();
    const out: ParsedAwsError = { code, operation, message };
    const naMatch = NOT_AUTHORIZED_RE.exec(message);
    if (naMatch) {
      out.suggestion = `Check IAM permissions: principal ${naMatch[1]} lacks ${naMatch[2]}.`;
    } else if (code === "AccessDenied" || code === "AccessDeniedException" || code === "UnauthorizedOperation") {
      out.suggestion = "Check IAM permissions for this operation.";
    } else if (code === "ThrottlingException" || code === "Throttling" || code === "RequestLimitExceeded") {
      out.suggestion = "Reduce request rate or retry with backoff.";
    } else if (
      code === "ResourceNotFoundException" ||
      code === "NoSuchBucket" ||
      code === "NoSuchKey" ||
      code === "NotFoundException"
    ) {
      out.suggestion = "Verify the resource identifier and region.";
    } else if (
      code === "ValidationException" ||
      code === "ValidationError" ||
      code === "InvalidParameterValue" ||
      code === "InvalidParameter"
    ) {
      out.suggestion = "Check the operation parameters against the API schema.";
    } else if (code === "ExpiredToken" || code === "ExpiredTokenException") {
      out.suggestion = "Re-authenticate with aws_login_start.";
    } else if (code === "ResourceAlreadyExistsException" || code === "AlreadyExistsException") {
      out.suggestion = "The resource already exists -- use aws_resource_update or pick a different identifier.";
    } else if (code === "ConflictException") {
      out.suggestion =
        "Resource state conflicts with the requested operation; check current state with aws_resource_get.";
    }
    return out;
  }

  const endpointMatch = BAD_ENDPOINT_RE.exec(trimmed);
  if (endpointMatch) {
    return {
      message: trimmed,
      suggestion: `Could not reach endpoint ${endpointMatch[1]}. Check the region spelling and network connectivity.`,
    };
  }

  if (PARAM_VALIDATION_RE.test(trimmed)) {
    return {
      message: trimmed,
      suggestion: "Fix parameter shape: check casing, required fields, and types against the API schema.",
    };
  }

  return { message: trimmed };
}
