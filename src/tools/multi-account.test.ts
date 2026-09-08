import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { _resetSession } from "../session.js";
import { multiAccountTools } from "./multi-account.js";
import type { ToolContext } from "./tool.js";

const tool = multiAccountTools.find((t) => t.name === "aws_multi_account");
if (!tool) throw new Error("multiAccountTools missing aws_multi_account");

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AWS = join(__dirname, "..", "testing", "fake-aws.js");

// Route every subprocess spawn at the fake aws shim via the documented test
// env-var hook (see aws-cli.ts). Without this the handler shells to the real
// aws binary, which the test environment doesn't have configured.
let prevCommand: string | undefined;
let prevPrefixArgs: string | undefined;
before(() => {
  prevCommand = process.env.AWS_MCP_TEST_AWS_COMMAND;
  prevPrefixArgs = process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS;
  process.env.AWS_MCP_TEST_AWS_COMMAND = process.execPath;
  process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS = JSON.stringify([FAKE_AWS]);
});
after(() => {
  if (prevCommand === undefined) delete process.env.AWS_MCP_TEST_AWS_COMMAND;
  else process.env.AWS_MCP_TEST_AWS_COMMAND = prevCommand;
  if (prevPrefixArgs === undefined) delete process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS;
  else process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS = prevPrefixArgs;
});

afterEach(() => {
  _resetSession();
});

const withScenario = async (scenario: string, fn: () => Promise<void>): Promise<void> => {
  const prev = process.env.AWS_MCP_FAKE_SCENARIO;
  process.env.AWS_MCP_FAKE_SCENARIO = scenario;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.AWS_MCP_FAKE_SCENARIO;
    else process.env.AWS_MCP_FAKE_SCENARIO = prev;
  }
};

interface AccountEntry {
  accountId: string;
  ok: boolean;
  data?: unknown;
  command?: string;
  error?: string;
  errorKind?: string;
  truncated?: boolean;
}

interface Envelope {
  service: string;
  operation: string;
  roleName: string;
  accountCount: number;
  okCount: number;
  errorCount: number;
  truncated?: boolean;
  truncatedAccounts?: string[];
  maxTotalResultBytes?: number;
  results: AccountEntry[];
}

const BASE = {
  service: "sts",
  operation: "get-caller-identity",
  roleName: "OrganizationAccountAccessRole",
  profile: "default",
  region: "us-east-1",
};

describe("aws_multi_account schema", () => {
  it("accepts a minimal call with two accounts", () => {
    const r = tool.inputSchema.safeParse({
      service: "sts",
      operation: "get-caller-identity",
      roleName: "Auditor",
      accounts: ["111111111111", "222222222222"],
    });
    assert.equal(r.success, true);
  });

  it("rejects an empty accounts array", () => {
    const r = tool.inputSchema.safeParse({
      service: "sts",
      operation: "get-caller-identity",
      roleName: "Auditor",
      accounts: [],
    });
    assert.equal(r.success, false);
  });

  it("rejects more than 32 accounts", () => {
    const accounts = Array.from({ length: 33 }, (_, n) => String(100000000000 + n));
    const r = tool.inputSchema.safeParse({
      service: "sts",
      operation: "get-caller-identity",
      roleName: "Auditor",
      accounts,
    });
    assert.equal(r.success, false);
  });

  it("rejects out-of-range concurrency", () => {
    const r = tool.inputSchema.safeParse({
      service: "sts",
      operation: "get-caller-identity",
      roleName: "Auditor",
      accounts: ["111111111111"],
      concurrency: 100,
    });
    assert.equal(r.success, false);
  });

  it("requires roleName -- there is no default role to assume", () => {
    const r = tool.inputSchema.safeParse({
      service: "sts",
      operation: "get-caller-identity",
      accounts: ["111111111111"],
    });
    assert.equal(r.success, false);
  });
});

describe("aws_multi_account -- credential plumbing", () => {
  it("hands each account its OWN session and keeps --profile off the operation argv", async () => {
    // The single most important behavioural assertion in this file. The
    // credentials reach the CLI through the environment, and botocore drops the
    // environment credential provider the moment an explicit profile is set --
    // so if `--profile` ever came back, every account would answer as the
    // OPERATOR's identity. That is a wrong answer, not an error: no failure
    // assertion anywhere else would catch it.
    await withScenario("macct_success", async () => {
      const res = await tool.handler({ ...BASE, accounts: ["111111111111", "222222222222"] } as never);
      assert.equal(res.ok, true);
      const data = res.data as Envelope;
      assert.equal(data.accountCount, 2);
      assert.equal(data.okCount, 2);
      assert.equal(data.errorCount, 0);

      for (const accountId of ["111111111111", "222222222222"]) {
        const entry = data.results.find((r) => r.accountId === accountId);
        assert.ok(entry, `missing entry for ${accountId}`);
        assert.equal(entry.ok, true);
        const payload = entry.data as { Account: string; SawProfileFlag: boolean; SessionTokenMatches: boolean };
        assert.equal(payload.Account, accountId, "the spawn ran on THIS account's assumed session");
        assert.equal(payload.SawProfileFlag, false, "--profile must not reach the per-account operation");
        assert.equal(payload.SessionTokenMatches, true, "the session token minted for this account is the one used");
      }
    });
  });

  it("does not name a profile in the returned command string", async () => {
    // Envelope-level counterpart to SawProfileFlag above: the caller can see for
    // itself that the call ran without a profile.
    await withScenario("macct_success", async () => {
      const res = await tool.handler({ ...BASE, accounts: ["111111111111"] } as never);
      const data = res.data as Envelope;
      const cmd = data.results[0]?.command ?? "";
      assert.ok(cmd.length > 0, "a successful entry still reports the command that ran");
      assert.ok(!cmd.includes("--profile"), `command must carry no --profile, got: ${cmd}`);
      assert.ok(cmd.includes("--region"), "the region flag is still passed");
    });
  });

  it("never writes the shared credentials file", async () => {
    // The headline correctness claim: aws_assume_role in a loop leaves live
    // credentials on disk for every account it touched, and a sweep killed
    // partway through leaves them there with nothing to clean up. This tool
    // holds them in memory, so a full batch must leave the credentials path
    // untouched -- here, still nonexistent.
    const dir = mkdtempSync(join(tmpdir(), "aws-mcp-macct-"));
    const credentialsPath = join(dir, "credentials");
    const prev = process.env.AWS_SHARED_CREDENTIALS_FILE;
    process.env.AWS_SHARED_CREDENTIALS_FILE = credentialsPath;
    try {
      await withScenario("macct_success", async () => {
        const res = await tool.handler({ ...BASE, accounts: ["111111111111", "222222222222"] } as never);
        assert.equal(res.ok, true);
        assert.equal((res.data as Envelope).okCount, 2, "the batch really ran");
      });
      assert.equal(existsSync(credentialsPath), false, "no profile section may be written for a fan-out");
    } finally {
      if (prev === undefined) delete process.env.AWS_SHARED_CREDENTIALS_FILE;
      else process.env.AWS_SHARED_CREDENTIALS_FILE = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("aws_multi_account -- credential hygiene", () => {
  it("keeps the assumed credentials out of command, error and rawBody even when the CLI dumps them", async () => {
    // macct_leaky_stderr writes the credentials it was handed to BOTH stdout and
    // stderr and then exits non-zero. Nothing real behaves that way; the point
    // is that the invariant holds against text this server is forwarding rather
    // than only against text it constructs.
    await withScenario("macct_leaky_stderr", async () => {
      const res = await tool.handler({ ...BASE, accounts: ["111111111111"] } as never);
      assert.equal(res.ok, true);
      const data = res.data as Envelope;
      const entry = data.results[0];
      assert.ok(entry);
      assert.equal(entry.ok, false);
      assert.equal(
        entry.errorKind,
        "nonzero_exit",
        "the scenario must NOT classify as an auth kind, or the handler's rewrite would drop the leaked text before the scrub ran",
      );

      // Serialize the WHOLE envelope, so the assertion covers fields a future
      // change might add as well as the ones checked individually below.
      const serialized = JSON.stringify(res);
      for (const secret of ["fake-secret-111111111111", "fake-token-111111111111", "ASIAFAKE111111111111"]) {
        assert.ok(!serialized.includes(secret), `credential material leaked into the response: ${secret}`);
      }
      // Positive control: the leak attempt really happened and really was
      // scrubbed, rather than the scenario silently not running.
      assert.ok(
        entry.error?.includes("<redacted assumed-role credential>"),
        `expected redaction stubs in the forwarded error, got: ${entry.error}`,
      );
      assert.equal(res.rawBody, undefined, "this tool never carries a raw body");
    });
  });
});

describe("aws_multi_account handler", () => {
  it("surfaces an assume failure and an operation failure side by side with a success", async () => {
    await withScenario("macct_partial_failure", async () => {
      const res = await tool.handler({
        ...BASE,
        accounts: ["111111111111", "222222222222", "333333333333"],
      } as never);
      assert.equal(res.ok, true);
      const data = res.data as Envelope;
      assert.equal(data.accountCount, 3);
      assert.equal(data.okCount, 1);
      assert.equal(data.errorCount, 2);
      assert.equal(data.roleName, "OrganizationAccountAccessRole");

      const good = data.results.find((r) => r.accountId === "111111111111");
      assert.equal(good?.ok, true);

      const assumeFailed = data.results.find((r) => r.accountId === "222222222222");
      assert.equal(assumeFailed?.ok, false);
      assert.equal(assumeFailed?.errorKind, "sso_expired");
      assert.ok(
        assumeFailed?.error?.startsWith("Could not assume arn:aws:iam::222222222222:role/"),
        `an assume failure must name the ARN it could not assume, got: ${assumeFailed?.error}`,
      );

      const callFailed = data.results.find((r) => r.accountId === "333333333333");
      assert.equal(callFailed?.ok, false);
      assert.equal(callFailed?.errorKind, "nonzero_exit");
      assert.ok(callFailed?.error?.includes("AccessDenied"), "the operation's own diagnostic survives");
      assert.ok(callFailed?.command, "a failed operation still reports the command that ran");
    });
  });

  it("fails a malformed account ID on its own entry without poisoning the batch", async () => {
    await withScenario("macct_success", async () => {
      const res = await tool.handler({ ...BASE, accounts: ["111111111111", "not-an-account"] } as never);
      assert.equal(res.ok, true);
      const data = res.data as Envelope;
      assert.equal(data.accountCount, 2);
      assert.equal(data.okCount, 1);
      assert.equal(data.errorCount, 1);
      const bad = data.results.find((r) => r.accountId === "not-an-account");
      assert.equal(bad?.ok, false);
      assert.equal(bad?.errorKind, "bad_input");
      assert.equal(bad?.command, undefined, "a rejected account ID must not spawn a CLI call");
      const good = data.results.find((r) => r.accountId === "111111111111");
      assert.equal(good?.ok, true);
    });
  });

  it("collapses duplicate account IDs, first occurrence wins", async () => {
    await withScenario("macct_success", async () => {
      const res = await tool.handler({
        ...BASE,
        accounts: ["111111111111", "222222222222", "111111111111"],
      } as never);
      const data = res.data as Envelope;
      assert.equal(data.accountCount, 2, "accountCount reports what was actually dispatched");
      assert.equal(data.results.length, 2);
      assert.deepEqual(
        data.results.map((r) => r.accountId),
        ["111111111111", "222222222222"],
      );
    });
  });
});

describe("aws_multi_account -- handler-level input guards", () => {
  // These bounds also exist in the schema; the handler re-checks them because
  // direct callers (the aws_script bridge, tests, future internal callers) never
  // pass through it.
  it("rejects more accounts than the cap, counting the RAW list", async () => {
    const accounts = Array.from({ length: 33 }, (_, n) => String(100000000000 + n));
    const res = await tool.handler({ ...BASE, accounts } as never);
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /Too many accounts: 33 requested, max 32/);
  });

  it("rejects a roleName that would not build a valid role ARN", async () => {
    const res = await tool.handler({ ...BASE, roleName: "bad role name", accounts: ["111111111111"] } as never);
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /Invalid roleName/);
  });

  it("accepts a path-qualified role name", () => {
    const r = tool.inputSchema.safeParse({
      service: "sts",
      operation: "get-caller-identity",
      roleName: "engineering/Auditor",
      accounts: ["111111111111"],
    });
    assert.equal(r.success, true);
  });

  it("rejects a sessionName outside the CloudTrail-safe charset", async () => {
    const res = await tool.handler({ ...BASE, sessionName: "bad session", accounts: ["111111111111"] } as never);
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /Invalid sessionName/);
  });

  it("rejects an argv-unsafe source profile, naming the argument", async () => {
    const res = await tool.handler({ ...BASE, profile: "--query=evil", accounts: ["111111111111"] } as never);
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /Invalid profile name/);
  });

  it("rejects a bad region ONCE for the batch rather than N times", async () => {
    const res = await tool.handler({
      ...BASE,
      region: "--profile-evil",
      accounts: ["111111111111", "222222222222"],
    } as never);
    assert.equal(res.ok, false, "a batch-wide input error is a batch-level failure, not N per-account ones");
    assert.match(res.error ?? "", /Invalid region/);
  });
});

describe("aws_multi_account -- aggregate cap", () => {
  it("drops over-budget payloads, names the accounts, and still counts what the CALLS did", async () => {
    // macct_big_payload emits ~2.75 MB per account (under the 5 MB per-CALL
    // stdout cap), so the second and third accounts cross the 5 MB aggregate
    // budget this tool shares with aws_multi_region.
    await withScenario("macct_big_payload", async () => {
      const res = await tool.handler({
        ...BASE,
        accounts: ["111111111111", "222222222222", "333333333333"],
      } as never);
      assert.equal(res.ok, true);
      const data = res.data as Envelope;

      assert.equal(data.truncated, true);
      assert.deepEqual(data.truncatedAccounts, ["222222222222", "333333333333"]);
      assert.equal(data.maxTotalResultBytes, 5 * 1024 * 1024);

      assert.equal(data.accountCount, 3);
      assert.equal(data.okCount, 3, "a truncated-but-successful call still counts as ok");
      assert.equal(data.errorCount, 0);

      const first = data.results.find((r) => r.accountId === "111111111111");
      assert.ok(first?.data, "the first account's payload fits and is kept");
      assert.equal(first?.truncated, undefined);

      const dropped = data.results.find((r) => r.accountId === "333333333333");
      assert.equal(dropped?.ok, true, "truncation must not restate a successful call as a failure");
      assert.equal(dropped?.truncated, true);
      assert.equal(dropped?.data, undefined, "the over-budget payload is dropped, not string-truncated");
      assert.equal(dropped?.accountId, "333333333333", "a truncated entry keeps the id the caller matches on");
    });
  });
});

describe("aws_multi_account -- progress reporting", () => {
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

  it("reports once per DEDUPED account, monotonically, with that count as the total", async () => {
    await withScenario("macct_success", async () => {
      const { ctx, calls } = recordingCtx();
      const res = await tool.handler(
        { ...BASE, accounts: ["111111111111", "222222222222", "111111111111"] } as never,
        ctx,
      );
      assert.equal(res.ok, true);
      assert.equal(calls.length, 2, "the duplicate is not dispatched, so it is not reported either");
      assert.deepEqual(
        calls.map((c) => c.progress),
        [1, 2],
      );
      for (const c of calls) {
        assert.equal(c.total, 2, "the denominator is the deduped count, matching accountCount");
      }
    });
  });

  it("survives a client whose progress sink throws", async () => {
    // runWithConcurrency's contract is that `fn` must always resolve; a throw
    // out of reportProgress would abandon every other in-flight account over a
    // notification.
    await withScenario("macct_success", async () => {
      const ctx: ToolContext = {
        reportProgress: () => {
          throw new Error("client hung up");
        },
      };
      const res = await tool.handler({ ...BASE, accounts: ["111111111111", "222222222222"] } as never, ctx);
      assert.equal(res.ok, true);
      assert.equal((res.data as Envelope).okCount, 2);
    });
  });
});
