import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { _resetSession } from "../session.js";
import { _clearSessions, findActiveSessionByProfile, startSsoLogin } from "../sso.js";
import { _resetStartSsoLoginImpl, _setStartSsoLoginImpl, authTools, findCachedSsoToken } from "./auth.js";
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
  // startUrlForProfile (auth.ts:115-122) is internal: it reads ~/.aws/config and
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

    // Explicit undefined: this is what the auth.ts:203, :315, :355 call
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

describe("aws_login_start handler — reuse vs fresh-spawn (auth.ts:195-236)", () => {
  const startTool = authTools.find((t) => t.name === "aws_login_start");
  if (!startTool) throw new Error("aws_login_start not registered");

  // The reuse branch only depends on findActiveSessionByProfile returning a
  // live session for the requested profile. We seed that by calling
  // startSsoLogin directly with the fake-aws shim (the handler itself calls
  // bare startSsoLogin(useProfile) with no opts, so the FRESH path can't be
  // routed at the fake — see the gated block below). The 'happy' fake emits
  // URL+code immediately and stays alive ~200ms before exiting, leaving a
  // window where the session is registered and not yet completed.
  function fakeOpts(scenario: string, urlWaitMs = 5000) {
    return {
      command: process.execPath,
      prefixArgs: [FAKE_AWS],
      urlWaitMs,
      // Stretch the session TTL well past the test so the killswitch never
      // races us; we tear sessions down explicitly in afterEach.
      sessionTtlMs: 60_000,
      env: { ...process.env, AWS_MCP_FAKE_SCENARIO: scenario },
    };
  }

  beforeEach(() => {
    _resetSession();
    _clearSessions();
  });

  afterEach(() => {
    _clearSessions();
    _resetSession();
    // Restore the production startSsoLogin call so the fresh-spawn seam set by
    // the fresh-spawn test below can't bleed into any other test.
    _resetStartSsoLoginImpl();
  });

  it("reuses an in-flight login instead of spawning a second subprocess", async () => {
    // Seed a live session for 'reuse-prof'. startSsoLogin returns once URL+code
    // are parsed; the subprocess is still alive at that instant.
    const seed = await startSsoLogin("reuse-prof", fakeOpts("happy"));
    assert.equal(seed.ok, true);
    if (!seed.ok) return;

    // Sanity: the session is discoverable while the subprocess is alive.
    assert.ok(findActiveSessionByProfile("reuse-prof"), "expected a live session to seed the reuse branch");

    const r = (await startTool.handler({ profile: "reuse-prof" })) as {
      ok: boolean;
      data?: {
        sessionId?: string;
        profile?: string;
        verificationUrl?: string;
        userCode?: string;
        reused?: boolean;
        instructions?: string;
      };
    };
    assert.equal(r.ok, true);
    // The defining marker of the reuse branch.
    assert.equal(r.data?.reused, true);
    // It hands back the EXISTING session's identifiers, not a fresh spawn's.
    assert.equal(r.data?.sessionId, seed.sessionId);
    assert.equal(r.data?.profile, "reuse-prof");
    assert.equal(r.data?.verificationUrl, seed.verificationUrl);
    assert.equal(r.data?.userCode, seed.userCode);
    assert.match(r.data?.instructions ?? "", /already in progress/);
    assert.match(r.data?.instructions ?? "", new RegExp(seed.sessionId));
  });

  it("does not cross profiles: a session for one profile is not reused for another", async () => {
    const seed = await startSsoLogin("prof-a", fakeOpts("happy"));
    assert.equal(seed.ok, true);
    if (!seed.ok) return;
    // prof-b has no in-flight session -> findActiveSessionByProfile returns
    // null -> the reuse branch must NOT fire for prof-b. (We assert the
    // negative observable here without spawning prof-b's real login: the
    // helper that gates the branch reports no active session for prof-b.)
    assert.equal(findActiveSessionByProfile("prof-b"), null);
  });

  it("reuse path is not taken once the seeded session has completed", async () => {
    // The 'happy' fake exits ~200ms after URL+code, which flips the session to
    // completed. findActiveSessionByProfile excludes completed sessions, so the
    // handler's reuse guard (active === null) would fall through to a fresh
    // spawn. Assert the guard input directly to avoid spawning the real binary.
    const seed = await startSsoLogin("expire-prof", fakeOpts("happy"));
    assert.equal(seed.ok, true);
    if (!seed.ok) return;
    assert.ok(findActiveSessionByProfile("expire-prof"), "live immediately after start");
    // Wait past the fake's ~200ms exit so the session is marked completed.
    await new Promise<void>((resolve) => setTimeout(resolve, 400));
    assert.equal(
      findActiveSessionByProfile("expire-prof"),
      null,
      "a completed session must not be reused — handler would spawn fresh",
    );
  });

  // --- Fresh-spawn branch (no active session -> handler calls startSsoLogin) ---
  //
  // The handler invokes its start call through the `_startSsoLoginImpl` seam
  // (auth.ts), which in production is bare `startSsoLogin(useProfile)`. Tests
  // inject an implementation that supplies the fake-aws shim opts so the
  // fresh-spawn path runs against the controlled fake instead of live AWS SSO
  // endpoints. The seam is restored in afterEach (_resetStartSsoLoginImpl) so
  // prod behavior is identical when no override is set, and the override can't
  // bleed across tests. This replaces the previously-gated AWS_MCP_LIVE_SSO
  // test, which never ran in CI.
  it("fresh spawn: with no active session the handler drives startSsoLogin and returns a NEW session without the reused flag", async () => {
    // Inject the fake-aws-backed start. The 'happy' scenario emits URL+code
    // immediately; sessionTtlMs is stretched so the killswitch never races us
    // (afterEach's _clearSessions tears the subprocess down).
    _setStartSsoLoginImpl((profile) => startSsoLogin(profile, fakeOpts("happy")));

    // Precondition: no in-flight session, so the handler must NOT take the
    // reuse branch and instead fall through to the fresh-spawn call.
    assert.equal(findActiveSessionByProfile("fresh-prof"), null, "precondition: no in-flight session for the profile");

    const r = (await startTool.handler({ profile: "fresh-prof" })) as {
      ok: boolean;
      error?: string;
      data?: { sessionId?: string; profile?: string; reused?: boolean; verificationUrl?: string; userCode?: string };
    };

    assert.equal(r.ok, true);
    // The defining markers of the fresh-spawn branch: a started session with
    // verificationUrl/userCode/sessionId and NO reuse marker.
    assert.equal(r.data?.reused, undefined, "fresh spawn must not carry the reuse marker");
    assert.ok(r.data?.sessionId, "fresh spawn returns a sessionId");
    assert.match(r.data?.sessionId ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(r.data?.profile, "fresh-prof");
    assert.equal(r.data?.verificationUrl, "https://device.sso.us-east-1.amazonaws.com/");
    assert.equal(r.data?.userCode, "ABCD-EFGH");
  });

  it("fresh spawn: surfaces the start error when the injected start fails", async () => {
    // Drive the fresh-spawn branch's failure path: the injected start resolves
    // ok:false (the fake never prints a URL within urlWaitMs), and the handler
    // must propagate it as ok:false with the error + rawBody.
    _setStartSsoLoginImpl((profile) => startSsoLogin(profile, fakeOpts("malformed", 300)));

    assert.equal(findActiveSessionByProfile("fresh-fail-prof"), null, "precondition: no in-flight session");

    const r = (await startTool.handler({ profile: "fresh-fail-prof" })) as { ok: boolean; error?: string };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Timed out|exited before printing/);
  });
});

describe("aws_login_complete handler (auth.ts:294-328)", () => {
  const completeTool = authTools.find((t) => t.name === "aws_login_complete");
  if (!completeTool) throw new Error("aws_login_complete not registered");

  // The seed subprocess scenario is carried in its OWN env (fakeOpts.env), so it
  // is independent of process.env.AWS_MCP_FAKE_SCENARIO — which drives the
  // SEPARATE getCallerIdentity runAwsCall the handler makes after waitForLogin
  // resolves ok. That lets one test seed a `happy` SSO subprocess while pointing
  // the post-login identity check at a different fake scenario.
  function fakeOpts(scenario: string, urlWaitMs = 5000) {
    return {
      command: process.execPath,
      prefixArgs: [FAKE_AWS],
      urlWaitMs,
      // Stretch the session TTL well past the test so the killswitch never
      // races the natural exit; sessions are torn down in afterEach.
      sessionTtlMs: 60_000,
      env: { ...process.env, AWS_MCP_FAKE_SCENARIO: scenario },
    };
  }

  // HOME/USERPROFILE override seam: getCallerIdentity routes through runAwsCall
  // (driven by AWS_MCP_TEST_AWS_COMMAND + AWS_MCP_FAKE_SCENARIO), and the
  // ssoToken comes from findCachedSsoToken/startUrlForProfile reading
  // ~/.aws/config + ~/.aws/sso/cache under homedir(). Point homedir() at a
  // tmpdir so both reads are hermetic.
  let homeDir: string;
  let homeBackup: string | undefined;
  let userprofileBackup: string | undefined;

  beforeEach(() => {
    _resetSession();
    _clearSessions();
    process.env.AWS_MCP_TEST_AWS_COMMAND = process.execPath;
    process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS = JSON.stringify([FAKE_AWS]);
    homeDir = mkdtempSync(join(tmpdir(), "aws-mcp-login-complete-"));
    homeBackup = process.env.HOME;
    userprofileBackup = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
  });

  afterEach(() => {
    _clearSessions();
    _resetSession();
    delete process.env.AWS_MCP_TEST_AWS_COMMAND;
    delete process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS;
    delete process.env.AWS_MCP_FAKE_SCENARIO;
    if (homeBackup === undefined) delete process.env.HOME;
    else process.env.HOME = homeBackup;
    if (userprofileBackup === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = userprofileBackup;
    rmSync(homeDir, { recursive: true, force: true });
  });

  /**
   * Seed an active SSO login session and return its sessionId. Uses the same
   * fake-aws shim the rest of the suite uses; the `scenario` controls how the
   * seeded subprocess behaves (e.g. `happy` exits 0 after ~200ms, so
   * waitForLogin will resolve ok:true; `early_exit_failure` exits 1, so
   * waitForLogin resolves ok:false).
   */
  async function seedSession(profile: string, scenario: string): Promise<string> {
    const seed = await startSsoLogin(profile, fakeOpts(scenario));
    assert.equal(seed.ok, true);
    if (!seed.ok) throw new Error("seed login did not start");
    return seed.sessionId;
  }

  /** Write ~/.aws/config (under the HOME override) with an SSO-backed profile. */
  function writeConfig(profile: string, startUrl: string): void {
    const dir = join(homeDir, ".aws");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "config"),
      `[profile ${profile}]\nsso_start_url = ${startUrl}\nsso_region = us-east-1\nregion = us-east-1\n`,
    );
  }

  /** Write a far-future SSO cache token (under the HOME override) for startUrl. */
  function writeCachedToken(startUrl: string): string {
    const cacheDir = join(homeDir, ".aws", "sso", "cache");
    mkdirSync(cacheDir, { recursive: true });
    const expiresAt = new Date(Date.now() + 8 * 3600_000).toISOString(); // +8h
    writeFileSync(join(cacheDir, "token.json"), JSON.stringify({ accessToken: "secret", expiresAt, startUrl }));
    return expiresAt;
  }

  it("surfaces the wait error + rawBody when waitForLogin returns ok:false", async () => {
    // `early_exit_failure` emits URL+code (so the session registers and
    // startSsoLogin returns ok), then writes stderr and exits 1. waitForLogin
    // therefore resolves ok:false with error "aws sso login exited with code 1:
    // Error: connection refused" and a rawOutput body. The handler returns that
    // error (the literal `aws sso login exited with code <exitCode>` fallback at
    // auth.ts:300 only fires when waitResult.error is undefined; here a concrete
    // error is present) plus rawBody. The post-login identity check is never
    // reached on this path.
    const sessionId = await seedSession("fail-prof", "early_exit_failure");
    const r = (await completeTool.handler({ sessionId, profile: "fail-prof" })) as {
      ok: boolean;
      error?: string;
      rawBody?: string;
    };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /exited with code 1/);
    assert.equal(typeof r.rawBody, "string");
    assert.ok((r.rawBody ?? "").length > 0, "expected the subprocess rawOutput to be surfaced as rawBody");
  });

  it("returns the identity-check-failed shape when login succeeds but get-caller-identity fails", async () => {
    // Seed a `happy` session: it exits 0 after ~200ms, so waitForLogin resolves
    // ok:true and the handler proceeds to getCallerIdentity. Point THAT call
    // (runAwsCall via process.env.AWS_MCP_FAKE_SCENARIO) at the sso-expired
    // failure. The handler must prefix the surfaced error with
    // "Login subprocess succeeded but identity check failed:" and pass through
    // the failure's rawBody.
    const sessionId = await seedSession("idfail-prof", "happy");
    process.env.AWS_MCP_FAKE_SCENARIO = "call_sso_expired";
    const r = (await completeTool.handler({ sessionId, profile: "idfail-prof", region: "us-east-1" })) as {
      ok: boolean;
      error?: string;
      rawBody?: string;
    };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /^Login subprocess succeeded but identity check failed: /);
    // The wrapped identity error is the same SSO-expiry hint aws_call surfaces.
    assert.match(r.error ?? "", /SSO session expired/);
    assert.equal(typeof r.rawBody, "string");
  });

  it("returns loggedIn + identity + profile/region + projected ssoToken on full success", async () => {
    // waitForLogin ok (happy exits 0) -> getCallerIdentity ok
    // (sts_caller_identity_success) -> findCachedSsoToken reads the HOME-override
    // cache, filtered by the profile's sso_start_url from the HOME-override
    // config. The emitted ssoToken is the projectSsoToken shape:
    // { expiresAt, minutesLeft, startUrl }.
    const startUrl = "https://full-success.awsapps.com/start";
    writeConfig("ok-prof", startUrl);
    const expiresAt = writeCachedToken(startUrl);

    const sessionId = await seedSession("ok-prof", "happy");
    process.env.AWS_MCP_FAKE_SCENARIO = "sts_caller_identity_success";
    const r = (await completeTool.handler({ sessionId, profile: "ok-prof", region: "eu-west-1" })) as {
      ok: boolean;
      data?: {
        loggedIn?: boolean;
        account?: string;
        userId?: string;
        arn?: string;
        profile?: string;
        region?: string;
        ssoToken?: { expiresAt?: string; minutesLeft?: number; startUrl?: string } | null;
      };
    };
    assert.equal(r.ok, true);
    assert.equal(r.data?.loggedIn, true);
    // Identity from the sts_caller_identity_success fake.
    assert.equal(r.data?.account, "123456789012");
    assert.equal(r.data?.userId, "AIDA1234EXAMPLE");
    assert.equal(r.data?.arn, "arn:aws:iam::123456789012:user/Alice");
    // The explicitly-passed profile/region echo back.
    assert.equal(r.data?.profile, "ok-prof");
    assert.equal(r.data?.region, "eu-west-1");
    // projectSsoToken shape: expiresAt + minutesLeft + startUrl, filtered to
    // the profile's start URL.
    assert.ok(r.data?.ssoToken, "expected a projected ssoToken on full success");
    assert.equal(r.data?.ssoToken?.expiresAt, expiresAt);
    assert.equal(r.data?.ssoToken?.startUrl, startUrl);
    assert.ok(
      (r.data?.ssoToken?.minutesLeft ?? 0) >= 470 && (r.data?.ssoToken?.minutesLeft ?? 0) <= 480,
      "minutesLeft should reflect the ~8h-out cached token",
    );
  });
});

describe("aws_refresh_if_expiring_soon handler (auth.ts:350-407)", () => {
  const refreshTool = authTools.find((t) => t.name === "aws_refresh_if_expiring_soon");
  if (!refreshTool) throw new Error("aws_refresh_if_expiring_soon not registered");

  // Seed-session opts: the handler's reuse branch (auth.ts:372) keys off
  // findActiveSessionByProfile, which we populate by calling startSsoLogin with
  // the fake-aws shim directly. `happy_hold` stays alive until killed so the
  // session's `completed` flag stays false deterministically (mirrors the
  // sso.integration.test.ts dedupe-helper test).
  function fakeOpts(scenario: string, urlWaitMs = 5000) {
    return {
      command: process.execPath,
      prefixArgs: [FAKE_AWS],
      urlWaitMs,
      sessionTtlMs: 60_000,
      env: { ...process.env, AWS_MCP_FAKE_SCENARIO: scenario },
    };
  }

  // HOME/USERPROFILE override so findCachedSsoToken + startUrlForProfile read a
  // hermetic ~/.aws under a tmpdir instead of the real user home.
  let homeDir: string;
  let homeBackup: string | undefined;
  let userprofileBackup: string | undefined;

  beforeEach(() => {
    _resetSession();
    _clearSessions();
    homeDir = mkdtempSync(join(tmpdir(), "aws-mcp-refresh-"));
    homeBackup = process.env.HOME;
    userprofileBackup = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
  });

  afterEach(() => {
    _clearSessions();
    _resetSession();
    // Restore the production startSsoLogin call so the fresh-spawn seam set by
    // the fresh-spawn tests below can't bleed into any other test.
    _resetStartSsoLoginImpl();
    if (homeBackup === undefined) delete process.env.HOME;
    else process.env.HOME = homeBackup;
    if (userprofileBackup === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = userprofileBackup;
    rmSync(homeDir, { recursive: true, force: true });
  });

  function writeConfig(profile: string, startUrl: string): void {
    const dir = join(homeDir, ".aws");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config"), `[profile ${profile}]\nsso_start_url = ${startUrl}\nsso_region = us-east-1\n`);
  }

  function writeCachedToken(startUrl: string, msFromNow: number): string {
    const cacheDir = join(homeDir, ".aws", "sso", "cache");
    mkdirSync(cacheDir, { recursive: true });
    const expiresAt = new Date(Date.now() + msFromNow).toISOString();
    writeFileSync(join(cacheDir, "token.json"), JSON.stringify({ accessToken: "secret", expiresAt, startUrl }));
    return expiresAt;
  }

  it("status:'ok' with no spawn when the cached token has >= threshold minutes left", async () => {
    // Far-future token (8h out) is well past the default 10-min threshold, so
    // the handler returns the ok branch (auth.ts:357-366) WITHOUT consulting
    // findActiveSessionByProfile or spawning a login. No AWS_MCP_TEST_AWS_*
    // env is set, so a regression that tried to spawn would surface as a real
    // 'aws' invocation, not a silent pass.
    const startUrl = "https://plenty.awsapps.com/start";
    writeConfig("ok-prof", startUrl);
    const expiresAt = writeCachedToken(startUrl, 8 * 3600_000);

    const r = (await refreshTool.handler({ profile: "ok-prof" })) as {
      ok: boolean;
      data?: { status?: string; minutesLeft?: number; expiresAt?: string; profile?: string; reused?: boolean };
    };
    assert.equal(r.ok, true);
    assert.equal(r.data?.status, "ok");
    assert.equal(r.data?.expiresAt, expiresAt);
    assert.equal(r.data?.profile, "ok-prof");
    assert.equal(r.data?.reused, undefined, "the ok branch must not carry a reuse marker");
    assert.ok((r.data?.minutesLeft ?? 0) >= 470, "minutesLeft should reflect the ~8h-out token");
  });

  it("status:'refreshing' reused:true with the existing session's URL+code when a login is already in flight", async () => {
    // Token below threshold (set a high threshold so even a fresh-ish token
    // trips it), AND an active session exists for the profile -> the reuse
    // branch (auth.ts:372-387) fires: status 'refreshing', reused true, and the
    // EXISTING session's identifiers, not a fresh spawn's.
    const startUrl = "https://reuse.awsapps.com/start";
    writeConfig("reuse-prof", startUrl);
    // Token with ~5 min left, threshold 30 -> below threshold.
    writeCachedToken(startUrl, 5 * 60_000);

    const seed = await startSsoLogin("reuse-prof", fakeOpts("happy_hold"));
    assert.equal(seed.ok, true);
    if (!seed.ok) return;
    assert.ok(findActiveSessionByProfile("reuse-prof"), "expected a live session to seed the reuse branch");

    const r = (await refreshTool.handler({ profile: "reuse-prof", thresholdMinutes: 30 })) as {
      ok: boolean;
      data?: {
        status?: string;
        reused?: boolean;
        sessionId?: string;
        profile?: string;
        verificationUrl?: string;
        userCode?: string;
        reason?: string;
        instructions?: string;
      };
    };
    assert.equal(r.ok, true);
    assert.equal(r.data?.status, "refreshing");
    assert.equal(r.data?.reused, true);
    assert.equal(r.data?.sessionId, seed.sessionId);
    assert.equal(r.data?.profile, "reuse-prof");
    assert.equal(r.data?.verificationUrl, seed.verificationUrl);
    assert.equal(r.data?.userCode, seed.userCode);
    assert.match(r.data?.reason ?? "", /already in progress/);
    assert.match(r.data?.instructions ?? "", new RegExp(seed.sessionId));
  });

  it("fresh spawn: no cached token -> handler drives startSsoLogin and returns status:'refreshing' without reused flag", async () => {
    // No cached token under HOME override -> findCachedSsoToken returns null
    // (below threshold by definition). No in-flight session -> reuse branch
    // not taken. Handler falls through to the fresh-spawn call via the
    // _startSsoLoginImpl seam. Assert status='refreshing', no reused flag,
    // sessionId present, and reason = "No cached SSO token found."
    writeConfig("nocache-prof", "https://nocache.awsapps.com/start");
    // No cache token written -> findCachedSsoToken returns null.
    assert.equal(findCachedSsoToken(join(homeDir, ".aws", "sso", "cache")), null, "precondition: no cached token");
    assert.equal(findActiveSessionByProfile("nocache-prof"), null, "precondition: no in-flight session");

    _setStartSsoLoginImpl((profile) => startSsoLogin(profile, fakeOpts("happy")));

    const r = (await refreshTool.handler({ profile: "nocache-prof" })) as {
      ok: boolean;
      data?: {
        status?: string;
        reason?: string;
        sessionId?: string;
        reused?: boolean;
        verificationUrl?: string;
        userCode?: string;
      };
    };
    assert.equal(r.ok, true);
    assert.equal(r.data?.status, "refreshing");
    assert.equal(r.data?.reused, undefined, "fresh spawn must not carry the reuse marker");
    assert.ok(r.data?.sessionId, "fresh spawn returns a sessionId");
    assert.match(r.data?.sessionId ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(r.data?.reason, "No cached SSO token found.");
  });

  it("fresh spawn: cached token below threshold -> handler drives startSsoLogin, reason names minutes+threshold", async () => {
    // Token with ~3 min left, threshold 10 -> below threshold. No in-flight
    // session -> reuse branch not taken. Handler falls through to the
    // fresh-spawn call. Assert status='refreshing', no reused flag, sessionId
    // present, and reason = "Token has <n> min left (threshold 10)."
    const startUrl = "https://below.awsapps.com/start";
    writeConfig("below-prof", startUrl);
    writeCachedToken(startUrl, 3 * 60_000); // ~3 min left

    const cached = findCachedSsoToken(join(homeDir, ".aws", "sso", "cache"), { startUrl });
    assert.ok(cached, "precondition: a non-null cached token below the threshold");
    assert.ok(cached.minutesLeft < 10, "precondition: token is below default threshold");
    assert.equal(findActiveSessionByProfile("below-prof"), null, "precondition: no in-flight session");

    _setStartSsoLoginImpl((profile) => startSsoLogin(profile, fakeOpts("happy")));

    const r = (await refreshTool.handler({ profile: "below-prof", thresholdMinutes: 10 })) as {
      ok: boolean;
      data?: {
        status?: string;
        reason?: string;
        sessionId?: string;
        reused?: boolean;
      };
    };
    assert.equal(r.ok, true);
    assert.equal(r.data?.status, "refreshing");
    assert.equal(r.data?.reused, undefined, "fresh spawn must not carry the reuse marker");
    assert.ok(r.data?.sessionId, "fresh spawn returns a sessionId");
    assert.match(r.data?.reason ?? "", /^Token has \d+ min left \(threshold 10\)\.$/);
  });
});
