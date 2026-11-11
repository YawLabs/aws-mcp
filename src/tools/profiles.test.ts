import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  type AwsProfile,
  parseAwsConfig,
  parseSsoSessions,
  profilesTools,
  resolveProfileStartUrl,
} from "./profiles.js";

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

  it("reads a header with a trailing comment as that section (botocore SECTCRE)", () => {
    const text =
      "[sso-session acme]\nsso_start_url = https://acme.awsapps.com/start\nsso_region = us-east-1\n" +
      "[profile prod-Admin]  # my break-glass profile\nsso_account_id = 999999999999\n" +
      "[profile legacy] ; note\nregion = eu-west-1\n";
    assert.deepEqual(
      parseAwsConfig(text).map((p) => [p.name, p.region]),
      [
        ["prod-Admin", undefined],
        ["legacy", "eu-west-1"],
      ],
    );
    assert.deepEqual(
      parseSsoSessions(text).map((s) => [s.name, s.ssoStartUrl, s.ssoRegion]),
      [["acme", "https://acme.awsapps.com/start", "us-east-1"]],
    );
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

  it("only emits [default] and [profile X]; every other section is ignored (allowlist)", () => {
    // parseAwsConfig must match `aws configure list-profiles`: ONLY default +
    // profile sections are profiles. Services/plugins endpoint blocks, [preview],
    // arbitrary/unknown sections, and any casing variant must NOT surface. A
    // skipped section's keys must also not leak onto an adjacent profile.
    const text = `
[default]
region = us-east-1

[services my-svc]
s3 =
  endpoint_url = https://s3.local

[plugins]
cwlogs = cwlogs

[Services cap-svc]
s3 =
  endpoint_url = https://cap.local

[Plugins]
foo = bar

[preview]
cloudfront = true

[some-random-section]
key = value

[profile prod]
region = us-west-2
`;
    const profiles = parseAwsConfig(text);
    assert.deepEqual(
      profiles.map((p) => p.name),
      ["default", "prod"],
    );
    // None of the skipped sections' keys leaked onto the adjacent profile.
    assert.equal(profiles.find((p) => p.name === "prod")?.region, "us-west-2");
  });

  it("keeps a real profile literally named 'services' or 'plugins' (it carries the 'profile ' prefix)", () => {
    // The allowlist matches on the `profile ` prefix, not on the bare name, so a
    // user who names a profile "services" -- written `[profile services]` -- is
    // unaffected by the non-profile-section skip.
    const text = `
[profile services]
region = us-east-1

[profile plugins]
region = eu-west-1
`;
    const profiles = parseAwsConfig(text);
    assert.deepEqual(
      profiles.map((p) => p.name),
      ["services", "plugins"],
    );
    assert.equal(profiles.find((p) => p.name === "services")?.region, "us-east-1");
  });

  it("drops nameless section headers ([profile], [sso-session], [plugins]) instead of leaking a bogus profile", () => {
    // A header carrying the keyword but no name -- a user typo -- must not
    // surface as a profile literally named the keyword. The allowlist requires
    // `profile ` + a name, and the sso-session branch requires `sso-session ` +
    // a name, so each bare keyword falls through to the skip. Its keys must not
    // leak onto an adjacent profile either.
    const text = `
[default]
region = us-east-1

[profile]
region = nowhere

[sso-session]
sso_start_url = https://x.awsapps.com/start

[plugins]
foo = bar

[profile real]
region = us-west-2
`;
    const profiles = parseAwsConfig(text);
    assert.deepEqual(
      profiles.map((p) => p.name),
      ["default", "real"],
    );
    assert.equal(profiles.find((p) => p.name === "default")?.region, "us-east-1");
    assert.equal(profiles.find((p) => p.name === "real")?.region, "us-west-2");
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
  let userprofileBackup: string | undefined;
  let configFileBackup: string | undefined;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "aws-mcp-profiles-"));
    homeBackup = process.env.HOME;
    userprofileBackup = process.env.USERPROFILE;
    configFileBackup = process.env.AWS_CONFIG_FILE;
    process.env.HOME = configDir;
    // On Windows, homedir() uses USERPROFILE instead.
    process.env.USERPROFILE = configDir;
    // An ambient AWS_CONFIG_FILE would take precedence over HOME/.aws/config.
    delete process.env.AWS_CONFIG_FILE;
  });

  afterEach(() => {
    if (homeBackup === undefined) delete process.env.HOME;
    else process.env.HOME = homeBackup;
    if (userprofileBackup === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = userprofileBackup;
    if (configFileBackup === undefined) delete process.env.AWS_CONFIG_FILE;
    else process.env.AWS_CONFIG_FILE = configFileBackup;
    rmSync(configDir, { recursive: true, force: true });
  });

  it("reads AWS_CONFIG_FILE instead of ~/.aws/config when it is set", async () => {
    // Both files exist with different profiles, so the result proves which one
    // was read -- the same file the aws CLI subprocess reads.
    mkdirSync(join(configDir, ".aws"));
    writeFileSync(join(configDir, ".aws", "config"), "[profile from-home]\nregion = us-east-1\n");
    const perUser = join(configDir, "per-user-config");
    writeFileSync(perUser, "[profile from-env]\nregion = eu-west-1\n");
    process.env.AWS_CONFIG_FILE = perUser;

    const r = (await listTool.handler({})) as { ok: boolean; data?: { configPath?: string; profiles?: AwsProfile[] } };
    assert.equal(r.ok, true);
    assert.equal(r.data?.configPath, perUser);
    assert.deepEqual(
      r.data?.profiles?.map((p) => p.name),
      ["from-env"],
    );
  });

  it("expands $VAR in AWS_CONFIG_FILE the way the CLI does", async () => {
    writeFileSync(join(configDir, "var-cfg"), "[profile from-var]\nregion = us-west-2\n");
    process.env.AWS_MCP_TEST_CFG_DIR = configDir;
    try {
      // The literal braced form "${AWS_MCP_TEST_CFG_DIR}/var-cfg".
      process.env.AWS_CONFIG_FILE = `$\{AWS_MCP_TEST_CFG_DIR}/var-cfg`;
      const r = (await listTool.handler({})) as { ok: boolean; data?: { profiles?: AwsProfile[] } };
      assert.equal(r.ok, true);
      assert.deepEqual(
        r.data?.profiles?.map((p) => p.name),
        ["from-var"],
      );
    } finally {
      delete process.env.AWS_MCP_TEST_CFG_DIR;
    }
  });

  it("reports an empty AWS_CONFIG_FILE instead of reading ~/.aws/config", async () => {
    // The CLI loads NO config file for an empty value; listing the home
    // config here would advertise profiles the CLI cannot use.
    mkdirSync(join(configDir, ".aws"));
    writeFileSync(join(configDir, ".aws", "config"), "[profile from-home]\nregion = us-east-1\n");
    process.env.AWS_CONFIG_FILE = "";
    const r = (await listTool.handler({})) as { ok: boolean; error?: string };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /AWS_CONFIG_FILE is set to an empty value/);
  });

  it("expands a leading ~ in AWS_CONFIG_FILE against the home directory", async () => {
    writeFileSync(join(configDir, "cfg"), "[profile tilde]\nregion = us-west-2\n");
    process.env.AWS_CONFIG_FILE = "~/cfg";

    const r = (await listTool.handler({})) as { ok: boolean; data?: { configPath?: string; profiles?: AwsProfile[] } };
    assert.equal(r.ok, true);
    assert.equal(r.data?.configPath, join(configDir, "cfg"));
    assert.deepEqual(
      r.data?.profiles?.map((p) => p.name),
      ["tilde"],
    );
  });

  it("returns an error when ~/.aws/config doesn't exist", async () => {
    const r = (await listTool.handler({})) as { ok: boolean; error?: string };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /not found/);
  });

  it("reads + parses ~/.aws/config and returns names + regions + SSO metadata", async () => {
    // Success-path round-trip the ENOENT test doesn't cover. Write a
    // representative config (default profile, inline-sso profile, and an
    // sso-session-backed profile) into HOME/.aws/config, invoke the handler,
    // and verify parsed names/regions/SSO fields match the file contents.
    mkdirSync(join(configDir, ".aws"));
    const configContents = `[default]
region = us-east-1

[profile staging]
sso_start_url = https://d-stg.awsapps.com/start
sso_region = eu-west-1
sso_account_id = 222222222222
sso_role_name = ReadOnly
region = eu-west-1

[sso-session my-org]
sso_start_url = https://d-org.awsapps.com/start
sso_region = us-west-2

[profile prod]
sso_session = my-org
sso_account_id = 111111111111
sso_role_name = Admin
region = us-west-2
`;
    writeFileSync(join(configDir, ".aws", "config"), configContents);

    const r = (await listTool.handler({})) as {
      ok: boolean;
      data?: { configPath?: string; profiles?: AwsProfile[] };
      error?: string;
    };
    assert.equal(r.ok, true, `expected ok=true, got error: ${r.error}`);
    assert.ok(r.data);
    assert.match(r.data.configPath ?? "", /[/\\]\.aws[/\\]config$/);

    const profiles = r.data.profiles ?? [];
    assert.deepEqual(
      profiles.map((p) => p.name),
      ["default", "staging", "prod"],
    );

    const def = profiles.find((p) => p.name === "default");
    assert.ok(def);
    assert.equal(def.region, "us-east-1");
    assert.equal(def.isSso, false);
    assert.equal(def.ssoStartUrl, undefined);

    const staging = profiles.find((p) => p.name === "staging");
    assert.ok(staging);
    assert.equal(staging.region, "eu-west-1");
    assert.equal(staging.isSso, true);
    assert.equal(staging.ssoStartUrl, "https://d-stg.awsapps.com/start");
    assert.equal(staging.ssoRegion, "eu-west-1");

    const prod = profiles.find((p) => p.name === "prod");
    assert.ok(prod);
    assert.equal(prod.region, "us-west-2");
    assert.equal(prod.isSso, true);
    assert.equal(prod.ssoSession, "my-org");
    // Inherited from [sso-session my-org]
    assert.equal(prod.ssoStartUrl, "https://d-org.awsapps.com/start");
    assert.equal(prod.ssoRegion, "us-west-2");
  });
});

describe("parseAwsConfig -- account / role / managed", () => {
  it("records sso_account_id, sso_role_name and the aws-mcp marker", () => {
    const text = `[sso-session acme]
sso_start_url = https://acme.awsapps.com/start
sso_region = us-east-1

[profile gen]
# managed-by: aws-mcp -- delete this line to take ownership; aws-mcp will then never change this section
sso_session = acme
sso_account_id = 111111111111
sso_role_name = Admin

[profile hand]
sso_session = acme
sso_account_id = 222222222222
sso_role_name = ReadOnly
`;
    const [gen, hand] = parseAwsConfig(text);
    assert.equal(gen.ssoAccountId, "111111111111");
    assert.equal(gen.ssoRoleName, "Admin");
    assert.equal(gen.managed, true);
    assert.equal(gen.ssoStartUrl, "https://acme.awsapps.com/start");
    assert.equal(hand.ssoAccountId, "222222222222");
    assert.equal(hand.managed, undefined, "absent, not false, on a hand-written profile");
  });
});

describe("parseSsoSessions", () => {
  it("returns every sso-session block with its URL, region and ownership", () => {
    const text = `[sso-session  hand]
sso_start_url = https://hand.awsapps.com/start
sso_region = eu-west-1

[profile x]
region = us-east-1

[sso-session gen]
# managed-by: aws-mcp
sso_start_url = https://gen.awsapps.com/start
sso_region = us-east-1
`;
    assert.deepEqual(parseSsoSessions(text), [
      { name: "hand", ssoStartUrl: "https://hand.awsapps.com/start", ssoRegion: "eu-west-1", managed: false },
      { name: "gen", ssoStartUrl: "https://gen.awsapps.com/start", ssoRegion: "us-east-1", managed: true },
    ]);
  });
});
