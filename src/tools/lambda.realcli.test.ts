/**
 * aws_lambda_invoke driven through the AWS CLI v2 installed on this machine,
 * against an Invoke endpoint inside this test process.
 *
 * This is the suite that can actually prove the fix. The fake CLI can only print
 * what it was told the real one prints, and the defect being fixed here lived
 * entirely in the real CLI's behavior: its 60-second socket read timeout, and the
 * retry that re-sent `Invoke` afterwards and ran somebody's function a second and
 * third time. Every case below asserts the number of requests the endpoint
 * received, because that count IS the bug.
 *
 * Opt-in: these cases wait out real read timeouts, so the suite needs
 * AWS_MCP_REAL_CLI_TESTS=1 (REAL_CLI_SLOW) on top of an installed CLI, and
 * `release.sh` sets it for its test step. It needs 2.13.0 or newer, the first CLI
 * that honors AWS_ENDPOINT_URL_<SERVICE> -- the handler exposes no endpoint knob,
 * deliberately, so that variable is how the call is routed at the stub (verified
 * working on 2.22.0 and 2.34.3).
 *
 * Nothing here can reach AWS. testing/real-cli.ts scrubs every AWS_* and PYTHON*
 * variable, writes throwaway config and credentials with fake static keys, and
 * points everything that is not the loopback at a dead proxy. Per the shared
 * rules no case passes `command` or sets AWS_MCP_TEST_AWS_COMMAND, so the CLI
 * under test is the one runAwsCall picks for itself.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  detectRealAwsCli,
  FAKE_ACCESS_KEY_ID,
  FAKE_SECRET_ACCESS_KEY,
  type IsolatedAwsEnv,
  isolateAwsEnv,
  type LoopbackStub,
  REAL_CLI_SLOW,
  startLoopbackStub,
} from "../testing/real-cli.js";
import { lambdaTools } from "./lambda.js";

const tool = lambdaTools.find((t) => t.name === "aws_lambda_invoke");
if (!tool) throw new Error("lambdaTools missing aws_lambda_invoke");

// A private temp root for this process, set before anything else runs.
//
// node --test runs each test FILE in its own process, in PARALLEL, and this file
// and lambda.test.ts both drive lambda.ts's
// mkdtempSync(join(tmpdir(), "aws-mcp-lambda-")) -- so the scan below, and the
// identical one there, see the other process's scratch dirs appear and vanish
// mid-assertion. With this suite opted in that failed 2 runs in 3 here, reported
// as "aws_lambda_invoke leaks a temp directory". os.tmpdir() re-reads TEMP/TMP
// (win32) / TMPDIR (POSIX) on every call, so pointing them at a private root
// makes both the handler's dirs and the scan process-local. Set before
// isolateAwsEnv: its snapshot then carries these three and restore() puts them
// back (it scrubs only AWS_*, PYTHON* and the proxy names).
const TMP_ROOT = mkdtempSync(join(tmpdir(), "aws-mcp-lambdatests-realcli-"));
const TMP_SNAPSHOT = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
process.env.TEMP = TMP_ROOT;
process.env.TMP = TMP_ROOT;
process.env.TMPDIR = TMP_ROOT;

after(() => {
  for (const [key, value] of Object.entries(TMP_SNAPSHOT)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

// Only probe for a CLI when the suite would actually run: detection spawns
// `aws --version`, and an opt-in suite should cost a skipped `npm test` nothing.
const detected = REAL_CLI_SLOW ? detectRealAwsCli({ minVersion: [2, 13, 0] }) : null;
const skip = !REAL_CLI_SLOW
  ? "set AWS_MCP_REAL_CLI_TESTS=1 to run the slow real-CLI suites"
  : detected?.ok
    ? false
    : (detected?.reason ?? "no AWS CLI v2");

type InvokeResult = {
  ok: boolean;
  data?: { statusCode?: number; payload?: unknown; logTail?: string; functionError?: string };
  error?: string;
  errorKind?: string;
  rawBody?: string;
  suggestion?: string;
};

const LOG_TAIL_TEXT = "START RequestId: realcli\nhello from the stub\nEND RequestId: realcli\n";
const LOG_RESULT = Buffer.from(LOG_TAIL_TEXT, "utf8").toString("base64");

/**
 * The handler's own scratch directories, by the prefix mkdtempSync is given --
 * inside this process's private temp root, so the sibling suite's dirs are not
 * in view.
 */
function lambdaTmpDirs(): string[] {
  return readdirSync(tmpdir())
    .filter((n) => n.startsWith("aws-mcp-lambda-"))
    .sort();
}

describe(`aws_lambda_invoke -- installed AWS CLI${detected?.ok ? ` (${detected.cli.versionLine})` : ""}`, {
  skip,
}, () => {
  let stub: LoopbackStub;
  let iso: IsolatedAwsEnv;
  let blackhole: NetServer;
  let dir: string;
  // Timers the slow branch arms, and the sockets the blackhole is still holding.
  // Both have to go in `after`, or the test process outlives the suite.
  const timers: NodeJS.Timeout[] = [];
  const hung: Socket[] = [];

  const invoke = (input: Record<string, unknown>) => tool.handler(input) as Promise<InvokeResult>;

  /** How many requests the Invoke endpoint received during `fn`. */
  async function countRequests(fn: () => Promise<InvokeResult>): Promise<{ r: InvokeResult; requests: number }> {
    const before = stub.requests.length;
    const r = await fn();
    return { r, requests: stub.requests.length - before };
  }

  before(async () => {
    // Behavior by function name, the same shapes the planning probes drove the
    // real CLI with: a 200 with the log-result header, a delayed 200, the two
    // error codes, and a socket dropped after the request was read.
    stub = await startLoopbackStub((req, res) => {
      const m = /\/functions\/([^/]+)\/invocations/.exec(req.path);
      const fn = m ? decodeURIComponent(m[1]) : "";
      const ok = () => {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-amz-executed-version": "$LATEST",
          "x-amz-log-result": LOG_RESULT,
        });
        res.end(JSON.stringify({ stub: true, fn }));
      };
      const err = (status: number, type: string, body: Record<string, unknown>) => {
        res.writeHead(status, { "content-type": "application/json", "x-amzn-errortype": type });
        res.end(JSON.stringify(body));
      };
      const slow = /^slow-(\d+)$/.exec(fn);
      if (slow) {
        // Held open on purpose: the CLI's --cli-read-timeout is what has to fire.
        timers.push(setTimeout(ok, Number(slow[1])));
        return;
      }
      if (fn === "throttle") {
        err(429, "TooManyRequestsException", {
          Type: "User",
          message: "Rate Exceeded.",
          Reason: "ConcurrentInvocationLimitExceeded",
        });
        return;
      }
      if (fn === "notfound") {
        err(404, "ResourceNotFoundException", {
          Type: "User",
          Message: "Function not found: arn:aws:lambda:us-east-1:123456789012:function:notfound",
        });
        return;
      }
      if (fn === "reset") {
        // The request arrived and is recorded; the response never does. This is
        // what the CLI reports as "Connection was closed before we received a
        // valid response", and what it used to send three times.
        res.socket?.destroy();
        return;
      }
      ok();
    });

    // Stands in for a credential endpoint that accepts the connection and never
    // answers -- a TCP listener that reads nothing and writes nothing.
    blackhole = createNetServer((socket) => {
      hung.push(socket);
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve, reject) => {
      blackhole.once("error", reject);
      blackhole.listen(0, "127.0.0.1", () => {
        blackhole.off("error", reject);
        resolve();
      });
    });
    const blackholePort = (blackhole.address() as { port: number }).port;

    // The credential_process helper has to exist before the config that names it,
    // so this directory is minted here rather than reusing the isolated env's.
    // NOT the `aws-mcp-lambda-` prefix: the handler's own scratch dirs are
    // counted by that prefix below.
    dir = mkdtempSync(join(tmpdir(), "aws-mcp-realcli-lambda-"));
    const wedged = join(dir, "wedged-credential-process.mjs");
    // Never answers, then exits on its own so no process is left behind when the
    // CLI above it is killed. The CLI starts it through its own shell-style
    // split, so the path is quoted and uses forward slashes.
    writeFileSync(wedged, "setTimeout(() => process.exit(1), 20_000);\n");
    const node = process.execPath.replace(/\\/g, "/");

    iso = isolateAwsEnv({
      // max_attempts = 5 is the load-bearing part: it is the caller's own retry
      // setting, and AWS_MAX_ATTEMPTS=1 has to beat it. Without the fix the
      // throttle case below sends five requests.
      config:
        "[profile realcli-static]\nregion = us-east-1\nmax_attempts = 5\n" +
        "[profile realcli-role]\nregion = us-east-1\n" +
        "role_arn = arn:aws:iam::123456789012:role/aws-mcp-realcli\nsource_profile = realcli-static\n" +
        `[profile realcli-slowcreds]\nregion = us-east-1\ncredential_process = "${node}" "${wedged.replace(/\\/g, "/")}"\n`,
      credentials: `[realcli-static]\naws_access_key_id = ${FAKE_ACCESS_KEY_ID}\naws_secret_access_key = ${FAKE_SECRET_ACCESS_KEY}\n`,
      set: {
        // The handler exposes no endpoint override, by design. These are how the
        // call is routed without one, and they are also why the suite needs
        // CLI 2.13.0.
        AWS_ENDPOINT_URL_LAMBDA: stub.url,
        AWS_ENDPOINT_URL_STS: `http://127.0.0.1:${blackholePort}`,
      },
    });

    // Preflight, per the shared real-CLI rules: prove the CLI reaches the stub
    // before any case counts requests. Otherwise every "zero requests" assertion
    // passes without testing anything.
    const r = await invoke({ functionName: "ok", profile: "realcli-static", region: "us-east-1" });
    assert.equal(r.ok, true, `preflight call failed: ${r.errorKind}: ${r.error}`);
    assert.ok(stub.requests.length >= 1, "preflight reached the stub");
  });

  after(async () => {
    for (const t of timers) clearTimeout(t);
    for (const s of hung) s.destroy();
    iso?.restore();
    await stub?.close();
    await new Promise<void>((resolve) => blackhole?.close(() => resolve()));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("returns the payload and the decoded log tail from ONE request", async () => {
    const { r, requests } = await countRequests(() =>
      invoke({ functionName: "ok", payload: { hello: "realcli" }, profile: "realcli-static", region: "us-east-1" }),
    );
    assert.equal(r.ok, true, `${r.errorKind}: ${r.error}`);
    assert.equal(requests, 1);
    assert.equal(r.data?.statusCode, 200);
    assert.deepEqual(r.data?.payload, { stub: true, fn: "ok" });
    // Decoded, not the base64 the API sends: the real CLI passes LogResult
    // through verbatim, so this is the round trip the tool exists for.
    assert.equal(r.data?.logTail, LOG_TAIL_TEXT);
    // The request really carried the payload the handler wrote to its temp file.
    assert.deepEqual(JSON.parse(stub.requests.at(-1)?.body ?? "null"), { hello: "realcli" });
  });

  it("sends $LATEST.PUBLISHED and a 256-char function name through to the endpoint", async () => {
    // The two validator limits, checked where it counts: against the real CLI and
    // the URL it builds. Both values used to be refused locally, before anything
    // spawned, so no CLI ever saw them.
    const published = await countRequests(() =>
      invoke({ functionName: "ok", qualifier: "$LATEST.PUBLISHED", profile: "realcli-static", region: "us-east-1" }),
    );
    assert.equal(published.r.ok, true, `${published.r.errorKind}: ${published.r.error}`);
    assert.equal(published.requests, 1);
    // The CLI percent-encodes the `$`; the dot travels as itself.
    assert.match(stub.requests.at(-1)?.path ?? "", /\?Qualifier=%24LATEST\.PUBLISHED$/);

    const longName = "a".repeat(256);
    const long = await countRequests(() =>
      invoke({ functionName: longName, profile: "realcli-static", region: "us-east-1" }),
    );
    assert.equal(long.r.ok, true, `${long.r.errorKind}: ${long.r.error}`);
    assert.equal(long.requests, 1);
    assert.ok(stub.requests.at(-1)?.path.includes(`/functions/${longName}/invocations`), "the whole name was sent");

    // And the half that must NOT reach a CLI: a qualifier the CLI would expand
    // into a local file's contents is refused with nothing sent.
    const refused = await countRequests(() =>
      invoke({ functionName: "ok", qualifier: "file://x", profile: "realcli-static", region: "us-east-1" }),
    );
    assert.equal(refused.r.ok, false);
    assert.equal(refused.requests, 0, "rejected before any process started");
    assert.match(refused.r.error ?? "", /Invalid qualifier/);
  });

  it("sends a slow invoke ONCE and reports the read timeout as a timeout that says so", async () => {
    // The whole defect, at the scale of a test: timeoutMs 1000 gives the CLI an
    // 11s read timeout, the function answers in 30s, and the CLI must report
    // rather than re-send. The huge backstop guarantees the CLI's own clock is
    // what fires, so this asserts the CLI's behavior and not ours.
    process.env.AWS_MCP_TEST_LAMBDA_SPAWN_TIMEOUT_MS = "120000";
    try {
      const { r, requests } = await countRequests(() =>
        invoke({ functionName: "slow-30000", timeoutMs: 1000, profile: "realcli-static", region: "us-east-1" }),
      );
      assert.equal(r.ok, false);
      assert.equal(requests, 1, "the invoke was sent exactly once");
      assert.equal(r.errorKind, "timeout", "a CLI read timeout used to arrive as nonzero_exit");
      assert.match(r.error ?? "", /sent once and not retried/);
      assert.match(r.error ?? "", /may still be running/);
      assert.match(r.rawBody ?? "", /Read timeout on endpoint URL/);
    } finally {
      delete process.env.AWS_MCP_TEST_LAMBDA_SPAWN_TIMEOUT_MS;
    }
  });

  it("does not retry a throttle, even under a profile asking for five attempts", async () => {
    const { r, requests } = await countRequests(() =>
      invoke({ functionName: "throttle", profile: "realcli-static", region: "us-east-1" }),
    );
    assert.equal(r.ok, false);
    assert.equal(requests, 1, "max_attempts = 5 in the profile must not win");
    assert.equal(r.errorKind, "nonzero_exit");
    assert.match(r.error ?? "", /TooManyRequestsException/);
    // The CLI's own proof that it ran with one attempt: botocore marks
    // MaxAttemptsReached on the first failure when max_attempts is 1, and the
    // classifier has to keep the remedy across that infix.
    assert.match(r.rawBody ?? "", /\(reached max retries: 0\)/);
    assert.match(r.suggestion ?? "", /Reduce request rate/);
  });

  it("does not retry a dropped connection, and says the call may have taken effect", async () => {
    const { r, requests } = await countRequests(() =>
      invoke({ functionName: "reset", profile: "realcli-static", region: "us-east-1" }),
    );
    assert.equal(r.ok, false);
    assert.equal(requests, 1, "every re-send of an invoke that reached Lambda is another run");
    assert.equal(r.errorKind, "nonzero_exit");
    assert.match(r.rawBody ?? "", /Connection was closed before we received a valid response/);
    assert.match(r.suggestion ?? "", /may or may not have taken effect/);
  });

  it("reports a hung credential endpoint as NOT invoked, with zero requests to Lambda", async () => {
    // The review's main finding, against the real CLI: --cli-read-timeout also
    // bounds the STS AssumeRole call of a role_arn profile, so this produces the
    // same "Read timeout on endpoint URL" sentence as the case above with nothing
    // sent to Lambda at all. Calling that "the function may still be running"
    // would stop a model retrying a call that never ran.
    process.env.AWS_MCP_TEST_LAMBDA_SPAWN_TIMEOUT_MS = "120000";
    try {
      const { r, requests } = await countRequests(() =>
        invoke({ functionName: "ok", timeoutMs: 1000, profile: "realcli-role", region: "us-east-1" }),
      );
      assert.equal(r.ok, false);
      assert.equal(requests, 0, "the invoke was never sent");
      assert.equal(r.errorKind, "timeout");
      assert.match(r.error ?? "", /was not invoked/);
      assert.doesNotMatch(r.error ?? "", /may still be running/);
      assert.match(r.suggestion ?? "", /Retrying is safe/);
    } finally {
      delete process.env.AWS_MCP_TEST_LAMBDA_SPAWN_TIMEOUT_MS;
    }
  });

  it("falls back to the kill when the CLI wedges before sending anything, and still cleans up", async () => {
    // A credential_process that never answers: the CLI is alive but has sent
    // nothing, and no read-timeout line is ever printed -- so the message must
    // claim neither "sent" nor "not sent". The override brings the backstop
    // forward from 75s to 3s.
    process.env.AWS_MCP_TEST_LAMBDA_SPAWN_TIMEOUT_MS = "3000";
    const dirsBefore = lambdaTmpDirs();
    try {
      const { r, requests } = await countRequests(() =>
        invoke({ functionName: "ok", payload: { k: 1 }, profile: "realcli-slowcreds", region: "us-east-1" }),
      );
      assert.equal(r.ok, false);
      assert.equal(requests, 0);
      assert.equal(r.errorKind, "timeout");
      assert.match(r.error ?? "", /may or may not have been sent/);
      // The kill path is exactly where a leftover scratch dir would hide, because
      // a killed CLI can still hold the outfile open on Windows.
      assert.deepEqual(lambdaTmpDirs(), dirsBefore);
    } finally {
      delete process.env.AWS_MCP_TEST_LAMBDA_SPAWN_TIMEOUT_MS;
    }
  });

  it("keeps the code, operation and remedy on a service error the single attempt reshapes", async () => {
    // AWS_MAX_ATTEMPTS=1 makes the CLI write "(reached max retries: 0)" on EVERY
    // Lambda service error, so without the classifier's infix the most common
    // Lambda mistake there is would lose its remedy.
    const { r, requests } = await countRequests(() =>
      invoke({ functionName: "notfound", profile: "realcli-static", region: "us-east-1" }),
    );
    assert.equal(r.ok, false);
    assert.equal(requests, 1);
    assert.equal(r.errorKind, "nonzero_exit");
    assert.match(r.error ?? "", /ResourceNotFoundException/);
    assert.match(r.rawBody ?? "", /\(reached max retries: 0\)/);
    assert.match(r.suggestion ?? "", /Verify the resource identifier/);
  });
});
