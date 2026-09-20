/**
 * runAwsCall against the AWS CLI v2 installed on this machine, pointed at a
 * loopback stub -- the check that the classifier reads the text the real CLI
 * actually writes, not the text the fake was told to write.
 *
 * Opt-in: this suite waits out the CLI's own retry backoff, so it needs
 * AWS_MCP_REAL_CLI_TESTS=1 (REAL_CLI_SLOW) on top of an installed CLI. The
 * harness in testing/real-cli.ts keeps it offline: fake static keys in a
 * throwaway credentials file, every AWS_* / PYTHON* variable scrubbed, and a
 * dead proxy for every address but the loopback. Per the shared rules it passes
 * no `command`, so the CLI it runs is the one runAwsCall picks for itself.
 *
 * One case for now -- the retry-exhausted throttle, which is what pins the
 * " (reached max retries: N)" infix in errors.ts against a live CLI. The
 * spawn-hardening package appends its own cases (pinned env, resolution, large
 * params) to this file.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { runAwsCall } from "./aws-cli.js";
import {
  detectRealAwsCli,
  type IsolatedAwsEnv,
  isolateAwsEnv,
  type LoopbackStub,
  REAL_CLI_SLOW,
  startLoopbackStub,
} from "./testing/real-cli.js";

// Only probe for a CLI when the suite would actually run: detection spawns
// `aws --version`, and an opt-in suite should cost a skipped `npm test` nothing.
const detected = REAL_CLI_SLOW ? detectRealAwsCli() : null;
const skip = !REAL_CLI_SLOW
  ? "set AWS_MCP_REAL_CLI_TESTS=1 to run the slow real-CLI suites"
  : detected?.ok
    ? false
    : (detected?.reason ?? "no AWS CLI v2");

const STS_XMLNS = "https://sts.amazonaws.com/doc/2011-06-15/";
const CALLER_IDENTITY_BODY =
  `<GetCallerIdentityResponse xmlns="${STS_XMLNS}"><GetCallerIdentityResult>` +
  "<Arn>arn:aws:iam::123456789012:user/aws-mcp-realcli</Arn><UserId>AIDAAWSMCPREALCLI</UserId>" +
  "<Account>123456789012</Account></GetCallerIdentityResult>" +
  "<ResponseMetadata><RequestId>aws-mcp-realcli</RequestId></ResponseMetadata></GetCallerIdentityResponse>";
const THROTTLING_BODY =
  `<ErrorResponse xmlns="${STS_XMLNS}"><Error><Type>Sender</Type><Code>Throttling</Code>` +
  "<Message>Rate exceeded</Message></Error><RequestId>aws-mcp-realcli</RequestId></ErrorResponse>";

describe(`runAwsCall -- installed AWS CLI${detected?.ok ? ` (${detected.cli.versionLine})` : ""}`, { skip }, () => {
  let stub: LoopbackStub;
  let iso: IsolatedAwsEnv;
  let mode: "ok" | "throttle" = "ok";

  /** Every call routes at the stub and passes no `command`. */
  const callSts = () =>
    runAwsCall({
      service: "sts",
      operation: "get-caller-identity",
      prefixArgs: ["--endpoint-url", stub.url],
      profile: "default",
      region: "us-east-1",
      // Room for a cold CLI start plus the CLI's own retry backoff on a busy
      // machine; nothing here is waiting on a timeout.
      timeoutMs: 120_000,
    });

  before(async () => {
    stub = await startLoopbackStub((_req, res) => {
      if (mode === "throttle") {
        res.writeHead(400, { "content-type": "text/xml" });
        res.end(THROTTLING_BODY);
        return;
      }
      res.writeHead(200, { "content-type": "text/xml" });
      res.end(CALLER_IDENTITY_BODY);
    });
    iso = isolateAwsEnv();

    // Preflight, per the shared real-CLI rules: prove the CLI reaches the
    // stub before any case counts requests. A failure here means the call
    // never arrived -- the dead proxy swallowed it, or the credentials did
    // not resolve -- and every request-count assertion below would pass
    // without testing anything.
    const r = await callSts();
    assert.equal(r.ok, true, `preflight call failed: ${r.ok ? "" : `${r.kind}: ${r.error}`}`);
    assert.ok(stub.requests.length >= 1, "preflight reached the stub");
    assert.deepEqual(
      r.ok ? (r.data as { Account: string }).Account : null,
      "123456789012",
      "the stub's answer is what came back",
    );
  });

  after(async () => {
    iso?.restore();
    await stub?.close();
  });

  it("keeps the code and the backoff suggestion when the CLI has used up its retries", async () => {
    mode = "throttle";
    const seenBefore = stub.requests.length;
    const r = await callSts();
    mode = "ok";

    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "nonzero_exit");
    // Default retry settings: nothing sets AWS_MAX_ATTEMPTS and the temp
    // config names no max_attempts, so the CLI sends three requests and
    // reports two retries.
    assert.equal(stub.requests.length - seenBefore, 3, "three attempts on the CLI's defaults");
    assert.match(r.rawStderr ?? "", /\(reached max retries: 2\)/, "the CLI still writes the retry infix");
    assert.match(r.suggestion ?? "", /Reduce request rate or retry with backoff\./);
    assert.match(r.suggestion ?? "", /already retried 2 times/);
    assert.match(r.error, /Suggestion: Reduce request rate/);
  });
});
