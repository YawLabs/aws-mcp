import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { upsertProfile, upsertProfileIntoText } from "./aws-credentials.js";

const CREDS = {
  aws_access_key_id: "AKIA-NEW-1",
  aws_secret_access_key: "secret-new-1",
  aws_session_token: "token-new-1",
};

describe("upsertProfileIntoText — new profile on empty file", () => {
  it("creates the section with all three keys", () => {
    const out = upsertProfileIntoText("", "mcp-dev", CREDS);
    assert.match(out, /\[mcp-dev\]/);
    assert.match(out, /aws_access_key_id = AKIA-NEW-1/);
    assert.match(out, /aws_secret_access_key = secret-new-1/);
    assert.match(out, /aws_session_token = token-new-1/);
  });
});

describe("upsertProfileIntoText — append to existing file", () => {
  it("preserves existing profiles and appends the new one", () => {
    const existing = `[default]
aws_access_key_id = OLD-DEFAULT
aws_secret_access_key = old-default-secret

[prod]
aws_access_key_id = OLD-PROD
aws_secret_access_key = old-prod-secret
`;
    const out = upsertProfileIntoText(existing, "mcp-staging", CREDS);
    assert.match(out, /\[default\]/);
    assert.match(out, /OLD-DEFAULT/);
    assert.match(out, /\[prod\]/);
    assert.match(out, /OLD-PROD/);
    assert.match(out, /\[mcp-staging\]/);
    assert.match(out, /AKIA-NEW-1/);
  });

  it("preserves comments in the preamble", () => {
    const existing = `# This is my credentials file
; Managed by me

[default]
aws_access_key_id = X
aws_secret_access_key = Y
`;
    const out = upsertProfileIntoText(existing, "mcp-new", CREDS);
    assert.match(out, /# This is my credentials file/);
    assert.match(out, /; Managed by me/);
    assert.match(out, /\[default\]/);
    assert.match(out, /\[mcp-new\]/);
  });
});

describe("upsertProfileIntoText — update existing profile", () => {
  it("replaces the three managed keys in place", () => {
    const existing = `[mcp-dev]
aws_access_key_id = OLD-KEY
aws_secret_access_key = old-secret
aws_session_token = old-token
`;
    const out = upsertProfileIntoText(existing, "mcp-dev", CREDS);
    assert.ok(!out.includes("OLD-KEY"));
    assert.ok(!out.includes("old-secret"));
    assert.ok(!out.includes("old-token"));
    assert.match(out, /AKIA-NEW-1/);
    assert.match(out, /secret-new-1/);
    assert.match(out, /token-new-1/);
  });

  it("preserves unrelated keys (region, output) in the same profile", () => {
    const existing = `[mcp-dev]
aws_access_key_id = OLD-KEY
aws_secret_access_key = old-secret
aws_session_token = old-token
region = eu-west-1
output = json
`;
    const out = upsertProfileIntoText(existing, "mcp-dev", CREDS);
    assert.match(out, /region = eu-west-1/);
    assert.match(out, /output = json/);
    assert.match(out, /AKIA-NEW-1/);
  });

  it("does not duplicate other profiles when updating one", () => {
    const existing = `[default]
aws_access_key_id = DEFAULT-KEY

[mcp-dev]
aws_access_key_id = OLD-KEY
aws_secret_access_key = old
aws_session_token = old

[prod]
aws_access_key_id = PROD-KEY
`;
    const out = upsertProfileIntoText(existing, "mcp-dev", CREDS);
    const defaultCount = (out.match(/\[default\]/g) ?? []).length;
    const prodCount = (out.match(/\[prod\]/g) ?? []).length;
    assert.equal(defaultCount, 1);
    assert.equal(prodCount, 1);
    assert.match(out, /DEFAULT-KEY/);
    assert.match(out, /PROD-KEY/);
  });

  it("adds missing managed keys when the profile exists with only some of them", () => {
    const existing = `[mcp-dev]
aws_access_key_id = OLD
region = us-east-1
`;
    const out = upsertProfileIntoText(existing, "mcp-dev", CREDS);
    assert.match(out, /aws_secret_access_key = secret-new-1/);
    assert.match(out, /aws_session_token = token-new-1/);
    assert.match(out, /region = us-east-1/);
  });
});

describe("upsertProfile — filesystem round-trip", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aws-mcp-creds-"));
    path = join(dir, "credentials");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the file when missing", () => {
    upsertProfile(path, "mcp-dev", CREDS);
    const text = readFileSync(path, "utf-8");
    assert.match(text, /\[mcp-dev\]/);
    assert.match(text, /AKIA-NEW-1/);
  });

  it("modifies in place without destroying other profiles", () => {
    writeFileSync(
      path,
      `[default]
aws_access_key_id = DEFAULT
aws_secret_access_key = default-secret
`,
    );
    upsertProfile(path, "mcp-dev", CREDS);
    const text = readFileSync(path, "utf-8");
    assert.match(text, /\[default\]/);
    assert.match(text, /DEFAULT/);
    assert.match(text, /\[mcp-dev\]/);
    assert.match(text, /AKIA-NEW-1/);
  });

  it("applies 0600 perms on Unix (skipped on Windows)", () => {
    if (platform() === "win32") return;
    upsertProfile(path, "mcp-dev", CREDS);
    const mode = statSync(path).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  });

  it("second upsert updates the same profile (not appends)", () => {
    upsertProfile(path, "mcp-dev", CREDS);
    upsertProfile(path, "mcp-dev", {
      aws_access_key_id: "AKIA-V2",
      aws_secret_access_key: "secret-v2",
      aws_session_token: "token-v2",
    });
    const text = readFileSync(path, "utf-8");
    const sectionCount = (text.match(/\[mcp-dev\]/g) ?? []).length;
    assert.equal(sectionCount, 1);
    assert.ok(!text.includes("AKIA-NEW-1"));
    assert.match(text, /AKIA-V2/);
  });
});
