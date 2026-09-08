# @yawlabs/aws-mcp

A small AWS MCP for AI assistants: **one server, one config entry, SSO re-auth baked in, generic CRUD over hundreds of resource types, live docs lookup, server-side scripting for batched workflows.**

It's an **alternative to AWS's official MCP server**, not a complement -- both call any AWS API, so running both just gives the model two redundant tools. Pick one. The honest comparison:

- **[AWS MCP Server](https://aws.amazon.com/blogs/aws/the-aws-mcp-server-is-now-generally-available/)** -- AWS's hosted server (`uvx mcp-proxy-for-aws`), GA since May 2026. Strong on AWS-team-curated skills, a server-side Python sandbox (`run_script`), days-fresh API coverage, per-tool CloudWatch metrics, and semantic Agent-SOP discovery. Since June 2026 it also takes a profile per request for cross-account / cross-role work in one session (that feature launched in `us-east-1` and `eu-central-1` only). Requires Python + `uv`, routes through a proxy that bridges IAM SigV4 to OAuth, and assumes your local credentials already work.
- **`@yawlabs/aws-mcp`** (this server) -- Node/npm-only, runs locally. Wins on SSO re-login when `aws sso login`'s browser handoff drops (Windows especially), ergonomic CCAPI CRUD with dry-run diffs, multi-region fan-out, pre-flight IAM permission checks, and a JS scripting tool for batching (in-process, not a security sandbox -- see the tools table). Live AWS docs search + read is built in too -- parity with the official server's `search_documentation` / `read_documentation`, no second server needed either way.

The one MCP that genuinely pairs with *either* choice is **[`awslabs/mcp`](https://github.com/awslabs/mcp)** -- AWS Labs' fleet of typed per-service servers (Lambda invoke, Bedrock retrieval, DynamoDB with type-marshalling). Those are per-service helpers, no overlap with a general AWS-API server.

Five things this server tries to handle well:

1. **SSO re-login.** When your token expires mid-session, `aws sso login` tries to open a browser from a subprocess -- on Windows (and sometimes elsewhere) that handoff drops silently. You end up context-switching to a terminal, running the command yourself, then coming back. The `--no-browser` device-code flow fixes this: the assistant surfaces a short URL + code, you click once, done. (`--no-browser` on its own is no longer enough -- AWS CLI 2.22.0 made the PKCE authorization-code flow the default, and it prints no short code -- so this server pairs it with `--use-device-code`, probing `aws --version` once to stay compatible with pre-2.22 CLIs.) There's also `aws_refresh_if_expiring_soon` for proactive top-ups before a long workflow. AWS's hosted server bridges IAM-to-OAuth via a local proxy; it doesn't help with the `aws sso login` browser-handoff failure.
2. **Calling any AWS API.** `aws_call` proxies the `aws` CLI directly. One tool covers the full API surface -- including services AWS adds tomorrow -- with no SDK bundling and no service-by-service tool sprawl. That is not aspirational: August 2026's arrivals (Lambda MicroVMs, Resilience Hub V2, ACM public ACME issuance, Agent Registry, Support AuthZ, EC2 account-level VPC encryption controls, the IPAM build-out) are reachable the moment your local `aws` CLI knows them -- no `@yawlabs/aws-mcp` upgrade required. `aws_paginate` handles paginated list/describe ops, `aws_multi_region` fans the same op out across N regions in parallel, and a JMESPath `query` parameter trims responses server-side (useful when a `describe-instances` result would otherwise blow past the 5 MB output cap).
3. **Generic CRUD across services.** `aws_resource_*` (seven tools, including `aws_resource_diff` for dry-run previews) wraps AWS Cloud Control API, so the same lifecycle -- get / list / create / update / delete / status -- works for any control-plane resource with a CloudFormation schema: Lambda functions, S3 buckets, IAM roles, SSM parameters, RDS instances, and a few hundred more. Pass `awaitCompletion: true` and the server polls the async create/update/delete through to terminal state for you. CCAPI is control-plane only -- for data-plane ops (S3 reads, Lambda invokes, Bedrock inference, DynamoDB GetItem) drop down to `aws_call` or use a typed AWS Labs server.
4. **Live AWS docs.** `aws_docs_search` queries the same backend that powers the docs.aws.amazon.com search box; `aws_docs_read` fetches a doc page and returns it as paginated markdown. Lets the agent discover new services and look up exact parameter names without a second MCP server installed.
5. **Batched workflows in one round-trip.** `aws_script` runs a short JS snippet in a `node:vm` context with `aws.call`, `aws.paginate`, `aws.paginateAll`, `aws.resource.*`, `aws.logsTail`, `aws.metricsQuery`, `aws.iamSimulate`, `aws.multiRegion`, `aws.assumeRole`, and `aws.docs.{search,read}` available. Best for "list X, fetch Y for each, return Z" pipelines that would otherwise need N tool calls. Same shape as AWS's `run_script` (Python, sandboxed server-side) -- yours is JS-native and runs locally.

[![Add to Yaw MCP](https://yaw.sh/yaw-mcp-button.svg)](https://yaw.sh/mcp/install?name=AWS&command=npx&args=-y%2C%40yawlabs%2Faws-mcp&env=AWS_PROFILE%2CAWS_REGION&description=Call%20any%20AWS%20API%20from%20one%20server%20-%20CCAPI%20CRUD%2C%20multi-region%2C%20SSO%20re-login&source=https%3A%2F%2Fgithub.com%2FYawLabs%2Faws-mcp)

One click adds this to your local Yaw MCP config so it's available in every Yaw Terminal session. Or install manually below.

## Optional companion: AWS Labs per-service servers

For deep work in a single service -- typed `lambda_invoke`, Bedrock KB retrieval, DynamoDB with type-marshalling -- add the relevant [`awslabs/mcp`](https://github.com/awslabs/mcp) server alongside this one. Those are per-service helpers with no tool-name overlap, so they pair cleanly:

```json
{
  "mcpServers": {
    "aws": {
      "command": "npx",
      "args": ["-y", "@yawlabs/aws-mcp@latest"]
    },
    "aws-lambda": {
      "command": "uvx",
      "args": ["awslabs.lambda-mcp-server@latest"]
    }
  }
}
```

## When to reach for this vs the other AWS MCPs

| Need | Best fit |
|------|----------|
| One config entry covering most of AWS | **`@yawlabs/aws-mcp`** |
| SSO re-login on Windows / broken browser handoff | **`@yawlabs/aws-mcp`** (`aws_login_start` device-code flow) |
| Generic CRUD across hundreds of resource types | **`@yawlabs/aws-mcp`** (`aws_resource_*`) |
| Dry-run an update before applying it | **`@yawlabs/aws-mcp`** (`aws_resource_diff`) |
| Multi-region fan-out in one call | **`@yawlabs/aws-mcp`** (`aws_multi_region`) |
| Batch N tool calls into one round-trip (JS) | **`@yawlabs/aws-mcp`** (`aws_script`) |
| Check IAM permissions before attempting an op | **`@yawlabs/aws-mcp`** (`aws_iam_simulate`) |
| Node/npm-only install (no Python) | **`@yawlabs/aws-mcp`** |
| Cross-account / cross-role in one session | **Either** -- both take a `profile` per call; this server adds `aws_assume_role` for STS role-chaining |
| Sandboxed Python script execution server-side | **AWS MCP Server** (`run_script`) |
| AWS-team-curated best-practice skills | **AWS MCP Server** (skills) |
| Days-fresh API coverage via hosted endpoint | **AWS MCP Server** (`call_aws`) |
| Typed per-service helpers (Lambda invoke, Bedrock KB, DynamoDB type-marshalling, ...) | **`awslabs/mcp`** (per-service servers) |

`@yawlabs/aws-mcp` and AWS's official server are an either/or -- pick the one whose tradeoffs fit. `awslabs/mcp` per-service servers pair cleanly with whichever you pick.

## What this server borrows from AWS's official one

Credit where due -- two features here were shaped by the official AWS MCP Server:

- **`aws_script`** mirrors the official server's `run_script`: a sandboxed scripting tool that collapses "list X, fetch Y for each, return Z" pipelines into one round-trip. Theirs is Python, sandboxed server-side; this one is JS-native and runs **in this server's own process** -- see the trust note in the tools table.
- **`aws_docs_search` / `aws_docs_read`** were added to match the official server's `search_documentation` / `read_documentation`, so you don't need a separate docs MCP regardless of which server you pick.

The rest -- SSO device-code re-login, CCAPI CRUD with dry-run diffs, multi-region fan-out, IAM pre-flight checks -- is this server's own.

## Tools

| Tool | What it does |
|------|--------------|
| `aws_whoami` | Current identity (account, ARN) + SSO token expiry countdown. Call this first. |
| `aws_login_start` | Start `aws sso login --no-browser --use-device-code`, returns a verification URL + short code and a `sessionId`. (`--use-device-code` is omitted on AWS CLI older than 2.22.0, where the device grant is already the default.) |
| `aws_login_complete` | Block until the SSO subprocess finishes (you auth in your browser), returns the new identity. |
| `aws_refresh_if_expiring_soon` | Check the cached SSO token and auto-start a refresh when < `thresholdMinutes` remain (default 10). One round-trip for "am I about to expire? if so, re-login." |
| `aws_session_set` | Set the default profile and/or region for the rest of this MCP session. "Switch to prod," "use us-west-2." |
| `aws_session_get` | Show the current session defaults and where each value came from (`session`/`env`/`default`). |
| `aws_session_clear` | Remove session profile/region overrides so env vars / defaults take over again. No args clears both. |
| `aws_list_profiles` | List profiles configured in `~/.aws/config` -- names, regions, and SSO metadata. Use before switching profiles or when an SSO error names one you haven't seen. |
| `aws_assume_role` | Call STS AssumeRole with your current identity and stash the temp creds as a new profile (`mcp-<sessionName>`) in `~/.aws/credentials`. Use for cross-account access. The secret/session token stay on disk -- not returned to the model. Optional `timeoutMs` (default 120s) for slow SAML / `credential_process` cold starts. |
| `aws_call` | Run any AWS API operation. `service: 's3api', operation: 'list-buckets'`, optional `params` (PascalCase JSON), optional `query` (JMESPath). Returns parsed JSON. |
| `aws_paginate` | Fetch one page of a paginated list/describe operation. Supports `query` too. Returns `nextToken`/`hasMore`; call again with the token to continue. |
| `aws_logs_tail` | Fetch recent CloudWatch Logs events for a log group. Wraps `aws logs tail --format json` with `since`, `filterPattern`, and stream-name filters; returns events as a parsed array, oldest first. Bounded by `maxEvents` (default 500, max 10000): a busier window keeps the NEWEST events and reports `truncated: true` plus the full `totalEvents`. |
| `aws_logs_query` | Run a CloudWatch Logs Insights query end to end: StartQuery, poll GetQueryResults to a terminal status, return the rows -- one call instead of the start/poll/interpret-status dance. Takes `logGroupNames` (1-50, bare names or ARNs), `queryString` (Logs Insights QL, or PPL via `queryLanguage`), and the same `startTime`/`endTime` vocabulary as `aws_metrics_query`; window capped at 90 days, `limit` defaults to 1000. Rows come back FLATTENED from the API's `[{field, value}]` pairs into plain objects, alongside `statistics` (`recordsMatched`/`recordsScanned`/`bytesScanned`). Billed by uncompressed bytes scanned, so narrow the window before widening it. On timeout or client cancellation the query is never stopped -- the `queryId` comes back and results stay retrievable for 7 days. |
| `aws_metrics_query` | Query CloudWatch metrics via GetMetricData (the modern multi-metric / expression-capable API). Pass `queries: [{id, namespace, metricName, dimensions?, statistic?, period?}]` or expression-based queries; `startTime`/`endTime` accept ISO 8601 or relative shorthand (`'15m'`, `'1h'`, `'1d'`). Period auto-picks from the time range. Returns `{series: [{id, label?, timestamps, values, period?, statusCode?}], periodSeconds, profile, region, nextToken, hasMore, messages?}` (full envelope under Stability). |
| `aws_resource_get` | Read an AWS resource via Cloud Control API by `typeName` + `identifier` (e.g. `AWS::Lambda::Function` + function name). Returns parsed Properties. |
| `aws_resource_list` | List resources of a type via CCAPI, paginated. Returns `{identifier, properties}` per entry plus a `nextToken`/`hasMore`. |
| `aws_resource_create` | Create an AWS resource via CCAPI. Async — returns top-level `requestToken` + `operationStatus`. Pass `awaitCompletion: true` to have the server poll to terminal state in one call. |
| `aws_resource_update` | Update an AWS resource via CCAPI using RFC 6902 JSON Patch. Same async + `awaitCompletion` shape as create. |
| `aws_resource_delete` | Delete an AWS resource via CCAPI. Same async + `awaitCompletion` shape as create. Destructive — verify `identifier` first. |
| `aws_resource_status` | Poll an async CCAPI request by `requestToken`. Returns the current state with `operationStatus`, `identifier`, `errorCode`, `statusMessage` flat-promoted (PENDING / IN_PROGRESS / SUCCESS / FAILED / CANCEL_*). |
| `aws_resource_diff` | Dry-run a CCAPI update: fetches current state, simulates the JSON Patch in memory, returns `{before, after, changes[]}`. No mutation sent to AWS. Supports the add/remove/replace subset of RFC 6902; `add` auto-creates missing object parents to match CCAPI's actual update semantics (so patches like `/Environment/Variables/NEW_KEY` work even when `/Environment/Variables` doesn't exist yet). `changes[i].after` reflects what op `i` produced (not the final post-patch state), so sequential ops on the same path read correctly. Call before `aws_resource_update` when you want to verify the patch does what you expect. |
| `aws_multi_region` | Run the same AWS operation across N regions in parallel. Same shape as `aws_call` but takes `regions: string[]`. Returns `{region, ok, data?, error?}[]` with `okCount`/`errorCount`. Partial failure is expected (services aren't everywhere, perms may be region-scoped). |
| `aws_script` | Run a short JS snippet that orchestrates the other tools and returns a combined result. Sandbox exposes `aws.call`, `aws.paginate`, `aws.paginateAll`, `aws.resource.{get,list,create,update,delete,status}`, `aws.logsTail`, `aws.metricsQuery`, `aws.iamSimulate`, `aws.multiRegion`, `aws.assumeRole`, `aws.docs.{search,read}`, plus standard JS builtins (`JSON`, `Math`, `Date`, `Promise`, etc.) and `console`. `require`/`import`/`process`/`fs`/`fetch`/timers are not bound into the context. **This is not a security boundary:** the script runs in this server's own process, and host globals remain reachable from inside it, so `aws_script` is strictly more powerful than the other tools -- those are bounded by AWS and your IAM policy, this one is not. Only pass script text you would run on this machine yourself, never text that arrived from a log line, a resource tag, or any other AWS response. Best for "list X, fetch Y for each, return Z" pipelines that would otherwise be N round-trips. Use `return <value>` to surface a result. |
| `aws_iam_simulate` | Simulate IAM permissions for a principal: can principal X do actions Y on resources Z? Wraps `iam simulate-principal-policy`. Returns one entry per (action, resource) pair with `decision` (allowed / explicitDeny / implicitDeny), `matchedStatementIds` (which IAM statements decided), and `missingContextValues` (context keys the policy needed but you didn't provide). Use BEFORE a risky operation to avoid a 403 -- pairs with the post-failure Suggestion from aws_call. Requires `iam:SimulatePrincipalPolicy` on the caller. |
| `aws_docs_search` | Search live AWS documentation (the backend behind the docs.aws.amazon.com search box). Returns ranked `{title, url, summary, excerpt}`. Use to discover the right doc page for a service/API/concept the model may not know -- new services, recently changed APIs, exact parameter names. |
| `aws_docs_read` | Fetch an `https://docs.aws.amazon.com/...html` page and return it as markdown. Strips nav/cookie-banner/feedback chrome. Long pages paginate via `startIndex` + `maxLength`; the response carries `hasMore` and `nextStartIndex`. Usually fed a url from `aws_docs_search`. |

## Install

Add to your MCP client config (e.g. `.mcp.json`):

```json
{
  "mcpServers": {
    "aws": {
      "command": "npx",
      "args": ["-y", "@yawlabs/aws-mcp@latest"]
    }
  }
}
```

The `-y` flag is what gives you **auto-update on each session load**: every time your MCP client spawns the server, `npx` checks the registry for the latest `@yawlabs/aws-mcp` and downloads it if newer. The first launch in a fresh cache adds ~100-500 ms; subsequent launches use npm's cache (typical metadata-freshness window: 5 min) and add ~50 ms or less. Once the server is up, tool calls have zero auto-update overhead -- the check fires only on (re-)spawn. No separate install step is needed; `-y` covers both first-time install and ongoing updates.

If you'd rather pin a specific version (no auto-update, but zero startup overhead), install globally and point the config at the installed binary:

```bash
npm install -g @yawlabs/aws-mcp
```

```json
{
  "mcpServers": {
    "aws": {
      "command": "aws-mcp"
    }
  }
}
```

You'll need to `npm install -g @yawlabs/aws-mcp@latest` manually when you want a newer version.

## Example session

You ask the assistant to check a staging bucket, but your SSO token just expired. What the assistant does (and what you see):

```
You:    "How many objects are in the staging-artifacts bucket right now?"

Claude: (calls aws_whoami) -> SSO session expired for profile 'staging'.
        (calls aws_login_start with profile='staging')
        "Your SSO token expired. Open
         https://device.sso.us-east-1.amazonaws.com/
         and enter code: ABCD-EFGH
         I'll wait."

You:    *click, authenticate in your browser*

Claude: (calls aws_login_complete with the sessionId)
        (calls aws_call with service='s3api', operation='list-objects-v2',
                         params={ Bucket: 'staging-artifacts' },
                         query='KeyCount')
        "There are 4,182 objects in staging-artifacts."
```

The SSO flow took one click. No "the browser didn't open, let me run it in a terminal" context switch.

For a larger list where the response might exceed the 5 MB output cap, the assistant reaches for `aws_paginate`:

```
(calls aws_paginate with service='ec2', operation='describe-instances',
                        maxItems=50,
                        query='Reservations[].Instances[].{Id:InstanceId,State:State.Name}')
-> returns one page + a nextToken; Claude calls again until hasMore=false
```

`query` (JMESPath) trims the response server-side -- a typical `describe-instances` result shrinks from megabytes to kilobytes when you only need two fields.

For "create this resource and tell me when it's ready," `aws_resource_create` with `awaitCompletion: true` collapses the usual create-then-poll loop into one tool call:

```
(calls aws_resource_create with
   typeName='AWS::SSM::Parameter',
   desiredState={Name: '/my/param', Type: 'String', Value: 'hello'},
   awaitCompletion: true)
-> server polls get-resource-request-status until SUCCESS / FAILED / CANCEL_COMPLETE
   and returns the terminal ProgressEvent in one call
```

Same shape for `aws_resource_update` and `aws_resource_delete`. Drop `awaitCompletion` (or set it false) for the default fire-and-poll behavior -- useful when you want to kick off a long-running update and check back later.

For "preview the patch before applying":

```
(calls aws_resource_diff with
   typeName='AWS::Lambda::Function',
   identifier='my-fn',
   patchDocument=[{op: 'replace', path: '/MemorySize', value: 1024}])
-> returns { before: {MemorySize: 256, ...}, after: {MemorySize: 1024, ...},
              changes: [{op: 'replace', path: '/MemorySize', before: 256, after: 1024}] }
```

No mutation is sent to AWS; the agent can verify the patch before invoking `aws_resource_update`.

For batched workflows, `aws_script` collapses N tool calls into one:

```
(calls aws_script with code=`
   const listed = await aws.resource.list({ typeName: "AWS::Lambda::Function" });
   const big = [];
   for (const r of listed.resources) {
     const cfg = await aws.resource.get({
       typeName: "AWS::Lambda::Function", identifier: r.identifier });
     if (cfg.properties.MemorySize > 1024) {
       big.push({ name: cfg.properties.FunctionName, mem: cfg.properties.MemorySize });
     }
   }
   return big;
`)
-> one round-trip; the agent gets the filtered list without N intermediate tool calls
```

For multi-region reads:

```
(calls aws_multi_region with
   service='ec2', operation='describe-instances',
   regions=['us-east-1','us-west-2','eu-west-1'],
   query='Reservations[].Instances[].InstanceId')
-> {okCount: 3, errorCount: 0, results: [{region, ok, data}, ...]}
```

## Requirements

- Node.js 22+ (or [oam.js](https://oamjs.org) -- see [Runtime](#runtime))
- AWS CLI v2 installed and on `PATH` (for `aws sso login`). 2.22.0+ recommended: that release added `--use-device-code`, which this server needs to keep the SSO short-code flow working. Older 2.x still works -- the server detects the version and adapts. AWS CLI **v1 is unsupported**; it entered maintenance mode on 2026-07-15 and reaches end of support on 2027-07-15.
- An AWS profile configured for SSO / IAM Identity Center in `~/.aws/config`

## Runtime

This server runs on [oam.js](https://oamjs.org) and on Node, unmodified. Verified
against oam 0.9.0 and Node 22: full MCP handshake, all 26 tools, `aws_script`'s
`node:vm` sandbox, and byte-identical error messages -- from the shipped bundle
*and* straight from the TypeScript source with no build step.

**oam 0.9.0 is the minimum.** Older releases ran `child_process.execFile`
arguments through a shell, accepted `exec`'s `timeout` and ignored it, and
treated `stdio: 'inherit'` as `'pipe'`. This server shells out to the `aws` CLI
on essentially every tool, so those were reachable bugs rather than theoretical
ones. The launcher enforces the floor: given an older oam it falls back to Node
and says so on stderr, and `AWS_MCP_RUNTIME=oam` turns that into a hard error.

To run it under oam, point your MCP client's `command` at it:

```jsonc
{
  "mcpServers": {
    "aws": {
      "command": "oam",
      "args": ["run", "/path/to/aws-mcp/dist/index.js"],
      "env": { "AWS_PROFILE": "my-sso-profile", "AWS_REGION": "us-west-2" }
    }
  }
}
```

**Node remains the packaged default, and that is a measurement, not a
preference.** An MCP client cold-starts this server once per session, so startup
is the cost that actually gets paid. On the machine this was measured on, to a
completed `initialize` + `tools/list` handshake, median of 10 warmed runs:

| Runtime | Cold start |
|---------|-----------|
| `node dist/index.js` | **359 ms** |
| `oam run dist/index.js` | 650 ms |
| `oam run src/index.ts` (no build step) | 947 ms |

Preferring oam automatically would mean either probing for it on every start --
a cost paid by everyone, including the majority who don't have it -- or making
oam a hard requirement, which breaks the npm package for those users. Neither is
worth it to reach a runtime that is not faster here. Measure on your own
hardware before concluding anything; if oam wins on yours, the config above is
all you need, and the `bin` shim keeps working under Node regardless.

Two places oam *does* win for this repo, both opt-in and neither touching the
published npm package:

- **`npm run check:oam`** -- type-checks via `oam check` (tsgo, TypeScript 7
  native). Measured **~1.0s against ~3.8-4.7s** for `tsc --noEmit`, resolving the
  same `tsconfig.json` and covering the same files -- including tests, confirmed
  by planting a type error in a test file and watching both reject it.
  `npx tsc --noEmit` remains the portable default.
- **`npm run build:binary:oam`** -- builds the standalone binary via
  `oam compile` instead of Node SEA. Measured **58.60 MB against 76.28 MB**, plus
  ~493 KB of embedded V8 bytecode the SEA path doesn't produce. Writes to the
  same `bin/<platform>-<arch>/` path as `npm run build:binary`, so the release
  staging script consumes either unchanged -- run one or the other, not both. If
  you redistribute that binary it embeds oam's runtime, so ship oam's `LICENSE`,
  `NOTICE` and `THIRD_PARTY_LICENSES.md` with it.

The source stays runtime-agnostic on purpose: no `oam:` imports anywhere, and
tests stay on `node:test`. That is what keeps the Node fallback real rather than
nominal.

One behavioral difference worth knowing if you run `aws_script` under oam: Node
honors `codeGeneration: { strings: false }` on the `node:vm` context, so `eval`
and `Function` throw; oam does not, so they work. Re-measured against oam 0.9.0
and still divergent, so treat it as a standing difference. The containment that
matters is unaffected -- under oam, `Function('return this')()` yields a global
whose `process` and `require` are both `undefined`, and `Function('return
require')` throws -- so a script gains nothing it couldn't already do by writing
the same code in its body. `aws_script` was never a security boundary (see its
description); the shadowed-globals list is the real defense, not that flag.

Note that any `oam` invocation writes a bytecode cache to `oam/` in the working
directory -- already in `.gitignore`.

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `AWS_PROFILE` | `default` | Profile used when a tool call omits `profile`. |
| `AWS_REGION` / `AWS_DEFAULT_REGION` | `us-east-1` | Region used when a tool call omits `region`. `AWS_REGION` wins if both are set. |
| `AWS_SHARED_CREDENTIALS_FILE` | `~/.aws/credentials` | Where `aws_assume_role` writes the profile it creates. Honored (with `~` expansion, like botocore) so the write lands in the same file the CLI later reads. |

If you authenticate via SAML (Okta / Azure AD / ADFS) or a custom `credential_process`, set `AWS_PROFILE` to that profile.

Every call resolves a profile name first -- **explicit tool `profile` argument -> the session profile set by `aws_session_set` -> `$AWS_PROFILE` -> the literal `default`** -- and then passes it to the CLI as `--profile <name>`. That flag is always present; there is no "no profile" mode. Inside the chosen profile the CLI's own chain resolves as usual: `credential_process`, SSO sessions (both `sso_session` blocks and inline `sso_start_url`), role chaining via `source_profile` / `role_arn`, static keys stored in `~/.aws/credentials`, container credentials, and IMDS.

**Exception -- static keys in your environment are not used.** Because a profile is always passed explicitly, botocore drops the environment credential provider from the chain, so `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` exported in your shell are never consulted. (Container credentials and IMDS are unaffected -- they sit later in the chain and are not profile-gated.) To use static keys, put them in a profile section of `~/.aws/credentials` and point `AWS_PROFILE` at it, rather than exporting them.

If neither `AWS_PROFILE` is set nor `aws_session_set` has been called and there's no `[default]` section in `~/.aws/config`, tools will fail with `ProfileNotFound`. Set `AWS_PROFILE` in your MCP config to your usual working profile.

## How the SSO login flow works

```
1. Claude calls aws_login_start({ profile: "prod" })
2. Server spawns: aws sso login --no-browser --use-device-code --profile prod
   (--use-device-code keeps the CLI on the device grant; without it, 2.22.0+
    prints an authorize URL with no short code to surface)
3. Server parses the URL + code from stdout, returns them to Claude
4. Claude surfaces: "Open https://device.sso.us-east-1.amazonaws.com/ and enter ABCD-EFGH"
5. You click — browser opens in your own user session — auth in ~10 seconds
6. Claude calls aws_login_complete({ sessionId })
7. Tool returns your new identity. Back to work.
```

The token is cached in `~/.aws/sso/cache/<hash>.json` the same way a normal `aws sso login` would, so the AWS CLI, the SDK, and every other tool on your machine pick it up transparently.

## Why this server must run locally (not on mcp.hosting)

SSO tokens live in `~/.aws/sso/cache/` on *your* device. A remote MCP server can't read them. So this is a stdio server, not a hosted one. That's a constraint of AWS SSO, not a limitation of mcp.hosting.

## Stability

From 1.0 onward this package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The 0.x line is the pre-stability tightening phase -- breaking changes are documented in [`CHANGELOG.md`](./CHANGELOG.md) but are not necessarily gated on a major bump.

**Stable in 1.x (anything below is a breaking change requiring a major bump):**

- **Tool names** -- the 26 tool names listed in the Tools table above will not be renamed or removed.
- **Tool annotations** -- `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`. These signal to MCP hosts how to gate calls; flipping them silently would break host UIs. Note the direction of the guarantee: an annotation may be tightened (made more cautious) in a patch release when it was previously understating what a tool can do -- v2.0.1 set `destructiveHint: true` on `aws_call`, `aws_multi_region` and `aws_resource_update` for exactly that reason. It will not be *loosened* outside a major. If your host suppresses confirmation prompts based on these, treat `aws_call` and `aws_multi_region` as able to invoke any AWS API the caller's IAM identity permits, including deletes.
- **Required input fields** -- the required fields per tool will not change shape or be removed. New *optional* fields may be added.
- **Success envelope shape per tool** -- the `data` object on `{ok: true, data}` responses, specifically:
  - `aws_call` -> `{command, result}`
  - `aws_paginate` -> `{command, result, nextToken, hasMore}`
  - `aws_multi_region` -> `{service, operation, regionCount, okCount, errorCount, results: [{region, ok, data?, command?, error?, errorKind?, truncated?}]}` (the aggregate response is capped; entries past the budget keep their `region`/`ok` but drop `data` and are flagged `truncated: true`. Error entries are never dropped, and `okCount`/`errorCount` are computed before capping, so they always describe what the calls did rather than what survived the cap.)
  - `aws_whoami` -> `{account, userId, arn, profile, region, ssoToken: {expiresAt, minutesLeft, startUrl?} | null}` (`startUrl` is omitted when the cached token didn't record one)
  - `aws_login_start` -> `{sessionId, profile, verificationUrl, userCode, instructions, reused?}` (`reused: true` when re-surfacing an in-flight login for the same profile)
  - `aws_login_complete` -> `{loggedIn, account, userId, arn, profile, region, ssoToken}` (same `ssoToken` shape as `aws_whoami`, including the optional `startUrl`)
  - `aws_refresh_if_expiring_soon` -> **one of two shapes by branch:** `{status: "ok", minutesLeft, expiresAt, profile}` when the cached token has more than `thresholdMinutes` left, or `{status: "refreshing", reason, sessionId, profile, verificationUrl, userCode, reused?, instructions}` when a refresh is in flight. Discriminate on `status`.
  - `aws_assume_role` -> `{profile, credentialsPath, expiration, assumedRoleArn, assumedRoleId, sourceProfile, hint, warning?}` (`warning` is present only when the target profile already existed and its three credential keys were overwritten in place; `credentialsPath` follows `AWS_SHARED_CREDENTIALS_FILE` when that is set)
  - `aws_list_profiles` -> `{configPath, profiles: [{name, region?, ssoStartUrl?, ssoRegion?, ssoSession?, isSso}]}`
  - `aws_session_get` / `aws_session_set` / `aws_session_clear` -> `{profile, region, profileSource, regionSource}` where `*Source` is `"session" | "env" | "default"`. All three return the same shape (set/clear return the post-mutation state).
  - `aws_resource_get` -> `{command, typeName, identifier, properties, propertiesRaw?}`
  - `aws_resource_list` -> `{command, typeName, resources: [{identifier, properties, propertiesRaw?}], nextToken, hasMore}` (`propertiesRaw` rides along on an entry whose `Properties` string didn't parse, matching `aws_resource_get`)
  - `aws_resource_create` / `_update` / `_delete` / `_status` -> flat-promoted `{command, requestToken, operationStatus, identifier, errorCode, statusMessage, retryAfter, progressEvent}` plus an `awaited: {attempts, elapsedMs}` block when `awaitCompletion: true` was passed, or an `awaitSkipped` string when `awaitCompletion: true` was passed but no request token came back to poll on
  - `aws_resource_diff` -> `{command, typeName, identifier, before, after, changes, changeCount}`
  - `aws_logs_tail` -> `{command, logGroupName, since, eventCount, totalEvents, truncated, events}` (`events` is capped at `maxEvents` -- default 500 -- keeping the NEWEST events, since `aws logs tail` emits oldest-first; order within the returned array is unchanged. `eventCount` is how many events are in `events` and `totalEvents` how many the window held, so the two differ exactly when `truncated` is true. Both counts are `null` on the NDJSON-parse-failure path, where `events` is the raw blob rather than an array and nothing was dropped. The cap bounds the response, not the CLI's server-side scan.)
  - `aws_logs_query` -> `{command, startCommand, profile, region, queryId, status, queryLanguage, logGroupNames, startTime, endTime, fields, rows, rowCount, statistics, truncated, polled: {attempts, elapsedMs}}`. `status` is always `"Complete"` on the `ok: true` arm -- every other terminal status (`Failed`, `Cancelled`, `Timeout`, an unrecognized one, or a missing one) returns `ok: false`, as do a `maxWaitMs` timeout and a client cancellation, both of which carry the `queryId` in the error string because the error envelope has no `data`. `command` is the last `get-query-results` call, `startCommand` the `start-query` call (its `--cli-input-json` payload is redacted, so the query text does not echo back). `rows` are the API's `[{field, value}]` pairs flattened to plain objects with `null` for a non-string value; `fields` is the union of field names in first-seen order; `logGroupNames` are the RESOLVED bare names actually queried (an ARN input echoes its extracted name). `queryLanguage` and `statistics` are `null` when the response omits them. `truncated` is true when `rowCount` reached the effective `limit`. The query is never stopped AWS-side by this tool on any path.
  - `aws_metrics_query` -> `{command, profile, region, startTime, endTime, periodSeconds, series: [{id, label?, timestamps, values, period?, statusCode?}], nextToken, hasMore, messages?: [{code?, value?}]}` (`messages` is omitted when empty; per-series `label` / `period` / `statusCode` are present when CloudWatch returns them or the query specifies/inherits a period; `nextToken` is null and `hasMore` false unless CloudWatch truncated the response)
  - `aws_iam_simulate` -> `{command, principalArn, summary: {allowed, denied, unknown, total}, results, marker, hasMore}` (`summary` describes only the page in hand; when `hasMore` is true, pass `marker` back to fetch the rest. `unknown` counts results whose `EvalDecision` was missing or unrecognized, so a malformed response can't be silently folded into `denied`.)
  - `aws_script` -> `{result, logs, truncatedLogs, durationMs}` where `result` is whatever the script `return`ed (any JSON-serializable value, including `undefined`)
  - `aws_docs_search` -> `{query, count, results: [{title, url, summary?, excerpt?}]}` (`summary` / `excerpt` are present only when the upstream search backend returns them)
  - `aws_docs_read` -> `{url, cached, content, startIndex, endIndex, totalLength, hasMore, nextStartIndex}`
- **Error envelope** -- `{ok: false, error: string, rawBody?: string, errorKind?: string, suggestion?: string}`. The `error` string is human-readable; its *wording* is best-effort (see below), and `errorKind` is the stable machine-readable part -- see the enum below. `suggestion` carries the one-line remedy for a recognized AWS error code; it is also embedded at the end of `error`, so it is a convenience for programmatic callers rather than extra information. On the wire an error result is a single text block, and `errorKind` rides on its own first line: `errorKind: <kind>` followed by a newline, then `Error: <message>`, then a blank line and `rawBody` when one is present and the message does not already quote it. A failure with no classification omits that line entirely and starts at `Error:` exactly as before.
- **`errorKind` enum** -- `"sso_expired" | "expired_creds" | "no_creds" | "invalid_creds" | "bad_input" | "spawn_failure" | "timeout" | "output_too_large" | "malformed_json" | "nonzero_exit" | "unexpected"`. Set on the error envelope of every tool that wraps an `aws` CLI call -- `aws_call`, `aws_paginate`, `aws_logs_tail`, `aws_logs_query`, `aws_metrics_query`, `aws_iam_simulate`, `aws_assume_role`, `aws_whoami`, `aws_login_complete`, the `aws_resource_*` family -- and on each entry of `aws_multi_region`'s `results` array. It is ABSENT, never defaulted, when the failure did not reach the CLI: a tool's own input validation, an `aws_docs_*` HTTP failure, a client-cancelled poll. Treat a missing `errorKind` as "unclassified", not as `nonzero_exit`. New variants may be added (additive); existing ones won't be renamed or repurposed. `unexpected` is `aws_multi_region`-only and flags a region whose worker threw rather than returning a result. The three credential kinds are deliberately distinct, because the remedy differs: `no_creds` means none were found, `invalid_creds` means credentials resolved and AWS rejected them (typical after a key rotation), and `expired_creds` means a temporary session expired. `expired_creds` is origin-agnostic -- AWS emits the same `ExpiredToken` wrapper for an SSO-derived session, an `aws_assume_role` session, and a web-identity one -- so its message names both remedies rather than assuming SSO; `sso_expired` is reserved for errors that name botocore's SSO token provider specifically. `malformed_json` means stdout opened with `{` or `[` and failed to parse, i.e. a truncated response rather than the scalar output a `--query` can legitimately produce.

**Best-effort (may change in a minor or patch):**

- **Error message wording.** Strings like "SSO session expired for profile 'X'. Call aws_login_start..." may be retuned for clarity. Anchor on `errorKind` or the structured envelope, not on regex-matching `error` text.
- **`suggestion` wording** -- the one-line remedy derived from a recognized AWS error code. Whether a suggestion is present tracks the error code, but the sentence itself may be retuned; branch on `errorKind`, not on this text. It is duplicated at the end of `error`, so a caller reading both must not print it twice.
- **`rawBody`** content -- raw stderr/stdout from the underlying `aws` CLI for diagnostic purposes. Format follows whatever the CLI emits in your installed version.
- **`command`** strings -- the human-readable command shown alongside results. Argv ordering and the exact redaction-stub format (`<redacted len=N>`) may shift.
- **Tool *descriptions*** -- the prose surfaced to the model. Tightening these is non-breaking.

**Deprecation policy:** breaking a stable shape requires a major bump. A deprecation lands first in a minor (the old shape continues to work and the new shape becomes available alongside it), with a removal scheduled for the next major. Both the deprecation and the removal show up in `CHANGELOG.md`.

## Development

`npm test` runs both unit tests and integration tests. The integration suites
spawn a local `fake-aws` subprocess that stubs the AWS CLI -- no AWS credentials
or network access required. The only tests that need real AWS credentials are
the live tests gated behind the `AWS_MCP_LIVE_TESTS` environment variable, which
are skipped in a standard `npm test` run.

## License

MIT
