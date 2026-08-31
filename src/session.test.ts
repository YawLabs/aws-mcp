import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  _resetSession,
  clearProfile,
  clearRegion,
  getProfile,
  getRegion,
  getSessionState,
  invalidProfileMessage,
  invalidRegionMessage,
  isValidProfileName,
  isValidRegionName,
  setProfile,
  setRegion,
} from "./session.js";

// Restore env across tests so one test's mutation doesn't leak into another.
const savedEnv = { ...process.env };

beforeEach(() => {
  _resetSession();
  delete process.env.AWS_PROFILE;
  delete process.env.AWS_DEFAULT_PROFILE;
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

describe("empty-string env vars are ABSENT, not a value", () => {
  // `??` treats "" as present, so an empty AWS_PROFILE / AWS_REGION used to
  // stop the resolution chain dead and hand `aws --profile ''` to the CLI.
  // This is routine in CI: `AWS_REGION: ${{ inputs.region }}` with nothing
  // passed, a `.env` line with no value, `export AWS_PROFILE=` in a wrapper.
  // The chains use `||` so empty falls through to the next link.

  it("AWS_PROFILE='' falls through to the built-in default", () => {
    process.env.AWS_PROFILE = "";
    assert.equal(getProfile(), "default");
  });

  it("AWS_PROFILE='' falls through to AWS_DEFAULT_PROFILE when that is set", () => {
    process.env.AWS_PROFILE = "";
    process.env.AWS_DEFAULT_PROFILE = "legacy-prof";
    assert.equal(getProfile(), "legacy-prof");
  });

  it("AWS_REGION='' falls through to AWS_DEFAULT_REGION", () => {
    process.env.AWS_REGION = "";
    process.env.AWS_DEFAULT_REGION = "eu-central-1";
    assert.equal(getRegion(), "eu-central-1");
  });

  it("both region vars empty falls through to the built-in default", () => {
    process.env.AWS_REGION = "";
    process.env.AWS_DEFAULT_REGION = "";
    assert.equal(getRegion(), "us-east-1");
  });

  it("an empty env var never reaches the argv validators", () => {
    // The concrete consequence: "" fails isValidProfileName / isValidRegionName,
    // so before this fix a CI job with an unset-but-exported var got a
    // bad_input rejection from runAwsCall instead of the default profile.
    process.env.AWS_PROFILE = "";
    process.env.AWS_REGION = "";
    assert.equal(isValidProfileName(getProfile()), true);
    assert.equal(isValidRegionName(getRegion()), true);
  });
});

describe("AWS_DEFAULT_PROFILE (the legacy spelling)", () => {
  it("is honored when AWS_PROFILE is unset", () => {
    process.env.AWS_DEFAULT_PROFILE = "legacy-prof";
    assert.equal(getProfile(), "legacy-prof");
  });

  it("loses to AWS_PROFILE when both are set", () => {
    // Mirrors the AWS_REGION / AWS_DEFAULT_REGION precedence already in place.
    process.env.AWS_PROFILE = "modern-prof";
    process.env.AWS_DEFAULT_PROFILE = "legacy-prof";
    assert.equal(getProfile(), "modern-prof");
  });

  it("loses to a session override", () => {
    process.env.AWS_DEFAULT_PROFILE = "legacy-prof";
    setProfile("sess-prof");
    assert.equal(getProfile(), "sess-prof");
  });
});

describe("invalidProfileMessage / invalidRegionMessage", () => {
  // Single-sourced so the three call sites (these setters, the pre-validation
  // in tools/session.ts, and runAwsCall's post-resolution check) cannot drift
  // apart again.

  it("setProfile throws exactly the shared message", () => {
    assert.throws(
      () => setProfile("-evil"),
      (err: Error) => err.message === invalidProfileMessage("-evil"),
    );
  });

  it("setRegion throws exactly the shared message", () => {
    assert.throws(
      () => setRegion("US-EAST-1"),
      (err: Error) => err.message === invalidRegionMessage("US-EAST-1"),
    );
  });

  it("appends a call-site tail after the shared rule statement", () => {
    const withTail = invalidProfileMessage("bad", "Check the 'profile' arg or AWS_PROFILE env var.");
    assert.ok(withTail.startsWith(invalidProfileMessage("bad")), "tail form must extend the bare form");
    assert.match(withTail, /Check the 'profile' arg or AWS_PROFILE env var\.$/);
  });

  it("omits the separator when no tail is given", () => {
    assert.doesNotMatch(invalidRegionMessage("bad"), / $/);
    assert.match(invalidRegionMessage("bad", "Extra."), /\)\. Extra\.$/);
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

  it("setProfile rejects leading-hyphen (argv-injection defense)", () => {
    assert.throws(() => setProfile("--query=foo"), /Invalid profile name/);
    assert.throws(() => setProfile("-evil"), /Invalid profile name/);
  });

  it("setProfile rejects INI-breaking characters", () => {
    assert.throws(() => setProfile("evil]hack"), /Invalid profile name/);
    assert.throws(() => setProfile("[bracket"), /Invalid profile name/);
    assert.throws(() => setProfile("line\nbreak"), /Invalid profile name/);
  });

  it("setRegion rejects leading-hyphen and shell metacharacters", () => {
    assert.throws(() => setRegion("--query=foo"), /Invalid region/);
    assert.throws(() => setRegion("us-east-1;rm"), /Invalid region/);
    assert.throws(() => setRegion("US-EAST-1"), /Invalid region/);
  });
});

describe("isValidProfileName", () => {
  it("accepts typical AWS profile names", () => {
    for (const name of ["default", "prod", "mcp-my-session", "dev_user", "org:account:role", "user@company.com"]) {
      assert.equal(isValidProfileName(name), true, `expected '${name}' to be valid`);
    }
  });

  it("rejects leading hyphen (argv-injection defense)", () => {
    assert.equal(isValidProfileName("--query=foo"), false);
    assert.equal(isValidProfileName("-prod"), false);
    assert.equal(isValidProfileName("-"), false);
  });

  it("rejects whitespace and control characters", () => {
    assert.equal(isValidProfileName("with space"), false);
    assert.equal(isValidProfileName("with\ttab"), false);
    assert.equal(isValidProfileName("with\nnewline"), false);
    assert.equal(isValidProfileName("with\x00null"), false);
  });

  it("rejects INI-breaking characters", () => {
    assert.equal(isValidProfileName("evil]hack"), false);
    assert.equal(isValidProfileName("[bracket"), false);
  });

  it("rejects empty and over-length names", () => {
    assert.equal(isValidProfileName(""), false);
    assert.equal(isValidProfileName("a".repeat(129)), false);
    assert.equal(isValidProfileName("a".repeat(128)), true);
  });
});

describe("isValidRegionName", () => {
  it("accepts standard AWS region IDs", () => {
    for (const r of ["us-east-1", "us-west-2", "eu-west-3", "ap-northeast-1", "us-gov-east-1", "cn-north-1"]) {
      assert.equal(isValidRegionName(r), true, `expected '${r}' to be valid`);
    }
  });

  it("rejects leading hyphen and shell metacharacters", () => {
    assert.equal(isValidRegionName("--query=foo"), false);
    assert.equal(isValidRegionName("-us-east-1"), false);
    assert.equal(isValidRegionName("us-east-1;rm"), false);
  });

  it("rejects uppercase and whitespace", () => {
    assert.equal(isValidRegionName("US-EAST-1"), false);
    assert.equal(isValidRegionName("us east 1"), false);
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

  it("reports AWS_DEFAULT_PROFILE as an 'env' source", () => {
    process.env.AWS_DEFAULT_PROFILE = "legacy-prof";
    const state = getSessionState();
    assert.equal(state.profile, "legacy-prof");
    assert.equal(state.profileSource, "env");
  });

  it("the source label agrees with the value when env vars are empty strings", () => {
    // The bug: getRegion used `??` (so "" WAS the answer) while regionSource
    // used `||` (so it said "default"). The response claimed the built-in
    // default was in play while reporting region:"" -- a state that reads as
    // fine and then fails at the CLI. Both sides now use the same truthiness.
    process.env.AWS_PROFILE = "";
    process.env.AWS_REGION = "";
    const state = getSessionState();
    assert.equal(state.profile, "default");
    assert.equal(state.profileSource, "default");
    assert.equal(state.region, "us-east-1");
    assert.equal(state.regionSource, "default");
  });

  it("labels 'env' only when the value actually came from the env", () => {
    // Empty AWS_REGION with a real AWS_DEFAULT_REGION: the value IS from the
    // env, just the other variable.
    process.env.AWS_REGION = "";
    process.env.AWS_DEFAULT_REGION = "eu-central-1";
    const state = getSessionState();
    assert.equal(state.region, "eu-central-1");
    assert.equal(state.regionSource, "env");
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

describe("clearProfile / clearRegion", () => {
  it("clearProfile only resets the profile override", () => {
    setProfile("sess-prof");
    setRegion("ap-south-1");
    clearProfile();
    assert.equal(getProfile(), "default");
    assert.equal(getRegion(), "ap-south-1"); // untouched
  });

  it("clearRegion only resets the region override", () => {
    setProfile("sess-prof");
    setRegion("ap-south-1");
    clearRegion();
    assert.equal(getProfile(), "sess-prof"); // untouched
    assert.equal(getRegion(), "us-east-1");
  });

  it("clear falls back to env when env is set", () => {
    process.env.AWS_PROFILE = "env-prof";
    setProfile("override");
    clearProfile();
    assert.equal(getProfile(), "env-prof");
  });

  it("clear on an already-unset override is a no-op", () => {
    clearProfile();
    clearProfile();
    assert.equal(getProfile(), "default");
  });
});
