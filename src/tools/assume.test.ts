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

  it("accepts an explicit timeoutMs", () => {
    const r = tool.inputSchema.safeParse({
      roleArn: "arn:aws:iam::123:role/A",
      sessionName: "sess",
      timeoutMs: 180_000,
    });
    assert.equal(r.success, true);
  });

  it("rejects a non-positive timeoutMs", () => {
    const r = tool.inputSchema.safeParse({
      roleArn: "arn:aws:iam::123:role/A",
      sessionName: "sess",
      timeoutMs: 0,
    });
    assert.equal(r.success, false);
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

  it("rejects an invalid sourceProfile with a sourceProfile-named error (not the generic 'profile' message)", async () => {
    // Without the assume.ts-level check, this would still get caught inside
    // runAwsCall but the error would say "Check the 'profile' arg or
    // AWS_PROFILE env var" -- misleading for an aws_assume_role caller who
    // passed sourceProfile. The handler-level check names the right field.
    const r = await tool.handler({
      roleArn: "arn:aws:iam::123:role/A",
      sessionName: "sess",
      sourceProfile: "--query=evil",
    } as never);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid sourceProfile name/);
    assert.match(r.error ?? "", /sourceProfile/);
  });

  it("rejects an INI-breaking targetProfile before touching ~/.aws/credentials", async () => {
    // The resolved targetProfile lands as a `[name]` section header in the
    // INI file. A `]` in the name would silently split the section. Catch
    // it at the handler boundary so the credentials file is never opened.
    // No fake-aws scenario needed: validation runs before runAwsCall.
    const r = await tool.handler({
      roleArn: "arn:aws:iam::123:role/A",
      sessionName: "sess",
      targetProfile: "mcp-evil]hack",
    } as never);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid targetProfile name/);
  });

  it("sends DurationSeconds/ExternalId/RoleArn/RoleSessionName via --cli-input-json and the source profile via --profile", async () => {
    // The handler routes assume-role params through --cli-input-json (no argv
    // positionals, so RoleArn/ExternalId can't pose as flags) and passes the
    // assuming identity as a separate --profile entry (assembled by
    // runAwsCall). The assume_role_echo_args fake writes the full argv to
    // AWS_MCP_FAKE_ARGV_OUT (side channel, since the handler discards
    // everything except Credentials/AssumedRoleUser) then emits a normal
    // success payload. Modeled on iam-simulate.test.ts's iam_sim_echo_argv
    // consumption: parse --cli-input-json, assert the PascalCase params reached
    // the CLI, and assert --profile carries the source profile.
    const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const sideChannelDir = mkdtempSync(join(tmpdir(), "aws-mcp-assume-argv-out-"));
    const argvOutPath = join(sideChannelDir, "argv.json");
    process.env.AWS_MCP_FAKE_ARGV_OUT = argvOutPath;
    process.env.AWS_MCP_FAKE_SCENARIO = "assume_role_echo_args";
    try {
      const r = await tool.handler({
        roleArn: "arn:aws:iam::123456789012:role/CrossAccountAdmin",
        sessionName: "echo-session",
        durationSeconds: 7200,
        externalId: "ext-12345",
        sourceProfile: "my-source",
      } as never);
      assert.equal(r.ok, true);
      const data = r.data as { sourceProfile: string };
      assert.equal(data.sourceProfile, "my-source");

      const argv = JSON.parse(readFileSync(argvOutPath, "utf-8")) as string[];

      // --cli-input-json carries the assume-role params in PascalCase.
      const cliInputIdx = argv.indexOf("--cli-input-json");
      assert.ok(cliInputIdx >= 0, "argv should contain --cli-input-json");
      const payloadRaw = argv[cliInputIdx + 1];
      assert.ok(typeof payloadRaw === "string", "--cli-input-json should be followed by a string");
      const payload = JSON.parse(payloadRaw) as {
        RoleArn?: string;
        RoleSessionName?: string;
        DurationSeconds?: number;
        ExternalId?: string;
      };
      assert.equal(payload.RoleArn, "arn:aws:iam::123456789012:role/CrossAccountAdmin");
      assert.equal(payload.RoleSessionName, "echo-session");
      assert.equal(payload.DurationSeconds, 7200);
      assert.equal(payload.ExternalId, "ext-12345");

      // --profile carries the source (assuming) profile.
      const profileIdx = argv.indexOf("--profile");
      assert.ok(profileIdx >= 0, "argv should contain --profile");
      assert.equal(argv[profileIdx + 1], "my-source");
    } finally {
      delete process.env.AWS_MCP_FAKE_ARGV_OUT;
      rmSync(sideChannelDir, { recursive: true, force: true });
    }
  });

  it("renders 'expire at unknown' and undefined expiration when the CLI omits Expiration", async () => {
    // assume_role_success_no_expiration returns a complete Credentials block
    // (AccessKeyId/SecretAccessKey/SessionToken) but NO Expiration. AWS always
    // sends Expiration in practice, but the handler reads it defensively
    // (creds.Expiration is optional). The envelope must carry
    // expiration===undefined and the hint must fall back to "expire at
    // unknown" rather than crashing or emitting a bogus value.
    process.env.AWS_MCP_FAKE_SCENARIO = "assume_role_success_no_expiration";
    const r = await tool.handler({
      roleArn: "arn:aws:iam::123456789012:role/Admin",
      sessionName: "no-exp-session",
    } as never);
    assert.equal(r.ok, true);
    const data = r.data as { expiration?: string; hint: string; assumedRoleArn?: string };
    assert.equal(data.expiration, undefined);
    assert.match(data.hint, /expire at unknown/);
    // AssumedRoleUser is present in the scenario, so identity still populates.
    assert.equal(data.assumedRoleArn, "arn:aws:sts::123456789012:assumed-role/Admin/no-exp-session");
  });

  it("propagates timeoutMs to the underlying CLI call (fires timeout path)", async () => {
    // assume_role_slow sleeps ~5s before responding. A 200ms timeoutMs has to
    // reach runAwsCall for the timeout error to surface inside that window;
    // if the handler ignored timeoutMs we'd hit the 120s default instead and
    // this test would either hang or eventually succeed.
    process.env.AWS_MCP_FAKE_SCENARIO = "assume_role_slow";
    const start = Date.now();
    const r = await tool.handler({
      roleArn: "arn:aws:iam::123:role/A",
      sessionName: "sess",
      timeoutMs: 200,
    } as never);
    const elapsed = Date.now() - start;
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /timed out/i);
    // Sanity check that the small timeout actually took effect rather than
    // waiting for the 5s sleep or the 120s default.
    assert.ok(elapsed < 4000, `expected fast timeout, got ${elapsed}ms`);
  });
});
