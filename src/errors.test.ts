import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyAuthError, parseAwsError } from "./errors.js";

describe("classifyAuthError — SDK patterns", () => {
  it("detects SSOTokenProviderFailure by name", () => {
    const err = new Error("No cached SSO token found");
    err.name = "SSOTokenProviderFailure";
    assert.equal(classifyAuthError(err).kind, "sso_expired");
  });

  it("detects ExpiredTokenException by name", () => {
    const err = new Error("The security token included in the request is expired");
    err.name = "ExpiredTokenException";
    assert.equal(classifyAuthError(err).kind, "sso_expired");
  });

  it("detects SSO expiry by message content", () => {
    const err = new Error("The SSO session associated with this profile has expired or is otherwise invalid");
    assert.equal(classifyAuthError(err).kind, "sso_expired");
  });

  it("detects 'Token has expired and refresh failed' (TokenRetrievalError content)", () => {
    // botocore/tokens.py DeferredRefreshableToken._protected_refresh raises
    // TokenRetrievalError with error_msg="Token has expired and refresh failed"
    // when a mandatory refresh on an expired SSO token fails. The CLI surfaces
    // it as "Error when retrieving token from sso: Token has expired and
    // refresh failed".
    const err = new Error("Error when retrieving token from sso: Token has expired and refresh failed");
    assert.equal(classifyAuthError(err).kind, "sso_expired");
  });

  it("detects missing credentials via CredentialsProviderError name", () => {
    const err = new Error("Could not load credentials from any providers");
    err.name = "CredentialsProviderError";
    assert.equal(classifyAuthError(err).kind, "no_creds");
  });
});

describe("classifyAuthError — CLI stderr patterns", () => {
  it("detects 'Error loading SSO Token' CLI output", () => {
    const err = new Error("Error loading SSO Token: Token for my-profile is expired.");
    assert.equal(classifyAuthError(err).kind, "sso_expired");
  });

  it("detects 'SSO session is invalid' CLI wording", () => {
    const err = new Error("The SSO session associated with this profile is invalid.");
    assert.equal(classifyAuthError(err).kind, "sso_expired");
  });

  it("detects 'Unable to locate credentials' CLI output", () => {
    const err = new Error("Unable to locate credentials. You can configure credentials by running 'aws configure'.");
    assert.equal(classifyAuthError(err).kind, "no_creds");
  });
});

describe("classifyAuthError — canonical AWS SSO messages", () => {
  // Sources for the messages below:
  //   botocore/exceptions.py: SSOTokenLoadError.fmt,
  //     UnauthorizedSSOTokenError.fmt, TokenRetrievalError.fmt
  //   botocore/tokens.py: DeferredRefreshableToken._protected_refresh

  it("detects SSOTokenLoadError prefix (Error loading SSO Token:)", () => {
    const err = new Error("Error loading SSO Token: Token for my-profile has expired.");
    assert.equal(classifyAuthError(err).kind, "sso_expired");
  });

  it("detects UnauthorizedSSOTokenError full sentence", () => {
    const err = new Error(
      "The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login with the corresponding profile.",
    );
    assert.equal(classifyAuthError(err).kind, "sso_expired");
  });

  it("detects TokenRetrievalError 'Token has expired and refresh failed'", () => {
    const err = new Error("Error when retrieving token from sso: Token has expired and refresh failed");
    assert.equal(classifyAuthError(err).kind, "sso_expired");
  });

  it("keeps the adjacent token-retrieval vs credentials-retrieval patterns from swallowing each other", () => {
    // The SSO TokenRetrievalError CLI shape ("Error when retrieving token from
    // sso: ...") and the no-creds CredentialRetrievalError CLI shape ("Error
    // when retrieving credentials from ...") differ by one word ("token" vs
    // "credentials"). Pin that the SSO string classifies sso_expired (matched by
    // the trailing "Token has expired and refresh failed" anchor, NOT the
    // prefix) and is NOT swallowed by the no_creds CredentialRetrievalError
    // pattern -- and vice versa.
    const ssoStr = "Error when retrieving token from sso: Token has expired and refresh failed";
    assert.equal(classifyAuthError(new Error(ssoStr)).kind, "sso_expired");

    const noCredsStr = "Error when retrieving credentials from container-role: HTTPSConnectionPool error";
    assert.equal(classifyAuthError(new Error(noCredsStr)).kind, "no_creds");
  });
});

describe("classifyAuthError — canonical AWS no-creds messages", () => {
  // Sources for the messages below (botocore/exceptions.py):
  //   NoCredentialsError.fmt, NoAuthTokenError.fmt, PartialCredentialsError.fmt,
  //   CredentialRetrievalError.fmt, ProfileNotFound.fmt

  it("detects PartialCredentialsError canonical message", () => {
    const err = new Error("Partial credentials found in env, missing: aws_secret_access_key");
    assert.equal(classifyAuthError(err).kind, "no_creds");
  });

  it("detects CredentialRetrievalError canonical message", () => {
    const err = new Error("Error when retrieving credentials from container-role: HTTPSConnectionPool error");
    assert.equal(classifyAuthError(err).kind, "no_creds");
  });

  it("detects ProfileNotFound canonical message", () => {
    const err = new Error("The config profile (saml-prod) could not be found");
    assert.equal(classifyAuthError(err).kind, "no_creds");
  });

  it("detects NoAuthTokenError canonical message", () => {
    const err = new Error("Unable to locate authorization token");
    assert.equal(classifyAuthError(err).kind, "no_creds");
  });
});

describe("classifyAuthError — false-positive guards", () => {
  it("does NOT classify a benign sentence that happens to contain SSO/session/expired words", () => {
    // Regression guard: the old SSO_EXPIRED_RE used /SSO[^\n]{0,80}session
    // [^\n]{0,80}(?:expired|invalid)/ which matched this string and sent
    // users on a wild goose chase to re-run `aws sso login`.
    const err = new Error("SSO admin's session expired the parameter named foo");
    assert.equal(classifyAuthError(err).kind, "other");
  });

  it("does NOT classify a bare ExpiredToken STS error (no name set)", () => {
    // The STS-side ExpiredToken error code is surfaced via the standard
    // `An error occurred (ExpiredToken) when calling ...` shape and handled
    // by parseAwsError -- not classifyAuthError. As a bare message with no
    // `err.name = "ExpiredTokenException"`, it must fall through to "other".
    const err = new Error(
      "An error occurred (ExpiredToken) when calling the GetCallerIdentity operation: The security token included in the request is expired",
    );
    assert.equal(classifyAuthError(err).kind, "other");
  });

  it("does NOT classify random text mentioning 'token' and 'expired' far apart", () => {
    const err = new Error("the API token for the upstream service has been rotated; the cache entry expired");
    assert.equal(classifyAuthError(err).kind, "other");
  });

  it("does NOT classify a benign sentence containing 'no identity'", () => {
    // Regression guard: the old NO_CREDS_RE had a `/no identity/i` alternation
    // (case-insensitive, unanchored) that matched any string mentioning "no
    // identity" -- e.g. discussion text or unrelated AWS errors that quoted
    // the phrase in a different context.
    const err = new Error("the user has no identity crisis here -- this is a different issue");
    assert.equal(classifyAuthError(err).kind, "other");
  });

  it("does NOT classify a generic 'could not load credentials' message without err.name set", () => {
    // The old NO_CREDS_RE matched /could not load credentials/i on raw
    // message text. The replacement relies on err.name ===
    // "CredentialsProviderError" for the SDK class (always set by the
    // @aws-sdk/property-provider class constructor) and anchored canonical
    // botocore strings for the CLI side. A bare message without a name set
    // is no longer auto-classified -- if a real-world case is found, add a
    // specific anchored pattern.
    const err = new Error("could not load credentials from some custom non-AWS provider");
    assert.equal(classifyAuthError(err).kind, "other");
  });
});

describe("classifyAuthError — fallthrough behavior", () => {
  it("falls back to 'other' for unrelated errors", () => {
    const err = new Error("connect ECONNREFUSED 169.254.169.254:80");
    assert.equal(classifyAuthError(err).kind, "other");
  });

  it("handles non-Error inputs", () => {
    assert.equal(classifyAuthError("a bare string error").kind, "other");
    assert.equal(classifyAuthError(undefined).kind, "other");
  });

  it("preserves the original message in the returned object", () => {
    const err = new Error("Some specific failure text");
    assert.equal(classifyAuthError(err).message, "Some specific failure text");
  });

  it("returns empty string message for undefined", () => {
    assert.equal(classifyAuthError(undefined).message, "undefined");
  });
});

describe("parseAwsError -- standard CLI shape", () => {
  it("pulls code, operation, message from 'An error occurred (X) when calling Y operation: Z'", () => {
    const r = parseAwsError(
      "An error occurred (AccessDenied) when calling the GetBucketLocation operation: User: arn:aws:iam::123:user/foo is not authorized to perform: s3:GetBucketLocation",
    );
    assert.equal(r.code, "AccessDenied");
    assert.equal(r.operation, "GetBucketLocation");
    assert.match(r.message ?? "", /not authorized/);
  });

  it("derives a 'lacks <action>' suggestion from User: ... is not authorized to perform: <action>", () => {
    const r = parseAwsError(
      "An error occurred (AccessDeniedException) when calling the CreateFunction operation: User: arn:aws:iam::123:user/foo is not authorized to perform: lambda:CreateFunction",
    );
    assert.match(r.suggestion ?? "", /lambda:CreateFunction/);
  });

  it("falls back to a generic IAM suggestion for AccessDenied without a User: line", () => {
    const r = parseAwsError("An error occurred (AccessDenied) when calling the SomeOp operation: nope");
    assert.match(r.suggestion ?? "", /IAM permissions/);
  });

  it("suggests retry/backoff for ThrottlingException", () => {
    const r = parseAwsError(
      "An error occurred (ThrottlingException) when calling the ListThings operation: Rate exceeded",
    );
    assert.match(r.suggestion ?? "", /retry/i);
  });

  it("suggests verifying identifier/region for ResourceNotFoundException", () => {
    const r = parseAwsError(
      "An error occurred (ResourceNotFoundException) when calling the GetFunction operation: Function not found: my-fn",
    );
    assert.match(r.suggestion ?? "", /identifier/);
  });

  it("suggests aws_resource_update for ResourceAlreadyExistsException", () => {
    const r = parseAwsError(
      "An error occurred (AlreadyExistsException) when calling the CreateResource operation: foo",
    );
    assert.match(r.suggestion ?? "", /aws_resource_update/);
  });

  it("suggests aws_resource_get for ConflictException (pins tool name reference)", () => {
    // Pins the cross-module tool-name reference in errors.ts so a rename of
    // aws_resource_get fails this test loudly rather than leaving a stale
    // suggestion string in the field.
    const r = parseAwsError(
      "An error occurred (ConflictException) when calling the UpdateResource operation: state conflict",
    );
    assert.match(r.suggestion ?? "", /aws_resource_get/);
  });
});

describe("parseAwsError -- non-standard shapes", () => {
  it("flags bad endpoint with the URL extracted", () => {
    const r = parseAwsError('Could not connect to the endpoint URL: "https://lambda.us-east-9.amazonaws.com/"');
    assert.match(r.suggestion ?? "", /region/i);
    assert.match(r.suggestion ?? "", /lambda\.us-east-9/);
  });

  it("extracts the URL when the endpoint is UNQUOTED", () => {
    // BAD_ENDPOINT_RE has optional quotes (`"?...?"`). The aws CLI usually quotes
    // the URL, but a wrapper or older CLI version may not. The `[^"\s]+` capture
    // stops at the first whitespace/quote, so the bare URL extracts cleanly.
    const r = parseAwsError("Could not connect to the endpoint URL: https://x");
    assert.match(r.suggestion ?? "", /https:\/\/x/);
    assert.match(r.suggestion ?? "", /region/i);
  });

  it("flags parameter validation failures with a schema hint", () => {
    const r = parseAwsError("Parameter validation failed: Missing required parameter in input: 'FunctionName'");
    assert.match(r.suggestion ?? "", /API schema/);
  });

  it("returns message-only for an unrecognized error", () => {
    const r = parseAwsError("some weird unrelated noise");
    assert.equal(r.code, undefined);
    assert.equal(r.suggestion, undefined);
    assert.equal(r.message, "some weird unrelated noise");
  });

  it("returns empty object for empty stderr", () => {
    assert.deepEqual(parseAwsError(""), {});
  });
});
