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
 * The cases: the retry-exhausted throttle, which pins the
 * " (reached max retries: N)" infix in errors.ts against a live CLI, and the
 * settings a user can put in ~/.aws/config that break what this server reads --
 * each driven with that setting actually in a config file the CLI loads, which
 * is the only way to show the environment pins beat it.
 */

import assert from "node:assert/strict";
import { chmodSync, copyFileSync, linkSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { runAwsCall } from "./aws-cli.js";
import {
  detectRealAwsCli,
  type IsolatedAwsEnv,
  isolateAwsEnv,
  type LoopbackStub,
  meetsMinVersion,
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
const callerIdentityBody = (user: string) =>
  `<GetCallerIdentityResponse xmlns="${STS_XMLNS}"><GetCallerIdentityResult>` +
  `<Arn>arn:aws:iam::123456789012:user/${user}</Arn><UserId>AIDAAWSMCPREALCLI</UserId>` +
  "<Account>123456789012</Account></GetCallerIdentityResult>" +
  "<ResponseMetadata><RequestId>aws-mcp-realcli</RequestId></ResponseMetadata></GetCallerIdentityResponse>";
const CALLER_IDENTITY_BODY = callerIdentityBody("aws-mcp-realcli");
const THROTTLING_BODY =
  `<ErrorResponse xmlns="${STS_XMLNS}"><Error><Type>Sender</Type><Code>Throttling</Code>` +
  "<Message>Rate exceeded</Message></Error><RequestId>aws-mcp-realcli</RequestId></ErrorResponse>";
const authErrorBody = (code: string, message: string) =>
  `<ErrorResponse xmlns="${STS_XMLNS}"><Error><Type>Sender</Type><Code>${code}</Code>` +
  `<Message>${message}</Message></Error><RequestId>aws-mcp-realcli</RequestId></ErrorResponse>`;

/**
 * A name holding three kinds of character the Windows ANSI code page cannot
 * carry all of: one inside cp1252 (`é`), one outside it (CJK), and one outside
 * the BMP (`𠮷`, a surrogate pair in JS). Without the output-encoding pins the
 * first came back as U+FFFD with ok:true and the other two failed the call with
 * `'charmap' codec can't encode characters`.
 */
const UNICODE_USER = "Renée-日本-𠮷";

describe(`runAwsCall -- installed AWS CLI${detected?.ok ? ` (${detected.cli.versionLine})` : ""}`, { skip }, () => {
  let stub: LoopbackStub;
  let iso: IsolatedAwsEnv;
  let mode: "ok" | "throttle" | "invalid_token" | "expired_token" | "unicode" = "ok";

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
    stub = await startLoopbackStub((req, res) => {
      // DynamoDB speaks JSON 1.0 and names the operation in a header, so one
      // empty JSON document answers any of its calls. Only the large-params case
      // uses it, and what that case asserts is the REQUEST body.
      if (req.headers["x-amz-target"] !== undefined) {
        res.writeHead(200, { "content-type": "application/x-amz-json-1.0" });
        res.end("{}");
        return;
      }
      if (mode === "throttle") {
        res.writeHead(400, { "content-type": "text/xml" });
        res.end(THROTTLING_BODY);
        return;
      }
      if (mode === "invalid_token" || mode === "expired_token") {
        // The two auth codes whose classification the error-format pin exists
        // to keep: 403 is what STS answers for both.
        res.writeHead(403, { "content-type": "text/xml" });
        res.end(
          mode === "invalid_token"
            ? authErrorBody("InvalidClientTokenId", "The security token included in the request is invalid.")
            : authErrorBody("ExpiredToken", "The security token included in the request is expired."),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/xml" });
      // Explicit UTF-8: the bytes on the wire are what the CLI decodes, and the
      // point of the unicode case is what it does on the way back out.
      res.end(Buffer.from(mode === "unicode" ? callerIdentityBody(UNICODE_USER) : CALLER_IDENTITY_BODY, "utf8"));
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

  /**
   * Each case here puts the hostile setting in a config file the CLI really
   * loads, then shows the call works anyway -- which is the only way to prove an
   * environment pin beats `~/.aws/config`. isolateAwsEnv nests: it snapshots the
   * environment the outer `before` already isolated and restores exactly that,
   * so the stub and the outer credentials survive.
   */
  const withConfig = async (config: string | Buffer, fn: () => Promise<void>): Promise<void> => {
    const nested = isolateAwsEnv({ config: typeof config === "string" ? config : "" });
    // A Buffer goes to disk as its own bytes. isolateAwsEnv writes a string as
    // UTF-8, which is exactly the wrong thing for the legacy-code-page case
    // below -- it would test the UTF-8 file the CLI already accepts.
    if (typeof config !== "string") writeFileSync(nested.configFile, config);
    try {
      await fn();
    } finally {
      nested.restore();
    }
  };

  it("classifies a rejected token even when the config asks for the json error format", async () => {
    // AWS CLI 2.34.0's `cli_error_format` (json/yaml/text/table) removes the
    // "An error occurred (Code) when calling the Op operation:" line every
    // pattern in errors.ts anchors on. Without AWS_CLI_ERROR_FORMAT=enhanced in
    // the child env this comes back as a bare nonzero_exit with no remedy.
    // Older CLIs do not know the setting at all and answer in the legacy format,
    // so this passes there for a different reason -- the pin is what makes it
    // version-independent.
    await withConfig("[default]\nregion = us-east-1\ncli_error_format = json\n", async () => {
      mode = "invalid_token";
      const invalid = await callSts();
      mode = "expired_token";
      const expired = await callSts();
      mode = "ok";

      assert.equal(invalid.ok, false);
      assert.equal(expired.ok, false);
      if (invalid.ok || expired.ok) return;
      assert.equal(invalid.kind, "invalid_creds", `stderr was: ${invalid.rawStderr}`);
      assert.equal(expired.kind, "expired_creds", `stderr was: ${expired.rawStderr}`);
      assert.match(invalid.rawStderr ?? "", /An error occurred \(InvalidClientTokenId\)/, "the enhanced wrapper");
    });
  });

  it("still reaches AWS when the config turns the interactive prompt on", async () => {
    // `cli_auto_prompt = on` wants a console before the CLI does anything: both
    // installed CLIs exit 255 with "expecting a Windows console" and send
    // nothing at all, `aws sso login` included. AWS_CLI_AUTO_PROMPT=off in the
    // child env is what restores the call.
    await withConfig("[default]\nregion = us-east-1\ncli_auto_prompt = on\n", async () => {
      const seenBefore = stub.requests.length;
      const r = await callSts();
      assert.equal(r.ok, true, r.ok ? "" : `${r.kind}: ${r.error}`);
      assert.equal(stub.requests.length - seenBefore, 1, "auto-prompt would have sent nothing");
    });
  });

  it("returns non-ASCII output exactly, rather than U+FFFD or a charmap crash", async () => {
    // The Windows CLI writes the ANSI code page to a pipe, with errors="strict"
    // on stdout: a character outside it failed the whole call, and one inside it
    // came back as a replacement character with ok:true. The encoding pins
    // (AWS_CLI_OUTPUT_ENCODING on 2.24.14+, PYTHONUTF8 on older) are what make
    // this exact on every platform.
    mode = "unicode";
    const r = await callSts();
    mode = "ok";
    assert.equal(r.ok, true, r.ok ? "" : `${r.kind}: ${r.error} / ${r.rawStderr ?? ""}`);
    if (!r.ok) return;
    const arn = (r.data as { Arn: string }).Arn;
    assert.equal(arn, `arn:aws:iam::123456789012:user/${UNICODE_USER}`);
    assert.ok(!r.rawStdout.includes("�"), "the CLI's stdout must not carry replacement characters");
  });

  it("documents what PYTHONUTF8=1 does to a config file saved in the legacy code page", async () => {
    // The disclosed cost of the PYTHONUTF8 pin. CLIs before 2.25.0 are frozen
    // with a PyInstaller that applies UTF-8 mode to the whole interpreter, so
    // the pin also changes how ~/.aws/config is DECODED: a cp1252 byte there
    // stops parsing. 2.25.0 and later apply the setting to output only.
    //
    // Asserted both ways on purpose -- this is the one place the trade is
    // pinned, so a future change to it shows up as a failing test rather than a
    // silently different product.
    const legacyConfig = Buffer.concat([
      Buffer.from("[default]\nregion = us-east-1\n# caf", "ascii"),
      Buffer.from([0xe9]), // 'é' in cp1252, and not valid UTF-8 on its own
      Buffer.from("\n", "ascii"),
    ]);
    const modern = detected?.ok ? meetsMinVersion(detected.cli.version, [2, 25, 0]) : true;
    await withConfig(legacyConfig, async () => {
      const r = await callSts();
      if (modern) {
        assert.equal(r.ok, true, r.ok ? "" : `${r.kind}: ${r.error}`);
        return;
      }
      // Measured on 2.22.0: exit 255, `Unable to parse config file: <path>`,
      // with the same file read fine when PYTHONUTF8 is unset.
      assert.equal(r.ok, false, "a pre-2.25.0 CLI reads config as UTF-8 under PYTHONUTF8=1");
      if (r.ok) return;
      assert.equal(r.kind, "nonzero_exit");
      assert.match(r.error, /Unable to parse config file/i);
    });
  });

  it("sends 45 KB of non-ASCII params through the temp file and the endpoint gets them exactly", async () => {
    // The whole point of writing the file ASCII-escaped: the CLI reads a file://
    // param as TEXT in the locale's preferred encoding, so a plain UTF-8 file
    // turned café into cafÃ© on the wire. Driven through the real CLI because
    // that decoding is the real CLI's behavior -- no fake can stand in for it.
    const value = `café-日本-😀-${"x".repeat(45_000)}`;
    const params = { TableName: "aws-mcp-realcli", Item: { pk: { S: value } } };
    assert.ok(JSON.stringify(params).length > 8_192, "the payload has to exceed the inline cap");
    const seenBefore = stub.requests.length;
    const r = await runAwsCall({
      service: "dynamodb",
      operation: "put-item",
      params,
      prefixArgs: ["--endpoint-url", stub.url],
      profile: "default",
      region: "us-east-1",
      timeoutMs: 120_000,
    });
    assert.equal(r.ok, true, r.ok ? "" : `${r.kind}: ${r.error} / ${r.rawStderr ?? ""}`);
    const sent = stub.requests.slice(seenBefore).at(-1);
    assert.ok(sent, "the CLI never reached the stub");
    // The stub records the body decoded as UTF-8, which is what DynamoDB's JSON
    // protocol sends -- so an exact match here means the escapes survived the
    // CLI's own file read and its re-serialization.
    assert.deepEqual(JSON.parse(sent.body), params);
    // And `command` shows the payload's length, with no temp path in it.
    assert.ok(!(r.ok ? r.command : "").includes("file://"), r.ok ? r.command : "");
  });

  it("sends a blob param as the base64 it was given, even under cli_binary_format = raw-in-base64-out", async () => {
    // AWS's own advice for `aws lambda invoke --payload` is to set
    // `cli_binary_format = raw-in-base64-out`, and that setting makes the CLI
    // base64-encode a blob member AGAIN: measured on 2.34.3 and 2.22.0, `B:
    // "aGVsbG8="` went on the wire as `YUdWc2JHOD0=`, so AWS stored the base64
    // text instead of the bytes and nothing said so. It is config-only -- no
    // environment variable exists -- which is why this one pin is a flag.
    await withConfig("[default]\nregion = us-east-1\ncli_binary_format = raw-in-base64-out\n", async () => {
      const seenBefore = stub.requests.length;
      const r = await runAwsCall({
        service: "dynamodb",
        operation: "put-item",
        params: { TableName: "aws-mcp-realcli", Item: { pk: { S: "k" }, blob: { B: "aGVsbG8=" } } },
        prefixArgs: ["--endpoint-url", stub.url],
        profile: "default",
        region: "us-east-1",
        timeoutMs: 120_000,
      });
      assert.equal(r.ok, true, r.ok ? "" : `${r.kind}: ${r.error} / ${r.rawStderr ?? ""}`);
      const sent = stub.requests.slice(seenBefore).at(-1);
      assert.ok(sent, "the CLI never reached the stub");
      const body = JSON.parse(sent.body) as { Item: { blob: { B: string } } };
      assert.equal(body.Item.blob.B, "aGVsbG8=", "a second base64 pass would make this YUdWc2JHOD0=");
    });
  });

  it("runs the installed CLI even from a working directory holding an aws.exe", async () => {
    // The same planting shape as the integration test, but with the real CLI as
    // the thing that must win: nothing here passes `command`, the parent's
    // NoDefaultCurrentDirectoryInExePath is removed for the call, and the cwd
    // holds an `aws.exe` that is really this Node. If the planted one ran it
    // would die on "Cannot find module 'sts'" and the stub would see nothing.
    const plant = mkdtempSync(join(tmpdir(), "aws-mcp-realcli-plant-"));
    const binary = join(plant, process.platform === "win32" ? "aws.exe" : "aws");
    try {
      linkSync(process.execPath, binary);
    } catch {
      copyFileSync(process.execPath, binary);
      if (process.platform !== "win32") chmodSync(binary, 0o755);
    }
    const cwd = process.cwd();
    const savedNoDefault = process.env.NoDefaultCurrentDirectoryInExePath;
    const seenBefore = stub.requests.length;
    try {
      delete process.env.NoDefaultCurrentDirectoryInExePath;
      process.chdir(plant);
      const r = await callSts();
      assert.equal(r.ok, true, r.ok ? "" : `${r.kind}: ${r.error}`);
      if (!r.ok) return;
      assert.equal((r.data as { Account: string }).Account, "123456789012", "the stub's answer, so the real CLI ran");
      assert.equal(stub.requests.length - seenBefore, 1);
    } finally {
      process.chdir(cwd);
      if (savedNoDefault === undefined) delete process.env.NoDefaultCurrentDirectoryInExePath;
      else process.env.NoDefaultCurrentDirectoryInExePath = savedNoDefault;
      rmSync(plant, { recursive: true, force: true });
    }
  });
});
