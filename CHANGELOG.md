# Changelog

All notable changes to `@yawlabs/aws-mcp` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The 0.x line is the pre-stability tightening phase -- breaking changes are
called out explicitly in the entries below but are not necessarily gated on a
major-version bump. From 1.0 onward the public tool shapes (see the README
"Stability" section) follow strict SemVer.

## [Unreleased]

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

[Unreleased]: https://github.com/YawLabs/aws-mcp/compare/v0.9.10...HEAD
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
