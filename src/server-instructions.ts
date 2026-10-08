/**
 * The budget for text this server hands a host to put in front of the model.
 *
 * Hosts cut that text silently -- no warning to the server, nothing in the
 * response -- so the limit lives here as a named constant with its measurement
 * written down, and `src/index.test.ts` holds every tool description to it. A
 * description that grows past the cap is not a style problem: the host drops its
 * END, which is where a "this is billed", "this is not a security boundary" or
 * "this never stops the query" sentence usually sits.
 *
 * The server `instructions` block this module is named for is SERVER_INSTRUCTIONS
 * below, with its own tighter ceiling (it is paid on every session, not once per
 * tool load). src/index.ts hands it to the McpServer; src/index.test.ts holds it
 * to SERVER_INSTRUCTIONS_CAP_BYTES and the descriptions to HOST_TEXT_CAP_BYTES.
 */

/**
 * The largest a single tool description may be before Claude Code truncates it.
 *
 * Measured in the installed Claude Code 2.1.272 binary (read-only scan): a
 * single `Io(text, label, server)` helper is applied both to each tool
 * description (`Tool "<name>" description`) and to the server instructions
 * (`Server instructions`); it returns the text unchanged while
 * `text.length <= OR`, and otherwise logs `<label> truncated from <n> to <OR>
 * chars` to the MCP debug log alone and returns the text cut to `OR` with an
 * ellipsis and " [truncated]" appended. `OR` is 2048.
 *
 * That comparison is on `.length`, i.e. UTF-16 code units, and this gate
 * measures UTF-8 BYTES, which are never fewer for the same text (a BMP
 * character is 1-3 bytes for 1 unit, an astral character 4 bytes for 2 units).
 * So text within this bound is never cut. The two counts are equal for ASCII,
 * and the gate is merely conservative otherwise -- today exactly one
 * description carries a non-ASCII character at all: aws_assume_role's single
 * em-dash (3 bytes, 1 unit), so it measures 2 bytes above what the host counts
 * (701 against 699). A one-line scan of the built bundle re-checks that, which
 * is why the claim is framed as a count rather than a list.
 */
export const HOST_TEXT_CAP_BYTES = 2048;

/**
 * The ceiling for SERVER_INSTRUCTIONS, tighter than HOST_TEXT_CAP_BYTES. yaw-mcp,
 * which fronts this server for most of its users, renders an upstream server's
 * instructions once per session and cuts them at 2000 UTF-8 bytes
 * (MAX_UPSTREAM_INSTRUCTIONS_BYTES in its src/upstream-instructions.ts), so text
 * past that is lost there before Claude Code's own 2048-character cut applies.
 */
export const SERVER_INSTRUCTIONS_CAP_BYTES = 2000;

/**
 * The MCP `instructions` string: which tool to reach for, nothing else. Plain
 * ASCII, routing guidance only -- every behavioural detail lives in the tool
 * descriptions, which are loaded with the tools. Held to
 * SERVER_INSTRUCTIONS_CAP_BYTES by src/index.test.ts.
 */
export const SERVER_INSTRUCTIONS = [
  "AWS through the locally installed aws CLI, using the caller's own profiles.",
  "Start with aws_whoami to confirm the identity and SSO token; if it reports an expired SSO session, use aws_login_start then aws_login_complete; aws_refresh_if_expiring_soon renews it ahead of a long task. aws_list_profiles lists profiles; aws_session_set pins a profile and region for later calls (aws_session_get shows them, aws_session_clear resets).",
  "Any single API operation: aws_call. One page of a list or describe operation: aws_paginate. The same operation across regions or accounts: aws_multi_region or aws_multi_account. Many dependent calls with filtering or aggregation: aws_script, one snippet instead of many round trips.",
  "Resources by CloudFormation type name (AWS::Service::Resource): aws_resource_list and aws_resource_get to read; aws_resource_diff to preview a patch before aws_resource_update; aws_resource_create and aws_resource_delete; aws_resource_status to poll a change those return.",
  "Logs: aws_logs_tail for recent lines, aws_logs_query for CloudWatch Logs Insights. Metrics: aws_metrics_query. Permissions: aws_iam_simulate. Lambda: aws_lambda_invoke. Temporary role credentials as a named profile: aws_assume_role.",
  "AWS documentation: aws_docs_search, then aws_docs_read on a result.",
].join("\n");
