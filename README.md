# @yawlabs/aws-mcp

A small AWS MCP for AI assistants: **one server, one config entry, SSO re-auth baked in, generic CRUD over hundreds of resource types, live docs lookup, server-side scripting for batched workflows.**

It's an **alternative to AWS's official MCP server**, not a complement -- both call any AWS API, so running both just gives the model two redundant tools. Pick one. The honest comparison:

- **[AWS MCP Server](https://aws.amazon.com/blogs/aws/the-aws-mcp-server-is-now-generally-available/)** -- AWS's hosted server (`uvx mcp-proxy-for-aws`). Strong on AWS-team-curated skills, a server-side Python sandbox (`run_script`), and days-fresh API coverage. Requires Python + `uv`, routes through a proxy that bridges IAM SigV4 to OAuth, and assumes your local credentials already work.
- **`@yawlabs/aws-mcp`** (this server) -- Node/npm-only, runs locally. Wins on SSO re-login when `aws sso login`'s browser handoff drops (Windows especially), ergonomic CCAPI CRUD with dry-run diffs, multi-region fan-out, pre-flight IAM permission checks, and a JS scripting sandbox. Ships live AWS docs search + read so you don't need a second server for that.

The one MCP that genuinely pairs with *either* choice is **[`awslabs/mcp`](https://github.com/awslabs/mcp)** -- AWS Labs' fleet of typed per-service servers (Lambda invoke, Bedrock retrieval, DynamoDB with type-marshalling). Those are per-service helpers, no overlap with a general AWS-API server.

Five things this server tries to handle well:

1. **SSO re-login.** When your token expires mid-session, `aws sso login` tries to open a browser from a subprocess -- on Windows (and sometimes elsewhere) that handoff drops silently. You end up context-switching to a terminal, running the command yourself, then coming back. The `--no-browser` device-code flow fixes this: the assistant surfaces a short URL + 8-character code, you click once, done. There's also `aws_refresh_if_expiring_soon` for proactive top-ups before a long workflow. AWS's hosted server bridges IAM-to-OAuth via a local proxy; it doesn't help with the `aws sso login` browser-handoff failure.
2. **Calling any AWS API.** `aws_call` proxies the `aws` CLI directly. One tool covers the full API surface -- including services AWS adds tomorrow -- with no SDK bundling and no service-by-service tool sprawl. `aws_paginate` handles paginated list/describe ops, `aws_multi_region` fans the same op out across N regions in parallel, and a JMESPath `query` parameter trims responses server-side (useful when a `describe-instances` result would otherwise blow past the 5 MB output cap).
3. **Generic CRUD across services.** `aws_resource_*` (seven tools, including `aws_resource_diff` for dry-run previews) wraps AWS Cloud Control API, so the same lifecycle -- get / list / create / update / delete / status -- works for any control-plane resource with a CloudFormation schema: Lambda functions, S3 buckets, IAM roles, SSM parameters, RDS instances, and a few hundred more. Pass `awaitCompletion: true` and the server polls the async create/update/delete through to terminal state for you. CCAPI is control-plane only -- for data-plane ops (S3 reads, Lambda invokes, Bedrock inference, DynamoDB GetItem) drop down to `aws_call` or use a typed AWS Labs server.
4. **Live AWS docs.** `aws_docs_search` queries the same backend that powers the docs.aws.amazon.com search box; `aws_docs_read` fetches a doc page and returns it as paginated markdown. Lets the agent discover new services and look up exact parameter names without a second MCP server installed.
5. **Batched workflows in one round-trip.** `aws_script` runs a short JS snippet inside a constrained `node:vm` sandbox with `aws.call`, `aws.paginate`, `aws.paginateAll`, `aws.resource.*`, and `aws.logsTail` available. Best for "list X, fetch Y for each, return Z" pipelines that would otherwise need N tool calls. Same shape as AWS's `run_script` (Python, sandboxed server-side) -- yours is JS-native and runs locally.

[![Add to mcp.hosting](https://mcp.hosting/install-button.svg)](https://mcp.hosting/install?name=AWS&command=npx&args=-y%2C%40yawlabs%2Faws-mcp&env=AWS_PROFILE%2CAWS_REGION&description=Call%20any%20AWS%20API%20from%20one%20server%20-%20CCAPI%20CRUD%2C%20multi-region%2C%20SSO%20re-login&source=https%3A%2F%2Fgithub.com%2FYawLabs%2Faws-mcp)

One click adds this to your [mcp.hosting](https://mcp.hosting) account so it syncs to every MCP client you use. Or install manually below.

## Optional companion: AWS Labs per-service servers

For deep work in a single service -- typed `lambda_invoke`, Bedrock KB retrieval, DynamoDB with type-marshalling -- add the relevant [`awslabs/mcp`](https://github.com/awslabs/mcp) server alongside this one. Those are per-service helpers with no tool-name overlap, so they pair cleanly:

```json
{
  "mcpServers": {
    "aws": {
      "command": "npx",
      "args": ["-y", "@yawlabs/aws-mcp"]
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
| Live AWS docs search + read | **`@yawlabs/aws-mcp`** (`aws_docs_search` / `aws_docs_read`) |
| Node/npm-only install (no Python) | **`@yawlabs/aws-mcp`** |
| Sandboxed Python script execution server-side | **AWS MCP Server** (`run_script`) |
| AWS-team-curated best-practice skills | **AWS MCP Server** (skills) |
| Days-fresh API coverage via hosted endpoint | **AWS MCP Server** (`call_aws`) |
| Typed per-service helpers (Lambda invoke, Bedrock KB, DynamoDB type-marshalling, ...) | **`awslabs/mcp`** (per-service servers) |

`@yawlabs/aws-mcp` and AWS's official server are an either/or -- pick the one whose tradeoffs fit. `awslabs/mcp` per-service servers pair cleanly with whichever you pick.

## Tools

| Tool | What it does |
|------|--------------|
| `aws_whoami` | Current identity (account, ARN) + SSO token expiry countdown. Call this first. |
| `aws_login_start` | Start `aws sso login --no-browser`, returns a verification URL + 8-character code and a `sessionId`. |
| `aws_login_complete` | Block until the SSO subprocess finishes (you auth in your browser), returns the new identity. |
| `aws_refresh_if_expiring_soon` | Check the cached SSO token and auto-start a refresh when < `thresholdMinutes` remain (default 10). One round-trip for "am I about to expire? if so, re-login." |
| `aws_session_set` | Set the default profile and/or region for the rest of this MCP session. "Switch to prod," "use us-west-2." |
| `aws_session_get` | Show the current session defaults and where each value came from (`session`/`env`/`default`). |
| `aws_session_clear` | Remove session profile/region overrides so env vars / defaults take over again. No args clears both. |
| `aws_list_profiles` | List profiles configured in `~/.aws/config` -- names, regions, and SSO metadata. Use before switching profiles or when an SSO error names one you haven't seen. |
| `aws_assume_role` | Call STS AssumeRole with your current identity and stash the temp creds as a new profile (`mcp-<sessionName>`) in `~/.aws/credentials`. Use for cross-account access. The secret/session token stay on disk -- not returned to the model. |
| `aws_call` | Run any AWS API operation. `service: 's3api', operation: 'list-buckets'`, optional `params` (PascalCase JSON), optional `query` (JMESPath). Returns parsed JSON. |
| `aws_paginate` | Fetch one page of a paginated list/describe operation. Supports `query` too. Returns `nextToken`/`hasMore`; call again with the token to continue. |
| `aws_logs_tail` | Fetch recent CloudWatch Logs events for a log group. Wraps `aws logs tail --format json` with `since`, `filterPattern`, and stream-name filters; returns events as a parsed array. |
| `aws_resource_get` | Read an AWS resource via Cloud Control API by `typeName` + `identifier` (e.g. `AWS::Lambda::Function` + function name). Returns parsed Properties. |
| `aws_resource_list` | List resources of a type via CCAPI, paginated. Returns `{identifier, properties}` per entry plus a `nextToken`/`hasMore`. |
| `aws_resource_create` | Create an AWS resource via CCAPI. Async — returns top-level `requestToken` + `operationStatus`. Pass `awaitCompletion: true` to have the server poll to terminal state in one call. |
| `aws_resource_update` | Update an AWS resource via CCAPI using RFC 6902 JSON Patch. Same async + `awaitCompletion` shape as create. |
| `aws_resource_delete` | Delete an AWS resource via CCAPI. Same async + `awaitCompletion` shape as create. Destructive — verify `identifier` first. |
| `aws_resource_status` | Poll an async CCAPI request by `requestToken`. Returns the current state with `operationStatus`, `identifier`, `errorCode`, `statusMessage` flat-promoted (PENDING / IN_PROGRESS / SUCCESS / FAILED / CANCEL_*). |
| `aws_resource_diff` | Dry-run a CCAPI update: fetches current state, simulates the JSON Patch in memory, returns `{before, after, changes[]}`. No mutation sent to AWS. Supports the add/remove/replace subset of RFC 6902 -- enough for the vast majority of CCAPI updates. Call before `aws_resource_update` when you want to verify the patch does what you expect. |
| `aws_multi_region` | Run the same AWS operation across N regions in parallel. Same shape as `aws_call` but takes `regions: string[]`. Returns `{region, ok, data?, error?}[]` with `okCount`/`errorCount`. Partial failure is expected (services aren't everywhere, perms may be region-scoped). |
| `aws_script` | Run a short JS snippet that orchestrates the other tools and returns a combined result. Sandbox exposes `aws.call`, `aws.paginate`, `aws.paginateAll`, `aws.resource.{get,list,create,update,delete,status}`, `aws.logsTail`, plus `JSON`/`Math`/`Date`/`console`. Best for "list X, fetch Y for each, return Z" pipelines that would otherwise be N round-trips. Use `return <value>` to surface a result. Not a security sandbox -- treat the same as any other tool the model can call. |
| `aws_iam_simulate` | Simulate IAM permissions for a principal: can principal X do actions Y on resources Z? Wraps `iam simulate-principal-policy`. Returns one entry per (action, resource) pair with `decision` (allowed / explicitDeny / implicitDeny), `matchedStatementIds` (which IAM statements decided), and `missingContextValues` (context keys the policy needed but you didn't provide). Use BEFORE a risky operation to avoid a 403 -- pairs with the post-failure Suggestion from aws_call. Requires `iam:SimulatePrincipalPolicy` on the caller. |
| `aws_docs_search` | Search live AWS documentation (the backend behind the docs.aws.amazon.com search box). Returns ranked `{title, url, summary, excerpt}`. Use to discover the right doc page for a service/API/concept the model may not know -- new services, recently changed APIs, exact parameter names. |
| `aws_docs_read` | Fetch an `https://docs.aws.amazon.com/...html` page and return it as markdown. Strips nav/cookie-banner/feedback chrome. Long pages paginate via `startIndex` + `maxLength`; the response carries `hasMore` and `nextStartIndex`. Usually fed a url from `aws_docs_search`. |

## Install

```bash
npm install -g @yawlabs/aws-mcp
```

Or add to your MCP client config (e.g. `.mcp.json`):

```json
{
  "mcpServers": {
    "aws": {
      "command": "npx",
      "args": ["-y", "@yawlabs/aws-mcp"]
    }
  }
}
```

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

- Node.js 22+
- AWS CLI v2 installed and on `PATH` (for `aws sso login --no-browser`)
- An AWS profile configured for SSO / IAM Identity Center in `~/.aws/config`

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `AWS_PROFILE` | `default` | Profile used when a tool call omits `profile`. |
| `AWS_REGION` / `AWS_DEFAULT_REGION` | `us-east-1` | Region for STS calls. |

## How the SSO login flow works

```
1. Claude calls aws_login_start({ profile: "prod" })
2. Server spawns: aws sso login --no-browser --profile prod
3. Server parses the URL + code from stdout, returns them to Claude
4. Claude surfaces: "Open https://device.sso.us-east-1.amazonaws.com/ and enter ABCD-EFGH"
5. You click — browser opens in your own user session — auth in ~10 seconds
6. Claude calls aws_login_complete({ sessionId })
7. Tool returns your new identity. Back to work.
```

The token is cached in `~/.aws/sso/cache/<hash>.json` the same way a normal `aws sso login` would, so the AWS CLI, the SDK, and every other tool on your machine pick it up transparently.

## Why this server must run locally (not on mcp.hosting)

SSO tokens live in `~/.aws/sso/cache/` on *your* device. A remote MCP server can't read them. So this is a stdio server, not a hosted one. That's a constraint of AWS SSO, not a limitation of mcp.hosting.

## License

MIT
