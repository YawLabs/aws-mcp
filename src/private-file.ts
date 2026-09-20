/**
 * One definition of "this file is owner-only, and we checked".
 *
 * Two places write a file whose privacy is load-bearing: the `--cli-input-json`
 * params file in aws-cli.ts, which can carry a SecureString or a credential, and
 * `~/.aws/credentials` in aws-credentials.ts, which carries an access key, a
 * secret key and a session token in plaintext. Both open at 0600 and then
 * fchmod the fd at 0600 -- open's mode because node honours it, the fchmod
 * because oam drops open's mode and oam is what the published bin prefers.
 *
 * Neither is sufficient, because a filesystem may accept a chmod, report
 * SUCCESS, and change nothing. MEASURED on WSL Ubuntu (linux/arm64, Node
 * 22.23.2) against a Windows drive under /mnt (v9fs/DrvFs):
 *
 *   mkdtemp            -> 0777   (not 0700)
 *   open(wx, 0600)     -> 0777   (not 0600)
 *   fchmodSync(0600)   -> succeeds, changes NOTHING
 *   second wx open     -> EEXIST (so exclusivity does hold; only the mode lies)
 *
 * The same applies to any mount with no inode mode to set: ASSERTED for
 * CIFS/SMB and for FAT-family and NTFS mounts driven by `fmask`/`dmask`, on the
 * basis that those drivers synthesise one fixed mode per mount option, which is
 * the same reason v9fs ignores the fchmod.
 *
 * These are not exotic configurations. A WSL user points TMPDIR into a Windows
 * drive to share one scratch directory between the two halves of the machine,
 * and points AWS_SHARED_CREDENTIALS_FILE at the Windows-side ~/.aws to share one
 * credentials file and one SSO cache. Both are deliberate setups, and
 * AWS_SHARED_CREDENTIALS_FILE is botocore's own variable, advertised in this
 * server's own tool descriptions.
 *
 * So the mode is verified rather than assumed, and a file that cannot be made
 * private is not written at all.
 */

import { fstatSync } from "node:fs";

/** Reads the permission bits off an open fd. Injectable so a test can drive the
 *  mode-ignoring filesystem branch from a machine that does not have one. */
export type ModeProbe = (fd: number) => number;

const fsModeProbe: ModeProbe = (fd) => fstatSync(fd).mode & 0o777;

/**
 * Throw unless `fd` is mode 0600. Call it after the fchmod and BEFORE writing
 * anything secret, so a failure leaves no sensitive byte on disk.
 *
 * `remedy` completes the message with the one thing the operator can change, and
 * should name the environment variable that chose this path.
 *
 * A no-op on Windows, deliberately: chmod there moves nothing but the read-only
 * bit and the mode reads back 0666 whatever is asked for (measured, win32/arm64),
 * so there is no POSIX mode to verify. Privacy on Windows rests on the per-user
 * %TEMP% / %USERPROFILE% ACL instead, which is what the call sites document.
 */
export function assertPrivateMode(
  fd: number,
  path: string,
  remedy: string,
  opts: { platform?: NodeJS.Platform; probe?: ModeProbe } = {},
): void {
  const platform = opts.platform ?? process.platform;
  if (platform === "win32") return;
  const mode = (opts.probe ?? fsModeProbe)(fd);
  if (mode === 0o600) return;
  throw new Error(
    `${path} is on a filesystem that does not honour file modes, so the 0600 its privacy rests on is not in effect (it is 0${mode.toString(8)}). ` +
      "A Windows drive mounted into WSL reports 0777 for every file and ignores chmod without failing; CIFS/SMB and FAT-family mounts do the same. " +
      remedy,
  );
}
