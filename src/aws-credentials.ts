/**
 * Minimal read/modify/write for ~/.aws/credentials.
 *
 * The goal is narrow: upsert a single profile section with our three keys
 * (aws_access_key_id, aws_secret_access_key, aws_session_token) without
 * touching anything else. Comments, whitespace between sections, unrelated
 * profiles, and keys we don't manage all pass through unchanged.
 *
 * We write to a .tmp file first and rename on top of the original so a
 * crash mid-write can't leave the user with a truncated credentials file.
 * On Unix we chmod 0o600 to match the AWS CLI's own behavior.
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  type Stats,
  statSync,
  writeSync,
} from "node:fs";
import { platform } from "node:os";

export interface AssumedCredentials {
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

function splitSections(text: string): Section[] {
  const sections: Section[] = [];
  let current: Section = { header: null, body: "" };
  for (const rawLine of text.split(/\r?\n/)) {
    const headerMatch = rawLine.match(/^\[(.+)\]\s*$/);
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

function sectionName(header: string): string {
  return header.slice(1, -1).trim();
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
    const key = line.slice(0, eqIdx).trim();
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
 * Read, modify, and atomically rewrite a credentials file. Creates the file
 * if it doesn't exist. Applies 0o600 permissions on Unix.
 */
export function upsertProfile(path: string, profile: string, creds: AssumedCredentials): void {
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const nextText = upsertProfileIntoText(existing, profile, creds);
  // Pid alone collides if two upsertProfile calls overlap in the same
  // process (e.g. concurrent aws_assume_role). The randomUUID suffix makes
  // tmpfiles unique per call so the second call's openSync(w) can't
  // truncate the first's in-flight write.
  //
  // Residual race: two concurrent calls each finish their write and then
  // both call renameSync(tmpPath, path). The second rename atomically
  // replaces the first. For two callers updating the SAME profile the
  // last-writer-wins outcome is the natural semantics. For two callers
  // updating DIFFERENT profiles in the file at the same time, the second
  // caller's read happened before the first caller's rename, so the first
  // caller's profile changes are lost when the second rename lands. Fixing
  // this needs a file lock or a single-writer queue; tracked as future
  // work, not closed by the UUID suffix alone.
  const tmpPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const fd = openSync(tmpPath, "w", 0o600);
  try {
    writeSync(fd, nextText);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, path);
  if (platform() !== "win32") {
    let existingMode = 0o600;
    if (existsSync(path)) {
      const st: Stats = statSync(path);
      existingMode = st.mode & 0o777;
    }
    // If the file was more permissive, tighten it.
    if ((existingMode & 0o077) !== 0) chmodSync(path, 0o600);
  }
}
