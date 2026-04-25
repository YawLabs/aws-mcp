# @yawlabs/aws-mcp

A minimal AWS MCP for AI assistants: **one server, one config entry, SSO re-auth baked in.**

Not a comprehensive per-service AWS MCP. For typed tools per service (Lambda, DynamoDB, IAM, Bedrock, ...) use AWS Labs' fleet at [`awslabs/mcp`](https://github.com/awslabs/mcp). Reach for this package when you want a single `.mcp.json` entry that handles the common AWS cases — and closes the SSO re-auth gap AWS Labs' servers don't cover.

Two things most AWS-from-assistant setups fumble:

1. **SSO re-login.** When your token expires mid-session, `aws sso login` tries to open a browser from a subprocess — and on Windows (and sometimes elsewhere) that handoff drops silently. You end up context-switching to a terminal, running the command yourself, then coming back. This server fixes that with the `--no-browser` device-code flow: the AI surfaces a short URL + code, you click once, done.
2. **Every AWS API operation.** `aws_call` proxies the `aws` CLI directly — one tool covers the entire surface, no SDK bundling, no service-by-service tool sprawl.

## When to reach for this vs AWS Labs' servers

**Use `@yawlabs/aws-mcp` when:**

- You want **one MCP entry** in `.mcp.json` that handles day-to-day AWS, not a fleet to configure per service.
- You hit **SSO token expiry mid-session** on Windows (or anywhere `aws sso login`'s browser handoff drops). This is the specific gap this server was built for; AWS Labs' servers assume credentials are already present.
- You need to call a **new or obscure AWS service** the day AWS adds it to the CLI — no waiting on a per-service MCP to ship.
- Your stack is **Node/npm** and you don't want Python + `uvx` in the loop.
- You want a **small footprint** — one esbuild bundle, no per-service SDK weight.

**Use AWS Labs' per-service servers ([`awslabs/mcp`](https://github.com/awslabs/mcp)) when:**

- You're doing **deep work in one service** (Lambda, DynamoDB, Bedrock, IAM, ...) and want typed, service-specific helpers (`lambda_invoke`, Bedrock KB retrieval, DynamoDB with type-marshalling, ...) that a generic CLI passthrough doesn't provide.
- You need **data-plane operations** (streaming reads, inference, large binary I/O) where a typed SDK matters more than a CLI string.
- **Enterprise compliance** requires first-party-only tooling.

The two aren't mutually exclusive — this server can sit alongside AWS Labs' per-service servers in the same `.mcp.json` if your workflow wants both.

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
| `aws_resource_create` | Create an AWS resource via CCAPI. Async — returns a `RequestToken`; poll `aws_resource_status` until complete. |
| `aws_resource_update` | Update an AWS resource via CCAPI using RFC 6902 JSON Patch. Async — returns a `RequestToken`; poll `aws_resource_status`. |
| `aws_resource_delete` | Delete an AWS resource via CCAPI. Async — returns a `RequestToken`; poll `aws_resource_status`. Destructive; verify `identifier` first. |
| `aws_resource_status` | Poll an async CCAPI request by `requestToken`. Returns the current ProgressEvent (PENDING / IN_PROGRESS / SUCCESS / FAILED / CANCEL_*). |

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
