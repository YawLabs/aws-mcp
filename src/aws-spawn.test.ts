import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  AWS_CLI_OVERRIDE_ENV,
  awsChildEnv,
  envLookup,
  isCliSafeFilePath,
  type PathProbe,
  PINNED_CLI_ENV,
  resolveAwsCommand,
  WIN32_PINNED_CLI_ENV,
} from "./aws-spawn.js";
import { invokeChildEnv } from "./tools/lambda.js";

// A whole file system described as path -> what the probe answers, so both
// platforms' walk rules run on whichever machine the suite is on (there is no
// CI, and half of these rules would otherwise be tested by nobody). Anything not
// listed is absent. Defaults are the common case: a regular, executable file.
function probeFor(files: Record<string, { isFile?: boolean; executable?: boolean }>): PathProbe {
  return (absPath) => {
    const entry = files[absPath];
    if (entry === undefined) return null;
    return { isFile: entry.isFile ?? true, executable: entry.executable ?? true };
  };
}

/** A probe that fails the test if the resolver consults the file system at all. */
const noProbe: PathProbe = (absPath) => assert.fail(`probe should not have been called, got ${absPath}`);

type Resolution = ReturnType<typeof resolveAwsCommand>;

function ok(resolution: Resolution): Extract<Resolution, { ok: true }> {
  assert.equal(resolution.ok, true, `expected a resolution, got ${JSON.stringify(resolution)}`);
  return resolution as Extract<Resolution, { ok: true }>;
}

function failed(resolution: Resolution): Extract<Resolution, { ok: false }> {
  assert.equal(resolution.ok, false, `expected a refusal, got ${JSON.stringify(resolution)}`);
  return resolution as Extract<Resolution, { ok: false }>;
}

describe("awsChildEnv", () => {
  it("layers the pins on top of the caller's environment", () => {
    const env = awsChildEnv(
      { PATH: "/usr/bin", AWS_ACCESS_KEY_ID: "AKIAEXAMPLE", HTTPS_PROXY: "http://proxy" },
      "linux",
    );
    assert.equal(env.AWS_CLI_ERROR_FORMAT, "enhanced");
    assert.equal(env.AWS_CLI_AUTO_PROMPT, "off");
    assert.equal(env.AWS_CLI_OUTPUT_ENCODING, "utf-8");
    assert.equal(env.PYTHONUTF8, "1");
    // Everything the caller put there survives -- aws_multi_account's per-account
    // credentials travel this way, and the resolver reads PATH back out of it.
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.AWS_ACCESS_KEY_ID, "AKIAEXAMPLE");
    assert.equal(env.HTTPS_PROXY, "http://proxy");
  });

  it("never mutates the base it was handed", () => {
    const base = { PATH: "/usr/bin", AWS_CLI_ERROR_FORMAT: "json" };
    awsChildEnv(base, "win32");
    assert.deepEqual(base, { PATH: "/usr/bin", AWS_CLI_ERROR_FORMAT: "json" });
  });

  it("overrides the caller's own value for every pinned name", () => {
    // These four are exactly the settings a user's ~/.aws/config can set against
    // us; a caller passing them in `env` gets the same treatment.
    const env = awsChildEnv(
      {
        AWS_CLI_ERROR_FORMAT: "json",
        AWS_CLI_AUTO_PROMPT: "on",
        AWS_CLI_OUTPUT_ENCODING: "cp1252",
        PYTHONUTF8: "0",
      },
      "linux",
    );
    assert.deepEqual(
      { ...env },
      {
        AWS_CLI_ERROR_FORMAT: "enhanced",
        AWS_CLI_AUTO_PROMPT: "off",
        AWS_CLI_OUTPUT_ENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
    );
  });

  it("win32: deletes every case-variant, so exactly one spelling of each pin reaches the child", () => {
    // Windows environment names are case-insensitive but a JS object's keys are
    // not, and which duplicate the child sees is runtime-dependent (node 22.22.2
    // hands over the upper-case one, oam 0.16.2 the last key in the object).
    const env = awsChildEnv(
      {
        PATH: "C:\\Windows\\System32",
        aws_cli_error_format: "json",
        Aws_Cli_Auto_Prompt: "on",
        NODEFAULTCURRENTDIRECTORYINEXEPATH: "0",
      },
      "win32",
    );
    for (const [name, value] of Object.entries({ ...PINNED_CLI_ENV, ...WIN32_PINNED_CLI_ENV })) {
      const spellings = Object.keys(env).filter((key) => key.toUpperCase() === name.toUpperCase());
      assert.deepEqual(spellings, [name], `expected only ${name}, got ${spellings.join(", ")}`);
      assert.equal(env[name], value);
    }
    assert.equal(env.PATH, "C:\\Windows\\System32");
  });

  it("POSIX: no win32-only pin, and a lower-case spelling is left alone", () => {
    // POSIX environments really are case-sensitive, so `aws_cli_error_format` is
    // a different variable that the CLI ignores. Deleting it would be a change
    // to the caller's environment for no reason.
    const env = awsChildEnv({ aws_cli_error_format: "json" }, "linux");
    assert.equal(env.aws_cli_error_format, "json");
    assert.equal(env.AWS_CLI_ERROR_FORMAT, "enhanced");
    assert.equal("NoDefaultCurrentDirectoryInExePath" in env, false);
  });
});

describe("awsChildEnv composes with a Lambda invoke's environment (C4)", () => {
  it("pins nothing that tools/lambda.ts relies on", () => {
    // AWS_MAX_ATTEMPTS is how invokeChildEnv keeps a Lambda from running twice.
    // A pin for it here would take that away silently, from the one caller that
    // cannot tolerate a retry.
    for (const table of [PINNED_CLI_ENV, WIN32_PINNED_CLI_ENV]) {
      const names = Object.keys(table).map((key) => key.toUpperCase());
      assert.equal(names.includes("AWS_MAX_ATTEMPTS"), false);
    }
  });

  it("keeps AWS_MAX_ATTEMPTS at 1 through both helpers on win32", () => {
    const env = awsChildEnv(invokeChildEnv({ PATH: "C:\\Windows\\System32", aws_max_attempts: "5" }), "win32");
    assert.equal(env.AWS_MAX_ATTEMPTS, "1");
    const spellings = Object.keys(env).filter((key) => key.toUpperCase() === "AWS_MAX_ATTEMPTS");
    assert.deepEqual(spellings, ["AWS_MAX_ATTEMPTS"]);
    assert.equal(env.AWS_CLI_ERROR_FORMAT, "enhanced");
  });
});

describe("envLookup", () => {
  it("matches case-insensitively on win32 only", () => {
    // process.env is already case-insensitive on Windows, but opts.env is a plain
    // object, and `{Path: "..."}.PATH` is undefined there (measured).
    assert.equal(envLookup({ Path: "C:\\Windows" }, "PATH", "win32"), "C:\\Windows");
    assert.equal(envLookup({ Path: "/usr/bin" }, "PATH", "linux"), undefined);
  });

  it("prefers the exact key on both platforms", () => {
    const env = { PATH: "exact", Path: "variant" };
    assert.equal(envLookup(env, "PATH", "win32"), "exact");
    assert.equal(envLookup(env, "PATH", "linux"), "exact");
  });

  it("treats an undefined value as unset", () => {
    // node drops undefined-valued keys at spawn time, so a caller that "unset" a
    // variable this way must read back as unset here too.
    assert.equal(envLookup({ PATH: undefined }, "PATH", "win32"), undefined);
    assert.equal(envLookup({ PATH: undefined, Path: "variant" }, "PATH", "win32"), "variant");
  });
});

describe("resolveAwsCommand -- the explicit test seam", () => {
  it("passes an explicit command through untouched, checks and all", () => {
    // opts.command / AWS_MCP_TEST_AWS_COMMAND: the suites point this at a fake
    // script or at a deliberately nonexistent name to assert the ENOENT path.
    const r = ok(resolveAwsCommand({ explicit: "definitely-not-a-real-binary", platform: "win32", probe: noProbe }));
    assert.equal(r.command, "definitely-not-a-real-binary");
    assert.equal(r.display, "definitely-not-a-real-binary");
    assert.equal(r.source, "explicit");
  });

  it("treats a blank explicit command as unset and keeps resolving", () => {
    const r = ok(
      resolveAwsCommand({
        explicit: "   ",
        env: { PATH: "C:\\legit" },
        platform: "win32",
        probe: probeFor({ "C:\\legit\\aws.exe": {} }),
      }),
    );
    assert.equal(r.command, "C:\\legit\\aws.exe");
    assert.equal(r.source, "path");
  });
});

describe("resolveAwsCommand -- win32 PATH walk", () => {
  it("takes the first directory that holds aws.exe", () => {
    const r = ok(
      resolveAwsCommand({
        env: { PATH: "C:\\first;C:\\second" },
        platform: "win32",
        probe: probeFor({ "C:\\first\\aws.exe": {}, "C:\\second\\aws.exe": {} }),
      }),
    );
    assert.equal(r.command, "C:\\first\\aws.exe");
    assert.equal(r.display, "aws");
    assert.equal(r.source, "path");
  });

  it("skips every entry that is not a fixed directory", () => {
    // The probe claims aws.exe exists in all of them. Only the drive-absolute
    // entry may be used: an empty entry and `.` mean the working directory, `bin`
    // is relative to it, `C:foo` is relative to the current directory ON C:,
    // `\tools` is relative to the current DRIVE (resolve("\\tools") is "C:\tools"
    // only because the cwd happens to be on C:), and `%SYSTEMROOT%\system32` is
    // an unexpanded variable reference.
    const r = ok(
      resolveAwsCommand({
        env: { PATH: ";.;bin;C:foo;\\tools;%SYSTEMROOT%\\system32;C:\\legit" },
        platform: "win32",
        probe: probeFor({
          "aws.exe": {},
          "bin\\aws.exe": {},
          "C:foo\\aws.exe": {},
          "\\tools\\aws.exe": {},
          "%SYSTEMROOT%\\system32\\aws.exe": {},
          "C:\\legit\\aws.exe": {},
        }),
      }),
    );
    assert.equal(r.command, "C:\\legit\\aws.exe");
  });

  it("accepts a quoted entry", () => {
    // Windows PATH entries with spaces are routinely stored quoted; the quotes
    // are not part of the directory name.
    const r = ok(
      resolveAwsCommand({
        env: { PATH: `"C:\\tools with space"` },
        platform: "win32",
        probe: probeFor({ "C:\\tools with space\\aws.exe": {} }),
      }),
    );
    assert.equal(r.command, "C:\\tools with space\\aws.exe");
  });

  it("accepts a UNC entry", () => {
    const r = ok(
      resolveAwsCommand({
        env: { PATH: "\\\\srv\\share\\bin" },
        platform: "win32",
        probe: probeFor({ "\\\\srv\\share\\bin\\aws.exe": {} }),
      }),
    );
    assert.equal(r.command, "\\\\srv\\share\\bin\\aws.exe");
  });

  it("skips a directory named aws.exe", () => {
    const r = failed(
      resolveAwsCommand({
        env: { PATH: "C:\\legit" },
        platform: "win32",
        probe: probeFor({ "C:\\legit\\aws.exe": { isFile: false } }),
      }),
    );
    assert.match(r.error, /Could not find the AWS CLI/);
  });

  it("finds the win32 PATH spelled any way", () => {
    const r = ok(
      resolveAwsCommand({
        env: { Path: "C:\\legit" },
        platform: "win32",
        probe: probeFor({ "C:\\legit\\aws.exe": {} }),
      }),
    );
    assert.equal(r.command, "C:\\legit\\aws.exe");
  });

  it("names an aws.cmd shim it had to pass over", () => {
    // node refuses to start a .cmd by path with no shell (a synchronous EINVAL,
    // measured on both spawn and spawnSync), while oam 0.16.2 runs the same path
    // through cmd.exe -- so we take neither. A pip-installed AWS CLI v1 leaves
    // exactly this, and saying so beats "found nothing".
    const r = failed(
      resolveAwsCommand({
        env: { PATH: "C:\\shim" },
        platform: "win32",
        probe: probeFor({ "C:\\shim\\aws.cmd": {} }),
      }),
    );
    assert.match(r.error, /Found C:\\shim\\aws\.cmd, a script shim/);
    assert.match(r.error, /install AWS CLI v2/);
  });

  it("tells the operator how to fix an unresolvable PATH", () => {
    const r = failed(
      resolveAwsCommand({ env: { PATH: "C:\\one;C:\\two;.;bin" }, platform: "win32", probe: probeFor({}) }),
    );
    assert.match(r.error, /no aws\.exe in any of the 2 absolute directories/);
    assert.match(r.error, /working directory is never searched/);
    assert.match(r.error, /where\.exe aws/);
    assert.match(r.error, new RegExp(AWS_CLI_OVERRIDE_ENV));
    assert.doesNotMatch(r.error, /script shim/);
  });
});

describe("resolveAwsCommand -- POSIX PATH walk", () => {
  it("splits on colons and takes the first executable regular file", () => {
    const r = ok(
      resolveAwsCommand({
        env: { PATH: "/usr/bin:/opt/aws/bin" },
        platform: "linux",
        probe: probeFor({ "/usr/bin/aws": {}, "/opt/aws/bin/aws": {} }),
      }),
    );
    assert.equal(r.command, "/usr/bin/aws");
    assert.equal(r.display, "aws");
  });

  it("skips empty, '.' and relative entries", () => {
    // An empty entry and `.` both mean the working directory to execvp.
    const r = ok(
      resolveAwsCommand({
        env: { PATH: ":.:bin:/usr/local/bin" },
        platform: "linux",
        probe: probeFor({ aws: {}, "bin/aws": {}, "/usr/local/bin/aws": {} }),
      }),
    );
    assert.equal(r.command, "/usr/local/bin/aws");
  });

  it("skips a file that is not executable", () => {
    // On a native POSIX filesystem X_OK carries real information, unlike win32.
    // Not everywhere POSIX, though: under WSL, DrvFs reports 0777 for every file
    // on a Windows drive, so the check cannot reject a non-executable there. See
    // fsProbe. This case drives the probe directly, so it tests the rule rather
    // than any filesystem's willingness to report it.
    const r = ok(
      resolveAwsCommand({
        env: { PATH: "/a:/b" },
        platform: "linux",
        probe: probeFor({ "/a/aws": { executable: false }, "/b/aws": {} }),
      }),
    );
    assert.equal(r.command, "/b/aws");
  });

  it("skips a directory named aws", () => {
    const r = ok(
      resolveAwsCommand({
        env: { PATH: "/a:/b" },
        platform: "linux",
        probe: probeFor({ "/a/aws": { isFile: false }, "/b/aws": {} }),
      }),
    );
    assert.equal(r.command, "/b/aws");
  });

  it("looks for no .exe and offers no shim clause", () => {
    const r = failed(
      resolveAwsCommand({ env: { PATH: "/a" }, platform: "linux", probe: probeFor({ "/a/aws.cmd": {} }) }),
    );
    assert.match(r.error, /no aws in any of the 1 absolute directories/);
    assert.doesNotMatch(r.error, /aws\.exe/);
    assert.doesNotMatch(r.error, /script shim/);
  });

  it("does not match a win32 case-variant of PATH", () => {
    const r = failed(resolveAwsCommand({ env: { Path: "/usr/bin" }, platform: "linux", probe: probeFor({}) }));
    assert.match(r.error, /any of the 0 absolute directories/);
  });
});

describe("resolveAwsCommand -- AWS_MCP_AWS_CLI", () => {
  it("runs the binary it names, ahead of anything on PATH, and still displays 'aws'", () => {
    const r = ok(
      resolveAwsCommand({
        env: { [AWS_CLI_OVERRIDE_ENV]: "C:\\custom\\aws.exe", PATH: "C:\\legit" },
        platform: "win32",
        probe: probeFor({ "C:\\custom\\aws.exe": {}, "C:\\legit\\aws.exe": {} }),
      }),
    );
    assert.equal(r.command, "C:\\custom\\aws.exe");
    assert.equal(r.display, "aws");
    assert.equal(r.source, "override");
  });

  it("accepts a value pasted with surrounding quotes and stray whitespace", () => {
    const r = ok(
      resolveAwsCommand({
        env: { [AWS_CLI_OVERRIDE_ENV]: `  "C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe"  ` },
        platform: "win32",
        probe: probeFor({ "C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe": {} }),
      }),
    );
    assert.equal(r.command, "C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe");
  });

  it("is honored under any case-variant of its name on win32", () => {
    const r = ok(
      resolveAwsCommand({
        env: { aws_mcp_aws_cli: "C:\\custom\\aws.exe" },
        platform: "win32",
        probe: probeFor({ "C:\\custom\\aws.exe": {} }),
      }),
    );
    assert.equal(r.source, "override");
  });

  it("refuses a relative value rather than guessing", () => {
    for (const value of ["aws.exe", "tools\\aws.exe", "C:tools\\aws.exe", "\\tools\\aws.exe"]) {
      const r = failed(
        resolveAwsCommand({
          env: { [AWS_CLI_OVERRIDE_ENV]: value },
          platform: "win32",
          probe: probeFor({ "aws.exe": {}, "tools\\aws.exe": {}, "C:tools\\aws.exe": {}, "\\tools\\aws.exe": {} }),
        }),
      );
      assert.match(r.error, /must be an absolute path to the aws executable/);
      assert.match(r.error, new RegExp(AWS_CLI_OVERRIDE_ENV));
    }
  });

  it("refuses a missing file and a directory", () => {
    const missing = failed(
      resolveAwsCommand({
        env: { [AWS_CLI_OVERRIDE_ENV]: "C:\\custom\\aws.exe" },
        platform: "win32",
        probe: probeFor({}),
      }),
    );
    assert.match(missing.error, /points at 'C:\\custom\\aws\.exe', which does not exist or is not a file/);
    const directory = failed(
      resolveAwsCommand({
        env: { [AWS_CLI_OVERRIDE_ENV]: "/opt/aws.exe" },
        platform: "linux",
        probe: probeFor({ "/opt/aws.exe": { isFile: false } }),
      }),
    );
    assert.match(directory.error, /does not exist or is not a file/);
  });

  it("win32: refuses a .cmd or .bat shim by name, whether or not it is there", () => {
    for (const value of ["C:\\shim\\aws.cmd", "C:\\shim\\aws.bat", "C:\\shim\\aws"]) {
      const r = failed(
        resolveAwsCommand({
          env: { [AWS_CLI_OVERRIDE_ENV]: value },
          platform: "win32",
          probe: probeFor({ "C:\\shim\\aws.cmd": {} }),
        }),
      );
      assert.match(r.error, /must point at an \.exe/);
      assert.match(r.error, /\.cmd or \.bat shim cannot be started without a shell/);
    }
  });

  it("POSIX: refuses a file it could not execute", () => {
    const r = failed(
      resolveAwsCommand({
        env: { [AWS_CLI_OVERRIDE_ENV]: "/opt/aws/bin/aws" },
        platform: "linux",
        probe: probeFor({ "/opt/aws/bin/aws": { executable: false } }),
      }),
    );
    assert.match(r.error, /points at '\/opt\/aws\/bin\/aws', which is not executable/);
  });

  it("never falls back to PATH when the value is unusable", () => {
    // The variable decides which binary handles the user's credentials. Falling
    // back would run a different one than the operator configured, quietly.
    const r = failed(
      resolveAwsCommand({
        env: { [AWS_CLI_OVERRIDE_ENV]: "tools\\aws.exe", PATH: "C:\\legit" },
        platform: "win32",
        probe: probeFor({ "C:\\legit\\aws.exe": {} }),
      }),
    );
    assert.match(r.error, new RegExp(AWS_CLI_OVERRIDE_ENV));
    assert.doesNotMatch(r.error, /Could not find the AWS CLI/);
  });

  it("treats a blank value as unset", () => {
    const r = ok(
      resolveAwsCommand({
        env: { [AWS_CLI_OVERRIDE_ENV]: "   ", PATH: "C:\\legit" },
        platform: "win32",
        probe: probeFor({ "C:\\legit\\aws.exe": {} }),
      }),
    );
    assert.equal(r.source, "path");
  });
});

describe("resolveAwsCommand -- the real probe, on this host", () => {
  const isWin32 = process.platform === "win32";
  const binary = isWin32 ? "aws.exe" : "aws";
  const root = mkdtempSync(join(tmpdir(), "aws-spawn-resolve-"));
  const legit = join(root, "legit");
  const plant = join(root, "plant");
  const empty = join(root, "empty");
  for (const dir of [legit, plant, empty]) mkdirSync(dir, { recursive: true });

  // The resolver only STATS its candidates, so a stub file is enough here; the
  // spawn-level regression test is the one that needs a startable binary. On
  // win32 a hard link to this node costs nothing when the temp dir is on the same
  // volume, so take the real executable when we can get it. On POSIX we write a
  // script instead: a hard link shares the inode, and the chmod the X_OK check
  // needs would land on the node binary itself.
  function plantAws(dir: string): string {
    const path = join(dir, binary);
    if (isWin32) {
      try {
        linkSync(process.execPath, path);
        return path;
      } catch {
        writeFileSync(path, "MZ stub\n");
        return path;
      }
    }
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o755);
    return path;
  }
  const legitAws = plantAws(legit);
  const plantedAws = plantAws(plant);

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("finds the binary on a PATH built from real directories", () => {
    const r = ok(resolveAwsCommand({ env: { PATH: `${empty}${isWin32 ? ";" : ":"}${legit}` } }));
    assert.equal(r.command, legitAws);
    assert.equal(r.source, "path");
  });

  it("never searches the working directory", () => {
    // The whole point of the resolver: libuv's Windows search_path looks in the
    // cwd before PATH whenever NoDefaultCurrentDirectoryInExePath is unset in the
    // parent, and the cwd belongs to the MCP host. Reproduced on this host: a
    // bare spawn("aws") from a directory holding a planted aws.exe ran the
    // planted one.
    const before = process.cwd();
    try {
      process.chdir(plant);
      const r = failed(resolveAwsCommand({ env: { PATH: empty } }));
      assert.doesNotMatch(r.error, new RegExp(plant.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
      assert.match(r.error, /working directory is never searched/);
    } finally {
      process.chdir(before);
    }
    // ...and the planted binary really was findable, so the test above proves a
    // rule rather than a broken fixture.
    assert.equal(ok(resolveAwsCommand({ env: { PATH: plant } })).command, plantedAws);
  });

  it("honors AWS_MCP_AWS_CLI pointing at a real file, and refuses the directory holding it", () => {
    assert.equal(ok(resolveAwsCommand({ env: { [AWS_CLI_OVERRIDE_ENV]: legitAws } })).command, legitAws);
    const r = failed(resolveAwsCommand({ env: { [AWS_CLI_OVERRIDE_ENV]: legit } }));
    // On win32 the extension check speaks first; on POSIX it is the stat.
    assert.match(r.error, isWin32 ? /must point at an \.exe/ : /does not exist or is not a file/);
  });
});

describe("isCliSafeFilePath", () => {
  it("rejects what the CLI would expand in a file:// path", () => {
    // awscli/paramfile.py runs expandvars(expanduser(path)) on a paramfile path,
    // so these never reach the file system as themselves.
    assert.equal(isCliSafeFilePath("C:\\Users\\$user\\AppData\\Local\\Temp"), false);
    assert.equal(isCliSafeFilePath("C:\\Users\\%USERNAME%\\Temp"), false);
    assert.equal(isCliSafeFilePath("~/tmp"), false);
  });

  it("accepts an ordinary temp directory, 8.3 short names included", () => {
    // Only a LEADING tilde expands, so a short name such as JEFF~1 is fine.
    assert.equal(isCliSafeFilePath("C:\\Users\\JEFF~1\\AppData\\Local\\Temp\\aws-mcp-input-AbC123"), true);
    assert.equal(isCliSafeFilePath("/tmp/aws-mcp-input-AbC123"), true);
  });
});
