import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseAwsConfig, profilesTools, resolveProfileStartUrl } from "./profiles.js";

const listTool = profilesTools.find((t) => t.name === "aws_list_profiles");
if (!listTool) throw new Error("profilesTools missing aws_list_profiles");

describe("parseAwsConfig", () => {
  it("parses a [default] section as name='default'", () => {
    const profiles = parseAwsConfig("[default]\nregion = us-east-1\n");
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].name, "default");
    assert.equal(profiles[0].region, "us-east-1");
    assert.equal(profiles[0].isSso, false);
  });

  it("strips the 'profile ' prefix from named sections", () => {
    const profiles = parseAwsConfig("[profile prod]\nregion = us-west-2\n");
    assert.equal(profiles[0].name, "prod");
  });

  it("flags profiles with sso_start_url as isSso=true", () => {
    const text = `
[profile sso-prof]
sso_start_url = https://d-xxxxx.awsapps.com/start
sso_region = us-east-1
sso_account_id = 123456789012
sso_role_name = ReadOnly
region = us-east-1
`;
    const [p] = parseAwsConfig(text);
    assert.equal(p.isSso, true);
    assert.equal(p.ssoStartUrl, "https://d-xxxxx.awsapps.com/start");
    assert.equal(p.ssoRegion, "us-east-1");
    assert.equal(p.region, "us-east-1");
  });

  it("handles the newer sso_session= form", () => {
    const text = `
[sso-session my-org]
sso_start_url = https://d-xxxxx.awsapps.com/start
sso_region = us-east-1

[profile dev]
sso_session = my-org
sso_account_id = 111111111111
sso_role_name = Dev
region = us-east-1
`;
    const profiles = parseAwsConfig(text);
    // sso-session blocks don't emit profiles themselves
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].name, "dev");
    assert.equal(profiles[0].ssoSession, "my-org");
    assert.equal(profiles[0].isSso, true);
    // Start URL + region should be inherited from the referenced sso-session.
    assert.equal(profiles[0].ssoStartUrl, "https://d-xxxxx.awsapps.com/start");
    assert.equal(profiles[0].ssoRegion, "us-east-1");
  });

  it("prefers the profile's inline ssoStartUrl over the referenced sso-session's", () => {
    const text = `
[sso-session my-org]
sso_start_url = https://session.awsapps.com/start

[profile dev]
sso_session = my-org
sso_start_url = https://inline.awsapps.com/start
`;
    const [p] = parseAwsConfig(text);
    assert.equal(p.ssoStartUrl, "https://inline.awsapps.com/start");
  });

  it("ignores sso_session refs pointing at a missing sso-session block", () => {
    const text = `
[profile dev]
sso_session = missing-org
`;
    const [p] = parseAwsConfig(text);
    assert.equal(p.ssoSession, "missing-org");
    assert.equal(p.ssoStartUrl, undefined);
  });

  it("handles multiple profiles in one file", () => {
    const text = `
[default]
region = us-east-1

[profile staging]
region = eu-west-1
sso_start_url = https://d-yyyyy.awsapps.com/start
sso_region = eu-west-1

[profile prod]
region = us-east-2
`;
    const profiles = parseAwsConfig(text);
    assert.equal(profiles.length, 3);
    assert.deepEqual(
      profiles.map((p) => p.name),
      ["default", "staging", "prod"],
    );
    assert.equal(profiles.find((p) => p.name === "staging")?.isSso, true);
    assert.equal(profiles.find((p) => p.name === "prod")?.isSso, false);
  });

  it("ignores blank lines and comments (# and ;)", () => {
    const text = `
# top comment
; another comment

[profile foo]
# inline comment
region = us-east-1
; trailing
`;
    const profiles = parseAwsConfig(text);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].region, "us-east-1");
  });

  it("tolerates keys with equals signs in values", () => {
    // Rare but legal: a value containing '='.
    const text = "[profile foo]\nsso_start_url = https://x.awsapps.com/start?a=b\n";
    const [p] = parseAwsConfig(text);
    assert.equal(p.ssoStartUrl, "https://x.awsapps.com/start?a=b");
  });

  it("returns an empty list on empty input", () => {
    assert.deepEqual(parseAwsConfig(""), []);
  });
});

describe("resolveProfileStartUrl", () => {
  it("returns the startUrl for an inline-sso profile", () => {
    const text = `
[profile dev]
sso_start_url = https://d-xxxxx.awsapps.com/start
sso_region = us-east-1
`;
    assert.equal(resolveProfileStartUrl(text, "dev"), "https://d-xxxxx.awsapps.com/start");
  });

  it("returns the startUrl for a profile referencing an sso-session", () => {
    const text = `
[sso-session my-org]
sso_start_url = https://via-session.awsapps.com/start

[profile dev]
sso_session = my-org
`;
    assert.equal(resolveProfileStartUrl(text, "dev"), "https://via-session.awsapps.com/start");
  });

  it("returns null when the profile isn't SSO", () => {
    const text = "[profile dev]\nregion = us-east-1\n";
    assert.equal(resolveProfileStartUrl(text, "dev"), null);
  });

  it("returns null when the profile doesn't exist", () => {
    assert.equal(resolveProfileStartUrl("[default]\n", "missing"), null);
  });
});

describe("aws_list_profiles handler", () => {
  let configDir: string;
  let homeBackup: string | undefined;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "aws-mcp-profiles-"));
    homeBackup = process.env.HOME;
    process.env.HOME = configDir;
    // On Windows, homedir() uses USERPROFILE instead.
    process.env.USERPROFILE = configDir;
  });

  afterEach(() => {
    if (homeBackup === undefined) delete process.env.HOME;
    else process.env.HOME = homeBackup;
    rmSync(configDir, { recursive: true, force: true });
  });

  it("returns an error when ~/.aws/config doesn't exist", async () => {
    const r = (await listTool.handler({})) as { ok: boolean; error?: string };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /not found/);
  });
});
