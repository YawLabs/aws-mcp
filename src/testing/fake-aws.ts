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

    default: {
      process.stderr.write(`fake-aws: unknown scenario '${scenario}'\n`);
      process.exit(2);
    }
  }
}

void main();
