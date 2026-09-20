# Changelog

All notable changes to `@yawlabs/aws-mcp` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The 0.x line is the pre-stability tightening phase -- breaking changes are
called out explicitly in the entries below but are not necessarily gated on a
major-version bump. From 1.0 onward the public tool shapes (see the README
"Stability" section) follow strict SemVer.

## [Unreleased]

### Security
- **The display `command` no longer runs anything when pasted into PowerShell.** Every result carries a `command` string built for a reader to paste, and a value containing a single quote made it executable. `shellQuoteArg` emitted the POSIX close-escape-reopen idiom; PowerShell reads `'...'` as literal text the way POSIX does but has no backslash escape inside it, so that form tokenises into separate words -- a `;` in the value ends the statement, whatever follows it RUNS, and a `#` comments out the dangling quote that would otherwise be a parse error. Measured on win32/arm64 with PowerShell 5.1, driving the real call against a loopback stub: a `--query` value of `x'; echo PWNED #` printed PWNED. The other 24 character-class probes were delivered byte-identically in PowerShell and in Git Bash, so a single quote in the value is the whole trigger -- and a `--query` such as ``Buckets[?Name=='prod'].Name`` is an ordinary way to get one. Quoting is now chosen by the platform the reader is on: Windows emits PowerShell's own escape, a doubled quote, which is also inert in bash (`'a''b'` is concatenation), so a Git Bash paste yields a wrong value rather than a running command. **`command` is still a display string, not a universal one**: it is correct in a POSIX shell and in PowerShell, and NOT in `cmd.exe`, where `&`, `|` and a newline are live whatever the quoting (measured 0 of 24 probes correct, and unchanged by this fix). A `%VAR%` is now quoted rather than emitted bare, so a batch file no longer expands it away. Re-quote the string yourself before pasting it into a shell other than the server's own.
- **The 0600 on the two files that can hold credentials is verified now rather than assumed, and a filesystem that cannot honour it fails the call instead of leaking.** The `--cli-input-json` params file (which can carry a SecureString) and `~/.aws/credentials` (which carries an access key, a secret key and a session token in plaintext) were each opened at 0600 and then `fchmod`-ed at 0600 -- open's mode because Node honours it, the `fchmod` because oam drops it. Neither is sufficient: a filesystem may accept a chmod, report **success**, and change nothing. Measured on WSL Ubuntu (linux/arm64, Node 22.23.2) against a Windows drive under `/mnt` (v9fs/DrvFs): `mkdtemp` returns 0777, the exclusive create returns 0777, and `fchmodSync(fd, 0o600)` succeeds while changing nothing -- so both files landed world-readable **and world-writable**, with nothing able to detect it. World-writable is the worse half: the CLI opens the params path after this server has closed it, so another local user can substitute the payload in between. Neither configuration is exotic -- `TMPDIR` into a Windows drive is how you share one scratch directory between a WSL distro and its Windows host, and `AWS_SHARED_CREDENTIALS_FILE` (botocore's own variable, named in `aws_assume_role`'s description) pointed at the Windows-side `~/.aws` is how you share one credentials file and SSO cache. The mode is now checked with one `fstat`, and a file that cannot be made private is **not written at all**: the call fails naming the variable to change (`TMPDIR`/`TMP`/`TEMP`, or `AWS_SHARED_CREDENTIALS_FILE`) before any secret byte reaches disk. **This is a failure you can newly hit**: with either path on such a mount, calls that used to appear to succeed now fail with that message. That is the intended trade, because the previous behaviour was a silent exposure. CIFS/SMB, FAT-family and NTFS mounts under `fmask`/`dmask`, and Docker Desktop bind mounts, are expected to behave the same way -- reasoned, not measured. No POSIX measurement of oam exists anywhere, since oam publishes no linux-arm64 build and this work had no Mac, so every oam filesystem row in this release was measured on Windows.
- **The AWS CLI is resolved to an absolute path before every call, and never from the working directory, on any platform.** 2.3.3 closed the Windows case by setting `NoDefaultCurrentDirectoryInExePath` on the server process, which left the protection resting on the server's own environment and did nothing for a `PATH` that names the working directory itself: on macOS and Linux an empty `PATH` entry or `.` means the current directory to `execvp`. The server now walks the absolute directories on the child environment's `PATH` itself -- `aws.exe` only on Windows, a regular executable file elsewhere -- and spawns the path it found. Every entry that would resolve against a directory the server does not control is skipped rather than searched: empty, `.`, a relative `bin`, a drive-relative `C:foo`, a root-relative `\tools`, an unexpanded `%X%\bin`. Each Windows `aws` child also gets `NoDefaultCurrentDirectoryInExePath=1` explicitly, so the CLI's own helpers do not resolve there either -- `aws ssm start-session` hands off to `session-manager-plugin` by bare name, and a `credential_process` can name a bare command too. There is no bare-name fallback: when no CLI is found nothing runs, because falling back is exactly the planted-checkout case on a machine without the CLI. Resolving the path also settles a runtime difference -- oam searches its own install directory before the parent `PATH` while Node searches the working directory -- so Node and oam now run the same binary. The walk is not cached and does not need to be: 0.47-1.16 ms over this host's 58-entry `PATH` (20 runs, median 0.56) against a CLI start of hundreds of milliseconds, and a cache would go stale after an install or an `aws update`.

### Fixed
- **`aws_logs_tail` returns structured events against a real AWS CLI -- for the first time since it shipped.** It wrapped `aws logs tail --format json` on the premise that the output is NDJSON. It never was: that flag selects the CLI's pretty-print formatter, which prints `<iso-timestamp> <stream> <message>` lines and re-indents any message that is entirely JSON across several lines (`awscli/customizations/logs/tail.py`, byte-identical from 2.34.3 to the v2 head). The first line never parsed, so every non-empty call took the raw-string fallback: `events` was one text blob, `eventCount` and `totalEvents` were `null`, `truncated` was `false`, and the `maxEvents` bound added in 2.2.0 never applied -- on aws-cli 2.34.3 against a loopback endpoint a six-event window came back as a 637-character string, and a 2,000-event window with `maxEvents: 5` as 329,998 characters. Only an empty window was right. Nor can that text be parsed back into events: a message beginning with a timestamp reads as a new event, a stream name with a space cannot be told from the message after it, a traceback's continuation lines carry no prefix, and a JSON message has already been re-serialized. The tool now calls FilterLogEvents through `aws logs filter-log-events` -- the same API `tail` calls -- whose JSON output is a single document, and returns events as `{timestamp, logStreamName, message}`: `timestamp` in ISO 8601 UTC with milliseconds, `message` verbatim rather than re-indented and right-stripped. The parser is strict now, which is the pin that keeps this from recurring: stdout that is not the document the fixed `--query` asked for is `ok: false` naming what arrived, where the old parser turned text into `ok: true`. That removes an arm the Stability section documented -- `events` as the raw blob with `eventCount` and `totalEvents` both `null` -- so `events` is always an array now. It is not held for a major because every non-empty call against a real CLI landed there: the shape being removed is the bug itself, not an output any caller could have gotten a real event out of. The tail scenarios in the fake are replaced by payloads captured from the real CLI, and a new suite drives the handler through the INSTALLED `aws` binary against an in-process endpoint on every `npm test` -- ten cases, four of which also assert the fake returns the identical envelope -- so a fake that drifts from the real format fails instead of hiding the next one.
- **A log-group ARN now addresses the group it names.** The ARN used to be cut down to its bare name, so a source-account ARN silently read the same-named group in the caller's own account, and an ARN for another region read the call's region instead. It is now sent as FilterLogEvents' `logGroupIdentifier` (a trailing `:*` removed), so a cross-account read works from a CloudWatch cross-account monitoring account; an ARN whose region differs from the call's region is refused before anything spawns, with both regions named, because FilterLogEvents is regional; and an AWS CLI older than 2.9.15, which cannot address a group by ARN, gets an error saying so -- naming the ARN's own account and the bare-name workaround -- instead of a silent retarget.
- **Every `aws` call pins the CLI settings that change what this server reads.** AWS CLI 2.34.0 added `cli_error_format`; set to `json`, `yaml`, `text` or `table`, it removes the `An error occurred (Code) when calling ...` line the error classifier reads, so an expired or rejected credential came back as `nonzero_exit` with no remedy instead of `expired_creds` / `invalid_creds` (measured on 2.34.3 against a loopback stub answering 403). `cli_auto_prompt = on` failed every call with exit 255 before a connection was opened -- `aws sso login` included, so `aws_login_start` could not work at all. Both are now pinned through the environment (`AWS_CLI_ERROR_FORMAT=enhanced`, the CLI's own default, and `AWS_CLI_AUTO_PROMPT=off`), not with flags: AWS CLI 2.22.0 answers `--cli-error-format` with `Unknown options` and exit 252, while an environment variable it does not know is ignored. The pins go on top of whatever environment the caller built rather than instead of it, so `aws_multi_account`'s per-account credentials and the `AWS_MAX_ATTEMPTS=1` that keeps `aws_lambda_invoke` to one attempt both survive them.
- **Non-ASCII output no longer breaks calls on Windows.** Writing to a pipe, the Windows CLI uses the ANSI code page. A response with any character outside it -- an emoji or a check mark in a log line, a CJK S3 key -- failed the whole call with `'charmap' codec can't encode characters` (exit 255), `aws_logs_tail` included, and characters inside it came back as U+FFFD with `ok: true`: for an e-acute the CLI wrote a lone cp1252 `0xE9`, which this server's UTF-8 decode cannot keep. The server now sets `AWS_CLI_OUTPUT_ENCODING=utf-8` (which exists from 2.24.14) and `PYTHONUTF8=1` (which is what covers older CLIs) on every `aws` process, and a real-CLI case round-trips an e-acute, CJK and an astral-plane character exactly on 2.34.3 and on 2.22.0. The test suite's fake CLI always wrote UTF-8, which is why this never showed up there.
- **Request `params` over ~32 KB work on Windows.** They travelled as one command-line argument, and past Windows' 32,767-character limit the spawn failed with `spawn ENAMETOOLONG. Is the AWS CLI installed and on PATH?` -- sending you to debug a `PATH` that was fine. A CloudFormation template body (up to 51,200 bytes), a Step Functions definition, an SSM document and a `dynamodb batch-write-item` all reach that size legitimately. Params over 8,192 characters now go through a private temp file (`--cli-input-json file://...`, mode 0600 -- verified, not assumed, see the Security note below -- in a directory made for that one call and removed when the call ends), written as ASCII-escaped JSON: the CLI reads a `file://` param as text in the locale's preferred encoding, so a plain UTF-8 file holding `caf` + e-acute reached the endpoint mojibaked, with exit 0 -- silent corruption of the request. If the temp directory itself holds a `$` or `%`, or starts with `~`, the call fails as `bad_input` naming `TMP`/`TEMP`/`TMPDIR`, because the CLI expands those in a `file://` path. A single value that is still too long (a very large Cloud Control desired state, say) now fails as `bad_input` naming the flag and its length, on Windows (`ENAMETOOLONG`) and Linux (`E2BIG`) alike, rather than as a `spawn_failure` blaming `PATH`.
- A `timeoutMs` above 2,147,483,647 (about 24.8 days) no longer times the call out at once: node stores a timer delay in a signed 32-bit int and fires a longer one after 1 ms, so `runAwsCall` now clamps it to the maximum rather than passing it through.

### Changed
- On arm64 Linux, `AWS_MCP_RUNTIME=oam` no longer advises installing something that does not exist. oam publishes darwin arm64/x64, windows arm64/x64 and linux **x64** -- there is no linux-arm64 asset -- so on a Pi, an arm64 cloud instance or WSL on an ARM Windows host, discovery can never succeed and "Install or update from oamjs.org" sent the reader to a releases page with nothing on it for their machine. Those hosts are now told there is no build for their platform, and pointed at `AWS_MCP_RUNTIME=node` or `OAM_BIN`. Every other platform's message is unchanged. The fallback itself was already right: measured on linux/arm64 against a real POSIX build, a bare launch serves 28 tools on Node, a bad `OAM_BIN` prints its diagnostic and then serves, and `AWS_MCP_RUNTIME=oam` exits without serving.
- **On AWS CLI 2.35.8+, `aws_logs_tail` stops reading once it has the newest `maxEvents` -- and a truncated result reports `totalEvents: null`.** This is a behavior change, not merely a fix: `aws logs tail` read every page in the window before the cap applied, so a busy hour ended in `output_too_large` or the 60s timeout after paying for every FilterLogEvents call. CLI 2.35.8 added FilterLogEvents' `startFromHead`; with it the tool reads newest-first and asks for `maxEvents` + 1 events -- one sentinel, which makes `truncated` exact without a `NextToken` that FilterLogEvents documents as over-reporting -- so a busy group costs a page or two instead of the whole window (a 1,200-event window measured one request). It therefore no longer knows the window's full size: `totalEvents` is `null` whenever `truncated` is true on that path. No existing caller can have seen a number there, because against a real CLI `totalEvents` was always `null` for a non-empty window. Older CLIs reject `startFromHead` before sending anything (exit 252, zero requests, measured on 2.34.3 and 2.22.0), and the tool reads the rejection itself rather than guessing at a version -- in 2.34.3's wording, in 2.22.0's, which prints the validation lines with no `ParamValidation` header, and in the CLI's JSON error format. It remembers that answer for the life of the process, so a current CLI never pays for the detection, and reads the whole window as before -- exact `totalEvents` -- but asks the CLI to print only the newest `maxEvents` plus a count, so even there a busy window no longer dies on the 5 MB output cap (780 KB unprojected against 130 KB projected, for 2,000 events). An endpoint that ACCEPTS `startFromHead` and ignores it is caught too: moto's FilterLogEvents never reads the member, so LocalStack does not either, and an ascending page that was also truncated triggers a whole-window re-read instead of presenting the window's oldest events as its newest.
- **`aws_logs_tail` sends every caller-supplied value inside `--cli-input-json`, where the CLI never expands `file://`.** 2.3.3 refused a `filterPattern` starting with `file://` or `fileb://` rather than let the CLI replace it with a local file's contents; the payload is passed through literally, so such a pattern now reaches CloudWatch as the text it is. The reject on a leading `-` stays, so nothing else about the accepted input set changes.
- **Blob-typed `params` are always base64.** This is a behavior change for one configuration. With `cli_binary_format = raw-in-base64-out` in your AWS config -- common advice, AWS's own docs suggest it for `aws lambda invoke --payload` -- a base64 value such as KMS `Plaintext` or Kinesis `Data` was encoded a second time and AWS stored the base64 text instead of the bytes, silently: measured on 2.34.3 and 2.22.0, a `dynamodb put-item` with `B: "aGVsbG8="` put `YUdWc2JHOD0=` on the wire. Calls that carry `params` now pass `--cli-binary-format base64`, the CLI's own default and the one such setting with no environment variable to pin instead. If you were passing raw text to a blob parameter under that config, it now fails with `Invalid base64` instead of succeeding; send base64. The flag is scoped to calls that carry `params`, so a `command` string without them is unchanged -- and AWS CLI v1, which this server does not support, has no such global option at all: those calls now fail with `Unknown options`, and the error says it is v1 rather than leaving you to read the flag name.
- **On AWS CLIs older than 2.25.0 ON WINDOWS, `~/.aws/config` and `~/.aws/credentials` are now read as UTF-8.** A side effect of `PYTHONUTF8=1` (above): those CLIs are frozen with a PyInstaller build that honors it for the whole interpreter, not for output alone. It costs nothing on macOS or Linux, because there is no ANSI code page to switch away from: measured on linux/arm64 with aws-cli 2.36.49, a cp1252 byte in `~/.aws/config` fails to parse identically with `PYTHONUTF8` unset, `=0` and `=1`, and under `LC_ALL=C` and `LC_ALL=POSIX`, while the same character encoded as UTF-8 parses in all of them -- so the pin changes nothing there, and such a file was already unreadable on those platforms before this server existed. A non-ASCII character saved in a legacy Windows code page there now fails with `Unable to parse config file` and exit 255 -- re-save the file as UTF-8, or update the CLI -- while a UTF-8 file holding a character the code page lacks, which those CLIs rejected, now parses; both directions are asserted against 2.22.0 in the real-CLI suite. A Python-based `credential_process` the CLI starts inherits the variable too. The trade was taken deliberately: without the pin, every Windows install fails or corrupts on any non-ASCII output, while this side effect needs both an old CLI and a legacy-encoded byte in a config file.

### Added
- `aws_logs_tail`'s success envelope carries `logGroupIdentifier` -- the ARN that was sent, with the trailing `:*` removed, or `null` for a bare-name call -- because `command` redacts the `--cli-input-json` payload and would otherwise hide whether an ARN input was honored.
- **`AWS_MCP_AWS_CLI`: point the server at a specific `aws` executable.** For MCP hosts started from a GUI that do not inherit your shell's `PATH`, now more common since AWS's recommended installer puts the CLI in `~/.local/bin` on macOS and Linux. It applies to every call and to `aws sso login`, which the old test-only override never reached. It must be absolute, and on Windows must name an `.exe`: node refuses to start a `.cmd` or `.bat` by path without a shell, while oam runs the same path through `cmd.exe`. An unusable value fails every call with a message naming the variable rather than quietly running a different CLI than you configured -- this setting picks which binary handles your credentials. When no CLI can be found at all, the error now says how many `PATH` directories were checked, that the working directory is never searched, how to find the path (`where.exe aws` / `command -v aws`), and names an `aws.cmd` or `aws.bat` shim if that is what it found, since a pip-installed AWS CLI v1 leaves one.

## [2.3.4] — 2026-09-20

### Fixed
- **`aws_iam_simulate` answered per action when it promises per resource, and reported resources as denied that AWS allows.** On 2026-07-30 IAM changed SimulatePrincipalPolicy server-side, so every CLI version is affected: it now returns ONE `EvaluationResult` per action, whose top-level `EvalDecision` is the most restrictive decision across every resource and whose `EvalResourceName` is an ARN TEMPLATE -- literally `arn:${Partition}:s3:::${BucketName}/${KeyName}`. The per-resource answers live only in `ResourceSpecificResults`, which this tool dropped. So "can this role read these three buckets" came back as one row that named none of them and said deny for all three because one was denied: safe and unreadable, and the opposite of the tool's job -- it is meant to stop a model attempting work that will 403, and instead it stopped the model attempting work that would have succeeded, sending the user hunting for permissions they already have. Rows now come from `ResourceSpecificResults`, one per resource, each with that resource's own decision, matched statement ids and missing context keys, so `summary` counts (action, resource) pairs again -- which is what the description and the README have promised all along. No field is added or removed. AWS's reference says the older one-result-per-resource shape carried the same aggregate decision on every result, so reading `ResourceSpecificResults` is right whichever shape AWS serves: one code path, no version sniffing. An action AWS does not break down per resource falls back to its own top-level result, so no action can drop out of `results` because AWS sent a shape we had not seen. Three corollaries, each a wrong answer on its own: a call that names no `resources` reports resource `*` again rather than the ARN template (that is the commonest call shape, "can I do this at all?", and AWS applies `['*']` server-side); `missingContextValues` survives that call, because the API reports those keys on the TOP-LEVEL result for a `*` simulation and puts them per resource only when the call named resources -- only a `*` entry inherits them, since the top-level list is a union across resources and copying it onto a specific ARN would blame that ARN for another's keys; and a decision outside allowed / explicitDeny / implicitDeny now reads `unknown`, as the README always said, where before only a MISSING decision landed there and every other string, including `""` and a miscased `"Allowed"`, passed through verbatim and was counted in `denied`. `organizationsDecision` and `permissionsBoundaryDecision` are reported by AWS per ACTION, so a resource row that was allowed now reads `"allowed"` instead of the action's aggregate `"denied"` -- an SCP or boundary deny cannot coexist with an allow -- while a row that is not allowed still carries the action's value, which the description now says rather than leaving the caller to guess. Every `iam_simulate` fixture the suite had was pre-change shape, which is why nothing caught this; the four new ones were transcribed from captures the real aws-cli 2.34.3 rendered from the documented XML through a loopback stub, and the 2-actions-by-3-resources call now yields 4 rows with no `${` in any `resource`.
- **`aws_iam_simulate` rejects an STS session ARN up front, with the lookup that fixes it.** `aws_whoami` reports `arn:aws:sts::<account>:assumed-role/<role>/<session>` for every SSO session, which makes it the ARN a model reaches for first, but the simulator takes a user, group or role ARN only -- so the first call from an SSO session went to IAM and came back with nothing to act on. The handler now refuses it before anything spawns and names the `iam get-role` lookup for the role it parsed out. It deliberately does not rebuild the role ARN, because the session ARN drops the role's path and SSO roles live under `aws-reserved/sso.amazonaws.com/`. The description and the README's rows also state what the simulator cannot see: SCP statements never appear in `matchedStatementIds`, keys only an SCP references are never reported missing (so a region-locking SCP needs `aws:RequestedRegion` passed in `contextEntries` yourself), and "allowed" is necessary but not sufficient -- RCPs, the target resource's own policy, session policies and VPC endpoint policies are not evaluated. The pagination wording now matches what the CLI does: `aws iam simulate-principal-policy` follows IAM's `IsTruncated`/`Marker` itself and prints the merged pages, so `hasMore` is false and `marker` null on every first call, and only a call that resumed from `marker` can carry either. The fake was emitting a truncated FIRST page the real CLI never produces -- the same fake-vs-real gap that hid the `aws_logs_tail` bug -- and now models the CLI both ways. The response shape is unchanged.
- **`aws_docs_read` could not open the `index.html` pages `aws_docs_search` hands out.** docs.aws.amazon.com answers every `<path>/index.html` with a 301 to `<path>/`, and the post-redirect check added in 2.0.0 re-used the input pattern, which demands a `.html` suffix. So the canonical form of a URL the site itself returns came back as "redirected to '<the same path>/', which is not an 'https://docs.aws.amazon.com/...html' page" -- an error worded like a blocked off-site redirect. In a live census of eight queries, 126 of 800 search hits were `index.html` URLs, among them the AWS CLI's own per-service command indexes (`cli/latest/reference/s3api/index.html`), which are the most relevant family of pages there is for a server that wraps the CLI. The landing URL is now judged three ways instead of one, and the 2.0.0 hardening is kept whole: it must still be https, on docs.aws.amazon.com, on the default port, with no credentials, and an off-site redirect is refused exactly as before.
- **A guessed page name now says it does not exist, instead of coming back as another page's content.** The site does not 404 a missing page inside a guide that exists: it 302s to the guide's landing page, and a missing CLI command to that service's command index. So the redirect fix on its own would have answered a guessed command name with the whole `s3api` index as the content of a command nobody can run -- which is what accepting every same-host redirect, the behavior an origin-only check gives you, amounts to. A PAGE request that lands on some other directory is now `ok: false` with "does not exist" and the landing URL, so a model that guessed learns that it guessed. Every shape here was re-verified against the live site on 2026-09-19, and the fixtures are trimmed captures of those responses rather than invented HTML.
- **A docs fetch blocked by a corporate gateway blamed AWS's backend for it.** Node's fetch rejects with a bare `TypeError: fetch failed` and puts the real verdict in `err.cause`, which no production file here read -- so behind a TLS-inspecting gateway or a private CA (the ordinary shape of a corporate network, and these are the only two tools in this server that reach the internet without the `aws` CLI) both docs tools reported "fetch failed" and nothing else, and `aws_docs_search` went on to say the undocumented backend at proxy.search.docs.aws.com "may have changed or be unreachable" about a request that never left the machine. The unit test meant to cover this threw `new Error("ECONNREFUSED")`, a shape fetch never produces, so the suite stayed green over it. All four fetch branches now append the cause -- read defensively, a non-empty string code only so a numeric errno cannot print as a bare "0", with any `userinfo@` redacted out of both halves -- to the LAST `@` of the authority and with no `:` required, because WHATWG userinfo runs to the final `@` (`new URL("http://svc:Pa@ss@h:3128")` gives password `Pa%40ss` on 22.22.2, so an unencoded `@` in a password is a legitimate value) and because `http://<token>@proxy` is auth too; `?` and `#` end the authority like `/` does, so a docs URL whose query or fragment holds an `@` is untouched -- and name the remedy where the verdict has one: an untrusted certificate chain asks for `NODE_EXTRA_CA_CERTS` or `NODE_USE_SYSTEM_CA=1` (Node 22.19+) and says both are read at process start, so they belong in the MCP config's `env` block rather than your shell; an expired certificate or a hostname mismatch deliberately gets no CA advice, because a CA fixes neither; `HTTPS_PROXY` set without `NODE_USE_ENV_PROXY=1` (Node 22.21+) gets the fact that Node's fetch ignores it, which is why the `aws` CLI -- which reads `HTTPS_PROXY` itself -- can keep working while these two tools cannot, and that hint also reaches the 30s timeout branch, because on a proxy-only network the likelier symptom is nothing answering at all; and an uncoded transport failure under oam, which reports no code for one, gets the certificate remedy plus a note that an unreachable proxy looks identical from there. Every shape was reproduced locally on 2026-09-19 rather than read out of documentation: a self-signed HTTPS server on a loopback port (Node 22.22.2 gives `DEPTH_ZERO_SELF_SIGNED_CERT`, oam 0.16.2 gives no code at all, and `NODE_EXTRA_CA_CERTS` fixes both), a dead port and an unresolvable host, and `HTTPS_PROXY` pointed at a dead port with the opt-in present, absent, set to `0`, and via `NODE_OPTIONS`.
- **`aws_call` no longer blames you for the params you did supply.** `aws_call` with `service: 's3api', operation: 'get-object', params: {Bucket, Key}` exited 252 with `the following arguments are required: --bucket, --key` -- naming the two values that were in `params` -- and no suggestion at all, so a model reads it as its own mistake and retries with the same params. Same for `bedrock-runtime invoke-model`, `bedrock-agentcore invoke-agent-runtime`, `lambda invoke`, `logs tail`, `s3 cp/ls/sync` and `configure get`. The cause is not the parameters: the AWS CLI never registers `--cli-input-json` on an operation whose argument table carries an `outfile` (`awscli/customizations/cliinput.py` `_add_cli_input_argument`: `if 'outfile' not in argument_table:`, unchanged from 2.0.0 to v2 HEAD), nor on its hand-written BasicCommands, and that flag is the only way `aws_call` passes `params` -- so those commands are unreachable through this tool whatever you send, and the required-arguments list is argparse describing flags it wanted, not members it was missing. The error now says so and names the way out: `aws_lambda_invoke` for Lambda, `aws_logs_tail` for `logs tail`, `bedrock-runtime converse` for text inference, `aws s3 cp s3://BUCKET/KEY -` in a shell for an object body, otherwise the shell with explicit flags. A call that sent NO params and hit the same message gets the other branch -- pass the members in `params` by API member name, with the rule rather than a guessed name (`--bucket` -> `Bucket`, but `--model-id` -> `modelId` on bedrock-runtime), because PascalCase is wrong for ECS, EKS, ECR, Logs, Step Functions, API Gateway, Batch and Bedrock. Detection is exit 252 plus argparse's own wording plus whether `params` was sent, and that third input is load-bearing: `s3api head-object` with no params emits BYTE-IDENTICAL stderr to `get-object` with params. It cannot fire on a call that worked, and it stays silent rather than guessing. No field moves -- `errorKind` stays `nonzero_exit` and `rawBody` is unchanged -- and the hint rides in `suggestion` and is embedded in `error` too, the convention `runAwsCall` already uses, because `toMcpResult` renders only `error`. The description also stops sending waiters to the shell: `aws ec2 wait` DOES register `--cli-input-json`, and `s3api wait object-exists` with `{Bucket, Key}` went on to the endpoint on both CLIs tested. Verified against real aws-cli 2.34.3 and real 2.22.0, whose stderr differs structurally (2.22.0 prints its usage block first, then `aws.exe: error:`), and in every one of the six error formats 2.34.3 offers -- seventeen rows through `dist`, each failing at argparse or a dead loopback port.
- **`aws_multi_region` refused the commercial partition its own description advertises.** The `regions` cap was 32 and the `aws` partition has 34 regions (botocore's `partitions.json`, already shipped inside the 2.34.3 CLI on this machine, lists 34 once `aws-global` is dropped), so an account with every opt-in region enabled that piped its `ec2 describe-regions` output straight in got `Too many regions: 34 requested, max 32` and nothing else -- the exact use the description promises ("describe-instances across all our regions"). All 34 names pass the region pattern, so the refusal was ours alone. The cap is now 64: 64 rather than 34 because an exact count goes stale at the next region launch, and 2x headroom costs nothing here, since the response is bounded separately by the unchanged 5 MB aggregate cap and parallelism by the unchanged concurrency limit of 32. Both numbers are interpolated into the tool description and the `regions` field description, so what the model is told cannot drift from what the schema and the handler enforce. Nothing on the stable list moves: no input is removed or reshaped, every previously valid call returns an identical result, and the cap was never documented as a blast-radius bound (that is `destructiveHint: true`, unchanged). Verified through `dist` against the loopback stub with both real CLIs: all 34 regions return `okCount` 34 on 2.34.3, and on 2.22.0 too -- it lists only 30 of them but resolves endpoints for the rest by pattern, so the cap was purely server-side.
- **An operation newer than your `aws` CLI looked like your typo, not an upgrade.** The README promises new AWS operations are reachable "the moment your local `aws` CLI knows them"; when it does not, every tool that shells out returned the CLI's own argparse rejection with no suggestion at all, and nothing said the fix might be an upgrade. Measured on aws-cli 2.34.3 against Batch's September bulk cancel (CLI 2.36.44): `aws_call {service: "batch", operation: "cancel-jobs"}` came back `argument operation: Found invalid choice 'cancel-jobs'`, exit 252, suggestion absent -- which reads as "you misspelled it". `parseAwsError` now recognizes that rejection and names both causes, spelling first, because a model's mistyped operation is at least as likely as an old CLI. It covers all three of argparse's dests and the noun follows the caller's vocabulary rather than argparse's: `command` is the SERVICE they passed, `operation` is the operation, `subcommand` is a waiter or an `s3` / `configure` subcommand. The upgrade half names the real constraint -- `update.py`'s `_SUPPORTED_SOURCES` is `('exe', 'script-exe', 'update-exe')`, so `aws update` (2.36.0+) works for installer and install-script installs and raises `UpdateError` for anything else, which is why the installer and package managers are named too. The pattern is unanchored, and that is load-bearing: the phrase moves depending on the CLI and the user's error format. Verified on real 2.34.3 in its default enhanced format, in legacy (also what a `--profile` the CLI cannot find produces), and in the json format where the phrase sits inside `Message` behind literal `\n` escapes; and on real 2.22.0, which predates error formats, prints its usage block first and names no choice at all on the service form. It sits after the standard-wrapper branch, so a genuine service error that merely contains the phrase keeps its code-based remedy. The name it quotes is vetted as a command token first, because argparse's "invalid choice" is not always a name the caller typed: when `operation` gives a subcommand GROUP (`ec2 wait`), that group's parser registers no `--cli-input-json` -- `aws ec2 wait help` lists the flag 0 times on 2.34.3, the leaf `ec2 wait instance-running help` 3 times -- so argparse reads the `params` JSON `aws_call` passes through that flag as the missing positional. Quoting that back told a model the CLI had "no subcommand named `{"InstanceIds":["i-1"]}`", to check that string's spelling, and to run `aws update`, which fixes nothing; it also copied `params` into a field documented as a one-line remedy. `aws_call` answers that shape itself now, since only the tool side knows params were sent: `aws ec2 wait` is a subcommand group, name the waiter in `operation`. On 2.22.0, whose wording names no choice at all, the shape is indistinguishable from a mistyped waiter and keeps the spelling remedy -- with nothing echoed either way. No field is added and `errorKind` stays `nonzero_exit`: `suggestion` is already in the envelope and already documented as best-effort.
- **A TLS-inspecting gateway or an unreachable proxy on the CLI path no longer reads like an AWS outage.** These are the CLI half of what the docs tools' fetch failures now explain, and both came back with no remedy. Behind a TLS-inspecting gateway botocore raises `SSLError` (`SSL validation failed for <url> ...`) and an unreachable proxy raises `ProxyConnectionError` (`Failed to connect to proxy URL: ...`); `parseAwsError` now says where the fix has to live -- `AWS_CA_BUNDLE` or the profile's `ca_bundle` for the first, `HTTPS_PROXY` / `NO_PROXY` for the second, and in this server's MCP-config `env` block, because the `aws` subprocess inherits this server's environment and botocore takes the proxy URL from the environment only (`endpoint.py`'s `_get_proxies` is `get_environ_proxies`). The TLS remedy does not offer to turn verification off. The proxy sentence was reproduced on 2.34.3 against a dead loopback proxy; the TLS sentence is botocore's own fmt string read from the CLI's bundled copy, because two attempts to force it against a self-signed loopback server on this box came back as a read timeout instead. botocore masks the credentials in a proxy URL before raising, so the value quoted back is already `***:***@`.
- **An unhandled promise rejection no longer takes the server down.** An `aws_script` whose code calls `aws.call(...)` without awaiting it returned success to the model and then killed the server: the script returns first, the un-awaited bridge call rejects a beat later, and with no process-level handler Node's default (`--unhandled-rejections=throw`) exits 1, so all 28 tools disappear from the session right after a call that reported success, until the host restarts the server. Measured over real MCP stdio on Node 22.22.2, both ways the call can fail -- a service name that fails validation locally, and a real `aws` CLI failure (an unknown `--profile` against an empty config, a loopback endpoint and a dead proxy). In both, `tools/call aws_script` answered `{"result":"returned"}` and the next `tools/list` got no reply at all. The entry point now installs a handler beside 2.3.3's `hardenWindowsExeSearch()` call and keeps serving: one stderr line with the reason's message and stack. It is installed in the entry-point block rather than at module load, so importing this module never changes a host process's rejection semantics -- including the test runner's, which must keep failing on one. The reason is classified with `node:util`'s `types.isNativeError` as well as `instanceof Error`, because the motivating reason fails the `instanceof` test: the `aws_script` bridge re-throws bridge failures as the sandbox realm's own `Error`, a different constructor from the server's, and an `instanceof`-only check would print "Error: <message>" with no stack for exactly the case the handler exists for. A non-error reason goes through `String(reason)` and is never inspected, the same rule `errorToMcpResult` follows, so a rejected `AwsCallResult`-shaped value cannot dump `rawStdout` / `rawStderr` into operator stderr. This is process-level rather than a fix in the bridge because the bridge can only mark its OWN promises handled -- a script's bare `Promise.reject()` and `sso.ts`'s `void promise.finally(...)` login dedupe would still be fatal. `uncaughtException` is deliberately left alone: a synchronous throw that unwound to the top left the code that threw it part-way through its work, and a server answering from torn state is worse than one the host restarts. Verified on the same two runs, plus under oam 0.16.1 and 0.16.2 and through `bin/aws-mcp.mjs` -- 28 tools still listed and a following tool call still answered.
- **A Registry-driven install had no way to offer a profile, so it wrote none.** `server.json` declared no environment variables, so an installer reading the MCP Registry entry had nothing to prompt for and wrote a config with no `env` block. The server then resolves `--profile default` on the first tool call (`session.ts`'s `getProfile` falls through `AWS_PROFILE`, `AWS_DEFAULT_PROFILE`, then `default`), and on a machine with no `[default]` section that is a `no_creds` error on the user's first question -- for a server whose whole pitch is that it runs on the profiles you already have. `packages[0].environmentVariables` now declares `AWS_PROFILE` and `AWS_REGION`, both optional, each description stating the real fallback chain rather than a generic blurb -- including that a profile's own `region` setting is never read, because every call carries `--region <resolved>` on its argv, so `us-east-1` is what an unset region means. Neither carries a `default`, deliberately both ways: a pre-filled `default` profile recreates the very `no_creds` failure this is meant to avoid, and a pre-filled region would outrank a user's own `AWS_DEFAULT_REGION`. An installer that writes an EMPTY string for a variable the user skipped is safe, since `getProfile` and `getRegion` use `||`. Nothing is marked secret, because neither value is one, and only these two are declared: the launcher knobs (`AWS_MCP_RUNTIME`, `OAM_BIN`) and the legacy spellings stay undeclared, because an installer may prompt for every declared variable and a runtime override is not a thing to ask a new user. Verified on the block as committed with `mcp-publisher validate` 1.7.9 against registry.modelcontextprotocol.io, with ajv against the 2025-12-11 schema, and through `release.sh`'s own version-sync `jq` line, which leaves the array intact and both version fields correct.
- **The README's only companion-config example could not install.** The single example under "Optional companion" was `uvx awslabs.lambda-mcp-server@latest`, and all ten releases of that name are yanked on PyPI ("superceeded by awslabs.lambda-tool-mcp-server"), so uv refuses to resolve it -- "Because all versions of awslabs-lambda-mcp-server were yanked ... your requirements are unsatisfiable", reproduced on uv 0.11.7 -- and the MCP entry it was pasted into never started. It was also selling a Python server for "typed `lambda_invoke`", which `aws_lambda_invoke` has done natively since 2.2.0, and the renamed package is a different product: a bridge that exposes chosen functions as tools. The example is now `awslabs.bedrock-kb-retrieval-mcp-server`, picked because its agentic retrieval reaches something `aws_call` never can -- it calls `AgenticRetrieveStream`, which `awscli/customizations/removals.py` deletes from the CLI's command table -- with the note that plain `bedrock-agent-runtime retrieve` is an ordinary `aws_call` operation, and that the server lists only knowledge bases tagged `mcp-multirag-kb=true` by default.

### Changed
- **A docs page with no content of its own now fails with the reason instead of coming back as an empty success.** This is a behavior change, not merely a fix, and it is the one response in this release that turns from `ok: true` into `ok: false`. Guide landing URLs are `<meta http-equiv="refresh">` stubs, and the JS SDK v3 and Swift API references are application shells assembled in the browser; converted, they are 0 characters and `[Skip to main content](#main)`. A read whose conversion is under 200 characters of text AND whose HTML carries one of those markers is now `ok: false` naming the reason -- for a stub, with the absolute URL of the page it forwards to. Both gates have to fire, so a genuinely short REAL page is served as-is, and nothing thin is cached, so a retry after the page is fixed is not served the empty conversion for five minutes. In practice this replaces an empty success rather than taking content away from anyone: every thin shape this work found live, on 2026-09-19 and again on 2026-09-20, is an `index.html` URL that the pre-existing post-redirect check refused anyway, and it is the redirect fix above that newly makes them reachable. No input, envelope field or annotation changes.
- **The README describes the server AWS runs today, and a comparison that is still true.** Every claim was re-verified live on 2026-09-20 and the diffs were all in AWS's favour, so the comparison had drifted into flattering ourselves on stale facts. `call_aws` is gone -- AWS's tool reference lists eight tools without it, and the endpoint answers `-32600 "The call_aws tool has been removed, use another one."` -- so every AWS API call there is now a Python script in `run_script`: a difference in shape, not coverage. Since July 2026 it also takes OAuth through AWS Sign-in with nothing installed locally, so "Requires Python + `uv`" described only its SigV4 path, the one AWS recommends for terminal and IDE coding agents and the only one that switches profiles per call. Its Agent SOPs are now "skills". The bullet is now a parent plus one sub-bullet per connection path, because a single sentence misstates whichever path it does not describe, and it keeps an honest "nothing installed locally -> AWS MCP Server (OAuth)" row; what Node/npm-only buys is stated as the checkable thing it is -- a local server on your own CLI profiles, no `uv` to install and no proxy -- not as "no Python", which CLI v2 bundles anyway. Data-plane routing was wrong in three places: `s3api get-object` and `bedrock-runtime invoke-model` stream their body to a positional outfile and register no `--cli-input-json`, Lambda invokes have had their own tool since 2.2.0, and AWS Labs' "DynamoDB with type-marshalling" has eight data-modeling, validation, cost and codegen tools and no data-plane tool at all; `dynamodb get-item` and `bedrock-runtime converse` do work and are named instead. Resource types are 1,300+ rather than "hundreds" (AWS's supported-resources list holds exactly 1,300, last updated 2025-12-23), the "services AWS adds tomorrow" examples are September's with the CLI release that added each, and `awslabs/mcp` is described as AWS now describes it -- succeeded by the Agent Toolkit for AWS, still working and taking contributions -- with the Cloud Control API server's deprecation named and its migration guide's "no direct replacement" for get / list / create / update / delete cited. Two limits are stated where they bind: the 5 MB cap is this server's and is not what users hit first, since Claude Code warns at 10,000 tokens and by default saves any result over 25,000 to a file the model has to read back; and keep this server's config key as `aws`, because `aws configure agent-toolkit` (CLI 2.35.0+) registers AWS's hosted server under `aws-mcp` and returns `ALREADY_CONFIGURED` on that key's presence alone, without looking at what it runs. Requirements now answers the question every tool depends on: what the CLI is for (every tool that talks to AWS shells out to it -- all but `aws_docs_*`, `aws_session_*` and `aws_list_profiles`), the version this server is developed and tested against, what an older CLI does with a newer service, operation or parameter, and how to upgrade. Documentation only; no change to the published package's behavior.
- **Test-only: a tool description that passes the host's 2 KB text cap now fails the suite.** Claude Code truncates every tool description it hands the model, silently, and nothing here was checking. Read out of the installed 2.1.272 binary: one helper is applied both to each tool description and to the server instructions; above 2,048 characters it cuts the text, appends a truncation marker, and logs the loss to the MCP debug log alone -- the server is not told and neither is the user. What goes first is whatever was written last, and the widest description in this server is `aws_logs_query`'s at 1,981 bytes, 67 to spare, whose closing sentences are the two a caller most needs: that a timed-out or cancelled Insights query is NEVER stopped, and that `aws_logs_tail` is cheaper for plain recent lines. `HOST_TEXT_CAP_BYTES` lands in a new `src/server-instructions.ts` -- the module the server `instructions` block and its own tighter ceiling will join -- and two tests hold every description to it: one against `allTools` from the esbuild bundle that ships, naming every offender with how far over it is, and one in the existing `tools/list` loop in the integration suite, which is the byte count a host actually reads off the wire. Checked by lowering the cap to 1,900: both fail, naming `aws_logs_query` and 1,981 bytes. The gate measures UTF-8 bytes where the host compares UTF-16 code units, which is never fewer for the same text, so a description that passes is never cut; today exactly one description carries a non-ASCII character at all -- `aws_assume_role`'s single em-dash -- and there the gate is 2 bytes stricter than the host.
- **Test-only: three new suites check the facts these fixes rest on against the real thing, not against a fixture.** Each is opt-in, so a plain `npm test` reports them skipped. `call.realcli.test.ts` drives `aws_call` at the AWS CLI v2 installed on `PATH` under the `AWS_MCP_REAL_CLI_TESTS=1` gate 2.3.3 established, and asserts the CLASSIFICATION of whatever the CLI printed rather than its bytes, so it survives a wording change that would break a byte-for-byte fixture -- all four cases die in argparse or in botocore's own validation, so there is no stub, no endpoint override and nothing sent. `docs.live.test.ts` runs the four cases the redirect and landing-page fixes turn around against docs.aws.amazon.com itself, under `AWS_MCP_LIVE_DOCS=1`: it needs outbound HTTPS and nothing else -- no credentials, no AWS API, no subprocess -- which is why it is `.live.` rather than the `.integration.` suffix this repo uses for suites that talk to a real account, and without it the day AWS starts 404ing a missing page the suite stays green and the "does not exist" message silently stops appearing. `iam-simulate.integration.test.ts` is the only one that watches AWS: read-only (SimulatePrincipalPolicy evaluates policies and mutates nothing), gated on BOTH `AWS_MCP_LIVE_TESTS=1` and `AWS_MCP_LIVE_IAM_PRINCIPAL_ARN`, and in its own file because `iam-simulate.test.ts` has a file-level `before()` that routes EVERY spawn to the fake, so a live test placed there would quietly pass against it. Each of the two live files says to run that file alone, because `AWS_MCP_LIVE_TESTS=1 npm test` also fires a real Cloud Control create/delete.
- **Test-only: a schema-validation case could have spawned 40 real AWS calls once the region cap moved.** `script.test.ts`'s "region list above `.max(32)`" case built 40 regions and ran against the DEFAULT handlers with no fake shim, on the premise that validation rejects it before any spawn. At a cap of 64 that premise is false: 40 validates, and `npm test` would have spawned 40 real `aws` processes with the developer's own credentials against real region names. The count now derives from the exported cap instead of a literal, and that whole describe pins the test command at a nonexistent binary, so a future regression of the same shape fails with `ENOENT` instead of reaching AWS.

### Security
- **The four local `aws` commands that print your credentials or your recorded traffic are refused before anything spawns.** `aws_call` accepted `service: 'configure', operation: 'export-credentials'`, and that command answers with the profile's resolved credentials -- measured on aws-cli 2.34.3 against a throwaway credentials file, the full `SecretAccessKey`, not the masked form `configure list` prints, and for a static-key profile a long-lived key no STS call would ever hand out. The output went straight into the model's context and the host's transcript. `history show` and `history list` replay what the CLI recorded locally, and `configure get` reads any config value by name. None of the four sends a request to AWS, so no IAM policy can limit them: scoping the credentials, which is this server's answer for every actual API call, does nothing here. They now return `errorKind: "bad_input"` naming the command, why it is refused, and the escape hatch -- your own terminal, which is where reading your own keys belongs. Everything else in `configure` still runs, including `configure list`. The guard sits in `runAwsCall`, so `aws_script`'s `aws.call` and the fan-out tools are covered too. (`configure get` was already unreachable in practice -- it needs a positional `varname` and `configure` rejects `--cli-input-json`, so the call failed with ParamValidation before reading anything -- and is listed so that stays true if a positional path is ever added.)
- **Requirements now carries a dated AWS CLI security floor: 2.35.3 or newer clears every published AWS CLI v2 advisory.** Nothing in this package changes -- the floor is not enforced and no version is rejected -- but it is worth stating where it binds, because v2 ships as an installer, so no dependency scanner will ever flag the CLI you share with everything else on the machine. None of the affected paths is reachable through this server: the affected commands (`emr ssh/socks/put/get`, `codeartifact login`, `deploy register`, `iam create-virtual-mfa-device`) all register no `--cli-input-json`, which is the only way `aws_call` passes parameters, and the remaining advisory is about the opt-in `cli_history` database, which this server never enables. The three advisories are linked from Requirements, with a pointer to the advisory list for newer ones.

## [2.3.3] — 2026-09-19

### Security
- **A Cloud Control identifier, token or pagination cursor, or an `aws_logs_tail` filter pattern, that starts with `file://` or `fileb://` no longer makes the AWS CLI read a local file and send it to AWS.** The CLI's paramfile loader (`awscli/paramfile.py`) replaces any command-line parameter value that begins with exactly `file://` or `fileb://` with the contents of that local file -- after expanding `~`, `$VAR` and `%VAR%` -- before the request is signed, and v2 stores its `no_paramfile` setting without ever reading it, so there is no per-parameter opt-out. `aws_resource_*`'s `identifier`, `requestToken`, `clientToken` and `nextToken`, `aws_paginate`'s `startingToken` and `aws_logs_tail`'s `filterPattern` reached the command line unguarded, on tools annotated read-only that hosts commonly auto-approve: a prompt-injected `identifier` of `file://~/.aws/credentials` sent that file to AWS as the identifier, and the `fileb://` form echoed the file's bytes back to the model in the error. The Cloud Control and pagination fields now reject the prefix before any process starts, in the same class as the existing leading-`-` reject and with `errorKind` absent the same way. As a backstop, `runAwsCall` refuses any such value among the CLI-level arguments a tool hands it (`errorKind: "bad_input"`, naming the flag it belongs to) -- that is what closes `filterPattern`, which has no field-level reject of its own, and it also covers the values that come back from AWS, such as the request token `awaitCompletion` polls with. The match is exactly the loader's own case-sensitive, whitespace-free `startswith`, so nothing that reached AWS as itself before is refused now: `FILE://`, a leading space and `file:/` with one slash all still pass through, verified against aws-cli 2.34.3 and 2.22.0 through a loopback stub. `aws_lambda_invoke`'s own `--payload fileb://<temp file>` is exempted by its exact value, so `--qualifier` and the rest of that call stay guarded.
- **On Windows, an `aws.exe` in the server's working directory no longer stands in for the AWS CLI.** Node resolves the bare command `aws` by looking in the current directory before `PATH` unless `NoDefaultCurrentDirectoryInExePath` is set. Claude Code sets it; hosts on the MCP SDK's default stdio transport pass only a short list of variables that does not include it, and start the server in their own working directory -- often the open project. So a repository with an `aws.exe` at its root ran that binary, with your AWS environment, on the first tool call: reproduced over MCP stdio on Node 22.22.2 against a build of this release with the fix removed, where a copy of `node.exe` planted as `aws.exe` answered `aws_call sts get-caller-identity` and the stub endpoint saw no requests at all. oam 0.16.2 never searched the working directory either way. The server now sets the variable for itself at startup when the host has not, as the first statement of the entry point, before any tool can spawn anything; an existing value is left alone whatever case the host spelled the key in. Windows evaluates the setting in the parent at spawn time, so the `aws` children are covered too, and the CLI inherits it, which also stops the CLI's own helpers resolving there: a planted `session-manager-plugin.exe` otherwise ran under `aws ssm start-session` and was handed the session's token. A `credential_process` configured as a bare program name that exists only in the working directory stops resolving; name it by absolute path.

### Fixed
- **`aws_lambda_invoke` could run a function three times and still return nothing.** A function slower than 60 s hit the AWS CLI's default socket read timeout, and the CLI's standard retry mode then sent `Invoke` again -- three attempts by default, five for a profile with `max_attempts = 5`. The tool's own description told callers to raise `timeoutMs` for a long function, which is exactly what set it off: through the v2.3.2 handler, aws-cli 2.34.3 against a local stub, a 70 s function with `timeoutMs: 200000` received three `Invoke` POSTs 60 s apart and the call came back after 183 s as `nonzero_exit` `Read timeout on endpoint URL`, with no payload and no log tail. The invoke now runs with `AWS_MAX_ATTEMPTS=1`, which overrides any `max_attempts` in the caller's profile -- every spelling of the variable is dropped from the child environment first, because Node hands a child the upper-case key while oam hands it the last one -- and with a `--cli-read-timeout` derived from `timeoutMs`, so the request is sent once and the CLI waits as long as the caller asked. `timeoutMs` now means how long to wait for the function: the CLI gets 10 s more, enough for a cold start's init phase, so a function that hits its own timeout still comes back as a `functionError` with its log tail, and the tool's own kill timer fires 5 s after the CLI's as a backstop. Values above 900000, Lambda's synchronous maximum, are treated as 900000, which also stops a huge `timeoutMs` timing the call out at once -- Node fires a timer longer than 2^31-1 ms after 1 ms. No answer in time is `errorKind: "timeout"` whichever clock fired -- the CLI's read timeout used to surface as `nonzero_exit` -- and the message says whether the invoke was sent. That distinction is not cosmetic: `--cli-read-timeout` also bounds the CLI's credential calls, and a hung STS endpoint for a `role_arn` profile produces the identical `Read timeout` text with nothing sent to Lambda, so the handler reads the URL in the message rather than assuming the function ran.
- **Error codes and remedies survive the CLI giving up on its retries.** Once botocore stops retrying it marks the error `MaxAttemptsReached` and writes `... when calling the X operation (reached max retries: N): ...`, and the parser required `operation:` straight after the operation name, so every retry-exhausted error lost its code, its operation and its suggestion -- throttling and 5xx on every tool, which is exactly the case the backoff suggestion was written for. It matters more now that `aws_lambda_invoke` runs with `AWS_MAX_ATTEMPTS=1`: botocore marks the FIRST failure the same way when `max_attempts` is 1, so the CLI writes `(reached max retries: 0)` on every Lambda service error, and a missing function would have lost "Verify the resource identifier and region." On Windows the same pattern also swallowed the CLI's `Additional error details:` block, because the terminator looked for `\n\n` and the CLI writes `\r\n\r\n`. Both are fixed by the one regex, and the throttling suggestion now says how many times the CLI had already retried -- nothing is appended when it had not.
- `parseAwsError` has a remedy for three transport failures that had none: `Read timeout on endpoint URL` and `Connection was closed before we received a valid response` (the request was sent, so a call that changes state may have taken effect -- check before retrying), and `Connect timeout on endpoint URL` (check network access, proxy and region). The remedies are deliberately generic about retry safety -- every tool but `aws_lambda_invoke` reaches them with the CLI's retries still on -- and the request they say was sent is the one to the endpoint the message names, which for a `role_arn` profile whose STS endpoint hangs is the credential call rather than the caller's operation.
- **`aws_lambda_invoke` accepts the qualifier `$LATEST.PUBLISHED` and function ARNs up to 256 characters.** Both limits predate Lambda Managed Instances, and both rejected valid input here before anything spawned: `FunctionName` now allows the 256 characters the Invoke API documents (it was 170, which a 64-character name with a 59-character alias already exceeds), and the qualifier charset gains `.` for `$LATEST.PUBLISHED` -- sent as `?Qualifier=%24LATEST.PUBLISHED`, verified through the installed CLI. `:` and `/` stay out, so a qualifier still cannot spell `file://`. The qualifier description no longer says an unqualified invoke always runs `$LATEST` -- on Managed Instances it runs `$LATEST.PUBLISHED`, and durable functions need an explicit qualifier -- the tool description says Managed Instances functions do not support the log tail, and `invocationType` no longer offers `aws_iam_simulate` as a DryRun substitute: the simulator evaluates the caller's identity policies and never fetches the function's resource-based policy.
- **Pagination cursors are accepted up to 8,192 characters, up from 2,048.** Cloud Control documents ListResources `NextToken` at up to 4,096 characters, and aws-cli returned and accepted one that long against a local stub, but `aws_resource_list` rejected it locally before any process spawned. `aws_paginate` needs more headroom still: the CLI wraps a raw token as base64 JSON for `--starting-token`, so a 4,096-character cursor arrives as 5,484. It is the 128-character bug 2.0.0 fixed, one limit higher. The identifier cap (2,048) and the `requestToken` / `clientToken` cap (128) are unchanged.

### Changed
- **`aws_lambda_invoke` no longer lets the AWS CLI retry a throttle, a 5xx or a dropped connection.** This is a behavior change, not merely a fix. The CLI re-sent all three, and every re-send of an `Invoke` that reached the function is another run -- a dropped connection, a 429 `TooManyRequestsException` and a 500 `ServiceException` were each sent three times on the CLI's defaults. They now reach the caller on the first failure. For a `TooManyRequestsException` this gives something up: Lambda refused before running anything, so the old silent retry was safe, but no environment variable or flag limits retries to some error codes and not others. The tool description now says a throttle is safe to retry, and that after a dropped connection or a 5xx the function may have run, so check its logs first.
- **`aws_lambda_invoke`'s `timeoutMs` now bounds the wait for the function, not the whole call.** This is a behavior change, not merely a fix: the CLI is allowed 10 s beyond the value in force and the tool's own kill timer 5 s beyond that, so a call that gets no answer takes up to 15 s longer than it did -- 75 s instead of 60 s on the default, and 915 s whenever the value was clamped to Lambda's 900 s maximum. In 2.3.2 `timeoutMs` WAS the kill timer, so a host that used it as a hard wall-clock budget has to allow for the extra 15 s.
- Test-only: suites named `*.realcli.test.ts` drive the AWS CLI v2 installed on `PATH` against an in-process endpoint on 127.0.0.1, with throwaway static keys, a throwaway config and credentials file, and a dead proxy for every other address, so what the fake CLI prints is checked against what the real one prints and nothing leaves the machine. `param-file.realcli.test.ts` runs on every `npm test` and skips itself, with a reason, when there is no CLI v2 to run; `lambda.realcli.test.ts` and `aws-cli.realcli.test.ts`, which wait out real timeouts and retries, also need `AWS_MCP_REAL_CLI_TESTS=1`, and `release.sh`'s test step now exports it as a default an explicit `AWS_MCP_REAL_CLI_TESTS=0` still overrides. A fake can only say what it was told the real CLI says; these check that it was told the truth.

## [2.3.2] — 2026-09-14

### Fixed
- **The bundled `fast-uri` is out of its advised range.** The published 2.3.1 bundle carried `fast-uri` 3.1.2 (via `@modelcontextprotocol/sdk` -> `ajv`), inside the range of six high-severity host-confusion and SSRF advisories; it is now 3.1.7. The `@modelcontextprotocol/sdk` range is unchanged at `^1.30.0`, and the SDK's other advised dev-tree packages, none of which are bundled, move too: `hono` 4.12.25 -> 4.13.7, `@hono/node-server` 1.19.14 -> 2.1.1, `ip-address` 10.2.0 -> 10.7.0, `qs` 6.15.2 -> 6.16.0, `body-parser` 2.2.2 -> 2.3.0, with the `hono` and `qs` override floors raised to their first patched versions (`^4.13.5`, `^6.16.0`). `npm audit` goes from 6 findings (2 high) to 0.

## [2.3.1] — 2026-09-14

### Changed
- npm and MCP Registry listing metadata: bugs URL, core keywords, and server.json title/repository/websiteUrl
- `release.sh` writes a `## [x.y.z]` changelog entry for every release -- promoting `[Unreleased]` when it has content, otherwise generating one from the commit subjects since the previous tag -- keeps the Keep-a-Changelog link references current, and takes the GitHub release notes from that entry instead of from `git log` subjects. Before this, a release with nothing under `[Unreleased]` got no entry at all (2.3.0 below is backfilled), and every GitHub release page showed raw commit subjects.

## [2.3.0] — 2026-09-13

Documentation only; no change to the published package's behavior.

### Changed
- README: the X follow badge moved from the top of the page to the bottom, so the description leads on npm and GitHub (#43).
- README: says when the launcher names skipped oam binaries on stderr -- an unusable `OAM_BIN` is always named; other skipped binaries and a `.cmd`/`.bat` shim only when no usable oam is found (#41).
- CHANGELOG: the 2.2.6 `OAM_BIN` bullet corrected (#42).

## [2.2.7] — 2026-09-13

### Fixed
- **The launcher's Node fallback survives a failed oam spawn on an oam host.** When the chosen oam passed its version check but could not be spawned (deleted or replaced in between), the failed child still emitted `close` with the negative errno, and on an oam host -- where the launcher waits for `close` -- that exited the launcher in the middle of the fallback, so nothing served. Stdin was also piped into the child before it ran. Both now wait for the child's `spawn` event. Found by review while porting the 2.2.6 launcher to the other Yaw Labs servers.
- Test-only: the success-path hang guards in the `runAwsCall` and SSO integration tests are sized for a saturated machine (30s), after both v2.2.6 release test runs failed on 5s and 2s deadlines with the CPU at 100%.

## [2.2.6] — 2026-09-13

### Fixed
- **The launcher always uses the newest oam, and the minimum is now the latest release, 0.15.2.** It used to take the FIRST oam binary it found and only then check its version, so a stale copy in an earlier location hid a current one: with oam 0.9.0 in `~/.oam/bin` and 0.15.2 on `PATH`, it ran 0.9.0. Every oam binary it can see is now asked for its version, and the newest at or above 0.15.2 wins.
- **An oam host older than the floor no longer serves the server itself.** When a client ran `oam run bin/aws-mcp.mjs` with an old oam and no newer one was found, the server ran on that old oam -- and below 0.9.0 oam passes CLI arguments through a shell. When a newer oam WAS found, the handoff inherited stdio, which an old oam does not honor, so the MCP handshake never answered (measured on a real oam 0.8.2 host). An old host now hands off with piped stdio to the newest usable oam, or to Node on `PATH`, or exits with an error when there is neither.
- **A bad `OAM_BIN` no longer stops discovery, and a missing one is no longer silent.** A path that does not exist, an oam below the floor, or a binary that will not run is named on stderr, and discovery carries on instead of dropping straight to Node. (Before, only a missing path went unreported.)
- **`AWS_MCP_RUNTIME=node` now always means Node.** Launched under `oam run`, it hands off to Node on `PATH` rather than staying on oam.
- Each `oam --version` probe is bounded at 5s, so a wedged binary on `PATH` cannot hang the launch.

### Changed
- Docs only: the README's Environment section now covers `AWS_DEFAULT_PROFILE`, which the server has always honored, and the launcher's `AWS_MCP_RUNTIME` and `OAM_BIN`, which it never mentioned. The Runtime section no longer says Node is the packaged default -- the published `aws-mcp` command has preferred oam since 1.7.0 -- and its startup table is labeled as an oam 0.8.2 measurement taken before the 0.9.0 floor.

## [2.2.5] — 2026-09-13

### Changed
- No behavior change in the published package. `startSsoLogin` accepts a `versionProbeTimeoutMs` option, a test knob beside `urlWaitMs` and `sessionTtlMs` that production never sets; the `aws --version` probe keeps its 2s bound.
- Test-only: the version-probe tests in `sso.integration.test.ts` failed 2-3 runs in 5 on an ordinary loaded machine, because the fake CLI's cold start could outlast the 2s probe bound and a timed-out probe silently answers "assume modern". They now give the fake 30s to answer; the hung-probe test still pins the 2s default.
- Test-only: three `runAwsCall` timeout tests no longer race the fake CLI's cold start. Two assumed the fake wrote its output before a fixed 2s kill and failed 5 and 8 runs in 8 under load. They now assert only on an attempt where the fake confirmed the write landed first, and retry with a longer timeout otherwise. The orphan test also can no longer strand a suspended orphan process: libuv starts a detached child suspended, and a kill between spawn and resume left one holding the test file's pipes open indefinitely. The third test's 12s settle bound, which a correct call missed about 1 run in 5, is now 60s.

## [2.2.4] — 2026-09-12

### Fixed
- **The launcher no longer spawns a nested oam when it is already running on oam.** A host can resolve this package's `bin` and launch `oam run bin/aws-mcp.mjs` rather than `node bin/aws-mcp.mjs` -- Yaw MCP does, and so does oam's sidecar regression matrix. The launcher discovered and spawned an oam without checking what it was already running on, so one server cost two runtime boots: on Windows, an `oam.exe` with a NESTED `oam.exe` and `conhost.exe` underneath it. When `process.versions.oam` clears the same 0.9.0 floor a discovered binary has to, the server is now imported into the running process exactly as the Node fallback is -- no discovery, no `oam --version` probe, no second oam. `OAM_BIN` is a discovery input and is not consulted on that path, since the host has already chosen which oam runs, and already running on oam satisfies `AWS_MCP_RUNTIME=oam`. A host oam below the floor takes the discovery path it always did, and `AWS_MCP_RUNTIME=node` is unchanged.

### Changed
- Repo tooling only, nothing in the published package: `tsconfig.json` declares `typeRoots`, so `npm run check:oam` type-checks instead of failing with `TS2688: Cannot find type definition file for 'node'` -- `oam check` extends this config from its own cache directory, where `types: ["node"]` alone does not resolve. Stock `tsc` was never affected, and the build output is byte-identical with and without the line.
- Test-only: every `parseAwsError` remedy group is now a table-driven test that enumerates each code in its branch, including `AccessDeniedException` and `ResourceAlreadyExistsException`, which their existing tests never actually reached. `src/errors.ts` is unchanged.

## [2.2.3] — 2026-09-11

### Changed
- Package metadata only, no code change in the published package: the npm `description`, `keywords` and `homepage` now match the terms the README actually uses, and `homepage` points at the per-server page.
- Repo tooling only: `release.sh` now waits for npm to SERVE a freshly published version before the MCP Registry step. `npm publish` returns when the registry accepts the tarball, but the MCP Registry validates by reading it, so step 7 failed with `version 'X' was not found (status: 404)` on v2.2.0, v2.2.1 and v2.2.2 and each release took a second invocation. The wait polls the same URL the registry reads with curl rather than `npm view`, whose 5-minute metadata cache can keep reporting the pre-publish answer, and it warns rather than fails on timeout so `mcp-publisher` still gets to report its own precise error. `SKIP_NPM_WAIT=1` bypasses it and `NPM_WAIT_TIMEOUT_S` retunes the 300s default.
- Repo tooling only: `scripts/lint.mjs` sizes the emulated biome it provisions on the version npm INSTALLED (`package-lock.json`, then `node_modules/@biomejs/biome/package.json`) rather than on `biome.json`'s `$schema` URL, which pins the config schema and drifts from the binary the moment either is bumped alone. Both agree here today, so this is a guard rather than a behavior change. The `lint.mjs` header and `release.sh`'s `SKIP_LINT` comment no longer overstate the arm64 crash: it is specific to biome 2.5.4 on a check run, not a standing arm64 defect.

## [2.2.2] — 2026-09-09

### Added
- **`aws_lambda_invoke` reports progress.** v2.1.0 gave `aws_resource_*`, `aws_multi_region` and `aws_assume_role` progress notifications on the stated reasoning that "a stdio server that says nothing for minutes is indistinguishable from one that has hung". The tool that can legitimately run LONGEST shipped in v2.2.0 without inheriting it: its own description tells callers to raise `timeoutMs` because a Lambda may run up to 15 minutes, and it then sat silent for all of them. It now emits a single starting notification naming the function, the qualifier when one is given, and the effective timeout -- one line, no `total` and no manufactured intermediate steps, since a single indivisible invoke has no honest denominator. Same shape as `aws_assume_role`.
- **`aws_multi_region` and `aws_multi_account` honor client cancellation.** Both accepted a `ToolContext` and reported progress but never read `ctx.signal`, so a client that cancelled a 32-region or 32-account sweep left every remaining item running. The shared concurrency runner now checks the signal before CLAIMING each input -- work already in flight is allowed to finish rather than abandoned, because those calls are already spent against AWS and discarding their answers would throw away results the caller has effectively paid for.
- **New `cancelled` errorKind, fan-out entries only.** An unattempted item is represented rather than dropped: a silently shorter `results` array reads as "these are all the regions", which would quietly under-report a fleet-wide check. Every slot stays occupied, so `okCount`/`errorCount` still describe the full requested set. The entry says plainly that nothing was sent to AWS for it -- and for `aws_multi_account`, that no role was assumed, so there is no credential to redact.

## [2.2.1] — 2026-09-08

### Fixed
- **`aws_logs_query` dropped the remedy sentence when a POLL failed.** On a poll-side failure the handler rebuilds its message around the `queryId` -- that recovery hint is the whole reason the arm exists -- and deliberately quotes the RAW stderr in preference to `runAwsCall`'s summary, so nesting a second remedy inside the first cannot displace the token the caller needs. But `runAwsCall` appends its `Suggestion: <remedy>` line to that summary and nowhere else, so preferring the raw body silently dropped it: for a recognized AWS error code (an IAM denial mid-poll, a throttle) the sentence naming the fix was absent from the message AND from the envelope, while the README's Stability section states `suggestion` is duplicated at the end of `error`. `QueryPollResult` now carries it and the arm re-appends it, guarded on containment so a raw body that already quotes the sentence cannot print it twice -- the defect v2.0.1 fixed for `rawBody` itself. Only this one path was affected; every other tool's remedy already survived.
- `aws_logs_query`'s error envelope now OMITS `suggestion` when there is none, rather than setting the key to `undefined`. Not visible over MCP -- `toMcpResult` never renders that field -- but `aws_script` attaches it to the error it throws, so a script doing `'suggestion' in err` saw a key that was always present and sometimes meaningless.

### Changed
- Repo tooling only, nothing in the published package: `npm run lint` now routes through `scripts/lint.mjs`, which resolves a biome binary that actually works on the host. On Windows ARM64 the native binary segfaults on every invocation path, so the wrapper provisions the x64 build into `node_modules/.cache` and runs it under emulation; everywhere else it is a passthrough. The cache is keyed by version and re-verified before use, and every spawn is bounded -- `npm run lint` is `release.sh` step 1 and runs unattended, where an unbounded child wedges a release instead of failing it (the same reasoning that bounded the test suite in v1.8.2). `release.sh`'s `SKIP_LINT` / `SKIP_TEST` comments no longer claim CI will catch what they skip: this repo ships no CI, so skipping either step means publishing unchecked.

## [2.2.0] — 2026-09-08

### Added
- **`aws_lambda_invoke` closes the one gap this README routed to a Python server.** `aws_call` is sold as covering the full AWS API, and for Lambda invokes that was false: `aws lambda invoke` takes the response body as a required POSITIONAL outfile, `SAFE_NAME_RE` rejects `operation: "invoke out.json"` before a process ever spawns, and `--cli-input-json` cannot supply an outfile because it is a CLI construct rather than an API member. The documented escape hatch was a `uvx`/Python awslabs server -- the exact thing this package's Node-only positioning exists to avoid. The new tool mints a 0600 temp file, passes it as a bare positional (the mechanism `aws_logs_tail` already uses for its log-group argument, so `aws-cli.ts` is untouched), and unlinks it in a `finally` that also covers the timeout and spawn-error paths. The returned `logTail` is the function's own `LogResult` already base64-DECODED, which collapses the usual invoke -> find the log group -> tail it -> hope the window caught it loop into one call; the official AWS server hands that back still encoded. A non-empty `functionError` is deliberately `ok: true` -- the invocation succeeded and the function's handler threw -- so a caller can tell "your code raised" apart from "the call never landed". `destructiveHint: true`, because invoking arbitrary Lambda code can do anything the function's own role permits, the same reasoning v2.0.1 applied to `aws_call`. Async invocation, DryRun and the `aws_script` binding are deferred.
- **`aws_multi_account` fans an operation across accounts without touching the credentials file.** Multi-region fan-out is this server's lead differentiator; this is the same move on the axis operators actually live in. The only path before was `aws_assume_role` in a loop, where the written profile name derives from `sessionName` -- so a 40-account sweep either wrote 40 sections into `~/.aws/credentials` or stomped one profile 40 times (the handler already returned a `warning` for exactly that stomp), and a sweep that died midway left live credentials on disk for accounts the operator had moved on from. This holds each account's session IN MEMORY and hands it to that one subprocess via `runAwsCall`'s existing `env` option, so nothing is written and nothing outlives the call. A subtlety worth naming because getting it wrong produces a wrong ANSWER rather than an error: botocore drops the environment credential provider the moment an explicit `--profile` is set, so the per-account spawn must carry no profile flag -- if one came back, every account would silently answer as the operator's own identity. A test asserts the flag's absence head-on. The envelope mirrors `aws_multi_region` field for field with `accountId` in place of `region`, reusing its concurrency runner and 5 MB aggregate cap rather than reimplementing them. This is fan-out in one call, not new access: it reaches exactly what the assume-role loop reached. `discoverFrom: 'organizations'` (it AccessDenies from a workload account, where most operators sit), `ouId`, and the regions cross-product are deferred as additive follow-ons.
- **`aws_logs_query` runs a CloudWatch Logs Insights query to completion in one call.** The only path before this was the three-step start-query / poll get-query-results / interpret-the-status dance through `aws_call`, re-implemented by every caller, and `aws_script` was not an alternative: its context binds no timers, so a busy-wait poll written there blocks the whole single-threaded stdio server. The tool takes 1-50 `logGroupNames` (bare names or ARNs, resolved the same way `aws_logs_tail` resolves them), a `queryString`, and the `startTime`/`endTime` vocabulary already shared by `aws_logs_tail` and `aws_metrics_query`; it returns the rows FLATTENED out of the API's `[{field, value}]` pairs into plain objects, plus `fields`, `statistics` and `truncated`. Termination is decided by an allowlist of the two in-flight statuses (`Scheduled`, `Running`) rather than a list of terminal ones, so a status AWS adds later — or a missing one — ends the poll instead of burning the wait budget. The poll loop follows the `awaitCompletion` discipline v2.1.0 established: one progress notification per attempt naming the observed status and elapsed time, `ctx.signal` checked before every pass including the first, a sleep that aborts immediately rather than waiting out its interval, and a distinct cancelled result that is never a fake success.
- **The Insights query is never stopped AWS-side, on any exit path.** There is a `StopQuery` API and this tool deliberately does not call it. Results are retained for 7 days, so letting a query finish preserves work the caller has already been billed for while stopping it would leave only partial rows; `StopQuery` also errors outright once the query has ended, which is the common case in the seconds after a poll. So a timeout or a cancellation hands back the `queryId` and says plainly that the query is still running — abandoning it stays an explicit choice, spelled out in the error, that the caller can make with `aws_call` and the same `queryId`.
- Bounds worth knowing on `aws_logs_query`, each for a named reason rather than symmetry: the window is capped at 90 days because Insights bills by uncompressed bytes **scanned**, so unlike every other bound in this server a fat-fingered range spends money rather than wasting a call; `limit` defaults to 1000 and caps at 10,000 rather than `StartQuery`'s documented 100,000, because a single `GetQueryResults` returns at most 10,000 rows and the rest needs pagination members absent from shipped CLI models (`aws logs get-query-results --generate-cli-skeleton` on aws-cli 2.34.3 emits `{"queryId": ""}` and nothing else); and the 500ms poll floor keeps one call inside the account's 10/sec `GetQueryResults` quota.
- **`aws_logs_tail` takes an optional `maxEvents`.** The response is now bounded: at most `maxEvents` events come back (default 500, ceiling 10,000, clamped for direct callers the same way `aws_paginate`'s `maxItems` is). Two additive envelope fields describe the cut -- `truncated: boolean` and `totalEvents`, the number of events the window actually held. `eventCount` keeps its meaning, "how many events are in `events`", so the two counts differ exactly when `truncated` is true; both are `null` on the existing NDJSON-parse-failure path, where `events` is the raw blob and nothing is dropped. **The newest events are kept, not the first N** -- `aws logs tail` emits oldest-first, and the head of a busy window is the half furthest from whatever the caller is investigating. Order within the returned array is unchanged. This bounds the RESPONSE only: the CLI has already drained the whole window server-side and the full stdout is already captured (up to the 5 MB cap) by the time the limit applies, so narrowing `since` or adding a `filterPattern` is still the only way to make the call itself cheaper, and `maxEvents` cannot rescue a call that dies with `output_too_large`.
- **`errorKind` is surfaced on every tool, not just `aws_multi_region`.** The README told integrators to anchor on `errorKind` rather than regex the `error` wording, but only `aws_multi_region` ever emitted it -- every other tool computed the classification inside `runAwsCall` and dropped it on the floor. `ToolResult` now carries `errorKind?: string`, populated at the handler sites that already held a classified kind in scope (`aws_call`, `aws_paginate`, `aws_logs_tail`, `aws_logs_query`, `aws_metrics_query`, `aws_iam_simulate`, `aws_whoami`, `aws_login_complete`, `aws_assume_role` including its three rewritten credential arms, the shared CCAPI failure shape behind all seven `aws_resource_*` verbs, and both arms of the `awaitCompletion` poll loop). Over the wire it arrives as a leading `errorKind: <kind>` line ahead of the existing `Error: <message>` text -- the text block is the only delivery path guaranteed to reach every host, since `structuredContent` would require migrating all registrations to `registerTool` with a per-tool `outputSchema`. Handlers that fail their own input validation are deliberately left alone: an absent `errorKind` means "unclassified", never `nonzero_exit`. Nothing is emitted at all when the field is unset, so an unclassified failure's text is byte-identical to before.
- **`suggestion` is carried structurally on the error envelope.** The one-line remedy `parseAwsError` derives from a recognized AWS error code was only ever available as prose glued to the end of `error`. It now rides alongside as `suggestion?: string` on both `AwsCallFailure` and `ToolResult`, and `aws_script`'s bridge attaches it (with `errorKind`) to the Error it throws, so a script can branch on `err.errorKind === 'sso_expired'` instead of matching a sentence. It is still embedded in `error` as well, deliberately: `aws_multi_region` carries only per-region `error` text, so moving it out would silently drop the remedy from every multi-region failure. For the same reason `toMcpResult` does NOT render it a second time -- printing it twice is the defect v2.0.1 fixed for `rawBody`.

### Changed
- **`aws_logs_tail` returns at most 500 events by default.** This is a behavior change, not merely an additive one: a call against a busy log group that previously returned 10,000 events now returns the newest 500, with `truncated: true` and `totalEvents: 10000` saying so. Nothing was previously counting them -- the whole window was parsed and serialized into a single MCP response, which is how one tail could consume a caller's entire context window. Callers that need the old behavior can pass `maxEvents` explicitly up to 10,000; callers that need more than that were already at the mercy of the 5 MB stdout cap and should narrow `since` or add a `filterPattern`. Windows under 500 events are unaffected apart from the two new fields.
- `resolveTime` — the `startTime`/`endTime` parser that makes an explicit UTC offset mandatory — moved from `metrics.ts` to `logs.ts`, beside the relative-time vocabulary it extends, and is re-exported from `metrics.ts` so nothing importing it has to change. `aws_logs_query` needs the same parser, and importing it the other way would have closed a `logs -> metrics -> logs` module cycle. `sleepUnlessAborted` is likewise exported from `resource.ts` and shared rather than copied into the second poll loop.

### Fixed
- **The documented `errorKind` enum was missing `unexpected`.** The fan-out tools have emitted it since `aws_multi_region` shipped, for an entry whose worker threw rather than returning a result, but the README's enum listed only the ten `AwsCallFailureKind` members -- so an integrator writing an exhaustive switch over the documented values had a hole. The Stability section now also separates the two surfaces the field appears on, because they follow different rules: a top-level envelope OMITS `errorKind` when the failure never reached the CLI, while a fan-out `results` entry always carries one -- including `bad_input` for an entry the tool rejected itself. Documentation only; no behavior change.

## [2.1.0] — 2026-08-31

### Added
- **Progress reporting on long-running tools.** A stdio server that says nothing for minutes is indistinguishable from one that has hung, and three tools could run that long in silence. `aws_resource_*` with `awaitCompletion` now emits one MCP progress notification per poll attempt naming the elapsed time and the observed `OperationStatus` (no `total` -- the operation ends when AWS says so, so there is no honest denominator); `aws_multi_region` reports `(completed, total)` as each region settles, using the deduped region count; `aws_assume_role` emits a single starting notification naming the role and resolved timeout rather than manufacturing fake intermediate steps. Progress is opt-in per the MCP spec -- nothing is sent unless the client supplied a `progressToken`, so this is invisible to clients that do not ask for it.
- **Client cancellation is honored during `awaitCompletion` polling.** The SDK exposes an `AbortSignal` for a cancelled request that nothing previously read, so a 30-minute poll kept running for a caller who had already walked away. The loop now checks it before every pass (including the first) and returns a distinct `cancelled` result -- never a fake success -- that states plainly the AWS operation itself was NOT cancelled and hands back the `requestToken` to check it. The sleep between polls aborts immediately rather than waiting out its interval.
- **`aws_docs_search` results carry a lexical relevance signal.** The backend always returns a full page of fuzzy matches and has no way to say "no good match", so a nonsense query came back with ten confident-looking hits -- worse than an empty state, because a model cannot tell them apart and may cite an unrelated page. Each result now carries `lexicalMatch` (`overlap`, `matchedTerms`, `unmatchedTerms`), and the response adds `queryTerms`, `termsMatchedNowhere`, `bestLexicalOverlap`, `lowRelevance`, and an explanatory `relevanceNote`. This is literal word overlap computed locally -- explicitly NOT a backend score and NOT semantic ranking; results are annotated, never re-ordered. The tokenizer handles the shapes this domain actually uses (`Route53::Errors::NoSuchHealthCheck`, `s3:GetObject`, `aws-sdk-js`, CamelCase, and the "Route 53" / "route53" split). Strictly additive: `count`, result order, and every existing field are unchanged.

### Fixed
- **`aws_assume_role` declares `destructiveHint: true`.** It writes the shared credentials file and overwrites the three managed keys in place when the target profile already exists -- the handler returns a `warning` for exactly that case, so the stomp was acknowledged in code while the annotation said "only additive updates". Same reasoning applied to `aws_call`, `aws_multi_region` and `aws_resource_update` in v2.0.1.
- **The low-relevance verdict no longer lets a nonsense query through.** Found by driving the built server against the live docs backend, not a fixture: `zzzzqqq-nonexistent-service-xyzzy` scored `bestLexicalOverlap` of exactly 0.5, because one unrelated page happened to contain the ordinary English words "nonexistent" and "service" -- while `zzzzqqq` and `xyzzy`, the terms that actually identify the query, matched nothing at all. Two flaws: the threshold test excluded its own boundary, and taking the max across results lets one incidental hit speak for the whole set. The check is now `<=`, and any term absent from every result flags the response on its own.
- **`aws_script`'s description and the README no longer call it a sandbox.** The docblock was corrected in v2.0.0, but the model-visible tool description still read "NOT a security sandbox -- treat the same as any other tool", which understates it: every other tool is bounded by AWS and the caller's IAM policy, and this one is not. The description and three README passages now state that the script runs in this server's own process, that host globals remain reachable from inside it, and that only script text you would run on the machine yourself should be passed -- never text that arrived from a log line, a resource tag, or any other AWS response. The README also claimed `process`/`fs`/`fetch` were absent; they are not bound into the context, which is not the same as unreachable.

## [2.0.1] — 2026-08-31

### Fixed
- **`aws_call`, `aws_multi_region` and `aws_resource_update` now declare `destructiveHint: true`.** MCP hosts gate their "are you sure?" confirmation on this annotation -- a server cannot prompt on its own, so the annotation *is* the confirmation mechanism. Per the MCP spec the field defaults to `true`, and `false` positively asserts "performs only additive updates". All three asserted that while being able to do the opposite: `aws_call` reaches the entire AWS API (`ec2 terminate-instances`, `s3api delete-bucket`, `iam delete-user`), `aws_multi_region` runs that same arbitrary operation across up to 32 regions at once, and a Cloud Control update patching a replacement-forcing property makes the provider delete and re-create the resource. `aws_call`'s comment already said to "annotate conservatively since we can't introspect" -- the value was the least conservative one available. Read-only tools (`aws_paginate`, `aws_docs_*`, `aws_whoami`) are unchanged. Expect hosts to prompt on these three where they previously did not; that is the point.
- **Credential errors no longer print their stderr twice.** `aws-cli.ts` ends its auth-class messages with `Underlying error: <stderr>` so the diagnostic survives handlers that rebuild the message without forwarding `rawBody`, and `toMcpResult` then appended `rawBody` -- the same stderr -- again. It now appends only when the summary does not already contain it (compared trimmed, since the raw stream carries trailing CR/LF the embedded copy does not); a genuinely truncated summary still gets the full body appended, which completes the clipped copy rather than repeating it. Worst on `no_creds` / `expired_creds` / `invalid_creds`, the errors a first-run user is most likely to hit.
- **`aws_assume_role` and `aws_resource_*` no longer nest a second, conflicting remedy inside the first.** Both quoted the upstream `result.error` after their own `Underlying error:`, but that string is itself `<remedy>. Underlying error: <stderr>` -- so the model got two instructions naming two different profiles for one failure, and in `aws_resource_*` the nested remedy displaced the `requestToken` recovery path that is the whole reason that arm exists. Both now quote the raw diagnostic instead. `aws_assume_role` quotes stderr only, never stdout, because `aws sts assume-role` writes the credential blob to stdout and may flush a partial one before failing.

## [2.0.0] — 2026-08-31

Findings from a full-pass audit of all 21 source files. The recurring defect was
not broken code but **comments asserting safety properties the code did not
implement** -- eight independent cases, several of which terminated an auditor's
search at exactly the wrong place. Those are corrected here alongside the bugs.

### Security
- **`aws_script`'s sandbox does not contain, and its docblock claimed it did.** Bridge functions (`console.log`, every `aws.*`) are host-realm closures, so their prototype chain never entered the vm context: `console.log.constructor` yields the **host** `Function`, and `Function('return process')()` returns the real host process object, with `fs` and `child_process` reachable via `getBuiltinModule` (verified by probe against the shipped bundle -- the returned pid matched the host's exactly). `codeGeneration.strings: false` blocks the *in-realm* `Function` only, which is the half the docblock tested. The two false claims -- "a script gains no capability it didn't already have" and "the shadow list below is the load-bearing defense" -- are removed and replaced with a plain statement of what is reachable. **No containment was added**; the operator already grants this server AWS credentials and CLI spawn rights, but note the escape reaches material IAM does not govern (static long-lived keys in `~/.aws/credentials`, SSH keys, arbitrary outbound network) and leaves no CloudTrail record. Treat `aws_script` as trusted-input-only.
- **A short write can no longer truncate the credentials file.** `writeSync`'s return value was discarded, so a partial write (POSIX permits one; interrupted syscalls and network filesystems produce them) was `renameSync`d over the real `~/.aws/credentials` -- silent data loss that no `try`/`catch` could see, because a short write does not throw. The write now loops on the byte offset until drained.
- **A failed credential write no longer leaves plaintext credentials on disk.** The tmp file in `writeAssumedCredentials` is opened `0600` and written, but only the fd was closed on the failure path -- a throw from `writeSync`/`renameSync` left `~/.aws/credentials.tmp-<pid>-<uuid>` in place permanently, holding the access key, secret key, and session token under a name no cleanup path or human would look for. The caller reported the write failure and never mentioned the file. It is now unlinked best-effort, without masking the original error.
- **`aws sso login` output reaching the model is now length-bounded.** Five `rawOutput` sites forwarded raw CLI stdout+stderr into model-visible text, bounded only by the 5 MB memory cap.

### Breaking
- **`aws_iam_simulate` no longer returns `evaluationResults`.** The full raw array was returned alongside the parsed `results`, doubling the payload for no consumer. The drop is lossy and the header comment now says exactly how: promoted are `EvalDecision`, `EvalActionName`, `EvalResourceName`, `MissingContextValues`, and the two decision details reduced to `"allowed"`/`"denied"`. **Not** promoted, and no longer reachable through this tool: the `MatchedStatements` *bodies* (`matchedStatementIds` carries each match's `SourcePolicyId`, or a synthesized `inline#L<n>`, and nothing else), plus `EvalDecisionDetails` and `ResourceSpecificResults`. Callers needing those must go around the tool via `aws_call`.
- **`aws_metrics_query` requires an explicit UTC offset on date-time inputs.** `new Date("2026-05-16T10:00:00")` parses as **local** time while a date-only string parses as UTC; the result was then `.toISOString()`d, silently skewing the window by the host's offset on input the tool description called "ISO 8601". Date-only stays accepted as UTC. Bare numbers (`"5"`, a dropped unit) are now rejected outright rather than falling through to `new Date("5")` -- which V8 reads as 2001-05-01, turning "5 minutes" into a 25-year window.
- **`aws logs tail --since` is bounded to 30 days**, and a zero-width window (`"0m"`) is rejected rather than returning `ok: true, eventCount: 0` -- indistinguishable from "no events found".
- **stdout that opens as JSON and fails to parse is now a failure, not a success.** It previously settled `ok: true` with the raw string, so a truncated payload reached callers as a successful call whose `data` was a string where the schema promised an object. It now settles `ok: false` with the new `malformed_json` kind and preserves the raw stdout. Genuinely scalar stdout (a `--query` extracting a string or number) still succeeds as before.

### Added
- **`aws_iam_simulate` surfaces truncation.** `SimulatePrincipalPolicy` returns `IsTruncated`/`Marker`; the handler read neither and reported `summary.total` as if it were the whole answer -- a silent undercount, and the only tool in the codebase that neither paginated nor admitted truncation existed. It now returns `hasMore` + `marker` and accepts `marker` to resume. `summary` also gained `unknown`, so a malformed decision is no longer folded into `denied`.
- **`aws_logs_tail` accepts a log-group ARN**, extracting the group name. A pasted ARN previously bounced on `LOG_GROUP_RE`, which rejects `:`.
- **`aws_multi_region` entries carry `truncated`**, and the aggregate response is capped -- 32 regions x 5 MB stdout each were held and serialized into one MCP response with no batch limit. Error entries are never dropped, and `okCount`/`errorCount` are computed before capping so they describe what the calls did.
- **`aws_resource_*` signals a skipped wait** via `awaitSkipped` when `awaitCompletion: true` was passed but no request token came back to poll on.
- **`invalid_creds` error kind**, separating "credentials resolved and AWS rejected them" (`UnrecognizedClientException`, `InvalidClientTokenId`, `SignatureDoesNotMatch` -- typical after a key rotation) from "no credentials found". The latter's advice to check `~/.aws/credentials` is wrong for the former.
- **`aws_resource_*` and `aws_assume_role` recognize `invalid_creds` in their credential-recovery arms.** Both gated their kind-specific handling on the expiry and missing-credential kinds only, so a key rotated mid-poll fell through to the bare error and dropped the `requestToken` recovery hint -- the same defect fixed for `expired_creds`, in the same guard. Its remedy text differs from both siblings: the credentials resolved and AWS refused them, so the fix is to repair the profile's credentials, not to re-authenticate and not to create them.
- **`expired_creds` error kind**, for an expired *temporary session*. AWS emits the same `An error occurred (ExpiredToken)` wrapper whether the session came from SSO, `aws_assume_role`, or web identity, so classifying it as `sso_expired` told assume-role users to run `aws_login_start` -- wrong advice -- and dropped the underlying stderr on the `aws_assume_role` path. The new kind is origin-agnostic and names both remedies; `sso_expired` is now reserved for errors that name botocore's SSO token provider specifically. `aws_resource_*` and `aws_assume_role` carry matching arms, so the mid-poll `requestToken` recovery hint still reaches the caller.
- `aws_resource_diff` is bound into the `aws_script` bridge as `aws.resource.diff`, where preview-then-update composes.

### Fixed
- **SIGTERM never escalated to SIGKILL, on any platform.** The guard was `!proc.killed && proc.exitCode === null`, but Node latches `proc.killed` when the signal is *dispatched*, not when the child dies -- so it was already false when the 2s timer ran. The module's stated purpose could not be delivered, and its comment blamed Windows for a branch that was dead everywhere. It now uses the `procHasExited` helper the same file already exported. `runAwsCall` had a documented "no watchdog needed by design: SIGKILL is unconditional" decision resting on this, so a child ignoring SIGTERM would have left its promise pending forever.
- **`runAwsCall` settles on `'close'`, not `'exit'`, and is bounded even when a descendant holds the pipes.** `'exit'` fires while stdio pipes may still hold unread data, so truncated stdout could fail `JSON.parse` and be returned as a successful call. But `'close'` alone is not a bound: it fires when the *last writer* on those pipes goes away, and any descendant that inherited the stdio handles keeps them open after `aws` itself dies -- `aws ssm start-session` and `aws ecs execute-command` both hand off to `session-manager-plugin` exactly that way, and both are reachable from `aws_call`. A grace timer is now armed at both kill sites and re-armed from an `'exit'` listener, so a reaped child whose descendant still holds the pipes settles instead of hanging past its own `timeoutMs`. Regression tests spawn a `detached` grandchild to reproduce it -- non-detached does not, because libuv's job object kills such a child with its parent on Windows and masks the bug.
- **Empty environment variables no longer wedge the fallback chain.** `??` does not treat `""` as absent, so `AWS_PROFILE=""` / `AWS_REGION=""` (routine in CI, where a variable is declared but unset) short-circuited the chain and never reached `AWS_DEFAULT_REGION`. `AWS_DEFAULT_PROFILE` is now honored, matching botocore. The same `??`-vs-`||` bug is fixed in eleven `rawBody` returns across `resource.ts` (7), `auth.ts`, `paginate.ts`, `metrics.ts`, `iam-simulate.ts`, and `logs.ts`.
- **`aws logs tail` NDJSON is no longer read as a truncated payload.** Its `--format json` output is one JSON object per line, so the blob opens with `{` and cannot parse as a single document -- the exact signature the new truncation check uses. Callers now declare `ndjson: true`; the check is unchanged for everyone else, since complete NDJSON and a truncated document are not distinguishable by inspection.
- **Three unreachable branches removed from `classifyAuthError`.** They keyed on SDK error *names* (`SSOTokenProviderFailure`, `ExpiredTokenException`, `CredentialsProviderError`), but the sole caller passes `new Error(stderrBuf)`, whose `name` is always `"Error"` -- and this package has zero runtime dependencies, so no SDK exists to produce them. The header claiming "both the SDK and the CLI get routed through here" is corrected. The genuinely common `An error occurred (ExpiredToken)` shape matched nothing and classified as `nonzero_exit`, so callers branching on `kind` to prompt re-login missed it; throttle codes (`TooManyRequestsException`, `SlowDown`, `ProvisionedThroughputExceededException`) and a bare `User: ... is not authorized` are now recognized.
- **`aws_docs_read` had the one genuinely unbounded fetch.** `response.text()` had no byte cap (the 30s timeout bounds latency, not size), the markdown conversion then blocked the event loop of a single-threaded stdio server, and the **full** document was cached -- the `maxLength` slice happens after the cache write. The header's "each entry is bounded by 1 MB, so worst-case footprint is ~64 MB" described a bound that did not exist. The body read is now capped and the arithmetic is true.
- **The docs allowlist is re-checked after redirects.** `isValidDocsUrl` validated the request URL; `fetch` follows redirects and the final `response.url` was never re-examined.
- **`aws_iam_simulate` bounds its request size.** `resources` had no maximum while `actions` was capped at 50; the product lands in a single `--cli-input-json` argv entry, which Linux caps at 128 KB and Windows at ~32 KB, so a plausible 300-ARN batch died as an opaque spawn error rather than a validation message.
- **`aws_metrics_query` counts datapoints per request, not per query -- and respects `maxDataPoints`.** CloudWatch's 100,800 limit is per request while the check divided it per query, so 100 queries at 100,000 points each passed locally and bounced server-side with exactly the vaguer error the check exists to prevent. The estimate now also clamps to `maxDataPoints` where the caller set one, so a request the caller has already bounded is not rejected on a projection that cannot materialize. The claim that the auto-picked period is "capped safe by construction" was also false -- the 3600s floor leaves ranges beyond ~11.5 years unchecked.
- **Pagination cursors are no longer rejected at 128 characters.** `nextToken`/`startingToken` reused the validator written for `ClientToken`/`RequestToken`, whose documented 128-char cap does not apply to cursors; real CloudControl cursors are longer base64 blobs, so page 2 of every list failed loudly on entirely expected input.
- `aws_assume_role` honors `AWS_SHARED_CREDENTIALS_FILE` -- previously hardcoded to `~/.aws/credentials` while its own error message told the user to set that variable, and a user who had it set got the profile written where the CLI would not read it.
- SSO token expiry tolerates botocore's legacy `...UTC` timestamp spelling (which `new Date()` returns `NaN` for, silently skipping every cache file and re-spawning a login each time) and allows 60s of clock skew.
- `aws_script`: captured `console.log` output now survives a timeout instead of being discarded at the moment it is most useful; `maxPages: 0` no longer returns success with zero pages; `pollUntilTerminal` no longer makes one AWS call past its budget; `add`/`replace` patch operations require a `value`.
- Duplicate tool names now throw at registration; `toMcpResult` no longer drops `data` when `rawBody` is also set; argv entries in the model-visible `command` field are shell-quoted.

### Changed
- Nine intrinsic read/write pairs in the `aws_script` context setup were removed as verified no-ops (`vm.createContext({})` already yields realm-local intrinsics), and 17 of 19 shadow-list entries removed -- Node 22 does not inject `Buffer`, timers, `queueMicrotask`, `AbortController` or `fetch` into a bare context, contrary to the comment claiming it does.
- Seven duplicated CloudControl failure returns in `resource.ts` collapsed into shared helpers, along with two ProgressEvent unwraps and five handler preambles.
- The relative-time pattern shared by `aws_logs_tail` and `aws_metrics_query` is single-sourced rather than duplicated byte-identically in both files.
- 24 symbols exported but never imported across a file boundary are now module-local. No `.d.ts` ships, so none were consumer-reachable.
- The esbuild `createRequire` banner's rationale cited an AWS SDK dependency this package does not have; corrected to name the CommonJS packages actually bundled.
- README: corrected the credential-resolution order (**static keys in the environment are not consulted** -- the unconditional `--profile` makes botocore drop its env provider), plus five stale response shapes.

## [1.8.2] — 2026-08-23

### Fixed
- **The launcher no longer dies with a raw stack trace when `spawn` fails.** Node throws synchronously rather than emitting `error` for some unexecutable targets — notably a `.cmd`/`.bat` on Windows — and the `error` listener is registered *after* the `spawn` call, so it could never observe that throw. Both failure modes now route through one handler.
- **Windows `PATH` discovery accepts `oam.exe` only**, instead of walking every `PATHEXT` entry and returning an `oam.cmd` Node cannot execute. A skipped shim is still **named** in the diagnostic, so an npm-style install no longer reports as "no oam binary was found".
- **A failing in-process fallback no longer escapes as an unhandled rejection.** `void runInProcess()` discarded the promise, replacing the launcher's own diagnostic with a raw stack trace.
- **Diagnostics that precede `process.exit` are written synchronously.** stderr is async for TTYs and pipes on Windows, so the exit could truncate them. They route through one helper that also handles short writes and macOS `EAGAIN` on a non-blocking piped stderr.
- Removed a literal backspace byte (`U+0008`) from the runtime-discovery comment, which made git treat the file as binary so its diff could not be reviewed.
- **An oam that cannot be *run* is no longer reported as an *outdated* one.** The version probe returns null for several distinct causes — not executable, wrong architecture, a shim Node refuses, deleted since the stat, unparseable `--version` output — and every one produced "older than oam 0.9.0 … run `oam self-update`", pointing at the single cause it definitely was not. The two cases now carry separate wording and remedies, and the outdated message reports the version actually detected.
- **Windows: the launcher no longer hard-kills the server on the first Ctrl-C.** There are no POSIX signals on Windows — `child.kill(sig)` ignores the name and calls `TerminateProcess`, an immediate hard kill (verified: a child with a `SIGTERM` handler never runs it and dies with `code=null`). The launcher forwarded anyway, on the stated assumption that this was a "no-op on Windows", so it aborted the graceful shutdown the console's own Ctrl-C had just started and skipped the server's `process.on("exit")` cleanup. The console already delivers the event to the whole process group, so on Windows the launcher now forwards nothing.
- **A wedged server no longer leaves the launcher hanging.** Forwarding was gated on `child.killed`, which records only that `kill()` was *called* — never that the child is gone — so every signal after the first was swallowed and there was no escape hatch. Escalation is now armed by a timer on the first signal: one press is enough, and a child still alive after a 2s grace window is killed. Using a timer rather than counting signals also stops the ordinary supervisor sequence (`SIGINT` then `SIGTERM` milliseconds apart) from being misread as impatience.
- **The test suite is bounded by `--test-timeout`, so a hang cannot wedge a release.** `node:test` has no default per-test timeout, so a test awaiting an event that never arrives runs forever -- and `npm test` runs unattended inside `release.sh`, which turns a wedged release rather than a failed one. 300000ms is deliberately generous (files measure ~7.5s worst case) and converts an infinite hang into a reported failure. Note the flag is per-FILE until Node 24, and requires Node >= 20.11.0.
- **The credential-race test no longer hangs when a forked child dies before signalling ready.** It waited on `child.once("message")` with no failure path, so an import throw or a stale build left the promise pending forever. It now settles on `exit` and reports the child's exit code.


## [1.8.1] — 2026-08-22

### Fixed
- **SSO login was broken on AWS CLI 2.22.0 and newer.** `aws_login_start` spawned
  `aws sso login --no-browser`, which since CLI 2.22.0 (Nov 2024) defaults to the
  PKCE authorization-code flow. That flow prints an
  `https://oidc.<region>.amazonaws.com/authorize?...` URL and **no short code**, so
  the device-code parse never matched and the call died on its 15-second
  "waiting for a verification URL" timeout -- with an error blaming the profile's
  SSO configuration. The server now passes `--use-device-code` to request the
  device-authorization grant it actually parses. The flag only exists from 2.22.0,
  so `aws --version` is probed once per binary (cached; unparseable output is
  treated as modern) and the flag is omitted on older CLIs, where the device grant
  is already the default.
- `aws_login_start` now recognizes PKCE output and fails immediately naming the
  flow and the fix, instead of spending 15 seconds to report a misleading
  "the profile may not be set up for SSO".

### Changed
- `@modelcontextprotocol/sdk` 1.29.0 -> 1.30.0 (stdio buffer-limit handling, Zod
  3.25 compatibility fixes, Content-Type validation by parsed media type, and a
  widened `@hono/node-server` range picking up a security fix). Bundled at build
  time, so this ships in the published artifact.
- README: AWS CLI requirement now states the 2.22.0 recommendation and notes that
  AWS CLI v1 is unsupported (maintenance mode 2026-07-15, end of support
  2027-07-15); the comparison table and the official-AWS-MCP-Server blurb are
  refreshed for its May 2026 GA, June 2026 cross-account/cross-role support, and
  March 2026 CloudWatch metrics + semantic Agent-SOP discovery.
- The version probe is bounded at 2 seconds (it runs ahead of the existing
  15-second URL wait), caps the output it will buffer, keys its cache on `PATH`
  as well as the command, and reads both pipes -- so a CLI that prints its
  version on stderr is still classified correctly. The PKCE detector likewise
  scans stdout and stderr rather than assuming which stream carries the banner.

## [1.7.0] — 2026-08-07

### Added
- Runtime launcher at `bin/aws-mcp.mjs`: the published `aws-mcp` command now prefers the [oam](https://oamjs.org) runtime and falls back to Node. `AWS_MCP_RUNTIME` selects (`auto` / `oam` / `node`) and `OAM_BIN` overrides discovery. Both paths verified against the MCP surface — handshake plus all 25 tools — and behave identically. The fallback does **not** re-exec Node: npm has already started Node to run the launcher, so it is an in-process `import()` with no extra spawn.

### Changed
- `.gitignore` excludes `bin/*` rather than `bin/`, so the launcher can be re-included with a negation. A negation cannot undo a directory-level exclusion — that trap shipped a broken `bin` in postgres-mcp, where the launcher was untracked and absent from every fresh clone.
- `scripts/build-binary.mjs` pins the CLI source entry instead of deriving it from `bin`'s value, which would have resolved to `bin/aws-mcp.ts` once `bin` moved to the launcher — the breakage postgres-mcp shipped in its 0.9.0.

## [1.6.0] - 2026-08-07

Minor release. The headline is a **behavior tightening in `aws_script`**: tool
calls made from inside a script are now validated against each tool's schema,
which they previously bypassed entirely. A script that exceeded a documented
limit used to succeed silently and now throws -- see Changed below before
upgrading. Alongside that, three fixes with real blast radius: secret material
could leak back to the caller in a Cloud Control response, `~/.aws/credentials`
could gain a duplicate profile section carrying stale keys, and abandoned SSO
login sessions were never released from memory.

### Security
- `aws_resource_create` / `aws_resource_update` / `aws_resource_list`: the JSON
  payload flags `--desired-state`, `--patch-document`, and `--resource-model`
  are now redacted in the `command` string returned to the caller. Only
  `--cli-input-json` was redacted before, so the CCAPI tools -- which pass their
  payloads as dedicated flags instead -- echoed them verbatim. Creating an
  `AWS::SSM::Parameter` of type `SecureString` returned its `Value` in full to
  the model in `data.command`.

### Changed
- **`aws_script` now validates every bridged tool call against that tool's Zod
  schema.** The MCP boundary always validated incoming calls, but the script
  bridge invoked handlers directly, so any cap living only in a schema went
  unenforced for scripted calls: `aws.multiRegion({regions: [...40 regions]})`
  spawned all 40 CLI subprocesses despite `.max(32)`, and
  `aws.resource.list({maxResults: 5000})` sent `--max-results 5000` despite
  `.max(100)`. Such a script now throws
  `Invalid input for '<tool>': <field>: <reason>`. Argv-safety was never
  affected either way -- those validators run inside the handlers. This can
  break a script that relied on the gap, which is why this is a minor rather
  than a patch.
- `aws_multi_region`: rejects more than 32 regions with an explicit error rather
  than relying on the schema alone, and clamps `concurrency` into 1..32. A
  non-positive `concurrency` previously produced `ok: true` with a full-length
  array of `null` results, having run nothing at all.

### Fixed
- `~/.aws/credentials`: a profile header carrying trailing whitespace (a space
  or a tab after the closing bracket) failed to match, so `aws_assume_role`
  appended a SECOND section of the same name and left the stale credentials in
  the first one. The header parser now shares one regex with the section
  splitter instead of a hand-rolled `slice(1, -1)`.
- SSO: completed login sessions are now reaped from the in-memory session map
  after a grace window. The map was drained only by `aws_login_complete`, so a
  caller that ran `aws_login_start` and never completed it leaked the entry, its
  `ChildProcess` handle, and its captured stdout/stderr for the life of the
  server process. The TTL killswitch already killed the subprocess but never
  released the map entry -- exactly the abandoned case it exists for.
- `resolvePointer`: uses `Object.hasOwn` instead of the prototype-chain-aware
  `in`, so a JSON Pointer like `/constructor` resolves to `undefined` rather
  than an inherited value. Not reachable through `aws_resource_diff` (the
  reserved-segment guard rejects those paths first); this hardens the exported
  helper for direct callers.
- `truncateForErrorMsg`: no longer splits a UTF-16 surrogate pair at the
  truncation boundary, which emitted a lone surrogate into the MCP response.
  The constant is renamed `MAX_ERROR_MSG_CHARS` to match what it actually
  measures -- it counts code units, not bytes.
- `index.ts`: the package.json version fallback no longer uses a dynamic
  `await import("node:module")`. esbuild kept the dead branch and rewrote it to
  `null.createRequire(...)`, so it would have thrown a `TypeError` had it ever
  run in a bundled build -- which is every build we publish.

### Added
- Verified support for the [oam.js](https://oamjs.org) runtime (oam 0.8.2)
  alongside Node, from the shipped bundle and from TypeScript source with no
  build step: full handshake, all 25 tools, `aws_script`'s `node:vm` sandbox,
  identical error messages. Node stays the packaged default on measurement --
  cold start to a completed handshake was 359ms under node against 650ms under
  `oam run` (median of 10 warmed runs). See the README "Runtime" section.
- `npm run check:oam` -- type-check via `oam check` (tsgo, TypeScript 7 native),
  ~1.0s against ~3.8-4.7s for `tsc --noEmit`, same tsconfig and same file
  coverage. `npx tsc --noEmit` remains the portable default.
- `npm run build:binary:oam` -- standalone binary via `oam compile` instead of
  Node SEA: 58.60 MB against 76.28 MB, plus embedded V8 bytecode. Writes to the
  same `bin/<platform>-<arch>/` path as `build:binary`; run one or the other.
- `npm run build:binary` -- an npm alias for `scripts/build-binary.mjs`, which
  previously had none.

### Internal
- Test suite is no longer timing-flaky. Several tests asserted against fixed
  durations sized to a fake subprocess's 200ms exit, which raced the scheduler
  under `node --test`'s parallel file execution and failed roughly 2 of 3 full
  runs. Replaced with a fake that stays alive until killed, condition polling
  instead of sleeps, and generous margins on timers that must not fire. Now
  green across 8 consecutive full runs.

## [1.5.4] - 2026-07-21

Maintenance release. No source changes to the published package -- dependency
updates and CI configuration only. Entry written retroactively in 1.6.0; this
version originally shipped without one.

### Changed
- Removed the GitHub Actions workflows and Dependabot configuration (#25).
- Dependency updates: `typescript` 6.0.3 -> 7.0.2, `node-html-parser` 7.1.0 ->
  9.0.0, `@types/node` 25.6.0 -> 26.1.1, `@biomejs/biome` 2.4.12 -> 2.5.4,
  `zod` 4.3.6 -> 4.4.3, plus GitHub Action bumps (#2, #8, #9, #12-#24).

## [1.5.3] - 2026-06-17

Patch release. Fixes a bug in `scripts/update-manifests.mjs` where
`git pull --rebase` ran after writing the manifest files to disk,
causing `--push` to fail with a dirty-tree error. No change to the
published npm package.

### Fixed
- `scripts/update-manifests.mjs`: reorder `commitPush` to
  `add -> commit -> pull --rebase -> push` so the tree is clean when
  git fetches upstream changes.

## [1.5.2] - 2026-06-17

Patch release. The headline is a prototype-pollution fix in
`aws_resource_diff` -- a JSON Patch document with a `__proto__`,
`constructor`, or `prototype` segment could write onto the host process's
`Object.prototype` for the lifetime of the MCP server. Verified at
runtime against `dist/tools/resource.js` v1.5.1 and now denied at the
patch-walk boundary. Plus nine other low-risk hygiene fixes from a
full-pass audit, a CI test workflow, and dependency hardening that
closes all eleven open Dependabot alerts.

### Security
- `aws_resource_diff`: the JSON Patch simulator (`_applyJsonPatchInPlace`)
  now rejects `__proto__`, `constructor`, and `prototype` segments at
  every position in the patch walk. Existing-key checks in the descend
  use `Object.prototype.hasOwnProperty.call` instead of the prototype-
  chain-aware `in` operator. Previously, a patch like
  `{op:'add', path:'/__proto__/polluted', value:'X'}` wrote onto the
  server's host `Object.prototype` -- reachable from any model that can
  call `aws_resource_diff`.

### Fixed
- `aws_multi_region`: per-region worker now catches synchronous throws
  from `runAwsCall` (e.g. a script-shaped input missing `operation`),
  surfacing them as a per-region `errorKind: 'unexpected'` rather than
  rejecting the whole call and abandoning every other in-flight region.
- `aws_assume_role`: on STS failure, the error envelope no longer falls
  back to `result.rawStdout`. assume-role writes the credential blob to
  stdout, so a partial JSON fragment from a non-zero exit could leak
  token material into `rawBody`; stderr-only now.
- `aws_assume_role`: EACCES/EROFS/EPERM from writing
  `~/.aws/credentials` now surfaces as a friendly
  `Cannot write <path> (permission denied)...` ToolResult rather than
  the raw `.lock`-sidecar errno bubbling out.
- `aws-credentials`: `mergeProfileBody` now case-folds the parsed key
  before the managed-set check, so a hand-edited `AWS_ACCESS_KEY_ID`
  is replaced in place rather than left intact while a duplicate
  lowercase line gets appended below.
- `aws_logs_tail`: `filterPattern` now rejects a leading `-`, matching
  the uniform leading-hyphen guard the file-header comment promises
  for every free-text field.
- `aws_metrics_query`: an empty `dimensions: {}` is now treated as no
  dimensions instead of emitting `Dimensions: []`, which CloudWatch
  rejected with a ValidationError.
- `aws_docs_search`: the URL allowlist that gates `aws_docs_read` is
  now also applied to search results -- search never advertises a URL
  the read tool would refuse to fetch.
- `aws_iam_simulate`: inline-policy matches that carry
  `SourcePolicyType` but no `SourcePolicyId` now synthesize an
  `inline#L<line>` (or bare `inline`) identifier in
  `matchedStatementIds` instead of being silently dropped. Malformed
  entries (null/number SourcePolicyId) still drop -- those are
  CLI-shape errors, not inline-policy signals.

### Changed
- `aws_metrics_query`: schema descriptions for `unit` and `expression`
  now note that those fields are validated server-side by CloudWatch,
  setting expectation for a downstream `ValidationError` on a malformed
  value rather than a local rejection.

### Internal
- New CI workflow at `.github/workflows/ci.yml`: lint + test on
  push-to-main and PRs, matrix across ubuntu/windows/macos with Node
  22. Cancel-in-progress for newer-run-wins on the same branch.
- New `.gitattributes` forcing LF line endings on every checkout so
  the Windows CI runner's git autocrlf doesn't convert source files
  to CRLF and trip biome's line-ending check.
- New `CODEOWNERS` for SOC 2 compliance.
- Close 11 Dependabot alerts via patch bumps: `esbuild` ^0.28.0 ->
  ^0.28.1 (advisory in `esbuild --serve`, which the build path never
  invokes -- `build.mjs` uses esbuild's bundle API), and `overrides`
  for `hono` ^4.12.25 + `qs` ^6.15.2 (transitive via
  `@modelcontextprotocol/sdk` -> `express` + `@hono/node-server`; all
  in HTTP transports aws-mcp never loads -- it only imports
  `StdioServerTransport`).
- 23 new tests across 8 files, including 9 for the proto-pollution
  fix (all three reserved segments x final/intermediate positions x
  add/replace, each with an `Object.prototype` leakage assertion).

## [1.5.1] - 2026-06-11

Feature release. Entry written retroactively in 1.6.0; this version originally
shipped without one.

### Added
- Cross-platform single-binary distribution pipeline: Node SEA build
  (`scripts/build-binary.mjs`) plus Scoop and Homebrew manifest publishing
  (`scripts/update-manifests.mjs`).

## [1.5.0] - 2026-06-10

Minor (not patch) because the `aws_iam_simulate` summary change alters what
the stable `denied` field counts.

### Changed
- `aws_iam_simulate` summary now reports `unknown` separately:
  `{ allowed, denied, unknown, total }`. `denied` counts only real denies
  (explicitDeny + implicitDeny); the `unknown` malformed-response fallback
  (EvalDecision missing or unrecognised) is no longer silently folded into
  `denied`. The per-result `decision` values gain documented `unknown`.
- `aws_assume_role` validates `roleArn` against the IAM role ARN shape at
  both the schema and handler level, rejecting malformed or flag-shaped
  values before any CLI spawn. The `mcp-` profile prefix guard now also
  applies to the `sessionName` fallback, so `sessionName: "mcp-session"`
  yields profile `mcp-session`, not `mcp-mcp-session`.
- `aws_paginate` validates `startingToken` (opaque-token guard shared with
  the CCAPI tools) and caps `maxItems` at 10000 (schema + handler clamp).
- `aws_call` caps `--query` expressions at 2048 chars, and `runAwsCall`'s
  display command now redacts every `--cli-input-json` occurrence, not just
  the first.
- `aws_docs_read` caps `url` at 2048 chars; both docs handlers clamp
  `limit`/`maxLength`/`startIndex` defensively for non-MCP callers.
- `aws_logs_tail` log-stream validation pins that embedded spaces are
  allowed (AWS permits them; only argv-unsafe shapes are rejected).
- `aws_metrics_query` rejects extended statistics like `iqm99` -- IQM takes
  no numeric suffix and CloudWatch would bounce it server-side.
- SSO login start-failure detection moved from the child's `exit` event to
  `close`, eliminating a load-dependent race where a final stdout chunk
  (the verification-URL banner) could be processed after `exit`, spuriously
  failing an otherwise-healthy login start.
- Profile-name validation errors now describe the allowed first characters
  positively instead of listing two of many forbidden ones.
- `aws_script` now carries `destructiveHint: true` -- scripts can invoke
  resource.create/update/delete, so the annotation reflects the worst case.
  Clients that gate confirmation on annotations may now prompt for
  aws_script calls that were previously unflagged.

### Internal
- Published package now ships `dist/index.js.map`. tsconfig upgraded to
  NodeNext module resolution. Dependabot github-actions cadence weekly.
- `release.sh`: dead CI-handoff branch removed (release.yml was dropped at
  v1.3.2); version re-read at the step-3 boundary.
- fake-aws: unset `AWS_MCP_FAKE_SCENARIO` now fails loud (exit 2) instead of
  silently running the SSO happy path; happy-scenario exit delay is
  overridable via `AWS_MCP_FAKE_HAPPY_EXIT_MS` (NaN-guarded, default 200ms)
  for slow-CI widening.
- CHANGELOG backfill: v1.3.2 / v1.3.3 entries and all missing version
  compare-links; README gains a Development section on the test layout.
- Test coverage: `aws_refresh_if_expiring_soon` fresh-spawn path,
  malformed-NDJSON logs fallback end-to-end, multi-occurrence redaction,
  boundary and rejection cases for every new validation above.

## [1.4.1] - 2026-06-07

### Changed
- `aws_metrics_query` now emits a per-series `period` -- the effective
  granularity for each query (its explicit `period`, or the auto-pick it
  inherited), omitted for an expression query that didn't set one. The
  top-level `periodSeconds` remains the auto-pick. Additive field on the
  stable success envelope; documented in the README "Stability" section and
  the tool description. Before this, a caller that set an explicit per-query
  period could not tell the real granularity apart from the auto-pick.
- `aws_list_profiles` now parses `~/.aws/config` with an allowlist: only
  `[default]` and `[profile X]` sections are treated as profiles. Every
  other bracketed section (`[services ...]` endpoint blocks, `[plugins]`,
  `[preview]`, unknown keywords, and any casing variant) is ignored, matching
  `aws configure list-profiles`. Previously every bracketed section surfaced
  as a profile, so non-profile and capital-cased sections leaked as bogus
  entries. A real profile literally named `services`/`plugins` (written
  `[profile services]`) is unaffected.

### Fixed
- README: the `aws_metrics_query` Stability envelope and Tools-table summary
  now list the full emitted shape (`profile`, `region`, `nextToken`,
  `hasMore`, and per-series `period`), and the `aws_script` sandbox surface
  in the feature bullet and Tools table now lists every bound helper
  (`metricsQuery`, `iamSimulate`, `multiRegion`, `assumeRole`,
  `docs.{search,read}`). Doc-only; no behavior change.
- `extractNextToken` doc comment corrected -- it is the top-level `NextToken`
  reader shared by `aws_paginate`, `aws_resource_list`, and
  `aws_metrics_query`, not `aws_paginate`-only.

### Internal
- Added coverage for the per-series `period` (explicit, inherited, and
  expression-with-explicit-period branches), and for the profiles allowlist
  (non-profile/`services`/`plugins`/`preview` sections, casing variants,
  nameless headers, and a real profile named `services`/`plugins`). Suite at
  634/634 green.

## [1.4.0] - 2026-06-04

### Changed
- `src/index.ts` re-exports `allTools` -- the same array the MCP
  registration loop iterates. The export is documented as test-only
  (not on the MCP surface) and exists so a test can pin the tool
  count and assert every individual tool array is non-empty and
  every name is unique. No runtime behavior change for end users.

### Internal
- Extracted `toMcpResult` and `errorToMcpResult` from inline code
  in the registration loop as pure exported functions, and gated
  the stdio-server bootstrap behind an `isEntryPoint` check. The
  refactor lets `index.test.ts` import and test the per-tool
  envelope mapping without spinning up a transport.
- Added `src/index.test.ts` with a "tool registry snapshot"
  describe that pins the live tool count at 25 and asserts every
  individual tool array contributes and every tool name is
  unique. Catches forgotten exports, name collisions, and typos
  in the registration-loop spread.
- Substantive test coverage added across the registry, all green
  (628/628):
  - `aws-credentials`: 40-trial forked-child cross-process
    concurrency guard for the sidecar lock (zero profile losses
    across all trials).
  - `kill-proc`: SIGTERM->SIGKILL escalation and the
    `procHasExited` race guard.
  - `sso`: in-flight dedupe via `pendingStarts` map, TTL
    killswitch, completed-session exclusion from
    `findActiveSessionByProfile`.
  - `tools/script`: vm sandbox, console capture, realm-bridge
    Error-wrapping, `paginateAll` loop.
  - `tools/resource`: CCAPI mutation polling, `awaitCompletion`
    recovery hints, json-patch diff preview.
  - `tools/auth`: SSO cache read with multi-org startUrl filter,
    login-reuse fast paths, refresh-if-expiring-soon.
  - `tools/metrics`: query input validation, canonical statistic
    casing, auto-period picker.
  - `tools/iam-simulate`: advisory fields, filter branches for
    non-string `SourcePolicyId`.
  - `tools/logs`: NDJSON normalization, log-stream-name
    validation.
  - `tools/docs`: docs-search result parsing, paginated read.
  - `tools/call`: stdout-only diagnostic fallback when stderr is
    empty.
  - `testing/fake-aws`: 30+ new scenarios covering the above
    branches.

## [1.3.3] - 2026-06-02

### Fixed
- `release.sh` tag-drift guard now compares tag-object SHAs (via
  `git rev-parse "v${VERSION}^{}"`) instead of the annotated-tag
  object SHA, so resume runs where the tag already matches the
  bump commit no longer false-abort with a "drift" error.
- `release.sh` SKIP_LINT=1 escape hatch: wraps `npm`/`pnpm` so any
  `lint*` subcommand becomes a no-op when SKIP_LINT=1 is set.
  Workaround for the MINGW64-ARM64 case where the npm-run-script
  wrapper segfaults on exit-cleanup (see platform-windows rule);
  CI biome on the ubuntu runner remains the authoritative format
  check.
- `release.sh` tag-drift pre-push check: refuse to push if origin
  already has the tag at a different commit (rewound elsewhere,
  parallel release race), preventing a silent non-fast-forward
  after npm publish has already started.
- README: "Add to Yaw MCP" badge URL updated to the correct https
  forwarder.

### Internal
- Added test coverage for `aws_call` success/error envelope shapes
  and `rawBody` field, and for the `aws_login_start` login-reuse
  fast path.

## [1.3.2] - 2026-05-28

### Changed
- `release.sh` now publishes to the MCP Registry as release step 7
  (previously handled by `release.yml`). Auth switches from
  GitHub Actions OIDC (Actions-only) to a PAT via
  `mcp-publisher login github -token $MCP_REGISTRY_TOKEN`, so
  releases run end-to-end from the workstation.
- `release.sh` server.json sync now runs unconditionally (not only
  inside the bump else-branch) so a resume run where package.json
  was already bumped still keeps server.json in sync.
- `release.sh` confirmation prompt is now gated on `[ -t 0 ]` so
  the script runs non-interactively in piped / automated contexts
  without hanging on `read`.
- `release.sh` MCP Registry auth falls back to `gh auth token`
  when `MCP_REGISTRY_TOKEN` is unset, so the common case (active
  `gh` session with read:org scope) needs no extra env var.
- `release.yml` removed; `.github/workflows/` directory dropped.
  GitHub Actions is no longer in the release path.
- README Install section pins the `npx` spawn to `@latest` so
  MCP client configs get the auto-update path explicitly.
- `dependabot.yml` added for weekly npm and monthly
  GitHub Actions dependency updates.

## [1.3.1] - 2026-05-22

### Changed
- README's Install section now leads with the `npx -y` MCP-client-config
  pattern (the auto-update path) and demotes `npm install -g` to a "pin
  a version" alternative. Added an explicit one-paragraph note on what
  `-y` does: re-checks the registry on each MCP session spawn, fetches
  newer releases when available, costs ~100-500 ms first-launch (or
  ~50 ms warm cache), and adds zero overhead to tool calls once the
  server is up. No code change; documentation reshapes the default
  install path to match how most users were already running it.

### Internal
- Fixed two Biome-format violations in `src/tools/script.test.ts`
  introduced by the v1.3.0 bump that slipped past local lint (ARM64
  Windows `npm run lint` segfaults; CI Biome on ubuntu is the
  authoritative format check). v1.3.0's release CI failed at the
  lint gate before publishing, so v1.3.0 never landed on npm or the
  MCP Registry; v1.3.1 supersedes it and carries the same feature set.

## [1.3.0] - 2026-05-22

### Added
- `aws_script` now exposes five additional AWS tools through its JS
  sandbox: `aws.metricsQuery`, `aws.iamSimulate`, `aws.multiRegion`,
  `aws.assumeRole`, and `aws.docs.{search,read}`. Previously these were
  intentional feature gaps -- the prior release's "either add them or
  document the cut-off" note resolves as add. Auth/session/profile tools
  and `aws_script` itself remain intentionally not bound (process-wide
  state / self-recursion).

### Fixed
- `aws_metrics_query` extended statistics (`p99`, `tm95`, `tc90`, ...)
  are now lowercased before being sent to CloudWatch. The validator's
  case-insensitive regex was accepting `P99` / `Tm95` but the
  CloudWatch wire format only accepts lowercase; uppercase inputs were
  bouncing server-side with a ValidationError. `canonicalizeStatistic`
  now handles both branches (PascalCase simple stats, lowercase extended
  stats) and the trailing fall-through still passes unrecognized inputs
  through verbatim as defense-in-depth.

### Internal
- Test fixtures for the new `aws_script` bindings now mirror the real
  handlers' response shapes -- `iamSimulate` results are
  `{ action, decision, ... }` not raw CLI `{ EvalActionName, ... }`;
  `multiRegion` returns `results: RegionResult[]` not a region-keyed
  object; `assumeRole` returns `{ profile, credentialsPath, expiration,
  assumedRoleArn }` (deliberately NOT raw credentials -- secrets stay
  off the wire). No behavior change in production code.

## [1.2.2] - 2026-05-22

### Fixed
- `aws_metrics_query` now canonicalizes simple `statistic` inputs
  (`average`, `AVERAGE`, `Average`) to CloudWatch's PascalCase
  (`Average`) before sending. Previously the case-insensitive validator
  accepted lowercase input but the handler passed the raw string through
  to CloudWatch, which rejects non-PascalCase simple stats with a
  ValidationError. Extended stats (`p99`, `tm95`, ...) still pass through
  verbatim.

### Changed
- `aws_script` description now explicitly names the intentionally-NOT-bound
  tools (`aws_metrics_query`, `aws_iam_simulate`, `aws_multi_region`,
  `aws_assume_role`, `aws_docs_search`, `aws_docs_read`, plus the
  auth/session/profile tools and `aws_script` itself). Tells the model to
  call those as sibling MCP tools instead of trying them inside a script
  and hitting a ReferenceError.

### Internal
- `tools/multi-region.ts` now imports `isValidRegionName` /
  `REGION_NAME_RE` from `session.ts` instead of carrying a duplicate
  regex. No behavior change -- both patterns were identical.

## [1.2.1] - 2026-05-21

### Changed
- `aws_script` `timeoutMs` description now spells out that timeout stops
  the script from being awaited but does NOT cancel any `aws.*` call
  already in flight -- those keep running until their own per-call
  timeout (default 60s). Matters because a script that timed out mid
  `resource.delete` may have completed the delete; re-issuing the same
  script on retry can double-mutate.
- `aws_multi_region` description now notes that duplicate regions in the
  input are collapsed (first occurrence wins) so `results.length` may be
  less than `regions.length`; the returned `regionCount` is authoritative
  for the actual count run.

## [1.2.0] - 2026-05-19

### Added
- `aws_metrics_query` pagination: handler now accepts a `nextToken` input
  and surfaces `nextToken`/`hasMore` in the response when CloudWatch
  truncates a large result (previously the resume cursor was silently
  dropped; in practice rare because the auto-period picker keeps most
  queries under CloudWatch's ~100,800-datapoint cap, but a 100-query
  batch over 24h at 300s resolution can produce ~2.88M datapoints).
- `aws_metrics_query` response now echoes the effective `profile` and
  `region` it ran against (mirrors `runAwsCall`'s resolution chain:
  opts override -> session -> env -> default), so an agent fanning out
  across regions doesn't have to track them separately.
- `aws_metrics_query` `statistic` validator accepts the simple stats
  case-insensitively (`'average'` / `'AVERAGE'` / `'Average'`). Previously
  the extended-stat regex was `/i` but the simple-stat list was
  case-sensitive, so `'p99'` worked while `'average'` was rejected.

### Fixed
- `aws_metrics_query` duplicate-id error names BOTH colliding indices
  (`queries[3] duplicates queries[1]`) instead of just the id string,
  so an operator with a 50-query batch can find the offenders.
- `aws_script` tool description and file-level comment now accurately
  list what's available inside the sandbox. The previous wording claimed
  `URL`, `URLSearchParams`, `TextEncoder`, `TextDecoder`, `crypto`,
  `structuredClone`, `EventTarget`, `MessageChannel`, `performance`
  were "left available," but `vm.createContext({})` on Node 22 doesn't
  inject any of them -- a script trusting that wording would have hit
  `ReferenceError`. Empirically verified list: only `Intl`, `WebAssembly`
  (with `compile`/`instantiate` blocked), `Atomics`, `SharedArrayBuffer`
  are injected.

### Changed
- `aws_script` sandbox now shadows `BroadcastChannel` (defense-in-depth;
  no current parent-process subscriber, but the cost of shadowing is
  zero and a future parent plugin might subscribe).
- `aws-credentials.ts:upsertProfile` removes a dead `existsSync` guard
  after `renameSync` (the file always exists at that point).
- Comment-only fixes: `resource.ts` explains why JSON Patch root-add
  matches RFC 6902 replace semantics; `paginate.ts` clarifies
  `extractNextToken` only holds when `--max-items` is passed;
  `docs.ts` explains why the schema-drift warn flag is module-level
  while the session UUID is per-instance.
- `fake-aws.ts` + `metrics.test.ts` document the
  `AWS_MCP_FAKE_SCENARIO` isolation model (sequential subtests within
  a file; separate worker process per file).

## [1.1.0] - 2026-05-16

### Added
- `aws_metrics_query` -- query CloudWatch metrics via GetMetricData (the
  modern multi-metric / expression-capable API; not the legacy
  get-metric-statistics). Accepts a flat array of `{id, namespace,
  metricName, dimensions?, statistic?, period?}` or expression-based
  `{id, expression}` queries and shapes them into CloudWatch's nested
  PascalCase MetricDataQueries payload. `startTime`/`endTime` accept
  ISO 8601 or the same relative shorthand as `aws_logs_tail`'s `since`
  flag (`'15m'`, `'1h'`, `'1d'`, `'1w'`); `endTime` defaults to `'now'`.
  Period auto-picks from the time range (60s/300s/900s/3600s) to stay
  under CloudWatch's ~100,800-datapoint response cap. Returns
  `{command, startTime, endTime, periodSeconds, series, messages?}`.
  Pairs with `aws_logs_tail` for the metric side of the same
  observability question the agent gets asked all the time.

## [1.0.2] - 2026-05-16

### Fixed
- README Stability section now marks optional fields as optional in two
  places: `ssoToken.startUrl?` on `aws_whoami` / `aws_login_complete`
  (omitted when the cached token didn't record one) and `summary?` /
  `excerpt?` on `aws_docs_search` results (present only when the upstream
  backend returns them). Callers assuming these were always present would
  hit `undefined` -- the handler shapes were always correct, only the
  docs overstated guarantees.

## [1.0.1] - 2026-05-16

### Fixed
- README Stability section was missing or mis-documenting 5 tools'
  success-envelope shapes. The omissions (`aws_login_complete`,
  `aws_session_set`, `aws_session_clear`, `aws_list_profiles`) and the
  mis-document (`aws_refresh_if_expiring_soon` lumped with
  `aws_login_start` despite returning one of two distinct shapes
  discriminated by `status`) would have left callers writing against
  undocumented shapes the 1.x contract didn't actually promise. Also
  added `aws_script`, `aws_docs_search`, `aws_docs_read` shapes
  (previously missing). All shapes verified against the actual handlers.

## [1.0.0] - 2026-05-16

**API stability commitment.** From this version onward the public tool shapes
documented in the README's [Stability](./README.md#stability) section follow
strict SemVer -- breaking them requires a major bump. No user-facing breaking
changes vs 0.9.10; the 1.0 designation is the contract, not a rewrite.

### Added
- `aws_assume_role` now validates `sourceProfile` at the handler boundary with
  an error message that names `sourceProfile` explicitly (instead of bubbling
  through `runAwsCall` with a generic "Check the 'profile' arg" message).
- `CHANGELOG.md` (this file). Backfilled from v0.1.0 through v0.9.10.
- README "Stability" section spelling out the 1.x SemVer commitment:
  per-tool success-envelope shapes, error-envelope shape, `errorKind` enum,
  best-effort surfaces (error message wording, `rawBody`, `command` strings,
  tool descriptions), and the deprecate-in-minor / remove-in-major policy.

### Changed
- `aws_resource_diff` rejects `move`/`copy`/`test` patch ops at schema
  validation instead of throwing at runtime. The sibling `aws_resource_update`
  still accepts the full RFC 6902 op set (CCAPI does too); only the local
  preview tool is restricted, because only add/remove/replace are simulated.
- `release.sh` now bumps `server.json` alongside `package.json` so the
  committed value stays in sync between releases. CI's jq-rewrite safety
  net at publish time remains in place.

### Fixed
- `server.json` version field was committed as 0.9.8 while npm was at 0.9.10;
  brought back into sync.

## [0.9.10] - 2026-05-16

### Security
- Validate `profile` and `region` argv-safety at every AWS boundary. A hostile
  `AWS_PROFILE=--query=evil` (or an `opts.profile` from a model) would
  previously have flowed straight into `aws --profile X --region Y` argv. New
  `isValidProfileName` / `isValidRegionName` validators enforce 1-128 chars
  from `[A-Za-z0-9_+=,.@:-]`, no leading hyphen, no INI-breakers. Enforced
  in `setProfile`/`setRegion`, `runAwsCall`, `startSsoLogin`, and the
  `targetProfile` write path in `aws_assume_role`.

### Changed
- `acquireLock` split into explicit Phase 1 (openSync attempt) and Phase 2
  (write/close/stamp) blocks. Each catch handles exactly one failure mode
  with a comment explaining the lock-file state. Behavioral equivalent.
- `runScript` hoists `setTimeout` out of the Promise executor so `.unref()`
  no longer depends on Promise-executor synchronous-execution semantics.
  Behavioral equivalent.

## [0.9.9] - 2026-05-15

### Changed
- Tightened input validators across the tool surface.
- Cross-process credentials lock now serializes concurrent `upsertProfile`
  writes via a sidecar `.lock` file with O_EXCL + stale-recovery.
- `startSsoLogin` dedupes by `(profile, opts)` hash instead of profile alone,
  so two callers with different opts no longer collapse to one subprocess
  (a previously silent override hazard).

## [0.9.8] - 2026-05-13

### Added
- CI publishes to the Official MCP Registry on tag push via GitHub OIDC,
  alongside the existing npm publish step.

## [0.9.7] - 2026-05-11

### Changed
- Cleared `npm audit` advisories.
- Hardened the race-condition test budget so flaky timing on CI runners
  doesn't false-fail the cross-process credentials lock test.

## [0.9.6] - 2026-05-09

### Changed
- README surfaces the `aws_assume_role timeoutMs` option (default 120s for
  slow SAML / `credential_process` cold starts).

## [0.9.5] - 2026-05-07

### Added
- Full coverage sweep across `src/`: handler-level tests, error-classifier
  edge cases, validator regression cases.

## [0.9.4] - 2026-05-05

### Fixed
- Tightened `NO_CREDS_RE` to anchor on canonical botocore error strings so
  unrelated stderr text can no longer false-classify as "no credentials."

## [0.9.3] - 2026-05-03

### Fixed
- Cross-realm `Error` instances thrown from the `aws_script` bridge now
  satisfy `e instanceof Error` inside the sandbox (was failing because the
  host `Error.prototype` is not on the sandbox realm's chain).
- `aws_resource_diff` performance: in-place patch replay where safe.
- `aws_assume_role` cold-start timeout raised from 60s default to 120s for
  SAML / `credential_process` setups.

## [0.9.2] - 2026-05-01

### Fixed
- `aws_script` sandbox isolation: realm-fresh intrinsics, explicit shadows
  for host globals (Buffer, process, require, timers, fetch).
- `aws_resource_diff` semantics: `add /Tags/-` auto-creates missing parent
  objects to match CCAPI's actual update behavior.
- AWS CLI credential chain: removed an in-process SDK call site that
  diverged from the CLI's resolution (broke `credential_process` profiles).

### Changed
- README accuracy pass: SSO code wording, AWS_REGION scope clarification,
  `aws_script` globals list.

### Added
- "Add to mcp.hosting" install button in the README.

## [0.9.1] - 2026-04-29

### Fixed
- `aws_docs_read` caching, content-type guard, timeout error message,
  empty-anchor handling.

## [0.9.0] - 2026-04-27

### Added
- `aws_docs_search` -- query the live AWS docs search backend.
- `aws_docs_read` -- fetch an `https://docs.aws.amazon.com/...html` page and
  return it as paginated markdown.

### Changed
- README repositioned to honestly compare with AWS's official MCP server
  rather than implying it's a complement.

## [0.8.0] - 2026-04-24

### Added
- `aws_iam_simulate` -- wraps `iam simulate-principal-policy` to pre-flight
  whether a principal can perform actions on resources. Pairs with the
  post-failure Suggestion surfaced by `aws_call`.

## [0.7.1] - 2026-04-22

### Fixed
- `aws_resource_diff` now surfaces the added value for `/-` array-append
  paths in the `changes[]` summary.

### Added
- `deprecate.yml` CI workflow: CI-driven `npm deprecate` via `NPM_TOKEN`.

## [0.7.0] - 2026-04-20

### Added
- `aws_script` -- run a JS snippet in a `node:vm` sandbox with `aws.call`,
  `aws.paginate`, `aws.paginateAll`, `aws.resource.*`, `aws.logsTail`.
- `aws_multi_region` -- run the same AWS operation across N regions in
  parallel; returns `{region, ok, data?, error?}[]` with `okCount`/`errorCount`.
- `aws_resource_diff` -- dry-run a CCAPI update, returns `{before, after,
  changes[]}` with no mutation sent.
- Structured error classification (`AwsCallFailureKind`) surfaced on every
  `aws_call` failure: `sso_expired` / `no_creds` / `bad_input` / `timeout` /
  `output_too_large` / `spawn_failure` / `nonzero_exit`.

## [0.6.0] - 2026-04-15

### Added
- CI release workflow on `v*` tag push (`.github/workflows/release.yml`).
  Replaces the manual local-publish flow.

## [0.5.0] - 2026-04-12

### Added
- `awaitCompletion: true` on CCAPI mutation tools polls `get-resource-request
  -status` to terminal state in one tool call.
- Flat-promoted ProgressEvent fields (`requestToken`, `operationStatus`,
  `identifier`, `errorCode`, `statusMessage`, `retryAfter`) on every CCAPI
  response.

### Changed
- SSO TTL killswitch + URL-wait timeout races closed; `aws_whoami` failure
  hints aligned with `aws_call` for consistent recovery messaging.

## [0.4.0] - 2026-04-10

### Fixed
- `aws_paginate` no longer drops `NextToken` when `query` is provided.
- SSO `startSsoLogin` race (two callers spawning duplicate `aws sso login`
  subprocesses for the same profile).
- TTL killswitch leak when a session is consumed by `waitForLogin` before
  the timer fires.

## [0.3.0] - 2026-04-07

### Added
- `aws_resource_*` tools (Cloud Control API): generic get/list/create/update/
  delete/status across hundreds of resource types.
- Live CCAPI integration test.

### Changed
- README repositioned around the CCAPI surface.
- Removed GitHub Actions; publish via `release.sh` locally (later re-added
  in 0.6.0 as a tag-push workflow).

### Fixed
- SSO log dedupe; profile-matched token lookup; logs output normalization.

## [0.2.1] - 2026-04-05

### Added
- README example session showing concrete SSO + `aws_call` + `aws_paginate`
  flow.

## [0.2.0] - 2026-04-03

### Added
- `aws_logs_tail` -- CloudWatch Logs retrieval via `aws logs tail`.
- `aws_assume_role` -- STS AssumeRole, writes temp creds to a `mcp-<sessionName>`
  profile in `~/.aws/credentials`.
- `aws_refresh_if_expiring_soon` -- proactive SSO token refresh when below
  threshold.
- `aws_paginate` -- one-page-at-a-time reads for list/describe operations.
- `aws_list_profiles` -- enumerate `~/.aws/config` profiles.
- `aws_session_clear` -- remove session profile/region overrides.
- `--query` (JMESPath) support on `aws_call` / `aws_paginate`.

### Fixed
- SSO session map leak.
- Bound on SSO cache file size to prevent giant-file event-loop blocks.

### Changed
- Subprocess hardening: UTF-8 stream decoding, SIGKILL escalation,
  `--cli-input-json` param redaction in display output, stderr byte cap.

## [0.1.0] - 2026-04-01

### Added
- Initial scaffold: `aws_whoami`, `aws_login_start`, `aws_login_complete`,
  `aws_call`, `aws_session_set`, `aws_session_get`. SSO device-code flow
  via `aws sso login --no-browser`.

[Unreleased]: https://github.com/YawLabs/aws-mcp/compare/v2.3.4...HEAD
[2.3.4]: https://github.com/YawLabs/aws-mcp/compare/v2.3.3...v2.3.4
[2.3.3]: https://github.com/YawLabs/aws-mcp/compare/v2.3.2...v2.3.3
[2.3.2]: https://github.com/YawLabs/aws-mcp/compare/v2.3.1...v2.3.2
[2.3.1]: https://github.com/YawLabs/aws-mcp/compare/v2.3.0...v2.3.1
[2.3.0]: https://github.com/YawLabs/aws-mcp/compare/v2.2.7...v2.3.0
[2.2.7]: https://github.com/YawLabs/aws-mcp/compare/v2.2.6...v2.2.7
[2.2.6]: https://github.com/YawLabs/aws-mcp/compare/v2.2.5...v2.2.6
[2.2.5]: https://github.com/YawLabs/aws-mcp/compare/v2.2.4...v2.2.5
[2.2.4]: https://github.com/YawLabs/aws-mcp/compare/v2.2.3...v2.2.4
[2.2.3]: https://github.com/YawLabs/aws-mcp/compare/v2.2.2...v2.2.3
[2.2.2]: https://github.com/YawLabs/aws-mcp/compare/v2.2.1...v2.2.2
[2.2.1]: https://github.com/YawLabs/aws-mcp/compare/v2.2.0...v2.2.1
[2.2.0]: https://github.com/YawLabs/aws-mcp/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/YawLabs/aws-mcp/compare/v2.0.1...v2.1.0
[2.0.1]: https://github.com/YawLabs/aws-mcp/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/YawLabs/aws-mcp/compare/v1.8.2...v2.0.0
[1.8.2]: https://github.com/YawLabs/aws-mcp/compare/v1.8.1...v1.8.2
[1.8.1]: https://github.com/YawLabs/aws-mcp/compare/v1.8.0...v1.8.1
[1.5.3]: https://github.com/YawLabs/aws-mcp/compare/v1.5.2...v1.5.3
[1.5.2]: https://github.com/YawLabs/aws-mcp/compare/v1.5.1...v1.5.2
[1.5.1]: https://github.com/YawLabs/aws-mcp/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/YawLabs/aws-mcp/compare/v1.4.1...v1.5.0
[1.4.1]: https://github.com/YawLabs/aws-mcp/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/YawLabs/aws-mcp/compare/v1.3.3...v1.4.0
[1.3.3]: https://github.com/YawLabs/aws-mcp/compare/v1.3.2...v1.3.3
[1.3.2]: https://github.com/YawLabs/aws-mcp/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/YawLabs/aws-mcp/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/YawLabs/aws-mcp/compare/v1.2.2...v1.3.0
[1.2.2]: https://github.com/YawLabs/aws-mcp/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/YawLabs/aws-mcp/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/YawLabs/aws-mcp/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/YawLabs/aws-mcp/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/YawLabs/aws-mcp/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/YawLabs/aws-mcp/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/YawLabs/aws-mcp/compare/v0.9.10...v1.0.0
[0.9.10]: https://github.com/YawLabs/aws-mcp/compare/v0.9.9...v0.9.10
[0.9.9]: https://github.com/YawLabs/aws-mcp/compare/v0.9.8...v0.9.9
[0.9.8]: https://github.com/YawLabs/aws-mcp/compare/v0.9.7...v0.9.8
[0.9.7]: https://github.com/YawLabs/aws-mcp/compare/v0.9.6...v0.9.7
[0.9.6]: https://github.com/YawLabs/aws-mcp/compare/v0.9.5...v0.9.6
[0.9.5]: https://github.com/YawLabs/aws-mcp/compare/v0.9.4...v0.9.5
[0.9.4]: https://github.com/YawLabs/aws-mcp/compare/v0.9.3...v0.9.4
[0.9.3]: https://github.com/YawLabs/aws-mcp/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/YawLabs/aws-mcp/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/YawLabs/aws-mcp/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/YawLabs/aws-mcp/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/YawLabs/aws-mcp/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/YawLabs/aws-mcp/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/YawLabs/aws-mcp/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/YawLabs/aws-mcp/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/YawLabs/aws-mcp/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/YawLabs/aws-mcp/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/YawLabs/aws-mcp/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/YawLabs/aws-mcp/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/YawLabs/aws-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/YawLabs/aws-mcp/releases/tag/v0.1.0
