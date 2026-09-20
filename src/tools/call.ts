import { z } from "zod";
import { runAwsCall } from "../aws-cli.js";
import type { Tool, ToolResult } from "./tool.js";

/** The AWS CLI v2's exit code for every argument-parsing failure: argparser.py
 * `self.exit(252, ...)` since 2.0.0; measured on 2.22.0 and 2.34.3. */
export const CLI_PARSE_EXIT_CODE = 252;

// Python argparse's own sentence, matched WITHOUT its prefix because the prefix
// varies by CLI version and by the caller's error format (all captured against
// real 2.34.3 and real 2.22.0):
//   2.34+ enhanced  "aws: [ERROR]: An error occurred (ParamValidation): the following arguments are required: --bucket, --key"
//   2.34+ legacy, or a --profile found in neither config nor credentials file
//                   "aws: [ERROR]: the following arguments are required: ..."
//   pre-2.34 (2.22.0) the usage block FIRST, then "aws.exe: error: the following
//                   arguments are required: ..." ("aws:" on POSIX and for the
//                   top-level parser), then a blank line
//   2.34+ json / yaml / text / table formats: the sentence sits inside a quoted
//                   or boxed `Message`, followed by LITERAL "\n" escapes
// So the capture must stop at CR, LF, a quote, a backslash or a table border --
// otherwise the json format's escaped usage text runs into the token list and
// "you can run:..." reads as a positional argument.
const ARGPARSE_REQUIRED_RE = /the following arguments are required: ([^\r\n"'\\|]+)/;
// clidriver joins unknown options with ", " and a hand-written (BasicCommand)
// command with "," -- `logs tail g` plus params gives
// `Unknown options: --cli-input-json,{"a":1}` (measured). The lookahead keeps
// `--cli-input-json-extra` from matching.
const UNKNOWN_CLI_INPUT_JSON_RE = /Unknown options: (?:[^\r\n]*[ ,])?--cli-input-json(?=[\s,"'\\|]|$)/;
// A CLI flag (--bucket) or an argparse positional dest (outfile, group_name,
// paths, varname).
const ARG_TOKEN_RE = /^(?:--[a-z0-9][a-z0-9-]*|[a-z][a-z0-9_]*)$/;
// `operation` named a subcommand GROUP rather than a leaf operation. The group's
// parser registers no --cli-input-json, so argparse takes the JSON VALUE as the
// missing positional and reports it as the invalid choice: `aws_call {service:
// "ec2", operation: "wait", params: {InstanceIds: ["i-1"]}}` gives `argument
// subcommand: Found invalid choice '{"InstanceIds":["i-1"]}'` on 2.34.3.
// Recognized on the leading `{` of our own payload, which is what distinguishes
// this from a genuinely mistyped waiter name -- errors.ts declines the shape for
// the same reason and leaves the remedy here. `subcommand` is the only dest this
// reaches: `command` and `operation` are filled by aws_call's own two inputs,
// and an empty `operation` is rejected before the spawn (all measured).
const JSON_AS_SUBCOMMAND_RE = /argument subcommand: Found invalid choice '\{/;

// The way out, for the handful of unreachable commands a model actually asks
// for. Keyed "<service> <operation>" on the same tokenization runAwsCall uses.
const CLI_INPUT_JSON_ALTERNATIVES: ReadonlyMap<string, string> = new Map([
  ["lambda invoke", "Use aws_lambda_invoke, which exists for exactly this operation."],
  ["logs tail", "Use aws_logs_tail."],
  [
    "s3 ls",
    "Use s3api list-buckets, or s3api list-objects-v2 with params {Bucket, Prefix}, through aws_call or aws_paginate.",
  ],
  [
    "s3api get-object",
    "For an object body, run `aws s3 cp s3://BUCKET/KEY -` in a shell; it prints the object to stdout.",
  ],
  [
    "bedrock-runtime invoke-model",
    "For text generation, call bedrock-runtime converse through aws_call (it takes params and returns JSON); invoke-model itself needs a shell.",
  ],
]);

export interface CliArgParseContext {
  service: string;
  operation: string;
  sentParams: boolean;
  exitCode: number | null | undefined;
}

/**
 * Explain an aws_call that died in the CLI's argument parser, for the two cases
 * whose stderr actively misleads the caller.
 *
 * The proof this rests on: the CLI never registers `--cli-input-json` on an
 * operation whose argument table carries an `outfile`
 * (`awscli/customizations/cliinput.py` `_add_cli_input_argument`: `if 'outfile'
 * not in argument_table:`, unchanged from 2.0.0 to v2 HEAD), nor on its
 * hand-written BasicCommands. That flag is the ONLY way aws_call passes
 * `params` (aws-cli.ts), so `s3api get-object` with `{Bucket, Key}` exits 252
 * saying `the following arguments are required: --bucket, --key` -- naming the
 * two values that WERE supplied. Conversely, for any operation that DOES
 * register the flag, `OverrideRequiredArgsArgument.override_required_args`
 * (`awscli/customizations/arguments.py`, also unchanged since 2.0.0) marks every
 * argument not-required as soon as `--cli-input-json` is on the command line, so
 * argparse can never say "the following arguments are required" on such a call.
 * A missing member surfaces later as botocore's `Parameter validation failed`,
 * which parseAwsError already has a remedy for.
 *
 * Why `sentParams` is an input rather than something read off stderr: `s3api
 * head-object` with NO params produces byte-identical stderr to `get-object`
 * WITH params (both captures are in the unit tests). The bytes alone cannot tell
 * "this command can never run here" from "you forgot params"; only the caller's
 * own context can.
 *
 * One known imprecision: a hand-written command whose required inputs are all
 * flags (`cloudformation deploy`) and that is called with NO params gets the
 * forgot-params branch first, and the correct branch on the next call once
 * params are supplied. Guessing "unreachable" from a flags-only list would
 * mislabel every ordinary operation called without its required params.
 *
 * Gated on exit 252, so it can never fire on a call that worked, and it returns
 * undefined rather than guessing whenever the token list does not parse cleanly.
 */
export function cliArgParseHint(stderr: string, ctx: CliArgParseContext): string | undefined {
  if (ctx.exitCode !== CLI_PARSE_EXIT_CODE) return undefined;
  // Mirrors runAwsCall's own operation tokenization so 'wait  object-exists'
  // and ' get-object ' resolve the same key the CLI was given.
  const key = `${ctx.service} ${ctx.operation.trim().split(/\s+/).filter(Boolean).join(" ")}`;
  // Before the two sentences below, because the group case carries neither of
  // them. See JSON_AS_SUBCOMMAND_RE.
  if (ctx.sentParams && JSON_AS_SUBCOMMAND_RE.test(stderr)) {
    return `\`aws ${key}\` is a subcommand group, not an operation, so it needs one more name in \`operation\` -- for a waiter, the waiter's own name ('wait instance-running'). \`aws ${key} help\` lists them. The name argparse called an invalid choice is the \`params\` JSON, not anything you passed as \`operation\`: aws_call sends params through --cli-input-json, a group's parser does not register that flag, and argparse read its value as the missing subcommand.`;
  }
  const required = ARGPARSE_REQUIRED_RE.exec(stderr);
  let unreachable: boolean;
  if (ctx.sentParams) {
    // Params were sent, so --cli-input-json WAS on the command line. Either
    // sentence proves the command did not accept it.
    unreachable = required !== null || UNKNOWN_CLI_INPUT_JSON_RE.test(stderr);
    if (!unreachable) return undefined;
  } else {
    if (required === null) return undefined;
    // A list cut by a line wrap (the yaml error format wraps mid-list) ends in
    // "," -- say nothing rather than treat the fragment as the whole list.
    if (required[1].trimEnd().endsWith(",")) return undefined;
    const tokens = required[1]
      .trim()
      .split(/,\s*/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (tokens.length === 0 || !tokens.every((t) => ARG_TOKEN_RE.test(t))) return undefined;
    // A positional in the list is an argument aws_call structurally cannot
    // supply; a list of only --flags means the caller forgot `params`.
    unreachable = tokens.some((t) => !t.startsWith("-"));
  }

  if (unreachable) {
    const alternative =
      CLI_INPUT_JSON_ALTERNATIVES.get(key) ?? `Run it in a shell with explicit flags (\`aws ${key} help\` lists them).`;
    return `\`aws ${key}\` cannot run through aws_call. aws_call passes \`params\` only through --cli-input-json and cannot supply positional arguments, and the AWS CLI registers --cli-input-json on neither the operations that stream their response to a positional output file (s3api get-object, bedrock-runtime invoke-model, bedrock-agentcore invoke-agent-runtime, lambda invoke) nor its hand-written commands (logs tail, s3 cp/ls/sync, cloudformation deploy). ${alternative}`;
  }
  // No guessed member names here on purpose: converting --cluster to Cluster is
  // wrong for ECS, EKS, ECR, Logs, Step Functions, API Gateway, Batch and
  // Bedrock, and a wrong name stated as an instruction is worse than the rule.
  return 'aws_call sent no `params`, and this operation has required members. The CLI names them as flags; pass them in `params` by API member name instead: PascalCase for most services (--bucket -> Bucket), camelCase for some (--model-id -> modelId on bedrock-runtime). If a name is wrong, the CLI\'s "Unknown parameter in input" error lists the valid ones.';
}

export const callTools: readonly Tool[] = [
  {
    name: "aws_call",
    description:
      "Run an arbitrary AWS API operation via the aws CLI. Use kebab-case service and operation names as in `aws help` (service='s3api', operation='list-buckets'). Pass params as a JSON object using the AWS API's PascalCase keys (e.g. {Bucket: 'foo'}); they go through --cli-input-json. Session profile/region (from aws_session_set) are used by default; override per-call when needed. Hand-written CLI commands (aws s3 cp/ls/sync, aws logs tail) and operations that stream their response to an output file (s3api get-object, bedrock-runtime invoke-model, bedrock-agentcore invoke-agent-runtime, lambda invoke) do not accept --cli-input-json and cannot run here -- use aws_lambda_invoke or aws_logs_tail where they exist, bedrock-runtime converse for text inference, otherwise your shell. Waiters work: operation 'wait instance-running'. Blob-typed members of params (KMS Plaintext, Kinesis Data, DynamoDB B) take base64 -- the server runs the CLI with --cli-binary-format base64 whatever your AWS config says. Returns parsed JSON output by default, plus the literal command that was run.",
    annotations: {
      title: "Call an AWS API operation",
      // The operation being called determines read-only/destructive, and we
      // cannot introspect it -- `operation` is a free string resolved by the
      // CLI at spawn time. So annotate for the WORST case this tool can reach,
      // which is the whole AWS API: ec2 terminate-instances, s3api
      // delete-bucket, iam delete-user.
      //
      // destructiveHint MUST stay true. Per the MCP spec it defaults to true,
      // and `false` positively asserts "performs only additive updates" -- a
      // claim this tool cannot make. Hosts gate their confirmation prompt on
      // it, so `false` here suppressed the confirm on the single most powerful
      // tool in the server. A caller who wants a hint that means "read-only"
      // should reach for aws_paginate (readOnlyHint: true) instead.
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      service: z
        .string()
        .describe(
          "AWS service name in kebab-case: 's3api', 'ec2', 'iam', 'lambda', 'dynamodb', 'logs', 'sts', 'cloudformation', etc.",
        ),
      operation: z
        .string()
        .describe(
          "Operation name in kebab-case: 'list-buckets', 'describe-instances', 'get-caller-identity', 'put-object'.",
        ),
      params: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Operation parameters as a JSON object (AWS API schema, PascalCase keys). E.g. {Bucket: 'foo', Key: 'bar'}.",
        ),
      query: z
        .string()
        .optional()
        .describe(
          "JMESPath expression to extract a subset of the response (passed as --query). E.g. 'Buckets[].Name', 'Reservations[].Instances[].{Id:InstanceId,State:State.Name}'. Dramatically reduces output size; reach for this whenever you only need a few fields.",
        ),
      profile: z.string().optional().describe("Override session profile for this call."),
      region: z.string().optional().describe("Override session region for this call."),
      outputFormat: z
        .enum(["json", "text", "table", "yaml"])
        .optional()
        .describe("Output format. Default 'json' (parsed into structured data when possible)."),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Timeout in milliseconds. Default 60000 (60s). Raise for slow ops; lower to fail fast."),
    }),
    handler: async (input: unknown): Promise<ToolResult> => {
      const i = input as {
        service: string;
        operation: string;
        params?: Record<string, unknown>;
        query?: string;
        profile?: string;
        region?: string;
        outputFormat?: "json" | "text" | "table" | "yaml";
        timeoutMs?: number;
      };
      const result = await runAwsCall({
        service: i.service,
        operation: i.operation,
        params: i.params,
        query: i.query,
        profile: i.profile,
        region: i.region,
        outputFormat: i.outputFormat,
        timeoutMs: i.timeoutMs,
      });
      if (!result.ok) {
        // Only where runAwsCall found no remedy of its own: parseAwsError's
        // suggestion is derived from the AWS error code and is the more specific
        // of the two whenever it fired at all.
        const hint =
          result.kind === "nonzero_exit" && result.suggestion === undefined
            ? cliArgParseHint(result.rawStderr ?? "", {
                service: i.service,
                operation: i.operation,
                // MUST mirror the --cli-input-json condition in aws-cli.ts (the
                // only place the flag is added). Pinned by the call_echo_args
                // test in call.test.ts, which asserts the argv both ways.
                sentParams: i.params !== undefined && Object.keys(i.params).length > 0,
                exitCode: result.exitCode,
              })
            : undefined;
        return {
          ok: false,
          // Embedded in `error` AND carried in `suggestion`, the same convention
          // runAwsCall's nonzero_exit branch uses -- toMcpResult renders only
          // `error`, so a hint that lived in the field alone would never reach
          // the model. `error` still OPENS with the stderr trim, which is what
          // keeps toMcpResult from appending rawBody a second time.
          error: hint ? `${result.error}\n\nSuggestion: ${hint}` : result.error,
          // runAwsCall already classified this failure; forwarding the kind is
          // what lets a caller branch on it without regexing the message. The
          // hint does not change it: this IS a nonzero exit.
          errorKind: result.kind,
          suggestion: result.suggestion ?? hint,
          // Treat an empty-string rawStderr as "no stderr" so a nonzero exit
          // that wrote its diagnostic to stdout (rare but observed: some
          // `aws` operations route through stdout when stderr is closed or
          // when a wrapper script swallows stderr) still surfaces the
          // stdout body. Pinned by call.test.ts -- the failure-shape
          // contract is "diagnostic text first, stdout second" rather
          // than "stderr always wins even when empty".
          rawBody: result.rawStderr ? result.rawStderr : result.rawStdout,
        };
      }
      return {
        ok: true,
        data: {
          command: result.command,
          commandArgv: result.commandArgv,
          result: result.data,
        },
      };
    },
  },
];
