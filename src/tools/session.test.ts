import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { _resetSession } from "../session.js";
import { sessionTools } from "./session.js";

const setTool = sessionTools.find((t) => t.name === "aws_session_set");
const getTool = sessionTools.find((t) => t.name === "aws_session_get");
if (!setTool || !getTool) throw new Error("sessionTools missing expected entries");

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

type SessionData = {
  profile: string;
  region: string;
  profileSource: "session" | "env" | "default";
  regionSource: "session" | "env" | "default";
};

describe("aws_session_set", () => {
  it("errors when neither profile nor region is provided", async () => {
    const r = (await setTool.handler({})) as { ok: boolean; error?: string };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Nothing to set/);
  });

  it("sets profile and returns new state with source='session'", async () => {
    const r = (await setTool.handler({ profile: "prod" })) as { ok: boolean; data: SessionData };
    assert.equal(r.ok, true);
    assert.equal(r.data.profile, "prod");
    assert.equal(r.data.profileSource, "session");
    // Region is untouched — still default
    assert.equal(r.data.region, "us-east-1");
    assert.equal(r.data.regionSource, "default");
  });

  it("sets region without touching profile", async () => {
    const r = (await setTool.handler({ region: "us-west-2" })) as { ok: boolean; data: SessionData };
    assert.equal(r.ok, true);
    assert.equal(r.data.region, "us-west-2");
    assert.equal(r.data.regionSource, "session");
    assert.equal(r.data.profileSource, "default");
  });

  it("sets both profile and region in one call", async () => {
    const r = (await setTool.handler({ profile: "staging", region: "eu-west-1" })) as {
      ok: boolean;
      data: SessionData;
    };
    assert.equal(r.ok, true);
    assert.equal(r.data.profile, "staging");
    assert.equal(r.data.region, "eu-west-1");
  });

  it("rejects empty-string profile via underlying validator", async () => {
    const r = (await setTool.handler({ profile: "" })) as { ok: boolean; error?: string };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /cannot be empty/);
  });

  it("rejects whitespace-only region", async () => {
    const r = (await setTool.handler({ region: "   " })) as { ok: boolean; error?: string };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /cannot be empty/);
  });
});

describe("aws_session_get", () => {
  it("returns defaults when nothing is set", async () => {
    const r = (await getTool.handler({})) as { ok: boolean; data: SessionData };
    assert.equal(r.ok, true);
    assert.equal(r.data.profile, "default");
    assert.equal(r.data.region, "us-east-1");
    assert.equal(r.data.profileSource, "default");
    assert.equal(r.data.regionSource, "default");
  });

  it("reflects env vars when present", async () => {
    process.env.AWS_PROFILE = "env-prof";
    process.env.AWS_REGION = "ap-northeast-1";
    const r = (await getTool.handler({})) as { ok: boolean; data: SessionData };
    assert.equal(r.data.profile, "env-prof");
    assert.equal(r.data.region, "ap-northeast-1");
    assert.equal(r.data.profileSource, "env");
    assert.equal(r.data.regionSource, "env");
  });

  it("reflects session override after aws_session_set", async () => {
    await setTool.handler({ profile: "override", region: "ca-central-1" });
    const r = (await getTool.handler({})) as { ok: boolean; data: SessionData };
    assert.equal(r.data.profile, "override");
    assert.equal(r.data.region, "ca-central-1");
    assert.equal(r.data.profileSource, "session");
    assert.equal(r.data.regionSource, "session");
  });
});
