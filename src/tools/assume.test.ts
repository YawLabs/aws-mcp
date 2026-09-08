import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { _resetSession } from "../session.js";
import { assumeTools } from "./assume.js";
import type { ToolContext } from "./tool.js";

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
      roleArn: "arn:aws:iam::123456789012:role/A",
      sessionName: "bad name/slash",
    });
    assert.equal(r.success, false);
  });

  it("rejects sessionName shorter than 2 chars", () => {
    const r = tool.inputSchema.safeParse({
      roleArn: "arn:aws:iam::123456789012:role/A",
      sessionName: "x",
    });
    assert.equal(r.success, false);
  });

  it("rejects durationSeconds below the STS minimum (900)", () => {
    const r = tool.inputSchema.safeParse({
      roleArn: "arn:aws:iam::123456789012:role/A",
      sessionName: "sess",
      durationSeconds: 300,
    });
    assert.equal(r.success, false);
  });

  it("rejects durationSeconds above the STS maximum (43200)", () => {
    const r = tool.inputSchema.safeParse({
      roleArn: "arn:aws:iam::123456789012:role/A",
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
      roleArn: "arn:aws:iam::123456789012:role/A",
      sessionName: "sess",
      timeoutMs: 180_000,
    });
    assert.equal(r.success, true);
  });

  it("rejects a non-positive timeoutMs", () => {
    const r = tool.inputSchema.safeParse({
      roleArn: "arn:aws:iam::123456789012:role/A",
      sessionName: "sess",
      timeoutMs: 0,
    });
    assert.equal(r.success, false);
  });

  // C6: roleArn schema-level validation
  it("rejects a malformed roleArn (plain string, no arn: prefix)", () => {
    const r = tool.inputSchema.safeParse({
      roleArn: "not-an-arn",
      sessionName: "sess",
    });
    assert.equal(r.success, false);
  });

  it("rejects a flag-shaped roleArn string", () => {
    const r = tool.inputSchema.safeParse({
      roleArn: "--role-arn=evil",
      sessionName: "sess",
    });
    assert.equal(r.success, false);
  });

  it("accepts a valid govcloud roleArn (arn:aws-us-gov partition)", () => {
    const r = tool.inputSchema.safeParse({
      roleArn: "arn:aws-us-gov:iam::123456789012:role/CrossAccountAdmin",
      sessionName: "sess",
    });
    assert.equal(r.success, true);
  });

  it("accepts a valid standard roleArn", () => {
    const r = tool.inputSchema.safeParse({
      roleArn: "arn:aws:iam::123456789012:role/CrossAccountAdmin",
      sessionName: "sess",
    });
    assert.equal(r.success, true);
  });

  // C5: sessionName fallback no-double-prefix guard
  it("sessionName='mcp-session' produces profile 'mcp-session', not 'mcp-mcp-session'", () => {
    // resolveTargetProfile must not double-prefix when the sessionName already
    // starts with 'mcp-'. The schema accepts mcp-session (valid chars); the
    // profile returned must be exactly 'mcp-session'.
    const r = tool.inputSchema.safeParse({
      roleArn: "arn:aws:iam::123456789012:role/Admin",
      sessionName: "mcp-session",
    });
    assert.equal(r.success, true, "schema should accept mcp-session as sessionName");
    // The profile name is only visible in the handler response, but we can
    // confirm the guard logic by checking the handler output directly.
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

  // C5: sessionName fallback no-double-prefix guard (handler level)
  it("sessionName='mcp-session' with no targetProfile yields profile='mcp-session', not 'mcp-mcp-session'", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "assume_role_success";
    const r = await tool.handler({
      roleArn: "arn:aws:iam::123456789012:role/Admin",
      sessionName: "mcp-session",
    } as never);
    assert.equal(r.ok, true);
    const data = r.data as { profile: string };
    assert.equal(data.profile, "mcp-session", "mcp-prefixed sessionName must not be double-prefixed");
  });

  // C6: roleArn handler-level validation (defense-in-depth, bypasses schema)
  it("rejects a malformed roleArn at the handler level with a descriptive error", async () => {
    // Direct handler call bypasses schema parsing; the handler must still
    // reject a bad ARN before touching runAwsCall.
    const r = await tool.handler({
      roleArn: "not-an-arn",
      sessionName: "sess",
    } as never);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid roleArn/);
    assert.match(r.error ?? "", /not-an-arn/);
  });

  it("rejects a flag-shaped roleArn at the handler level", async () => {
    const r = await tool.handler({
      roleArn: "--role-arn=evil",
      sessionName: "sess",
    } as never);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid roleArn/);
  });

  it("accepts a valid roleArn and proceeds to the AWS call", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "assume_role_success";
    const r = await tool.handler({
      roleArn: "arn:aws:iam::123456789012:role/CrossAccountAdmin",
      sessionName: "sess",
    } as never);
    assert.equal(r.ok, true);
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
      roleArn: "arn:aws:iam::123456789012:role/A",
      sessionName: "sess",
      sourceProfile: "my-source",
    } as never);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /source profile 'my-source'/);
    assert.match(r.error ?? "", /aws_login_start/);
  });

  it("rewrites invalid_creds errors to name the source profile, without offering a re-auth", async () => {
    // invalid_creds is the arm that sat between the two that existed: the
    // source profile's credentials RESOLVED and STS refused them (rotated or
    // deleted access key, wrong partition, drifted clock). No session exists
    // to refresh, so the sso_expired / expired_creds remedies are both wrong
    // advice here -- and the generic fallback says "profile 'x'", never
    // "source profile 'x'", which is the whole reason these arms exist.
    process.env.AWS_MCP_FAKE_SCENARIO = "res2_invalid_creds_stderr";
    const r = await tool.handler({
      roleArn: "arn:aws:iam::123456789012:role/A",
      sessionName: "sess",
      sourceProfile: "my-source",
    } as never);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /source profile 'my-source'/);
    assert.match(r.error ?? "", /rejected by AWS/);
    assert.match(r.error ?? "", /Fix the credentials for that profile/);
    assert.match(r.error ?? "", /Underlying error:/);
    // Wrong-remedy guards: not an expiry, not a missing profile.
    assert.doesNotMatch(r.error ?? "", /aws_login_start/);
    assert.doesNotMatch(r.error ?? "", /have expired/);
    assert.doesNotMatch(r.error ?? "", /No credentials found/);
  });

  // --- errorKind / suggestion forwarding (assume.ts's four failure returns) ---

  it("forwards the classified kind on all three rewritten credential arms", async () => {
    // These three arms REPLACE runAwsCall's message with a source-profile-aware
    // one and drop rawBody entirely (the assume-role stdout can carry secret
    // material). errorKind is therefore the ONLY surviving machine-readable
    // trace of what actually failed -- for aws_assume_role specifically, a
    // caller that wants to branch on the failure class has nothing else to read.
    for (const [scenario, kind] of [
      ["call_sso_expired", "sso_expired"],
      ["awscli_expired_token", "expired_creds"],
      ["res2_invalid_creds_stderr", "invalid_creds"],
    ] as const) {
      process.env.AWS_MCP_FAKE_SCENARIO = scenario;
      const r = (await tool.handler({
        roleArn: "arn:aws:iam::123456789012:role/A",
        sessionName: "sess",
        sourceProfile: "my-source",
      } as never)) as { ok: boolean; error?: string; errorKind?: string; suggestion?: string; rawBody?: string };
      assert.equal(r.ok, false, scenario);
      assert.equal(r.errorKind, kind, scenario);
      // Auth-class kinds never carry a suggestion: the arm's own prose IS the
      // remedy, and parseAwsError only runs on the nonzero_exit branch.
      assert.equal(r.suggestion, undefined, scenario);
      // Deliberately dropped on these arms -- pinned so a future "helpfully
      // restore rawBody" change has to be a conscious one.
      assert.equal(r.rawBody, undefined, scenario);
      assert.match(r.error ?? "", /source profile 'my-source'/, scenario);
    }
  });

  it("forwards nonzero_exit plus the parsed suggestion on the generic CLI-failure arm", async () => {
    // The fourth arm, the only one that passes runAwsCall's own message
    // through -- so it is also the only one that has a suggestion to carry.
    process.env.AWS_MCP_FAKE_SCENARIO = "assume_role_access_denied";
    const r = (await tool.handler({
      roleArn: "arn:aws:iam::999999999999:role/NoSuchRole",
      sessionName: "sess",
    } as never)) as { ok: boolean; error?: string; errorKind?: string; suggestion?: string; rawBody?: string };
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, "nonzero_exit");
    // parseAwsError's NOT_AUTHORIZED branch, which names the principal and the
    // action -- more specific than the bare AccessDenied remedy.
    assert.equal(
      r.suggestion,
      "Check IAM permissions: principal arn:aws:iam::123456789012:user/jeff lacks sts:AssumeRole.",
    );
    assert.ok(
      (r.error ?? "").endsWith(`\n\nSuggestion: ${r.suggestion}`),
      `error must still end with the suggestion sentence, got: ${r.error}`,
    );
    // This arm DOES keep stderr (never stdout -- that is where the credential
    // blob lands).
    assert.match(r.rawBody ?? "", /AccessDenied/);
  });

  it("leaves errorKind UNSET when the handler rejects a malformed roleArn before any CLI call", async () => {
    // NEGATIVE contract: the handler's own validation never reaches runAwsCall,
    // so nothing classified this. Absent means "unclassified" -- never
    // "nonzero_exit", and never a manufactured "bad_input".
    const r = (await tool.handler({ roleArn: "not-an-arn", sessionName: "sess" } as never)) as {
      ok: boolean;
      error?: string;
      errorKind?: string;
      suggestion?: string;
    };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid roleArn/);
    assert.equal(r.errorKind, undefined);
    assert.equal(r.suggestion, undefined);
  });

  it("guards against an incomplete Credentials block in CLI stdout", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "assume_role_incomplete";
    const r = await tool.handler({
      roleArn: "arn:aws:iam::123456789012:role/A",
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
      roleArn: "arn:aws:iam::123456789012:role/A",
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
      roleArn: "arn:aws:iam::123456789012:role/A",
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
      roleArn: "arn:aws:iam::123456789012:role/A",
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

  it("returns a friendly ToolResult when ~/.aws is not writable (EACCES; skipped on Windows)", async () => {
    // STS returns valid creds; the failure is purely on the local write path.
    // The handler must catch the EACCES that propagates out of upsertProfile
    // and surface the friendly 'Cannot write ... permission denied' message
    // -- otherwise the raw .lock-sidecar errno bubbles to errorToMcpResult and
    // the agent has no actionable hint for what went wrong.
    //
    // Skipped on Windows: chmod against an NTFS directory does not reliably
    // produce EACCES on a subsequent openSync via Node, so the scenario can
    // only be simulated portably on Unix. The friendly-error mapping itself
    // is platform-agnostic and exercised by the production path on either OS.
    if (platform() === "win32") return;

    // Use an isolated HOME so the chmod cannot leak to other tests in this
    // file (the shared `fakeHome` in the before() block stays untouched).
    const isolatedHome = mkdtempSync(join(tmpdir(), "aws-mcp-assume-eacces-"));
    const awsDir = join(isolatedHome, ".aws");
    mkdirSync(awsDir, { recursive: true });
    const savedHome = process.env.HOME;
    const savedUserprofile = process.env.USERPROFILE;
    process.env.HOME = isolatedHome;
    process.env.USERPROFILE = isolatedHome;

    try {
      // Deny all permissions on .aws: acquireLock's openSync(<path>.lock, 'wx')
      // hits EACCES, which upsertProfile rethrows synchronously.
      chmodSync(awsDir, 0o000);
      process.env.AWS_MCP_FAKE_SCENARIO = "assume_role_success";
      const r = await tool.handler({
        roleArn: "arn:aws:iam::123456789012:role/TestRole",
        sessionName: "eacces-test",
      } as never);
      assert.equal(r.ok, false);
      assert.match(r.error ?? "", /Cannot write/);
      assert.match(r.error ?? "", /permission denied/);
    } finally {
      // Restore perms before cleanup so rmSync can descend.
      try {
        chmodSync(awsDir, 0o700);
      } catch {
        // best-effort
      }
      process.env.HOME = savedHome;
      process.env.USERPROFILE = savedUserprofile;
      delete process.env.AWS_MCP_FAKE_SCENARIO;
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });
});

describe("aws_assume_role — credentials file location and overwrite warning", () => {
  let scratchDir: string;
  let savedSharedFile: string | undefined;

  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), "aws-mcp-assume-shared-"));
    savedSharedFile = process.env.AWS_SHARED_CREDENTIALS_FILE;
  });

  afterEach(() => {
    if (savedSharedFile === undefined) delete process.env.AWS_SHARED_CREDENTIALS_FILE;
    else process.env.AWS_SHARED_CREDENTIALS_FILE = savedSharedFile;
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it("writes to AWS_SHARED_CREDENTIALS_FILE when it is set, not to ~/.aws/credentials", async () => {
    // The handler previously hardcoded ~/.aws/credentials while its own EACCES
    // message told the user to set this variable. A user who had it set got the
    // profile written where the CLI never reads, so the returned hint named a
    // profile that did not exist from the CLI's point of view.
    const target = join(scratchDir, "custom-credentials");
    process.env.AWS_SHARED_CREDENTIALS_FILE = target;
    process.env.AWS_MCP_FAKE_SCENARIO = "assume_role_success";

    const r = await tool.handler({
      roleArn: "arn:aws:iam::123456789012:role/Admin",
      sessionName: "shared-file",
    } as never);

    assert.equal(r.ok, true);
    const data = r.data as { credentialsPath: string; profile: string; warning?: string };
    assert.equal(data.credentialsPath, target);
    assert.equal(data.profile, "mcp-shared-file");
    assert.match(readFileSync(target, "utf-8"), /\[mcp-shared-file\]/);
    assert.equal(data.warning, undefined, "a freshly-created profile must not carry the overwrite warning");

    // The default location must not have picked up this profile.
    const defaultPath = join(fakeHome, ".aws", "credentials");
    if (existsSync(defaultPath)) {
      assert.doesNotMatch(readFileSync(defaultPath, "utf-8"), /\[mcp-shared-file\]/);
    }
  });

  it("expands a leading ~ in AWS_SHARED_CREDENTIALS_FILE the way botocore does", async () => {
    // A literal "~" directory next to the cwd would be exactly the
    // write-here-read-there mismatch this change exists to remove.
    process.env.AWS_SHARED_CREDENTIALS_FILE = "~/tilde-credentials";
    process.env.AWS_MCP_FAKE_SCENARIO = "assume_role_success";

    const r = await tool.handler({
      roleArn: "arn:aws:iam::123456789012:role/Admin",
      sessionName: "tilde",
    } as never);

    assert.equal(r.ok, true);
    const expected = join(fakeHome, "tilde-credentials");
    const data = r.data as { credentialsPath: string };
    assert.equal(data.credentialsPath, expected);
    assert.match(readFileSync(expected, "utf-8"), /\[mcp-tilde\]/);
  });

  it("warns on the second assume into the same profile, since the managed keys are overwritten in place", async () => {
    // The 'mcp-' prefix is a naming convention, not a collision guard: the user
    // may keep their own mcp-* profile, and re-assuming with the same
    // sessionName lands on the same section either way.
    const target = join(scratchDir, "credentials");
    process.env.AWS_SHARED_CREDENTIALS_FILE = target;
    process.env.AWS_MCP_FAKE_SCENARIO = "assume_role_success";

    const first = await tool.handler({
      roleArn: "arn:aws:iam::123456789012:role/Admin",
      sessionName: "dup",
    } as never);
    assert.equal(first.ok, true);
    assert.equal((first.data as { warning?: string }).warning, undefined);

    const second = await tool.handler({
      roleArn: "arn:aws:iam::123456789012:role/Admin",
      sessionName: "dup",
    } as never);
    assert.equal(second.ok, true);
    const warning = (second.data as { warning?: string }).warning ?? "";
    assert.match(warning, /already existed/);
    assert.match(warning, /mcp-dup/);
    assert.match(warning, /overwritten/);

    // Still exactly one section -- the warning describes an in-place update.
    const text = readFileSync(target, "utf-8");
    assert.equal((text.match(/\[mcp-dup\]/g) ?? []).length, 1);
  });
});

describe("aws_assume_role -- progress reporting", () => {
  // One STS round-trip with a 120s default timeout: long enough that silence
  // reads as a hang, but with no internal step boundary to report. So there is
  // exactly ONE report, it happens up front, and it carries no total --
  // anything more would be manufactured.
  interface ProgressCall {
    progress: number;
    total?: number;
    message?: string;
  }
  const recordingCtx = (): { ctx: ToolContext; calls: ProgressCall[] } => {
    const calls: ProgressCall[] = [];
    return {
      ctx: {
        reportProgress: (progress, total, message) => {
          calls.push({ progress, total, message });
        },
      },
      calls,
    };
  };

  it("emits exactly one starting report, with no invented total", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "assume_role_success";
    const { ctx, calls } = recordingCtx();
    const r = await tool.handler(
      { roleArn: "arn:aws:iam::123456789012:role/Admin", sessionName: "progress-one", sourceProfile: "src-prof" },
      ctx,
    );

    assert.equal(r.ok, true);
    assert.equal(calls.length, 1, "one long call means one report -- no fabricated intermediate steps");
    assert.equal(calls[0].total, undefined, "a single indivisible call has no honest denominator");
    // Names the role and the assuming identity: what a human staring at a
    // stalled SAML round-trip needs to know.
    assert.match(calls[0].message ?? "", /sts:AssumeRole/);
    assert.match(calls[0].message ?? "", /arn:aws:iam::123456789012:role\/Admin/);
    assert.match(calls[0].message ?? "", /src-prof/);
  });

  it("quotes the same timeout the call actually uses", async () => {
    // The message reads as a promise about how long this can take, so it has
    // to come from the resolved timeout rather than a hardcoded 120.
    process.env.AWS_MCP_FAKE_SCENARIO = "assume_role_success";
    const withDefault = recordingCtx();
    await tool.handler(
      { roleArn: "arn:aws:iam::123456789012:role/Admin", sessionName: "progress-default" },
      withDefault.ctx,
    );
    assert.match(withDefault.calls[0].message ?? "", /timeout 120s/);

    const withOverride = recordingCtx();
    await tool.handler(
      { roleArn: "arn:aws:iam::123456789012:role/Admin", sessionName: "progress-override", timeoutMs: 5_000 },
      withOverride.ctx,
    );
    assert.match(withOverride.calls[0].message ?? "", /timeout 5s/);
  });

  it("reports before the call, so a FAILED assume still produced its one update", async () => {
    // Pins the report as a "starting" signal rather than a completion one: the
    // STS call is denied here, and the update must already have gone out.
    process.env.AWS_MCP_FAKE_SCENARIO = "assume_role_access_denied";
    const { ctx, calls } = recordingCtx();
    const r = await tool.handler(
      { roleArn: "arn:aws:iam::123456789012:role/Admin", sessionName: "progress-denied" },
      ctx,
    );

    assert.equal(r.ok, false);
    assert.equal(calls.length, 1, "the starting report does not depend on the outcome");
    assert.match(calls[0].message ?? "", /sts:AssumeRole/);
  });

  it("does not report before input validation rejects the call", async () => {
    // A call that never reaches STS should not announce that it is calling it.
    process.env.AWS_MCP_FAKE_SCENARIO = "assume_role_success";
    const { ctx, calls } = recordingCtx();
    const r = await tool.handler({ roleArn: "not-an-arn", sessionName: "progress-badarn" }, ctx);

    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid roleArn/);
    assert.equal(calls.length, 0, "validation failures short-circuit before the STS call and its report");
  });

  it("a no-op ctx (the no-progressToken path) changes nothing about the result", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "assume_role_success";
    // Distinct sessionNames so the second call is a fresh write rather than an
    // overwrite (which would add a `warning` key of its own); `profile` and
    // `hint` embed that name and are compared separately.
    const reported = await tool.handler(
      { roleArn: "arn:aws:iam::123456789012:role/Admin", sessionName: "noop-a" },
      { reportProgress: () => {} },
    );
    const bare = await tool.handler({ roleArn: "arn:aws:iam::123456789012:role/Admin", sessionName: "noop-b" });

    assert.equal(reported.ok, true);
    assert.equal(bare.ok, true);
    const strip = (r: { data?: unknown }): Record<string, unknown> => {
      const { profile, hint, ...rest } = r.data as Record<string, unknown>;
      return rest;
    };
    assert.deepEqual(strip(reported), strip(bare), "the envelope must not depend on whether progress was reported");
    assert.equal((reported.data as { profile: string }).profile, "mcp-noop-a");
    assert.equal((bare.data as { profile: string }).profile, "mcp-noop-b");
  });
});
