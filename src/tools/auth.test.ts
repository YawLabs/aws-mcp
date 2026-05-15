import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { _resetSession } from "../session.js";
import { authTools, findCachedSsoToken } from "./auth.js";
import { resolveProfileStartUrl } from "./profiles.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AWS = join(__dirname, "..", "testing", "fake-aws.js");

describe("findCachedSsoToken", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "aws-mcp-test-"));
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("returns null when cache dir is empty", () => {
    assert.equal(findCachedSsoToken(cacheDir), null);
  });

  it("returns null when cache dir does not exist", () => {
    rmSync(cacheDir, { recursive: true, force: true });
    assert.equal(findCachedSsoToken(cacheDir), null);
  });

  it("returns the token when a valid non-expired token file exists", () => {
    const future = new Date(Date.now() + 3600_000).toISOString(); // +1h
    writeFileSync(
      join(cacheDir, "abc123.json"),
      JSON.stringify({
        accessToken: "secret-token",
        expiresAt: future,
        startUrl: "https://d-xxxxxxxxxx.awsapps.com/start",
      }),
    );
    const result = findCachedSsoToken(cacheDir);
    assert.ok(result);
    assert.equal(result.expiresAt, future);
    assert.equal(result.startUrl, "https://d-xxxxxxxxxx.awsapps.com/start");
    assert.ok(result.minutesLeft >= 59 && result.minutesLeft <= 60);
  });

  it("ignores expired tokens", () => {
    const past = new Date(Date.now() - 3600_000).toISOString(); // -1h
    writeFileSync(join(cacheDir, "abc123.json"), JSON.stringify({ accessToken: "secret-token", expiresAt: past }));
    assert.equal(findCachedSsoToken(cacheDir), null);
  });

  it("picks a valid token even if an expired one is also present", () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    const future = new Date(Date.now() + 3600_000).toISOString();
    writeFileSync(join(cacheDir, "expired.json"), JSON.stringify({ accessToken: "old", expiresAt: past }));
    writeFileSync(
      join(cacheDir, "valid.json"),
      JSON.stringify({ accessToken: "new", expiresAt: future, startUrl: "https://x.awsapps.com/start" }),
    );
    const result = findCachedSsoToken(cacheDir);
    assert.ok(result);
    assert.equal(result.startUrl, "https://x.awsapps.com/start");
  });

  it("returns the freshest valid token when several non-expired ones exist", () => {
    // Re-login leaves the previous cache entry in place until it naturally
    // expires. Without sorting we'd return whichever readdirSync surfaced
    // first -- which is FS-defined, not lexicographic. Pin the contract:
    // freshest expiresAt wins, regardless of filename.
    const t1 = new Date(Date.now() + 1 * 3600_000).toISOString(); // +1h
    const t2 = new Date(Date.now() + 2 * 3600_000).toISOString(); // +2h
    const t3 = new Date(Date.now() + 3 * 3600_000).toISOString(); // +3h
    writeFileSync(
      join(cacheDir, "zzz-old.json"),
      JSON.stringify({ accessToken: "a", expiresAt: t1, startUrl: "https://shared.awsapps.com/start" }),
    );
    writeFileSync(
      join(cacheDir, "aaa-newer.json"),
      JSON.stringify({ accessToken: "b", expiresAt: t3, startUrl: "https://shared.awsapps.com/start" }),
    );
    writeFileSync(
      join(cacheDir, "mid.json"),
      JSON.stringify({ accessToken: "c", expiresAt: t2, startUrl: "https://shared.awsapps.com/start" }),
    );
    const result = findCachedSsoToken(cacheDir, { startUrl: "https://shared.awsapps.com/start" });
    assert.ok(result);
    assert.equal(result.expiresAt, t3, "expected the latest expiresAt to win");
  });

  it("ignores malformed JSON files without crashing", () => {
    writeFileSync(join(cacheDir, "broken.json"), "{ not json");
    const future = new Date(Date.now() + 3600_000).toISOString();
    writeFileSync(join(cacheDir, "good.json"), JSON.stringify({ accessToken: "t", expiresAt: future }));
    const result = findCachedSsoToken(cacheDir);
    assert.ok(result);
  });

  it("ignores files that lack required fields", () => {
    writeFileSync(join(cacheDir, "partial.json"), JSON.stringify({ accessToken: "t" }));
    assert.equal(findCachedSsoToken(cacheDir), null);
  });

  it("skips non-json files in the cache directory", () => {
    writeFileSync(join(cacheDir, "ignore-me.txt"), "not a token");
    mkdirSync(join(cacheDir, "subdir"));
    assert.equal(findCachedSsoToken(cacheDir), null);
  });

  it("skips .json files larger than the cap without blocking", () => {
    // A pathological oversized file should not be parsed. Real tokens are a
    // few KB; the cap is 64 KB. Write 128 KB and expect it ignored.
    writeFileSync(join(cacheDir, "huge.json"), "x".repeat(128 * 1024));
    const future = new Date(Date.now() + 3600_000).toISOString();
    writeFileSync(join(cacheDir, "good.json"), JSON.stringify({ accessToken: "t", expiresAt: future }));
    const result = findCachedSsoToken(cacheDir);
    assert.ok(result, "small valid token should still be found");
    assert.equal(result.expiresAt, future);
  });

  it("filters by startUrl when supplied (multi-org cache hygiene)", () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    writeFileSync(
      join(cacheDir, "org-a.json"),
      JSON.stringify({ accessToken: "a", expiresAt: future, startUrl: "https://org-a.awsapps.com/start" }),
    );
    writeFileSync(
      join(cacheDir, "org-b.json"),
      JSON.stringify({ accessToken: "b", expiresAt: future, startUrl: "https://org-b.awsapps.com/start" }),
    );
    const matchA = findCachedSsoToken(cacheDir, { startUrl: "https://org-a.awsapps.com/start" });
    assert.ok(matchA);
    assert.equal(matchA.startUrl, "https://org-a.awsapps.com/start");

    const matchB = findCachedSsoToken(cacheDir, { startUrl: "https://org-b.awsapps.com/start" });
    assert.ok(matchB);
    assert.equal(matchB.startUrl, "https://org-b.awsapps.com/start");

    // A startUrl with no matching cache file returns null even though other
    // valid tokens are present — prevents the multi-org misread.
    assert.equal(findCachedSsoToken(cacheDir, { startUrl: "https://nobody.awsapps.com/start" }), null);
  });
});

describe("aws_whoami handler — error path consistency with aws_call (fake-aws)", () => {
  const tool = authTools.find((t) => t.name === "aws_whoami");
  if (!tool) throw new Error("aws_whoami not registered");

  beforeEach(() => {
    process.env.AWS_MCP_TEST_AWS_COMMAND = process.execPath;
    process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS = JSON.stringify([FAKE_AWS]);
    _resetSession();
  });

  afterEach(() => {
    delete process.env.AWS_MCP_TEST_AWS_COMMAND;
    delete process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS;
    delete process.env.AWS_MCP_FAKE_SCENARIO;
    _resetSession();
  });

  it("returns the parsed identity on a successful sts get-caller-identity", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "sts_caller_identity_success";
    const r = (await tool.handler({ profile: "tester", region: "us-east-1" })) as {
      ok: boolean;
      data?: { account?: string; userId?: string; arn?: string; profile?: string; region?: string };
    };
    assert.equal(r.ok, true);
    assert.equal(r.data?.account, "123456789012");
    assert.equal(r.data?.userId, "AIDA1234EXAMPLE");
    assert.equal(r.data?.arn, "arn:aws:iam::123456789012:user/Alice");
    assert.equal(r.data?.profile, "tester");
    assert.equal(r.data?.region, "us-east-1");
  });

  it("surfaces the same SSO expiry hint that aws_call surfaces (consistency invariant)", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "call_sso_expired";
    const r = (await tool.handler({ profile: "tester" })) as { ok: boolean; error?: string };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /SSO session expired/);
    assert.match(r.error ?? "", /tester/);
    assert.match(r.error ?? "", /aws_login_start/);
  });

  it("surfaces the same no-creds hint that aws_call surfaces", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "call_no_creds";
    const r = (await tool.handler({ profile: "tester" })) as { ok: boolean; error?: string };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /No credentials found/);
    assert.match(r.error ?? "", /tester/);
  });
});

describe("startUrlForProfile unknown-profile fallback", () => {
  // startUrlForProfile (auth.ts:78-84) is internal: it reads ~/.aws/config and
  // delegates to resolveProfileStartUrl, mapping null -> undefined. When the
  // config is readable but doesn't contain the requested profile, callers see
  // `undefined`, and findCachedSsoToken({ startUrl: undefined }) degrades to
  // the legacy "any valid token" behavior. A regression returning a stale
  // string or throwing here would silently misfilter the SSO token cache.

  let configDir: string;
  let cacheDir: string;
  let homeBackup: string | undefined;
  let userprofileBackup: string | undefined;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "aws-mcp-auth-cfg-"));
    cacheDir = mkdtempSync(join(tmpdir(), "aws-mcp-auth-cache-"));
    homeBackup = process.env.HOME;
    userprofileBackup = process.env.USERPROFILE;
    process.env.HOME = configDir;
    process.env.USERPROFILE = configDir;
  });

  afterEach(() => {
    if (homeBackup === undefined) delete process.env.HOME;
    else process.env.HOME = homeBackup;
    if (userprofileBackup === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = userprofileBackup;
    rmSync(configDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("resolveProfileStartUrl returns null for an unknown profile (input to the '?? undefined' map)", () => {
    // The startUrlForProfile wrap is `resolveProfileStartUrl(text, profile) ?? undefined`.
    // Pin the null contract here -- the wrap relies on it to surface undefined,
    // which findCachedSsoToken treats as "no filter".
    const text = `
[profile alpha]
sso_start_url = https://alpha.awsapps.com/start

[profile beta]
region = us-east-1
`;
    assert.equal(resolveProfileStartUrl(text, "no-such-profile"), null);
  });

  it("findCachedSsoToken with startUrl=undefined falls back to legacy 'any valid token' behavior without throwing", () => {
    // This is the downstream half of the unknown-profile path: when
    // startUrlForProfile returns undefined, findCachedSsoToken is invoked with
    // { startUrl: undefined } and must not throw -- it should ignore the
    // filter and return any valid non-expired token in the cache.
    const future = new Date(Date.now() + 3600_000).toISOString();
    writeFileSync(
      join(cacheDir, "tok.json"),
      JSON.stringify({
        accessToken: "t",
        expiresAt: future,
        startUrl: "https://some-org.awsapps.com/start",
      }),
    );

    // Explicit undefined: this is what the auth.ts:160 / :278 / :318 call
    // sites pass when startUrlForProfile returns undefined. The call must
    // neither throw nor return null -- it should ignore the absent filter
    // and surface the cached token.
    const result = findCachedSsoToken(cacheDir, { startUrl: undefined });
    assert.ok(result, "findCachedSsoToken should not return null when a valid token is present");
    assert.equal(result.expiresAt, future);
  });
});

describe("aws_refresh_if_expiring_soon schema", () => {
  const tool = authTools.find((t) => t.name === "aws_refresh_if_expiring_soon");
  if (!tool) throw new Error("aws_refresh_if_expiring_soon not registered");

  it("accepts an empty object (all defaults)", () => {
    assert.equal(tool.inputSchema.safeParse({}).success, true);
  });

  it("accepts thresholdMinutes and profile", () => {
    assert.equal(tool.inputSchema.safeParse({ thresholdMinutes: 15, profile: "prod" }).success, true);
  });

  it("rejects zero or negative thresholdMinutes", () => {
    assert.equal(tool.inputSchema.safeParse({ thresholdMinutes: 0 }).success, false);
    assert.equal(tool.inputSchema.safeParse({ thresholdMinutes: -5 }).success, false);
  });

  it("rejects non-integer thresholdMinutes", () => {
    assert.equal(tool.inputSchema.safeParse({ thresholdMinutes: 5.5 }).success, false);
  });
});
