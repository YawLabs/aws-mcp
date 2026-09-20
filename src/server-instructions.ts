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
 * The server `instructions` block this module is named for lands in 2.5.0, with
 * its own tighter ceiling (it is paid on every session, not once per tool load).
 * Today the cap is the only export, and only the test imports it.
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
 * and the gate is merely conservative otherwise -- aws_call's and
 * aws_assume_role's descriptions each carry one em-dash (3 bytes, 1 unit), so
 * they measure 2 bytes above what the host counts.
 */
export const HOST_TEXT_CAP_BYTES = 2048;
