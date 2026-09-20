/**
 * The paramfile guard's premise, checked against the AWS CLI v2 installed on
 * this machine: that the CLI replaces a command-line value beginning exactly
 * `file://` with the contents of that local file, and sends every near miss as
 * itself. The guard's regex is deliberately no wider than the CLI's own
 * `str.startswith`, and the error message says the CLI would read a file -- both
 * claims rest on the four cases below. A future CLI that normalized case, or
 * accepted a leading space, would reopen the hole this guard closes, and this
 * suite is what goes red on the first `npm test` run on that CLI.
 *
 * Default-on: four CLI starts, no timeouts and nothing to wait out, so it runs
 * on every `npm test` and skips only when there is no AWS CLI v2 to run. See
 * testing/real-cli.ts for why nothing here can reach AWS -- fake static keys, a
 * throwaway config, and a dead proxy for every address but the loopback. Per the
 * shared rules it passes no `command`, so the CLI under test is the one
 * runAwsCall picks for itself.
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { runAwsCall } from "./aws-cli.js";
import {
  detectRealAwsCli,
  type IsolatedAwsEnv,
  isolateAwsEnv,
  type LoopbackStub,
  startLoopbackStub,
} from "./testing/real-cli.js";

const detected = detectRealAwsCli();
const skip = detected.ok ? false : detected.reason;

// Shaped like nothing else in the repo, so a grep says at once whether a file's
// contents left the process.
const CANARY = "FURV-CANARY-7731";
const TYPE_NAME = "AWS::S3::Bucket";
// A well-formed GetResource answer, so the CLI exits 0 and every case reads as
// "what did the stub receive" rather than "did the response parse".
const GET_RESOURCE_BODY = JSON.stringify({
  TypeName: TYPE_NAME,
  ResourceDescription: {
    Identifier: "aws-mcp-param-file",
    Properties: JSON.stringify({ BucketName: "aws-mcp-param-file" }),
  },
});

describe(`paramfile guard -- installed AWS CLI${detected.ok ? ` (${detected.cli.versionLine})` : ""}`, { skip }, () => {
  let stub: LoopbackStub;
  let iso: IsolatedAwsEnv;
  let canaryPath: string;

  /** Cloud Control get-resource at the stub, with `identifier` as passed. */
  const getResource = (identifier: string, trustedParamFileArgs?: readonly string[]) =>
    runAwsCall({
      service: "cloudcontrol",
      operation: "get-resource",
      extraFlags: ["--type-name", TYPE_NAME, "--identifier", identifier],
      ...(trustedParamFileArgs ? { trustedParamFileArgs } : {}),
      prefixArgs: ["--endpoint-url", stub.url],
      profile: "default",
      region: "us-east-1",
      // Room for a cold CLI start on a machine busy with a parallel
      // `node --test` run; nothing here waits on a timeout.
      timeoutMs: 60_000,
    });

  /** The Identifier the CLI actually put on the wire (Cloud Control is JSON). */
  const identifierSent = (): string => {
    const last = stub.requests.at(-1);
    assert.ok(last, "expected a request to have reached the stub");
    return (JSON.parse(last.body) as { Identifier: string }).Identifier;
  };

  before(async () => {
    stub = await startLoopbackStub((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-amz-json-1.0" });
      res.end(GET_RESOURCE_BODY);
    });
    iso = isolateAwsEnv();
    canaryPath = join(iso.dir, "canary.txt");
    // No trailing newline: the expanded identifier is the file's bytes exactly,
    // and a newline would make the wire value differ from CANARY.
    writeFileSync(canaryPath, CANARY);

    // Preflight, per the shared real-CLI rules: prove the CLI reaches the stub
    // before any case counts requests. Otherwise a suite whose calls never
    // arrive passes every "zero requests" assertion without testing anything.
    const r = await getResource("aws-mcp-param-file");
    assert.equal(r.ok, true, `preflight call failed: ${r.ok ? "" : `${r.kind}: ${r.error}`}`);
    assert.ok(stub.requests.length >= 1, "preflight reached the stub");
    assert.equal(identifierSent(), "aws-mcp-param-file", "the identifier arrives as given");
  });

  after(async () => {
    iso?.restore();
    await stub?.close();
  });

  it("expands an exact file:// value and sends the file's contents -- the reason the guard exists", async (t) => {
    // The CLI runs expandvars on the path before reading it, so a temp dir
    // holding `$` or `%` would be rewritten and this case would measure the
    // wrong thing. Windows temp dirs do not normally contain either.
    if (/[$%]/.test(canaryPath)) {
      t.skip(`temp path contains $ or %, which the CLI's expandvars would rewrite: ${canaryPath}`);
      return;
    }
    const arg = `file://${canaryPath}`;
    // Trusted, so the guard lets it through: this is both halves of the
    // exemption -- the value reaches the CLI untouched, and the CLI does the
    // substitution the guard refuses for every other value.
    const r = await getResource(arg, [arg]);
    assert.equal(r.ok, true, `call failed: ${r.ok ? "" : `${r.kind}: ${r.error}`}`);
    assert.equal(identifierSent(), CANARY, "the CLI sent the file's contents as the identifier");
  });

  it("sends an upper-case FILE:// value literally -- the match is case-sensitive", async () => {
    const r = await getResource(`FILE://${canaryPath}`);
    assert.equal(r.ok, true, `call failed: ${r.ok ? "" : `${r.kind}: ${r.error}`}`);
    const sent = identifierSent();
    assert.equal(sent, `FILE://${canaryPath}`, "the identifier arrives unexpanded");
    assert.ok(!sent.includes(CANARY), "no file was read");
  });

  it("sends a leading-space ' file://' value literally -- the match is whitespace-free", async () => {
    const r = await getResource(` file://${canaryPath}`);
    assert.equal(r.ok, true, `call failed: ${r.ok ? "" : `${r.kind}: ${r.error}`}`);
    const sent = identifierSent();
    assert.equal(sent, ` file://${canaryPath}`, "the space survives argv and stops the expansion");
    assert.ok(!sent.includes(CANARY), "no file was read");
  });

  it("refuses an untrusted file:// value with ZERO requests to the stub", async () => {
    const seenBefore = stub.requests.length;
    const r = await getResource(`file://${canaryPath}`);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "bad_input");
    assert.match(r.error, /the value of --identifier/);
    assert.equal(stub.requests.length, seenBefore, "nothing was sent");
    assert.ok(!r.error.includes(CANARY), "the canary is not echoed back either");
  });
});
