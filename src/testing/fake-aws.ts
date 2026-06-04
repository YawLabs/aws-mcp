/**
 * A controlled stand-in for the real `aws` CLI, used only by integration
 * tests. Invoked like:
 *   node dist/testing/fake-aws.js sso login --no-browser --profile foo
 *
 * Reads the `AWS_MCP_FAKE_SCENARIO` env var to decide what to emit.
 * Exercises the full subprocess path in sso.ts (spawn, pipe stdout, exit
 * handling) without requiring a real AWS CLI or SSO setup in CI.
 *
 * Concurrency note: AWS_MCP_FAKE_SCENARIO is read out of the parent's env
 * via the spawn inherit, but the PARENT sets it via `process.env.AWS_MCP_
 * FAKE_SCENARIO = ...` per-test. node:test runs subtests SEQUENTIALLY
 * within a single test file (the default concurrency model for our
 * suites), so a `before`/`it`/`afterEach` block that sets + clears the var
 * is race-free for tests in the same file. If a future test runner change
 * enables intra-file parallelism, or a second file mutates the same var
 * concurrently, callers will need a serial guard. See metrics.test.ts for
 * the matching note on the test side.
 */

const scenario = process.env.AWS_MCP_FAKE_SCENARIO ?? "happy";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The exact stdout the `happy` scenario emits up to and including the URL +
// code lines. Shared so `happy_hold` is guaranteed byte-for-byte identical
// through the point findActiveSessionByProfile parses (verificationUrl +
// userCode), and can't silently drift from `happy`.
const HAPPY_URL_CODE_BANNER =
  "Attempting to automatically open the SSO authorization page in your default browser.\n" +
  "If the browser does not open or you wish to use a different device to authorize this request, open the following URL:\n\n" +
  "https://device.sso.us-east-1.amazonaws.com/\n\n" +
  "Then enter the code:\n\n" +
  "ABCD-EFGH\n";

async function main(): Promise<void> {
  switch (scenario) {
    case "happy": {
      // Realistic aws-cli output: banner text, URL, code, then successful auth.
      // HARD CONSTRAINT: the 200ms exit timing is depended on by
      // auth.test.ts and several sso.integration.test.ts cases (TTL
      // killswitch, completed-session exclusion). Do not change it. If you
      // need a session that stays active deterministically, use `happy_hold`.
      process.stdout.write(HAPPY_URL_CODE_BANNER);
      await sleep(200); // Simulate user auth delay
      process.stdout.write("Successfully logged into Start URL: https://d-test.awsapps.com/start\n");
      process.exit(0);
      return;
    }

    case "happy_hold": {
      // Same URL+code stdout as `happy` (so findActiveSessionByProfile parses
      // the identical verificationUrl/userCode), but then stays alive until
      // the parent kills it instead of exiting after 200ms. This keeps the
      // session's `completed` flag false deterministically, so a test that
      // synchronously asserts findActiveSessionByProfile right after start
      // can't lose the race to the 200ms exit. The parent reaps it via
      // killProc (_clearSessions in afterEach), so the long sleep never
      // actually elapses -- it's just a "stay alive" floor well past any
      // test's wall-clock.
      process.stdout.write(HAPPY_URL_CODE_BANNER);
      await sleep(10 * 60_000); // 10 min: effectively "until killed"
      process.exit(0);
      return;
    }

    case "malformed": {
      // Output without a matching URL or code — tests the parse-fail path.
      process.stdout.write("Something went wrong. Try again.\n");
      await sleep(100);
      process.exit(0);
      return;
    }

    case "early_exit_failure": {
      // Print URL+code, then die with nonzero before the "user" auths.
      process.stdout.write("Open: https://device.sso.us-east-1.amazonaws.com/\nCode: ABCD-EFGH\n");
      process.stderr.write("Error: connection refused\n");
      await sleep(50);
      process.exit(1);
      return;
    }

    case "exits_before_url": {
      // Exit cleanly before emitting anything useful.
      await sleep(50);
      process.exit(0);
      return;
    }

    // --- aws_call scenarios ---

    case "call_json_success": {
      process.stdout.write(
        `${JSON.stringify({
          Buckets: [
            { Name: "bucket-1", CreationDate: "2024-01-01T00:00:00.000Z" },
            { Name: "bucket-2", CreationDate: "2024-02-01T00:00:00.000Z" },
          ],
          Owner: { DisplayName: "me", ID: "abc123" },
        })}\n`,
      );
      process.exit(0);
      return;
    }

    case "call_empty_success": {
      // Some operations (tag-role, put-*, etc.) succeed with empty stdout.
      process.exit(0);
      return;
    }

    case "call_nonjson_success": {
      // aws can emit a plain scalar when --query is used, even with --output json.
      process.stdout.write("some-plain-string\n");
      process.exit(0);
      return;
    }

    case "call_access_denied": {
      process.stderr.write("An error occurred (AccessDenied) when calling the ListBuckets operation: Access Denied\n");
      process.exit(255);
      return;
    }

    case "call_sso_expired": {
      process.stderr.write("Error loading SSO Token: Token for my-profile is expired.\n");
      process.exit(255);
      return;
    }

    case "call_no_creds": {
      process.stderr.write("Unable to locate credentials. You can configure credentials by running 'aws configure'.\n");
      process.exit(255);
      return;
    }

    case "call_fail_stdout_only": {
      // Nonzero exit with output on stdout and a deliberately EMPTY stderr.
      // Forces the `?? rawStdout` half of the aws_call handler's
      // `rawBody: result.rawStderr ?? result.rawStdout`. The classifier sees
      // no stderr, so this lands as a generic nonzero_exit (kind: other).
      process.stdout.write("partial-output-on-stdout\n");
      process.exit(1);
      return;
    }

    case "call_slow": {
      // Sleep longer than the test's timeoutMs to exercise the timeout path.
      await sleep(5000);
      process.stdout.write("{}\n");
      process.exit(0);
      return;
    }

    case "call_partial_then_hang": {
      // Write some stdout FIRST, then hang past a short timeoutMs. Unlike
      // call_slow (which hangs before emitting anything), this exercises the
      // timeout-PRESERVES-partial-output path: runAwsCall's timeout branch
      // attaches rawStdout to the AwsCallFailure, so a test can assert the
      // partial bytes survived the kill. We flush a fragment immediately, give
      // the parent's stdout.on('data') a tick to drain it, then sleep well past
      // any reasonable test timeoutMs so the parent's timeout fires and kills
      // us. The fragment is intentionally NOT valid JSON on its own -- the
      // timeout path never parses stdout, it just preserves the raw bytes.
      process.stdout.write('{"partial":"this-arrived-before-the-timeout"');
      await sleep(50); // let the parent drain the first chunk before we hang
      await sleep(10_000); // hang well past the test's timeoutMs
      process.stdout.write("}\n");
      process.exit(0);
      return;
    }

    case "call_large": {
      // Emit more than MAX_OUTPUT_BYTES (5 MB) so the parent trips its
      // output_too_large cap and kills us. Write a single 6 MB burst with NO
      // inter-chunk sleeps: the parent's cap is cumulative over stdout 'data'
      // events, so once it drains 6 MB the guard fires regardless of reader
      // speed or CI load. The earlier 1 MB-chunks-with-10ms-sleeps version was
      // timing-coupled -- it only passed because the parent read fast enough to
      // kill mid-stream before all 8 MB were written and before the test
      // timeout. This burst makes the cap deterministic.
      process.stdout.write("x".repeat(6 * 1024 * 1024));
      process.exit(0);
      return;
    }

    case "mr_partial_failure": {
      // Multi-region test: vary output by --region argv so a single scenario
      // produces ok for one region and an sso_expired failure for another.
      // Lets the multi-region handler exercise the partial-failure result
      // shape end-to-end -- one region returns {ok: true, data, command},
      // another returns {ok: false, errorKind: "sso_expired", error, command}.
      const argv = process.argv.slice(2);
      const regionIdx = argv.indexOf("--region");
      const region = regionIdx >= 0 ? argv[regionIdx + 1] : "";
      if (region === "us-west-2") {
        process.stderr.write("Error loading SSO Token: Token for my-profile is expired.\n");
        process.exit(255);
        return;
      }
      // Default: success with a small JSON payload tagged by region.
      process.stdout.write(`${JSON.stringify({ Buckets: [{ Name: `bucket-${region}` }] })}\n`);
      process.exit(0);
      return;
    }

    case "call_echo_args": {
      // Emit the full argv (minus node executable and script path) as JSON on
      // stdout so tests can verify what flags runAwsCall actually assembled.
      process.stdout.write(`${JSON.stringify({ argv: process.argv.slice(2) })}\n`);
      process.exit(0);
      return;
    }

    case "awscli_utf8_split": {
      // Exercises the per-stream StringDecoder in runAwsCall: emit a multi-byte
      // UTF-8 character split across two stdout.write() calls so the decoder
      // must buffer the partial sequence across data events. Using "𠮷"
      // (U+20BB7, 4 bytes: F0 A0 AE B7) -- a supplementary-plane char that
      // also needs surrogate-pair handling in the resulting JS string. If the
      // production code is replaced by a naive chunk.toString(), the parent
      // sees U+FFFD U+FFFD instead of the intact codepoint.
      const fourByteChar = Buffer.from("\u{20BB7}", "utf8"); // F0 A0 AE B7
      // Write enough JSON shell to satisfy --output json parsing AND split the
      // multi-byte char across two distinct 'data' events. The sleep gives
      // the parent's stdout.on('data') a chance to fire on the first chunk
      // before the second arrives -- without it the kernel may coalesce the
      // two writes into a single chunk and the split-boundary path doesn't
      // exercise.
      process.stdout.write(Buffer.concat([Buffer.from('{"name":"'), fourByteChar.slice(0, 2)]));
      await sleep(50);
      process.stdout.write(Buffer.concat([fourByteChar.slice(2), Buffer.from('"}\n')]));
      process.exit(0);
      return;
    }

    case "paginate_has_more": {
      // Simulates a truncated page: CLI surfaces resume cursor as NextToken.
      process.stdout.write(
        `${JSON.stringify({
          Buckets: [{ Name: "bucket-1" }, { Name: "bucket-2" }],
          NextToken: "eyJuZXh0IjoiYWJjIn0=",
        })}\n`,
      );
      process.exit(0);
      return;
    }

    case "paginate_last_page": {
      // Final page: response omits NextToken.
      process.stdout.write(`${JSON.stringify({ Buckets: [{ Name: "bucket-3" }] })}\n`);
      process.exit(0);
      return;
    }

    case "paginate_query_wrapped_has_more": {
      // Simulates what the aws CLI emits for a wrapped query like
      // {NextToken: NextToken, items: Buckets[].Name} on a truncated page.
      process.stdout.write(
        `${JSON.stringify({
          NextToken: "eyJuZXh0IjoiYWJjIn0=",
          items: ["bucket-1", "bucket-2"],
        })}\n`,
      );
      process.exit(0);
      return;
    }

    case "paginate_query_wrapped_last_page": {
      // Final page with a wrapped query: NextToken evaluates to null.
      process.stdout.write(`${JSON.stringify({ NextToken: null, items: ["bucket-3"] })}\n`);
      process.exit(0);
      return;
    }

    case "ccapi_list_resources_paginated": {
      // Mimics `aws cloudcontrol list-resources` for the aws_resource_list
      // pagination path. Stateful by argv: when `--next-token` is present the
      // caller is resuming, so emit the FINAL page (ResourceDescriptions with
      // NO top-level NextToken). On the first call (no --next-token) emit a
      // truncated page: ResourceDescriptions PLUS a NextToken resume cursor.
      //
      // Each ResourceDescription carries an Identifier and a Properties field
      // that is a JSON-ENCODED STRING (not a parsed object) -- this is exactly
      // how CCAPI emits it, and parseResourceProperties in resource.ts is what
      // turns that string back into an object. Tests asserting
      // resources[i].properties get a parsed object; resources[i].identifier
      // gets the Identifier string. hasMore is derived from NextToken by the
      // handler (extractNextToken), so page 1 -> hasMore:true, page 2 ->
      // hasMore:false, nextToken:null.
      const argv = process.argv.slice(2);
      const isResume = argv.includes("--next-token");
      if (isResume) {
        // Final page: two resources, NO NextToken.
        process.stdout.write(
          `${JSON.stringify({
            ResourceDescriptions: [
              {
                Identifier: "/my/param-3",
                Properties: JSON.stringify({ Name: "/my/param-3", Type: "String", Value: "v3" }),
              },
              {
                Identifier: "/my/param-4",
                Properties: JSON.stringify({ Name: "/my/param-4", Type: "String", Value: "v4" }),
              },
            ],
          })}\n`,
        );
        process.exit(0);
        return;
      }
      // First page: two resources PLUS a resume cursor under NextToken.
      process.stdout.write(
        `${JSON.stringify({
          ResourceDescriptions: [
            {
              Identifier: "/my/param-1",
              Properties: JSON.stringify({ Name: "/my/param-1", Type: "String", Value: "v1" }),
            },
            {
              Identifier: "/my/param-2",
              Properties: JSON.stringify({ Name: "/my/param-2", Type: "String", Value: "v2" }),
            },
          ],
          NextToken: "ccapi-list-cursor-page2",
        })}\n`,
      );
      process.exit(0);
      return;
    }

    case "ccapi_create_then_status_success": {
      // Routes a single AWS_MCP_FAKE_SCENARIO across the two CLI calls the
      // create-with-awaitCompletion HAPPY path makes:
      //   1) cloudcontrol create-resource             -> IN_PROGRESS (success), RequestToken=req-tok-ok
      //   2) cloudcontrol get-resource-request-status -> SUCCESS    (success)
      // Drives buildMutationResponse + pollUntilTerminal end-to-end to a
      // terminal SUCCESS in one handler call. The status-poll branch reaches a
      // TERMINAL_STATUSES member ("SUCCESS") on the first poll, so attempts==1.
      // Companion to ccapi_create_then_status_sso_expired (the failure path).
      const argv = process.argv.slice(2);
      if (argv.includes("create-resource")) {
        process.stdout.write(
          `${JSON.stringify({
            ProgressEvent: {
              TypeName: "AWS::SSM::Parameter",
              Identifier: "/my/p",
              RequestToken: "req-tok-ok",
              OperationStatus: "IN_PROGRESS",
              Operation: "CREATE",
            },
          })}\n`,
        );
        process.exit(0);
        return;
      }
      if (argv.includes("get-resource-request-status")) {
        process.stdout.write(
          `${JSON.stringify({
            ProgressEvent: {
              TypeName: "AWS::SSM::Parameter",
              Identifier: "/my/p",
              RequestToken: "req-tok-ok",
              OperationStatus: "SUCCESS",
              Operation: "CREATE",
            },
          })}\n`,
        );
        process.exit(0);
        return;
      }
      process.stderr.write(`fake-aws: ccapi_create_then_status_success hit unexpected argv: ${argv.join(" ")}\n`);
      process.exit(2);
      return;
    }

    case "ccapi_create_already_terminal": {
      // The create-resource call returns a ProgressEvent that is ALREADY in a
      // terminal state (SUCCESS) on the very first response -- some CCAPI
      // resource types complete synchronously. With awaitCompletion:true the
      // handler's buildMutationResponse must SHORT-CIRCUIT: it sees the initial
      // status is terminal and skips the poll loop entirely (no `awaited`
      // block, attempts never run). To PROVE the poll was skipped, the
      // get-resource-request-status branch errors out -- if the handler ever
      // reaches it, the test sees ok:false instead of a clean SUCCESS.
      const argv = process.argv.slice(2);
      if (argv.includes("create-resource")) {
        process.stdout.write(
          `${JSON.stringify({
            ProgressEvent: {
              TypeName: "AWS::SSM::Parameter",
              Identifier: "/my/p",
              RequestToken: "req-tok-term",
              OperationStatus: "SUCCESS",
              Operation: "CREATE",
            },
          })}\n`,
        );
        process.exit(0);
        return;
      }
      if (argv.includes("get-resource-request-status")) {
        // Should be unreachable: the initial SUCCESS short-circuits the poll.
        process.stderr.write("fake-aws: ccapi_create_already_terminal poll was called but should have been skipped\n");
        process.exit(255);
        return;
      }
      process.stderr.write(`fake-aws: ccapi_create_already_terminal hit unexpected argv: ${argv.join(" ")}\n`);
      process.exit(2);
      return;
    }

    case "logs_tail_ndjson": {
      // 'aws logs tail --format json' emits one JSON object per line.
      process.stdout.write(
        `${JSON.stringify({ timestamp: "2026-04-21T00:00:00Z", logStreamName: "s1", message: "hello" })}\n${JSON.stringify(
          {
            timestamp: "2026-04-21T00:00:01Z",
            logStreamName: "s1",
            message: "world",
          },
        )}\n${JSON.stringify({ timestamp: "2026-04-21T00:00:02Z", logStreamName: "s2", message: "ok" })}\n`,
      );
      process.exit(0);
      return;
    }

    case "logs_tail_empty": {
      // No events in the window -- empty stdout, exit 0.
      process.exit(0);
      return;
    }

    case "logs_tail_ndjson_malformed": {
      // Multi-line NDJSON where ONE line is not valid JSON. The aws CLI
      // normally never emits this, but a partially-flushed event, an injected
      // CLI warning line, or a truncated final record can produce it.
      // parseLogsJsonOutput in logs.ts gives up on the first un-parseable line
      // and returns the RAW string unchanged; the handler then renders
      // eventCount=null (since events is a string, not an array) while still
      // surfacing the blob in `events` for diagnosis. First line is valid JSON,
      // second line is garbage, third line is valid JSON -- so the failure is
      // mid-stream, not at the very start.
      process.stdout.write(
        `${JSON.stringify({ timestamp: "2026-04-21T00:00:00Z", logStreamName: "s1", message: "hello" })}\n` +
          "this-line-is-not-json\n" +
          `${JSON.stringify({ timestamp: "2026-04-21T00:00:02Z", logStreamName: "s2", message: "ok" })}\n`,
      );
      process.exit(0);
      return;
    }

    case "sts_caller_identity_success": {
      // Mimics `aws sts get-caller-identity --output json`.
      process.stdout.write(
        `${JSON.stringify({
          UserId: "AIDA1234EXAMPLE",
          Account: "123456789012",
          Arn: "arn:aws:iam::123456789012:user/Alice",
        })}\n`,
      );
      process.exit(0);
      return;
    }

    case "ccapi_create_then_status_sso_expired": {
      // Routes a single AWS_MCP_FAKE_SCENARIO across the two CLI calls the
      // create-with-awaitCompletion flow makes:
      //   1) cloudcontrol create-resource         -> IN_PROGRESS (success)
      //   2) cloudcontrol get-resource-request-status -> SSO expired
      // Lets us drive the buildMutationResponse recovery-hint path through
      // the real handler without two-step env-var juggling.
      const argv = process.argv.slice(2);
      if (argv.includes("create-resource")) {
        process.stdout.write(
          `${JSON.stringify({
            ProgressEvent: {
              TypeName: "AWS::SSM::Parameter",
              Identifier: "/my/p",
              RequestToken: "req-tok-abc",
              OperationStatus: "IN_PROGRESS",
              Operation: "CREATE",
            },
          })}\n`,
        );
        process.exit(0);
        return;
      }
      if (argv.includes("get-resource-request-status")) {
        process.stderr.write("Error loading SSO Token: Token for my-profile is expired.\n");
        process.exit(255);
        return;
      }
      process.stderr.write(`fake-aws: ccapi_create_then_status_sso_expired hit unexpected argv: ${argv.join(" ")}\n`);
      process.exit(2);
      return;
    }

    case "iam_simulate_allow": {
      // All requested actions allowed by a single matched statement.
      process.stdout.write(
        `${JSON.stringify({
          EvaluationResults: [
            {
              EvalActionName: "lambda:CreateFunction",
              EvalResourceName: "*",
              EvalDecision: "allowed",
              MatchedStatements: [{ SourcePolicyId: "AdministratorAccess", SourcePolicyType: "IAM Policy" }],
              MissingContextValues: [],
            },
          ],
        })}\n`,
      );
      process.exit(0);
      return;
    }

    case "iam_simulate_mixed": {
      // Two actions: one allowed, one explicitDeny with a matched deny
      // statement and a missing context value.
      process.stdout.write(
        `${JSON.stringify({
          EvaluationResults: [
            {
              EvalActionName: "s3:GetObject",
              EvalResourceName: "arn:aws:s3:::my-bucket/*",
              EvalDecision: "allowed",
              MatchedStatements: [{ SourcePolicyId: "ReadOnlyAccess", SourcePolicyType: "IAM Policy" }],
            },
            {
              EvalActionName: "s3:DeleteObject",
              EvalResourceName: "arn:aws:s3:::my-bucket/*",
              EvalDecision: "explicitDeny",
              MatchedStatements: [{ SourcePolicyId: "DenyDeletes", SourcePolicyType: "IAM Policy" }],
              MissingContextValues: ["aws:RequestTag/Project"],
            },
          ],
        })}\n`,
      );
      process.exit(0);
      return;
    }

    case "assume_role_success": {
      // Mimics `aws sts assume-role --output json` on a successful assume.
      // Mirrors the real CLI shape: Credentials, AssumedRoleUser, PackedPolicySize.
      process.stdout.write(
        `${JSON.stringify({
          Credentials: {
            AccessKeyId: "ASIA1234EXAMPLE",
            SecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            SessionToken: "FQoGZXIvYXdzEXAMPLETOKENBLAHBLAH",
            Expiration: "2099-12-31T23:59:59+00:00",
          },
          AssumedRoleUser: {
            AssumedRoleId: "AROA1234EXAMPLE:my-session",
            Arn: "arn:aws:sts::123456789012:assumed-role/Admin/my-session",
          },
          PackedPolicySize: 6,
        })}\n`,
      );
      process.exit(0);
      return;
    }

    case "assume_role_incomplete": {
      // CLI returns 0 but the Credentials block is missing required fields --
      // tests the post-success defensive guard in the handler.
      process.stdout.write(
        `${JSON.stringify({
          Credentials: { AccessKeyId: "ASIA1234EXAMPLE" },
          AssumedRoleUser: { Arn: "arn:aws:sts::123:assumed-role/Admin/sess" },
        })}\n`,
      );
      process.exit(0);
      return;
    }

    case "assume_role_echo_args": {
      // Capture-and-echo variant for aws_assume_role: write the full argv as
      // JSON to AWS_MCP_FAKE_ARGV_OUT (side channel, since the handler discards
      // everything except Credentials/AssumedRoleUser), then emit a normal
      // successful assume-role payload so the handler returns ok:true and the
      // post-success path runs. Lets a test assert that DurationSeconds /
      // ExternalId reached the CLI inside --cli-input-json AND that the source
      // profile reached --profile. Modeled on iam_sim_echo_argv.
      //
      // The handler sends assume-role params (RoleArn / RoleSessionName /
      // DurationSeconds / ExternalId) via --cli-input-json; the source profile
      // lands as a separate --profile argv entry. Both are recoverable from
      // the echoed argv.
      const outPath = process.env.AWS_MCP_FAKE_ARGV_OUT;
      if (outPath) {
        const fs = await import("node:fs");
        fs.writeFileSync(outPath, JSON.stringify(process.argv.slice(2)));
      }
      process.stdout.write(
        `${JSON.stringify({
          Credentials: {
            AccessKeyId: "ASIA1234EXAMPLE",
            SecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            SessionToken: "FQoGZXIvYXdzEXAMPLETOKENBLAHBLAH",
            Expiration: "2099-12-31T23:59:59+00:00",
          },
          AssumedRoleUser: {
            AssumedRoleId: "AROA1234EXAMPLE:my-session",
            Arn: "arn:aws:sts::123456789012:assumed-role/Admin/my-session",
          },
          PackedPolicySize: 6,
        })}\n`,
      );
      process.exit(0);
      return;
    }

    case "assume_role_success_no_expiration": {
      // Successful assume whose Credentials block has all three required
      // fields (AccessKeyId / SecretAccessKey / SessionToken) but NO
      // Expiration. AWS always returns Expiration in practice, but the handler
      // reads it defensively (`creds.Expiration` is optional) and must not
      // crash or emit a bogus expiration. The returned envelope should have
      // expiration === undefined and the hint should render the
      // "expire at unknown" fallback. AssumedRoleUser is present so the
      // assumedRoleArn / assumedRoleId fields still populate.
      process.stdout.write(
        `${JSON.stringify({
          Credentials: {
            AccessKeyId: "ASIA1234NOEXPIRE",
            SecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYNOEXPIRE",
            SessionToken: "FQoGZXIvYXdzNOEXPIRETOKEN",
          },
          AssumedRoleUser: {
            AssumedRoleId: "AROA1234EXAMPLE:no-exp-session",
            Arn: "arn:aws:sts::123456789012:assumed-role/Admin/no-exp-session",
          },
          PackedPolicySize: 6,
        })}\n`,
      );
      process.exit(0);
      return;
    }

    case "assume_role_slow": {
      // Sleep longer than the test's timeoutMs to exercise the timeout path
      // when aws_assume_role propagates a user-supplied timeoutMs through to
      // runAwsCall.
      await sleep(5000);
      process.stdout.write("{}\n");
      process.exit(0);
      return;
    }

    case "assume_role_access_denied": {
      // Real-world shape for an unauthorized AssumeRole call.
      process.stderr.write(
        "An error occurred (AccessDenied) when calling the AssumeRole operation: User: arn:aws:iam::123456789012:user/jeff is not authorized to perform: sts:AssumeRole on resource: arn:aws:iam::999999999999:role/NoSuchRole\n",
      );
      process.exit(255);
      return;
    }

    case "resource_update_sso_expired_mid_poll": {
      // Mirrors `ccapi_create_then_status_sso_expired` for the update path:
      //   1) cloudcontrol update-resource         -> IN_PROGRESS (success)
      //   2) cloudcontrol get-resource-request-status -> SSO expired
      // Drives the buildMutationResponse recovery-hint path for
      // aws_resource_update through the real handler.
      const argv = process.argv.slice(2);
      if (argv.includes("update-resource")) {
        process.stdout.write(
          `${JSON.stringify({
            ProgressEvent: {
              TypeName: "AWS::Lambda::Function",
              Identifier: "my-fn",
              RequestToken: "req-tok-upd",
              OperationStatus: "IN_PROGRESS",
              Operation: "UPDATE",
            },
          })}\n`,
        );
        process.exit(0);
        return;
      }
      if (argv.includes("get-resource-request-status")) {
        process.stderr.write("Error loading SSO Token: Token for my-profile is expired.\n");
        process.exit(255);
        return;
      }
      process.stderr.write(`fake-aws: resource_update_sso_expired_mid_poll hit unexpected argv: ${argv.join(" ")}\n`);
      process.exit(2);
      return;
    }

    case "resource_delete_sso_expired_mid_poll": {
      // Same pattern for the delete path.
      const argv = process.argv.slice(2);
      if (argv.includes("delete-resource")) {
        process.stdout.write(
          `${JSON.stringify({
            ProgressEvent: {
              TypeName: "AWS::S3::Bucket",
              Identifier: "my-bucket",
              RequestToken: "req-tok-del",
              OperationStatus: "IN_PROGRESS",
              Operation: "DELETE",
            },
          })}\n`,
        );
        process.exit(0);
        return;
      }
      if (argv.includes("get-resource-request-status")) {
        process.stderr.write("Error loading SSO Token: Token for my-profile is expired.\n");
        process.exit(255);
        return;
      }
      process.stderr.write(`fake-aws: resource_delete_sso_expired_mid_poll hit unexpected argv: ${argv.join(" ")}\n`);
      process.exit(2);
      return;
    }

    case "resource_delete_no_creds_mid_poll": {
      // Mid-poll auth lapse where credentials disappear (vs. SSO expiry).
      // The buildMutationResponse recovery hint differs for kind=no_creds
      // (it points at fixing credentials rather than re-running aws_login_start).
      // Delete is the right verb to test: it's destructive, so a buried
      // mid-poll failure has the highest blast radius.
      const argv = process.argv.slice(2);
      if (argv.includes("delete-resource")) {
        process.stdout.write(
          `${JSON.stringify({
            ProgressEvent: {
              TypeName: "AWS::S3::Bucket",
              Identifier: "my-bucket",
              RequestToken: "req-tok-del-nc",
              OperationStatus: "IN_PROGRESS",
              Operation: "DELETE",
            },
          })}\n`,
        );
        process.exit(0);
        return;
      }
      if (argv.includes("get-resource-request-status")) {
        process.stderr.write(
          "Unable to locate credentials. You can configure credentials by running 'aws configure'.\n",
        );
        process.exit(255);
        return;
      }
      process.stderr.write(`fake-aws: resource_delete_no_creds_mid_poll hit unexpected argv: ${argv.join(" ")}\n`);
      process.exit(2);
      return;
    }

    case "iam_simulate_implicit_deny": {
      // No matching statement at all -- the result is implicitDeny.
      process.stdout.write(
        `${JSON.stringify({
          EvaluationResults: [
            {
              EvalActionName: "ec2:TerminateInstances",
              EvalResourceName: "*",
              EvalDecision: "implicitDeny",
              MatchedStatements: [],
            },
          ],
        })}\n`,
      );
      process.exit(0);
      return;
    }

    case "iam_simulate_advisory_and_filter": {
      // Exercises three branches of parseSimulationResults in one response:
      //
      //  [0] EvalDecision MISSING entirely -> parseSimulationResults falls back
      //      to decision="unknown". Because the handler counts allowed by
      //      `decision === "allowed"`, this entry lands in the DENIED bucket
      //      (allowed:0). Also its sole MatchedStatements entry has a
      //      NON-STRING SourcePolicyId (number 42), so the matched-statement
      //      filter drops it and matchedStatementIds stays undefined.
      //
      //  [1] Carries OrganizationsDecisionDetail.AllowedByOrganizations=false
      //      and PermissionsBoundaryDecisionDetail.AllowedByPermissionsBoundary
      //      =true -> the advisory fields organizationsDecision="denied" and
      //      permissionsBoundaryDecision="allowed" populate. Decision is a
      //      real "allowed" so this is the one allowed entry.
      //
      //  [2] A MatchedStatements array that MIXES a valid string SourcePolicyId
      //      ("KeepThis") with an entry whose SourcePolicyId is non-string
      //      (null) and an entry missing SourcePolicyId entirely -> the filter
      //      keeps ONLY "KeepThis". decision="explicitDeny" (denied bucket).
      //
      // Net summary: allowed=1, denied=2, total=3.
      process.stdout.write(
        `${JSON.stringify({
          EvaluationResults: [
            {
              EvalActionName: "s3:GetObject",
              EvalResourceName: "*",
              // EvalDecision intentionally omitted -> "unknown"
              MatchedStatements: [{ SourcePolicyId: 42, SourcePolicyType: "IAM Policy" }],
            },
            {
              EvalActionName: "lambda:InvokeFunction",
              EvalResourceName: "*",
              EvalDecision: "allowed",
              MatchedStatements: [{ SourcePolicyId: "OrgAllowed", SourcePolicyType: "IAM Policy" }],
              OrganizationsDecisionDetail: { AllowedByOrganizations: false },
              PermissionsBoundaryDecisionDetail: { AllowedByPermissionsBoundary: true },
            },
            {
              EvalActionName: "ec2:TerminateInstances",
              EvalResourceName: "*",
              EvalDecision: "explicitDeny",
              MatchedStatements: [
                { SourcePolicyId: "KeepThis", SourcePolicyType: "IAM Policy" },
                { SourcePolicyId: null, SourcePolicyType: "IAM Policy" },
                { SourcePolicyType: "IAM Policy" },
              ],
            },
          ],
        })}\n`,
      );
      process.exit(0);
      return;
    }

    case "metrics_success": {
      // Realistic GetMetricData response with two series: one CPUUtilization
      // (regular metric-stat) and one expression-derived (uses same Timestamps
      // axis). Mirrors what CloudWatch emits for a typical "show CPU + load
      // over 1h" query.
      process.stdout.write(
        `${JSON.stringify({
          MetricDataResults: [
            {
              Id: "cpu",
              Label: "CPUUtilization",
              Timestamps: ["2026-05-16T11:00:00Z", "2026-05-16T10:55:00Z", "2026-05-16T10:50:00Z"],
              Values: [42.5, 38.1, 35.7],
              StatusCode: "Complete",
            },
            {
              Id: "expr",
              Label: "cpu_x2",
              Timestamps: ["2026-05-16T11:00:00Z", "2026-05-16T10:55:00Z", "2026-05-16T10:50:00Z"],
              Values: [85.0, 76.2, 71.4],
              StatusCode: "Complete",
            },
          ],
          Messages: [],
        })}\n`,
      );
      process.exit(0);
      return;
    }

    case "metrics_empty": {
      // CloudWatch returns the MetricDataResults envelope with empty
      // Timestamps/Values when no datapoints exist in the window. The series
      // entry still appears so callers can tell "the query ran but returned
      // nothing" vs "the query never executed."
      process.stdout.write(
        `${JSON.stringify({
          MetricDataResults: [
            {
              Id: "cpu",
              Label: "CPUUtilization",
              Timestamps: [],
              Values: [],
              StatusCode: "Complete",
            },
          ],
          Messages: [],
        })}\n`,
      );
      process.exit(0);
      return;
    }

    case "metrics_partial_data": {
      // StatusCode='PartialData' when CloudWatch truncated -- the agent
      // should surface this so a caller knows their datapoints aren't the
      // full picture.
      process.stdout.write(
        `${JSON.stringify({
          MetricDataResults: [
            {
              Id: "cpu",
              Label: "CPUUtilization",
              Timestamps: ["2026-05-16T11:00:00Z"],
              Values: [42.5],
              StatusCode: "PartialData",
            },
          ],
          Messages: [{ Code: "MaxMetricsExceeded", Value: "Maximum allowed metrics exceeded" }],
        })}\n`,
      );
      process.exit(0);
      return;
    }

    case "metrics_bad_metric": {
      // Real-world shape for an invalid namespace or malformed query.
      process.stderr.write(
        "An error occurred (ValidationError) when calling the GetMetricData operation: The parameter MetricDataQueries.member.1.MetricStat.Metric.Namespace is required.\n",
      );
      process.exit(255);
      return;
    }

    case "metrics_paginated": {
      // Stateful by argv inspection: if the --cli-input-json payload carries
      // a top-level NextToken (= caller is resuming), emit the final page;
      // otherwise emit the first page with a NextToken pointing at the
      // resume cursor. Lets one scenario name cover both call shapes in a
      // paginate test. Parse the payload as JSON and check the actual key
      // rather than substring-matching '"NextToken"' -- a metric label,
      // dimension value, or expression containing that literal would
      // otherwise silently switch branches.
      const argv = process.argv.slice(2);
      const jsonIdx = argv.indexOf("--cli-input-json");
      const payload = jsonIdx >= 0 ? argv[jsonIdx + 1] : "";
      let isResume = false;
      try {
        const parsed = JSON.parse(payload) as { NextToken?: unknown };
        isResume = parsed.NextToken !== undefined;
      } catch {
        // Malformed JSON shouldn't reach us in a real call (runAwsCall
        // serializes the payload). If it does, default to the first-page
        // branch so the test fails loud rather than silently resuming.
        isResume = false;
      }
      if (isResume) {
        process.stdout.write(
          `${JSON.stringify({
            MetricDataResults: [
              {
                Id: "cpu",
                Label: "CPUUtilization",
                Timestamps: ["2026-05-16T09:00:00Z"],
                Values: [33.3],
                StatusCode: "Complete",
              },
            ],
            Messages: [],
          })}\n`,
        );
        process.exit(0);
        return;
      }
      process.stdout.write(
        `${JSON.stringify({
          MetricDataResults: [
            {
              Id: "cpu",
              Label: "CPUUtilization",
              Timestamps: ["2026-05-16T11:00:00Z", "2026-05-16T10:00:00Z"],
              Values: [42.5, 38.1],
              StatusCode: "Complete",
            },
          ],
          Messages: [],
          NextToken: "eyJtZXRyaWNzIjoiYWJjIn0=",
        })}\n`,
      );
      process.exit(0);
      return;
    }

    case "metrics_echo_argv": {
      // Capture-and-echo variant: dump argv to AWS_MCP_FAKE_ARGV_OUT so tests
      // can verify the --cli-input-json payload includes the right
      // MetricDataQueries shape. Returns an empty-but-valid response.
      const outPath = process.env.AWS_MCP_FAKE_ARGV_OUT;
      if (outPath) {
        const fs = await import("node:fs");
        fs.writeFileSync(outPath, JSON.stringify(process.argv.slice(2)));
      }
      process.stdout.write(`${JSON.stringify({ MetricDataResults: [], Messages: [] })}\n`);
      process.exit(0);
      return;
    }

    case "iam_sim_echo_argv": {
      // Capture-and-echo variant for iam_simulate: writes the full argv as
      // JSON to the path in AWS_MCP_FAKE_ARGV_OUT (side channel that survives
      // the handler discarding everything except EvaluationResults), then
      // emits a normal-shaped EvaluationResults on stdout so the handler
      // returns ok:true. Lets tests verify that the handler's
      // camelCase -> PascalCase mapping (iam-simulate.ts:215-220) produces
      // the right CLI flags (ContextKeyName/ContextKeyType/ContextKeyValues
      // inside --cli-input-json). Modeled on call_echo_args.
      const outPath = process.env.AWS_MCP_FAKE_ARGV_OUT;
      if (outPath) {
        const fs = await import("node:fs");
        fs.writeFileSync(outPath, JSON.stringify(process.argv.slice(2)));
      }
      process.stdout.write(
        `${JSON.stringify({
          EvaluationResults: [
            {
              EvalActionName: "s3:GetObject",
              EvalResourceName: "*",
              EvalDecision: "allowed",
              MatchedStatements: [],
            },
          ],
        })}\n`,
      );
      process.exit(0);
      return;
    }

    default: {
      process.stderr.write(`fake-aws: unknown scenario '${scenario}'\n`);
      process.exit(2);
      return;
    }
  }
}

void main();
