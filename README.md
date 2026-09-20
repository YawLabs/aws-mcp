# @yawlabs/aws-mcp

A small AWS MCP for AI assistants: **one server, one config entry, SSO re-auth baked in, generic CRUD over 1,300+ resource types, live docs lookup, server-side scripting for batched workflows.**

It's an **alternative to AWS's official MCP server**, not a complement -- both reach any AWS API, so running both hands the model two overlapping ways to do the same thing. (AWS gives the same advice about its own older servers: its setup guide says to remove them "to avoid tool conflicts that can confuse AI agents".) Pick one. They overlap in coverage and differ in shape. The honest comparison:

- **[AWS MCP Server](https://docs.aws.amazon.com/agent-toolkit/latest/userguide/getting-started-aws-mcp-server.html)** -- AWS's hosted server, GA since May 2026 and part of the Agent Toolkit for AWS. Strong on AWS-team-curated skills, a server-side Python sandbox (`run_script`) with days-fresh API coverage, a read-only serverless troubleshooting capability (Lambda `diagnose`, recent changes, X-Ray trace summaries), IAM condition keys that tell its calls apart from direct API calls, and per-tool CloudWatch metrics. As of September 2026, `run_script` is its only general-purpose way to call an AWS API -- the single-call `call_aws` tool has been removed -- so every call, even a one-off `describe`, is a Python script the model writes. The endpoint runs in `us-east-1` and `eu-central-1`. Two ways to connect:
  - **OAuth** through AWS Sign-in (since July 2026): nothing to install -- your client opens a browser and connects straight to the endpoint. Each session is bound to one IAM role and refreshes for up to 12 hours, and the principal needs `signin:AuthorizeOAuth2Access` and `signin:CreateOAuth2Token`.
  - **SigV4** through a local proxy run with `uv` (`uvx mcp-proxy-for-aws-cli@latest` in AWS's guide), signing with your AWS CLI credentials (CLI 2.32.0+). AWS recommends this path for terminal and IDE coding agents, and it is the only one that switches profiles per call, from an allowlist fixed when the proxy starts. Since AWS CLI 2.35.0, `aws configure agent-toolkit` writes a SigV4 entry (`uvx mcp-proxy-for-aws@latest`) into your agent's MCP config for you, under the key `aws-mcp`.
- **`@yawlabs/aws-mcp`** (this server) -- installs from npm and runs locally on your own `aws` CLI and profiles: one `npx` line, no `uv`, no proxy, no hosted hop. Wins on SSO re-login when `aws sso login`'s browser handoff drops (Windows especially), one AWS operation per tool call (`aws_call` takes `service`, `operation` and `params`, so a host's approval prompt shows the operation itself, not a script), ergonomic CCAPI CRUD with dry-run diffs, multi-region and multi-account fan-out, pre-flight IAM permission checks, and a JS scripting tool for when you do want a batch (in-process, not a security sandbox -- see the tools table). Live AWS docs search + page read are built in too, so you don't need a second docs server either way -- they cover the same ground as the official server's `search_documentation` / `read_documentation`, without its topic routing or skills results.

The MCPs that genuinely pair with *either* choice are the per-service servers in **[`awslabs/mcp`](https://github.com/awslabs/mcp)** that reach what a general AWS-API tool cannot -- Bedrock's agentic Knowledge Base retrieval is the clearest case (see [the companion config](#optional-companion-aws-labs-per-service-servers)). AWS now describes that repo as succeeded by the Agent Toolkit for AWS; it still works and takes contributions, but some of its servers are deprecated or superseded -- its general AWS API server among them -- so check a server's README before adding it.

Five things this server tries to handle well:

1. **SSO re-login.** When your token expires mid-session, `aws sso login` tries to open a browser from a subprocess -- on Windows (and sometimes elsewhere) that handoff drops silently. You end up context-switching to a terminal, running the command yourself, then coming back. The `--no-browser` device-code flow fixes this: the assistant surfaces a short URL + code, you click once, done. (`--no-browser` on its own is no longer enough -- AWS CLI 2.22.0 made the PKCE authorization-code flow the default, and it prints no short code -- so this server pairs it with `--use-device-code`, probing `aws --version` once to stay compatible with pre-2.22 CLIs.) There's also `aws_refresh_if_expiring_soon` for proactive top-ups before a long workflow. AWS's hosted server goes around the problem rather than through it. On its OAuth path your MCP client runs its own browser sign-in, and the tokens are bound to that client and that server, so nothing else on the machine benefits; on its SigV4 path, AWS's troubleshooting table tells SSO users to run `aws sso login` themselves and then restart the MCP client. Here the re-login refreshes the same `~/.aws/sso/cache` token the CLI, the SDKs and every other tool on the machine read.
2. **Calling any AWS API.** `aws_call` proxies the `aws` CLI directly. One tool covers the full API surface -- including services AWS adds tomorrow -- with no SDK bundling and no service-by-service tool sprawl. That is not aspirational: September 2026's arrivals -- AWS Batch bulk `cancel-jobs` / `terminate-jobs` (CLI 2.36.44), the STS session-token size fields (2.36.45), Elastic Beanstalk cluster environments (2.36.47), "Tunnel" VPC endpoints (2.36.48) -- are reachable the moment your local `aws` CLI knows them, with no `@yawlabs/aws-mcp` upgrade. An older CLI rejects an operation it does not know before anything is sent, and the error says to upgrade. `aws_paginate` handles paginated list/describe ops, `aws_multi_region` fans the same op out across N regions in parallel, and a JMESPath `query` parameter trims responses server-side. Reach for them long before this server's 5 MB output cap: MCP hosts cut in much sooner -- Claude Code warns at 10,000 tokens and, by default, saves any result over 25,000 tokens to a file the model has to read back.
3. **Generic CRUD across services.** `aws_resource_*` (seven tools, including `aws_resource_diff` for dry-run previews) wraps AWS Cloud Control API, so the same lifecycle -- get / list / create / update / delete / status -- works for any control-plane resource with a CloudFormation schema: Lambda functions, S3 buckets, IAM roles, SSM parameters, RDS instances, and the rest of the 1,300 types on AWS's published list (not every type implements every verb). Pass `awaitCompletion: true` and the server polls the async create/update/delete through to terminal state for you. AWS Labs deprecated its own Cloud Control API MCP server in March 2026, and [its migration guide](https://github.com/awslabs/mcp/blob/main/docs/migration-ccapi.md) lists no direct replacement for resource get / list / create / update / delete: the successor authors CloudFormation and CDK instead. CCAPI is control-plane only. On the data plane, DynamoDB `get-item` / `query` and Bedrock `converse` are ordinary operations `aws_call` handles (DynamoDB values stay in its typed JSON, `{"S": "..."}`), and Lambda invokes have their own tool, `aws_lambda_invoke`. Three kinds of operation are out of `aws_call`'s reach: those that write their response body to a positional outfile (S3 `get-object`, Bedrock `invoke-model`), the CLI's hand-written commands, which register no `--cli-input-json` (`s3 cp/ls/sync`, `logs tail`, `cloudformation deploy`), and event-stream operations the CLI does not ship at all (Bedrock `converse-stream`, `invoke-agent`, agentic Knowledge Base retrieval).
4. **Live AWS docs.** `aws_docs_search` queries the same backend that powers the docs.aws.amazon.com search box; `aws_docs_read` fetches a doc page and returns it as paginated markdown. Lets the agent discover new services and look up exact parameter names without a second MCP server installed.
5. **Batched workflows in one round-trip.** `aws_script` runs a short JS snippet in a `node:vm` context with `aws.call`, `aws.paginate`, `aws.paginateAll`, `aws.resource.*`, `aws.logsTail`, `aws.metricsQuery`, `aws.iamSimulate`, `aws.multiRegion`, `aws.assumeRole`, and `aws.docs.{search,read}` available. Best for "list X, fetch Y for each, return Z" pipelines that would otherwise need N tool calls. Same idea as AWS's `run_script` (Python, sandboxed server-side), which is now that server's only general-purpose way to call an AWS API; here it is the batching option -- JS-native, running locally -- with `aws_call` for single operations.

[![Add to Yaw MCP](https://yaw.sh/yaw-mcp-button.svg)](https://yaw.sh/mcp/install?name=AWS&command=npx&args=-y%2C%40yawlabs%2Faws-mcp&env=AWS_PROFILE%2CAWS_REGION&description=Call%20any%20AWS%20API%20from%20one%20server%20-%20CCAPI%20CRUD%2C%20multi-region%2C%20SSO%20re-login&source=https%3A%2F%2Fgithub.com%2FYawLabs%2Faws-mcp)

One click adds this to your local Yaw MCP config so it's available in every Yaw Terminal session. Or install manually below.

## Optional companion: AWS Labs per-service servers

For work a general AWS-API tool cannot do, add the relevant [`awslabs/mcp`](https://github.com/awslabs/mcp) server alongside this one. Bedrock's agentic Knowledge Base retrieval is the clearest case: it calls `AgenticRetrieveStream`, an event-stream operation the AWS CLI leaves out of its command table, so no CLI-based tool -- `aws_call` included -- can reach it. (Plain retrieval, `bedrock-agent-runtime retrieve`, is an ordinary `aws_call` operation.) These are Python servers run with `uvx`, and they have no tool-name overlap with this one, so they pair cleanly:

```json
{
  "mcpServers": {
    "aws": {
      "command": "npx",
      "args": ["-y", "@yawlabs/aws-mcp@latest"]
    },
    "aws-bedrock-kb": {
      "command": "uvx",
      "args": ["awslabs.bedrock-kb-retrieval-mcp-server@latest"],
      "env": { "AWS_PROFILE": "my-profile", "AWS_REGION": "us-east-1" }
    }
  }
}
```

Its agentic tool works on managed knowledge bases, and by default the server lists only knowledge bases tagged `mcp-multirag-kb=true`; its [README](https://github.com/awslabs/mcp/tree/main/src/bedrock-kb-retrieval-mcp-server) covers the tag and the IAM permissions. Skip the older `awslabs.lambda-mcp-server`: every release is yanked on PyPI, and Lambda invokes are built in here as `aws_lambda_invoke`.

## When to reach for this vs the other AWS MCPs

| Need | Best fit |
|------|----------|
| Node/npm-only install, running locally on your own `aws` CLI and profiles (no `uv`, no proxy) | **`@yawlabs/aws-mcp`** |
| Nothing installed locally (remote server, browser sign-in) | **AWS MCP Server** (OAuth) |
| SSO re-login on Windows / broken browser handoff, fixed for every tool on the machine | **`@yawlabs/aws-mcp`** (`aws_login_start` device-code flow) |
| One AWS operation per tool call -- the approval prompt shows `service`, `operation` and `params`, not a script | **`@yawlabs/aws-mcp`** (`aws_call`) |
| Generic CRUD across 1,300+ resource types | **`@yawlabs/aws-mcp`** (`aws_resource_*`) |
| Dry-run an update before applying it | **`@yawlabs/aws-mcp`** (`aws_resource_diff`) |
| Multi-region fan-out in one call | **`@yawlabs/aws-mcp`** (`aws_multi_region`) |
| Same operation across many accounts in one call | **`@yawlabs/aws-mcp`** (`aws_multi_account`) |
| Batch N tool calls into one round-trip (JS) | **`@yawlabs/aws-mcp`** (`aws_script`) |
| Check IAM permissions before attempting an op | **`@yawlabs/aws-mcp`** (`aws_iam_simulate`) |
| Cross-account / cross-role in one session | **Either** -- this server takes any configured `profile` on every call and adds `aws_assume_role` for STS role-chaining; AWS's takes one per call over SigV4 only, from profiles declared when its proxy starts (an OAuth session is one role) |
| Sandboxed Python script execution server-side | **AWS MCP Server** (`run_script`) |
| Days-fresh API coverage via hosted endpoint | **AWS MCP Server** (`run_script`) |
| AWS-team-curated best-practice skills | **AWS MCP Server** (`retrieve_skill`) |
| Guided Lambda troubleshooting (diagnose, recent changes, trace summary) | **AWS MCP Server** (serverless capability) |
| Typed per-service helpers for what a CLI-based tool cannot reach (Bedrock agentic KB retrieval, ...) | **`awslabs/mcp`** (per-service servers) |

`@yawlabs/aws-mcp` and AWS's official server are an either/or -- pick the one whose tradeoffs fit. `awslabs/mcp` per-service servers pair cleanly with whichever you pick.

## What this server borrows from AWS's official one

Credit where due -- two features here were shaped by the official AWS MCP Server:

- **`aws_script`** mirrors the official server's `run_script`: a scripting tool that collapses "list X, fetch Y for each, return Z" pipelines into one round-trip. Theirs is Python, sandboxed server-side, and is now that server's only general-purpose API path; this one is JS-native, runs **in this server's own process** -- see the trust note in the tools table -- and sits beside `aws_call` rather than replacing it.
- **`aws_docs_search` / `aws_docs_read`** were added so you don't need a separate docs MCP whichever server you pick. They cover the same ground as the official server's `search_documentation` / `read_documentation` -- live search and page reads -- without its topic routing or skills results.

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
| `aws_call` | Run any AWS API operation. `service: 's3api', operation: 'list-buckets'`, optional `params` (PascalCase JSON), optional `query` (JMESPath). Returns parsed JSON. Hand-written CLI commands (`s3 cp/ls/sync`, `logs tail`) and operations that stream their response to a file (`s3api get-object`, `bedrock-runtime invoke-model`, `bedrock-agentcore invoke-agent-runtime`, `lambda invoke`) never accept `--cli-input-json`, so `aws_call` cannot reach them; the error says so and names the alternative (`aws_lambda_invoke`, `aws_logs_tail`, `bedrock-runtime converse`, or a shell). Waiters work as `operation: 'wait <name>'`. |
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
| `aws_multi_region` | Run the same AWS operation across N regions in parallel. Same shape as `aws_call` but takes `regions: string[]`. Returns `{region, ok, data?, error?}[]` with `okCount`/`errorCount`. Partial failure is expected (services aren't everywhere, perms may be region-scoped). Up to 64 regions per call, at most 32 in flight. |
| `aws_multi_account` | Run the same AWS operation across N accounts in parallel, assuming `roleName` in each. Credentials for every account are held IN MEMORY for the life of the call and passed to that one spawn -- nothing is written to `~/.aws/credentials`, unlike an `aws_assume_role` loop, which either writes a section per account or stomps one repeatedly (and leaves live keys on disk if a sweep dies midway). Same envelope as `aws_multi_region` with `accountId` in place of `region`, including the 5 MB aggregate cap and `okCount`/`errorCount` computed before capping. Partial failure is expected: the role may not exist everywhere. |
| `aws_script` | Run a short JS snippet that orchestrates the other tools and returns a combined result. Sandbox exposes `aws.call`, `aws.paginate`, `aws.paginateAll`, `aws.resource.{get,list,create,update,delete,status}`, `aws.logsTail`, `aws.metricsQuery`, `aws.iamSimulate`, `aws.multiRegion`, `aws.assumeRole`, `aws.docs.{search,read}`, plus standard JS builtins (`JSON`, `Math`, `Date`, `Promise`, etc.) and `console`. `require`/`import`/`process`/`fs`/`fetch`/timers are not bound into the context. **This is not a security boundary:** the script runs in this server's own process, and host globals remain reachable from inside it, so `aws_script` is strictly more powerful than the other tools -- those are bounded by AWS and your IAM policy, this one is not. Only pass script text you would run on this machine yourself, never text that arrived from a log line, a resource tag, or any other AWS response. Best for "list X, fetch Y for each, return Z" pipelines that would otherwise be N round-trips. Use `return <value>` to surface a result. |
| `aws_iam_simulate` | Simulate IAM permissions for a principal: can principal X do actions Y on resources Z? Wraps `iam simulate-principal-policy`. Returns one entry per (action, resource) pair -- one per action with resource `*` when `resources` is omitted -- with `decision` (allowed / explicitDeny / implicitDeny / unknown), `matchedStatementIds` (which IAM statements decided), `missingContextValues` (context keys the policy needed but you didn't provide), `permissionsBoundaryDecision` and `organizationsDecision` (reported by AWS per action). An SCP deny never names its statement, and keys only an SCP references are never reported missing -- pass `aws:RequestedRegion` and the like in `contextEntries`. "allowed" is necessary, not sufficient: RCPs, the target resource's own policy, session policies and VPC endpoint policies are not evaluated. Pass the IAM role ARN, not the STS session ARN `aws_whoami` shows. Use BEFORE a risky operation to avoid a 403 -- pairs with the post-failure Suggestion from aws_call. Requires `iam:SimulatePrincipalPolicy` on the caller. |
| `aws_lambda_invoke` | Invoke a Lambda function synchronously and return its response payload plus the DECODED tail of its execution log. `aws_call` structurally **cannot** do this -- `aws lambda invoke` takes the response body as a required positional outfile and rejects `--cli-input-json` -- so this is the one Lambda path that works without a second (Python) MCP server. The decoded `logTail` collapses the usual invoke -> find the log group -> tail it -> hope the window caught it loop into one call. A non-empty `functionError` means the function's HANDLER threw: the invocation still succeeded, so `ok` is true and the thrown error is in `payload`. The invoke is sent at most once: the CLI's automatic retries are off for this tool, because a retried invoke runs the function again. `timeoutMs` is how long to wait for the function (default 60s, at most 900000). A throttled call did not run and is safe to retry; after a timeout the error says whether the invoke was sent. |
| `aws_docs_search` | Search live AWS documentation (the backend behind the docs.aws.amazon.com search box). Returns ranked `{title, url, summary, excerpt}`. Each result also carries a locally computed `lexicalMatch`, and the response carries `queryTerms` / `termsMatchedNowhere` / `bestLexicalOverlap` / `lowRelevance` -- the backend always returns a full page of fuzzy matches and never says "no good match", so those are the only signal that a query found nothing. Use to discover the right doc page for a service/API/concept the model may not know -- new services, recently changed APIs, exact parameter names. |
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

Keep the key `aws` (anything but `aws-mcp`). AWS's `aws configure agent-toolkit` wizard registers its hosted server under `aws-mcp`, and reports an existing `aws-mcp` entry as already configured without looking at what it runs.

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

For a larger list -- anything that would run past your MCP host's output limit, which is far smaller than this server's 5 MB cap -- the assistant reaches for `aws_paginate`:

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
- AWS CLI v2 on `PATH`. Every tool that talks to AWS shells out to it (all but `aws_docs_*`, `aws_session_*` and `aws_list_profiles`), so the CLI you have installed decides which services, operations and parameters are reachable. No minimum version is enforced:
  - **2.22.0+ recommended.** That release added `--use-device-code`, which this server needs to keep the SSO short-code flow working. Older 2.x still works -- the server detects the version and adapts.
  - **Developed and tested against 2.34.3.** Anything newer than your CLI is rejected by the CLI itself before a request is sent: an unknown service or operation as an "invalid choice" (the error then says to upgrade), a new parameter as `Unknown parameter in input`. Upgrade with `aws update` (CLI 2.36.0+, for installs made with AWS's installer or install script), otherwise with [the installer](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) or your package manager.
  - **Security, as of 2026-09:** CLI 2.35.3 or newer clears every published AWS CLI v2 advisory ([GHSA-747p-wmpv-9c78](https://github.com/aws/aws-cli/security/advisories/GHSA-747p-wmpv-9c78), [CVE-2026-13769](https://github.com/aws/aws-cli/security/advisories/GHSA-wfp6-f47h-hxc3), [CVE-2026-18654](https://github.com/aws/aws-cli/security/advisories/GHSA-hqvf-45jj-mccq)). None of the affected paths is reachable through this server: the four commands (`emr ssh/socks/put/get`, `codeartifact login`, `deploy register`, `iam create-virtual-mfa-device`) all register no `--cli-input-json`, which is the only way `aws_call` passes parameters, and the third advisory is about the opt-in `cli_history` database, which this server never enables. You do share that CLI install with everything else on the machine, though. Worth checking [the advisory list](https://github.com/aws/aws-cli/security/advisories) for newer ones: v2 ships as an installer, so a dependency scanner will never flag it.
  - AWS CLI **v1 is unsupported**; it entered maintenance mode on 2026-07-15 and reaches end of support on 2027-07-15.
- An AWS profile the CLI can already use -- see [Environment](#environment) for how the profile is chosen. SSO / IAM Identity Center profiles also get the device-code re-login tools.

## Runtime

This server runs on [oam.js](https://oamjs.org) and on Node, unmodified, and
the launcher only ever uses the **latest oam release, currently 0.15.2**. On
oam 0.15.2: full MCP handshake with all 28 tools, and the `aws_script` sandbox
behavior described below.

**oam 0.15.2 is the minimum.** The launcher picks the newest oam it can find at
or above it, never serves on an older one, and falls back to Node when there is
none (`AWS_MCP_RUNTIME=oam` turns that into a hard error). A floor matters here:
releases before 0.9.0 ran `child_process.execFile` arguments through a shell,
accepted `exec`'s `timeout` and ignored it, and treated `stdio: 'inherit'` as
`'pipe'`, and this server shells out to the `aws` CLI on essentially every tool.

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

**Measure startup on your own hardware.** An MCP client cold-starts this server
once per session, so startup is the cost that actually gets paid. The numbers
below were taken with oam 0.8.2, long before the current 0.15.2 floor, and have
not been re-run since, so do not read them as a current ranking. To a completed
`initialize` + `tools/list` handshake, median of 10 warmed runs:

| Runtime | Cold start |
|---------|-----------|
| `node dist/index.js` | **359 ms** |
| `oam run dist/index.js` | 650 ms |
| `oam run src/index.ts` (no build step) | 947 ms |

The published `aws-mcp` command prefers the newest oam it finds (see
`AWS_MCP_RUNTIME` under [Environment](#environment)). Without oam that costs
almost nothing: discovery is file-existence checks only, never a subprocess, and
the fallback runs the server inside the Node process npm already started. With
oam installed, though, the command boots Node, runs `--version` on every oam
binary it found to pick the newest, and only then boots oam, so it is always
slower than pointing your client at oam directly with the config above.
`AWS_MCP_RUNTIME=node` skips oam entirely.

Two more places oam wins for this repo, both opt-in and neither touching the
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
and `Function` throw; oam does not, so they work. Re-measured against oam 0.15.2
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
| `AWS_PROFILE` / `AWS_DEFAULT_PROFILE` | `default` | Profile used when a tool call omits `profile`. `AWS_DEFAULT_PROFILE` is the legacy spelling. `AWS_PROFILE` wins if both are set, as in AWS CLI v2 (standalone botocore and boto3 check `AWS_DEFAULT_PROFILE` first). An empty value counts as unset. |
| `AWS_REGION` / `AWS_DEFAULT_REGION` | `us-east-1` | Region used when a tool call omits `region`. `AWS_REGION` wins if both are set. |
| `AWS_SHARED_CREDENTIALS_FILE` | `~/.aws/credentials` | Where `aws_assume_role` writes the profile it creates. Honored (with `~` expansion, like botocore) so the write lands in the same file the CLI later reads. |
| `AWS_MCP_AWS_CLI` | unset | Absolute path to the `aws` executable to run instead of the one found on `PATH`. For MCP hosts started from a GUI, which often inherit none of your shell's `PATH` -- and AWS's recommended installer now defaults to `~/.local/bin` on macOS and Linux, which such hosts rarely see. Find the path with `command -v aws` (macOS/Linux) or `where.exe aws` (Windows). It applies to every call and to `aws sso login`. Must be absolute, and on Windows must name `aws.exe`: a `.cmd` or `.bat` shim cannot be started without a shell. An unusable value fails every call with a message naming this variable, rather than quietly running a different CLI than you configured. Unset, the server walks the absolute directories on `PATH`; it never runs an `aws` from its working directory. |

The launcher that the published `aws-mcp` command runs (`bin/aws-mcp.mjs`, which is what `npx @yawlabs/aws-mcp` starts) reads two more. They pick the runtime, not anything about AWS, and pointing your client straight at `dist/index.js` bypasses both. See [Runtime](#runtime) for what running on oam changes.

| Variable | Default | Purpose |
|----------|---------|---------|
| `AWS_MCP_RUNTIME` | `auto` | `auto`: serve on the oam the launcher is already running under if that is 0.15.2 or newer; otherwise run on the newest oam binary it can find at 0.15.2 or newer (see `OAM_BIN`); otherwise on Node. An oam host older than 0.15.2 never serves the server itself -- it hands off to the newest usable oam, or to Node on `PATH`, or exits with an error when there is neither. An unusable `OAM_BIN` is always named on stderr; the other oam binaries that were passed over are named only when no usable oam is found. `oam`: the same, but exit with an error instead of falling back to Node. `node`: always Node -- in-process under `npx`, and handed off to Node on `PATH` when a client launches the command with `oam run`. Case-insensitive, and any other value behaves like `auto`. |
| `OAM_BIN` | unset | Path to an oam binary to use in preference to discovery, when it is 0.15.2 or newer. If it does not exist, is older, or will not run, the launcher says so on stderr and carries on with discovery. Discovery looks in the installed location (`%LOCALAPPDATA%\oam\bin` then `~/.oam/bin` on Windows, `~/.oam/bin` elsewhere) and on `PATH`, asks every oam it finds for its version, and uses the newest; on a tie the installed copy wins. On Windows only `oam.exe` counts; an `oam.cmd` / `oam.bat` shim is never run, and is named on stderr when no usable oam is found. Ignored under `AWS_MCP_RUNTIME=node` and when already running on oam 0.15.2+. |

If you authenticate via SAML (Okta / Azure AD / ADFS) or a custom `credential_process`, set `AWS_PROFILE` to that profile.

Every call resolves a profile name first -- **explicit tool `profile` argument -> the session profile set by `aws_session_set` -> `$AWS_PROFILE` -> `$AWS_DEFAULT_PROFILE` -> the literal `default`** -- and then passes it to the CLI as `--profile <name>`. There is no "no profile" mode, with one exception: `aws_multi_account` uses the resolved profile only for its `sts:AssumeRole` calls, and each per-account operation then runs on that account's assumed-role credentials with no `--profile` flag. Inside the chosen profile the CLI's own chain resolves as usual: `credential_process`, SSO sessions (both `sso_session` blocks and inline `sso_start_url`), role chaining via `source_profile` / `role_arn`, static keys stored in `~/.aws/credentials`, container credentials, and IMDS.

**Exception -- static keys in your environment are not used.** Because a profile is always passed explicitly, botocore drops the environment credential provider from the chain, so `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` exported in your shell are never consulted. (Container credentials and IMDS are unaffected -- they sit later in the chain and are not profile-gated.) To use static keys, put them in a profile section of `~/.aws/credentials` and point `AWS_PROFILE` at it, rather than exporting them.

### Behind a proxy or a private CA

`aws_docs_search` and `aws_docs_read` fetch over HTTPS from this process, so they are the two tools a corporate gateway breaks. They now name the cause rather than blaming AWS's backend, and the fix is an `env` entry in your MCP config -- **not** an export in your shell, because both variables below are read when the process starts and your MCP client launches the server itself.

| Variable | Purpose |
|----------|---------|
| `NODE_EXTRA_CA_CERTS` | Path to the PEM file holding your gateway's CA certificate, when TLS interception makes the fetch fail with a self-signed or unknown-issuer error. |
| `NODE_USE_SYSTEM_CA=1` | Trust the operating system's certificate store instead of naming a file (Node 22.19+). |
| `HTTPS_PROXY` / `https_proxy` | The proxy to fetch through. On Node this is **ignored** unless you also opt in with `NODE_USE_ENV_PROXY=1` or `--use-env-proxy` (Node 22.21+, also accepted inside `NODE_OPTIONS`); a request otherwise goes direct and a proxy-only network simply times out. Running on oam, the variable is honored with no opt-in. |

The AWS CLI is a separate process with its own rules, so a `credential_process`, an SSO login or any `aws_call` behind the same gateway follows the [AWS CLI's own proxy configuration](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-proxy.html) (`HTTP_PROXY` / `HTTPS_PROXY` and `AWS_CA_BUNDLE`) rather than the Node variables above. Those failures now carry their own remedy too.

If a call omits `profile`, `aws_session_set` has not been called, neither `AWS_PROFILE` nor `AWS_DEFAULT_PROFILE` is set to a non-empty value, and neither `~/.aws/config` nor `~/.aws/credentials` defines a `default` profile, the CLI rejects `--profile default` with `ProfileNotFound`, which the tool reports as a `no_creds` error. Set `AWS_PROFILE` in your MCP config to your usual working profile.

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

- **Tool names** -- the 28 tool names listed in the Tools table above will not be renamed or removed.
- **Tool annotations** -- `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`. These signal to MCP hosts how to gate calls; flipping them silently would break host UIs. Note the direction of the guarantee: an annotation may be tightened (made more cautious) in a patch release when it was previously understating what a tool can do -- v2.0.1 set `destructiveHint: true` on `aws_call`, `aws_multi_region` and `aws_resource_update` for exactly that reason. It will not be *loosened* outside a major. If your host suppresses confirmation prompts based on these, treat `aws_call` and `aws_multi_region` as able to invoke any AWS API the caller's IAM identity permits, including deletes.
- **Required input fields** -- the required fields per tool will not change shape or be removed. New *optional* fields may be added.
- **Success envelope shape per tool** -- the `data` object on `{ok: true, data}` responses, specifically:
  - `aws_call` -> `{command, result}`
  - `aws_paginate` -> `{command, result, nextToken, hasMore}`
  - `aws_multi_region` -> `{service, operation, regionCount, okCount, errorCount, results: [{region, ok, data?, command?, error?, errorKind?, truncated?}]}` (the aggregate response is capped; entries past the budget keep their `region`/`ok` but drop `data` and are flagged `truncated: true`. Error entries are never dropped, and `okCount`/`errorCount` are computed before capping, so they always describe what the calls did rather than what survived the cap.)
  - `aws_multi_account` -> `{service, operation, roleName, accountCount, okCount, errorCount, results: [{accountId, ok, data?, command?, error?, errorKind?, truncated?}]}` plus `truncated`, `truncatedAccounts` and `maxTotalResultBytes` when the 5 MB aggregate cap fired. Mirrors `aws_multi_region` field for field with `accountId` in place of `region`, including that `okCount`/`errorCount` are computed BEFORE capping so they describe what the calls did rather than what survived. Duplicate account IDs collapse, so `results.length` may be under `accounts.length`; use `accountCount`. Credentials are never written to `~/.aws/credentials` and never appear in `command`, `error` or `rawBody`.
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
  - `aws_iam_simulate` -> `{command, principalArn, summary: {allowed, denied, unknown, total}, results, marker, hasMore}` (`results` has one entry per (action, resource) pair, read from IAM's per-resource `ResourceSpecificResults`. A call without `resources` gets one entry per action with `resource: "*"`; an action AWS does not break down per resource gets a single entry carrying AWS's own `EvalResourceName` (`*` or the action's ARN template). `summary` counts entries. `organizationsDecision` and `permissionsBoundaryDecision` fall back to AWS's action-level value when it gives no per-resource one, except that an `allowed` entry always reads `"allowed"`. `unknown` counts entries whose decision was missing or unrecognized, so a malformed response can't be silently folded into `denied`. The CLI follows IAM's pagination itself, so a first call is complete -- `hasMore: false`, `marker: null`; the two carry a cursor only on a call that resumed from `marker`, and `summary` then describes only that page.)
  - `aws_lambda_invoke` -> `{command, statusCode, functionError, executedVersion, payload, logTail}`, plus `payloadTruncated: true` only when the response body was clipped (absent otherwise, so the field reads as an exception flag rather than a size report). `logTail` is the function's `LogResult` already base64-DECODED. A non-empty `functionError` is still `ok: true`: the invocation succeeded and the function's handler threw, with the thrown error in `payload` -- an invocation failure (bad function name, no permission, throttling, timeout) is the `ok: false` case. The invoke is never sent more than once; `errorKind: "timeout"` means no answer arrived in time, and its message says whether the invoke was sent (if it was, the function may have run and may still be running).
  - `aws_script` -> `{result, logs, truncatedLogs, durationMs}` where `result` is whatever the script `return`ed (any JSON-serializable value, including `undefined`)
  - `aws_docs_search` -> `{query, count, results: [{title, url, summary?, excerpt?, lexicalMatch}], queryTerms, termsMatchedNowhere?, bestLexicalOverlap, lowRelevance, relevanceNote?}` (`summary` / `excerpt` are present only when the upstream search backend returns them. The relevance fields, shipped since 2.1.0, are computed locally by this server: literal word overlap between the query's terms and a result's title/summary/excerpt, NOT a backend score and NOT semantic ranking -- results are annotated, never re-ordered. Per result, `lexicalMatch` is `{overlap, matchedTerms, unmatchedTerms}`, or `null` for a query with no scorable terms -- the same case where `bestLexicalOverlap` is `null` and `termsMatchedNowhere` is omitted. `lowRelevance` is true when the best result matched at or under half the query terms, when any term appears in no result at all, or when the backend returned nothing. `relevanceNote` is the prose explanation -- of a `lowRelevance` verdict, or of the no-scorable-terms case -- and is absent when there is nothing to explain.)
  - `aws_docs_read` -> `{url, cached, content, startIndex, endIndex, totalLength, hasMore, nextStartIndex}`
- **Error envelope** -- `{ok: false, error: string, rawBody?: string, errorKind?: string, suggestion?: string}`. The `error` string is human-readable; its *wording* is best-effort (see below), and `errorKind` is the stable machine-readable part -- see the enum below. `suggestion` carries the one-line remedy for a recognized AWS error code; it is also embedded at the end of `error`, so it is a convenience for programmatic callers rather than extra information. On the wire an error result is a single text block, and `errorKind` rides on its own first line: `errorKind: <kind>` followed by a newline, then `Error: <message>`, then a blank line and `rawBody` when one is present and the message does not already quote it. A failure with no classification omits that line entirely and starts at `Error:` exactly as before.
- **`errorKind` enum** -- `"sso_expired" | "expired_creds" | "no_creds" | "invalid_creds" | "bad_input" | "spawn_failure" | "timeout" | "output_too_large" | "malformed_json" | "nonzero_exit" | "unexpected" | "cancelled"`. It appears on two distinct surfaces, with different rules.

  **On the top-level error envelope**, for every tool that wraps an `aws` CLI call -- `aws_call`, `aws_paginate`, `aws_logs_tail`, `aws_logs_query`, `aws_metrics_query`, `aws_iam_simulate`, `aws_lambda_invoke`, `aws_assume_role`, `aws_whoami`, `aws_login_complete`, the `aws_resource_*` family. There it is ABSENT, never defaulted, when the failure did not reach the CLI: a tool's own input validation, an `aws_docs_*` HTTP failure, a client-cancelled poll. Treat a missing `errorKind` as "unclassified", not as `nonzero_exit`.

  **On each entry of a fan-out tool's `results` array** -- `aws_multi_region` and `aws_multi_account`. A per-entry `errorKind` is always present on a failed entry, including for failures that never reached the CLI: both tools classify an entry they rejected themselves (a malformed region name, an account ID that is not 12 digits) as `bad_input`, and an entry whose worker threw as `unexpected`. `unexpected` is fan-out-only -- it cannot appear on a top-level envelope, and so is `cancelled`, which marks an entry that was NEVER ATTEMPTED because the client cancelled the request before a worker claimed it. Nothing was sent to AWS for a `cancelled` entry; entries that had already run keep their real results, and the array still covers the full requested set so `okCount`/`errorCount` cannot mistake a cancelled sweep for a smaller successful one.

  New variants may be added (additive); existing ones won't be renamed or repurposed. The three credential kinds are deliberately distinct, because the remedy differs: `no_creds` means none were found, `invalid_creds` means credentials resolved and AWS rejected them (typical after a key rotation), and `expired_creds` means a temporary session expired. `expired_creds` is origin-agnostic -- AWS emits the same `ExpiredToken` wrapper for an SSO-derived session, an `aws_assume_role` session, and a web-identity one -- so its message names both remedies rather than assuming SSO; `sso_expired` is reserved for errors that name botocore's SSO token provider specifically. `malformed_json` means stdout opened with `{` or `[` and failed to parse, i.e. a truncated response rather than the scalar output a `--query` can legitimately produce.

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
or network access required. Suites named `*.realcli.test.ts` check the fake
against the real thing: they drive the AWS CLI v2 on your `PATH` against an
in-process endpoint on 127.0.0.1, with throwaway keys and every other address
routed to a dead proxy, so nothing leaves the machine. The ones that need only a
few CLI starts run on every `npm test` and skip themselves when no CLI v2 is
installed; the ones that wait out real timeouts and retries also need
`AWS_MCP_REAL_CLI_TESTS=1`, which `release.sh` sets. The only tests that need
real AWS credentials are the live tests gated behind the `AWS_MCP_LIVE_TESTS`
environment variable, which are skipped in a standard `npm test` run.

## License

MIT

[![Follow @TokenLimitNews on X](https://img.shields.io/badge/follow-%40TokenLimitNews-000000?logo=x&logoColor=white)](https://x.com/TokenLimitNews)
