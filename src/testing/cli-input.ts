/**
 * Read the `--cli-input-json` payload out of a fake-aws argv, whether it was
 * passed inline or as a `file://` / `fileb://` path.
 *
 * Test-only, and shared on purpose: several fake scenarios and the real-CLI
 * suites need the same answer, and the payload can arrive two ways.
 * `runAwsCall` sends params inline, but past a threshold it writes them to a
 * private temp file and passes `--cli-input-json file://<path>` instead, so a
 * scenario that only ever did `argv[argv.indexOf("--cli-input-json") + 1]`
 * would silently start parsing the literal string "file://C:\\...".
 *
 * What the real CLI does with the same argv (awscli/paramfile.py,
 * LOCAL_PREFIX_MAP, and awscli/customizations/cliinput.py in 2.34.3):
 *   - `file://` is read as TEXT through compat_open, which uses the locale's
 *     preferred encoding -- the ANSI code page on Windows, not UTF-8. This
 *     helper decodes UTF-8, so keep such a file ASCII-only, where the two
 *     agree; a cp1252-vs-UTF-8 difference is a real CLI behavior that belongs
 *     in a real-CLI test, not something a fake should imitate.
 *   - `fileb://` is read as BYTES and handed to `json.loads`, which decodes
 *     UTF-8 itself. `bytes` is exposed so a scenario can assert on the exact
 *     bytes it was sent.
 *   - the path goes through `expandvars(expanduser(...))` first. This helper
 *     reads it literally, so pass an absolute path with no `~`, `$VAR` or
 *     `%VAR%` in it.
 *
 * Every failure throws with a `fake-aws:` prefix: inside the fake these become
 * stderr the calling test can read, and the message has to say which of the
 * three went wrong (no value, unreadable file, invalid JSON) or the test just
 * sees a nonzero exit.
 */

import { readFileSync } from "node:fs";

export interface CliInputJson {
  /** How the payload arrived. */
  source: "inline" | "file" | "fileb";
  /** The file the payload was read from, or null when it was inline. */
  path: string | null;
  /** The file's exact bytes, or null when the payload was inline. */
  bytes: Buffer | null;
  /** The payload as text: the argv entry itself, or the file decoded as UTF-8. */
  text: string;
  /** The parsed payload. `unknown` on purpose -- callers assert the shape they expect. */
  params: unknown;
}

const FILE_PREFIX = "file://";
const FILEB_PREFIX = "fileb://";

function parseJson(text: string, origin: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`fake-aws: ${origin} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Null when argv carries no `--cli-input-json` at all -- a caller that requires
 * one should say so itself, since "no params" is legitimate for most calls.
 */
export function readCliInputJson(argv: readonly string[]): CliInputJson | null {
  const idx = argv.indexOf("--cli-input-json");
  if (idx === -1) return null;
  const value = argv[idx + 1];
  if (value === undefined) {
    throw new Error("fake-aws: --cli-input-json is the last argv entry, with no value after it");
  }

  const source = value.startsWith(FILEB_PREFIX) ? "fileb" : value.startsWith(FILE_PREFIX) ? "file" : "inline";
  if (source === "inline") {
    return { source, path: null, bytes: null, text: value, params: parseJson(value, "the --cli-input-json value") };
  }

  const path = value.slice(source === "fileb" ? FILEB_PREFIX.length : FILE_PREFIX.length);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    throw new Error(
      `fake-aws: could not read the --cli-input-json ${source}:// file '${path}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const text = bytes.toString("utf8");
  return { source, path, bytes, text, params: parseJson(text, `the --cli-input-json file '${path}'`) };
}
