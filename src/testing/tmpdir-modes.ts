/**
 * Which directories on this machine can actually hold a private (0600) file?
 *
 * WSL's DrvFs cannot: a Windows drive under /mnt reports 0777 for every file, and
 * `fchmodSync` succeeds while changing nothing (measured on linux/arm64, Node
 * 22.23.2, with TMPDIR under /mnt/c). CIFS/SMB and FAT-family mounts behave the
 * same way, for the same reason -- there is no inode mode to set.
 *
 * Two production paths refuse to write on such a filesystem rather than leave a
 * credential-bearing file world-readable and world-writable: the params temp file
 * in aws-cli.ts and `~/.aws/credentials` in aws-credentials.ts, both through
 * `assertPrivateMode`. So tests come in two kinds, and both need to know what
 * they are standing on:
 *
 *   - tests of the happy path need a directory that DOES honour modes, or they
 *     are asserting a path the product deliberately refuses. They take
 *     `modeHonouringTmpBase()` rather than os.tmpdir(), so they keep running on a
 *     machine whose TMPDIR points into a Windows drive -- which is a real,
 *     deliberate setup, for sharing one scratch directory between a WSL distro
 *     and its Windows host.
 *   - the test of the refusal needs one that does NOT, which is what
 *     `tmpdirIgnoresModes()` detects.
 *
 * Both are no-ops on Windows: chmod there moves nothing but the read-only bit and
 * the mode reads back 0666 whatever is asked for, so there is no POSIX mode to
 * verify and the product does not check one.
 */

import { closeSync, fchmodSync, fstatSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Can a 0600 file actually be created under `base`? */
function honoursModes(base: string): boolean {
  let dir: string;
  try {
    dir = mkdtempSync(join(base, "aws-mcp-modeprobe-"));
  } catch {
    return false; // not writable at all; not this module's problem to report
  }
  try {
    const fd = openSync(join(dir, "probe"), "wx", 0o600);
    try {
      fchmodSync(fd, 0o600);
      return (fstatSync(fd).mode & 0o777) === 0o600;
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** True when os.tmpdir() accepts a chmod and ignores it. Always false on Windows. */
export function tmpdirIgnoresModes(): boolean {
  if (process.platform === "win32") return false;
  return !honoursModes(tmpdir());
}

/**
 * A base directory under which a test can create a real 0600 file: os.tmpdir()
 * when that works, else a native-filesystem fallback. `/dev/shm` is tmpfs and
 * the home directory is whatever the distro installed onto, so on WSL both are
 * ext4 even when TMPDIR is not. Returns null when nothing found honours modes,
 * which leaves the caller to decide between skipping and failing.
 */
export function modeHonouringTmpBase(): string | null {
  if (process.platform === "win32") return tmpdir();
  for (const base of [tmpdir(), "/dev/shm", homedir()]) {
    if (honoursModes(base)) return base;
  }
  return null;
}
