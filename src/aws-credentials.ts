/**
 * Minimal read/modify/write for ~/.aws/credentials.
 *
 * The goal is narrow: upsert a single profile section with our three keys
 * (aws_access_key_id, aws_secret_access_key, aws_session_token) without
 * touching anything else. Comments, whitespace between sections, unrelated
 * profiles, and keys we don't manage all pass through unchanged.
 *
 * One deliberate exception: when we MATCH the target profile (see
 * upsertProfileIntoText), its header is normalized to the canonical
 * `[name]` form (e.g. `[ mcp-dev ]` -> `[mcp-dev]`). Only the matched
 * managed profile's header is rewritten this way; unrelated and non-managed
 * sections keep their headers verbatim.
 *
 * We write to a .tmp file first and rename on top of the original so a
 * crash mid-write can't leave the user with a truncated credentials file.
 * The tmp file is opened with mode 0o600 (a no-op on Windows), so the
 * credentials file inherits those permissions through the rename -- matching
 * the AWS CLI's own behavior. If anything between the open and the rename
 * throws, the tmp file is unlinked: it holds all three plaintext credentials
 * under a name (`<path>.tmp-<pid>-<uuid>`) that no other cleanup path and no
 * human would ever think to look for.
 *
 * Concurrent writers are serialized via a sidecar lock file (`<path>.lock`).
 * Without the lock, two upsertProfile calls landing at the same instant for
 * DIFFERENT profiles could each read the file, each compute their own
 * single-profile output, and the second rename would clobber the first
 * caller's profile changes. The lock turns the read-modify-rename window
 * into a critical section.
 */

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

interface AssumedCredentials {
  aws_access_key_id: string;
  aws_secret_access_key: string;
  aws_session_token: string;
}

/**
 * Parse an INI-style credentials file into an ordered list of sections.
 * We keep the list ordered so a round-trip preserves the user's layout.
 */
interface Section {
  // The raw header line including brackets, e.g. "[profile foo]" or "[default]".
  // null for the pre-first-section preamble (comments / blank lines).
  header: string | null;
  // Raw text of the section body, including trailing newline.
  body: string;
}

// Single source of truth for what counts as a section header line. Both
// splitSections (which decides where a section starts) and sectionName (which
// extracts the name back out of the stored raw line) MUST use this -- they
// previously disagreed, see the sectionName comment below.
const SECTION_HEADER_RE = /^\[(.+)\]\s*$/;

function splitSections(text: string): Section[] {
  const sections: Section[] = [];
  let current: Section = { header: null, body: "" };
  for (const rawLine of text.split(/\r?\n/)) {
    const headerMatch = SECTION_HEADER_RE.exec(rawLine);
    if (headerMatch) {
      if (current.header !== null || current.body !== "") {
        sections.push(current);
      }
      current = { header: rawLine, body: "" };
    } else {
      // Preserve line + trailing newline; skip the trailing fake line from
      // split on a terminating newline.
      current.body += `${rawLine}\n`;
    }
  }
  // split adds an empty final entry on a trailing newline; that produced an
  // extra \n above. Trim one trailing \n from the last section's body so a
  // round-trip on a file ending with one newline is idempotent.
  if (current.body.endsWith("\n")) current.body = current.body.slice(0, -1);
  if (current.header !== null || current.body !== "") sections.push(current);
  return sections;
}

/**
 * Extract the profile name from a stored raw header line.
 *
 * MUST parse with SECTION_HEADER_RE, not `slice(1, -1)`. splitSections stores
 * the RAW line, and the regex tolerates trailing whitespace after the closing
 * bracket (`\s*$`). A naive slice(1, -1) on `"[mcp-dev]  "` drops the final
 * SPACE instead of the bracket, yielding `"mcp-dev]"` -- which matched no
 * profile, so upsertProfileIntoText appended a SECOND `[mcp-dev]` section and
 * left the stale credentials sitting in the first one. `[mcp-dev]\t` failed the
 * same way; `[ mcp-dev ]` and CRLF files happened to work, which is why this
 * hid for so long.
 *
 * Callers only ever pass lines splitSections stored, which by construction
 * matched SECTION_HEADER_RE -- so the exec always matches. The `?? ""` is a
 * type-level floor, not a second parsing path (a second path is exactly what
 * produced the bug above); "" matches no profile name, all of which are
 * non-empty.
 */
function sectionName(header: string): string {
  return (SECTION_HEADER_RE.exec(header)?.[1] ?? "").trim();
}

function buildProfileBody(creds: AssumedCredentials): string {
  return (
    `aws_access_key_id = ${creds.aws_access_key_id}\n` +
    `aws_secret_access_key = ${creds.aws_secret_access_key}\n` +
    `aws_session_token = ${creds.aws_session_token}\n`
  );
}

/**
 * Update the profile in-place, replacing only the three keys we manage and
 * leaving any other keys (e.g. region, output) untouched.
 */
function mergeProfileBody(existingBody: string, creds: AssumedCredentials): string {
  const managedKeys = new Set(["aws_access_key_id", "aws_secret_access_key", "aws_session_token"]);
  const lines = existingBody.split(/\r?\n/);
  const updated: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const eqIdx = line.indexOf("=");
    if (eqIdx < 0) {
      updated.push(line);
      continue;
    }
    // AWS CLI / SDK treat credentials keys case-insensitively; a hand-edited
    // `AWS_ACCESS_KEY_ID` line is the same key as our canonical lowercase.
    // Lowercase before the managed-set check so the existing line is replaced
    // in place rather than left untouched and shadowed by an appended dup.
    const key = line.slice(0, eqIdx).trim().toLowerCase();
    if (managedKeys.has(key)) {
      seen.add(key);
      updated.push(`${key} = ${(creds as unknown as Record<string, string>)[key]}`);
    } else {
      updated.push(line);
    }
  }
  const missingKeys = [...managedKeys].filter((k) => !seen.has(k));
  if (missingKeys.length > 0) {
    // Capture the section's trailing blank-line suffix, append managed keys
    // onto a clean tail, then restore the suffix verbatim. Users who placed
    // blank lines BETWEEN this section and the next one (splitSections folds
    // those into this section's body) shouldn't lose them just because we
    // had to add a key. If there were no trailing blanks, default to a
    // single newline so the next section's header doesn't butt up against
    // our last key.
    const trailingBlanks: string[] = [];
    while (updated.length > 0 && updated[updated.length - 1].trim() === "") {
      trailingBlanks.unshift(updated.pop() as string);
    }
    for (const key of missingKeys) {
      updated.push(`${key} = ${(creds as unknown as Record<string, string>)[key]}`);
    }
    if (trailingBlanks.length === 0) trailingBlanks.push("");
    updated.push(...trailingBlanks);
  }
  return updated.join("\n");
}

export function upsertProfileIntoText(text: string, profile: string, creds: AssumedCredentials): string {
  const sections = splitSections(text);
  const targetHeader = `[${profile}]`;
  const idx = sections.findIndex((s) => s.header === targetHeader || (s.header && sectionName(s.header) === profile));
  if (idx >= 0) {
    sections[idx].header = targetHeader;
    sections[idx].body = mergeProfileBody(sections[idx].body, creds);
  } else {
    // Ensure at least one blank line between the previous section and ours.
    const last = sections[sections.length - 1];
    if (last && !last.body.endsWith("\n\n") && last.body !== "") {
      last.body = `${last.body.replace(/\n*$/, "")}\n\n`;
    }
    sections.push({ header: targetHeader, body: buildProfileBody(creds) });
  }
  return sections
    .map((s) => (s.header === null ? s.body : `${s.header}\n${s.body}`))
    .join("")
    .replace(/\n*$/, "\n");
}

/**
 * Does `text` already contain a section for `profile`?
 *
 * Uses the same matcher as upsertProfileIntoText (the `sectionName` compare
 * subsumes the raw-header compare, since sectionName("[x]") === "x"), so the
 * answer is exactly "would the upsert OVERWRITE rather than APPEND". Callers
 * use it to warn that a pre-existing profile's managed keys are about to be
 * replaced in place.
 */
export function profileExistsInText(text: string, profile: string): boolean {
  return splitSections(text).some((s) => s.header !== null && sectionName(s.header) === profile);
}

/** Max wall-clock spent trying to acquire the lock before giving up. */
const LOCK_MAX_WAIT_MS = 10_000;
/**
 * Lock files older than this are considered stale (prior holder crashed
 * before unlinking). 30s is a generous upper bound on a healthy
 * read-modify-rename cycle; anything older was almost certainly orphaned.
 */
const LOCK_STALE_AFTER_MS = 30_000;
/** Base retry delay; jittered + scaled per attempt up to a cap. */
const LOCK_BASE_RETRY_MS = 25;
const LOCK_MAX_RETRY_MS = 250;

/**
 * Acquire a sidecar lock file via O_EXCL. Honored cross-process: both POSIX
 * `openSync(p, 'wx')` and Windows `_open` reject a `CREATE | EXCL` request
 * when the file already exists, so a second process loses the race and
 * retries.
 *
 * Stale-lock recovery: if the existing lock is older than
 * `LOCK_STALE_AFTER_MS`, the prior holder is presumed dead and we force-
 * unlink. The stat-then-unlink window is racy in the worst case: two
 * processes both stat the same stale lock and both unlink it (the second
 * unlink hits an already-gone file and swallows ENOENT). NEITHER claims the
 * lock on that iteration -- both just set shouldRetryImmediately and loop.
 * On the next iteration both race a fresh O_EXCL openSync, so one wins and
 * the other falls back to EEXIST. Recovery is clean, just one iteration
 * later than the wording above might suggest.
 *
 * Limitation: a process killed (SIGKILL, power loss) leaves a lock that
 * blocks new writers for up to `LOCK_STALE_AFTER_MS` before recovery kicks
 * in. Acceptable for the assume-role write path; users who hit a permanent
 * "failed to acquire lock" error can manually remove `<credentials>.lock`.
 */
async function acquireLock(lockPath: string): Promise<void> {
  const start = Date.now();
  let attempt = 0;
  while (true) {
    // Timeout check at the top of the loop so EVERY iteration -- including
    // the stale-recovery and stat-failed `continue` paths below -- is bounded
    // by LOCK_MAX_WAIT_MS. Without this, two processes that keep recreating
    // the lock between our openSync and statSync could starve us forever.
    if (Date.now() - start > LOCK_MAX_WAIT_MS) {
      throw new Error(
        `upsertProfile: failed to acquire lock at ${lockPath} after ${LOCK_MAX_WAIT_MS}ms. If a previous writer crashed, remove the lock file manually.`,
      );
    }
    // Phase 1: try to atomically claim the lock file. The catch only fires
    // on openSync failure; write/close errors are handled separately in
    // Phase 2. Splitting the two paths keeps the cleanup intent explicit --
    // openSync-fail has nothing to unlink, write/close-fail does.
    let fd: number | null = null;
    try {
      fd = openSync(lockPath, "wx");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        // openSync itself failed for a non-EEXIST reason (EPERM on a
        // read-only ~/.aws, ENOENT on a missing parent dir, ENOSPC on a
        // full disk, ...). No lock file was created; nothing to clean up.
        // Propagate so the caller sees the real error instead of timing
        // out later with a misleading "failed to acquire lock" message.
        throw err;
      }
      // EEXIST: another writer holds the lock. Fall through to the
      // stale-check + backoff below.
    }

    if (fd !== null) {
      // Phase 2: lock is ours. Stamp it + close. If either throws, the
      // lock file exists but may be empty/garbled -- orphan-clean so new
      // writers don't block on it for LOCK_STALE_AFTER_MS.
      try {
        try {
          writeSync(fd, `pid=${process.pid} time=${Date.now()}\n`);
        } finally {
          closeSync(fd);
        }
        return;
      } catch (err) {
        try {
          unlinkSync(lockPath);
        } catch {
          // best-effort
        }
        throw err;
      }
    }
    let shouldRetryImmediately = false;
    try {
      const st = statSync(lockPath);
      if (Date.now() - st.mtimeMs > LOCK_STALE_AFTER_MS) {
        try {
          unlinkSync(lockPath);
        } catch {
          // Someone else already unlinked this stale lock (swallowed ENOENT).
          // We don't claim it here -- just loop and race openSync fresh.
        }
        shouldRetryImmediately = true;
      }
    } catch {
      // Lock removed under us between EEXIST and statSync; loop and race
      // openSync fresh (we don't claim it on this iteration).
      shouldRetryImmediately = true;
    }
    if (shouldRetryImmediately) continue;
    const cappedAttempt = Math.min(attempt, 8);
    const baseDelay = Math.min(LOCK_BASE_RETRY_MS * (1 + cappedAttempt), LOCK_MAX_RETRY_MS);
    await delay(baseDelay + Math.random() * baseDelay);
    attempt++;
  }
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // Best-effort: the lock may have already been swept by a stale-recovery
    // pass from another process. Either way we're done with it.
  }
}

/**
 * Read, modify, and atomically rewrite a credentials file. Creates the file
 * if it doesn't exist. The tmp file is opened 0o600, and renameSync replaces
 * the destination inode, so the resulting credentials file is 0o600 on Unix
 * without a follow-up chmod (open's mode is only ever narrowed by umask, never
 * widened).
 *
 * Returns `{ existed: true }` when the profile was already present and its
 * managed keys were overwritten in place, so callers can warn about it.
 *
 * Concurrent callers (multi-process or async) are serialized via a sidecar
 * lock file -- see `acquireLock` for the protocol.
 */
export async function upsertProfile(
  path: string,
  profile: string,
  creds: AssumedCredentials,
): Promise<{ existed: boolean }> {
  const lockPath = `${path}.lock`;
  await acquireLock(lockPath);
  try {
    const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
    const existed = profileExistsInText(existing, profile);
    const nextText = upsertProfileIntoText(existing, profile, creds);
    // randomUUID suffix prevents two same-process callers from clobbering
    // each other's in-flight tmp writes; the lock above prevents cross-
    // process clobber via the read-modify-rename race.
    const tmpPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
    const fd = openSync(tmpPath, "w", 0o600);
    try {
      try {
        writeSync(fd, nextText);
      } finally {
        closeSync(fd);
      }
      renameSync(tmpPath, path);
    } catch (err) {
      // The tmp file holds all three plaintext credentials. A failed
      // writeSync / closeSync / renameSync would otherwise strand it at
      // `<path>.tmp-<pid>-<uuid>` forever -- no cleanup path looks for that
      // name, and the caller (see tools/assume.ts) reports only "the write
      // failed". Unlink is best-effort and must not mask the real error, so
      // its own failure is swallowed and `err` is rethrown untouched.
      //
      // Only reachable BEFORE a successful rename: once renameSync returns,
      // tmpPath no longer exists and nothing after it can throw.
      try {
        unlinkSync(tmpPath);
      } catch {
        // best-effort
      }
      throw err;
    }
    return { existed };
  } finally {
    releaseLock(lockPath);
  }
}
