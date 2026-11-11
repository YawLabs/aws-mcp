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
 * The write itself loops until every byte lands (see writeAllSync) -- a SHORT
 * write doesn't throw, so without the loop the rename would publish a
 * truncated file through the very path that exists to prevent one.
 * The tmp file is opened with mode 0o600 and fchmod-ed to it before any byte
 * is written (a no-op on Windows; on oam the open mode alone does not stick --
 * see upsertProfile), so the credentials file inherits those permissions
 * through the rename -- matching the AWS CLI's own behavior. If anything
 * between the open and the rename
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

import { sectionName, splitSections, withLockedAtomicWrite } from "./ini-file.js";

// Moved to ini-file.ts (shared with the config-file writer) and re-exported so
// existing importers keep working.
export { sectionName, splitSections };

interface AssumedCredentials {
  aws_access_key_id: string;
  aws_secret_access_key: string;
  aws_session_token: string;
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

/**
 * Read, modify, and atomically rewrite a credentials file. Creates the file
 * if it doesn't exist. A thin caller of withLockedAtomicWrite (ini-file.ts),
 * which owns the lock, the 0o600 tmp file, the short-write loop and the
 * tmp-file cleanup; see its docs for the reasoning behind each.
 *
 * `requirePrivate: true` is the load-bearing option here: the file carries an
 * access key, a secret key and a session token in plaintext, so the tmp file's
 * mode is VERIFIED rather than assumed, and on a filesystem that silently
 * ignores chmod (a Windows drive under WSL, CIFS, FAT) the write is refused
 * instead (see private-file.ts).
 *
 * Returns `{ existed: true }` when the profile was already present and its
 * managed keys were overwritten in place, so callers can warn about it.
 */
export async function upsertProfile(
  path: string,
  profile: string,
  creds: AssumedCredentials,
): Promise<{ existed: boolean }> {
  let existed = false;
  await withLockedAtomicWrite(
    path,
    (existing) => {
      existed = profileExistsInText(existing, profile);
      return upsertProfileIntoText(existing, profile, creds);
    },
    {
      requirePrivate: true,
      privateHint:
        "Point AWS_SHARED_CREDENTIALS_FILE at a path on a native filesystem, or unset it to use ~/.aws/credentials.",
    },
  );
  return { existed };
}
