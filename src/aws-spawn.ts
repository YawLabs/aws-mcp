/**
 * Spawn policy for every `aws` child this server starts: which binary runs, and
 * what environment it runs in.
 *
 * Both halves are pure functions with the platform and the file-system probe as
 * parameters, so each platform's rules are unit-tested on one machine (this repo
 * has no CI, so a POSIX-only branch would otherwise be tested by nobody).
 *
 * Why the environment needs pinning: the CLI reads its own behavior out of the
 * user's ~/.aws/config, and some of those settings break this server rather than
 * the user's terminal -- the caller gets a misclassified error, a call that never
 * reaches AWS, or output with the non-ASCII characters replaced. PINNED_CLI_ENV
 * documents each one against a measurement. The pins go on last, so no caller
 * can lose them.
 *
 * Why the binary needs resolving: `spawn("aws")` on Windows runs an `aws.exe`
 * from the WORKING DIRECTORY before it looks at PATH (libuv's search_path, when
 * `NoDefaultCurrentDirectoryInExePath` is unset in the parent -- reproduced here
 * on Node 22.22.2), and the working directory belongs to the MCP host, not to us.
 * The same hosts that could plant one -- started from a GUI, inheriting no shell
 * PATH -- are also the ones where `aws` is on no PATH at all, and until now the
 * only override was a test-only env var. resolveAwsCommand answers both: an
 * absolute path or a refusal, never a bare name.
 */

import { accessSync, constants, statSync } from "node:fs";
import { posix as posixPath, win32 as win32Path } from "node:path";

/**
 * Production override for the aws binary (the test seams stay separate; see
 * resolveAwsCommand's `explicit`).
 */
export const AWS_CLI_OVERRIDE_ENV = "AWS_MCP_AWS_CLI";

/**
 * CLI settings pinned in the child environment on every platform.
 *
 * Environment variables rather than flags, because the flags do not exist on
 * older CLIs: `--cli-error-format enhanced` on the local 2.22.0 exits **252**
 * with `Unknown options: --cli-error-format, enhanced` and never parses the
 * command, while an unknown env var is simply ignored (2.22.0 with
 * `AWS_CLI_ERROR_FORMAT=json` answered in its legacy format, unchanged). The env
 * var beats the user's config -- measured, `cli_error_format = json` in config
 * plus `AWS_CLI_ERROR_FORMAT=enhanced` in the environment gave the enhanced
 * format -- and only a flag on argv could beat the env var, which no user input
 * can become (service and operation tokens are SAFE_NAME_RE-validated, params
 * travel inside --cli-input-json).
 *
 * - `AWS_CLI_ERROR_FORMAT=enhanced` (the variable exists from aws-cli 2.34.0;
 *   values legacy, json, yaml, text, table, enhanced). Measured against a
 *   loopback stub answering 403 InvalidClientTokenId: with `cli_error_format =
 *   json` in config, 2.34.3 printed `{"Type": ..., "Code": ..., "Message": ...}`
 *   and NOT the `An error occurred (Code) when calling the Op operation:` line
 *   that every pattern in errors.ts anchors on -- so such a user's invalid or
 *   expired token comes back as a bare `nonzero_exit` with no suggestion.
 *   `enhanced` is also today's default, so pinning it changes nothing for a user
 *   with no such config.
 * - `AWS_CLI_AUTO_PROMPT=off`. With `cli_auto_prompt = on` in config, both local
 *   CLIs exit 255 without sending a request -- measured against a loopback
 *   endpoint: `Found xterm-256color, while expecting a Windows console`, zero
 *   connections. Every call is dead for such a user, `aws sso login` included.
 *   The env var restores the call on both.
 * - `AWS_CLI_OUTPUT_ENCODING=utf-8` (exists from aws-cli 2.24.14) and
 *   `PYTHONUTF8=1`. This server decodes the child's output as UTF-8; the CLI
 *   writes the locale's code page, which on Windows is not UTF-8. Measured with
 *   `日本-é` in the CLI's own message: with no pin, both local CLIs wrote
 *   `\u65e5\u672c-` plus a lone 0xE9 (cp1252 `é`), which our UTF-8 decode turns
 *   into U+FFFD -- silent corruption of any CJK S3 key, tag value or log line.
 *   With the encoding pin 2.34.3 wrote exact UTF-8; 2.22.0 ignored it (it
 *   predates 2.24.14) and needed `PYTHONUTF8=1`, which fixed both. Hence both.
 *
 * `PYTHONUTF8=1` has a disclosed side effect on CLIs before 2.25.0, which are
 * frozen with a PyInstaller that honors it for the whole interpreter rather than
 * for output alone: it also switches how the CLI DECODES ~/.aws/config,
 * ~/.aws/credentials and `file://` params, from the code page to UTF-8. A
 * code-page-encoded non-ASCII byte in one of those files starts failing every
 * call (and a UTF-8 byte undefined in the code page starts working). Accepted
 * and documented in the CHANGELOG and the README: the corruption above hits
 * every Windows install on any non-ASCII output, current editors save UTF-8,
 * this server's own aws_assume_role writes the credentials file as UTF-8, and
 * UTF-8 mode is Python's own default from 3.15.
 *
 * Deliberately NOT here: `AWS_MAX_ATTEMPTS`. tools/lambda.ts pins that to "1"
 * for its own spawns (invokeChildEnv) so a Lambda is never invoked twice, and
 * awsChildEnv layers on top of whatever the caller passed. A pin for it here
 * would silently take that guarantee away; aws-spawn.test.ts holds the
 * invariant.
 */
export const PINNED_CLI_ENV: Readonly<Record<string, string>> = {
  AWS_CLI_ERROR_FORMAT: "enhanced",
  AWS_CLI_AUTO_PROMPT: "off",
  AWS_CLI_OUTPUT_ENCODING: "utf-8",
  PYTHONUTF8: "1",
};

/**
 * Pinned only on win32: stop the CLI's OWN children resolving from the working
 * directory the same way ours would. `aws ssm start-session` hands off to
 * `session-manager-plugin` by bare name (reachable from aws_call), and a
 * `credential_process` can name a bare command too. Resolving our own spawn does
 * not cover either -- libuv reads the variable from the PARENT env of the process
 * doing the search, so the CLI needs it in its own environment.
 */
export const WIN32_PINNED_CLI_ENV = { NoDefaultCurrentDirectoryInExePath: "1" } as const;

/**
 * Read one variable out of an arbitrary environment object the way the platform
 * would: exact key on POSIX, case-insensitively on win32. A value of `undefined`
 * counts as unset, which is what node does with it at spawn time.
 *
 * `process.env` is already case-insensitive on Windows, but a plain object is
 * not (measured: `{Path: "..."}.PATH` is undefined), and every caller here may
 * hand us `opts.env` rather than `process.env`.
 */
export function envLookup(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct;
  if (platform !== "win32") return undefined;
  const wanted = name.toUpperCase();
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() !== wanted) continue;
    const value = env[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * The environment for one aws child: a copy of `base` with the pins layered on
 * top.
 *
 * Layered rather than merged into the parent, because runAwsCall's `env`
 * REPLACES the parent environment (node's spawn semantics; see
 * AwsCallOptions.env). So a caller that builds its own environment -- the
 * per-account credentials of aws_multi_account, the AWS_MAX_ATTEMPTS=1 of a
 * Lambda invoke -- keeps everything it put there, and the pins still win.
 *
 * On win32 every case-variant of a pinned name is deleted before the pins go on.
 * Windows itself treats environment names case-insensitively, but a JS object
 * does not, so `{aws_cli_error_format: "json", AWS_CLI_ERROR_FORMAT: "enhanced"}`
 * is a real possibility and which one the child sees depends on the runtime:
 * node 22.22.2 hands over the upper-case one whatever the insertion order, while
 * oam 0.16.2 -- the runtime the published binary uses -- hands over the LAST key
 * in the object (both measured, both directions). Deleting is what makes the
 * result the same either way.
 */
export function awsChildEnv(
  base: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const pins: Record<string, string> =
    platform === "win32" ? { ...PINNED_CLI_ENV, ...WIN32_PINNED_CLI_ENV } : { ...PINNED_CLI_ENV };
  if (platform === "win32") {
    const pinned = new Set(Object.keys(pins).map((key) => key.toUpperCase()));
    for (const key of Object.keys(env)) {
      if (pinned.has(key.toUpperCase())) delete env[key];
    }
  }
  return Object.assign(env, pins);
}

/**
 * Where the command came from. `display` is what goes into the `command` string
 * the caller sees: `aws` for a resolved path (the absolute path is noise, and for
 * the override it is the user's own file layout), the literal for a test seam.
 */
export type AwsCommandResolution =
  | { ok: true; command: string; display: string; source: "explicit" | "override" | "path" }
  | { ok: false; error: string };

/**
 * File-system question the resolver asks about one absolute candidate: `null`
 * when nothing is there (or the stat failed), otherwise whether it is a regular
 * file and whether the OS would let us execute it. Injectable so the tests can
 * drive either platform's rules from one machine.
 */
export type PathProbe = (absPath: string) => { isFile: boolean; executable: boolean } | null;

/**
 * The real probe. `executable` is only asked on POSIX: on Windows
 * accessSync(X_OK) is granted for any readable file (measured on a plain .txt),
 * so it would answer yes for everything and mean nothing. Windows decides by
 * extension instead -- see the `.exe` rule below.
 */
function fsProbe(platform: NodeJS.Platform): PathProbe {
  return (absPath) => {
    try {
      const stat = statSync(absPath, { throwIfNoEntry: false });
      if (stat === undefined) return null;
      if (!stat.isFile()) return { isFile: false, executable: false };
      if (platform === "win32") return { isFile: true, executable: true };
      try {
        accessSync(absPath, constants.X_OK);
        return { isFile: true, executable: true };
      } catch {
        return { isFile: true, executable: false };
      }
    } catch {
      return null;
    }
  };
}

/**
 * A drive-absolute Windows path (`C:\tools`, `C:/tools`). Deliberately narrower
 * than path.win32.isAbsolute, which also accepts the root-relative `\tools` --
 * and `\tools` is not a fixed location: it resolves against the CURRENT DRIVE
 * (measured: resolve("\\tools") is "C:\tools" only because the cwd is on C:).
 */
const WIN32_DRIVE_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/;
/** A UNC path (`\\server\share\...`). The other spelling win32 calls absolute. */
const WIN32_UNC_RE = /^\\\\[^\\]/;
/** Windows PATH entries are frequently pasted quoted; the quotes are not part of the path. */
const SURROUNDING_QUOTES_RE = /^"(.*)"$/;

function unquote(value: string): string {
  return value.replace(SURROUNDING_QUOTES_RE, "$1");
}

function isAbsoluteFor(value: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? WIN32_DRIVE_ABSOLUTE_RE.test(value) || WIN32_UNC_RE.test(value) : value.startsWith("/");
}

/**
 * Resolve the aws binary to an absolute path, or explain why we will not run
 * anything. Never falls back to the bare name `aws`: that fallback is exactly
 * the planted-binary case on a host with no CLI on PATH.
 *
 * Precedence: `explicit` (the opts.command / AWS_MCP_TEST_AWS_COMMAND test
 * seams, passed through verbatim so every existing test keeps its shape) >
 * AWS_MCP_AWS_CLI > a walk of the child environment's PATH. The child's PATH,
 * not the parent's, because that is the one libuv would have searched (measured:
 * a bare name resolved out of a directory that appeared only in the child env's
 * PATH).
 *
 * Not cached. A walk of this host's 58-entry PATH costs 0.47-1.16 ms (20 runs,
 * median 0.56), against a CLI start of hundreds of milliseconds, and an uncached
 * walk cannot go stale after an install or an `aws update`.
 */
export function resolveAwsCommand(opts: {
  explicit?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  probe?: PathProbe;
}): AwsCommandResolution {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const probe = opts.probe ?? fsProbe(platform);

  // Verbatim, no checks: these are in-process test seams, and a test's fake is
  // often a script path or a deliberately nonexistent name. A blank value is
  // treated as unset rather than spawned -- the one shape that could only be a
  // mistake.
  const explicit = opts.explicit?.trim();
  if (explicit !== undefined && explicit !== "") {
    return { ok: true, command: opts.explicit as string, display: opts.explicit as string, source: "explicit" };
  }

  const overrideRaw = envLookup(env, AWS_CLI_OVERRIDE_ENV, platform)?.trim();
  if (overrideRaw !== undefined && overrideRaw !== "") {
    return resolveOverride(unquote(overrideRaw), platform, probe);
  }

  return resolveFromPath(env, platform, probe);
}

/**
 * Validate AWS_MCP_AWS_CLI. An unusable value fails loudly rather than falling
 * back to PATH: this variable picks which binary handles the user's credentials,
 * and quietly running a different one than the operator configured is the wrong
 * failure. Each message names the variable so the fix is obvious.
 *
 * The name check comes before the existence check on win32 so that a `.cmd` path
 * gets told what is actually wrong with it whether or not the file is there.
 */
function resolveOverride(value: string, platform: NodeJS.Platform, probe: PathProbe): AwsCommandResolution {
  if (!isAbsoluteFor(value, platform)) {
    return {
      ok: false,
      error: `${AWS_CLI_OVERRIDE_ENV} must be an absolute path to the aws executable; got '${value}'.`,
    };
  }
  if (platform === "win32" && !/\.exe$/i.test(value)) {
    return {
      ok: false,
      error: `${AWS_CLI_OVERRIDE_ENV} must point at an .exe (aws.exe for a standard install); a .cmd or .bat shim cannot be started without a shell.`,
    };
  }
  const stat = probe(value);
  if (stat === null || !stat.isFile) {
    return { ok: false, error: `${AWS_CLI_OVERRIDE_ENV} points at '${value}', which does not exist or is not a file.` };
  }
  if (platform !== "win32" && !stat.executable) {
    return { ok: false, error: `${AWS_CLI_OVERRIDE_ENV} points at '${value}', which is not executable.` };
  }
  return { ok: true, command: value, display: "aws", source: "override" };
}

/**
 * Walk the absolute directories on PATH for the aws binary.
 *
 * Only absolute entries are considered, which drops the ones that would resolve
 * against a directory we do not control: empty, `.`, a relative `bin`, a
 * drive-relative `C:foo`, a root-relative `\tools`, an unexpanded `%X%\bin`.
 * Skipping them is the whole point of the walk -- searching them here would
 * reintroduce by hand the cwd search that resolving an absolute path removes.
 *
 * win32 looks for `aws.exe` only. Node refuses to start a `.cmd` or `.bat` by
 * path with no shell (measured: a synchronous EINVAL from both spawn and
 * spawnSync), while oam 0.16.2 runs the same path through cmd.exe -- so the same
 * shim would be a hard error on one runtime and a shell-quoted JSON argv on the
 * other. Executability is not consulted on win32 (see fsProbe).
 */
function resolveFromPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, probe: PathProbe): AwsCommandResolution {
  const isWin32 = platform === "win32";
  const binary = isWin32 ? "aws.exe" : "aws";
  const join = isWin32 ? win32Path.join : posixPath.join;
  const dirs: string[] = [];
  for (const entry of (envLookup(env, "PATH", platform) ?? "").split(isWin32 ? ";" : ":")) {
    const dir = unquote(entry.trim());
    if (dir !== "" && isAbsoluteFor(dir, platform)) dirs.push(dir);
  }

  for (const dir of dirs) {
    const candidate = join(dir, binary);
    const stat = probe(candidate);
    if (stat?.isFile && (isWin32 || stat.executable)) {
      return { ok: true, command: candidate, display: "aws", source: "path" };
    }
  }

  // Only once the walk has failed do we pay for the shim probes: a pip-installed
  // AWS CLI v1 leaves an `aws.cmd`, and "found one, it is a shim" is a much
  // better answer than "found nothing".
  let shim: string | null = null;
  if (isWin32) {
    for (const dir of dirs) {
      for (const name of ["aws.cmd", "aws.bat"]) {
        const candidate = join(dir, name);
        if (probe(candidate)?.isFile) {
          shim = candidate;
          break;
        }
      }
      if (shim !== null) break;
    }
  }

  const found =
    shim === null
      ? ""
      : ` Found ${shim}, a script shim (a pip-installed AWS CLI v1 leaves one), which cannot be started without a shell; install AWS CLI v2.`;
  return {
    ok: false,
    error:
      `Could not find the AWS CLI: no ${binary} in any of the ${dirs.length} absolute directories on this server's ` +
      `PATH (the working directory is never searched). MCP hosts started from a GUI often do not inherit your shell's ` +
      `PATH: run 'where.exe aws' (Windows) or 'command -v aws' (macOS/Linux) in a terminal and set ` +
      `${AWS_CLI_OVERRIDE_ENV} to that absolute path in this server's env block, or add its directory to PATH there.` +
      found,
  };
}

/**
 * True if the CLI would read a `file://` path we mint under this directory as
 * itself. The CLI runs `expandvars(expanduser(path))` on a paramfile path
 * (awscli/paramfile.py), so a `$` or `%` in it becomes a variable lookup and a
 * LEADING `~` becomes the home directory. An 8.3 short name such as `JEFF~1` is
 * fine: only a leading tilde expands.
 *
 * Checked before writing rather than after failing, so the caller gets a message
 * naming TMP/TEMP instead of a CLI error about a path it never wrote.
 */
export function isCliSafeFilePath(p: string): boolean {
  return !/[$%]/.test(p) && !p.startsWith("~");
}
