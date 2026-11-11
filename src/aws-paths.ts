import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the AWS CLI's shared files live, resolved the way botocore does it.
 *
 * botocore reads AWS_CONFIG_FILE and AWS_SHARED_CREDENTIALS_FILE before
 * falling back to ~/.aws/config and ~/.aws/credentials, and its
 * configloader.raw_config_parse runs os.path.expandvars() and then
 * os.path.expanduser() on the value. Every in-process read or write of those
 * files must resolve through here, so the server and the `aws` subprocess it
 * spawns -- which inherits the same environment -- always agree on the file. A
 * one-process-per-user deployment that points these variables at per-user files
 * depends on that agreement.
 *
 * Fidelity points that matter, each matching botocore:
 * - Only an UNSET variable falls back to the default. A set-but-empty value is
 *   a path too: the CLI then loads no config file at all, and falling back to
 *   ~/.aws/config here would show the process owner's profiles that the CLI
 *   cannot use. Callers must handle "" (it never names a readable file).
 * - The value is not trimmed; botocore uses it as given.
 * - `$NAME` / `${NAME}` (and `%NAME%` on Windows) are expanded before `~`. MCP
 *   host env blocks are not shell-expanded, so "$HOME/.aws/alt" reaches both
 *   processes literally and the CLI expands it.
 *
 * Both are read per call, never cached: the environment is the configuration.
 */
export function resolveAwsConfigPath(): string {
  return fromEnvOrDefault(process.env.AWS_CONFIG_FILE, "config");
}

export function resolveAwsCredentialsPath(): string {
  return fromEnvOrDefault(process.env.AWS_SHARED_CREDENTIALS_FILE, "credentials");
}

function fromEnvOrDefault(raw: string | undefined, basename: string): string {
  if (raw === undefined) return join(homedir(), ".aws", basename);
  return expandUser(expandVars(raw));
}

/**
 * Python's os.path.expandvars: replace `$NAME` and `${NAME}` (and `%NAME%` on
 * Windows, as ntpath does) with the variable's value, leaving a reference to an
 * unset variable exactly as written. NAME is ASCII letters, digits and `_`.
 * Exported for tests.
 */
export function expandVars(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
  win32 = process.platform === "win32",
): string {
  if (!value.includes("$") && !(win32 && value.includes("%"))) return value;
  // One pass, so a substituted value is never itself expanded again -- Python
  // scans left to right the same way.
  const re = win32
    ? /\$\{([A-Za-z0-9_]+)\}|\$([A-Za-z0-9_]+)|%([A-Za-z0-9_]+)%/g
    : /\$\{([A-Za-z0-9_]+)\}|\$([A-Za-z0-9_]+)/g;
  return value.replace(re, (whole, braced?: string, bare?: string, pct?: string) => {
    const v = env[(braced ?? bare ?? pct) as string];
    return v === undefined ? whole : v;
  });
}

/** os.path.expanduser for the forms botocore users write: `~`, `~/x`, `~\x`. */
function expandUser(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}
