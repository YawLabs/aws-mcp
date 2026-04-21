# @yawlabs/aws-mcp

AWS MCP server focused on one pain point: **AWS SSO re-login from inside an AI assistant.**

When your SSO token expires mid-session, `aws sso login` tries to open a browser from a subprocess — and on Windows (and sometimes elsewhere) that handoff drops silently. You end up context-switching to a terminal, running the command yourself, then coming back. This server fixes that with the `--no-browser` device-code flow: the AI surfaces a short URL + code, you click once, done.

## Tools

| Tool | What it does |
|------|--------------|
| `aws_whoami` | Current identity (account, ARN) + SSO token expiry countdown. Call this first. |
| `aws_login_start` | Start `aws sso login --no-browser`, returns a verification URL + 8-character code and a `sessionId`. |
| `aws_login_complete` | Block until the SSO subprocess finishes (you auth in your browser), returns the new identity. |

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

## Requirements

- Node.js 18+
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
