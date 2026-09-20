/**
 * cliArgParseHint against the AWS CLI v2 installed on this machine.
 *
 * The unit tests in call.test.ts replay captured stderr, which proves the
 * classifier reads those bytes correctly but can never notice the CLI changing
 * its wording. This suite closes that gap: it drives aws_call at a real CLI and
 * asserts the classification of whatever that CLI actually printed. If a future
 * release reworks argparse's sentence, the fake keeps passing and this fails.
 *
 * Every case dies in the CLI's own argument parser (exit 252), before botocore
 * builds a request -- so there is no stub, no endpoint override and no network.
 * isolateAwsEnv scrubs every AWS_* and PYTHON* variable, writes throwaway config
 * and credentials with fake static keys, and points anything not on the loopback
 * at a dead proxy. Per the shared real-CLI rules no case passes `command` or sets
 * AWS_MCP_TEST_AWS_COMMAND, so the CLI under test is the one runAwsCall picks.
 *
 * Opt-in like the other realcli suites (AWS_MCP_REAL_CLI_TESTS=1), even though
 * these cases are fast: they need a CLI installed, which a CI box may not have.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { detectRealAwsCli, type IsolatedAwsEnv, isolateAwsEnv, REAL_CLI_SLOW } from "../testing/real-cli.js";
import { callTools } from "./call.js";

const tool = callTools.find((t) => t.name === "aws_call");
if (!tool) throw new Error("callTools missing aws_call");

// Only probe for a CLI when the suite would actually run: detection spawns
// `aws --version`, and an opt-in suite should cost a skipped `npm test` nothing.
// No minVersion -- the argparse behavior this checks holds on every v2 (verified
// on 2.22.0 and 2.34.3).
const detected = REAL_CLI_SLOW ? detectRealAwsCli() : null;
const skip = !REAL_CLI_SLOW
  ? "set AWS_MCP_REAL_CLI_TESTS=1 to run the slow real-CLI suites"
  : detected?.ok
    ? false
    : (detected?.reason ?? "no AWS CLI v2");

type CallResult = { ok: boolean; error?: string; errorKind?: string; suggestion?: string; rawBody?: string };

describe(`aws_call parse-failure hint -- installed AWS CLI${detected?.ok ? ` (${detected.cli.versionLine})` : ""}`, {
  skip,
}, () => {
  let iso: IsolatedAwsEnv;
  const call = (input: Record<string, unknown>) => tool.handler(input) as Promise<CallResult>;

  before(() => {
    iso = isolateAwsEnv();
  });
  after(() => {
    iso?.restore();
  });

  it("tells a get-object call with params that the command cannot run here", async () => {
    // The defect: the CLI's own answer is `the following arguments are required:
    // --bucket, --key`, which names both values that WERE supplied.
    const r = await call({
      service: "s3api",
      operation: "get-object",
      params: { Bucket: "b", Key: "k" },
      profile: "default",
      region: "us-east-1",
    });
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, "nonzero_exit");
    assert.match(r.suggestion ?? "", /cannot run through aws_call/, `CLI stderr was: ${r.rawBody}`);
    assert.match(r.suggestion ?? "", /aws s3 cp s3:\/\/BUCKET\/KEY -/);
    // The remedy has to be in the message too, or toMcpResult never shows it.
    assert.ok((r.error ?? "").endsWith(`\n\nSuggestion: ${r.suggestion}`));
  });

  it("tells a head-object call with NO params to pass them by API member name", async () => {
    // Same required-arguments sentence, opposite meaning. On 2.34.3 the stderr
    // is byte-identical to the case above, so only `params` separates them.
    const r = await call({
      service: "s3api",
      operation: "head-object",
      profile: "default",
      region: "us-east-1",
    });
    assert.equal(r.ok, false);
    assert.match(r.suggestion ?? "", /sent no `params`/, `CLI stderr was: ${r.rawBody}`);
  });

  it("points a logs tail call at aws_logs_tail", async () => {
    // A hand-written BasicCommand, so the CLI answers `Unknown options:
    // --cli-input-json` rather than a required-arguments list.
    const r = await call({
      service: "logs",
      operation: "tail",
      params: { logGroupName: "g" },
      profile: "default",
      region: "us-east-1",
    });
    assert.equal(r.ok, false);
    assert.match(r.suggestion ?? "", /cannot run through aws_call/, `CLI stderr was: ${r.rawBody}`);
    assert.match(r.suggestion ?? "", /aws_logs_tail/);
  });

  // --- the invalid-choice remedy (parseAwsError's INVALID_CHOICE_RE) ---
  //
  // Same reason as the cases above, one file up the stack: the unit tests replay
  // captured argparse text, and only a real CLI notices AWS rewording it. All
  // three names below are misspellings of real ones, so no future release can
  // turn them valid and quietly stop exercising this path -- the remedy's other
  // half is "check the spelling", and this is that case. The newer-than-your-CLI
  // case has byte-identical stderr apart from the name: measured on this machine
  // on 2026-09-20 with `batch cancel-jobs` (Batch bulk cancel arrived in CLI
  // 2.36.44) against 2.34.3 and against the extracted 2.22.0, which prints the
  // pre-2.34 "Invalid choice, valid choices are:" wording instead.

  it("tells a call with an unknown OPERATION that the CLI does not have it", async () => {
    const r = await call({
      service: "batch",
      operation: "cancel-jobsx",
      profile: "default",
      region: "us-east-1",
    });
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, "nonzero_exit");
    assert.match(r.suggestion ?? "", /The installed aws CLI has no operation /, `CLI stderr was: ${r.rawBody}`);
    assert.match(r.suggestion ?? "", /Check the spelling/);
    assert.match(r.suggestion ?? "", /aws update/);
    assert.ok((r.error ?? "").endsWith(`\n\nSuggestion: ${r.suggestion}`));
  });

  it("calls argparse's `command` dest a SERVICE, which is what the caller passed", async () => {
    // 2.22.0 prints no name on this line (a ~17 KB service list instead), so the
    // assertion stops at the noun rather than the name.
    const r = await call({
      service: "batchx",
      operation: "cancel-job",
      profile: "default",
      region: "us-east-1",
    });
    assert.equal(r.ok, false);
    assert.match(r.suggestion ?? "", /The installed aws CLI has no service /, `CLI stderr was: ${r.rawBody}`);
  });

  it("covers the `subcommand` dest too, which is how waiters reject", async () => {
    // New waiters arrive with new CLIs, and `s3` and `configure` reject on this
    // same dest -- so a pattern that only knew `command` and `operation` would
    // miss a whole family.
    const r = await call({
      service: "ec2",
      operation: "wait instance-runningx",
      profile: "default",
      region: "us-east-1",
    });
    assert.equal(r.ok, false);
    assert.match(r.suggestion ?? "", /The installed aws CLI has no subcommand /, `CLI stderr was: ${r.rawBody}`);
  });

  it("never quotes aws_call's own params back as a misspelled subcommand", async () => {
    // `ec2 wait` is a subcommand GROUP, and a group's parser registers no
    // --cli-input-json (`aws ec2 wait help` lists it 0 times on 2.34.3, the leaf
    // `ec2 wait instance-running help` 3 times), so argparse reads the params
    // JSON as the missing positional and names it as the invalid choice. Only a
    // real CLI produces that, which is why the pin lives here: the fake has no
    // argument parser.
    const r = await call({
      service: "ec2",
      operation: "wait",
      params: { InstanceIds: ["i-1"] },
      profile: "default",
      region: "us-east-1",
    });
    assert.equal(r.ok, false);
    // Whatever this CLI printed, the payload never reaches the one-line remedy.
    assert.doesNotMatch(r.suggestion ?? "", /InstanceIds/, `CLI stderr was: ${r.rawBody}`);
    if (/Found invalid choice '\{/.test(r.rawBody ?? "")) {
      // 2.34.x names the choice, so the group remedy is reachable.
      assert.match(r.suggestion ?? "", /is a subcommand group, not an operation/);
      assert.match(r.suggestion ?? "", /wait instance-running/);
    } else {
      // 2.22.0's wording names no choice at all, so this shape is
      // indistinguishable from a mistyped waiter and keeps the spelling remedy.
      assert.match(r.suggestion ?? "", /The installed aws CLI has no subcommand by that name/);
    }
  });

  it("says nothing on a botocore validation failure, which already has its own remedy", async () => {
    // head-object WITH one of its two members: this one gets past argparse and
    // fails inside botocore, where parseAwsError's "Fix parameter shape" applies.
    // The hint must not compete with it.
    const r = await call({
      service: "s3api",
      operation: "head-object",
      params: { Bucket: "b" },
      profile: "default",
      region: "us-east-1",
    });
    assert.equal(r.ok, false);
    assert.match(r.rawBody ?? "", /Parameter validation failed/);
    assert.match(r.suggestion ?? "", /Fix parameter shape/);
    assert.doesNotMatch(r.suggestion ?? "", /cannot run through aws_call/);
  });
});
