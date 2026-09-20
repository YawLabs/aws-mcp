import assert from "node:assert/strict";
import { closeSync, fchmodSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { assertPrivateMode } from "./private-file.js";
import { modeHonouringTmpBase } from "./testing/tmpdir-modes.js";

describe("assertPrivateMode", () => {
  // The guarantee this enforces is that two files which can hold credentials --
  // the --cli-input-json params file and ~/.aws/credentials -- are owner-only.
  // The probe is injectable precisely so the FAILING branch is covered from a
  // machine with no mode-ignoring filesystem on it, which is every machine here:
  // the real 0777 case was measured on WSL against a Windows drive, and a test
  // that could only run there would never run.

  it("passes a file that really is 0600", () => {
    assertPrivateMode(3, "/tmp/x/params.json", "remedy.", { platform: "linux", probe: () => 0o600 });
  });

  it("throws when the filesystem reported success and left the file world-readable", () => {
    assert.throws(
      () =>
        assertPrivateMode(3, "/mnt/c/tmp/params.json", "Point TMPDIR at a native filesystem.", {
          platform: "linux",
          probe: () => 0o777,
        }),
      (err: Error) => {
        // The path, so the reader knows which file; the octal mode, so they can
        // see it is the filesystem and not a bug; and the remedy, which is the
        // only thing they can act on.
        assert.match(err.message, /\/mnt\/c\/tmp\/params\.json/);
        assert.match(err.message, /0777/);
        assert.match(err.message, /Point TMPDIR at a native filesystem\./);
        assert.match(err.message, /does not honour file modes/);
        return true;
      },
    );
  });

  it("throws on any mode that is not exactly 0600, narrower included", () => {
    // fchmod(fd, 0o600) is absolute -- umask does not apply to it -- so on a
    // filesystem that honours it the mode IS 0600. Anything else, wider or
    // narrower, means the chmod did not take, which is the thing being detected.
    for (const mode of [0o777, 0o666, 0o644, 0o640, 0o604, 0o400, 0o000]) {
      assert.throws(
        () => assertPrivateMode(3, "/x", "r.", { platform: "linux", probe: () => mode }),
        new RegExp(`0${mode.toString(8)}`),
        `mode 0${mode.toString(8)} must be rejected`,
      );
    }
  });

  it("is a no-op on win32, and does not even ask for the mode", () => {
    // Windows has no POSIX mode to verify: chmod moves only the read-only bit
    // and the mode reads back 0666 whatever is requested (measured, win32/arm64).
    // Privacy there rests on the per-user %TEMP% / %USERPROFILE% ACL. Asserting
    // the probe is never called pins that this returns before touching the fd,
    // so a bogus fd on Windows cannot throw.
    let asked = false;
    assertPrivateMode(-1, "C:\\Temp\\params.json", "remedy.", {
      platform: "win32",
      probe: () => {
        asked = true;
        return 0o666;
      },
    });
    assert.equal(asked, false, "the win32 arm must return before reading the mode");
  });

  it("accepts a real fd from the real filesystem on the host it runs on", (t) => {
    // The default probe against an actual file, so the wiring is covered and not
    // just the injected form. Deliberately NOT os.tmpdir(): on a machine whose
    // TMPDIR points into a Windows drive that directory cannot hold a 0600 file
    // at all, and this case would fail for the very reason the product exists to
    // report. modeHonouringTmpBase picks a filesystem that can.
    const base = modeHonouringTmpBase();
    if (base === null) {
      t.skip("no directory on this machine honours file modes, so there is no 0600 file to verify");
      return;
    }
    const dir = mkdtempSync(join(base, "aws-mcp-privfile-"));
    try {
      const file = join(dir, "probe");
      const fd = openSync(file, "wx", 0o600);
      try {
        fchmodSync(fd, 0o600);
        assertPrivateMode(fd, file, "remedy.");
      } finally {
        closeSync(fd);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
