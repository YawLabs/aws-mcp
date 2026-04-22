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

    default: {
      process.stderr.write(`fake-aws: unknown scenario '${scenario}'\n`);
      process.exit(2);
    }
  }
}

void main();
