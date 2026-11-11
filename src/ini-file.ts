/**
 * The shared INI plumbing behind every file this server writes into the user's
 * AWS directory: `~/.aws/credentials` (aws_assume_role, via aws-credentials.ts)
 * and the AWS config file (aws_login_start's `[sso-session]` block and
 * aws_sso_generate_profiles' `[profile]` sections).
 *
 * Two layers live here:
 *
 *   - withLockedAtomicWrite: read -> transform -> write-to-tmp -> rename, inside
 *     a sidecar O_EXCL lock. Extracted unchanged from upsertProfile, which is now
 *     a thin caller of it, so both files get the same crash-safety (no truncated
 *     file can ever be published) and the same serialization of concurrent
 *     writers (two read-modify-renames cannot clobber each other).
 *
 *   - planConfigUpserts: a byte-preserving editor for "managed" sections. A
 *     section aws-mcp created carries a marker comment; only those sections are
 *     ever modified, and only their managed keys. Everything else in the file --
 *     comments, `[services x]` blocks, `[plugins]`, odd spacing, CRLF -- is left
 *     byte-for-byte as it was, because a user's AWS config is theirs and a
 *     reformat-on-write tool is one they stop trusting.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertPrivateMode, type ModeProbe } from "./private-file.js";

/**
 * Parse an INI-style file into an ordered list of sections.
 * We keep the list ordered so a round-trip preserves the user's layout.
 */
export interface Section {
  // The raw header line including brackets, e.g. "[profile foo]" or "[default]".
  // null for the pre-first-section preamble (comments / blank lines).
  header: string | null;
  // Raw text of the section body, including trailing newline.
  body: string;
}

// Single source of truth for what counts as a section header line. Both
// splitSections (which decides where a section starts) and sectionName (which
// extracts the name back out of the stored raw line) MUST use this -- they
// previously disagreed, see the sectionName comment below. planConfigUpserts
// uses it too, so the config editor and the credentials editor can never
// disagree about where a section begins.
//
// Shape: botocore reads the file with RawConfigParser, whose SECTCRE is the
// UNANCHORED `\[(?P<header>.+)\]` -- greedy up to the LAST `]`, anything after
// it ignored. So `[profile x]  # note` and `[profile x] ; note` are the header
// `profile x` to botocore. An end-anchored regex here missed them: the readers
// folded the hand-written section into the one above it, and the writer either
// rewrote its keys or appended a duplicate section that RawConfigParser then
// rejects (DuplicateSectionError breaks every CLI/SDK call). The optional
// leading U+FEFF lets a BOM-prefixed file's FIRST header be seen too; the BOM
// stays in the raw line, so it is re-emitted byte-for-byte.
const SECTION_HEADER_RE = /^\uFEFF?\[(.+)\]/;

export function splitSections(text: string): Section[] {
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
 * the RAW line, and the regex tolerates anything after the closing
 * bracket (whitespace, a comment). A naive slice(1, -1) on `"[mcp-dev]  "` drops the final
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
export function sectionName(header: string): string {
  return (SECTION_HEADER_RE.exec(header)?.[1] ?? "").trim();
}

/**
 * Normalize a header's inner text the way botocore reads it: trim, then
 * collapse the whitespace between the `profile` / `sso-session` keyword and the
 * name. So `[profile  prod]` and `[ profile prod ]` are both `profile prod` --
 * botocore would treat either as THE prod profile, and a writer that thought
 * they were different would append a second `[profile prod]` that botocore
 * then merges unpredictably with the first.
 */
export function normalizeHeaderName(inner: string): string {
  return inner.trim().replace(/^(profile|sso-session)\s+/, "$1 ");
}

/**
 * The ownership marker. A section whose body carries a comment line matching
 * this was created by aws-mcp and may be updated by it; any other section is the
 * user's and is never modified. Matching is deliberately loose about the comment
 * character and spacing (`;managed-by: aws-mcp` counts) so a user who re-types
 * the line by hand to hand a section TO aws-mcp is not defeated by a space.
 */
export const MANAGED_MARKER_RE = /^\s*[#;]\s*managed-by: aws-mcp\b/;

// ---------------------------------------------------------------------------
// Value guard
// ---------------------------------------------------------------------------

/** Cap on any single value written into an INI file. Far above any real start
 *  URL, region, account ID, role name or profile name. */
const MAX_INI_VALUE_CHARS = 512;

/**
 * Why `value` cannot be written into an INI header or `key = value` line, or
 * null when it can.
 *
 * Every rule here closes a specific injection: a newline (or any C0 control)
 * would start a new line -- a new key or a whole new `[section]` -- inside the
 * one being written; `[` / `]` can forge or truncate a header; leading or
 * trailing whitespace is silently trimmed by the reader, so the value read back
 * would differ from the one compared; a leading `#` / `;` turns the value into
 * a comment on some readers. Applied to API-sourced values too (account names,
 * role names): they are admin-controlled, but still untrusted text.
 */
export function iniValueProblem(value: string): string | null {
  if (value.length === 0) return "is empty";
  if (value.length > MAX_INI_VALUE_CHARS) return `is longer than ${MAX_INI_VALUE_CHARS} characters`;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
  if (/[\x00-\x1f\x7f]/.test(value)) return "contains a control character (newline, tab, NUL, ...)";
  if (/[[\]]/.test(value)) return "contains '[' or ']'";
  if (value !== value.trim()) return "has leading or trailing whitespace";
  if (value.startsWith("#") || value.startsWith(";")) return "starts with '#' or ';'";
  return null;
}

/** Throwing form of {@link iniValueProblem}, for values that were already
 *  validated upstream and reaching here unsafe would be a bug. */
export function assertIniSafe(value: string, what: string): void {
  const problem = iniValueProblem(value);
  if (problem) throw new Error(`Refusing to write ${what} into an INI file: the value ${problem}.`);
}

// ---------------------------------------------------------------------------
// Managed-section upserts (byte preserving)
// ---------------------------------------------------------------------------

export interface ManagedSectionSpec {
  /** Exact header text, e.g. "profile prod-Admin" or "sso-session acme". */
  header: string;
  /** Full comment line written first in the body of a NEW section. */
  marker: string;
  /** Managed key/value pairs, in order. Rewritten on every upsert of a managed section. */
  keys: ReadonlyArray<readonly [string, string]>;
  /**
   * Keys written only when the section is CREATED and never touched afterwards.
   * `region` in a generated profile is one: a user who changes it has made a
   * choice, and the next generate run must not quietly undo it.
   */
  createOnlyKeys?: ReadonlyArray<readonly [string, string]>;
}

export type UpsertOutcome = "created" | "updated" | "unchanged" | "refused-unmanaged";

/** One physical line, kept with its own line terminator so it can be re-emitted
 *  byte-for-byte. */
interface RawLine {
  content: string;
  eol: string;
}

function toRawLines(text: string): RawLine[] {
  const out: RawLine[] = [];
  const re = /\r?\n/g;
  let last = 0;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    out.push({ content: text.slice(last, m.index), eol: m[0] });
    last = m.index + m[0].length;
    m = re.exec(text);
  }
  if (last < text.length) out.push({ content: text.slice(last), eol: "" });
  return out;
}

function fromRawLines(lines: readonly RawLine[]): string {
  return lines.map((l) => l.content + l.eol).join("");
}

/** The file's line ending, judged by its FIRST line break: a CRLF file stays
 *  CRLF, so a Windows user's config does not come back with mixed endings. */
export function detectEol(text: string): string {
  const i = text.indexOf("\n");
  return i > 0 && text[i - 1] === "\r" ? "\r\n" : "\n";
}

interface LocatedSection {
  /** Index of the header line. */
  start: number;
  /** One past the last body line (the next header, or lines.length). */
  end: number;
}

function findSection(lines: readonly RawLine[], header: string): LocatedSection | null {
  const want = normalizeHeaderName(header);
  for (let i = 0; i < lines.length; i++) {
    const m = SECTION_HEADER_RE.exec(lines[i].content);
    if (!m || normalizeHeaderName(m[1]) !== want) continue;
    let end = i + 1;
    while (end < lines.length && !SECTION_HEADER_RE.test(lines[end].content)) end++;
    return { start: i, end };
  }
  return null;
}

/** Key of a `key = value` line, lowercased (botocore's RawConfigParser
 *  lowercases option names), or null for comments, blanks and junk. */
function lineKey(content: string): string | null {
  const t = content.trim();
  if (!t || t.startsWith("#") || t.startsWith(";")) return null;
  const eq = t.indexOf("=");
  if (eq <= 0) return null;
  return t.slice(0, eq).trim().toLowerCase();
}

function lineValue(content: string): string {
  const eq = content.indexOf("=");
  return eq < 0 ? "" : content.slice(eq + 1).trim();
}

/** Is the section body between `start+1` and `end` marked as aws-mcp's? */
export function isManagedBody(bodyLines: readonly string[]): boolean {
  return bodyLines.some((l) => MANAGED_MARKER_RE.test(l));
}

function upsertOne(lines: RawLine[], spec: ManagedSectionSpec, eol: string): UpsertOutcome {
  const found = findSection(lines, spec.header);
  if (!found) {
    // Append at EOF. The previous last line gets a terminator if it lacked one,
    // and a blank line separates our section from whatever came before -- but
    // an empty file gets no leading blank line.
    if (lines.length > 0) {
      const last = lines[lines.length - 1];
      if (last.eol === "") last.eol = eol;
      if (last.content.trim() !== "") lines.push({ content: "", eol });
    }
    lines.push({ content: `[${spec.header}]`, eol });
    lines.push({ content: spec.marker, eol });
    for (const [k, v] of [...spec.keys, ...(spec.createOnlyKeys ?? [])]) {
      lines.push({ content: `${k} = ${v}`, eol });
    }
    return "created";
  }

  const body = lines.slice(found.start + 1, found.end);
  if (!isManagedBody(body.map((l) => l.content))) return "refused-unmanaged";

  let changed = false;
  const seen = new Set<string>();
  const wanted = new Map(spec.keys.map(([k, v]) => [k.toLowerCase(), v] as const));
  let lastManagedIdx = -1;
  let markerIdx = -1;
  for (let i = found.start + 1; i < found.end; i++) {
    const line = lines[i];
    if (markerIdx < 0 && MANAGED_MARKER_RE.test(line.content)) markerIdx = i;
    const key = lineKey(line.content);
    if (key === null || !wanted.has(key)) continue;
    lastManagedIdx = i;
    seen.add(key);
    const want = wanted.get(key) as string;
    // Only rewrite a line whose VALUE differs, so an unchanged section keeps
    // its exact spacing (`key=value`, tabs, whatever the user had).
    if (lineValue(line.content) !== want) {
      line.content = `${key} = ${want}`;
      changed = true;
    }
  }
  const missing = spec.keys.filter(([k]) => !seen.has(k.toLowerCase()));
  if (missing.length > 0) {
    // After the last managed key, else straight after the marker -- never at the
    // section's end, where the user's blank separator lines live.
    const at = (lastManagedIdx >= 0 ? lastManagedIdx : markerIdx >= 0 ? markerIdx : found.start) + 1;
    // The line we insert after may be the file's unterminated last line.
    if (lines[at - 1].eol === "") lines[at - 1].eol = eol;
    lines.splice(at, 0, ...missing.map(([k, v]) => ({ content: `${k} = ${v}`, eol })));
    changed = true;
  }
  return changed ? "updated" : "unchanged";
}

/**
 * Apply `specs` to `text` in order and report what happened to each.
 *
 * - Absent section: appended at EOF with the marker and every key.
 * - Managed section: only the managed keys' values are replaced; missing
 *   managed keys are inserted after the last managed key. User-added keys,
 *   comments and blank lines are kept exactly. createOnlyKeys are ignored.
 * - Unmanaged section: untouched, outcome `refused-unmanaged`.
 *
 * Every byte outside a touched section is preserved, including the file's line
 * endings. `[default]` is never a valid target -- callers never build one.
 */
export function planConfigUpserts(
  text: string,
  specs: readonly ManagedSectionSpec[],
): { text: string; outcomes: UpsertOutcome[] } {
  const eol = detectEol(text);
  const lines = toRawLines(text);
  const outcomes = specs.map((spec) => {
    if (normalizeHeaderName(spec.header) === "default") {
      throw new Error("planConfigUpserts: [default] is never a managed target.");
    }
    return upsertOne(lines, spec, eol);
  });
  return { text: fromRawLines(lines), outcomes };
}

/**
 * One section of a config file as read by the managed-section editor: its
 * normalized header name, whether it carries the marker, and its key/value
 * pairs (lowercased keys, last one wins as in botocore).
 */
export interface ReadSection {
  name: string;
  managed: boolean;
  values: Map<string, string>;
}

export function readSections(text: string): ReadSection[] {
  const lines = toRawLines(text);
  const out: ReadSection[] = [];
  let current: ReadSection | null = null;
  for (const l of lines) {
    const m = SECTION_HEADER_RE.exec(l.content);
    if (m) {
      current = { name: normalizeHeaderName(m[1]), managed: false, values: new Map() };
      out.push(current);
      continue;
    }
    if (!current) continue;
    if (MANAGED_MARKER_RE.test(l.content)) current.managed = true;
    const key = lineKey(l.content);
    if (key !== null) current.values.set(key, lineValue(l.content));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Locked atomic write
// ---------------------------------------------------------------------------

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
 * in. Acceptable for these write paths; users who hit a permanent
 * "failed to acquire lock" error can manually remove `<file>.lock`.
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
 * Write EVERY byte of `text` to `fd`, looping until the buffer is drained.
 *
 * writeSync returns how many bytes it actually wrote, and POSIX permits that
 * to be FEWER than requested -- pipes, network filesystems (a ~/.aws on NFS
 * or a mounted share is not exotic) and EINTR-interrupted syscalls all
 * produce short writes. Crucially a short write does NOT throw, so the
 * caller's try/catch never sees it: dropping writeSync's return value would
 * renameSync a TRUNCATED file over the user's real credentials. That is both
 * data loss (the other profiles in the file are gone) and a broken-auth state
 * (the profile we just wrote is half a secret key), and the atomic-rename
 * dance exists precisely to make that impossible.
 *
 * The loop tracks BYTE offsets into a Buffer rather than string indices: a
 * multi-byte UTF-8 character split across a short write would desync a
 * string-sliced retry and corrupt the output.
 *
 * A non-positive return would spin forever, so it is treated as a hard
 * failure instead. That throws into the caller's catch, which unlinks the tmp
 * file and propagates -- an error beats a hung call, and beats a truncated
 * file.
 */
function writeAllSync(fd: number, text: string): void {
  const buf = Buffer.from(text, "utf-8");
  let written = 0;
  while (written < buf.byteLength) {
    const n = writeSync(fd, buf, written, buf.byteLength - written);
    if (n <= 0) {
      throw new Error(
        `upsertProfile: write stalled after ${written} of ${buf.byteLength} bytes; refusing to rename a truncated credentials file.`,
      );
    }
    written += n;
  }
}

/**
 * Rename with one retry on Windows sharing errors. A rename onto a file another
 * process holds open (an editor, an antivirus scan, a concurrent `aws` reading
 * the config) fails with EPERM / EBUSY / EACCES there; it almost always clears
 * within milliseconds. One retry, per the single-retry rule -- a second failure
 * is a real problem and is surfaced.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  try {
    renameSync(from, to);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
    await delay(100);
    renameSync(from, to);
  }
}

export interface LockedWriteOptions {
  /**
   * Verify the tmp file really is 0600 before writing (assertPrivateMode), and
   * refuse the write if it is not. TRUE for the credentials file, which holds
   * secrets. FALSE for the config file: it holds no secrets, so a WSL / CIFS /
   * FAT mount that reports 0777 must not make generating profiles impossible.
   * The file is still created 0600 either way.
   */
  requirePrivate: boolean;
  /** Completes assertPrivateMode's message; names the env var that chose the path. */
  privateHint?: string;
  /**
   * mkdir -p the file's directory (0700) before taking the lock. A brand-new
   * per-user HOME has no `.aws`, and the lock file cannot be created without it.
   */
  ensureDir?: boolean;
  /** Test seam: platform + mode probe handed to assertPrivateMode, so the
   *  mode-ignoring-filesystem branch is drivable from any host. */
  privateModeOpts?: { platform?: NodeJS.Platform; probe?: ModeProbe };
}

/** The real file behind `path` (symlinks resolved), or `path` itself when it
 *  does not exist yet. */
function resolveWriteTarget(path: string): string {
  try {
    return realpathSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return path;
    throw err;
  }
}

/**
 * Read `path` (as "" when absent), hand it to `transform`, and atomically
 * replace the file with the result -- all under the `<path>.lock` sidecar lock.
 *
 * `transform` returns null for "no change": then nothing is written and no
 * rename happens, so an idempotent rerun leaves the file's mtime alone (and a
 * file that did not exist is not created).
 *
 * The tmp file is opened with mode 0o600 and fchmod-ed to it before any byte is
 * written (a no-op on Windows; on oam before 0.19.1 the open mode alone did not
 * stick), so the destination inherits those permissions through the rename --
 * matching the AWS CLI's own behavior. If anything between the open and the
 * rename throws -- including assertPrivateMode or `transform` itself -- the tmp
 * file is unlinked and the lock released, so nothing is stranded.
 *
 * The fchmod is not redundant belt-and-braces: open's mode argument is honoured
 * by node (and only ever narrowed by umask, never widened), but oam before
 * 0.19.1 DROPPED it -- measured 2026-09-20 on WIN32/ARM64, oam 0.16.2: a file
 * opened 0o400 came back writable where node marks it read-only. oam 0.19.1
 * (the launcher's floor) honours it like node, but a client running `oam run`
 * directly bypasses the floor, and a mount with no inode mode ignores both.
 * It goes on the fd rather than the path so there is no moment where the file
 * holds content at a wider mode.
 */
export async function withLockedAtomicWrite(
  givenPath: string,
  transform: (text: string) => string | null,
  opts: LockedWriteOptions,
): Promise<{ changed: boolean }> {
  if (opts.ensureDir) mkdirSync(dirname(givenPath), { recursive: true, mode: 0o700 });
  // Write THROUGH a symlink, not over it. A dotfiles-managed ~/.aws/config ->
  // ~/dotfiles/aws/config would otherwise be replaced by a regular file: rename
  // swaps the directory entry, so the link is lost and the dotfiles copy never
  // sees the change. The lock, the tmp file and the rename all sit beside the
  // TARGET, which also keeps the rename on one filesystem. `aws configure sso`
  // writes in place and keeps the link; this matches it.
  const path = resolveWriteTarget(givenPath);
  const lockPath = `${path}.lock`;
  await acquireLock(lockPath);
  try {
    const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
    // Inside the lock, so the transform sees the text it is about to replace --
    // a plan computed from an earlier read would be a lost update.
    const nextText = transform(existing);
    if (nextText === null) return { changed: false };
    // randomUUID suffix prevents two same-process callers from clobbering
    // each other's in-flight tmp writes; the lock above prevents cross-
    // process clobber via the read-modify-rename race.
    const tmpPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
    const fd = openSync(tmpPath, "w", 0o600);
    try {
      try {
        // Before writeAllSync, so the content never exists on disk at a mode
        // open(2) set and something ignored (oam before 0.19.1 did).
        fchmodSync(fd, 0o600);
        // And VERIFY it, before any secret byte exists, when the file holds
        // secrets. fchmod succeeding is not the same as the mode being set: on a
        // filesystem with no inode mode it returns success and changes nothing,
        // which would leave plaintext credentials in a world-readable AND
        // world-writable file with nothing able to detect it. Reachable through
        // a documented, advertised variable -- AWS_SHARED_CREDENTIALS_FILE
        // pointed at a Windows-side ~/.aws so a WSL distro and its Windows host
        // share one credentials file. Measured 0777 there against the real
        // upsertProfile. Throwing here hands control to the catch below, which
        // unlinks the tmp file, so nothing is stranded and nothing secret was
        // written.
        if (opts.requirePrivate) {
          assertPrivateMode(
            fd,
            tmpPath,
            opts.privateHint ?? "Point the file at a path on a native filesystem.",
            opts.privateModeOpts ?? {},
          );
        }
        // Loops on the byte count: a partial write must not be renamed over
        // the real file. See writeAllSync.
        writeAllSync(fd, nextText);
      } finally {
        closeSync(fd);
      }
      await renameWithRetry(tmpPath, path);
    } catch (err) {
      // The tmp file may hold plaintext credentials. A failed writeSync /
      // closeSync / renameSync would otherwise strand it at
      // `<path>.tmp-<pid>-<uuid>` forever -- no cleanup path looks for that
      // name. Unlink is best-effort and must not mask the real error, so its
      // own failure is swallowed and `err` is rethrown untouched.
      //
      // Only reachable BEFORE a successful rename: once the rename returns,
      // tmpPath no longer exists and nothing after it can throw.
      try {
        unlinkSync(tmpPath);
      } catch {
        // best-effort
      }
      throw err;
    }
    return { changed: true };
  } finally {
    releaseLock(lockPath);
  }
}
