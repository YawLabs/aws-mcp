/**
 * End-to-end tests for the IAM Identity Center bootstrap: aws_login_start /
 * aws_login_complete with `ssoSession`, aws_sso_list_assignments and
 * aws_sso_generate_profiles, all driven through the real handlers against the
 * fake CLI (src/testing/fake-aws.ts, scenarios sso_session_login and sso_list*).
 *
 * Every test runs with HOME / USERPROFILE on one mkdtemp directory and
 * AWS_CONFIG_FILE on a SEPARATE one, so a write that went to ~/.aws/config
 * instead of the configured file is visible -- and with AWS_PROFILE pointing at
 * a profile that does not exist, which the fake turns into exit 3 if it ever
 * reaches a child. Every tool result is collected and checked in afterEach for
 * the fake's bearer token: it must appear in no result, success or failure.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { EMPTY_CONFIG_FILE_ERROR } from "../aws-paths.js";
import { _resetSession } from "../session.js";
import { _clearCliVersionCache, _clearSessions, startSsoLogin } from "../sso.js";
import { MANAGED_MARKER } from "../sso-config.js";
import { _resetStartSsoLoginImpl, _setStartSsoLoginImpl, authTools } from "./auth.js";
import { profilesTools } from "./profiles.js";
import { ssoSetupTools } from "./sso-setup.js";
import type { ToolResult } from "./tool.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AWS = join(__dirname, "..", "testing", "fake-aws.js");
// Mirrors FAKE_SSO_TOKEN in fake-aws.ts (not imported: importing the fake would run it).
const SENTINEL = "FAKE-SSO-TOKEN-7f3c9a-DO-NOT-LEAK";
const START = "https://acme.awsapps.com/start";
// Tool results are untyped JSON here; one loose alias keeps the assertions readable.
// biome-ignore lint/suspicious/noExplicitAny: test-only view of untyped tool output.
type Json = any;

const tool = (name: string) => {
  const t = [...authTools, ...ssoSetupTools, ...profilesTools].find((x) => x.name === name);
  if (!t) throw new Error(`${name} not registered`);
  return t;
};

const ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "AWS_CONFIG_FILE",
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_MCP_TEST_AWS_COMMAND",
  "AWS_MCP_TEST_AWS_PREFIX_ARGS",
  "AWS_MCP_FAKE_SCENARIO",
  "AWS_MCP_FAKE_CALLS_OUT",
  "AWS_MCP_FAKE_CLI_VERSION",
  "AWS_MCP_FAKE_RELEASE_FILE",
  "AWS_MCP_FAKE_SSO_TOKEN",
] as const;

describe("IAM Identity Center bootstrap (fake-aws)", () => {
  let home: string;
  let cfgDir: string;
  let configPath: string;
  let callsPath: string;
  let saved: Record<string, string | undefined>;
  let results: unknown[];

  async function call(name: string, input: unknown): Promise<ToolResult & { data?: Json }> {
    const r = await tool(name).handler(input);
    results.push(r);
    return r as ToolResult & { data?: Json };
  }

  function calls(): string[][] {
    return existsSync(callsPath)
      ? readFileSync(callsPath, "utf-8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as string[])
      : [];
  }

  /** The managed block + a token in the cache, without a login round-trip. */
  function seedSession(opts: { token?: string; expiresAt?: string; extraConfig?: string } = {}): void {
    writeFileSync(
      configPath,
      `[sso-session acme]\n${MANAGED_MARKER}\nsso_start_url = ${START}\nsso_region = us-east-1\nsso_registration_scopes = sso:account:access\n${opts.extraConfig ?? ""}`,
    );
    const cache = join(home, ".aws", "sso", "cache");
    mkdirSync(cache, { recursive: true });
    writeFileSync(
      join(cache, `${createHash("sha1").update("acme").digest("hex")}.json`),
      JSON.stringify({
        startUrl: START,
        region: "us-east-1",
        accessToken: opts.token ?? SENTINEL,
        expiresAt: opts.expiresAt ?? new Date(Date.now() + 8 * 3600_000).toISOString(),
      }),
    );
  }

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    results = [];
    home = mkdtempSync(join(tmpdir(), "aws-mcp-ssoboot-home-"));
    cfgDir = mkdtempSync(join(tmpdir(), "aws-mcp-ssoboot-cfg-"));
    configPath = join(cfgDir, "config");
    callsPath = join(home, "calls.jsonl");
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.AWS_CONFIG_FILE = configPath;
    // Inherited from an operator shell and naming nothing: every child that
    // sees it fails (fake exit 3), so its absence from every child is proven
    // by every test below succeeding.
    process.env.AWS_PROFILE = "does-not-exist";
    delete process.env.AWS_DEFAULT_PROFILE;
    delete process.env.AWS_MCP_FAKE_CLI_VERSION;
    process.env.AWS_MCP_TEST_AWS_COMMAND = process.execPath;
    process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS = JSON.stringify([FAKE_AWS]);
    process.env.AWS_MCP_FAKE_SCENARIO = "sso_list";
    process.env.AWS_MCP_FAKE_CALLS_OUT = callsPath;
    _resetSession();
    _clearSessions();
    _setStartSsoLoginImpl((target, extra) =>
      startSsoLogin(target, {
        command: process.execPath,
        prefixArgs: [FAKE_AWS],
        urlWaitMs: 20_000,
        sessionTtlMs: 60_000,
        versionProbeTimeoutMs: 30_000,
        // The handler's env (profile selectors stripped) is what must reach the
        // child; only the scenario is layered on.
        env: { ...(extra?.env ?? process.env), AWS_MCP_FAKE_SCENARIO: "sso_session_login" },
        dedupeTag: extra?.dedupeTag,
      }),
    );
  });

  afterEach(() => {
    _clearSessions();
    _resetSession();
    _resetStartSsoLoginImpl();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(cfgDir, { recursive: true, force: true });
    // The leak check, over every result this test produced.
    const blob = JSON.stringify(results);
    assert.ok(!blob.includes(SENTINEL), "the IAM Identity Center bearer token leaked into a tool result");
  });

  // ---------------------------------------------------------------------
  // Login
  // ---------------------------------------------------------------------

  it("bootstraps on an empty HOME: block written to AWS_CONFIG_FILE, device code, no STS on complete", async () => {
    const start = await call("aws_login_start", { ssoSession: "acme", startUrl: START, ssoRegion: "us-east-1" });
    assert.equal(start.ok, true, start.error ?? "");
    assert.equal(start.data.sessionBlock, "created");
    assert.equal(start.data.ssoSession, "acme");
    assert.equal(start.data.startUrl, START);
    assert.equal(start.data.configPath, configPath);
    assert.equal(start.data.userCode, "ABCD-EFGH");
    assert.equal(
      readFileSync(configPath, "utf-8"),
      `[sso-session acme]\n${MANAGED_MARKER}\nsso_start_url = ${START}\nsso_region = us-east-1\nsso_registration_scopes = sso:account:access\n`,
    );
    assert.ok(!existsSync(join(home, ".aws", "config")), "must not write ~/.aws/config when AWS_CONFIG_FILE is set");

    const done = await call("aws_login_complete", { sessionId: start.data.sessionId });
    assert.equal(done.ok, true, done.error ?? "");
    assert.equal(done.data.loggedIn, true);
    assert.equal(done.data.ssoSession, "acme");
    assert.equal(done.data.startUrl, START);
    assert.ok(done.data.ssoToken, "expected the projected token status");
    assert.deepEqual(Object.keys(done.data.ssoToken).sort(), ["expiresAt", "minutesLeft", "startUrl"]);
    assert.ok(done.data.ssoToken.minutesLeft >= 470);
    assert.match(done.data.next, /aws_sso_list_assignments/);
    assert.equal(done.data.note, undefined);
    const spawned = calls();
    assert.ok(
      spawned.some((a) => a.includes("--sso-session")),
      "the login ran",
    );
    assert.ok(!spawned.some((a) => a[0] === "sts"), "an sso-session login must not run get-caller-identity");
  });

  it("an empty AWS_CONFIG_FILE makes every bootstrap tool refuse without writing anything", async () => {
    // Set-but-empty means "no config file" to botocore. dirname("") is ".", so
    // a write that slipped past the guard would land in the working directory;
    // a fall-back to the default path would land in HOME/.aws. Run from a
    // fresh cwd so both are observable.
    const snapshot = (d: string) => readdirSync(d, { recursive: true }).map(String).sort();
    seedSession(); // a real token cache in HOME, so nothing short-circuits on "not logged in"
    rmSync(configPath);
    const homeBefore = snapshot(home);
    const cwd = mkdtempSync(join(tmpdir(), "aws-mcp-ssoboot-cwd-"));
    const prevCwd = process.cwd();
    process.env.AWS_CONFIG_FILE = "";
    process.chdir(cwd);
    try {
      const runs: Array<[string, unknown]> = [
        ["aws_login_start", { ssoSession: "acme", startUrl: START, ssoRegion: "us-east-1" }],
        ["aws_sso_list_assignments", { ssoSession: "acme" }],
        ["aws_sso_generate_profiles", { ssoSession: "acme" }],
      ];
      for (const [name, input] of runs) {
        const r = await call(name, input);
        assert.equal(r.ok, false, name);
        assert.equal(r.error, EMPTY_CONFIG_FILE_ERROR, name);
      }
      assert.deepEqual(snapshot(cwd), [], "nothing may be written to the working directory");
      assert.deepEqual(snapshot(home), homeBefore, "nothing may be written under HOME");
      assert.deepEqual(calls(), [], "no CLI child may run");
    } finally {
      process.chdir(prevCwd);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("aws_login_complete notes ignored profile/region on an sso-session login", async () => {
    const start = await call("aws_login_start", { ssoSession: "acme", startUrl: START, ssoRegion: "us-east-1" });
    assert.equal(start.ok, true, start.error ?? "");
    const done = await call("aws_login_complete", {
      sessionId: start.data.sessionId,
      profile: "x",
      region: "eu-west-1",
    });
    assert.equal(done.ok, true, done.error ?? "");
    assert.match(done.data.note, /ignored/);
  });

  it("reuses an existing hand-written block with the same URL, and refuses one with a different URL", async () => {
    const hand = `[sso-session acme]\nsso_start_url = ${START}\nsso_region = us-east-1\n`;
    writeFileSync(configPath, hand);
    const same = await call("aws_login_start", { ssoSession: "acme", startUrl: START, ssoRegion: "us-east-1" });
    assert.equal(same.ok, true, same.error ?? "");
    assert.equal(same.data.sessionBlock, "existing");
    _clearSessions();
    const omitted = await call("aws_login_start", { ssoSession: "acme" });
    assert.equal(omitted.ok, true, omitted.error ?? "");
    assert.equal(omitted.data.sessionBlock, "existing");
    assert.equal(omitted.data.startUrl, START);
    _clearSessions();
    const other = await call("aws_login_start", {
      ssoSession: "acme",
      startUrl: "https://other.awsapps.com/start",
      ssoRegion: "us-east-1",
    });
    assert.equal(other.ok, false);
    assert.match(other.error ?? "", /was not created by aws-mcp/);
    assert.equal(readFileSync(configPath, "utf-8"), hand, "a hand-written block is never modified");
  });

  it("repoints a managed block whose URL changed (sessionBlock: updated)", async () => {
    writeFileSync(
      configPath,
      `[sso-session acme]\n${MANAGED_MARKER}\nsso_start_url = https://old.awsapps.com/start\nsso_region = us-east-1\nsso_registration_scopes = sso:account:access\n`,
    );
    const r = await call("aws_login_start", { ssoSession: "acme", startUrl: START, ssoRegion: "us-east-1" });
    assert.equal(r.ok, true, r.error ?? "");
    assert.equal(r.data.sessionBlock, "updated");
    assert.match(readFileSync(configPath, "utf-8"), new RegExp(`sso_start_url = ${START}`));
  });

  it("repointing the block while a login is in flight abandons it and starts a fresh one", async () => {
    process.env.AWS_MCP_FAKE_RELEASE_FILE = join(home, "release");
    try {
      const DEV = "https://dev-org.awsapps.com/start";
      const first = await call("aws_login_start", { ssoSession: "acme", startUrl: DEV, ssoRegion: "us-east-1" });
      assert.equal(first.ok, true, first.error ?? "");
      // Same block again: the in-flight login is still the right one.
      const again = await call("aws_login_start", { ssoSession: "acme", startUrl: DEV, ssoRegion: "us-east-1" });
      assert.equal(again.data.reused, true);
      assert.equal(again.data.sessionId, first.data.sessionId);
      const second = await call("aws_login_start", { ssoSession: "acme", startUrl: START, ssoRegion: "us-east-1" });
      assert.equal(second.ok, true, second.error ?? "");
      assert.equal(second.data.sessionBlock, "updated");
      assert.notEqual(second.data.sessionId, first.data.sessionId, "the dev-org login must not be handed out");
      assert.equal(second.data.reused, undefined);
      const old = await call("aws_login_complete", { sessionId: first.data.sessionId });
      assert.equal(old.ok, false);
      assert.match(old.error ?? "", /Superseded/);
      writeFileSync(join(home, "release"), "");
      const done = await call("aws_login_complete", { sessionId: second.data.sessionId });
      assert.equal(done.ok, true, done.error ?? "");
      assert.equal(done.data.ssoToken?.startUrl, START, "the token is for the repointed URL");
    } finally {
      delete process.env.AWS_MCP_FAKE_RELEASE_FILE;
    }
  });

  it("treats empty-string optional fields as absent (profile login, not a cross-field error)", async () => {
    const r = await call("aws_login_start", { profile: "dev", ssoSession: "", startUrl: "", ssoRegion: "" });
    assert.notEqual(r.errorKind, "bad_input", r.error ?? "");
    assert.ok(
      calls().some((a) => a.includes("--profile") && a.includes("dev")),
      "a profile login for 'dev' was attempted",
    );
    assert.ok(!existsSync(configPath), "no sso-session block may be written");
  });

  it("errors when the block is absent and no startUrl/ssoRegion were given", async () => {
    const r = await call("aws_login_start", { ssoSession: "acme" });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /No \[sso-session acme\].*Pass startUrl and ssoRegion/);
    assert.ok(!existsSync(configPath));
  });

  it("validates the cross-field rules and every new input", async () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ profile: "p", ssoSession: "acme" }, /either profile or ssoSession/],
      [{ startUrl: START, ssoRegion: "us-east-1" }, /only valid with ssoSession/],
      [{ ssoSession: "acme", startUrl: START }, /together/],
      [{ ssoSession: "default", startUrl: START, ssoRegion: "us-east-1" }, /'default'/],
      [{ ssoSession: "-x", startUrl: START, ssoRegion: "us-east-1" }, /Invalid ssoSession/],
      [{ ssoSession: "acme", startUrl: "http://acme.awsapps.com/start", ssoRegion: "us-east-1" }, /https/],
      [{ ssoSession: "acme", startUrl: `${START}\n[profile x]`, ssoRegion: "us-east-1" }, /Invalid startUrl/],
      [{ ssoSession: "acme", startUrl: START, ssoRegion: "--evil" }, /Invalid ssoRegion/],
    ];
    for (const [input, re] of cases) {
      const r = await call("aws_login_start", input);
      assert.equal(r.ok, false, JSON.stringify(input));
      assert.equal(r.errorKind, "bad_input", JSON.stringify(input));
      assert.match(r.error ?? "", re, JSON.stringify(input));
    }
    assert.ok(!existsSync(configPath), "a rejected input must not touch the config");
  });

  it("refuses an sso-session login on a CLI older than 2.9.0", async () => {
    _clearCliVersionCache();
    process.env.AWS_MCP_FAKE_CLI_VERSION = "2.8.0";
    try {
      const r = await call("aws_login_start", { ssoSession: "acme", startUrl: START, ssoRegion: "us-east-1" });
      assert.equal(r.ok, false);
      assert.match(r.error ?? "", /2\.8\.0 predates --sso-session \(2\.9\.0\)/);
    } finally {
      _clearCliVersionCache();
    }
  });

  // ---------------------------------------------------------------------
  // aws_sso_list_assignments
  // ---------------------------------------------------------------------

  it("lists accounts and roles, flags configured ones, keeps the 40-role account whole, drops emailAddress", async () => {
    seedSession({
      extraConfig: "\n[profile mine]\nsso_session = acme\nsso_account_id = 111111111111\nsso_role_name = ReadOnly\n",
    });
    const r = await call("aws_sso_list_assignments", { ssoSession: "acme" });
    assert.equal(r.ok, true, r.error ?? "");
    assert.equal(r.data.startUrl, START);
    assert.deepEqual(
      r.data.accounts.map((a: Json) => a.accountId),
      ["111111111111", "222222222222", "333333333333"],
    );
    const prod = r.data.accounts[0];
    assert.deepEqual(prod.roles, [
      { roleName: "AdministratorAccess", profile: null },
      { roleName: "ReadOnly", profile: "mine", managed: false },
    ]);
    assert.equal(prod.rolesError, null);
    assert.equal(r.data.accounts[2].roles.length, 40);
    assert.deepEqual(r.data.totals, { accounts: 3, roles: 44, configured: 1 });
    assert.doesNotMatch(JSON.stringify(r), /emailAddress|example\.com/);
    // Every sso call went through the 0600 file transport (the fake exits 4
    // otherwise) and named no profile (exit 2) -- the call succeeding is the proof.
    const ssoCalls = calls().filter((a) => a[0] === "sso");
    assert.equal(ssoCalls.length, 4);
    assert.ok(ssoCalls.every((a) => a[a.indexOf("--cli-input-json") + 1].startsWith("file://")));
    assert.ok(!JSON.stringify(ssoCalls).includes(SENTINEL), "the token must never be on argv");
  });

  it("the token file is gone once the call returns", async () => {
    seedSession();
    const r = await call("aws_sso_list_assignments", { ssoSession: "acme", includeRoles: false });
    assert.equal(r.ok, true, r.error ?? "");
    assert.equal(r.data.accounts[0].roles, undefined);
    const [argv] = calls();
    const path = argv[argv.indexOf("--cli-input-json") + 1].slice("file://".length);
    assert.ok(!existsSync(path), `temp token file still on disk: ${path}`);
  });

  it("narrows to accountIds and rejects a malformed one", async () => {
    seedSession();
    const r = await call("aws_sso_list_assignments", { ssoSession: "acme", accountIds: ["222222222222"] });
    assert.equal(r.ok, true, r.error ?? "");
    assert.deepEqual(
      r.data.accounts.map((a: Json) => a.accountId),
      ["222222222222"],
    );
    const bad = await call("aws_sso_list_assignments", { ssoSession: "acme", accountIds: ["12345"] });
    assert.equal(bad.errorKind, "bad_input");
  });

  it("follows a nextToken, and stops on a repeated one", async () => {
    seedSession();
    process.env.AWS_MCP_FAKE_SCENARIO = "sso_list_paged";
    const paged = await call("aws_sso_list_assignments", { ssoSession: "acme", includeRoles: false });
    assert.equal(paged.ok, true, paged.error ?? "");
    assert.equal(paged.data.accounts.length, 3);
    process.env.AWS_MCP_FAKE_SCENARIO = "sso_list_paged_loop";
    const loop = await call("aws_sso_list_assignments", { ssoSession: "acme", includeRoles: false });
    assert.equal(loop.ok, false);
    assert.equal(loop.errorKind, "bad_output");
    assert.match(loop.error ?? "", /same nextToken twice/);
  });

  it("a rejected token is sso_expired naming aws_login_start", async () => {
    seedSession();
    process.env.AWS_MCP_FAKE_SCENARIO = "sso_list_unauthorized";
    const r = await call("aws_sso_list_assignments", { ssoSession: "acme" });
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, "sso_expired");
    assert.match(r.error ?? "", /rejected.*aws_login_start with ssoSession='acme'/s);
  });

  it("a throttled account gets rolesError; the rest still list", async () => {
    seedSession();
    process.env.AWS_MCP_FAKE_SCENARIO = "sso_list_roles_throttle";
    const r = await call("aws_sso_list_assignments", { ssoSession: "acme" });
    assert.equal(r.ok, true, r.error ?? "");
    const dev = r.data.accounts.find((a: Json) => a.accountId === "222222222222");
    assert.match(dev.rolesError, /TooManyRequestsException/);
    assert.deepEqual(dev.roles, []);
    assert.equal(r.data.accounts[0].rolesError, null);
    assert.equal(r.data.accounts[0].roles.length, 2);
  });

  it("scrubs a token the CLI echoed into its error text", async () => {
    seedSession();
    process.env.AWS_MCP_FAKE_SCENARIO = "sso_list_echo_token_error";
    const r = await call("aws_sso_list_assignments", { ssoSession: "acme" });
    assert.equal(r.ok, true, r.error ?? "");
    const dev = r.data.accounts.find((a: Json) => a.accountId === "222222222222");
    assert.match(dev.rolesError, /InternalServerException.*<redacted-token>/);
  });

  it("scrubs a long token whose echo crosses the 500-char cut", async () => {
    // Real Identity Center tokens run 1000+ chars. Cutting before scrubbing left
    // a token fragment the whole-token split could not match.
    const longToken = `aoaAAAAAG${"x".repeat(1200)}Z9`;
    seedSession({ token: longToken });
    process.env.AWS_MCP_FAKE_SSO_TOKEN = longToken;
    process.env.AWS_MCP_FAKE_SCENARIO = "sso_list_echo_token_error";
    const r = await call("aws_sso_list_assignments", { ssoSession: "acme" });
    assert.equal(r.ok, true, r.error ?? "");
    const blob = JSON.stringify(r);
    assert.ok(!blob.includes(longToken.slice(0, 40)), "a prefix of the token leaked");
    const dev = r.data.accounts.find((a: Json) => a.accountId === "222222222222");
    assert.match(dev.rolesError, /<redacted-token>/);
    assert.ok(dev.rolesError.length <= 500);
  });

  it("no token, or an expired one, is sso_expired for list and generate", async () => {
    seedSession({ expiresAt: new Date(Date.now() - 60_000).toISOString() });
    for (const name of ["aws_sso_list_assignments", "aws_sso_generate_profiles"]) {
      const r = await call(name, { ssoSession: "acme" });
      assert.equal(r.ok, false, name);
      assert.equal(r.errorKind, "sso_expired", name);
      assert.match(r.error ?? "", /No valid IAM Identity Center token for sso-session 'acme'.*aws_login_start/);
    }
    assert.equal(calls().length, 0, "nothing should be spawned without a token");
  });

  it("an unknown sso-session is a clear error", async () => {
    const r = await call("aws_sso_list_assignments", { ssoSession: "nope" });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /No usable \[sso-session nope\]/);
  });

  // ---------------------------------------------------------------------
  // aws_sso_generate_profiles
  // ---------------------------------------------------------------------

  it("generates every assignment: clash group suffixed, bad role skipped, rerun byte-identical", async () => {
    seedSession({ extraConfig: "\n[profile dev-Admin]\nregion = eu-west-1\n" });
    const r = await call("aws_sso_generate_profiles", { ssoSession: "acme" });
    assert.equal(r.ok, true, r.error ?? "");
    const written = r.data.written.map((w: Json) => w.profile);
    assert.ok(written.includes("prod-111111111111-AdministratorAccess"));
    assert.ok(written.includes("prod-333333333333-AdministratorAccess"));
    assert.ok(written.includes("prod-ReadOnly"));
    assert.ok(written.includes("prod-Role01"));
    assert.equal(written.length, 1 + 1 + 40, "111: 2 roles, 333: 40 roles; dev-Admin and Bad Role skipped");
    assert.ok(r.data.written.every((w: Json) => w.action === "created"));
    const reasons = Object.fromEntries(r.data.skipped.map((s: Json) => [s.roleName, s.reason]));
    assert.equal(reasons["Bad Role"], "role name not representable");
    assert.equal(reasons.Admin, "profile exists and was not created by aws-mcp");
    const text = readFileSync(configPath, "utf-8");
    assert.match(text, /\[profile dev-Admin\]\nregion = eu-west-1\n/, "the hand-written profile is preserved");
    assert.match(
      text,
      new RegExp(
        `\\[profile prod-ReadOnly\\]\\n${MANAGED_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\nsso_session = acme\\nsso_account_id = 111111111111\\nsso_role_name = ReadOnly\\nregion = us-east-1\\n`,
      ),
    );

    const again = await call("aws_sso_generate_profiles", { ssoSession: "acme" });
    assert.equal(again.ok, true, again.error ?? "");
    assert.equal(again.data.written.length, 0);
    assert.equal(again.data.unchanged.length, 42);
    assert.equal(readFileSync(configPath, "utf-8"), text, "a rerun must not change a byte");

    const listed = await call("aws_list_profiles", {});
    assert.equal(listed.ok, true, listed.error ?? "");
    const p = listed.data.profiles.find((x: Json) => x.name === "prod-ReadOnly");
    assert.equal(p.isSso, true);
    assert.equal(p.ssoStartUrl, START);
    assert.equal(p.ssoAccountId, "111111111111");
    assert.equal(p.managed, true);
  });

  it("never resets a region the user changed in a generated profile", async () => {
    seedSession();
    const sel = [{ accountId: "111111111111", roleName: "ReadOnly" }];
    const first = await call("aws_sso_generate_profiles", { ssoSession: "acme", selection: sel });
    assert.equal(first.ok, true, first.error ?? "");
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf-8").replace(/region = us-east-1\n$/, "region = ap-south-1\noutput = table\n"),
    );
    const before = readFileSync(configPath, "utf-8");
    const again = await call("aws_sso_generate_profiles", { ssoSession: "acme", selection: sel, region: "eu-west-1" });
    assert.equal(again.ok, true, again.error ?? "");
    assert.equal(again.data.unchanged.length, 1);
    assert.equal(readFileSync(configPath, "utf-8"), before);
  });

  it("skips a selection that is not assigned, honours profileName, and reports an assignment already hand-configured", async () => {
    seedSession({
      extraConfig: `\n[profile legacy]\nsso_start_url = ${START}\nsso_region = us-east-1\nsso_account_id = 333333333333\nsso_role_name = Role01\n`,
    });
    const r = await call("aws_sso_generate_profiles", {
      ssoSession: "acme",
      selection: [
        { accountId: "111111111111", roleName: "ReadOnly", profileName: "prod-ro" },
        { accountId: "111111111111", roleName: "NotMine" },
        { accountId: "999999999999", roleName: "Admin" },
        { accountId: "333333333333", roleName: "Role01" },
      ],
    });
    assert.equal(r.ok, true, r.error ?? "");
    assert.deepEqual(
      r.data.written.map((w: Json) => w.profile),
      ["prod-ro"],
    );
    const reasons = r.data.skipped.map((s: Json) => s.reason);
    assert.deepEqual(reasons.filter((x: string) => x === "not assigned to you").length, 2);
    assert.ok(reasons.includes("already configured as profile 'legacy'"));
  });

  it("does not duplicate an assignment already generated under another name (account renamed)", async () => {
    seedSession({
      extraConfig: `\n[profile renamed-ro]\n${MANAGED_MARKER}\nsso_session = acme\nsso_account_id = 111111111111\nsso_role_name = ReadOnly\n`,
    });
    const r = await call("aws_sso_generate_profiles", {
      ssoSession: "acme",
      selection: [{ accountId: "111111111111", roleName: "ReadOnly" }],
    });
    assert.equal(r.ok, true, r.error ?? "");
    assert.deepEqual(r.data.written, []);
    assert.deepEqual(r.data.unchanged, [{ profile: "renamed-ro", accountId: "111111111111", roleName: "ReadOnly" }]);
    assert.doesNotMatch(readFileSync(configPath, "utf-8"), /\[profile prod-ReadOnly\]/);
  });

  it("reports a managed profile whose assignment is gone as stale, and leaves it in place", async () => {
    const gone = `\n[profile old-one]\n${MANAGED_MARKER}\nsso_session = acme\nsso_account_id = 111111111111\nsso_role_name = Revoked\n`;
    seedSession({ extraConfig: gone });
    const r = await call("aws_sso_generate_profiles", { ssoSession: "acme" });
    assert.equal(r.ok, true, r.error ?? "");
    assert.deepEqual(r.data.stale, [{ profile: "old-one", accountId: "111111111111", roleName: "Revoked" }]);
    assert.ok(readFileSync(configPath, "utf-8").includes(gone), "nothing is pruned in v1");
  });

  it("dryRun reports the plan without touching the file", async () => {
    seedSession();
    const before = readFileSync(configPath, "utf-8");
    const r = await call("aws_sso_generate_profiles", { ssoSession: "acme", dryRun: true });
    assert.equal(r.ok, true, r.error ?? "");
    assert.equal(r.data.dryRun, true);
    assert.equal(r.data.written.length, 43, "dev-Admin too: no hand-written section here");
    assert.equal(readFileSync(configPath, "utf-8"), before);
  });

  it("rejects bad generate inputs before any AWS call", async () => {
    seedSession();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ nameTemplate: "{accountName}-{oops}" }, /nameTemplate/],
      [{ region: "Nope" }, /Invalid region/],
      [{ selection: [{ accountId: "1", roleName: "Admin" }] }, /12 digits/],
      [{ selection: [{ accountId: "111111111111", roleName: "Bad Role" }] }, /roleName/],
      [{ selection: [{ accountId: "111111111111", roleName: "Admin", profileName: "default" }] }, /'default'/],
    ];
    for (const [extra, re] of cases) {
      const r = await call("aws_sso_generate_profiles", { ssoSession: "acme", ...extra });
      assert.equal(r.errorKind, "bad_input", JSON.stringify(extra));
      assert.match(r.error ?? "", re);
    }
    assert.equal(calls().length, 0);
  });

  it("refuses while a login for the same sso-session is in flight", async () => {
    seedSession();
    process.env.AWS_MCP_FAKE_RELEASE_FILE = join(home, "never");
    try {
      const start = await call("aws_login_start", { ssoSession: "acme" });
      assert.equal(start.ok, true, start.error ?? "");
      const r = await call("aws_sso_generate_profiles", { ssoSession: "acme" });
      assert.equal(r.ok, false);
      assert.match(r.error ?? "", /login for sso-session 'acme' is in progress/);
    } finally {
      delete process.env.AWS_MCP_FAKE_RELEASE_FILE;
    }
  });

  it("expired token -> sso_expired; a fresh login then lets generate succeed", async () => {
    seedSession({ expiresAt: new Date(Date.now() - 60_000).toISOString() });
    const stale = await call("aws_sso_generate_profiles", { ssoSession: "acme" });
    assert.equal(stale.errorKind, "sso_expired");
    const start = await call("aws_login_start", { ssoSession: "acme" });
    assert.equal(start.ok, true, start.error ?? "");
    const done = await call("aws_login_complete", { sessionId: start.data.sessionId });
    assert.equal(done.ok, true, done.error ?? "");
    const r = await call("aws_sso_generate_profiles", {
      ssoSession: "acme",
      selection: [{ accountId: "222222222222", roleName: "Admin" }],
    });
    assert.equal(r.ok, true, r.error ?? "");
    assert.deepEqual(
      r.data.written.map((w: Json) => w.profile),
      ["dev-Admin"],
    );
  });
});
