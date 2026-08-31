/**
 * Classify an error from the aws CLI subprocess into one of a small set of
 * actionable kinds, so callers can surface the right fix-it message (re-login
 * / fix creds / show raw error).
 *
 * TEXT ONLY -- there is no SDK side. This package ships zero runtime
 * dependencies and does not depend on @aws-sdk at all; every AWS call is a
 * subprocess to the `aws` binary. The single production caller is
 * aws-cli.ts's exit handler, which does `classifyAuthError(new Error(stderr))`
 * -- so `err.name` is always the literal "Error", and matching on SDK class
 * names (SSOTokenProviderFailure / ExpiredTokenException /
 * CredentialsProviderError) classified nothing that ever reached here. Those
 * branches are gone; the anchored stderr patterns below are the whole
 * classifier.
 *
 * Add new patterns as CLI stderr text, anchored tightly enough that ordinary
 * prose can't trip them.
 */

export type AuthErrorKind = "sso_expired" | "expired_creds" | "no_creds" | "invalid_creds" | "other";

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
// Everything in THIS list is SSO-specific by construction: each string comes
// from botocore's SSO token provider and from nothing else, so "run
// aws_login_start" is unambiguously the right remedy. The service-side
// ExpiredToken wrapper is deliberately NOT here -- see EXPIRED_CREDS_PATTERNS.
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

// Temporary credentials that were VALID and have since expired -- but whose
// origin this text does not reveal.
//
// The service-side expiry does not come from botocore at all: STS and friends
// reject an expired session token with the standard wrapper
//   "An error occurred (ExpiredToken) when calling the X operation: The
//    security token included in the request is expired"
// and they emit it for ANY expired temporary credential -- an assume-role
// session, a web-identity session, an SSO-derived one, a `credential_process`
// one. The stderr carries nothing that distinguishes them.
//
// This is its own kind rather than an SSO_EXPIRED_PATTERNS entry precisely
// because of that ambiguity. Folding it in classified a plain assume-role user
// as sso_expired and told them to run aws_login_start, which does not refresh
// an STS session -- wrong advice, and via aws_assume_role the underlying stderr
// was dropped too, so nothing on screen contradicted it. The caller message for
// this kind names both remedies (re-login for SSO, re-assume for STS) and keeps
// the raw stderr.
//
// Anchored on "An error occurred (" + the code so a bare mention of the word in
// prose cannot match. Covers the STS spelling (ExpiredToken) and the
// service-exception spelling (ExpiredTokenException).
const EXPIRED_CREDS_PATTERNS: RegExp[] = [/An error occurred \(ExpiredToken(?:Exception)?\)/];

// Credentials that EXIST but the service refuses. Distinct from no_creds
// (nothing resolved at all): the fix is different -- rotate / re-issue the key
// or fix the clock, not "configure a profile".
//
// Canonical shapes, all via the standard wrapper:
//   - UnrecognizedClientException: "The security token included in the request
//     is invalid" (a deleted/rotated access key, or a token for another
//     partition).
//   - InvalidClientTokenId: same family, the STS/IAM spelling.
//   - SignatureDoesNotMatch: the secret key is wrong, or -- the classic -- the
//     machine's clock has drifted far enough to invalidate SigV4.
const INVALID_CREDS_PATTERNS: RegExp[] = [
  /An error occurred \((?:UnrecognizedClientException|InvalidClientTokenId|SignatureDoesNotMatch)\)/,
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
const NO_CREDS_PATTERNS: RegExp[] = [
  /Unable to locate credentials/,
  /Unable to locate authorization token/,
  /Partial credentials found in/,
  /Error when retrieving credentials from/,
  /The config profile \([^)]+\) could not be found/,
];

export function classifyAuthError(err: unknown): { kind: AuthErrorKind; message: string } {
  // Message text only. `err.name` is not consulted: the sole production caller
  // constructs `new Error(stderrBuf)`, so it is always "Error". See the file
  // header.
  const message = err instanceof Error ? err.message : String(err);

  // SSO first: its patterns name the SSO token provider explicitly, so when one
  // of them matches we know the origin and can give the SSO-specific remedy.
  // expired_creds is the fallback for the origin-agnostic wrapper.
  if (SSO_EXPIRED_PATTERNS.some((re) => re.test(message))) {
    return { kind: "sso_expired", message };
  }
  if (EXPIRED_CREDS_PATTERNS.some((re) => re.test(message))) {
    return { kind: "expired_creds", message };
  }
  if (INVALID_CREDS_PATTERNS.some((re) => re.test(message))) {
    return { kind: "invalid_creds", message };
  }
  if (NO_CREDS_PATTERNS.some((re) => re.test(message))) {
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
// Not exported: parseAwsError's callers use the returned object's fields
// directly and no .d.ts ships, so nothing needs to name the type.
interface ParsedAwsError {
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
    } else if (
      // Every service spells rate-limiting differently: ThrottlingException is
      // the common one, but S3 says SlowDown, API Gateway / Lambda say
      // TooManyRequestsException, and DynamoDB says
      // ProvisionedThroughputExceededException. Same remedy for all of them.
      code === "ThrottlingException" ||
      code === "Throttling" ||
      code === "RequestLimitExceeded" ||
      code === "TooManyRequestsException" ||
      code === "SlowDown" ||
      code === "ProvisionedThroughputExceededException"
    ) {
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
      // Origin-agnostic on purpose, matching EXPIRED_CREDS_PATTERNS above: AWS
      // emits this code for any expired temporary credential, so naming only
      // aws_login_start sent assume-role users at a tool that cannot refresh
      // their session.
      out.suggestion =
        "Temporary credentials have expired: re-run aws_login_start for an SSO profile, or aws_assume_role for an STS session.";
    } else if (code === "ResourceAlreadyExistsException" || code === "AlreadyExistsException") {
      out.suggestion = "The resource already exists -- use aws_resource_update or pick a different identifier.";
    } else if (code === "ConflictException") {
      out.suggestion =
        "Resource state conflicts with the requested operation; check current state with aws_resource_get.";
    }
    return out;
  }

  // Not-authorized text OUTSIDE the standard wrapper. Above, NOT_AUTHORIZED_RE
  // only ever runs against m[3] -- the message captured inside "An error
  // occurred (...) when calling ...". The same sentence also shows up bare:
  // CCAPI / cloudcontrol surface it without the wrapper, as do several
  // higher-level `aws` customizations. Without this the most actionable
  // stderr the CLI produces fell through to message-only, no suggestion.
  const bareNotAuthorized = NOT_AUTHORIZED_RE.exec(trimmed);
  if (bareNotAuthorized) {
    return {
      message: trimmed,
      suggestion: `Check IAM permissions: principal ${bareNotAuthorized[1]} lacks ${bareNotAuthorized[2]}.`,
    };
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
