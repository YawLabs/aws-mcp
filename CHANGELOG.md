# Changelog

All notable changes to `@yawlabs/aws-mcp` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The 0.x line is the pre-stability tightening phase -- breaking changes are
called out explicitly in the entries below but are not necessarily gated on a
major-version bump. From 1.0 onward the public tool shapes (see the README
"Stability" section) follow strict SemVer.

## [Unreleased]

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

[Unreleased]: https://github.com/YawLabs/aws-mcp/compare/v1.2.0...HEAD
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
