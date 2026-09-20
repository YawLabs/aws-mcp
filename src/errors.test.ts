import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyAuthError, parseAwsError, READ_TIMEOUT_RE } from "./errors.js";

describe("classifyAuthError — message text only, err.name is not consulted", () => {
  // The classifier used to have three branches keyed on AWS SDK error CLASS
  // NAMES (SSOTokenProviderFailure / ExpiredTokenException /
  // CredentialsProviderError). They were unreachable: this package has no
  // @aws-sdk dependency, and the one production caller is aws-cli.ts doing
  // `classifyAuthError(new Error(stderrBuf))`, where name is always "Error".
  // These cases pin that the name is genuinely ignored, so nobody restores a
  // branch that can never fire.

  it("ignores err.name = SSOTokenProviderFailure when the message says nothing", () => {
    const err = new Error("No cached SSO token found");
    err.name = "SSOTokenProviderFailure";
    assert.equal(classifyAuthError(err).kind, "other");
  });

  it("ignores err.name = CredentialsProviderError when the message says nothing", () => {
    const err = new Error("Could not load credentials from any providers");
    err.name = "CredentialsProviderError";
    assert.equal(classifyAuthError(err).kind, "other");
  });

  it("classifies purely on the message, whatever the name is", () => {
    // Same stderr text, a misleading name attached: the text wins.
    const err = new Error("Unable to locate credentials");
    err.name = "SSOTokenProviderFailure";
    assert.equal(classifyAuthError(err).kind, "no_creds");
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
});

describe("classifyAuthError — service-reported expiry (ExpiredToken) is NOT SSO-specific", () => {
  // Two corrections, in order.
  //
  // First: the standard-wrapper ExpiredToken shape is the most common way an
  // expired session surfaces (the service rejects the request, rather than
  // botocore failing to load a token), and the classifier used to call it
  // "other" -- so it fell through to a generic nonzero_exit.
  //
  // Then the over-correction: it was folded into SSO_EXPIRED_PATTERNS. AWS emits
  // that wrapper for ANY expired temporary credential -- assume-role,
  // web-identity, credential_process, SSO -- and the stderr does not say which.
  // A plain assume-role user was told to run aws_login_start, which cannot
  // refresh an STS session. These pin the third state: its own kind, whose
  // message covers both remedies.

  it("classifies the STS ExpiredToken wrapper as expired_creds, not sso_expired", () => {
    const err = new Error(
      "An error occurred (ExpiredToken) when calling the GetCallerIdentity operation: The security token included in the request is expired",
    );
    assert.equal(classifyAuthError(err).kind, "expired_creds");
  });

  it("classifies the ExpiredTokenException spelling too", () => {
    const err = new Error(
      "An error occurred (ExpiredTokenException) when calling the DescribeInstances operation: The security token included in the request is expired",
    );
    assert.equal(classifyAuthError(err).kind, "expired_creds");
  });

  it("classifies an AssumeRole-derived session's expiry as expired_creds", () => {
    // The case that made the SSO-specific advice wrong: nothing about this
    // stderr involves SSO, and telling the caller to re-login would not help.
    const err = new Error(
      "An error occurred (ExpiredToken) when calling the ListBuckets operation: The provided token has expired.",
    );
    assert.equal(classifyAuthError(err).kind, "expired_creds");
  });

  it("still classifies a genuinely SSO-sourced expiry as sso_expired", () => {
    // The SSO patterns name botocore's SSO token provider explicitly, so the
    // origin IS known there and the SSO-specific remedy stays correct. Splitting
    // the wrapper out must not weaken that half.
    assert.equal(
      classifyAuthError(new Error("Error loading SSO Token: Token for my-profile is expired.")).kind,
      "sso_expired",
    );
    assert.equal(
      classifyAuthError(new Error("Error when retrieving token from sso: Token has expired and refresh failed")).kind,
      "sso_expired",
    );
  });

  it("agrees with parseAwsError on the same stderr, and neither is SSO-only", () => {
    // Both halves of the file point at the same remedy for one input, and that
    // remedy now names the STS path too. A suggestion mentioning only
    // aws_login_start is the regression this guards.
    const stderr =
      "An error occurred (ExpiredToken) when calling the GetCallerIdentity operation: The security token included in the request is expired";
    assert.equal(classifyAuthError(new Error(stderr)).kind, "expired_creds");
    const suggestion = parseAwsError(stderr).suggestion ?? "";
    assert.match(suggestion, /aws_login_start/);
    assert.match(suggestion, /aws_assume_role/);
  });

  it("requires the wrapper -- a bare mention of the word does not match", () => {
    // Anchored on "An error occurred (" so prose can't trip it.
    assert.equal(classifyAuthError(new Error("the ExpiredToken metric fired on the dashboard")).kind, "other");
    assert.equal(classifyAuthError(new Error("An error occurred (ExpiredTokenFoo) when calling X")).kind, "other");
  });
});

describe("classifyAuthError — invalid_creds (credentials present but rejected)", () => {
  // Distinct from no_creds, and the distinction is the point: no_creds means
  // nothing resolved ("check ~/.aws/credentials"), invalid_creds means
  // something resolved and AWS refused it (rotated key, wrong partition,
  // clock skew). The remedies do not overlap.

  it("classifies UnrecognizedClientException", () => {
    const err = new Error(
      "An error occurred (UnrecognizedClientException) when calling the ListBuckets operation: The security token included in the request is invalid.",
    );
    assert.equal(classifyAuthError(err).kind, "invalid_creds");
  });

  it("classifies InvalidClientTokenId", () => {
    const err = new Error(
      "An error occurred (InvalidClientTokenId) when calling the GetCallerIdentity operation: The security token included in the request is invalid",
    );
    assert.equal(classifyAuthError(err).kind, "invalid_creds");
  });

  it("classifies SignatureDoesNotMatch (wrong secret, or a drifted clock)", () => {
    const err = new Error(
      "An error occurred (SignatureDoesNotMatch) when calling the ListObjectsV2 operation: Signature expired: 20260830T000000Z is now earlier than 20260830T010000Z",
    );
    assert.equal(classifyAuthError(err).kind, "invalid_creds");
  });

  it("does NOT swallow a plain no-creds message", () => {
    assert.equal(classifyAuthError(new Error("Unable to locate credentials")).kind, "no_creds");
  });

  it("requires the wrapper -- prose mentioning the code does not match", () => {
    assert.equal(classifyAuthError(new Error("we saw SignatureDoesNotMatch in the logs last week")).kind, "other");
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

  it("does NOT classify a generic 'could not load credentials' message", () => {
    // The old NO_CREDS_RE matched /could not load credentials/i on raw message
    // text, which is loose enough to catch unrelated prose. The replacement is
    // the set of anchored canonical botocore strings -- nothing else is
    // auto-classified. If a real-world case turns up, add a specific anchored
    // pattern for it rather than loosening these.
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

  // From here on, each test enumerates EVERY code in one branch of the code
  // ladder, so deleting a code from its list turns a test red. The operation and
  // message are deliberately meaningless ("SomeOp", "foo"): a fixture message
  // like "Rate exceeded" keeps a test green even if the branch is rewritten to
  // match on the message text and its codes are dropped.

  it("falls back to the generic IAM suggestion for every access-denied code without a User: line", () => {
    // A "User: ... is not authorized to perform:" message is checked before the
    // code and answers with the principal-specific suggestion, which also says
    // "IAM permissions" -- hence "for this operation".
    for (const code of ["AccessDenied", "AccessDeniedException", "UnauthorizedOperation"]) {
      const r = parseAwsError(`An error occurred (${code}) when calling the SomeOp operation: foo`);
      assert.equal(r.code, code);
      assert.match(r.suggestion ?? "", /IAM permissions for this operation/, `expected the IAM suggestion for ${code}`);
    }
  });

  it("suggests retry/backoff for every service's spelling of rate-limited", () => {
    // Throttling has no single code across AWS: S3 says SlowDown, API Gateway
    // and Lambda say TooManyRequestsException, DynamoDB says
    // ProvisionedThroughputExceededException. Only the ThrottlingException
    // family was recognized, so the other three got no suggestion at all --
    // the agent had no hint that BACKING OFF was the fix, which is exactly the
    // case where an agent instead retries in a hot loop. So the assertion is
    // "retry with backoff": a bare /retry/ stays green on "just retry".
    for (const code of [
      "ThrottlingException",
      "Throttling",
      "RequestLimitExceeded",
      "TooManyRequestsException",
      "SlowDown",
      "ProvisionedThroughputExceededException",
    ]) {
      const r = parseAwsError(`An error occurred (${code}) when calling the SomeOp operation: foo`);
      assert.equal(r.code, code);
      assert.match(r.suggestion ?? "", /retry with backoff/i, `expected a backoff suggestion for ${code}`);
    }
  });

  it("suggests verifying identifier/region for every not-found code", () => {
    // The whole phrase, not /identifier/: the already-exists suggestion says
    // "identifier" too, so the bare word stays green if a not-found code is
    // moved into that branch.
    for (const code of ["ResourceNotFoundException", "NoSuchBucket", "NoSuchKey", "NotFoundException"]) {
      const r = parseAwsError(`An error occurred (${code}) when calling the SomeOp operation: foo`);
      assert.equal(r.code, code);
      assert.match(
        r.suggestion ?? "",
        /Verify the resource identifier and region/,
        `expected the not-found suggestion for ${code}`,
      );
    }
  });

  it("suggests checking the operation parameters for every validation-error code", () => {
    // Not /API schema/: the unwrapped "Parameter validation failed" remedy
    // (non-standard shapes, below) shares that phrase, so only this branch's
    // own wording catches the two remedy texts being swapped.
    for (const code of ["ValidationException", "ValidationError", "InvalidParameterValue", "InvalidParameter"]) {
      const r = parseAwsError(`An error occurred (${code}) when calling the SomeOp operation: foo`);
      assert.equal(r.code, code);
      assert.match(
        r.suggestion ?? "",
        /Check the operation parameters/,
        `expected the parameter suggestion for ${code}`,
      );
    }
  });

  it("names both credential-refresh tools for every expired-token code", () => {
    // ExpiredToken is also pinned by the classifyAuthError agreement test near
    // the top of this file; it is listed here too so the loop matches the branch.
    for (const code of ["ExpiredToken", "ExpiredTokenException"]) {
      const r = parseAwsError(`An error occurred (${code}) when calling the SomeOp operation: foo`);
      assert.equal(r.code, code);
      assert.match(r.suggestion ?? "", /aws_login_start/, `expected aws_login_start for ${code}`);
      assert.match(r.suggestion ?? "", /aws_assume_role/, `expected aws_assume_role for ${code}`);
    }
  });

  it("suggests aws_resource_update for every already-exists code", () => {
    for (const code of ["ResourceAlreadyExistsException", "AlreadyExistsException"]) {
      const r = parseAwsError(`An error occurred (${code}) when calling the SomeOp operation: foo`);
      assert.equal(r.code, code);
      assert.match(r.suggestion ?? "", /aws_resource_update/, `expected the already-exists suggestion for ${code}`);
    }
  });

  it("suggests aws_resource_get for ConflictException (pins tool name reference)", () => {
    // Pins the cross-module tool-name reference in errors.ts so a rename of
    // aws_resource_get fails this test loudly rather than leaving a stale
    // suggestion string in the field.
    const r = parseAwsError("An error occurred (ConflictException) when calling the SomeOp operation: foo");
    assert.match(r.suggestion ?? "", /aws_resource_get/);
  });
});

describe("parseAwsError -- retry-exhausted and CRLF-terminated CLI messages", () => {
  // Every string in this describe is a VERBATIM capture from a real AWS CLI
  // driven through runAwsCall against a loopback stub -- not a hand-written
  // approximation -- because both defects here are about characters the fake
  // CLI never emitted: the " (reached max retries: N)" infix botocore adds once
  // it stops retrying, and the CRLF the Windows CLI writes before its
  // "Additional error details:" block.

  // Stub answering 400 Throttling, three requests each. The first two are the
  // same failure on the two CLIs (2.34.3 wraps it in its enhanced format,
  // 2.22.0 in the legacy one); the third is what AWS_MAX_ATTEMPTS=1 produces,
  // where botocore marks MaxAttemptsReached on the very first failure.
  const RETRY_EXHAUSTED_CAPTURES: { label: string; stderr: string; retries: number }[] = [
    {
      label: "2.34.3, enhanced error format",
      stderr:
        "\r\naws: [ERROR]: An error occurred (Throttling) when calling the GetCallerIdentity operation (reached max retries: 2): Rate exceeded\r\n\r\nAdditional error details:\r\nType: Sender\r\n",
      retries: 2,
    },
    {
      label: "2.22.0, legacy error format",
      stderr:
        "\r\nAn error occurred (Throttling) when calling the GetCallerIdentity operation (reached max retries: 2): Rate exceeded\r\n",
      retries: 2,
    },
    {
      label: "AWS_MAX_ATTEMPTS=1, so zero retries",
      stderr:
        "\r\naws: [ERROR]: An error occurred (Throttling) when calling the GetCallerIdentity operation (reached max retries: 0): Rate exceeded\r\n",
      retries: 0,
    },
  ];

  it("pulls code, operation and the retry count out of every captured retry-exhausted throttle", () => {
    for (const { label, stderr, retries } of RETRY_EXHAUSTED_CAPTURES) {
      const r = parseAwsError(stderr);
      assert.equal(r.code, "Throttling", label);
      assert.equal(r.operation, "GetCallerIdentity", label);
      assert.equal(r.retries, retries, label);
      // The message stops at the blank line, CRLF or not -- the enhanced
      // capture's "Additional error details:" block must not be in it.
      assert.equal(r.message, "Rate exceeded", label);
      assert.match(r.suggestion ?? "", /retry with backoff/, label);
    }
  });

  it("says how many times the CLI had already retried, and says nothing when it had not", () => {
    const [enhanced, legacy, zero] = RETRY_EXHAUSTED_CAPTURES.map((c) => parseAwsError(c.stderr));
    assert.match(enhanced.suggestion ?? "", /already retried 2 times/);
    assert.match(legacy.suggestion ?? "", /already retried 2 times/);
    // Not "0 times", and not "1 time" either: with nothing retried the clause
    // is absent, so the suggestion is byte-identical to the pre-2.3.3 one.
    assert.equal(zero.suggestion, "Reduce request rate or retry with backoff.");
  });

  it("uses the singular for a single retry", () => {
    const r = parseAwsError(
      "An error occurred (TooManyRequestsException) when calling the Invoke operation (reached max retries: 1): Rate Exceeded.",
    );
    assert.equal(r.retries, 1);
    assert.match(r.suggestion ?? "", /already retried 1 time\./);
  });

  it("leaves retries absent when the CLI did not report any", () => {
    // The infix is optional, so a plain message must still parse -- and must
    // not pick up a retry count from prose inside the message.
    const r = parseAwsError(
      "An error occurred (Throttling) when calling the GetCallerIdentity operation: Rate exceeded (reached max retries: 9)",
    );
    assert.equal(r.retries, undefined);
    assert.equal(r.suggestion, "Reduce request rate or retry with backoff.");
  });

  it("stops a CRLF-terminated message before the CLI's 'Additional error details' block", () => {
    // Captured from 2.34.3 with a stub answering 403 InvalidClientTokenId.
    // Latent before 2.3.3 (only `suggestion` was consumed), but the parsed
    // message is what a caller reads once anything surfaces it.
    const r = parseAwsError(
      "\r\naws: [ERROR]: An error occurred (InvalidClientTokenId) when calling the GetCallerIdentity operation: The security token included in the request is invalid.\r\n\r\nAdditional error details:\r\nType: Sender\r\n",
    );
    assert.equal(r.code, "InvalidClientTokenId");
    assert.equal(r.message, "The security token included in the request is invalid.");
  });

  it("keeps the not-found remedy on the Lambda error AWS_MAX_ATTEMPTS=1 reshapes", () => {
    // Verbatim from lambda-invoke-probe2.out.ndjson, record `notfound_max1`
    // (aws-cli 2.34.3, `aws lambda invoke` with AWS_MAX_ATTEMPTS=1 against a
    // stub answering ResourceNotFoundException). aws_lambda_invoke sets that
    // variable so an invoke is sent at most once, which makes the CLI print
    // "(reached max retries: 0)" on EVERY Lambda service error -- so without
    // the infix in the pattern this suggestion would go missing on the most
    // common Lambda mistake there is.
    const r = parseAwsError(
      "\r\naws: [ERROR]: An error occurred (ResourceNotFoundException) when calling the Invoke operation (reached max retries: 0): Function not found: arn:aws:lambda:us-east-1:123456789012:function:notfound\r\n\r\nAdditional error details:\r\nType: User\r\n",
    );
    assert.equal(r.code, "ResourceNotFoundException");
    assert.equal(r.operation, "Invoke");
    assert.equal(r.retries, 0);
    assert.equal(r.message, "Function not found: arn:aws:lambda:us-east-1:123456789012:function:notfound");
    assert.match(r.suggestion ?? "", /Verify the resource identifier and region/);
  });
});

describe("parseAwsError -- an AWS CLI v1 rejecting the pinned --cli-binary-format", () => {
  // aws-cli.ts pins `--cli-binary-format base64` on every call that carries
  // params, so blob members are not double-encoded by a
  // `cli_binary_format = raw-in-base64-out` config. v1 has no such global option
  // -- see CLI_V1_UNKNOWN_BINARY_FORMAT_RE for its whole list -- so a v1 install,
  // which this server documents as unsupported, now fails those calls with an
  // argument-parser error the model cannot act on unless we name the cause.
  it("says it is v1, on both the clidriver and hand-written command spellings", () => {
    for (const stderr of [
      "\r\nusage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]\r\nTo see help text, you can run:\r\n\r\nUnknown options: --cli-binary-format, base64\r\n",
      'Unknown options: --cli-binary-format,base64,--cli-input-json,{"Bucket":"b"}\n',
    ]) {
      const r = parseAwsError(stderr);
      assert.match(r.suggestion ?? "", /AWS CLI v1/, stderr);
      assert.match(r.suggestion ?? "", /Install AWS CLI v2/, stderr);
    }
  });

  it("does not claim v1 for any other unknown option", () => {
    // Every 2.x accepts --cli-binary-format, so an "Unknown options" naming
    // something else is a different problem -- a typo in extraFlags, or an option
    // newer than the installed CLI -- and answering "you are on v1" would be a
    // confident wrong diagnosis. 2.22.0 answers exactly this way for
    // --cli-error-format (measured).
    const r = parseAwsError("\r\nUnknown options: --cli-error-format, enhanced\r\n");
    assert.equal(r.suggestion, undefined);
  });
});

describe("parseAwsError -- not-authorized text OUTSIDE the standard wrapper", () => {
  // NOT_AUTHORIZED_RE only ever ran against the message captured INSIDE "An
  // error occurred (...) when calling ...". The same sentence also arrives
  // bare -- cloudcontrol/CCAPI and several higher-level `aws` customizations
  // emit it unwrapped -- and those fell through to message-only with no
  // suggestion, losing the single most actionable hint the CLI produces.

  it("derives the IAM suggestion from a bare 'User: ... is not authorized to perform: ...'", () => {
    const r = parseAwsError(
      "User: arn:aws:iam::123456789012:user/jeff is not authorized to perform: cloudformation:DescribeStacks on resource: arn:aws:cloudformation:us-east-1:123456789012:stack/foo",
    );
    assert.match(r.suggestion ?? "", /IAM permissions/);
    assert.match(r.suggestion ?? "", /arn:aws:iam::123456789012:user\/jeff/);
    assert.match(r.suggestion ?? "", /cloudformation:DescribeStacks/);
    // The raw text is still preserved for diagnosis.
    assert.match(r.message ?? "", /not authorized/);
  });

  it("leaves code/operation undefined for the bare form (there is no wrapper to parse)", () => {
    const r = parseAwsError("User: arn:aws:sts::1:assumed-role/R/s is not authorized to perform: s3:GetObject");
    assert.equal(r.code, undefined);
    assert.equal(r.operation, undefined);
    assert.ok(r.suggestion);
  });

  it("still prefers the wrapped parse when the wrapper IS present", () => {
    // The wrapped branch returns first and carries code + operation, so adding
    // the bare check must not shadow it.
    const r = parseAwsError(
      "An error occurred (AccessDenied) when calling the GetBucketLocation operation: User: arn:aws:iam::123:user/foo is not authorized to perform: s3:GetBucketLocation",
    );
    assert.equal(r.code, "AccessDenied");
    assert.equal(r.operation, "GetBucketLocation");
    assert.match(r.suggestion ?? "", /s3:GetBucketLocation/);
  });
});

describe("parseAwsError -- a service, operation or subcommand the installed CLI does not know", () => {
  // README.md promises new AWS operations are reachable "the moment your local
  // `aws` CLI knows them". When it does not, argparse rejects the command with
  // exit 252 before anything is sent, and until now that came back with no
  // suggestion at all -- nothing said the fix might be an upgrade rather than a
  // typo. Every string below is a verbatim capture from a real CLI on Windows
  // (hence CRLF) driven against a dead loopback endpoint, with an existing
  // scratch profile and empty credentials: aws-cli 2.34.3 in its default
  // (enhanced) error format, its legacy and json formats, and the extracted real
  // 2.22.0, whose wording predates `Found invalid choice`.

  const CASES: ReadonlyArray<{ what: string; stderr: string; expect: RegExp }> = [
    {
      // plans/readme-positioning_rv_234_op_enhanced.err -- `batch cancel-jobs`,
      // the operation CLI 2.36.44 added, on 2.34.3. This is the format users see
      // and the bytes the fake replays.
      what: "2.34.3 enhanced, unknown operation",
      stderr:
        "\r\naws: [ERROR]: An error occurred (ParamValidation): argument operation: Found invalid choice 'cancel-jobs'\r\n\r\nMaybe you meant:\r\n\r\n  * cancel-job\r\n\r\nusage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]\r\nTo see help text, you can run:\r\n\r\n  aws help\r\n  aws <command> help\r\n  aws <command> <subcommand> help\r\n",
      expect: /no operation named 'cancel-jobs'/,
    },
    {
      // Same command with cli_error_format=legacy, rewritten to LF: the wrapper
      // is gone, and this is also what 2.34.3 prints for a --profile it cannot
      // find. LF is what the CLI writes on macOS and Linux.
      what: "2.34.3 legacy, unknown operation, LF newlines",
      stderr:
        "\naws: [ERROR]: argument operation: Found invalid choice 'cancel-jobs'\n\nMaybe you meant:\n\n  * cancel-job\n\nusage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]\n",
      expect: /no operation named 'cancel-jobs'/,
    },
    {
      // plans/readme-positioning_rv_234_svc_enhanced.err -- argparse's `command`
      // dest is the SERVICE, so the remedy has to say "service", not "command".
      what: "2.34.3 enhanced, unknown service",
      stderr:
        "\r\naws: [ERROR]: An error occurred (ParamValidation): argument command: Found invalid choice 'lambda-microvms'\r\n\r\n\r\nusage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]\r\n",
      expect: /no service named 'lambda-microvms'/,
    },
    {
      // plans/readme-positioning_rv_234_sub_enhanced.err -- `ec2 wait
      // instance-runningx`. Waiters, `s3` and `configure` all reject on the
      // `subcommand` dest, and new waiters arrive with new CLIs.
      what: "2.34.3 enhanced, unknown waiter",
      stderr:
        "\r\naws: [ERROR]: An error occurred (ParamValidation): argument subcommand: Found invalid choice 'instance-runningx'\r\n\r\nMaybe you meant:\r\n\r\n  * instance-running\r\n\r\n",
      expect: /no subcommand named 'instance-runningx'/,
    },
    {
      // plans/readme-positioning_rv_2220_op.err, excerpt. 2.22.0 prints the
      // usage block FIRST, prefixes with the program name argparse was given
      // (`aws.exe: error:` here, `aws: error:` when the same binary is resolved
      // off PATH -- both measured), and names no
      // choice on this line -- hence the "by that name" wording.
      what: "2.22.0, unknown operation (no name on the line)",
      stderr:
        "\r\nusage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]\r\n\r\naws.exe: error: argument operation: Invalid choice, valid choices are:\r\n\r\ncancel-job                               | create-compute-environment              \r\ndescribe-job-queues                      | describe-jobs                           \r\n",
      expect: /no operation by that name/,
    },
    {
      // plans/readme-positioning_rv_234_op_json.err -- cli_error_format=json
      // puts the phrase inside `Message` with literal \n escapes. The pattern is
      // unanchored, so the remedy survives whatever error format the user set.
      what: "2.34.3 json error format",
      stderr:
        '{\r\n    "Code": "ParamValidation",\r\n    "Message": "argument operation: Found invalid choice \'cancel-jobs\'\\n\\nMaybe you meant:\\n\\n  * cancel-job\\n"\r\n}\r\n',
      expect: /no operation named 'cancel-jobs'/,
    },
  ];

  for (const c of CASES) {
    it(`suggests a spelling check and an upgrade -- ${c.what}`, () => {
      const r = parseAwsError(c.stderr);
      assert.match(r.suggestion ?? "", c.expect);
      // Both halves of the remedy, in this order: spelling is at least as likely
      // as an old CLI when a model picked the name.
      assert.match(r.suggestion ?? "", /Check the spelling/);
      assert.match(r.suggestion ?? "", /aws update/);
      // argparse exits before a request is signed, so there is no AWS error code
      // and nothing reached an operation.
      assert.equal(r.code, undefined);
      assert.equal(r.operation, undefined);
      // The CLI's own text is preserved for diagnosis.
      assert.equal(r.message, c.stderr.trim());
    });
  }

  it("does not claim a real AWS error that happens to contain the phrase", () => {
    // Guards the one-way coupling this branch has on STD_ERROR_RE: the enhanced
    // "(ParamValidation)" wrapper has no "when calling the X operation" tail, so
    // STD_ERROR_RE must keep requiring one. Widen it to accept a bare
    // "(Code):" and a genuine service error like this loses its code-based
    // remedy to the upgrade advice.
    const r = parseAwsError(
      "An error occurred (ValidationException) when calling the CreateThing operation: Invalid choice for Mode: argument operation: Found invalid choice 'x'",
    );
    assert.equal(r.code, "ValidationException");
    assert.equal(r.operation, "CreateThing");
    assert.match(r.suggestion ?? "", /API schema/);
  });

  it("does not read aws_call's own params payload back as a misspelled subcommand", () => {
    // Verbatim 2.34.3, from `aws_call {service: "ec2", operation: "wait",
    // params: {InstanceIds: ["i-1"]}}`: `ec2 wait` is a subcommand GROUP, whose
    // parser registers no --cli-input-json, so argparse took the JSON value as
    // the missing positional. Quoting that back told the caller the CLI has no
    // subcommand named '{"InstanceIds":["i-1"]}' and to check its spelling or
    // run `aws update`. Silence here is what lets cliArgParseHint answer it.
    const r = parseAwsError(
      '\r\naws: [ERROR]: An error occurred (ParamValidation): argument subcommand: Found invalid choice \'{"InstanceIds":["i-1"]}\'\r\n\r\n\r\nusage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]\r\n',
    );
    assert.equal(r.suggestion, undefined);
    assert.match(r.message ?? "", /\{"InstanceIds":\["i-1"\]\}/, "the CLI's own text is still preserved");
  });

  it("stays out of the way of the missing-arguments shape aws_call explains itself", () => {
    // cliArgParseHint (tools/call.ts) only runs when parseAwsError found no
    // remedy, so if this pattern claimed the required-arguments stderr the
    // s3api get-object explanation would never be reached. Verbatim 2.34.3.
    const r = parseAwsError(
      "\r\naws: [ERROR]: An error occurred (ParamValidation): the following arguments are required: --bucket, --key\r\n",
    );
    assert.equal(r.suggestion, undefined);
  });
});

describe("parseAwsError -- TLS and proxy failures on the CLI path", () => {
  // The CLI half of what docs.ts's describeFetchFailure explains for the
  // in-process fetch path: behind a TLS-inspecting gateway or an unreachable
  // proxy, every shelling-out tool used to report botocore's sentence and no
  // remedy, which reads like an AWS outage.
  //
  // Provenance, because it differs between the two. The proxy sentence is a
  // verbatim capture: `sts get-caller-identity` on 2.34.3 with HTTPS_PROXY
  // pointed at a dead loopback port printed
  // `aws: [ERROR]: Failed to connect to proxy URL: "http://127.0.0.1:1"`. The
  // TLS sentence is botocore's fmt string, read from the CLI's own bundled copy
  // (awscli/botocore/exceptions.py: SSLError.fmt, raised in httpsession.py's
  // send as `SSLError(endpoint_url=request.url, error=e)`) -- two attempts to
  // force it locally against a self-signed loopback server on this ARM64 box
  // came back as a read timeout instead, so it is asserted from the source
  // string rather than from a capture. The "aws: [ERROR]: " prefix is 2.34.3's;
  // 2.22.0 writes the sentence bare, which is why both patterns are unanchored.

  it("names the TLS-inspection cause and where the CA bundle has to be set", () => {
    const r = parseAwsError(
      "\r\naws: [ERROR]: SSL validation failed for https://sts.us-east-1.amazonaws.com/ [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: unable to get local issuer certificate (_ssl.c:1006)\r\n",
    );
    assert.match(r.suggestion ?? "", /TLS verification failed reaching https:\/\/sts\.us-east-1\.amazonaws\.com\//);
    assert.match(r.suggestion ?? "", /TLS-inspecting gateway or a private CA/);
    assert.match(r.suggestion ?? "", /AWS_CA_BUNDLE/);
    assert.match(r.suggestion ?? "", /ca_bundle/);
    // The remedy must not offer the shortcut that turns verification off.
    assert.match(r.suggestion ?? "", /Do not disable verification/);
    assert.equal(r.code, undefined);
    // botocore's own sentence is still there for diagnosis.
    assert.match(r.message ?? "", /CERTIFICATE_VERIFY_FAILED/);
  });

  it("extracts the endpoint from the bare sentence older CLIs write", () => {
    const r = parseAwsError("SSL validation failed for https://lambda.eu-west-1.amazonaws.com/ [SSL: WRONG_VERSION]");
    assert.match(r.suggestion ?? "", /https:\/\/lambda\.eu-west-1\.amazonaws\.com\//);
  });

  it("blames the proxy, not AWS, when the proxy connection fails", () => {
    // botocore runs the URL through mask_proxy_url before formatting, so any
    // user:password@ is already "***:***@" when it reaches us.
    const r = parseAwsError(
      '\r\naws: [ERROR]: Failed to connect to proxy URL: "http://***:***@proxy.corp.example:8080"\r\n',
    );
    assert.match(r.suggestion ?? "", /http:\/\/\*\*\*:\*\*\*@proxy\.corp\.example:8080/);
    assert.match(r.suggestion ?? "", /it is the proxy, not AWS, that did not answer/);
    assert.match(r.suggestion ?? "", /NO_PROXY/);
    assert.equal(r.code, undefined);
  });

  it("keeps the endpoint remedy for the unreachable-endpoint sentence", () => {
    // BAD_ENDPOINT_RE runs first and neither new pattern can match its text --
    // botocore raises EndpointConnectionError, SSLError and ProxyConnectionError
    // from three different places with three different sentences.
    const r = parseAwsError('Could not connect to the endpoint URL: "https://lambda.us-east-9.amazonaws.com/"');
    assert.match(r.suggestion ?? "", /Check the region spelling/);
  });

  it("does not fire on prose that merely mentions SSL or a proxy", () => {
    for (const noise of ["our ssl validation failed review is pending", "the proxy url is in the runbook"]) {
      assert.equal(parseAwsError(noise).suggestion, undefined, noise);
    }
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

describe("parseAwsError -- transport failures", () => {
  // Every sample is a verbatim capture from a real AWS CLI driven against a
  // loopback stub (`lambda-invoke-probe2.out.ndjson`,
  // `lambda-invoke-rv2-probe.out.ndjson`), in both prefix styles: 2.34.3 writes
  // "aws: [ERROR]: " ahead of the sentence and 2.22.0 writes it bare. None of
  // these three had a remedy before, which is how a 60-second Lambda invoke came
  // back with nothing to act on.

  it("gives a read timeout a remedy that does not claim the request was or was not re-sent", () => {
    for (const stderr of [
      '\r\naws: [ERROR]: Read timeout on endpoint URL: "http://127.0.0.1:28763/2015-03-31/functions/slow-6000/invocations"\r\n',
      '\r\nRead timeout on endpoint URL: "http://127.0.0.1:28841/2015-03-31/functions/slow-4000/invocations?Qualifier=PROD"\r\n',
    ]) {
      const r = parseAwsError(stderr);
      assert.match(r.suggestion ?? "", /socket read timeout/);
      // Generic on purpose: aws_call and every other tool reach this with the
      // CLI's retries still ON, so only aws_lambda_invoke -- which turns them off
      // and reads the URL itself -- may say "sent once".
      assert.match(r.suggestion ?? "", /may already have re-sent it/);
      assert.match(r.suggestion ?? "", /check before retrying/);
      // There is no "An error occurred (Code)" wrapper on a transport failure.
      assert.equal(r.code, undefined);
      assert.equal(r.operation, undefined);
      assert.equal(r.message, stderr.trim());
    }
  });

  it("gives a connect timeout the network / proxy / region remedy", () => {
    const r = parseAwsError(
      '\r\naws: [ERROR]: Connect timeout on endpoint URL: "http://192.0.2.1:9/2015-03-31/functions/ok/invocations"\r\n',
    );
    assert.match(r.suggestion ?? "", /Could not open a connection/);
    assert.match(r.suggestion ?? "", /HTTPS_PROXY/);
    assert.equal(r.code, undefined);
  });

  it("gives a dropped connection the may-or-may-not-have-taken-effect remedy", () => {
    // Note the trailing "." after the quoted URL: it is in the real message, so
    // the pattern must not expect the URL to end the line.
    const r = parseAwsError(
      '\r\naws: [ERROR]: Connection was closed before we received a valid response from endpoint URL: "http://127.0.0.1:28763/2015-03-31/functions/reset/invocations".\r\n',
    );
    assert.match(r.suggestion ?? "", /may or may not have taken effect/);
    assert.match(r.suggestion ?? "", /NAT gateway, firewall or proxy/);
  });

  it("does not fire on prose that merely mentions a read timeout", () => {
    // The patterns are botocore's fmt strings, not keywords -- the whole point of
    // anchoring on "on endpoint URL:" rather than on "read timeout".
    const r = parseAwsError("a read timeout happened in my app");
    assert.equal(r.suggestion, undefined);
    assert.equal(r.message, "a read timeout happened in my app");
  });

  it("exports READ_TIMEOUT_RE with the whole line, so a caller can read the URL out of it", () => {
    // What aws_lambda_invoke tells "the invoke was sent" from "a credential call
    // never answered" with: this STS capture (`sts_hang_rt3`) came with ZERO
    // Invoke requests, and the URL is the only thing that says so.
    const m = READ_TIMEOUT_RE.exec('\r\naws: [ERROR]: Read timeout on endpoint URL: "http://127.0.0.1:28842/"\r\n');
    assert.ok(m);
    assert.ok(m[0].includes("http://127.0.0.1:28842/"), `matched line was ${JSON.stringify(m?.[0])}`);
    // One line only: a multi-line blob must not let the match run past it.
    assert.ok(!m[0].includes("\r"));
  });
});
