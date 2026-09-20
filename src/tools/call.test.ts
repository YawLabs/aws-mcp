import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { _resetSession } from "../session.js";
import { CLI_PARSE_EXIT_CODE, callTools, cliArgParseHint } from "./call.js";

// Direct handler-level tests for aws_call (src/tools/call.ts:55-91). The two
// branches under test are the post-runAwsCall envelope shaping:
//   - success  -> { ok: true,  data: { command, result } }
//   - failure  -> { ok: false, error, rawBody: rawStderr ?? rawStdout }
//
// The handler calls runAwsCall directly and exposes no command/prefixArgs knob
// (that would surface argv injection through the MCP surface), so we route the
// subprocess at the fake aws shim via the documented test env-var hook
// (AWS_MCP_TEST_AWS_COMMAND / AWS_MCP_TEST_AWS_PREFIX_ARGS, see aws-cli.ts).
// Same pattern paginate.test.ts and multi-region.test.ts use.

const tool = callTools.find((t) => t.name === "aws_call");
if (!tool) throw new Error("callTools missing aws_call");

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AWS = join(__dirname, "..", "testing", "fake-aws.js");

describe("aws_call handler — success envelope vs rawBody fallback (fake-aws)", () => {
  beforeEach(() => {
    process.env.AWS_MCP_TEST_AWS_COMMAND = process.execPath;
    process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS = JSON.stringify([FAKE_AWS]);
    _resetSession();
  });

  afterEach(() => {
    delete process.env.AWS_MCP_TEST_AWS_COMMAND;
    delete process.env.AWS_MCP_TEST_AWS_PREFIX_ARGS;
    delete process.env.AWS_MCP_FAKE_SCENARIO;
    _resetSession();
  });

  // --- success branch: { ok:true, data: { command, result } } ---

  it("wraps a JSON success in { command, result } with the parsed payload", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "call_json_success";
    const r = (await tool.handler({ service: "s3api", operation: "list-buckets" })) as {
      ok: boolean;
      data?: { command?: string; result?: unknown };
    };
    assert.equal(r.ok, true);
    // The success envelope nests the parsed JSON under `result` and the literal
    // command under `command` — not the bare runAwsCall data shape.
    assert.deepEqual(r.data?.result, {
      Buckets: [
        { Name: "bucket-1", CreationDate: "2024-01-01T00:00:00.000Z" },
        { Name: "bucket-2", CreationDate: "2024-02-01T00:00:00.000Z" },
      ],
      Owner: { DisplayName: "me", ID: "abc123" },
    });
    // command is the redacted display string runAwsCall assembled; it must name
    // the service + operation that were dispatched.
    assert.equal(typeof r.data?.command, "string");
    assert.match(r.data?.command ?? "", /s3api/);
    assert.match(r.data?.command ?? "", /list-buckets/);
  });

  it("passes through a null result on an empty-stdout success (put-/tag- style ops)", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "call_empty_success";
    const r = (await tool.handler({ service: "iam", operation: "tag-role" })) as {
      ok: boolean;
      data?: { command?: string; result?: unknown };
    };
    assert.equal(r.ok, true);
    // runAwsCall returns data:null for empty stdout; the handler nests it verbatim.
    assert.equal(r.data?.result, null);
    assert.match(r.data?.command ?? "", /tag-role/);
  });

  it("preserves a plain scalar string when --query extracts a non-JSON value", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "call_nonjson_success";
    const r = (await tool.handler({ service: "s3api", operation: "list-buckets", query: "Buckets[0].Name" })) as {
      ok: boolean;
      data?: { result?: unknown };
    };
    assert.equal(r.ok, true);
    // runAwsCall falls back to the trimmed text when JSON.parse fails; the
    // handler surfaces that string as `result`.
    assert.equal(r.data?.result, "some-plain-string");
  });

  // --- failure branch: { ok:false, error, rawBody: rawStderr ?? rawStdout } ---

  it("on a nonzero exit returns ok:false with rawBody set to the stderr blob", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "call_access_denied";
    const r = (await tool.handler({ service: "s3api", operation: "list-buckets" })) as {
      ok: boolean;
      error?: string;
      rawBody?: string;
      data?: unknown;
    };
    assert.equal(r.ok, false);
    // No success envelope on failure.
    assert.equal(r.data, undefined);
    assert.match(r.error ?? "", /Access Denied/);
    // rawBody is the rawStderr half of `rawStderr ?? rawStdout` — the fake
    // wrote the AccessDenied line to stderr.
    assert.match(r.rawBody ?? "", /AccessDenied/);
    assert.match(r.rawBody ?? "", /ListBuckets/);
  });

  it("surfaces the classified SSO-expiry error and stderr rawBody on an expired token", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "call_sso_expired";
    const r = (await tool.handler({ service: "sts", operation: "get-caller-identity", profile: "my-profile" })) as {
      ok: boolean;
      error?: string;
      rawBody?: string;
    };
    assert.equal(r.ok, false);
    // The handler passes runAwsCall's already-classified sso_expired error text
    // through unchanged — same hint aws_whoami surfaces.
    assert.match(r.error ?? "", /SSO session expired/);
    assert.match(r.error ?? "", /my-profile/);
    assert.match(r.error ?? "", /aws_login_start/);
    // The underlying stderr is still preserved in rawBody for diagnosis.
    assert.match(r.rawBody ?? "", /Error loading SSO Token/);
  });

  it("surfaces the classified no-creds error and stderr rawBody", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "call_no_creds";
    const r = (await tool.handler({ service: "s3api", operation: "list-buckets", profile: "my-profile" })) as {
      ok: boolean;
      error?: string;
      rawBody?: string;
    };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /No credentials found/);
    assert.match(r.error ?? "", /my-profile/);
    assert.match(r.rawBody ?? "", /Unable to locate credentials/);
  });

  it("falls through to stdout when stderr is an empty string on a nonzero exit", async () => {
    // The `call_fail_stdout_only` fake writes diagnostic content to stdout
    // and leaves stderr empty. An empty rawStderr is treated as "no stderr"
    // (handler uses a truthy check, not `??`) so the agent gets the stdout
    // content in rawBody instead of an empty string. Practical case: a
    // wrapper script that swallows stderr, an `aws` operation that routes
    // through stdout when stderr is closed, or a CLI version that emits
    // the error in a different stream than the version this server was
    // tested against.
    process.env.AWS_MCP_FAKE_SCENARIO = "call_fail_stdout_only";
    const r = (await tool.handler({ service: "s3api", operation: "list-buckets" })) as {
      ok: boolean;
      error?: string;
      rawBody?: string;
    };
    assert.equal(r.ok, false);
    // The generic nonzero-exit error text is the stderr trim (empty) -> the
    // "no stderr" fallback message from aws-cli.ts.
    assert.match(r.error ?? "", /aws CLI exited with code 1 and no stderr/);
    // rawBody falls through to stdout because rawStderr is an empty string.
    assert.match(r.rawBody ?? "", /partial-output-on-stdout/);
  });

  // --- errorKind / suggestion forwarding ---

  it("forwards the classified errorKind on the auth-class failures, with no suggestion", async () => {
    // The auth branches build their own profile-aware remedy into `error`, so
    // parseAwsError never runs for them and `suggestion` stays absent -- the
    // two new fields are independent.
    for (const [scenario, kind] of [
      ["call_sso_expired", "sso_expired"],
      ["call_no_creds", "no_creds"],
    ] as const) {
      process.env.AWS_MCP_FAKE_SCENARIO = scenario;
      const r = (await tool.handler({ service: "s3api", operation: "list-buckets", profile: "my-profile" })) as {
        ok: boolean;
        errorKind?: string;
        suggestion?: string;
      };
      assert.equal(r.ok, false, scenario);
      assert.equal(r.errorKind, kind, scenario);
      assert.equal(r.suggestion, undefined, scenario);
    }
  });

  it("forwards nonzero_exit plus the parsed suggestion, which stays embedded in error too", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "call_access_denied";
    const r = (await tool.handler({ service: "s3api", operation: "list-buckets" })) as {
      ok: boolean;
      error?: string;
      errorKind?: string;
      suggestion?: string;
    };
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, "nonzero_exit");
    assert.equal(r.suggestion, "Check IAM permissions for this operation.");
    // The field DUPLICATES the message rather than replacing it: aws_multi_region
    // carries only per-region `error` text, so moving it out would drop the
    // remedy there.
    assert.ok(
      (r.error ?? "").endsWith("\n\nSuggestion: Check IAM permissions for this operation."),
      `error must still end with the suggestion sentence, got: ${r.error}`,
    );
  });

  // --- the CLI parse-failure hint (cliArgParseHint), through the handler ---

  it("explains that s3api get-object cannot run here, instead of blaming the params that were sent", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "new-tools_argparse_required_bucket_key";
    const r = (await tool.handler({
      service: "s3api",
      operation: "get-object",
      params: { Bucket: "b", Key: "k" },
    })) as { ok: boolean; error?: string; errorKind?: string; suggestion?: string; rawBody?: string };
    assert.equal(r.ok, false);
    // A parse failure is still a nonzero exit: the stable enum does not move.
    assert.equal(r.errorKind, "nonzero_exit");
    assert.match(r.suggestion ?? "", /cannot run through aws_call/);
    assert.match(r.suggestion ?? "", /aws s3 cp s3:\/\/BUCKET\/KEY -/);
    assert.ok(
      (r.error ?? "").endsWith(`\n\nSuggestion: ${r.suggestion}`),
      `error must carry the hint too, got: ${r.error}`,
    );
    // The CLI's own misleading sentence is still there for diagnosis.
    assert.match(r.rawBody ?? "", /the following arguments are required: --bucket, --key/);
  });

  it("tells a caller that sent NO params to pass them by API member name", async () => {
    // Same scenario, same bytes: head-object with no params is what the real CLI
    // emits identically to get-object WITH params. Only `sentParams` separates
    // the two branches.
    process.env.AWS_MCP_FAKE_SCENARIO = "new-tools_argparse_required_bucket_key";
    const r = (await tool.handler({ service: "s3api", operation: "head-object" })) as {
      ok: boolean;
      suggestion?: string;
    };
    assert.match(r.suggestion ?? "", /sent no `params`/);
    assert.match(r.suggestion ?? "", /modelId/);
  });

  it("treats an EMPTY params object as no params, matching the --cli-input-json condition", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "new-tools_argparse_required_bucket_key";
    const r = (await tool.handler({ service: "s3api", operation: "head-object", params: {} })) as {
      suggestion?: string;
    };
    assert.match(r.suggestion ?? "", /sent no `params`/);
  });

  it("names the positional outfile case unreachable even with no params sent", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "new-tools_argparse_required_outfile";
    const r = (await tool.handler({ service: "s3api", operation: "get-object" })) as { suggestion?: string };
    assert.match(r.suggestion ?? "", /cannot run through aws_call/);
  });

  it("points a logs tail call at aws_logs_tail on the Unknown-options shape", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "new-tools_unknown_cli_input_json";
    const r = (await tool.handler({
      service: "logs",
      operation: "tail",
      params: { logGroupName: "g" },
    })) as { suggestion?: string };
    assert.match(r.suggestion ?? "", /cannot run through aws_call/);
    assert.match(r.suggestion ?? "", /aws_logs_tail/);
  });

  it("puts --cli-input-json on the argv only when params has at least one key", async () => {
    // The `sentParams` flag in the handler MIRRORS the condition in aws-cli.ts;
    // nothing else can notice if that condition changes (a fixed-bytes fake
    // would keep passing). Assert the real argv instead, both ways.
    process.env.AWS_MCP_FAKE_SCENARIO = "call_echo_args";
    const argvFor = async (params?: Record<string, unknown>): Promise<string[]> => {
      const r = (await tool.handler({ service: "s3api", operation: "get-object", params })) as {
        ok: boolean;
        data?: { result?: { argv?: string[] } };
      };
      assert.equal(r.ok, true);
      return r.data?.result?.argv ?? [];
    };
    assert.ok(!(await argvFor({})).includes("--cli-input-json"), "an empty params object adds no flag");
    assert.ok(!(await argvFor(undefined)).includes("--cli-input-json"), "absent params adds no flag");
    assert.ok((await argvFor({ Bucket: "b" })).includes("--cli-input-json"), "one key is enough to add the flag");
  });

  it("classifies a nonzero exit with empty stderr but has no suggestion to give", async () => {
    process.env.AWS_MCP_FAKE_SCENARIO = "call_fail_stdout_only";
    const r = (await tool.handler({ service: "s3api", operation: "list-buckets" })) as {
      ok: boolean;
      errorKind?: string;
      suggestion?: string;
      rawBody?: string;
    };
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, "nonzero_exit");
    assert.equal(r.suggestion, undefined, "parseAwsError('') yields nothing");
    assert.match(r.rawBody ?? "", /partial-output-on-stdout/);
  });

  it("tells the caller to upgrade the CLI when it does not know the operation", async () => {
    // The other half of the README's "reachable the moment your local `aws` CLI
    // knows them" promise: `batch cancel-jobs` arrived in CLI 2.36.44, and on an
    // older CLI argparse rejects it (exit 252) with text that reads like a typo.
    // The remedy comes from parseAwsError, not cliArgParseHint -- which is why
    // `suggestion` being set here also proves the two never stack.
    process.env.AWS_MCP_FAKE_SCENARIO = "readme-positioning_cli_invalid_choice";
    const r = (await tool.handler({
      service: "batch",
      operation: "cancel-jobs",
      params: { jobIds: ["j-1"] },
    })) as { ok: boolean; error?: string; errorKind?: string; suggestion?: string; rawBody?: string };
    assert.equal(r.ok, false);
    // A parse failure is still a nonzero exit: the stable enum does not move.
    assert.equal(r.errorKind, "nonzero_exit");
    assert.match(r.suggestion ?? "", /^The installed aws CLI has no operation named 'cancel-jobs'\./);
    assert.match(r.suggestion ?? "", /aws update/);
    assert.ok(
      (r.error ?? "").endsWith(`\n\nSuggestion: ${r.suggestion}`),
      `error must carry the suggestion too, got: ${r.error}`,
    );
    // The CLI's own text, including its did-you-mean list, stays for diagnosis.
    assert.match(r.error ?? "", /Found invalid choice 'cancel-jobs'/);
    assert.match(r.rawBody ?? "", /Maybe you meant/);
  });

  // --- bad_input short-circuit (runAwsCall returns before spawning) ---

  it("returns ok:false with undefined rawBody when validation fails before any subprocess", async () => {
    // An invalid (flag-shaped) service makes runAwsCall bail with kind:bad_input
    // and NO rawStdout/rawStderr, so the handler's
    // `rawStderr ? rawStderr : rawStdout` resolves to undefined. The fake is
    // never spawned.
    const r = (await tool.handler({ service: "--evil", operation: "list-buckets" })) as {
      ok: boolean;
      error?: string;
      rawBody?: string;
    };
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid service/);
    assert.equal(r.rawBody, undefined);
    // runAwsCall classified it before returning, so the kind survives even
    // though no subprocess ever ran.
    assert.equal((r as { errorKind?: string }).errorKind, "bad_input");
  });
});

/**
 * cliArgParseHint is pure, so these tests feed it REAL captured stderr rather
 * than a fake's approximation of it. Every string below was captured from a real
 * AWS CLI on Windows (hence CRLF): aws-cli 2.34.3 and the extracted 2.22.0, each
 * driven against a dead loopback endpoint so nothing ever left the machine. The
 * 2.22.0 shape matters because it differs structurally -- the usage block comes
 * FIRST and the prefix is `aws.exe: error:` -- and the json/yaml/table shapes
 * matter because a user's `cli_error_format` or AWS_CLI_ERROR_FORMAT puts the
 * sentence inside a quoted or boxed field followed by LITERAL "\n" escapes.
 */
describe("cliArgParseHint — classifying a real AWS CLI argparse failure", () => {
  const USAGE_LF =
    "\n\nusage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]\n" +
    "To see help text, you can run:\n\n  aws help\n  aws <command> help\n  aws <command> <subcommand> help\n";
  const USAGE = USAGE_LF.replace(/\n/g, "\r\n");

  // 2.34.3 under the default `enhanced` error format.
  const ENHANCED = (list: string): string =>
    `\r\naws: [ERROR]: An error occurred (ParamValidation): the following arguments are required: ${list}${USAGE}`;
  // 2.34.3 with `cli_error_format = legacy`, and also 2.34.3 when --profile names
  // a profile present in neither the config nor the credentials file: no wrapper.
  const LEGACY = (list: string): string => `\r\naws: [ERROR]: the following arguments are required: ${list}${USAGE}`;
  // 2.22.0 on Windows: the usage block FIRST, then `aws.exe: error:` (`aws:` on
  // POSIX and for the top-level parser), then a blank line.
  const CLI_2220 = (list: string): string =>
    `${USAGE.slice(2)}\r\naws.exe: error: the following arguments are required: ${list}\r\n\r\n`;
  // 2.34.3 with AWS_CLI_ERROR_FORMAT=json. The escapes inside Message are two
  // literal characters, backslash then n -- which is exactly why the capture
  // group has to stop at a backslash.
  const ERR_JSON = (list: string): string =>
    '{\r\n    "Code": "ParamValidation",\r\n    "Message": "the following arguments are required: ' +
    `${list}\\n\\nusage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]\\nTo see help text, you can run:\\n\\n  aws help\\n  aws <command> help\\n  aws <command> <subcommand> help\\n"\r\n}\r\n`;

  const sent = { sentParams: true, exitCode: CLI_PARSE_EXIT_CODE };
  const unsent = { sentParams: false, exitCode: CLI_PARSE_EXIT_CODE };

  describe("params WERE sent -- so the command cannot accept them at all", () => {
    it("rejects s3api get-object and names the shell alternative", () => {
      const hint = cliArgParseHint(ENHANCED("--bucket, --key"), { service: "s3api", operation: "get-object", ...sent });
      assert.match(hint ?? "", /cannot run through aws_call/);
      assert.match(hint ?? "", /aws s3 cp s3:\/\/BUCKET\/KEY -/);
      // The whole point: the CLI's list named exactly what `params` carried.
      assert.doesNotMatch(hint ?? "", /sent no `params`/);
    });

    it("is line-ending agnostic", () => {
      const crlf = cliArgParseHint(ENHANCED("--bucket, --key"), { service: "s3api", operation: "get-object", ...sent });
      const lf = cliArgParseHint(
        `\naws: [ERROR]: An error occurred (ParamValidation): the following arguments are required: --bucket, --key${USAGE_LF}`,
        { service: "s3api", operation: "get-object", ...sent },
      );
      assert.equal(lf, crlf);
    });

    it("reads the wrapper-less legacy shape", () => {
      const hint = cliArgParseHint(LEGACY("--bucket, --key"), { service: "s3api", operation: "get-object", ...sent });
      assert.match(hint ?? "", /cannot run through aws_call/);
    });

    it("reads 2.22.0's usage-block-first shape", () => {
      const hint = cliArgParseHint(CLI_2220("--bucket, --key"), { service: "s3api", operation: "get-object", ...sent });
      assert.match(hint ?? "", /cannot run through aws_call/);
    });

    it("reads the json error format", () => {
      const hint = cliArgParseHint(ERR_JSON("--bucket, --key"), { service: "s3api", operation: "get-object", ...sent });
      assert.match(hint ?? "", /cannot run through aws_call/);
    });

    for (const [service, operation, required, pattern] of [
      ["lambda", "invoke", "--function-name", /aws_lambda_invoke/],
      ["bedrock-runtime", "invoke-model", "--model-id", /converse/],
      // GA 2026-09-18 and modeled in 2.34.3, which answers with its own required
      // list. No dedicated tool for it, so the default alternative applies.
      ["bedrock-agentcore", "invoke-agent-runtime", "--agent-runtime-arn, --payload", /in a shell/],
    ] as const) {
      it(`names the way out for ${service} ${operation}`, () => {
        const hint = cliArgParseHint(ENHANCED(required), { service, operation, ...sent });
        assert.match(hint ?? "", /cannot run through aws_call/);
        assert.match(hint ?? "", pattern);
      });
    }

    for (const [label, stderr] of [
      [
        "2.34.3 enhanced",
        "\r\naws: [ERROR]: An error occurred (ParamValidation): Unknown options: --cli-input-json\r\n",
      ],
      ["2.22.0 bare", "\r\nUnknown options: --cli-input-json\r\n"],
      // A BasicCommand joins with "," and no space, so the params blob follows
      // the flag directly: `logs tail g --cli-input-json '{"a":1}'`.
      [
        "with the params blob appended",
        '\r\naws: [ERROR]: An error occurred (ParamValidation): Unknown options: --cli-input-json,{"a":1}\r\n',
      ],
      [
        "json error format",
        '{\r\n    "Code": "ParamValidation",\r\n    "Message": "Unknown options: --cli-input-json"\r\n}\r\n',
      ],
    ] as const) {
      it(`reads the Unknown-options shape (${label})`, () => {
        const hint = cliArgParseHint(stderr, { service: "logs", operation: "tail", ...sent });
        assert.match(hint ?? "", /cannot run through aws_call/);
        assert.match(hint ?? "", /aws_logs_tail/);
      });
    }

    it("points s3 ls at the s3api list operations", () => {
      const hint = cliArgParseHint("\r\nUnknown options: --cli-input-json\r\n", {
        service: "s3",
        operation: "ls",
        ...sent,
      });
      assert.match(hint ?? "", /list-objects-v2/);
    });
  });

  describe("NO params sent -- a positional proves it, a flag list does not", () => {
    for (const [label, service, operation, list] of [
      ["s3api get-object's outfile", "s3api", "get-object", "--bucket, --key, outfile"],
      ["logs tail's group_name", "logs", "tail", "group_name"],
      ["s3 cp's paths", "s3", "cp", "paths"],
      ["configure get's varname", "configure", "get", "varname"],
    ] as const) {
      it(`rejects on ${label}`, () => {
        const hint = cliArgParseHint(ENHANCED(list), { service, operation, ...unsent });
        assert.match(hint ?? "", /cannot run through aws_call/);
      });
    }

    it("tells a flags-only caller to pass params by API member name", () => {
      const hint = cliArgParseHint(ENHANCED("--bucket, --key"), {
        service: "s3api",
        operation: "head-object",
        ...unsent,
      });
      assert.match(hint ?? "", /sent no `params`/);
      assert.match(hint ?? "", /--bucket -> Bucket/);
      // The RULE, never a guessed name: --model-id is modelId, not ModelId.
      assert.match(hint ?? "", /modelId/);
    });

    it("gives the same rule for bedrock-runtime converse, which is reachable", () => {
      const hint = cliArgParseHint(ENHANCED("--model-id"), {
        service: "bedrock-runtime",
        operation: "converse",
        ...unsent,
      });
      assert.match(hint ?? "", /sent no `params`/);
    });

    it("does NOT mistake the json format's escaped usage text for positionals", () => {
      // The regression this tokenizer exists for. With a `([^\r\n]+)` capture the
      // escaped usage block came back as tokens, "you can run:..." read as a
      // positional, and head-object was told it can never run through aws_call --
      // which is false.
      const hint = cliArgParseHint(ERR_JSON("--bucket, --key"), {
        service: "s3api",
        operation: "head-object",
        ...unsent,
      });
      assert.match(hint ?? "", /sent no `params`/);
    });

    it("still sees the positional in the json format", () => {
      const hint = cliArgParseHint(ERR_JSON("--bucket, --key, outfile"), {
        service: "s3api",
        operation: "get-object",
        ...unsent,
      });
      assert.match(hint ?? "", /cannot run through aws_call/);
    });

    it("says nothing when a yaml line wrap cuts the list mid-item", () => {
      // Real 2.34.3 with AWS_CLI_ERROR_FORMAT=yaml on `polly synthesize-speech`:
      // the wrap lands after "--voice-id," and `outfile` sits on the next line.
      // The visible fragment is all flags, so a guess would answer forgot-params
      // for a command that is genuinely unreachable. A trailing comma means stop.
      const yamlWrapped =
        'Code: ParamValidation\r\nMessage: "the following arguments are required: --output-format, --text, --voice-id,\r\n' +
        "  outfile\\n\\nusage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]\\nTo\r\n" +
        '  see help text, you can run:\\n\\n  aws help\\n"\r\n';
      assert.equal(
        cliArgParseHint(yamlWrapped, { service: "polly", operation: "synthesize-speech", ...unsent }),
        undefined,
      );
    });

    it("reads the table error format, whose borders end the capture", () => {
      // Shortened from the real 2.34.3 table capture (its rules are ~270 chars
      // wide); the Message row is verbatim.
      const tableFormat =
        "-------------\r\n|   error   |\r\n+---------+---+\r\n|  Code   |  ParamValidation   |\r\n" +
        "|  Message|  the following arguments are required: --bucket, --key, outfile\r\n\r\nusage: aws help\r\n   |\r\n";
      assert.match(
        cliArgParseHint(tableFormat, { service: "s3api", operation: "get-object", ...unsent }) ?? "",
        /cannot run through aws_call/,
      );
    });
  });

  describe("says nothing rather than guessing", () => {
    for (const [label, stderr, ctx] of [
      // botocore's own validation, which parseAwsError already has a remedy for.
      [
        "botocore parameter validation",
        '\r\naws: [ERROR]: An error occurred (ParamValidation): Parameter validation failed:\r\nMissing required parameter in input: "Key"\r\n',
        { service: "s3api", operation: "head-object", ...sent },
      ],
      [
        "an AccessDenied wrapper",
        "An error occurred (AccessDenied) when calling the ListBuckets operation: Access Denied\r\n",
        { service: "s3api", operation: "list-buckets", ...sent },
      ],
      ["empty stderr", "", { service: "s3api", operation: "list-buckets", ...sent }],
      [
        "an unknown option that is not --cli-input-json",
        "\r\nUnknown options: --foo\r\n",
        { service: "s3api", operation: "list-buckets", ...sent },
      ],
      [
        "an invalid operation choice",
        "\r\naws: [ERROR]: An error occurred (ParamValidation): argument operation: Found invalid choice 'not-an-op'\r\n",
        { service: "s3api", operation: "not-an-op", ...sent },
      ],
      [
        "bare `ec2 wait`, which argparse answers with 'too few arguments'",
        "\r\naws: [ERROR]: An error occurred (ParamValidation): usage: aws [options] ec2 wait <subcommand> [parameters]\r\naws: [ERROR]: too few arguments\r\n",
        { service: "ec2", operation: "wait", ...sent },
      ],
      [
        "a service message that merely mentions outfile",
        "An error occurred (InvalidRequest) when calling the PutThing operation: outfile is not a valid property\r\n",
        { service: "thing", operation: "put-thing", ...sent },
      ],
    ] as const) {
      it(`returns undefined for ${label}`, () => {
        assert.equal(cliArgParseHint(stderr, ctx), undefined);
      });
    }

    it("returns undefined when the required tokens are not argument-shaped", () => {
      // Belt and braces for a future CLI wording change: a token that looks like
      // neither a flag nor an argparse dest means the parse is not understood.
      assert.equal(
        cliArgParseHint("the following arguments are required: Bucket, KEY!", {
          service: "s3api",
          operation: "head-object",
          ...unsent,
        }),
        undefined,
      );
    });
  });

  describe("the exit-code gate", () => {
    for (const exitCode of [255, 254, 1, 0, null, undefined] as const) {
      it(`returns undefined at exit ${String(exitCode)}, params sent or not`, () => {
        for (const sentParams of [true, false]) {
          assert.equal(
            cliArgParseHint(ENHANCED("--bucket, --key"), {
              service: "s3api",
              operation: "get-object",
              sentParams,
              exitCode,
            }),
            undefined,
            `exit ${String(exitCode)}, sentParams=${sentParams}`,
          );
        }
      });
    }

    it("is gated on 252, the CLI's parse-error code", () => {
      assert.equal(CLI_PARSE_EXIT_CODE, 252);
    });
  });

  it("normalizes the operation the way runAwsCall tokenizes it", () => {
    // runAwsCall does operation.trim().split(/\s+/), so '  get-object  ' reaches
    // the CLI as the same command and must resolve the same alternative.
    const hint = cliArgParseHint(ENHANCED("--bucket, --key"), {
      service: "s3api",
      operation: "  get-object  ",
      ...sent,
    });
    assert.match(hint ?? "", /aws s3 cp s3:\/\/BUCKET\/KEY -/);
    assert.match(hint ?? "", /`aws s3api get-object` cannot run/);
  });
});
