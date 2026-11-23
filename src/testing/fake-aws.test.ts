/**
 * Self-test for the fake CLI's own guards and payload handling -- behavior
 * that no tool test exercises because it only matters when a test is written
 * wrong (a forgotten HOME redirect, a release file that never appears) or a
 * payload crosses runAwsCall's inline limit.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AWS = join(__dirname, "fake-aws.js");

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "aws-mcp-fake-selftest-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** process.env minus anything that would steer the fake, plus `extra`. */
function fakeEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.toUpperCase().startsWith("AWS_")) env[k] = v;
  }
  return { ...env, ...extra };
}

function runFake(argv: string[], env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [FAKE_AWS, ...argv], { env, encoding: "utf8", timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A payload file, the way runAwsCall passes params past INLINE_CLI_INPUT_JSON_MAX_CHARS. */
function payloadFile(name: string, params: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(params));
  return `file://${path}`;
}

describe("sso_session_login guards", () => {
  it("refuses (exit 5) when HOME / USERPROFILE are the account's real home", () => {
    const realHome = userInfo().homedir;
    // AWS_CONFIG_FILE names nothing, so even with the guard gone the scenario
    // stops at its missing-session check (exit 2) before writing any token.
    const r = runFake(
      ["sso", "login", "--sso-session", "aws-mcp-fake-selftest"],
      fakeEnv({
        AWS_MCP_FAKE_SCENARIO: "sso_session_login",
        HOME: realHome,
        USERPROFILE: realHome,
        AWS_CONFIG_FILE: join(dir, "no-such-config"),
      }),
    );
    assert.equal(r.status, 5, r.stderr);
    assert.match(r.stderr, /refusing to write an SSO token under the real home directory/);
  });

  it("fails (exit 6) instead of logging in when the release file never appears", () => {
    const home = mkdtempSync(join(dir, "home-"));
    const config = join(dir, "release-config");
    writeFileSync(
      config,
      "[sso-session acme]\nsso_start_url = https://acme.awsapps.com/start\nsso_region = us-east-1\n",
    );
    const r = runFake(
      ["sso", "login", "--sso-session", "acme"],
      fakeEnv({
        AWS_MCP_FAKE_SCENARIO: "sso_session_login",
        HOME: home,
        USERPROFILE: home,
        AWS_CONFIG_FILE: config,
        AWS_MCP_FAKE_RELEASE_FILE: join(dir, "never-created"),
        AWS_MCP_FAKE_RELEASE_TIMEOUT_MS: "300",
      }),
    );
    assert.equal(r.status, 6, r.stderr);
    assert.match(r.stderr, /release file .* never appeared within 300 ms/);
    assert.doesNotMatch(r.stdout, /Successfully logged into/);
  });
});

describe("--cli-input-json file:// payloads (runAwsCall's large-params path)", () => {
  it("iam_simulate_truncated reads the resume Marker out of a file:// payload", () => {
    const r = runFake(
      [
        "iam",
        "simulate-principal-policy",
        "--cli-input-json",
        payloadFile("iam.json", {
          PolicySourceArn: "arn:aws:iam::123456789012:user/x",
          Marker: "obs2-iam-marker-page2==",
        }),
      ],
      fakeEnv({ AWS_MCP_FAKE_SCENARIO: "iam_simulate_truncated" }),
    );
    assert.equal(r.status, 0, r.stderr);
    const page = JSON.parse(r.stdout) as { IsTruncated?: boolean; Marker?: string };
    // Page 2, not the merged first page an unparsed payload used to fall back to.
    assert.equal(page.IsTruncated, true);
    assert.equal(page.Marker, "obs2-iam-marker-page3==");
  });

  it("iam_simulate_truncated fails loud on an unreadable payload instead of answering page 1", () => {
    const r = runFake(
      ["iam", "simulate-principal-policy", "--cli-input-json", `file://${join(dir, "missing.json")}`],
      fakeEnv({ AWS_MCP_FAKE_SCENARIO: "iam_simulate_truncated" }),
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /could not read the --cli-input-json file:\/\/ file/);
  });

  it("multi_account_* phase 1 reads the RoleArn out of a file:// payload", () => {
    const r = runFake(
      [
        "sts",
        "assume-role",
        "--cli-input-json",
        payloadFile("macct.json", { RoleArn: "arn:aws:iam::444455556666:role/Fake", RoleSessionName: "s" }),
      ],
      fakeEnv({ AWS_MCP_FAKE_SCENARIO: "multi_account_success" }),
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      (JSON.parse(r.stdout) as { Credentials: { AccessKeyId: string } }).Credentials.AccessKeyId,
      "ASIAFAKE444455556666",
    );
  });

  it("multi_account_* (phase-1 argv checks) reads both phases' payloads out of file:// paths", () => {
    const assume = runFake(
      [
        "sts",
        "assume-role",
        "--cli-input-json",
        payloadFile("macct2-assume.json", {
          RoleArn: "arn:aws:iam::777788889999:role/Fake",
          RoleSessionName: "s",
          DurationSeconds: 900,
        }),
        "--profile",
        "operator",
      ],
      fakeEnv({ AWS_MCP_FAKE_SCENARIO: "multi_account_echo_args" }),
    );
    assert.equal(assume.status, 0, assume.stderr);
    const creds = (JSON.parse(assume.stdout) as { Credentials: Record<string, string> }).Credentials;
    assert.equal(creds.AccessKeyId, "ASIAFAKE777788889999");

    const op = runFake(
      ["s3api", "list-buckets", "--cli-input-json", payloadFile("macct2-op.json", { Prefix: "p" })],
      fakeEnv({
        AWS_MCP_FAKE_SCENARIO: "multi_account_echo_args",
        AWS_ACCESS_KEY_ID: creds.AccessKeyId,
        AWS_SECRET_ACCESS_KEY: creds.SecretAccessKey,
        AWS_SESSION_TOKEN: creds.SessionToken,
      }),
    );
    assert.equal(op.status, 0, op.stderr);
    assert.deepEqual((JSON.parse(op.stdout) as { SawParams: unknown }).SawParams, { Prefix: "p" });
  });
});

describe("chunk-split scenarios (writeSplitStdout)", () => {
  for (const scenario of ["regional_device_split", "split_portal_url", "call_utf8_split"]) {
    it(`${scenario} refuses to run without the split handshake instead of falling back to a sleep`, () => {
      const r = runFake(["s3api", "list-buckets"], fakeEnv({ AWS_MCP_FAKE_SCENARIO: scenario }));
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /needs AWS_MCP_FAKE_READY_OUT and AWS_MCP_FAKE_RELEASE_FILE/);
      assert.equal(r.stdout, "", "nothing may be written before the handshake is known to be in place");
    });
  }

  it("holds the second chunk until the parent's release file appears", () => {
    // No release ever appears, so the fake must stop after chunk 1 and fail
    // (exit 6) rather than carry on as if the parent had read it.
    const ready = join(dir, "split-ready");
    const r = runFake(
      ["s3api", "list-buckets"],
      fakeEnv({
        AWS_MCP_FAKE_SCENARIO: "split_portal_url",
        AWS_MCP_FAKE_READY_OUT: ready,
        AWS_MCP_FAKE_RELEASE_FILE: join(dir, "split-never-released"),
        AWS_MCP_FAKE_RELEASE_TIMEOUT_MS: "200",
      }),
    );
    assert.equal(r.status, 6, r.stderr);
    assert.equal(r.stdout, "Open the following URL:\n\nhttps://team-example.awsapps.com/start/#/device?user_co");
    assert.match(r.stderr, /release file .*split-never-released\.1 never appeared within 200 ms/);
  });
});
