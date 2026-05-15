/**
 * A controlled stand-in for the real `aws` CLI, used only by integration
 * tests. Invoked like:
 *   node dist/testing/fake-aws.js sso login --no-browser --profile foo
 *
 * Reads the `AWS_MCP_FAKE_SCENARIO` env var to decide what to emit.
 * Exercises the full subprocess path in sso.ts (spawn, pipe stdout, exit
 * handling) without requiring a real AWS CLI or SSO setup in CI.
 */

const scenario = process.env.AWS_MCP_FAKE_SCENARIO ?? "happy";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  switch (scenario) {
    case "happy": {
      // Realistic aws-cli output: banner text, URL, code, then successful auth.
      process.stdout.write(
        "Attempting to automatically open the SSO authorization page in your default browser.\n" +
          "If the browser does not open or you wish to use a different device to authorize this request, open the following URL:\n\n" +
          "https://device.sso.us-east-1.amazonaws.com/\n\n" +
          "Then enter the code:\n\n" +
          "ABCD-EFGH\n",
      );
      await sleep(200); // Simulate user auth delay
      process.stdout.write("Successfully logged into Start URL: https://d-test.awsapps.com/start\n");
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

    case "slow_url": {
      // Wait longer than the test's urlWaitMs before emitting — exercises timeout.
      await sleep(3000);
      process.stdout.write("https://device.sso.us-east-1.amazonaws.com/\nABCD-EFGH\n");
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

    case "call_slow": {
      // Sleep longer than the test's timeoutMs to exercise the timeout path.
      await sleep(5000);
      process.stdout.write("{}\n");
      process.exit(0);
      return;
    }

    case "call_large": {
      // Stream more than MAX_OUTPUT_BYTES (5 MB) so the parent kills us.
      const oneMb = "x".repeat(1024 * 1024);
      for (let i = 0; i < 8; i++) {
        process.stdout.write(oneMb);
        await sleep(10); // give parent a chance to read, hit the cap, and kill us
      }
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

    case "ccapi_in_progress": {
      // Mimics a cloudcontrol create/update/delete-resource initial response:
      // operation accepted, IN_PROGRESS, with a RequestToken to poll.
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

    case "ccapi_status_sso_expired": {
      // Mimics `aws cloudcontrol get-resource-request-status` failing with
      // the same SSO expiry stderr aws_call sees, so awaitCompletion
      // surfaces the same hint.
      process.stderr.write("Error loading SSO Token: Token for my-profile is expired.\n");
      process.exit(255);
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

    default: {
      process.stderr.write(`fake-aws: unknown scenario '${scenario}'\n`);
      process.exit(2);
    }
  }
}

void main();
