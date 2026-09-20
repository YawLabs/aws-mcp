/**
 * Self-test for the real-CLI harness (real-cli.ts). Needs no AWS CLI: the one
 * case that uses a real CLI skips itself when none is installed.
 *
 * The harness is what keeps the real-CLI suites from reaching AWS or reading
 * the developer's credentials, so its scrub, its dead proxy and its restore are
 * asserted head-on here rather than trusted through a suite that happens to
 * pass.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Agent, request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  DEAD_PROXY_URL,
  detectRealAwsCli,
  FAKE_ACCESS_KEY_ID,
  isolateAwsEnv,
  meetsMinVersion,
  parseAwsCliVersion,
  startLoopbackStub,
} from "./real-cli.js";

/** process.env as sorted [name, value] pairs, spelling included. */
function envEntries(): [string, string][] {
  return Object.entries(process.env)
    .filter((e): e is [string, string] => e[1] !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Run `fn` with extra variables planted, and put process.env back afterwards whatever happens. */
function withPlantedEnv(planted: Record<string, string>, fn: () => void): void {
  const original = { ...process.env };
  try {
    for (const [key, value] of Object.entries(planted)) process.env[key] = value;
    fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!Object.hasOwn(original, key)) delete process.env[key];
    }
    Object.assign(process.env, original);
  }
}

/** POST `body` to the stub over a keep-alive agent; resolves with the status and response body. */
function post(
  url: string,
  path: string,
  body: string,
  agent: Agent,
): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      `${url}${path}`,
      { method: "POST", agent, headers: { "content-type": "text/plain", "x-probe": "real-cli-selftest" } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          text += c;
        });
        res.on("end", () => resolve({ status: res.statusCode, body: text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("isolateAwsEnv", () => {
  it("scrubs every AWS_*, PYTHON* and proxy variable whatever its spelling, and restore() puts back exactly what was there", () => {
    const planted: Record<string, string> = {
      aws_mcp_realcli_selftest_lower: "lower",
      AWS_MCP_REALCLI_SELFTEST_UPPER: "upper",
      AWS_MCP_TEST_AWS_COMMAND: "not-the-real-cli",
      AWS_PROFILE: "someone-elses-profile",
      AWS_ACCESS_KEY_ID: "planted-key-id",
      Https_Proxy: "http://proxy.invalid:3128",
      all_proxy: "socks5://proxy.invalid:1080",
      no_proxy: "example.invalid",
      PythonHome: "nowhere",
    };
    // POSIX names are case-sensitive, so both spellings can coexist there and
    // both must go. On Windows they are one variable.
    if (process.platform !== "win32") {
      planted.http_proxy = "http://lower.invalid:8080";
      planted.HTTP_PROXY = "http://upper.invalid:8080";
    }
    withPlantedEnv(planted, () => {
      const before = envEntries();
      const iso = isolateAwsEnv();
      try {
        const names = Object.keys(process.env);
        assert.deepEqual(
          names.filter((k) => k.toUpperCase().startsWith("PYTHON")),
          [],
          "every PYTHON* variable is gone",
        );
        assert.deepEqual(
          names.filter((k) => k.toUpperCase().startsWith("AWS_")).sort(),
          ["AWS_CONFIG_FILE", "AWS_EC2_METADATA_DISABLED", "AWS_PAGER", "AWS_REGION", "AWS_SHARED_CREDENTIALS_FILE"],
          "only the harness's own AWS_* variables are left",
        );
        assert.deepEqual(
          names.filter((k) => /^(HTTPS?|ALL|NO)_PROXY$/i.test(k)).sort(),
          ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"],
          "each proxy variable exists once, in the upper-case spelling the harness set",
        );
      } finally {
        iso.restore();
      }
      assert.deepEqual(envEntries(), before);
      assert.equal(existsSync(iso.dir), false, "restore() removes the temp dir");
      // Idempotent: a second restore (an `after` hook running after a test's
      // own finally, say) changes nothing.
      iso.restore();
      assert.deepEqual(envEntries(), before);
    });
  });

  it("routes everything but the loopback to a dead proxy and points the CLI at fake credentials", async () => {
    const iso = isolateAwsEnv();
    try {
      assert.equal(process.env.HTTP_PROXY, DEAD_PROXY_URL);
      assert.equal(process.env.HTTPS_PROXY, DEAD_PROXY_URL);
      assert.deepEqual(process.env.NO_PROXY?.split(","), ["127.0.0.1", "localhost"]);
      assert.equal(process.env.AWS_EC2_METADATA_DISABLED, "true");
      assert.equal(process.env.AWS_REGION, "us-east-1");
      assert.equal(process.env.AWS_PAGER, "");
      assert.equal(process.env.AWS_CONFIG_FILE, iso.configFile);
      assert.equal(process.env.AWS_SHARED_CREDENTIALS_FILE, iso.credentialsFile);
      assert.ok(iso.configFile.startsWith(iso.dir) && iso.credentialsFile.startsWith(iso.dir));
      assert.match(readFileSync(iso.configFile, "utf8"), /^\[default\]\nregion = us-east-1\n$/);
      const creds = readFileSync(iso.credentialsFile, "utf8");
      assert.match(creds, /^\[default\]\n/);
      assert.ok(creds.includes(`aws_access_key_id = ${FAKE_ACCESS_KEY_ID}\n`));
      assert.match(creds, /aws_secret_access_key = \S+\n/);

      // "Dead" has to be true, not just configured: if anything accepted a
      // connection on port 1, an escaped request would go wherever it forwards.
      const { port } = new URL(DEAD_PROXY_URL);
      const outcome = await new Promise<string>((resolve) => {
        const sock = connect(Number(port), "127.0.0.1");
        const timer = setTimeout(() => {
          sock.destroy();
          resolve("no answer");
        }, 10_000);
        sock.once("connect", () => {
          clearTimeout(timer);
          sock.destroy();
          resolve("connected");
        });
        sock.once("error", (err: NodeJS.ErrnoException) => {
          clearTimeout(timer);
          resolve(err.code ?? "error");
        });
      });
      assert.notEqual(outcome, "connected", `something is listening on ${DEAD_PROXY_URL}`);
    } finally {
      iso.restore();
    }
  });

  it("writes the config and credentials it is given, and applies `set` last", () => {
    const iso = isolateAwsEnv({
      config: "[profile other]\nregion = eu-west-1\n",
      credentials: "[other]\naws_access_key_id = X\naws_secret_access_key = Y\n",
      set: { AWS_REGION: "eu-west-1", AWS_MCP_REALCLI_SELFTEST_SET: "applied" },
    });
    try {
      assert.equal(readFileSync(iso.configFile, "utf8"), "[profile other]\nregion = eu-west-1\n");
      assert.equal(
        readFileSync(iso.credentialsFile, "utf8"),
        "[other]\naws_access_key_id = X\naws_secret_access_key = Y\n",
      );
      assert.equal(process.env.AWS_REGION, "eu-west-1", "`set` overrides the harness default");
      assert.equal(process.env.AWS_MCP_REALCLI_SELFTEST_SET, "applied");
    } finally {
      iso.restore();
    }
    assert.equal(process.env.AWS_MCP_REALCLI_SELFTEST_SET, undefined);
  });
});

describe("startLoopbackStub", () => {
  it("records every request before its handler answers, and close() does not wait on a keep-alive socket", async () => {
    const stub = await startLoopbackStub((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`seen ${req.method} ${req.path}`);
    });
    const agent = new Agent({ keepAlive: true });
    try {
      assert.match(stub.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.equal(stub.url, `http://127.0.0.1:${stub.port}`);

      const r = await post(stub.url, "/some/path?x=1", "hello stub", agent);
      assert.equal(r.status, 200);
      assert.equal(r.body, "seen POST /some/path?x=1");
      assert.equal(stub.requests.length, 1);
      const [seen] = stub.requests;
      assert.equal(seen.method, "POST");
      assert.equal(seen.path, "/some/path?x=1");
      assert.equal(seen.body, "hello stub");
      assert.equal(seen.headers["x-probe"], "real-cli-selftest");

      // The agent now holds an idle keep-alive socket. server.close() alone
      // would wait for it to time out; the race below fails if close() does.
      const closed = await Promise.race([
        stub.close().then(() => "closed"),
        new Promise<string>((resolve) => setTimeout(() => resolve("still open after 5s"), 5_000).unref()),
      ]);
      assert.equal(closed, "closed");
    } finally {
      agent.destroy();
      await stub.close();
    }
  });

  it("answers 500 when the handler throws, instead of leaving the request hanging", async () => {
    const stub = await startLoopbackStub(() => {
      throw new Error("handler bug");
    });
    const agent = new Agent();
    try {
      const r = await post(stub.url, "/", "x", agent);
      assert.equal(r.status, 500);
      assert.match(r.body, /handler bug/);
      assert.equal(stub.requests.length, 1, "the request is recorded even though the handler failed");
    } finally {
      agent.destroy();
      await stub.close();
    }
  });
});

describe("detectRealAwsCli", () => {
  it("parses the version line of AWS CLI v2 and v1, and nothing else", () => {
    assert.deepEqual(parseAwsCliVersion("aws-cli/2.34.3 Python/3.13.11 Windows/11 exe/ARM64\r\n"), {
      versionLine: "aws-cli/2.34.3 Python/3.13.11 Windows/11 exe/ARM64",
      version: [2, 34, 3],
    });
    assert.deepEqual(
      parseAwsCliVersion("\naws-cli/1.46.1 Python/3.12.3 Linux/6.8.0 botocore/1.40.1\n")?.version,
      [1, 46, 1],
    );
    assert.equal(parseAwsCliVersion("v22.22.2\n"), null);
    assert.equal(parseAwsCliVersion(""), null);
  });

  it("reports a missing CLI instead of throwing", () => {
    const empty = mkdtempSync(join(tmpdir(), "aws-mcp-realcli-nopath-"));
    try {
      const r = detectRealAwsCli({ env: { PATH: empty } });
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.reason, /^no aws(\.exe)? on PATH$/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("names an aws.cmd shim on PATH rather than claiming nothing is installed", {
    skip: process.platform !== "win32",
  }, () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-mcp-realcli-shim-"));
    try {
      writeFileSync(join(dir, "aws.cmd"), "@echo aws-cli/1.46.1 Python/3.12.3 Windows/11\r\n");
      const r = detectRealAwsCli({ env: { PATH: dir } });
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.ok(r.reason.includes(join(dir, "aws.cmd")), r.reason);
        assert.match(r.reason, /cannot be started without a shell/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compares versions component by component, so a minVersion gate is not string comparison", () => {
    // 2.9.15 vs 2.13.0 is the case a string or float comparison gets wrong,
    // and it is a real floor (a log-group ARN needs 2.9.15+).
    assert.equal(meetsMinVersion([2, 13, 0], [2, 9, 15]), true);
    assert.equal(meetsMinVersion([2, 9, 15], [2, 13, 0]), false);
    assert.equal(meetsMinVersion([2, 22, 0], [2, 24, 14]), false);
    assert.equal(meetsMinVersion([2, 34, 3], [2, 24, 14]), true);
    assert.equal(meetsMinVersion([2, 13, 0], [2, 13, 0]), true, "equal meets the floor");
    assert.equal(meetsMinVersion([2, 13, 0], [2, 13, 1]), false);
    assert.equal(meetsMinVersion([1, 46, 1], [2, 0, 0]), false);
  });

  // One spawn per `npm test`, and the only test here that needs a CLI. It is
  // worth it: if `aws --version` parsing ever broke, every real-CLI suite would
  // report itself skipped instead of failing, and nothing else would notice.
  const installed = detectRealAwsCli();
  it("finds the installed CLI and reports what a suite title needs", {
    skip: installed.ok ? false : `no AWS CLI v2 to check against (${installed.reason})`,
  }, () => {
    assert.ok(installed.ok);
    const { cli } = installed;
    assert.equal(cli.command, "aws", "a real-CLI call resolves the bare name itself");
    assert.equal(cli.version[0], 2);
    assert.ok(cli.versionLine.startsWith(`aws-cli/${cli.version.join(".")}`), cli.versionLine);
    const tooNew: [number, number, number] = [cli.version[0], cli.version[1], cli.version[2] + 1];
    assert.equal(meetsMinVersion(cli.version, tooNew), false, "the floor this CLI would miss");
  });
});
