// Verify an oam release the way oam's own installers and `oam self-update` do,
// for scripts/build-binary-oam.mjs, which ships an oam release binary (the
// cross-build carrier) inside a binary we publish.
//
// From v0.18.0 every oam release carries RELEASE-MANIFEST -- the line
// `oam-release-manifest v1`, the line `tag <tag>`, then the release's SHA256SUMS
// bytes verbatim -- and RELEASE-MANIFEST.sig, an SSH signature over it in
// namespace `oam-release` by a key in oam's release-keys/allowed_signers. The
// manifest is the trust root; the SHA256SUMS published beside it is unsigned and
// fetched from the same place as the binary, so checking a download against it
// proves only that the two came from the same server.
//
// Releases before v0.18.0 have no manifest. oam's installers check such a
// release's SHA256SUMS against a pinned digest of that file
// (release-keys/presigning-sums: bounded and immutable, one line per
// pre-signing tag) and refuse a tag the table does not list; so does
// verifyPresigningSums here.
//
// The trust root is VENDORED in scripts/oam-release-keys/ (byte-identical
// copies of oam's release-keys/allowed_signers, ranges and presigning-sums),
// never fetched alongside the release it is judging. When oam rotates a key,
// re-copy the files from the oam repo.
//
// Everything here fails closed: a missing ssh-keygen, a signature that does not
// verify, a manifest signed for another tag, a key outside its range, a
// pre-signing tag that is not pinned or whose SHA256SUMS does not match its
// pin, or an asset absent from (or listed twice in) the checksums is an error,
// never a warning.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_KEYS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'oam-release-keys');
export const MANIFEST_HEADER = 'oam-release-manifest v1';
export const SIGN_NAMESPACE = 'oam-release';
const PRINCIPAL_PREFIX = 'oam-release-';
/** The first signed release. Older tags have no manifest to verify. */
export const FIRST_SIGNED = [0, 18, 0];

/** 'v0.18.0' or '0.18.0' -> [0, 18, 0]; null for anything that is not a plain vX.Y.Z. */
export function parseTag(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(tag).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/** True when `tag` predates release signing, so only an unsigned SHA256SUMS exists for it. */
export function predatesSigning(tag) {
  const v = parseTag(tag);
  if (!v) throw new Error(`'${tag}' is not a plain vX.Y.Z tag`);
  return cmp(v, FIRST_SIGNED) < 0;
}

/**
 * The principals whose release-keys/ranges line covers `tag`, in ranges order.
 * `rangesText` is the file's contents: `<id> <from-tag> <to-tag or ->`, both
 * ends inclusive, `#` comments and blank lines ignored. A key with no line (a
 * staged next key) may sign nothing.
 */
export function principalsForTag(rangesText, tag) {
  const v = parseTag(tag);
  if (!v) throw new Error(`'${tag}' is not a plain vX.Y.Z tag`);
  const out = [];
  for (const raw of rangesText.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [id, from, to] = line.split(/\s+/);
    const lo = parseTag(from ?? '');
    if (!id || !lo) continue;
    if (cmp(v, lo) < 0) continue;
    if (to !== '-') {
      const hi = parseTag(to ?? '');
      if (!hi || cmp(v, hi) > 0) continue;
    }
    out.push(`${PRINCIPAL_PREFIX}${id}`);
  }
  return out;
}

/**
 * Check the manifest's header against `tag` (byte-exact: LF only) and return its
 * SHA256SUMS section as a Map of asset name -> lowercase sha256 hex. Only call
 * this AFTER the signature has verified -- until then the content is
 * attacker-controlled.
 */
export function parseManifest(manifestText, tag) {
  const want = `v${parseTag(tag)?.join('.')}`;
  const prefix = `${MANIFEST_HEADER}\ntag ${want}\n`;
  if (!manifestText.startsWith(prefix)) {
    const [line1 = '', line2 = ''] = manifestText.split('\n');
    if (line1.replace(/\r$/, '') !== MANIFEST_HEADER) {
      throw new Error(`RELEASE-MANIFEST line 1 is '${line1}', not '${MANIFEST_HEADER}'`);
    }
    if (/^tag /.test(line2) && line2.replace(/\r$/, '') !== `tag ${want}`) {
      throw new Error(`RELEASE-MANIFEST is signed for '${line2.slice(4)}', not ${want} -- a replayed or misfiled release`);
    }
    throw new Error(`RELEASE-MANIFEST's header is not byte-exact for ${want}`);
  }
  return parseSums(manifestText.slice(prefix.length), 'RELEASE-MANIFEST');
}

/**
 * A SHA256SUMS body as a Map of asset name -> lowercase sha256 hex. A malformed
 * line, or an asset listed twice, throws: the installers likewise refuse an
 * asset that is not listed exactly once. `what` names the source in errors.
 */
export function parseSums(text, what = 'SHA256SUMS') {
  const sums = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const [hash, rawName] = line.split(/\s+/);
    if (!/^[0-9a-f]{64}$/i.test(hash ?? '') || !rawName) {
      throw new Error(`${what} has a malformed SHA256SUMS line: '${line}'`);
    }
    const name = rawName.replace(/^\*/, '');
    if (sums.has(name)) throw new Error(`${what} lists ${name} more than once`);
    sums.set(name, hash.toLowerCase());
  }
  return sums;
}

/**
 * For a tag before v0.18.0: check the downloaded SHA256SUMS bytes against the
 * vendored pin for that tag (release-keys/presigning-sums, `<tag> <sha256>`),
 * as oam's installers do, and return its parsed entries. Throws when the tag
 * has no pin -- there is no such pre-signing release -- or the bytes differ.
 */
export function verifyPresigningSums({ sumsBytes, tag, keysDir = RELEASE_KEYS_DIR }) {
  const v = parseTag(tag);
  if (!v) throw new Error(`'${tag}' is not a plain vX.Y.Z tag`);
  const want = `v${v.join('.')}`;
  const pinsPath = join(keysDir, 'presigning-sums');
  let pinned = null;
  for (const raw of readFileSync(pinsPath, 'utf-8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [t, hash] = line.split(/\s+/);
    if (t === want) {
      pinned = (hash ?? '').toLowerCase();
      break;
    }
  }
  if (!pinned) {
    throw new Error(`${want} predates signed releases and has no pinned SHA256SUMS digest in ${pinsPath}`);
  }
  const got = createHash('sha256').update(sumsBytes).digest('hex');
  if (got !== pinned) {
    throw new Error(`SHA256SUMS for ${want} hashes to ${got}, but its pinned digest is ${pinned}`);
  }
  return parseSums(Buffer.from(sumsBytes).toString('utf-8'));
}

/**
 * `ssh-keygen -Y verify` the manifest against `signersPath`, once per principal
 * whose range covers `tag`. Returns the principal that verified; throws when
 * none does, or when ssh-keygen (8.1+ for -Y verify) cannot be run.
 */
export function verifyManifestSignature({
  manifestPath,
  sigPath,
  tag,
  keysDir = RELEASE_KEYS_DIR,
  sshKeygen = process.env.SSH_KEYGEN ?? 'ssh-keygen',
}) {
  const signersPath = join(keysDir, 'allowed_signers');
  const principals = principalsForTag(readFileSync(join(keysDir, 'ranges'), 'utf-8'), tag);
  if (principals.length === 0) {
    throw new Error(`no key in ${join(keysDir, 'ranges')} may sign ${tag}`);
  }
  const manifest = readFileSync(manifestPath);
  let last = '';
  for (const principal of principals) {
    try {
      execFileSync(
        sshKeygen,
        ['-Y', 'verify', '-f', signersPath, '-I', principal, '-n', SIGN_NAMESPACE, '-s', sigPath],
        { input: manifest, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      );
      return principal;
    } catch (err) {
      if (err?.code === 'ENOENT') {
        throw new Error(
          `${sshKeygen} was not found; verifying an oam release needs ssh-keygen 8.1 or later (set SSH_KEYGEN to its path)`,
        );
      }
      last = String(err?.stderr ?? err?.message ?? err).trim();
    }
  }
  throw new Error(`RELEASE-MANIFEST.sig does not verify for ${tag} against ${signersPath}: ${last}`);
}
