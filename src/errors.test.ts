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

  it("detects 'token is expired' phrasing", () => {
    const err = new Error("Provided token is expired");
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
});

describe("parseAwsError -- non-standard shapes", () => {
  it("flags bad endpoint with the URL extracted", () => {
    const r = parseAwsError('Could not connect to the endpoint URL: "https://lambda.us-east-9.amazonaws.com/"');
    assert.match(r.suggestion ?? "", /region/i);
    assert.match(r.suggestion ?? "", /lambda\.us-east-9/);
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
