import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Authored in src/, executed from dist/: one hop up reaches the repo root in
// both layouts. The subject lives in scripts/, which tsconfig does not include,
// so the test cannot live beside it (the same arrangement as oam-floor.test.ts).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KEYS_DIR = join(repoRoot, "scripts", "oam-release-keys");
// The real v0.18.0 release's RELEASE-MANIFEST and .sig, downloaded from
// github.com/YawLabs/oam/releases/tag/v0.18.0 -- so the vendored trust root is
// checked against a signature oam actually published, offline.
const REAL = join(repoRoot, "src", "testing", "oam-release-v0.18.0");

interface Verify {
  parseTag(tag: string): number[] | null;
  predatesSigning(tag: string): boolean;
  principalsForTag(ranges: string, tag: string): string[];
  parseManifest(text: string, tag: string): Map<string, string>;
  verifyManifestSignature(opts: { manifestPath: string; sigPath: string; tag: string; keysDir?: string }): string;
  MANIFEST_HEADER: string;
}
const verify = (await import(pathToFileURL(join(repoRoot, "scripts", "lib", "oam-release-verify.mjs")).href)) as Verify;

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const hasSshKeygen = spawnSync("ssh-keygen", ["-Y"], { encoding: "utf8" }).error === undefined;
const HASH = "a".repeat(64);

describe("oam release verification: pure parts", () => {
  it("places tags before and after the first signed release", () => {
    assert.equal(verify.predatesSigning("v0.17.1"), true);
    assert.equal(verify.predatesSigning("v0.18.0"), false);
    assert.equal(verify.predatesSigning("0.18.1"), false);
    assert.throws(() => verify.predatesSigning("latest"), /not a plain vX\.Y\.Z/);
  });

  it("only offers a key whose range covers the tag", () => {
    const ranges = "# comment\nk1 v0.18.0 v0.21.3\nk2 v0.21.4 -\n";
    assert.deepEqual(verify.principalsForTag(ranges, "v0.17.1"), []);
    assert.deepEqual(verify.principalsForTag(ranges, "v0.18.0"), ["oam-release-k1"]);
    assert.deepEqual(verify.principalsForTag(ranges, "v0.21.3"), ["oam-release-k1"]);
    assert.deepEqual(verify.principalsForTag(ranges, "v0.21.4"), ["oam-release-k2"]);
    assert.deepEqual(verify.principalsForTag(ranges, "v1.0.0"), ["oam-release-k2"]);
  });

  it("vendors oam's trust root: k1 signs from v0.18.0", () => {
    const ranges = readFileSync(join(KEYS_DIR, "ranges"), "utf-8");
    assert.deepEqual(verify.principalsForTag(ranges, "v0.18.0"), ["oam-release-k1"]);
    assert.match(
      readFileSync(join(KEYS_DIR, "allowed_signers"), "utf-8"),
      /^oam-release-k1 namespaces="oam-release" ssh-ed25519 /m,
    );
  });

  it("reads the SUMS section only under the exact header for the requested tag", () => {
    const text = `${verify.MANIFEST_HEADER}\ntag v0.18.0\n${HASH} *oam-x86_64-unknown-linux-gnu\n`;
    assert.equal(verify.parseManifest(text, "v0.18.0").get("oam-x86_64-unknown-linux-gnu"), HASH);
    assert.throws(() => verify.parseManifest(text, "v0.18.1"), /signed for 'v0\.18\.0', not v0\.18\.1/);
    assert.throws(() => verify.parseManifest(text.replace(/\n/g, "\r\n"), "v0.18.0"), /not byte-exact/);
    assert.throws(() => verify.parseManifest(`other\n${text}`, "v0.18.0"), /line 1/);
    assert.throws(
      () => verify.parseManifest(`${verify.MANIFEST_HEADER}\ntag v0.18.0\nnot-a-hash x\n`, "v0.18.0"),
      /malformed/,
    );
  });
});

describe("oam release verification: signatures", { skip: hasSshKeygen ? false : "ssh-keygen not on PATH" }, () => {
  it("verifies the published v0.18.0 manifest against the vendored keys", () => {
    const principal = verify.verifyManifestSignature({
      manifestPath: join(REAL, "RELEASE-MANIFEST"),
      sigPath: join(REAL, "RELEASE-MANIFEST.sig"),
      tag: "v0.18.0",
    });
    assert.equal(principal, "oam-release-k1");
    const sums = verify.parseManifest(readFileSync(join(REAL, "RELEASE-MANIFEST"), "utf-8"), "v0.18.0");
    assert.ok(sums.has("oam-x86_64-unknown-linux-gnu"));
    assert.ok(sums.has("oam-aarch64-pc-windows-msvc.exe"));
  });

  it("refuses a manifest whose bytes changed after signing", () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-mcp-oamsig-"));
    dirs.push(dir);
    const manifest = readFileSync(join(REAL, "RELEASE-MANIFEST"), "utf-8").replace(/^[0-9a-f]{64}/m, HASH);
    writeFileSync(join(dir, "RELEASE-MANIFEST"), manifest);
    copyFileSync(join(REAL, "RELEASE-MANIFEST.sig"), join(dir, "RELEASE-MANIFEST.sig"));
    assert.throws(
      () =>
        verify.verifyManifestSignature({
          manifestPath: join(dir, "RELEASE-MANIFEST"),
          sigPath: join(dir, "RELEASE-MANIFEST.sig"),
          tag: "v0.18.0",
        }),
      /does not verify/,
    );
  });

  it("refuses a tag no vendored key may sign", () => {
    assert.throws(
      () =>
        verify.verifyManifestSignature({
          manifestPath: join(REAL, "RELEASE-MANIFEST"),
          sigPath: join(REAL, "RELEASE-MANIFEST.sig"),
          tag: "v0.17.1",
        }),
      /no key .* may sign v0\.17\.1/,
    );
  });
});
