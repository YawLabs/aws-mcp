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
 *
 * Scenario classes: argv-branching scenarios (e.g. ccapi_list_resources_paginated,
 * mr_partial_failure, metrics_paginated) are per-process safe -- they carry all
 * state in argv, not in a shared env var. The env-var scenario dispatch
 * (AWS_MCP_FAKE_SCENARIO itself) is the shared-state surface that requires
 * the sequential guard above.
 */

const scenario = process.env.AWS_MCP_FAKE_SCENARIO;

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

// What a real `aws sso login --no-browser` prints WITHOUT --use-device-code on
// AWS CLI >= 2.22.0: an authorize URL and no short code. Modeled on the real
// message template in awscli/customizations/sso/utils.py.
const PKCE_BANNER =
  "Attempting to open your default browser. If the browser does not open, open the following URL.\n" +
  "If you are unable to open the URL on this device, run this command again with the '--use-device-code' option.\n\n" +
  "https://oidc.us-east-1.amazonaws.com/authorize?response_type=code&client_id=fake&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2Foauth%2Fcallback&code_challenge=fake&code_challenge_method=S256\n";

/**
 * `aws --version` intercept, ahead of the scenario switch.
 *
 * sso.ts probes the CLI version once per binary to decide whether to pass
 * `--use-device-code`. Without this branch the probe would fall through to
 * whatever AWS_MCP_FAKE_SCENARIO is set to and either parse a login banner as
 * a version string or (for `happy_hold`) hang until the probe timeout, putting
 * that penalty on every integration test in the file.
 *
 * Knobs, all optional:
 *   AWS_MCP_FAKE_CLI_VERSION       version to report (default "2.34.3").
 *                                  "none" prints nothing (unparseable path);
 *                                  "hang" never responds and never exits, so
 *                                  the probe's own timeout has to fire.
 *   AWS_MCP_FAKE_VERSION_STREAM    "stderr" to print the line on stderr
 *                                  instead of stdout. sso.ts reads both pipes;
 *                                  this is what proves the stderr reader works.
 *   AWS_MCP_FAKE_VERSION_NOISE_BYTES  emit N bytes of filler BEFORE the version
 *                                  line, to push it past the probe's byte cap.
 *   AWS_MCP_FAKE_VERSION_COUNT_OUT append one byte per probe invocation to this
 *                                  path. The file's SIZE is the spawn count --
 *                                  append, not overwrite, because the whole
 *                                  point is counting repeats. Same side-channel
 *                                  idea as AWS_MCP_FAKE_ARGV_OUT.
 */
async function handleVersionProbe(): Promise<boolean> {
  if (process.argv[2] !== "--version") return false;

  const countPath = process.env.AWS_MCP_FAKE_VERSION_COUNT_OUT;
  if (countPath) {
    const fs = await import("node:fs");
    fs.appendFileSync(countPath, "1");
  }

  const version = process.env.AWS_MCP_FAKE_CLI_VERSION ?? "2.34.3";
  if (version === "hang") {
    // Never print, never exit. The parent must bound this itself.
    await sleep(10 * 60_000);
    process.exit(0);
  }

  const stream = process.env.AWS_MCP_FAKE_VERSION_STREAM === "stderr" ? process.stderr : process.stdout;
  const noiseBytes = Number(process.env.AWS_MCP_FAKE_VERSION_NOISE_BYTES ?? "0");
  if (Number.isFinite(noiseBytes) && noiseBytes > 0) {
    stream.write(`${"x".repeat(noiseBytes)}\n`);
  }
  if (version !== "none") {
    stream.write(`aws-cli/${version} Python/3.13.11 Windows/11 exe/AMD64\n`);
  }
  // Return rather than process.exit(0): writes to a pipe are asynchronous, and
  // exiting in the same breath can truncate them. Observed on the stderr
  // variant -- it passed alone and failed under a loaded full-file run, which
  // is exactly the shape of a lost write. Falling out of main() lets Node exit
  // on its own once stdio has flushed.
  return true;
}

/**
 * Locate the positional outfile in an `aws lambda invoke` argv.
 *
 * runAwsCall appends `--output <fmt> --profile <p> --region <r>` immediately
 * after the caller's extraFlags, and tools/lambda.ts puts the outfile last in
 * extraFlags -- so the outfile is always the entry directly before `--output`.
 * Anchoring on that boundary rather than "the last token that isn't a flag"
 * keeps this from mistaking a flag VALUE (the qualifier, the function name) for
 * the path.
 */
function lambdaOutfileFromArgv(): string | undefined {
  const idx = process.argv.indexOf("--output");
  if (idx <= 0) return undefined;
  return process.argv[idx - 1];
}

/**
 * Execution-log text the lambda_* scenarios base64 into LogResult. Shared so
 * the happy path and the FunctionError path decode to the identical string and
 * a test can assert the decode without pinning two separate literals.
 */
const LAMBDA_FAKE_LOG_TEXT =
  "START RequestId: 8f3a1c2e-0000-4000-8000-abcdefabcdef Version: $LATEST\n" +
  "hello from the handler\n" +
  "END RequestId: 8f3a1c2e-0000-4000-8000-abcdefabcdef\n";

async function main(): Promise<void> {
  if (await handleVersionProbe()) return;
  switch (scenario) {
    case "happy": {
      // Realistic aws-cli output: banner text, URL, code, then successful auth.
      // HARD CONSTRAINT: the default 200ms exit timing is the contract that
      // auth.test.ts and several sso.integration.test.ts cases (TTL
      // killswitch, completed-session exclusion) depend on. Do not change
      // the default. AWS_MCP_FAKE_HAPPY_EXIT_MS exists only for slow-CI
      // widening -- it must not be set in normal test runs. If you need a
      // session that stays active deterministically, use `happy_hold`.
      // A garbage env value would make Number() return NaN (and "" parses to
      // 0, negatives are equally bogus) -- setTimeout with any of those fires
      // immediately, silently shrinking the 200ms window the timing tests
      // anchor on. Fall back to the contract default unless the value is a
      // positive finite number.
      const parsedExitMs = Number(process.env.AWS_MCP_FAKE_HAPPY_EXIT_MS ?? "200");
      const exitMs = Number.isFinite(parsedExitMs) && parsedExitMs > 0 ? parsedExitMs : 200;
      process.stdout.write(HAPPY_URL_CODE_BANNER);
      await sleep(exitMs); // Simulate user auth delay
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

    case "pkce_no_device_code": {
      // The regression this guards: `aws sso login --no-browser` on CLI
      // >= 2.22.0 without --use-device-code. An authorize URL, no short code.
      // startSsoLogin must name the PKCE flow rather than time out.
      process.stdout.write(PKCE_BANNER);
      await sleep(10 * 60_000); // real CLI blocks on its localhost callback
      process.exit(0);
      return;
    }

    case "pkce_no_device_code_stderr": {
      // Same as pkce_no_device_code but on the other pipe. Pins that the PKCE
      // detector runs from BOTH stream handlers -- a stdout-only check would
      // silently regress this case to the 15s URL timeout.
      process.stderr.write(PKCE_BANNER);
      await sleep(10 * 60_000);
      process.exit(0);
      return;
    }

    case "device_code_flag_echo": {
      // Echoes the login argv so a test can assert --use-device-code is
      // actually on the command line, then behaves like `happy`.
      process.stderr.write(`ARGV:${process.argv.slice(2).join(" ")}\n`);
      process.stdout.write(HAPPY_URL_CODE_BANNER);
      await sleep(200);
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
      // 250ms, not 50ms. sso.ts listens on proc 'exit', which Node can deliver
      // BEFORE the last pipe 'data' event drains -- so too short a window lets
      // a loaded machine see the exit first and report "exited before printing
      // a URL", failing tests that require the URL+code to land first. Observed
      // under a full parallel `npm test`; never reproduced running this file
      // alone. 250ms matches the `happy` scenario's 200ms exit convention.
      // Production is unaffected: the real CLI blocks on the user, it does not
      // print and exit in the same breath.
      await sleep(250);
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

    case "call_truncated_json": {
      // Exit 0 with stdout that OPENS as a JSON object and is cut off partway
      // -- what a killed upload, a full disk, or a proxy dropping the response
      // body actually produces. The sibling of call_nonjson_success, and the
      // pair is the whole point: both fail JSON.parse, and runAwsCall must
      // treat them completely differently. The scalar is a legitimate success;
      // this one is a truncated payload and settles as kind:"malformed_json".
      //
      // Before that split, a truncated response came back as {ok:true, data:
      // "<the broken text>"} -- the caller was told the call SUCCEEDED and
      // handed a string where the schema promises an object.
      process.stdout.write('{"Buckets":[{"Name":"bucket-1"},{"Na');
      process.exit(0);
      return;
    }

    case "call_truncated_json_array": {
      // Same as above but opening with '[', the other JSON container. Pins
      // that the detection is not '{'-only.
      process.stdout.write('[{"Name":"bucket-1"},{"Nam');
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

    case "awscli_expired_token": {
      // The service-side expiry wrapper, as emitted for an expired STS session
      // that has NOTHING to do with SSO. Sibling of call_sso_expired, and the
      // pair is the point: both are "expired", but only one of them can be
      // fixed by aws_login_start, so runAwsCall must not give them the same
      // advice. Real shape, from an assume-role session past its Expiration.
      process.stderr.write(
        "An error occurred (ExpiredToken) when calling the ListBuckets operation: The provided token has expired.\n",
      );
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
      // partial bytes survived the kill. The fragment is intentionally NOT
      // valid JSON on its own -- the timeout path never parses stdout, it just
      // preserves the raw bytes.
      //
      // Behavior is unchanged now that runAwsCall settles on 'close' instead of
      // 'exit', but the reason it holds is stronger. Under 'exit' the parent
      // could settle the moment we were reaped, with our fragment still sitting
      // unread in the pipe -- so the sleep below was load-bearing, buying the
      // parent's stdout.on('data') a chance to drain first. 'close' fires only
      // after the pipes are drained and closed, so the fragment is now
      // guaranteed to be in rawStdout however the scheduling falls. The sleep
      // stays because it keeps the two-chunk write shape this scenario is
      // named for; it is no longer what makes the assertion pass.
      //
      // What DOES still matter is ordering: we must get this write out before
      // the parent's timeout kills us, so the test's timeoutMs has to clear
      // Node's cold start. See the note on the caller in
      // aws-cli.integration.test.ts.
      process.stdout.write('{"partial":"this-arrived-before-the-timeout"');
      await sleep(50); // keeps the write split across two chunks
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
      // Coupling: --region position here must match the fixed argv layout in
      // runAwsCall (aws-cli.ts:208-209), which places --region immediately
      // before the region value. If that placement ever changes, regionIdx+1
      // will silently resolve to the wrong token.
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

    case "awscli_orphan_holds_pipes":
    case "awscli_orphan_outlives_exit": {
      // Both model the shape that hangs runAwsCall when it settles ONLY on
      // 'close': a descendant that inherited our stdio and outlives us, so the
      // write ends of the parent's pipes never close and 'close' never fires.
      // That is what `aws ssm start-session` / `aws ecs execute-command` do when
      // they hand off to session-manager-plugin, and both are reachable through
      // aws_call (validateNames permits them; there is no interactive denylist).
      //
      // The two cases cover the two DISTINCT failure paths in runAwsCall:
      //   awscli_orphan_holds_pipes  -- we stay alive past the caller's
      //     timeoutMs, so the timeout callback kills US and then waits on
      //     'close'. killProc guarantees this process dies; it says nothing
      //     about the orphan holding the pipes.
      //   awscli_orphan_outlives_exit -- we exit CLEANLY and fast, long before
      //     timeoutMs. The timeout callback's procHasExited() guard then returns
      //     early and never attempts a kill at all, so nothing bounds the wait.
      //
      // detached:true is load-bearing and must not be simplified away. libuv
      // assigns a spawned child to its global job object ONLY when the child is
      // not detached, and that job carries KILL_ON_JOB_CLOSE -- so on Windows a
      // plainly-spawned grandchild dies WITH us and the bug is masked (measured
      // here: 'close' at parent-exit +7ms non-detached, versus never within 6s
      // detached). On POSIX detached makes the orphan a session leader, so
      // killProc's SIGTERM to our process group does not reach it either.
      //
      // Knobs:
      //   AWS_MCP_FAKE_ORPHAN_PID_OUT  path to write the orphan's pid to, so the
      //                                test can reap it instead of leaving the
      //                                parent's pipes (and the test file's event
      //                                loop) pinned open for the full hold.
      //   AWS_MCP_FAKE_ORPHAN_HOLD_MS  how long the orphan lives (default 30s).
      //                                Must comfortably EXCEED the assertion
      //                                window, or an unfixed runAwsCall settles
      //                                on its own and the test passes vacuously.
      const { spawn } = await import("node:child_process");
      const parsedHold = Number(process.env.AWS_MCP_FAKE_ORPHAN_HOLD_MS ?? "30000");
      const holdMs = Number.isFinite(parsedHold) && parsedHold > 0 ? parsedHold : 30_000;
      const orphan = spawn(process.execPath, ["-e", `setTimeout(() => {}, ${holdMs})`], {
        detached: true,
        // stdout+stderr inherited: THIS is what keeps the parent's pipes open.
        stdio: ["ignore", "inherit", "inherit"],
      });
      orphan.unref();

      const pidPath = process.env.AWS_MCP_FAKE_ORPHAN_PID_OUT;
      if (pidPath && orphan.pid !== undefined) {
        const fs = await import("node:fs");
        fs.writeFileSync(pidPath, String(orphan.pid));
      }

      if (scenario === "awscli_orphan_outlives_exit") {
        // Valid, complete JSON: the assertion is that the caller gets this
        // NATURAL result (exit 0, parsed payload) rather than hanging, which
        // pins that the bound does not simply rewrite every held-pipe call as a
        // timeout. The sleep gives the write time to land before we exit.
        process.stdout.write(`${JSON.stringify({ orphan: "outlived-a-clean-exit" })}\n`);
        await sleep(150);
        process.exit(0);
        return;
      }

      // awscli_orphan_holds_pipes: emit a fragment, then hang past timeoutMs so
      // the timeout path runs. The fragment doubles as proof that buffered bytes
      // still reach rawStdout when the fallback settles instead of 'close'.
      process.stdout.write('{"partial":"emitted-before-the-orphan-hang"');
      await sleep(10 * 60_000);
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

    case "paginate_startingtoken_stateful": {
      // Stateful by argv on --starting-token, for driving buildPaginateAll's
      // auto-loop against the REAL aws_paginate tool (schema + handler), not a
      // stub. First call (no --starting-token) returns page 1 PLUS a NextToken;
      // the resume call returns the final page with NO NextToken, so the loop
      // terminates after exactly 2 pages.
      //
      // This is what makes a dropped --starting-token detectable. If the token
      // never reaches the CLI, every iteration takes the first-page branch,
      // hasMore stays true, and the loop runs to maxPages returning N copies of
      // page 1 -- a silent duplication rather than an error. Asserting
      // pages === 2 and distinct items catches exactly that.
      //
      // Sibling to paginate_has_more / paginate_last_page, which are single-shot
      // and cannot express the resume transition in one scenario.
      const argv = process.argv.slice(2);
      const tokenIdx = argv.indexOf("--starting-token");
      const isResume = tokenIdx >= 0;
      if (isResume) {
        process.stdout.write(
          `${JSON.stringify({
            Buckets: [{ Name: "bucket-3" }],
            StartingTokenSeen: argv[tokenIdx + 1],
          })}\n`,
        );
        process.exit(0);
        return;
      }
      process.stdout.write(
        `${JSON.stringify({
          Buckets: [{ Name: "bucket-1" }, { Name: "bucket-2" }],
          NextToken: "page2-cursor",
        })}\n`,
      );
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

    case "res2_diff_get_ok": {
      // Feeds aws_resource_diff's HANDLER (not just its schema): one
      // `cloudcontrol get-resource` whose ResourceDescription.Properties is a
      // JSON-ENCODED STRING, exactly as CCAPI emits it. The handler then runs
      // the whole local glue chain -- parseResourceProperties -> applyJsonPatch
      // -> summarizePatch -> {before, after, changes, changeCount} -- with no
      // second CLI call, so this single branch covers both the happy path and
      // the patch-failure path at resource.ts's `Patch application failed`
      // return (same fetch, a patch that throws).
      //
      // The document is shaped to exercise three op kinds against one fetch:
      // a scalar (/MemorySize) for replace, a nested object
      // (/Environment/Variables/DROP) for remove, and an array (/Tags) for the
      // `add /Tags/-` end-of-array append whose `after` only resolves via
      // summarizePatch's op.value fallback.
      process.stdout.write(
        `${JSON.stringify({
          TypeName: "AWS::Lambda::Function",
          ResourceDescription: {
            Identifier: "my-fn",
            Properties: JSON.stringify({
              FunctionName: "my-fn",
              MemorySize: 256,
              Timeout: 3,
              Environment: { Variables: { KEEP: "yes", DROP: "gone" } },
              Tags: ["alpha"],
            }),
          },
        })}\n`,
      );
      process.exit(0);
      return;
    }

    case "res2_ccapi_initial_fail_stderr": {
      // Fails EVERY cloudcontrol verb on the INITIAL call, with a populated
      // stderr and empty stdout. Drives get/list/create/update/delete/diff into
      // ccapiFailure -- the `if (!result.ok) return ccapiFailure(result)` line
      // each verb has, which nothing in the suite reached -- and pins the
      // stderr half of rawBodyOf's `rawStderr ? rawStderr : rawStdout`.
      process.stderr.write(
        "An error occurred (AccessDeniedException) when calling the GetResource operation: User is not authorized to perform: cloudformation:GetResource\n",
      );
      process.exit(255);
      return;
    }

    case "res2_ccapi_initial_fail_stdout_only": {
      // The OTHER half of rawBodyOf: nonzero exit, deliberately EMPTY stderr,
      // diagnostic on stdout (a wrapper swallowing stderr, or stderr closed).
      // Truthiness is what makes this work -- `rawStderr ?? rawStdout` would
      // hand back the empty string and drop the only diagnosable bytes. No
      // resource-side test covered this half anywhere in the repo.
      //
      // Deliberately NOT JSON: the nonzero-exit path never parses stdout, and
      // a parseable payload would obscure that these are raw preserved bytes.
      process.stdout.write("ccapi-diagnostic-on-stdout-only\n");
      process.exit(1);
      return;
    }

    case "res2_invalid_creds_stderr": {
      // Generic (argv-independent) invalid_creds failure: credentials WERE
      // resolved and sent, and the service refused them. Sibling of
      // call_sso_expired / call_no_creds, for the classification arm neither
      // of those reaches. InvalidClientTokenId is the STS/IAM spelling of the
      // rotated-or-deleted-key family, so it fits an assume-role call.
      process.stderr.write(
        "An error occurred (InvalidClientTokenId) when calling the AssumeRole operation: The security token included in the request is invalid.\n",
      );
      process.exit(255);
      return;
    }

    case "res2_props_unparseable": {
      // A CCAPI Properties string that is NOT valid JSON, served for BOTH
      // get-resource and list-resources. parseResourceProperties keeps the raw
      // string under propertiesRaw; the two verbs' handlers must each surface
      // it (get at the top level, list on the per-resource entry) or the only
      // diagnosable artifact of the parse failure is lost.
      const argv = process.argv.slice(2);
      const badProps = "{not-valid-json";
      if (argv.includes("list-resources")) {
        process.stdout.write(
          `${JSON.stringify({
            ResourceDescriptions: [{ Identifier: "/my/param-bad", Properties: badProps }],
          })}\n`,
        );
        process.exit(0);
        return;
      }
      process.stdout.write(
        `${JSON.stringify({
          TypeName: "AWS::SSM::Parameter",
          ResourceDescription: { Identifier: "/my/param-bad", Properties: badProps },
        })}\n`,
      );
      process.exit(0);
      return;
    }

    case "res2_update_expired_creds_mid_poll": {
      //   1) cloudcontrol update-resource             -> IN_PROGRESS, RequestToken=req-tok-upd-exp
      //   2) cloudcontrol get-resource-request-status -> ExpiredToken
      // The expired_creds arm of buildMutationResponse's auth-recovery branch.
      // ExpiredToken is the ORIGIN-AGNOSTIC expiry wrapper (an assume-role or
      // web-identity session, not necessarily SSO), so it classifies as
      // expired_creds rather than sso_expired.
      const argv = process.argv.slice(2);
      if (argv.includes("update-resource")) {
        process.stdout.write(
          `${JSON.stringify({
            ProgressEvent: {
              TypeName: "AWS::Lambda::Function",
              Identifier: "my-fn",
              RequestToken: "req-tok-upd-exp",
              OperationStatus: "IN_PROGRESS",
              Operation: "UPDATE",
            },
          })}\n`,
        );
        process.exit(0);
        return;
      }
      if (argv.includes("get-resource-request-status")) {
        process.stderr.write(
          "An error occurred (ExpiredToken) when calling the GetResourceRequestStatus operation: The provided token has expired.\n",
        );
        process.exit(255);
        return;
      }
      process.stderr.write(`fake-aws: res2_update_expired_creds_mid_poll hit unexpected argv: ${argv.join(" ")}\n`);
      process.exit(2);
      return;
    }

    case "res2_create_invalid_creds_mid_poll": {
      //   1) cloudcontrol create-resource             -> IN_PROGRESS, RequestToken=req-tok-inv
      //   2) cloudcontrol get-resource-request-status -> UnrecognizedClientException
      // A key rotated or deleted MID-POLL: the credentials resolved and AWS
      // refused them, which classifies as invalid_creds -- neither an expiry
      // nor a missing profile. The mutation may still land server-side, so the
      // recovery hint has to carry the requestToken like its sibling arms.
      const argv = process.argv.slice(2);
      if (argv.includes("create-resource")) {
        process.stdout.write(
          `${JSON.stringify({
            ProgressEvent: {
              TypeName: "AWS::SSM::Parameter",
              Identifier: "/my/p",
              RequestToken: "req-tok-inv",
              OperationStatus: "IN_PROGRESS",
              Operation: "CREATE",
            },
          })}\n`,
        );
        process.exit(0);
        return;
      }
      if (argv.includes("get-resource-request-status")) {
        process.stderr.write(
          "An error occurred (UnrecognizedClientException) when calling the GetResourceRequestStatus operation: The security token included in the request is invalid.\n",
        );
        process.exit(255);
        return;
      }
      process.stderr.write(`fake-aws: res2_create_invalid_creds_mid_poll hit unexpected argv: ${argv.join(" ")}\n`);
      process.exit(2);
      return;
    }

    case "res2_create_no_request_token": {
      // create-resource returns a NON-TERMINAL ProgressEvent with NO
      // RequestToken -- so a caller who passed awaitCompletion:true gets the
      // not-awaited shape plus the explanatory `awaitSkipped` string, because
      // there is nothing to poll. To PROVE no poll was attempted, the
      // get-resource-request-status branch errors out: reaching it flips the
      // result to ok:false. Sibling of ccapi_create_already_terminal, which
      // skips the poll for the other reason (already terminal).
      const argv = process.argv.slice(2);
      if (argv.includes("create-resource")) {
        process.stdout.write(
          `${JSON.stringify({
            ProgressEvent: {
              TypeName: "AWS::SSM::Parameter",
              Identifier: "/my/p",
              OperationStatus: "IN_PROGRESS",
              Operation: "CREATE",
            },
          })}\n`,
        );
        process.exit(0);
        return;
      }
      if (argv.includes("get-resource-request-status")) {
        process.stderr.write("fake-aws: res2_create_no_request_token polled, but there was no token to poll with\n");
        process.exit(255);
        return;
      }
      process.stderr.write(`fake-aws: res2_create_no_request_token hit unexpected argv: ${argv.join(" ")}\n`);
      process.exit(2);
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

    case "logs_tail_ndjson_bulk": {
      // A busy window: more events than aws_logs_tail's default maxEvents cap,
      // emitted OLDEST-FIRST the way `aws logs tail` does. Each message carries
      // its index so a test can assert WHICH end of the window survived the cap
      // -- "keep the newest" is the tool's contract, and first-N vs last-N is
      // indistinguishable unless the events are individually identifiable.
      // ~1200 events is ~110 KB in one write, far below the 5 MB stdout cap.
      const bulkLines: string[] = [];
      for (let i = 0; i < 1200; i++) {
        bulkLines.push(
          JSON.stringify({
            timestamp: new Date(Date.UTC(2026, 3, 21, 0, 0, 0) + i * 1000).toISOString(),
            logStreamName: "s1",
            message: `event-${i}`,
          }),
        );
      }
      process.stdout.write(`${bulkLines.join("\n")}\n`);
      process.exit(0);
      return;
    }

    case "logs_query_complete": {
      // aws_logs_query happy path across the two CLI calls one handler run
      // makes: `logs start-query` -> a queryId, then `logs get-query-results`
      // -> Complete on the FIRST poll, so attempts === 1. Argv-branching, so
      // it carries no cross-process state. Sibling to
      // logs_query_running_then_complete, which is this flow with the in-flight
      // statuses in front of it.
      const argv = process.argv.slice(2);
      if (argv.includes("start-query")) {
        process.stdout.write(`${JSON.stringify({ queryId: "q-complete-1" })}\n`);
        process.exit(0);
        return;
      }
      if (argv.includes("get-query-results")) {
        process.stdout.write(
          `${JSON.stringify({
            queryLanguage: "CWLI",
            status: "Complete",
            results: [
              [
                { field: "@timestamp", value: "2026-04-21 00:00:00.000" },
                { field: "@message", value: "ERROR boom" },
                { field: "@ptr", value: "ptr-1" },
              ],
              [
                { field: "@timestamp", value: "2026-04-21 00:00:01.000" },
                { field: "@message", value: "ERROR again" },
                { field: "@ptr", value: "ptr-2" },
              ],
            ],
            statistics: { recordsMatched: 2, recordsScanned: 1000, bytesScanned: 4096, logGroupsScanned: 1 },
          })}\n`,
        );
        process.exit(0);
        return;
      }
      process.stderr.write(`fake-aws: logs_query_complete hit unexpected argv: ${argv.join(" ")}\n`);
      process.exit(2);
      return;
    }

    case "logs_query_running_then_complete": {
      // Stateful ACROSS PROCESSES: each fake-aws invocation is a fresh process,
      // so the poll progression lives in a counter FILE the parent names with
      // AWS_MCP_FAKE_QUERY_COUNT_OUT -- one byte appended per get-query-results
      // call, so the file's SIZE is the call number. Same side-channel shape as
      // AWS_MCP_FAKE_VERSION_COUNT_OUT above; append, not overwrite, because
      // counting the repeats is the whole point.
      //
      // Scheduled -> Running -> Complete. Both in-flight statuses appear, which
      // is what proves the loop keeps polling instead of treating the first
      // non-Complete answer as terminal, and the Running call returns PARTIAL
      // results the handler must not return early with.
      const argv = process.argv.slice(2);
      if (argv.includes("start-query")) {
        process.stdout.write(`${JSON.stringify({ queryId: "q-progress-1" })}\n`);
        process.exit(0);
        return;
      }
      if (argv.includes("get-query-results")) {
        const fs = await import("node:fs");
        const countPath = process.env.AWS_MCP_FAKE_QUERY_COUNT_OUT;
        let call = 3;
        if (countPath) {
          fs.appendFileSync(countPath, "1");
          call = fs.statSync(countPath).size;
        }
        const status = call === 1 ? "Scheduled" : call === 2 ? "Running" : "Complete";
        process.stdout.write(
          `${JSON.stringify({
            status,
            results:
              status === "Complete"
                ? [[{ field: "@message", value: "done" }]]
                : status === "Running"
                  ? [[{ field: "@message", value: "partial-do-not-return-me" }]]
                  : [],
            statistics: { recordsMatched: status === "Complete" ? 1 : 0, recordsScanned: 10, bytesScanned: 100 },
          })}\n`,
        );
        process.exit(0);
        return;
      }
      process.stderr.write(`fake-aws: logs_query_running_then_complete hit unexpected argv: ${argv.join(" ")}\n`);
      process.exit(2);
      return;
    }

    case "logs_query_echo_args": {
      // Capture-and-echo for aws_logs_query: write the START-QUERY argv as JSON
      // to AWS_MCP_FAKE_ARGV_OUT (side channel -- the handler keeps only the
      // queryId from that call), then answer the poll with a trivial Complete so
      // the handler reaches ok:true and the test can read the file. Lets a test
      // assert the two facts most easily got wrong: that --cli-input-json is
      // camelCase (logGroupNames/startTime, NOT LogGroupNames/StartTime) and
      // that the window is epoch SECONDS, not the milliseconds `aws logs tail`
      // uses. Modeled on assume_role_echo_args.
      const argv = process.argv.slice(2);
      if (argv.includes("start-query")) {
        const outPath = process.env.AWS_MCP_FAKE_ARGV_OUT;
        if (outPath) {
          const fs = await import("node:fs");
          fs.writeFileSync(outPath, JSON.stringify(argv));
        }
        process.stdout.write(`${JSON.stringify({ queryId: "q-echo-1" })}\n`);
        process.exit(0);
        return;
      }
      if (argv.includes("get-query-results")) {
        process.stdout.write(`${JSON.stringify({ status: "Complete", results: [], statistics: {} })}\n`);
        process.exit(0);
        return;
      }
      process.stderr.write(`fake-aws: logs_query_echo_args hit unexpected argv: ${argv.join(" ")}\n`);
      process.exit(2);
      return;
    }

    case "logs_query_failed": {
      // A query that reaches the terminal Failed status. GetQueryResults carries
      // no reason for it -- only the status -- which is exactly the shape the
      // handler's message has to cope with.
      const argv = process.argv.slice(2);
      if (argv.includes("start-query")) {
        process.stdout.write(`${JSON.stringify({ queryId: "q-failed-1" })}\n`);
        process.exit(0);
        return;
      }
      if (argv.includes("get-query-results")) {
        process.stdout.write(`${JSON.stringify({ status: "Failed", results: [], statistics: {} })}\n`);
        process.exit(0);
        return;
      }
      process.stderr.write(`fake-aws: logs_query_failed hit unexpected argv: ${argv.join(" ")}\n`);
      process.exit(2);
      return;
    }

    case "logs_query_poll_sso_expired": {
      // start-query succeeds, then the SSO session lapses before the first poll
      // lands. Reaches aws_logs_query's `call_failed` poll arm, which rewrites
      // `error` wholesale to lead with the recovery hint -- so the forwarded
      // errorKind is the caller's only remaining classification signal, and the
      // one thing that distinguishes "re-authenticate" from "the poll broke".
      const argv = process.argv.slice(2);
      if (argv.includes("start-query")) {
        process.stdout.write(`${JSON.stringify({ queryId: "q-poll-expired-1" })}\n`);
        process.exit(0);
        return;
      }
      process.stderr.write("Error loading SSO Token: Token for my-profile is expired.\n");
      process.exit(255);
      return;
    }

    case "logs_query_start_malformed": {
      // `logs start-query` rejects the query before any polling can begin.
      // Proves the handler surfaces the start-query failure directly instead of
      // falling through to poll on a queryId it never got. The get-query-results
      // branch is absent on purpose: reaching it would be the bug.
      process.stderr.write(
        "An error occurred (MalformedQueryException) when calling the StartQuery operation: Query string parse error\n",
      );
      process.exit(255);
      return;
    }

    case "lq2_poll_access_denied": {
      // start-query succeeds; every get-query-results call is denied. Reaches
      // aws_logs_query's `call_failed` poll arm on a NON-auth kind, which is the
      // half logs_query_poll_sso_expired cannot reach -- that scenario takes the
      // isAuthKind branch, so the plain "Polling the query failed." prefix and
      // the re-appended "Suggestion:" sentence (v2.2.1: `underlying` prefers the
      // RAW stderr over runAwsCall's already-suffixed message, so the remedy has
      // to be added back) have no other exercise. call_access_denied itself is
      // argv-independent and would fail START-query instead, landing in the arm
      // that is already covered.
      const argv = process.argv.slice(2);
      if (argv.includes("start-query")) {
        process.stdout.write(`${JSON.stringify({ queryId: "q-poll-denied-1" })}\n`);
        process.exit(0);
        return;
      }
      process.stderr.write(
        "An error occurred (AccessDenied) when calling the GetQueryResults operation: Access Denied\n",
      );
      process.exit(255);
      return;
    }

    case "lq2_terminal_status": {
      // Drives terminalQueryFailure's per-status message arms through the real
      // handler: start-query hands back a fixed queryId and get-query-results
      // answers with whatever AWS_MCP_FAKE_QUERY_STATUS names. The var UNSET
      // omits the `status` member entirely, which is the malformed-response arm
      // -- the same env side-channel shape as AWS_MCP_FAKE_QUERY_COUNT_OUT
      // above. Every status here is outside Scheduled/Running, so the poll loop
      // returns on the first attempt and the handler builds the message.
      const argv = process.argv.slice(2);
      if (argv.includes("start-query")) {
        process.stdout.write(`${JSON.stringify({ queryId: "q-term-1" })}\n`);
        process.exit(0);
        return;
      }
      if (argv.includes("get-query-results")) {
        const status = process.env.AWS_MCP_FAKE_QUERY_STATUS;
        process.stdout.write(`${JSON.stringify({ ...(status ? { status } : {}), results: [], statistics: {} })}\n`);
        process.exit(0);
        return;
      }
      process.stderr.write(`fake-aws: lq2_terminal_status hit unexpected argv: ${argv.join(" ")}\n`);
      process.exit(2);
      return;
    }

    case "lq2_start_bad_query_id": {
      // start-query EXITS 0 but its body carries no usable queryId, so the
      // handler has to bail before polling rather than hand `--query-id
      // undefined` to the CLI once per attempt for the whole wait budget.
      // AWS_MCP_FAKE_QUERY_ID_SHAPE picks which half of
      // `typeof rawQueryId !== "string" || !isValidQueryId(rawQueryId)` runs:
      // unset (or "missing") omits the member, "number" sends 42, "hyphen"
      // sends a string the argv guard rejects. No get-query-results branch on
      // purpose -- the fall-through's "unexpected argv" string is absent from
      // the response only if no poll was attempted, the same negative proof
      // logs_query_start_malformed relies on.
      const argv = process.argv.slice(2);
      if (argv.includes("start-query")) {
        const shape = process.env.AWS_MCP_FAKE_QUERY_ID_SHAPE;
        const body = shape === "number" ? { queryId: 42 } : shape === "hyphen" ? { queryId: "-x" } : {};
        process.stdout.write(`${JSON.stringify(body)}\n`);
        process.exit(0);
        return;
      }
      process.stderr.write(`fake-aws: lq2_start_bad_query_id hit unexpected argv: ${argv.join(" ")}\n`);
      process.exit(2);
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

    case "awscli2_invalid_creds_unrecognized_client": {
      // Credentials RESOLVED and were sent; the service refused them. The
      // canonical shape for a deleted/rotated access key, or a key issued in a
      // different partition. Sibling of call_no_creds, and the pair is the
      // point: nothing resolved at all vs. something resolved and got rejected.
      // "Check ~/.aws/credentials exists" is the wrong advice for this one.
      process.stderr.write(
        "An error occurred (UnrecognizedClientException) when calling the ListBuckets operation: The security token included in the request is invalid.\n",
      );
      process.exit(255);
      return;
    }

    case "awscli2_invalid_creds_client_token_id": {
      // Same family, the STS/IAM spelling of it. Kept as its own scenario
      // rather than folded into the one above because INVALID_CREDS_PATTERNS
      // is a three-way alternation and a regex edit can drop one arm without
      // touching the others.
      process.stderr.write(
        "An error occurred (InvalidClientTokenId) when calling the GetCallerIdentity operation: The security token included in the request is invalid\n",
      );
      process.exit(255);
      return;
    }

    case "awscli2_invalid_creds_signature_mismatch": {
      // The third arm: a wrong secret key, or -- the classic -- a machine clock
      // that has drifted far enough to invalidate the SigV4 signature. Real
      // shape, including the two timestamps the service echoes back, which is
      // what makes the clock-drift diagnosis possible from the stderr alone.
      process.stderr.write(
        "An error occurred (SignatureDoesNotMatch) when calling the ListObjectsV2 operation: Signature expired: 20260830T000000Z is now earlier than 20260830T010000Z (20260830T001500Z - 15 min.)\n",
      );
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

    case "sso2_raw_sized": {
      // Sized stdout for the clampRawOutput coverage in sso.integration.test.ts.
      // Emits exactly AWS_MCP_FAKE_SSO2_FILLER 'x' characters followed by the
      // URL+code tail below, then exits 0 after a drain window.
      //
      // The tail lands LAST on purpose. startSsoLogin only settles once BOTH
      // the URL and the short code have been parsed out of stdout, so a
      // successful start proves the entire payload is already in the parent's
      // stdout buffer. That is what makes an exact-length assertion on
      // rawOutput deterministic instead of a race against the pipe.
      //
      // COUPLING: sso.integration.test.ts mirrors SSO2_TAIL byte-for-byte to
      // compute the expected rawOutput. Change one, change both -- the
      // byte-identical passthrough assertion there fails loudly if they drift.
      const SSO2_TAIL = "\nhttps://device.sso.us-east-1.amazonaws.com/\nABCD-EFGH\n";
      const raw = process.env.AWS_MCP_FAKE_SSO2_FILLER;
      const filler = Number(raw ?? "-1");
      if (!Number.isInteger(filler) || filler < 0) {
        process.stderr.write(`fake-aws: sso2_raw_sized needs a non-negative integer filler, got '${raw}'\n`);
        process.exit(2);
        return;
      }
      process.stdout.write(`${"x".repeat(filler)}${SSO2_TAIL}`);
      // Same 250ms drain convention as early_exit_failure: sso.ts computes
      // rawOutput inside its 'exit' handler, which Node can dispatch before the
      // final stdout 'data' event. Exiting in the same breath would race that.
      await sleep(250);
      process.exit(0);
      return;
    }

    case "sso2_raw_surrogate_boundary": {
      // Puts a NON-BMP character astride clampRawOutput's 4000-char cut so the
      // test can pin what the clamp actually does with a surrogate pair.
      // 3999 filler chars means the first U+20BB7 occupies UTF-16 indices 3999
      // and 4000, so a slice(0, 4000) keeps only its HIGH surrogate. Same tail
      // and drain contract as sso2_raw_sized.
      const SSO2_TAIL = "\nhttps://device.sso.us-east-1.amazonaws.com/\nABCD-EFGH\n";
      process.stdout.write(`${"x".repeat(3999)}${"\u{20BB7}".repeat(8)}${SSO2_TAIL}`);
      await sleep(250);
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
      //      (null, malformed CLI shape -- stays dropped) and an entry
      //      missing SourcePolicyId entirely (truly absent -- parseSimulationResults
      //      now synthesizes 'inline' from SourcePolicyType for these). Result:
      //      ["KeepThis", "inline"]. decision="explicitDeny" (denied bucket).
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

    // --- aws_lambda_invoke (tools/lambda.ts) ---
    //
    // The real `aws lambda invoke` splits its answer across two channels: the
    // response BODY goes to the positional outfile, and a metadata envelope
    // (StatusCode / FunctionError / LogResult / ExecutedVersion) goes to
    // stdout. Every scenario below reproduces that split, because a fake that
    // only wrote stdout would let a broken outfile read pass unnoticed. The
    // shapes here were taken from a real aws-cli/2.34.3 run against a stubbed
    // Lambda endpoint, not from the API reference.

    case "lambda_invoke_success": {
      const fs = await import("node:fs");
      const outFile = lambdaOutfileFromArgv();
      if (outFile) fs.writeFileSync(outFile, JSON.stringify({ ok: true, greeting: "hello" }));
      process.stdout.write(
        `${JSON.stringify({
          StatusCode: 200,
          LogResult: Buffer.from(LAMBDA_FAKE_LOG_TEXT, "utf8").toString("base64"),
          ExecutedVersion: "$LATEST",
        })}\n`,
      );
      process.exit(0);
      return;
    }

    case "lambda_invoke_function_error": {
      // The handler threw. EXIT CODE 0 is the point of this scenario and is not
      // a simplification: the real CLI treats a FunctionError as a successful
      // invocation (verified -- exit 0, empty stderr, the thrown error written
      // to the outfile as the response body). That is what makes the tool's
      // ok:true-with-functionError decision the one consistent with the layer
      // underneath it.
      const fs = await import("node:fs");
      const outFile = lambdaOutfileFromArgv();
      if (outFile) {
        fs.writeFileSync(
          outFile,
          JSON.stringify({
            errorMessage: "boom",
            errorType: "Error",
            stackTrace: ["    at handler (/var/task/index.js:3:9)"],
          }),
        );
      }
      process.stdout.write(
        `${JSON.stringify({
          StatusCode: 200,
          FunctionError: "Unhandled",
          LogResult: Buffer.from(LAMBDA_FAKE_LOG_TEXT, "utf8").toString("base64"),
          ExecutedVersion: "$LATEST",
        })}\n`,
      );
      process.exit(0);
      return;
    }

    case "lambda_invoke_not_found": {
      // Service-level failure: nonzero exit with the diagnostic on stderr, and
      // deliberately NO outfile write -- the real CLI leaves the file untouched
      // when the call never reaches the function, which is why the handler must
      // not assume a readable body on the failure branch.
      process.stderr.write(
        "\nAn error occurred (ResourceNotFoundException) when calling the Invoke operation: Function not found: arn:aws:lambda:us-east-1:123456789012:function:missing-fn\n",
      );
      process.exit(255);
      return;
    }

    case "lambda_invoke_echo_argv": {
      // Capture-and-echo: dumps the argv AND the bytes the handler wrote to the
      // fileb:// payload file to AWS_MCP_FAKE_ARGV_OUT, so a test can prove the
      // payload actually round-tripped through the temp file instead of only
      // asserting that a --payload flag was present. Modeled on
      // metrics_echo_argv.
      //
      // It also stats the three paths the handler minted -- the scratch DIR,
      // the pre-created response outfile, and the fileb:// payload file -- and
      // reports `mode & 0o777` for each. That observation CANNOT happen in the
      // parent: the handler's finally block rmSync's the whole directory before
      // it returns, so this subprocess is the only window in which those files
      // exist. The modes are meaningless on Windows (statSync reports the
      // FAT-style 0666/0444 approximation there), so the test that reads them
      // is POSIX-gated; they are emitted unconditionally to keep this branch
      // free of platform forks.
      const fs = await import("node:fs");
      const { dirname } = await import("node:path");
      const argv = process.argv.slice(2);
      const payloadIdx = argv.indexOf("--payload");
      let payloadFile: string | null = null;
      let payloadPath: string | null = null;
      if (payloadIdx >= 0) {
        const ref = argv[payloadIdx + 1] ?? "";
        if (ref.startsWith("fileb://")) {
          payloadPath = ref.slice("fileb://".length);
          payloadFile = fs.readFileSync(payloadPath, "utf8");
        }
      }
      const outFile = lambdaOutfileFromArgv();
      const modeOf = (p: string | null | undefined): number | null =>
        p === null || p === undefined ? null : fs.statSync(p).mode & 0o777;
      const outPath = process.env.AWS_MCP_FAKE_ARGV_OUT;
      if (outPath) {
        fs.writeFileSync(
          outPath,
          JSON.stringify({
            argv,
            payloadFile,
            // dirname of the outfile IS the mkdtempSync scratch dir: the
            // handler joins both temp files onto it.
            dirMode: outFile === undefined ? null : modeOf(dirname(outFile)),
            // Read BEFORE the outfile write below, so what is reported is the
            // mode the handler pre-created it with rather than anything this
            // fake may have done to it.
            outfileMode: modeOf(outFile),
            payloadFileMode: modeOf(payloadPath),
          }),
        );
      }
      if (outFile) fs.writeFileSync(outFile, JSON.stringify({ ok: true }));
      process.stdout.write(`${JSON.stringify({ StatusCode: 200, ExecutedVersion: "$LATEST" })}\n`);
      process.exit(0);
      return;
    }

    case "lambda_invoke_empty_response": {
      // A handler that returns nothing leaves a 0-byte outfile.
      const fs = await import("node:fs");
      const outFile = lambdaOutfileFromArgv();
      if (outFile) fs.writeFileSync(outFile, "");
      process.stdout.write(`${JSON.stringify({ StatusCode: 200, ExecutedVersion: "$LATEST" })}\n`);
      process.exit(0);
      return;
    }

    case "lambda_invoke_nonjson_response": {
      // A Lambda response body is not required to be JSON.
      const fs = await import("node:fs");
      const outFile = lambdaOutfileFromArgv();
      if (outFile) fs.writeFileSync(outFile, "plain text, not JSON");
      process.stdout.write(`${JSON.stringify({ StatusCode: 200, ExecutedVersion: "$LATEST" })}\n`);
      process.exit(0);
      return;
    }

    case "lambda_invoke_large_response": {
      // Larger than the handler's 256 KB response cap. Valid JSON on the wire,
      // so a test can tell "clipped by our cap" (payloadTruncated, string body)
      // apart from "the function returned garbage".
      const fs = await import("node:fs");
      const outFile = lambdaOutfileFromArgv();
      if (outFile) fs.writeFileSync(outFile, JSON.stringify({ blob: "a".repeat(300_000) }));
      process.stdout.write(`${JSON.stringify({ StatusCode: 200, ExecutedVersion: "$LATEST" })}\n`);
      process.exit(0);
      return;
    }

    case "lambda_invoke_hang": {
      // Never writes the outfile and never exits, so the parent's timeoutMs has
      // to fire. Exists to prove the handler's finally-block cleanup runs on the
      // TIMEOUT path, not just the happy one. The parent kills it, so the sleep
      // never actually elapses -- same "stay alive until reaped" floor as
      // happy_hold.
      await sleep(10 * 60_000);
      process.exit(0);
      return;
    }

    case "lam2_invoke_echo_payload": {
      // Echoes the REQUEST back as the response: reads the fileb:// payload
      // file this child was handed and writes those exact bytes into its own
      // outfile. That makes every response caller-specific, which is what lets
      // a concurrency test tell "each invoke read back its OWN outfile" apart
      // from "both read the same one" -- with a fixed response body the two
      // results are identical either way and the test proves nothing.
      //
      // lambda_invoke_echo_argv cannot serve that test: two concurrent children
      // would both write the single AWS_MCP_FAKE_ARGV_OUT path and the loser's
      // capture would be lost.
      const fs = await import("node:fs");
      const argv = process.argv.slice(2);
      const payloadIdx = argv.indexOf("--payload");
      let body = "null";
      if (payloadIdx >= 0) {
        const ref = argv[payloadIdx + 1] ?? "";
        if (ref.startsWith("fileb://")) {
          body = fs.readFileSync(ref.slice("fileb://".length), "utf8");
        }
      }
      const outFile = lambdaOutfileFromArgv();
      if (outFile) fs.writeFileSync(outFile, body);
      process.stdout.write(`${JSON.stringify({ StatusCode: 200, ExecutedVersion: "$LATEST" })}\n`);
      process.exit(0);
      return;
    }

    case "lam2_invoke_multibyte_large_response": {
      // Same over-cap shape as lambda_invoke_large_response, but the body is
      // 3-byte UTF-8 characters (U+5B57) instead of ASCII. On an all-ASCII body
      // a cut by BYTE and a cut by CHARACTER are indistinguishable; here they
      // differ by ~3x, which is what pins MAX_RESPONSE_PAYLOAD_BYTES as the
      // byte budget it is documented to be. 100k characters -> 300011 bytes on
      // the wire, comfortably past the 256 KB cap.
      const fs = await import("node:fs");
      const outFile = lambdaOutfileFromArgv();
      if (outFile) fs.writeFileSync(outFile, JSON.stringify({ blob: "字".repeat(100_000) }));
      process.stdout.write(`${JSON.stringify({ StatusCode: 200, ExecutedVersion: "$LATEST" })}\n`);
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

    case "obs2_iam_sim_truncated": {
      // IAM paginates SimulatePrincipalPolicy with IsTruncated + Marker, and no
      // other iam_simulate scenario emits either -- so hasMore:true and the
      // echoed marker had never executed, only their false/null complements.
      //
      // Stateful by argv, the same way metrics_paginated is: parse the
      // --cli-input-json payload and switch on whether it carries a Marker.
      //   first call (no Marker)  -> a TRUNCATED page: one EvaluationResult
      //                              plus IsTruncated:true and a Marker.
      //   resume call (Marker set) -> the FINAL page: one EvaluationResult, no
      //                              IsTruncated, no Marker.
      // Parsing the payload rather than substring-matching '"Marker"' keeps a
      // resource ARN or action name containing that literal from flipping the
      // branch.
      const argv = process.argv.slice(2);
      const jsonIdx = argv.indexOf("--cli-input-json");
      let isResume = false;
      try {
        const parsed = JSON.parse(jsonIdx >= 0 ? argv[jsonIdx + 1] : "") as { Marker?: unknown };
        isResume = parsed.Marker !== undefined;
      } catch {
        // Malformed JSON can't reach us from runAwsCall (it serializes the
        // payload itself). Default to the first-page branch so a test fails
        // loud rather than silently looking like a resume.
        isResume = false;
      }
      if (isResume) {
        process.stdout.write(
          `${JSON.stringify({
            EvaluationResults: [
              {
                EvalActionName: "s3:DeleteObject",
                EvalResourceName: "arn:aws:s3:::my-bucket/*",
                EvalDecision: "explicitDeny",
                MatchedStatements: [{ SourcePolicyId: "DenyDeletes", SourcePolicyType: "IAM Policy" }],
              },
            ],
          })}\n`,
        );
        process.exit(0);
        return;
      }
      process.stdout.write(
        `${JSON.stringify({
          EvaluationResults: [
            {
              EvalActionName: "s3:GetObject",
              EvalResourceName: "arn:aws:s3:::my-bucket/*",
              EvalDecision: "allowed",
              MatchedStatements: [{ SourcePolicyId: "ReadOnlyAccess", SourcePolicyType: "IAM Policy" }],
            },
          ],
          IsTruncated: true,
          Marker: "obs2-iam-marker-page2==",
        })}\n`,
      );
      process.exit(0);
      return;
    }

    case "macct_success":
    case "macct_partial_failure":
    case "macct_leaky_stderr":
    case "macct_big_payload": {
      // The four aws_multi_account scenarios share one block because every one
      // of them needs the same two-PHASE behaviour, and duplicating the phase
      // split four times is how the copies drift apart. Each account drives two
      // spawns:
      //
      //   phase 1, `sts assume-role`: mint credentials whose values ENCODE the
      //     account they were minted for, so phase 2 can prove which session it
      //     was actually handed. The account comes out of the RoleArn inside
      //     --cli-input-json, which is where the handler puts it.
      //   phase 2, the caller's operation: the credentials arrive through the
      //     ENVIRONMENT (aws_multi_account passes them via runAwsCall's `env`),
      //     so this side reads AWS_ACCESS_KEY_ID rather than argv.
      //
      // Phase 2 also reports whether `--profile` was on argv. That is not
      // decoration: botocore drops the environment credential provider entirely
      // once a profile is explicitly set, so a regression that put the flag back
      // would make every account silently answer as the operator's own -- a
      // wrong ANSWER, not an error, which is the kind of bug no failure assertion
      // catches.
      const argv = process.argv.slice(2);
      const isAssume = argv[0] === "sts" && argv[1] === "assume-role";

      if (isAssume) {
        const inputIdx = argv.indexOf("--cli-input-json");
        const payload = inputIdx >= 0 ? (JSON.parse(argv[inputIdx + 1]) as { RoleArn?: string }) : {};
        const account = /:([0-9]{12}):role\//.exec(payload.RoleArn ?? "")?.[1] ?? "unknown";
        if (scenario === "macct_partial_failure" && account === "222222222222") {
          // One account whose ASSUME fails, so the batch proves an account can
          // drop out before its operation ever runs.
          process.stderr.write("Error loading SSO Token: Token for my-profile is expired.\n");
          process.exit(255);
          return;
        }
        process.stdout.write(
          `${JSON.stringify({
            Credentials: {
              AccessKeyId: `ASIAFAKE${account}`,
              SecretAccessKey: `fake-secret-${account}`,
              SessionToken: `fake-token-${account}`,
              Expiration: "2099-12-31T23:59:59+00:00",
            },
            AssumedRoleUser: {
              AssumedRoleId: `AROAFAKE${account}:macct`,
              Arn: `arn:aws:sts::${account}:assumed-role/Fake/macct`,
            },
            PackedPolicySize: 6,
          })}\n`,
        );
        process.exit(0);
        return;
      }

      const accessKeyId = process.env.AWS_ACCESS_KEY_ID ?? "";
      const account = accessKeyId.startsWith("ASIAFAKE") ? accessKeyId.slice("ASIAFAKE".length) : "unknown";
      const sawProfileFlag = argv.includes("--profile");

      if (scenario === "macct_leaky_stderr") {
        // Adversarial: a subprocess that dumps the credentials it was handed to
        // BOTH streams and then fails. Nothing real does this -- the point is
        // that aws_multi_account's response must not contain them even when the
        // text it is forwarding does. Deliberately worded so classifyAuthError
        // does NOT recognize it: an auth-class kind would take the handler's
        // rewrite path and drop the leaked text on the floor, and the test would
        // pass without ever exercising the scrub.
        const dump = `AWS_ACCESS_KEY_ID=${accessKeyId} AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} AWS_SESSION_TOKEN=${process.env.AWS_SESSION_TOKEN}`;
        process.stdout.write(`partial output before failing: ${dump}\n`);
        process.stderr.write(`An error occurred (InternalError) when calling the operation: debug dump ${dump}\n`);
        process.exit(254);
        return;
      }

      if (scenario === "macct_partial_failure" && account === "333333333333") {
        // A second account that assumed fine and then failed the OPERATION, so
        // the batch carries both failure stages plus a success at once.
        process.stderr.write(
          "An error occurred (AccessDenied) when calling the operation: not authorized in this account\n",
        );
        process.exit(254);
        return;
      }

      if (scenario === "macct_big_payload") {
        // ~2.75 MB per account: under the 5 MB PER-CALL stdout cap in
        // aws-cli.ts, but two of them cross the 5 MB AGGREGATE budget.
        process.stdout.write(`${JSON.stringify({ Account: account, Blob: "x".repeat(2_750_000) })}\n`);
        process.exit(0);
        return;
      }

      process.stdout.write(
        `${JSON.stringify({
          Account: account,
          SawProfileFlag: sawProfileFlag,
          // A BOOLEAN, not the token: this scenario's job is to prove the exact
          // session reached the right subprocess, and echoing the value would
          // put credential-shaped text in a payload the leak test then has to
          // special-case.
          SessionTokenMatches: process.env.AWS_SESSION_TOKEN === `fake-token-${account}`,
        })}\n`,
      );
      process.exit(0);
      return;
    }

    case "obs2_mr_big_payload": {
      // Drives aws_multi_region's AGGREGATE byte cap (5 MB across the batch)
      // through the real handler. Region-branching like mr_partial_failure:
      //   us-west-2 -> an sso_expired FAILURE, so the batch also proves
      //                okCount/errorCount count what the CALLS did, not what
      //                survived the cap.
      //   anything else -> ~2.75 MB of JSON, comfortably under the 5 MB
      //                PER-CALL stdout cap in aws-cli.ts but enough that two
      //                such regions cross the 5 MB aggregate budget.
      const argv = process.argv.slice(2);
      // Same coupling as mr_partial_failure: --region is immediately followed
      // by its value in runAwsCall's fixed argv layout.
      const regionIdx = argv.indexOf("--region");
      const region = regionIdx >= 0 ? argv[regionIdx + 1] : "";
      if (region === "us-west-2") {
        process.stderr.write("Error loading SSO Token: Token for my-profile is expired.\n");
        process.exit(255);
        return;
      }
      process.stdout.write(`${JSON.stringify({ Region: region, Blob: "x".repeat(2_750_000) })}\n`);
      process.exit(0);
      return;
    }

    default: {
      // Catches both unknown values and an unset AWS_MCP_FAKE_SCENARIO
      // (undefined falls here -- there is no implicit default scenario).
      if (scenario === undefined) {
        process.stderr.write(
          "fake-aws: AWS_MCP_FAKE_SCENARIO is not set. Every test that spawns fake-aws must set it explicitly.\n",
        );
      } else {
        process.stderr.write(`fake-aws: unknown scenario '${scenario}'\n`);
      }
      process.exit(2);
      return;
    }
  }
}

void main();
