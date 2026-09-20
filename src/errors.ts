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
  // How many times the CLI had already retried before it gave up, when its
  // message says so. RETRIES, not attempts: 0 means the first attempt was also
  // the last. Only the throttling suggestion reads it.
  retries?: number;
}

// `An error occurred (Code) when calling the Operation operation: Message`
// -- the standard botocore / aws CLI shape, with two variations that both
// defeated the earlier pattern (each reproduced against a loopback stub on
// aws-cli 2.34.3 and 2.22.0):
//
//   - Once botocore stops retrying it marks the error MaxAttemptsReached, and
//     its MSG_TEMPLATE then inserts " (reached max retries: N)" between the
//     operation name and the colon. Requiring `operation:` immediately meant
//     no match at all, so every retry-exhausted error -- throttling and 5xx,
//     the cases the backoff suggestion was written for -- lost its code,
//     operation and suggestion. The infix appears on the FIRST failure too
//     when max_attempts is 1 (`AWS_MAX_ATTEMPTS=1`, which aws_lambda_invoke
//     sets), and then N is 0.
//   - The terminator accepts CRLF. On Windows the CLI separates the message
//     from its "Additional error details:" block with "\r\n\r\n", which
//     contains no "\n\n", so the captured message used to run on into that
//     block.
//
// We bound the gap with `[\s\S]*?` non-greedy so the regex can't run away on a
// multi-line stderr blob that happens to contain another "An error occurred"
// later (rare; defensive).
const STD_ERROR_RE =
  /An error occurred \(([^)]+)\) when calling the (\S+) operation(?: \(reached max retries: (\d+)\))?:\s*([\s\S]*?)(?:\r?\n\r?\n|$)/;
// "User: arn:aws:iam::123:user/foo is not authorized to perform: lambda:CreateFunction"
const NOT_AUTHORIZED_RE = /User:\s*(\S+)\s*is not authorized to perform:\s*(\S+)/i;

// The CLI's own argparse rejection of a service, operation or subcommand it does
// not know -- usually one newer than the installed CLI, or a misspelling. Three
// dests: `command` (service), `operation`, `subcommand` (waiters, `s3`,
// `configure`). Unanchored on purpose; every shape below was captured from a real
// CLI driven against a dead loopback endpoint, which argparse rejects before any
// request is sent (exit 252):
//
//   2.34.0+ enhanced error format, the default:
//     "aws: [ERROR]: An error occurred (ParamValidation): argument operation: Found invalid choice 'cancel-jobs'"
//   2.34.0+ with cli_error_format=legacy, or with a --profile the CLI cannot find:
//     "aws: [ERROR]: argument operation: Found invalid choice 'cancel-jobs'"
//   2.34.0+ json / yaml / text / table formats: the same phrase inside `Message`
//   2.22.0 (pre-2.34, no error formats):
//     "aws.exe: error: argument operation: Invalid choice, valid choices are:" + the list
//
// The enhanced wrapper carries no "when calling the X operation" tail, so
// STD_ERROR_RE cannot claim it and this branch still sees it -- errors.test.ts
// pins that both ways. 2.22.0 names no choice at all on the service form (it
// prints a ~17 KB service list instead), hence the second alternative with no
// capture.
const INVALID_CHOICE_RE =
  /argument (command|operation|subcommand): (?:Found invalid choice '([^'\r\n]+)'|Invalid choice, valid choices are:)/;
// argparse's dest name -> the word the caller would recognize. Only the three
// keys above can reach it; the fallback exists because Map.get is nullable.
const INVALID_CHOICE_NOUN: ReadonlyMap<string, string> = new Map([
  ["command", "service"],
  ["operation", "operation"],
  ["subcommand", "subcommand"],
]);

// "Could not connect to the endpoint URL: \"https://lambda.us-east-9.amazonaws.com/\""
const BAD_ENDPOINT_RE = /Could not connect to the endpoint URL[:\s]+"?([^"\s]+)"?/i;
// The two enterprise-network failures on the CLI path, straight from botocore's
// own fmt strings (awscli/botocore/exceptions.py), raised from
// httpsession.py's send():
//   - SSLError.fmt = 'SSL validation failed for {endpoint_url} {error}', where
//     endpoint_url is the request URL (unquoted) and {error} is urllib3's, e.g.
//     "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: unable to get
//     local issuer certificate".
//   - ProxyConnectionError.fmt = 'Failed to connect to proxy URL: "{proxy_url}"',
//     and botocore passes it through mask_proxy_url first, so any user:password@
//     in the value is already "***:***@" by the time it reaches us. The proxy URL
//     itself comes from the environment and only from there: endpoint.py's
//     _get_proxies returns get_environ_proxies(url), over a comment saying a
//     config file COULD be supported, and the profile carries only
//     proxy_ca_bundle / proxy_client_cert / proxy_use_forwarding_for_https.
// Neither had a remedy, so the CLI half of the same failure docs.ts's
// describeFetchFailure explains for the in-process fetch path said nothing. The
// endpoint quotes are optional for the same reason BAD_ENDPOINT_RE's are.
const SSL_VALIDATION_RE = /SSL validation failed for\s+"?([^"\s]+)"?/i;
const PROXY_CONNECT_RE = /Failed to connect to proxy URL[:\s]+"?([^"\s]+)"?/i;
// "Parameter validation failed: Missing required parameter ..."
const PARAM_VALIDATION_RE = /Parameter validation failed/i;

// The three transport failures, straight from botocore's own fmt strings
// (botocore/exceptions.py): ReadTimeoutError, ConnectTimeoutError and
// ConnectionClosedError. None of them had a remedy before, which is how a
// 60-second Lambda invoke came back with no code, no suggestion and nothing to
// act on.
//
// Unanchored because the prefix is not stable across CLIs: 2.34.3 writes
// "aws: [ERROR]: Read timeout on endpoint URL: ..." and 2.22.0 writes the bare
// sentence (both captured against a loopback stub).
//
// READ_TIMEOUT_RE takes the rest of the LINE, and is exported for that reason:
// the message carries the full request URL, which is the only thing in it that
// says whether the request that went unanswered was the invoke or one of the
// CLI's own credential calls. aws_lambda_invoke reads it to decide what it can
// honestly tell the caller.
export const READ_TIMEOUT_RE = /Read timeout on endpoint URL:[^\r\n]*/;
const CONNECT_TIMEOUT_RE = /Connect timeout on endpoint URL:[^\r\n]*/;
const CONNECTION_CLOSED_RE = /Connection was closed before we received a valid response from endpoint URL/;

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
    const retries = m[3] === undefined ? undefined : Number(m[3]);
    const message = m[4].trim();
    const out: ParsedAwsError = { code, operation, message };
    if (retries !== undefined) out.retries = retries;
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
      // How many retries the CLI already spent matters to the remedy: "retry
      // with backoff" after the CLI itself backed off twice means wait longer
      // than a bare first-failure throttle does.
      const alreadyRetried =
        retries !== undefined && retries > 0
          ? ` The AWS CLI had already retried ${retries} time${retries === 1 ? "" : "s"}.`
          : "";
      out.suggestion = `Reduce request rate or retry with backoff.${alreadyRetried}`;
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

  // See INVALID_CHOICE_RE. Runs only after STD_ERROR_RE failed, so a real AWS
  // message that merely contains the phrase keeps its code-based suggestion.
  // No `code` or `operation` is set: argparse exits before a request is signed,
  // so there is no AWS error code to report and nothing reached an operation.
  const invalidChoice = INVALID_CHOICE_RE.exec(trimmed);
  if (invalidChoice) {
    const noun = INVALID_CHOICE_NOUN.get(invalidChoice[1]) ?? "command";
    const which = invalidChoice[2] ? `no ${noun} named '${invalidChoice[2]}'` : `no ${noun} by that name`;
    // Spelling first: a model's mistyped operation is at least as common as an
    // old CLI, and the README promises new AWS operations are reachable "the
    // moment your local aws CLI knows them" -- this is what it says when it
    // does not. The `aws update` caveat is real: update.py's
    // _SUPPORTED_SOURCES is ('exe', 'script-exe', 'update-exe'), so a
    // package-manager or source install raises UpdateError.
    return {
      message: trimmed,
      suggestion: `The installed aws CLI has ${which}. Check the spelling; if it is newer than your CLI, upgrade the CLI (\`aws update\` on 2.36.0+ for installer installs, otherwise the AWS CLI installer or your package manager).`,
    };
  }

  const endpointMatch = BAD_ENDPOINT_RE.exec(trimmed);
  if (endpointMatch) {
    return {
      message: trimmed,
      suggestion: `Could not reach endpoint ${endpointMatch[1]}. Check the region spelling and network connectivity.`,
    };
  }

  // See SSL_VALIDATION_RE / PROXY_CONNECT_RE. Both sit here, past the endpoint
  // branch, because they are the same class of answer -- "this did not fail at
  // AWS" -- and neither text can also match BAD_ENDPOINT_RE.
  const sslMatch = SSL_VALIDATION_RE.exec(trimmed);
  if (sslMatch) {
    return {
      message: trimmed,
      suggestion: `TLS verification failed reaching ${sslMatch[1]}, which on a corporate network means a TLS-inspecting gateway or a private CA rather than a problem at AWS. Point the CLI at the trusted bundle: set AWS_CA_BUNDLE in this server's MCP-config \`env\` block -- the aws subprocess inherits this server's environment, so exporting it in your own shell does not reach a server your MCP client launched -- or set \`ca_bundle\` in the profile, which needs no environment at all. Do not disable verification.`,
    };
  }
  const proxyMatch = PROXY_CONNECT_RE.exec(trimmed);
  if (proxyMatch) {
    return {
      message: trimmed,
      suggestion: `The proxy the aws CLI was told to use (${proxyMatch[1]}) refused the connection or could not be reached, so it is the proxy, not AWS, that did not answer. Check that value and NO_PROXY in this server's MCP-config \`env\` block: botocore takes the proxy URL from the environment only, and the aws subprocess inherits this server's environment, so exporting them in your own shell does not reach a server your MCP client launched.`,
    };
  }

  // Transport failures. Deliberately GENERIC about retry safety, even though
  // botocore's own wording is precise about when the request left: aws_call and
  // every other tool reach these with the CLI's retries still ON, so "the
  // connection was never opened, nothing ran" is false whenever an earlier
  // attempt did open one. Only aws_lambda_invoke, which runs with
  // AWS_MAX_ATTEMPTS=1 and reads the URL out of READ_TIMEOUT_RE, makes a
  // sent/not-sent claim -- and it builds its own message.
  if (READ_TIMEOUT_RE.test(trimmed)) {
    return {
      message: trimmed,
      suggestion:
        "The request was sent but no response arrived within the AWS CLI's socket read timeout (60s unless the call set another), and with default retry settings the CLI may already have re-sent it. An operation that changes state may have taken effect -- check before retrying.",
    };
  }
  if (CONNECT_TIMEOUT_RE.test(trimmed)) {
    return {
      message: trimmed,
      suggestion:
        "Could not open a connection to the endpoint in time. Check network access, any proxy (HTTPS_PROXY / NO_PROXY) and the region, then retry.",
    };
  }
  if (CONNECTION_CLOSED_RE.test(trimmed)) {
    return {
      message: trimmed,
      suggestion:
        "The connection dropped after the request was sent and before a response arrived, so the operation may or may not have taken effect -- check before retrying anything that changes state. A NAT gateway, firewall or proxy that drops idle connections is a common cause on long requests.",
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
