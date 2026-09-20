import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
  _resetParseTestPrefixArgsDedupe,
  isParamFileUri,
  paramFileUriMessage,
  parseTestPrefixArgs,
  redactDisplayArgs,
  runAwsCall,
  SAFE_NAME_RE,
  shellQuoteArg,
  truncateForErrorMsg,
} from "./aws-cli.js";

describe("SAFE_NAME_RE", () => {
  it("accepts typical kebab-case service/operation names", () => {
    for (const name of ["s3", "s3api", "ec2", "list-buckets", "get-caller-identity", "describe-log-streams"]) {
      assert.match(name, SAFE_NAME_RE, `expected ${name} to match`);
    }
  });

  it("rejects leading hyphens (argv-injection defense)", () => {
    assert.doesNotMatch("-s3", SAFE_NAME_RE);
    assert.doesNotMatch("--profile", SAFE_NAME_RE);
    assert.doesNotMatch("-", SAFE_NAME_RE);
  });

  it("rejects uppercase and whitespace", () => {
    assert.doesNotMatch("S3", SAFE_NAME_RE);
    assert.doesNotMatch("list_Buckets", SAFE_NAME_RE);
    assert.doesNotMatch("s3 api", SAFE_NAME_RE);
    assert.doesNotMatch("s3\tapi", SAFE_NAME_RE);
  });

  it("rejects shell-meaningful characters", () => {
    assert.doesNotMatch("s3;rm", SAFE_NAME_RE);
    assert.doesNotMatch("s3|cat", SAFE_NAME_RE);
    assert.doesNotMatch("s3$foo", SAFE_NAME_RE);
    assert.doesNotMatch("s3`echo`", SAFE_NAME_RE);
    assert.doesNotMatch("s3.api", SAFE_NAME_RE);
    assert.doesNotMatch("s3/api", SAFE_NAME_RE);
    assert.doesNotMatch("s3\\api", SAFE_NAME_RE);
  });

  it("rejects empty string", () => {
    assert.doesNotMatch("", SAFE_NAME_RE);
  });
});

describe("isParamFileUri", () => {
  // The predicate is the CLI's own `str.startswith`, no wider. Both halves
  // matter: too narrow and a value gets exfiltrated, too wide and the server
  // refuses input that reaches AWS as itself while claiming the CLI would read
  // a file. The false list below is exactly what 2.34.3 and 2.22.0 sent
  // literally to a loopback stub.

  it("matches the two prefixes the CLI expands, whatever follows", () => {
    for (const value of [
      "file://x",
      "fileb://x",
      "file://",
      "file://~/.aws/credentials",
      "file://$HOME/.aws/credentials",
      "file://%USERPROFILE%/.aws/credentials",
      "fileb://C:\\Users\\me\\.aws\\credentials",
    ]) {
      assert.equal(isParamFileUri(value), true, `expected ${JSON.stringify(value)} to match`);
    }
  });

  it("does not match near misses the CLI passes through literally", () => {
    for (const value of [
      "FILE://x", // the match is case-sensitive
      "File://x",
      "FILEB://x",
      " file://x", // and whitespace-free: a leading space survives argv
      "\tfile://x",
      '"file://x"', // a quoted filter pattern means the literal text
      "file:/x", // one slash is not the prefix
      "xfile://x",
      "my-file-bucket",
      "arn:aws:s3:::file-logs",
      "https://sqs.us-east-1.amazonaws.com/123456789012/q", // a real CCAPI identifier
      "key1:value1|key2:value2",
      "",
    ]) {
      assert.equal(isParamFileUri(value), false, `expected ${JSON.stringify(value)} not to match`);
    }
  });
});

describe("paramFileUriMessage", () => {
  it("names the field and says what the CLI would do", () => {
    const msg = paramFileUriMessage("identifier");
    assert.match(msg, /^Invalid identifier: must not start with 'file:\/\/'/);
    assert.match(msg, /contents of a local file/);
  });
});

describe("runAwsCall — input validation (no spawn)", () => {
  it("rejects invalid service name", async () => {
    const r = await runAwsCall({ service: "-s3", operation: "list-buckets" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "bad_input");
    assert.match(r.error, /Invalid service/);
  });

  it("rejects service containing shell metacharacters", async () => {
    const r = await runAwsCall({ service: "s3;rm -rf /", operation: "list-buckets" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "bad_input");
  });

  it("rejects operation that looks like a flag", async () => {
    const r = await runAwsCall({ service: "s3", operation: "--profile evil" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "bad_input");
    assert.match(r.error, /Invalid operation token/);
  });

  it("rejects empty operation", async () => {
    const r = await runAwsCall({ service: "s3", operation: "" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "bad_input");
  });

  it("rejects whitespace-only operation", async () => {
    const r = await runAwsCall({ service: "s3", operation: "   " });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "bad_input");
  });

  // Local commands that print secrets. Every case here must reject BEFORE a spawn:
  // the whole point is that nothing reads the credentials file, so a regression
  // that lets one through would print a real secret on a developer's machine.
  // AWS_MCP_TEST_AWS_COMMAND is pinned to a binary that cannot exist so that a
  // regression fails to spawn instead.
  describe("local credential-disclosure commands", () => {
    const realCommand = process.env.AWS_MCP_TEST_AWS_COMMAND;
    beforeEach(() => {
      process.env.AWS_MCP_TEST_AWS_COMMAND = "__no_such_binary_aws_mcp__";
    });
    afterEach(() => {
      if (realCommand === undefined) delete process.env.AWS_MCP_TEST_AWS_COMMAND;
      else process.env.AWS_MCP_TEST_AWS_COMMAND = realCommand;
    });

    for (const operation of ["export-credentials", "get"]) {
      it(`refuses configure ${operation}`, async () => {
        const r = await runAwsCall({ service: "configure", operation });
        assert.equal(r.ok, false);
        if (r.ok) return;
        assert.equal(r.kind, "bad_input");
        assert.match(r.error, new RegExp(`Refusing to run 'configure ${operation}'`));
        // The message has to say why no IAM policy helps here, because that is
        // the reason this guard exists at all.
        assert.match(r.error, /sends no request to AWS/);
      });
    }

    for (const operation of ["show", "list"]) {
      it(`refuses history ${operation}`, async () => {
        const r = await runAwsCall({ service: "history", operation });
        assert.equal(r.ok, false);
        if (r.ok) return;
        assert.equal(r.kind, "bad_input");
        assert.match(r.error, new RegExp(`Refusing to run 'history ${operation}'`));
      });
    }

    it("refuses the command however the caller spaces the operation", async () => {
      const r = await runAwsCall({ service: "configure", operation: "  export-credentials  " });
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.match(r.error, /Refusing to run 'configure export-credentials'/);
    });

    it("refuses it with trailing tokens, which the CLI would ignore", async () => {
      const r = await runAwsCall({ service: "configure", operation: "export-credentials json" });
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.match(r.error, /Refusing to run 'configure export-credentials'/);
    });

    it("leaves the rest of configure alone", async () => {
      // `configure list` masks all but the last four characters of a key, and is
      // how a caller is meant to see which profile resolved. It must still run:
      // spawning the pinned nonexistent binary is the proof it got past the guard.
      const r = await runAwsCall({ service: "configure", operation: "list" });
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.doesNotMatch(r.error, /Refusing to run/);
      assert.equal(r.kind, "spawn_failure");
    });

    it("does not refuse a real AWS operation whose name collides in another service", async () => {
      // `aws s3api list-buckets`-shaped traffic must be untouched; only the two
      // local services are listed, and the guard keys on both halves.
      const r = await runAwsCall({ service: "s3api", operation: "get" });
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.doesNotMatch(r.error, /Refusing to run/);
      assert.equal(r.kind, "spawn_failure");
    });
  });

  it("rejects profile that looks like a flag (argv-injection defense)", async () => {
    const r = await runAwsCall({ service: "s3", operation: "list-buckets", profile: "--query=foo" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "bad_input");
    assert.match(r.error, /Invalid profile name/);
  });

  it("rejects region that looks like a flag", async () => {
    const r = await runAwsCall({ service: "s3", operation: "list-buckets", region: "--profile=evil" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "bad_input");
    assert.match(r.error, /Invalid region/);
  });

  it("rejects profile with whitespace / newlines", async () => {
    const r = await runAwsCall({ service: "s3", operation: "list-buckets", profile: "evil\nname" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "bad_input");
    assert.match(r.error, /Invalid profile name/);
  });

  it("catches malicious AWS_PROFILE env var (resolved-value validation)", async () => {
    // setProfile validates at write time, but env vars bypass it -- getProfile
    // returns whatever AWS_PROFILE says. The validator inside runAwsCall is
    // the backstop that catches a hostile env-var fallback.
    const saved = process.env.AWS_PROFILE;
    process.env.AWS_PROFILE = "--query=evil";
    try {
      const r = await runAwsCall({ service: "s3", operation: "list-buckets" });
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.equal(r.kind, "bad_input");
      assert.match(r.error, /AWS_PROFILE/);
    } finally {
      if (saved === undefined) delete process.env.AWS_PROFILE;
      else process.env.AWS_PROFILE = saved;
    }
  });

  it("rejects query expressions longer than 2048 chars", async () => {
    const longQuery = "a".repeat(2049);
    const r = await runAwsCall({ service: "s3", operation: "list-buckets", query: longQuery });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "bad_input");
    assert.match(r.error, /query expression too long/);
    assert.match(r.error, /2049/);
  });

  it("accepts query expressions at exactly the 2048-char limit", async () => {
    // At exactly 2048 the validation passes; the call may still fail for other
    // reasons (no real CLI), but the rejection shape must NOT be bad_input.
    const exactQuery = "a".repeat(2048);
    const r = await runAwsCall({
      service: "s3",
      operation: "list-buckets",
      query: exactQuery,
      // Use a non-existent command so the call fails fast without touching
      // the real AWS CLI, but not as bad_input.
      command: "__no_such_binary__",
    });
    // The rejection may be spawn_failure or similar -- the important thing is
    // it is not bad_input from the length check.
    if (!r.ok) {
      assert.notEqual(r.kind, "bad_input", "2048-char query must not be rejected by the length cap");
    }
  });

  // The paramfile backstop. Every case below pins a command that cannot exist
  // AND a path that does not: a regression in the guard then shows up as
  // spawn_failure rather than sending the developer's own credentials file to
  // real AWS through their own profile.
  const NO_BINARY = "__no_such_binary__";
  const MISSING = "fileuri-definitely-missing";

  it("refuses a file:// extraFlags value and names the flag it belongs to", async () => {
    const r = await runAwsCall({
      service: "cloudcontrol",
      operation: "get-resource",
      extraFlags: ["--type-name", "AWS::S3::Bucket", "--identifier", `file://${MISSING}`],
      command: NO_BINARY,
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "bad_input");
    assert.match(r.error, /the value of --identifier/);
    assert.match(r.error, /file:\/\//);
  });

  it("refuses the fileb:// form the same way", async () => {
    const r = await runAwsCall({
      service: "cloudcontrol",
      operation: "get-resource",
      extraFlags: ["--type-name", "AWS::S3::Bucket", "--identifier", `fileb://${MISSING}`],
      command: NO_BINARY,
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "bad_input");
    assert.match(r.error, /the value of --identifier/);
  });

  it("refuses the combined --flag=file:// spelling, which the CLI expands the same way", async () => {
    // One argv entry, not two: the CLI runs its paramfile loader on the segment
    // after the first `=`, so this spelling reaches the endpoint as the file's
    // contents (verified on 2.34.3 against a loopback stub). No shipped tool
    // builds it -- the scan covers it so the first one that does is guarded.
    const r = await runAwsCall({
      service: "cloudcontrol",
      operation: "get-resource",
      extraFlags: ["--type-name", "AWS::S3::Bucket", `--identifier=file://${MISSING}`],
      command: NO_BINARY,
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "bad_input");
    assert.match(r.error, /the value of --identifier/);
    // The preview is the value the CLI would read, not the whole entry.
    assert.match(r.error, /Refusing 'file:\/\//);
  });

  it("lets the CLI's near misses through in the combined spelling too", async () => {
    // Same reason as the separate-entry near misses below: the loader's match on
    // the post-`=` segment is its own `str.startswith`, so these travel as
    // themselves (verified against the stub -- no file was read for either).
    for (const entry of [`--identifier=FILE://${MISSING}`, `--identifier=file:/${MISSING}`]) {
      const r = await runAwsCall({
        service: "cloudcontrol",
        operation: "get-resource",
        extraFlags: ["--type-name", "AWS::S3::Bucket", entry],
        command: NO_BINARY,
      });
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.equal(r.kind, "spawn_failure", `${JSON.stringify(entry)} must not be refused by the paramfile guard`);
    }
  });

  it("refuses a positional file:// entry, with no flag to name", async () => {
    const r = await runAwsCall({
      service: "s3api",
      operation: "list-buckets",
      extraFlags: [`file://${MISSING}`, "--format", "json"],
      command: NO_BINARY,
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "bad_input");
    assert.match(r.error, /a command-line argument/);
  });

  it("closes aws_logs_tail's filterPattern, which has no field-level reject of its own", async () => {
    // logs.ts passes filterPattern as an extraFlags entry, so until that tool
    // moves it into --cli-input-json this backstop is the whole defense for it.
    const r = await runAwsCall({
      service: "logs",
      operation: "tail",
      extraFlags: ["my-group", "--filter-pattern", `file://${MISSING}`],
      command: NO_BINARY,
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "bad_input");
    assert.match(r.error, /the value of --filter-pattern/);
  });

  it("exempts a trusted value by its exact string and keeps guarding the rest of the call", async () => {
    // The exemption is a value list, not a whole-call switch: lambda's own
    // --payload path passes, a caller-supplied --qualifier does not.
    const r = await runAwsCall({
      service: "lambda",
      operation: "invoke",
      extraFlags: ["--payload", "fileb://a", "--qualifier", "file://b"],
      trustedParamFileArgs: ["fileb://a"],
      command: NO_BINARY,
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "bad_input");
    assert.match(r.error, /the value of --qualifier/);
  });

  it("lets a trusted value through the guard", async () => {
    const r = await runAwsCall({
      service: "lambda",
      operation: "invoke",
      extraFlags: ["--payload", "fileb://a"],
      trustedParamFileArgs: ["fileb://a"],
      command: NO_BINARY,
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "spawn_failure", "the value cleared the guard and the pinned command failed to spawn");
  });

  it("exempts a trusted combined entry, listed the way the caller built it", async () => {
    // A caller that mints `--payload=fileb://<temp>` as one entry lists that
    // whole string, so the exemption has to be checked against the entry as well
    // as the value inside it.
    const r = await runAwsCall({
      service: "lambda",
      operation: "invoke",
      extraFlags: ["--payload=fileb://a"],
      trustedParamFileArgs: ["--payload=fileb://a"],
      command: NO_BINARY,
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "spawn_failure", "the entry cleared the guard and the pinned command failed to spawn");
  });

  it("lets the CLI's near misses through, because the CLI sends them as themselves", async () => {
    for (const value of ["FILE://x", " file://x", "file:/x"]) {
      const r = await runAwsCall({
        service: "cloudcontrol",
        operation: "get-resource",
        extraFlags: ["--type-name", "AWS::S3::Bucket", "--identifier", value],
        command: NO_BINARY,
      });
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.equal(r.kind, "spawn_failure", `${JSON.stringify(value)} must not be refused by the paramfile guard`);
    }
  });
});

describe("redactDisplayArgs", () => {
  it("replaces the value after --cli-input-json with a length stub", () => {
    const payload = JSON.stringify({ Password: "hunter2", Username: "admin" });
    const args = ["s3api", "put-object", "--cli-input-json", payload, "--profile", "prod"];
    const redacted = redactDisplayArgs(args);
    assert.ok(!redacted.some((a) => a.includes("hunter2")), "password must not appear");
    assert.ok(!redacted.some((a) => a.includes("admin")), "username must not appear");
    assert.equal(redacted[3], `<redacted len=${payload.length}>`);
    // Non-payload args pass through unchanged.
    assert.deepEqual(redacted.slice(0, 3), ["s3api", "put-object", "--cli-input-json"]);
    assert.deepEqual(redacted.slice(4), ["--profile", "prod"]);
  });

  it("returns the input unchanged when --cli-input-json is absent", () => {
    const args = ["s3api", "list-buckets", "--profile", "prod"];
    assert.deepEqual(redactDisplayArgs(args), args);
  });

  it("does not crash when --cli-input-json has no following token", () => {
    const args = ["s3api", "list-buckets", "--cli-input-json"];
    assert.deepEqual(redactDisplayArgs(args), args);
  });

  it("redacts ALL occurrences of --cli-input-json, not just the first", () => {
    // Both occurrences carry secrets; only redacting the first leaves the
    // second payload exposed in the displayCommand string.
    const payload1 = JSON.stringify({ SecretKey: "abc123" });
    const payload2 = JSON.stringify({ Password: "hunter2" });
    const args = [
      "s3api",
      "put-object",
      "--cli-input-json",
      payload1,
      "--cli-input-json",
      payload2,
      "--profile",
      "prod",
    ];
    const redacted = redactDisplayArgs(args);
    assert.ok(!redacted.some((a) => a.includes("abc123")), "first payload secret must not appear");
    assert.ok(!redacted.some((a) => a.includes("hunter2")), "second payload secret must not appear");
    assert.equal(redacted[3], `<redacted len=${payload1.length}>`);
    assert.equal(redacted[5], `<redacted len=${payload2.length}>`);
    // Flag tokens and other args pass through.
    assert.equal(redacted[2], "--cli-input-json");
    assert.equal(redacted[4], "--cli-input-json");
    assert.equal(redacted[6], "--profile");
    assert.equal(redacted[7], "prod");
  });
});

describe("shellQuoteArg", () => {
  // displayCommand is returned to the caller as `data.command`, and the caller
  // is an LLM -- which will paste it into a shell far more readily than a
  // human would. Joining raw argv on a space produced a string that either
  // failed to run or, with a metacharacter-bearing value, ran something else.

  it("leaves ordinary CLI tokens unquoted", () => {
    for (const safe of [
      "aws",
      "s3api",
      "list-buckets",
      "--profile",
      "--cli-input-json",
      "us-east-1",
      "org:account:role", // SSO profile names -- isValidProfileName permits ':'
      "user@company.com", // and '@'
      "/usr/local/bin/aws",
      "a.b,c+d=e",
    ]) {
      assert.equal(shellQuoteArg(safe), safe, `expected '${safe}' to need no quoting`);
    }
  });

  it("quotes values containing spaces", () => {
    assert.equal(shellQuoteArg("two words"), "'two words'");
    // The redaction stub itself has spaces and angle brackets.
    assert.equal(shellQuoteArg("<redacted len=42>"), "'<redacted len=42>'");
  });

  it("quotes shell metacharacters so a pasted command cannot execute them", () => {
    // The concrete hazard: --query takes arbitrary JMESPath and profile names
    // are permissive, so these reach displayCommand.
    assert.equal(shellQuoteArg("$(whoami)"), "'$(whoami)'");
    assert.equal(shellQuoteArg("a;rm -rf /"), "'a;rm -rf /'");
    assert.equal(shellQuoteArg("`id`"), "'`id`'");
    assert.equal(shellQuoteArg("a|b"), "'a|b'");
    assert.equal(shellQuoteArg("a&b"), "'a&b'");
    assert.equal(shellQuoteArg("$HOME"), "'$HOME'");
    assert.equal(shellQuoteArg("a>b"), "'a>b'");
  });

  it("quotes JMESPath expressions, which are full of shell-active characters", () => {
    assert.equal(shellQuoteArg("Buckets[].Name"), "'Buckets[].Name'");
    assert.equal(
      shellQuoteArg("Reservations[*].Instances[*].[InstanceId]"),
      "'Reservations[*].Instances[*].[InstanceId]'",
    );
  });

  it("escapes an embedded single quote with the POSIX close-escape-reopen idiom", () => {
    // Inside single quotes a POSIX shell expands nothing and there is no
    // escape character, so the only way to include one is to close, emit an
    // escaped quote, and reopen. Platform passed explicitly so both dialects are
    // asserted from either host -- there is no Mac here and only one Windows box,
    // so a default-platform assertion would test exactly one of the two branches.
    assert.equal(shellQuoteArg("it's", "linux"), `'it'\\''s'`);
    assert.equal(shellQuoteArg("'", "linux"), `''\\'''`);
    assert.equal(shellQuoteArg("it's", "darwin"), `'it'\\''s'`);
  });

  it("doubles an embedded single quote on win32, because PowerShell EXECUTES the POSIX idiom", () => {
    // The POSIX form is not merely wrong in PowerShell. Measured on win32/arm64,
    // PowerShell 5.1: a --query value of  x'; echo PWNED #  emitted as the POSIX
    // close-escape-reopen form tokenised into separate words, the ';' ended the
    // statement, and PWNED was PRINTED. PowerShell's own escape is to double the
    // quote, so that is what a Windows host emits.
    assert.equal(shellQuoteArg("it's", "win32"), `'it''s'`);
    assert.equal(shellQuoteArg("'", "win32"), `''''`);

    // The regression that matters: whatever the value, the win32 form must never
    // contain the backslash-quote sequence PowerShell breaks out of.
    for (const value of ["it's", "'", "x'; echo PWNED #", "a'b'c", `x' & echo PWNED`, `'; rm -rf / #`]) {
      const quoted = shellQuoteArg(value, "win32");
      assert.doesNotMatch(quoted, /\\'/, `win32 quoting of ${JSON.stringify(value)} must not emit \\' -- ${quoted}`);
      // And it stays one PowerShell string: an even number of quotes, opening and
      // closing included, is what makes the doubled form parse as a single token.
      assert.equal((quoted.match(/'/g) ?? []).length % 2, 0, `unbalanced quotes in ${quoted}`);
    }
  });

  it("is inert in bash even when it quoted for PowerShell", () => {
    // A Windows host's string pasted into Git Bash gets a WRONG value, not a
    // running command: 'a''b' is concatenation in POSIX, so the quote simply
    // disappears. Wrong-but-inert is the trade this makes deliberately.
    const quoted = shellQuoteArg("x'; echo PWNED #", "win32");
    assert.doesNotMatch(quoted, /\\/, "no backslashes, so bash has nothing to escape out of");
    assert.ok(quoted.startsWith("'") && quoted.endsWith("'"), quoted);
  });

  it("quotes an empty argv entry so it stays visible", () => {
    // An empty string joined raw would vanish from the display command.
    assert.equal(shellQuoteArg(""), "''");
  });

  it("quotes Windows paths (backslashes are shell-active on POSIX)", () => {
    assert.equal(
      shellQuoteArg("C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe"),
      "'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe'",
    );
  });
});

describe("truncateForErrorMsg", () => {
  it("returns input unchanged when under cap", () => {
    assert.equal(truncateForErrorMsg("short error"), "short error");
  });

  it("truncates and annotates long input", () => {
    const huge = "x".repeat(10 * 1024);
    const result = truncateForErrorMsg(huge);
    assert.ok(result.length < huge.length);
    assert.match(result, /\[truncated; \d+ chars omitted\]/);
  });

  it("does not split a surrogate pair at the cut boundary", () => {
    // Put a 4-byte astral char (2 UTF-16 units) so its HIGH surrogate sits at
    // index 8191 and its LOW surrogate at 8192 -- a naive slice(0, 8192) would
    // keep the high half alone and emit a lone surrogate.
    const head = "x".repeat(8 * 1024 - 1);
    const huge = `${head}\u{20BB7}${"y".repeat(100)}`;
    const result = truncateForErrorMsg(huge);
    const body = result.slice(0, result.indexOf("\n\n"));
    assert.ok(!/[\uD800-\uDBFF]$/.test(body), "must not end on a lone high surrogate");
    assert.equal(body, head, "backs off to just before the astral char");
    assert.match(result, /\[truncated; \d+ chars omitted\]/);
  });
});

describe("parseTestPrefixArgs", () => {
  // The dedupe set is module-level state; clear it between tests so each
  // case starts from a clean "no values warned yet" baseline.
  afterEach(() => {
    _resetParseTestPrefixArgsDedupe();
    mock.restoreAll();
  });

  it("returns undefined for undefined input without warning", () => {
    const warn = mock.method(console, "warn", () => {});
    assert.equal(parseTestPrefixArgs(undefined), undefined);
    assert.equal(warn.mock.callCount(), 0);
  });

  it("returns undefined for malformed JSON and warns once", () => {
    const warn = mock.method(console, "warn", () => {});
    assert.equal(parseTestPrefixArgs("{not json"), undefined);
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0] as string, /isn't valid JSON/);
  });

  it("returns undefined for valid JSON that is not a string array", () => {
    const warn = mock.method(console, "warn", () => {});
    // Object payload -- valid JSON, wrong shape.
    assert.equal(parseTestPrefixArgs('{"foo":"bar"}'), undefined);
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0] as string, /must parse to a string array/);
  });

  it("returns undefined for a JSON array containing a non-string element", () => {
    const warn = mock.method(console, "warn", () => {});
    assert.equal(parseTestPrefixArgs('["ok", 42]'), undefined);
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0] as string, /must parse to a string array/);
  });

  it("dedupes per malformed value: same input called twice warns ONCE total", () => {
    const warn = mock.method(console, "warn", () => {});
    parseTestPrefixArgs("{not json");
    parseTestPrefixArgs("{not json");
    parseTestPrefixArgs("{not json");
    assert.equal(warn.mock.callCount(), 1, "expected exactly one warn for repeated identical malformed input");
  });

  it("warns again for a NEW malformed value even when a different value was malformed earlier", () => {
    // Closes the "warn-once is per-value, not per-process" property: an
    // earlier malformed value should not silence the warn for a fresh one.
    const warn = mock.method(console, "warn", () => {});
    parseTestPrefixArgs("{not json");
    assert.equal(warn.mock.callCount(), 1);
    parseTestPrefixArgs('{"foo":"bar"}'); // different malformed value
    assert.equal(warn.mock.callCount(), 2, "expected a fresh warn for a new malformed value");
    parseTestPrefixArgs('{"foo":"bar"}'); // and that new value is now itself deduped
    assert.equal(warn.mock.callCount(), 2);
  });

  it("returns the parsed array for a valid string-array JSON without warning", () => {
    const warn = mock.method(console, "warn", () => {});
    assert.deepEqual(parseTestPrefixArgs('["a","b"]'), ["a", "b"]);
    assert.equal(warn.mock.callCount(), 0);
  });
});

describe("redactDisplayArgs -- CCAPI payload flags (regression)", () => {
  // The CCAPI tools in tools/resource.ts do NOT go through --cli-input-json;
  // they pass payloads as dedicated flags via extraFlags. Only --cli-input-json
  // was redacted, so aws_resource_create on an AWS::SSM::Parameter echoed the
  // SecureString Value straight back to the caller in `data.command`.
  for (const flag of ["--desired-state", "--patch-document", "--resource-model"]) {
    it(`redacts the payload after ${flag}`, () => {
      const payload = JSON.stringify({ Name: "/prod/db", Type: "SecureString", Value: "hunter2" });
      const args = ["cloudcontrol", "create-resource", flag, payload, "--profile", "prod"];
      const redacted = redactDisplayArgs(args);
      assert.ok(!redacted.some((a) => a.includes("hunter2")), `${flag} payload must not appear`);
      assert.equal(redacted[3], `<redacted len=${payload.length}>`);
      // The flag itself stays visible so the command shape is still readable.
      assert.equal(redacted[2], flag);
      assert.deepEqual(redacted.slice(4), ["--profile", "prod"]);
    });
  }

  it("leaves non-payload flags alone", () => {
    const args = ["cloudcontrol", "get-resource", "--type-name", "AWS::S3::Bucket", "--identifier", "my-bucket"];
    assert.deepEqual(redactDisplayArgs(args), args);
  });
});

describe("runAwsCall — a child killed by a signal exits with code === null", () => {
  // Bypass command resolution with the explicit-command seam resolveAwsCommand
  // documents ("verbatim, no checks: these are in-process test seams"). spawn is
  // mocked here so the value is never executed -- but resolution runs BEFORE the
  // spawn, so without this the suite depends on an aws being findable on PATH and
  // settles spawn_failure ("Could not find the AWS CLI") on any machine without
  // one. That is a normal state for a contributor running unit tests, and it is
  // new in 2.4.0: before the resolver landed, the mocked spawn was reached
  // directly. Measured in WSL Ubuntu (linux/arm64, no aws installed), where these
  // two were the only failures in the entire compiled suite.
  const STUB_COMMAND = "aws-mcp-signal-kill-stub";

  // Every other failure test in this suite carries a NUMERIC exit code (255 or
  // 1), so the nonzero_exit fallback message -- which interpolates `code` --
  // had only ever rendered with a number. A child killed by a signal reaches
  // the same branch with code === null, because that is how Node reports a
  // signal death on 'close'.
  //
  // Why this substitutes spawn instead of using the fake aws binary: Node only
  // maps a death to `code: null, signal: 'SIGTERM'` when the kill went through
  // the spawning handle (child.kill()). runAwsCall's own killProc sites both
  // set timedOut / tooLarge first, so they settle as timeout /
  // output_too_large and never reach this branch. An EXTERNAL signal does
  // produce code === null on POSIX (an OOM kill of `aws`, an operator's
  // `kill -9`), but on Windows an external kill arrives as a numeric exit
  // status -- measured on this machine: `process.kill(pid, 'SIGTERM')` from
  // another process, and a self-signal from the child itself, both land as
  // code 1, signal null. A self-signalling fake would therefore cover nothing
  // on the platform this suite usually runs on. Substituting the spawn makes
  // the branch reachable on every platform, deterministically.

  /** Minimal stand-in for the ChildProcess surface runAwsCall touches: the two
   * pipe emitters, the 'error' / 'exit' / 'close' events, and the exitCode /
   * signalCode pair procHasExited reads. Emits a signal death one tick later
   * so the caller's listeners are attached first. */
  function signalKilledSpawn(stderrText: string) {
    return () => {
      const proc = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        // What libuv reports for a signal death: no exit status, a signal name.
        exitCode: null as number | null,
        signalCode: "SIGKILL" as string | null,
        kill: () => true,
      });
      setImmediate(() => {
        if (stderrText) proc.stderr.emit("data", Buffer.from(stderrText, "utf8"));
        proc.emit("exit", null, "SIGKILL");
        proc.emit("close", null, "SIGKILL");
      });
      return proc;
    };
  }

  async function withMockedSpawn<T>(impl: ReturnType<typeof signalKilledSpawn>, fn: () => Promise<T>): Promise<T> {
    const cp = childProcess as { spawn: typeof childProcess.spawn };
    const original = cp.spawn;
    cp.spawn = impl as unknown as typeof childProcess.spawn;
    // aws-cli.ts does `import { spawn } from "node:child_process"`, and the ESM
    // named binding for a builtin is a snapshot of the CJS export -- it has to
    // be re-synced for the substitution to be visible on the other side of that
    // import (and again on the way out, or the stub leaks to later tests).
    syncBuiltinESMExports();
    try {
      return await fn();
    } finally {
      cp.spawn = original;
      syncBuiltinESMExports();
    }
  }

  it("settles nonzero_exit with exitCode null rather than treating the kill as success", async () => {
    const r = await withMockedSpawn(signalKilledSpawn(""), () =>
      runAwsCall({ service: "s3api", operation: "list-buckets", timeoutMs: 5000, command: STUB_COMMAND }),
    );
    assert.equal(r.ok, false, "a signal-killed child must not settle as a successful call");
    if (r.ok) return;
    assert.equal(r.kind, "nonzero_exit");
    assert.equal(r.exitCode, null, "a signal death has no numeric exit status");
    // Pinning the message EXACTLY as it renders today, including the bare
    // "null". It reads poorly -- "exited with code null" tells the agent
    // nothing about the signal that actually killed the process, and the
    // signal name is available (proc.signalCode / the 'close' argument) but
    // never surfaced. That is a message-quality issue in aws-cli.ts, not
    // something to paper over here: this test records the current behavior so
    // a deliberate rewording is a visible, intentional diff.
    assert.equal(r.error, "aws CLI exited with code null and no stderr");
  });

  it("prefers the child's stderr over the code-null fallback when there is any", async () => {
    // The fallback only fires on EMPTY stderr (`truncateForErrorMsg(...) || ...`),
    // so a signal death that managed to emit something keeps the real text --
    // the half of the branch that never renders "code null" at all.
    const r = await withMockedSpawn(signalKilledSpawn("Killed\n"), () =>
      runAwsCall({ service: "s3api", operation: "list-buckets", timeoutMs: 5000, command: STUB_COMMAND }),
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "nonzero_exit");
    assert.equal(r.exitCode, null);
    assert.equal(r.error, "Killed");
    assert.doesNotMatch(r.error, /code null/);
    assert.equal(r.rawStderr, "Killed\n");
  });
});

describe("truncateForErrorMsg boundary", () => {
  // The cap comparison is `text.length <= MAX_ERROR_MSG_CHARS`. At EXACTLY the
  // cap the string must pass through untouched; an off-by-one flipping that to
  // `<` would emit the nonsensical "[truncated; 0 chars omitted]" on a message
  // that fit perfectly.
  const CAP = 8 * 1024;

  it("returns a string of exactly the cap unchanged", () => {
    const exact = "x".repeat(CAP);
    const result = truncateForErrorMsg(exact);
    assert.equal(result, exact);
    assert.doesNotMatch(result, /truncated/);
  });

  it("truncates at one char over the cap", () => {
    const over = "x".repeat(CAP + 1);
    const result = truncateForErrorMsg(over);
    assert.match(result, /\[truncated; 1 chars omitted\]/);
  });
});
