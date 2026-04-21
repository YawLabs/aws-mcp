import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyAuthError } from "./errors.js";

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
