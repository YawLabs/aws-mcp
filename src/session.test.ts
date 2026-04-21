import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { _resetSession, getProfile, getRegion, getSessionState, setProfile, setRegion } from "./session.js";

// Restore env across tests so one test's mutation doesn't leak into another.
const savedEnv = { ...process.env };

beforeEach(() => {
  _resetSession();
  delete process.env.AWS_PROFILE;
  delete process.env.AWS_REGION;
  delete process.env.AWS_DEFAULT_REGION;
});

afterEach(() => {
  _resetSession();
  process.env = { ...savedEnv };
});

describe("getProfile", () => {
  it("returns 'default' when nothing is set", () => {
    assert.equal(getProfile(), "default");
  });

  it("returns AWS_PROFILE env var when set", () => {
    process.env.AWS_PROFILE = "env-profile";
    assert.equal(getProfile(), "env-profile");
  });

  it("returns session override when set, ignoring env", () => {
    process.env.AWS_PROFILE = "env-profile";
    setProfile("session-profile");
    assert.equal(getProfile(), "session-profile");
  });
});

describe("getRegion", () => {
  it("returns 'us-east-1' when nothing is set", () => {
    assert.equal(getRegion(), "us-east-1");
  });

  it("returns AWS_REGION env var when set", () => {
    process.env.AWS_REGION = "us-west-2";
    assert.equal(getRegion(), "us-west-2");
  });

  it("falls back to AWS_DEFAULT_REGION when AWS_REGION is missing", () => {
    process.env.AWS_DEFAULT_REGION = "eu-central-1";
    assert.equal(getRegion(), "eu-central-1");
  });

  it("AWS_REGION wins over AWS_DEFAULT_REGION", () => {
    process.env.AWS_REGION = "us-east-2";
    process.env.AWS_DEFAULT_REGION = "eu-central-1";
    assert.equal(getRegion(), "us-east-2");
  });

  it("returns session override when set, ignoring env", () => {
    process.env.AWS_REGION = "us-west-2";
    setRegion("ap-southeast-1");
    assert.equal(getRegion(), "ap-southeast-1");
  });
});

describe("setProfile / setRegion", () => {
  it("rejects empty string", () => {
    assert.throws(() => setProfile(""), /cannot be empty/);
    assert.throws(() => setRegion(""), /cannot be empty/);
  });

  it("rejects whitespace-only strings", () => {
    assert.throws(() => setProfile("   "), /cannot be empty/);
    assert.throws(() => setRegion("\t\n"), /cannot be empty/);
  });

  it("trims surrounding whitespace", () => {
    setProfile("  prod  ");
    setRegion("  us-west-2  ");
    assert.equal(getProfile(), "prod");
    assert.equal(getRegion(), "us-west-2");
  });

  it("later calls overwrite earlier ones", () => {
    setProfile("first");
    setProfile("second");
    assert.equal(getProfile(), "second");
  });
});

describe("getSessionState", () => {
  it("labels source as 'default' when no env or session override", () => {
    const state = getSessionState();
    assert.equal(state.profile, "default");
    assert.equal(state.region, "us-east-1");
    assert.equal(state.profileSource, "default");
    assert.equal(state.regionSource, "default");
  });

  it("labels source as 'env' when only env vars are set", () => {
    process.env.AWS_PROFILE = "env-prof";
    process.env.AWS_REGION = "eu-west-1";
    const state = getSessionState();
    assert.equal(state.profileSource, "env");
    assert.equal(state.regionSource, "env");
  });

  it("labels source as 'session' when setters have been called", () => {
    process.env.AWS_PROFILE = "env-prof";
    process.env.AWS_REGION = "eu-west-1";
    setProfile("sess-prof");
    setRegion("ap-south-1");
    const state = getSessionState();
    assert.equal(state.profile, "sess-prof");
    assert.equal(state.profileSource, "session");
    assert.equal(state.region, "ap-south-1");
    assert.equal(state.regionSource, "session");
  });

  it("reports AWS_DEFAULT_REGION as an 'env' source", () => {
    process.env.AWS_DEFAULT_REGION = "eu-central-1";
    assert.equal(getSessionState().regionSource, "env");
  });
});

describe("_resetSession", () => {
  it("clears session overrides so env fallback kicks in again", () => {
    process.env.AWS_PROFILE = "env-prof";
    setProfile("session-prof");
    assert.equal(getProfile(), "session-prof");
    _resetSession();
    assert.equal(getProfile(), "env-prof");
  });
});
