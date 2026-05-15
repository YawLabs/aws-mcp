import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { _resetSession } from "../session.js";
import { assumeTools } from "./assume.js";

const tool = assumeTools.find((t) => t.name === "aws_assume_role");
if (!tool) throw new Error("assumeTools missing aws_assume_role");

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AWS = join(__dirname, "..", "testing", "fake-aws.js");

let prevCommand: string | undefined;
let prevPrefixArgs: string | undefined;
let prevHome: string | undefined;
let prevUserprofile: string | undefined;
let fakeHome: string;

before(() => {
  prevCommand = process.env.AWS_MCP_TEST_AWS_COMMAND;
  prevPrefixArgs = process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS;
  prevHome = process.env.HOME;
  prevUserprofile = process.env.USERPROFILE;
  process.env.AWS_MCP_TEST_AWS_COMMAND = process.execPath;
  process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS = JSON.stringify([FAKE_AWS]);
  // Redirect homedir() so upsertProfile writes into a throwaway tempdir
  // instead of the real ~/.aws/credentials. os.homedir() honors $HOME on
  // Unix and $USERPROFILE on Windows; setting both keeps the test portable.
  fakeHome = mkdtempSync(join(tmpdir(), "aws-mcp-assume-test-"));
  // upsertProfile expects the parent .aws directory to already exist (it
  // writes a sibling .tmp- file). Real installs always have it; tests get
  // a fresh tmpdir so we create the dir explicitly.
  mkdirSync(join(fakeHome, ".aws"), { recursive: true });
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
});
after(() => {
  if (prevCommand === undefined) delete process.env.AWS_MCP_TEST_AWS_COMMAND;
  else process.env.AWS_MCP_TEST_AWS_COMMAND = prevCommand;
  if (prevPrefixArgs === undefined) delete process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS;
  else process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS = prevPrefixArgs;
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserprofile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserprofile;
  try {
    rmSync(fakeHome, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; if a stray fd holds the dir on Windows the OS
    // will reap it later -- not worth failing the test for.
  }
});

afterEach(() => {
  _resetSession();
  delete process.env.AWS_MCP_FAKE_SCENARIO;
});

describe("aws_assume_role schema", () => {
  it("accepts a minimal valid input (roleArn + sessionName)", () => {
    const r = tool.inputSchema.safeParse({
      roleArn: "arn:aws:iam::123456789012:role/Admin",
      sessionName: "my-session",
    });
    assert.equal(r.success, true);
  });

  it("accepts all optional fields", () => {
    const r = tool.inputSchema.safeParse({
      roleArn: "arn:aws:iam::123456789012:role/Admin",
      sessionName: "my-session",
      durationSeconds: 7200,
      externalId: "xyz",
      sourceProfile: "dev",
      targetProfile: "mcp-prod",
      region: "us-west-2",
    });
    assert.equal(r.success, true);
  });

  it("rejects sessionName with invalid characters", () => {
    const r = tool.inputSchema.safeParse({
      roleArn: "arn:aws:iam::123:role/A",
      sessionName: "bad name/slash",
    });
    assert.equal(r.success, false);
  });

  it("rejects sessionName shorter than 2 chars", () => {
    const r = tool.inputSchema.safeParse({
      roleArn: "arn:aws:iam::123:role/A",
      sessionName: "x",
    });
    assert.equal(r.success, false);
  });

  it("rejects durationSeconds below the STS minimum (900)", () => {
    const r = tool.inputSchema.safeParse({
      roleArn: "arn:aws:iam::123:role/A",
      sessionName: "sess",
      durationSeconds: 300,
    });
    assert.equal(r.success, false);
  });

  it("rejects durationSeconds above the STS maximum (43200)", () => {
    const r = tool.inputSchema.safeParse({
      roleArn: "arn:aws:iam::123:role/A",
      sessionName: "sess",
      durationSeconds: 50_000,
    });
    assert.equal(r.success, false);
  });

  it("requires roleArn and sessionName", () => {
    assert.equal(tool.inputSchema.safeParse({}).success, false);
    assert.equal(tool.inputSchema.safeParse({ roleArn: "x" }).success, false);
    assert.equal(tool.inputSchema.safeParse({ sessionName: "x" }).success, false);
  });
});

describe("aws_assume_role handler (fake-aws integration)", () => {
  it("writes the profile and returns the assumed identity on a successful assume", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "assume_role_success";
    const r = await tool.handler({
      roleArn: "arn:aws:iam::123456789012:role/Admin",
      sessionName: "my-session",
    } as never);
    assert.equal(r.ok, true);
    const data = r.data as {
      profile: string;
      credentialsPath: string;
      expiration?: string;
      assumedRoleArn?: string;
      assumedRoleId?: string;
      sourceProfile: string;
      hint: string;
    };
    assert.equal(data.profile, "mcp-my-session");
    assert.equal(data.assumedRoleArn, "arn:aws:sts::123456789012:assumed-role/Admin/my-session");
    assert.equal(data.assumedRoleId, "AROA1234EXAMPLE:my-session");
    assert.equal(data.expiration, "2099-12-31T23:59:59+00:00");
    assert.match(data.hint, /profile='mcp-my-session'/);
    // The raw secret material must NOT leak into the response envelope.
    const blob = JSON.stringify(r);
    assert.equal(blob.includes("wJalrXUtnFEMI"), false);
    assert.equal(blob.includes("FQoGZXIvYXdz"), false);
    // The credentials file should now contain the new profile with all
    // three keys upserted under the resolved target profile.
    const credsText = readFileSync(data.credentialsPath, "utf-8");
    assert.match(credsText, /\[mcp-my-session]/);
    assert.match(credsText, /aws_access_key_id = ASIA1234EXAMPLE/);
    assert.match(credsText, /aws_secret_access_key = wJalrXUtnFEMI/);
    assert.match(credsText, /aws_session_token = FQoGZXIvYXdz/);
  });

  it("auto-prefixes a non-mcp- targetProfile", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "assume_role_success";
    const r = await tool.handler({
      roleArn: "arn:aws:iam::123456789012:role/Admin",
      sessionName: "sess",
      targetProfile: "prod",
    } as never);
    assert.equal(r.ok, true);
    const data = r.data as { profile: string };
    assert.equal(data.profile, "mcp-prod");
  });

  it("surfaces an error envelope (does not crash) when the CLI exits non-zero", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "assume_role_access_denied";
    const r = await tool.handler({
      roleArn: "arn:aws:iam::999999999999:role/NoSuchRole",
      sessionName: "sess",
    } as never);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /AccessDenied|not authorized/i);
  });

  it("rewrites sso_expired errors to name the source profile", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "call_sso_expired";
    const r = await tool.handler({
      roleArn: "arn:aws:iam::123:role/A",
      sessionName: "sess",
      sourceProfile: "my-source",
    } as never);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /source profile 'my-source'/);
    assert.match(r.error ?? "", /aws_login_start/);
  });

  it("guards against an incomplete Credentials block in CLI stdout", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "assume_role_incomplete";
    const r = await tool.handler({
      roleArn: "arn:aws:iam::123:role/A",
      sessionName: "sess",
    } as never);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /incomplete credentials/i);
  });
});
