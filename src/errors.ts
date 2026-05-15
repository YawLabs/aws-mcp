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

// Anchor on the exact strings botocore/aws-cli emit so we don't false-positive
// on stderr that mentions "SSO", "session", and "expired" in unrelated
// contexts (e.g. "SSO admin's session expired the parameter named foo").
//
// Canonical sources (botocore/exceptions.py):
//   - SSOTokenLoadError.fmt
//       "Error loading SSO Token: {error_msg}"
//     where {error_msg} is e.g. "Token for my-profile is expired."
//   - UnauthorizedSSOTokenError.fmt
//       "The SSO session associated with this profile has expired or is
//        otherwise invalid. To refresh this SSO session run aws sso login
//        with the corresponding profile."
//   - TokenRetrievalError.fmt
//       "Error when retrieving token from {provider}: {error_msg}"
//     where {provider}="sso" and {error_msg}="Token has expired and refresh
//     failed" comes from DeferredRefreshableToken._protected_refresh in
//     botocore/tokens.py when a mandatory refresh fails on an expired token.
//
// The SDK throws an Error subclass named SSOTokenProviderFailure for the
// same family; we match that by name above the regex check.
const SSO_EXPIRED_PATTERNS: RegExp[] = [
  // "Error loading SSO Token: ..." -- the prefix is the load() failure;
  // the rest is variable (profile name, expiry phrasing) but the prefix is
  // a deterministic anchor.
  /Error loading SSO Token:/,
  // UnauthorizedSSOTokenError -- the "associated with this profile" wording
  // is distinctive enough that it can't reasonably collide with unrelated
  // stderr. We don't require the full sentence in case a wrapper truncates.
  /The SSO session associated with this profile/,
  // TokenRetrievalError content for the sso provider. The full CLI shape is
  // "Error when retrieving token from sso: Token has expired and refresh
  // failed". The trailing fragment alone is specific enough.
  /Token has expired and refresh failed/,
];
// Same treatment as SSO_EXPIRED_PATTERNS -- anchor on the exact strings
// botocore emits so we don't false-positive on stderr that happens to mention
// "no identity" or "credentials" in unrelated contexts.
//
// Canonical sources (botocore/exceptions.py):
//   - NoCredentialsError.fmt = "Unable to locate credentials"
//   - NoAuthTokenError.fmt = "Unable to locate authorization token"
//   - PartialCredentialsError.fmt =
//       "Partial credentials found in {provider}, missing: {cred_var}"
//   - CredentialRetrievalError.fmt =
//       "Error when retrieving credentials from {provider}: {error_msg}"
//   - ProfileNotFound.fmt = "The config profile ({profile}) could not be found"
//
// The JS SDK throws Error subclasses named CredentialsProviderError for the
// same family; we match that by name above the regex check.
const NO_CREDS_PATTERNS: RegExp[] = [
  /Unable to locate credentials/,
  /Unable to locate authorization token/,
  /Partial credentials found in/,
  /Error when retrieving credentials from/,
  /The config profile \([^)]+\) could not be found/,
];

export function classifyAuthError(err: unknown): { kind: AuthErrorKind; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  const blob = `${name}: ${message}`;

  if (
    name === "SSOTokenProviderFailure" ||
    name === "ExpiredTokenException" ||
    SSO_EXPIRED_PATTERNS.some((re) => re.test(blob))
  ) {
    return { kind: "sso_expired", message };
  }
  if (name === "CredentialsProviderError" || NO_CREDS_PATTERNS.some((re) => re.test(blob))) {
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
