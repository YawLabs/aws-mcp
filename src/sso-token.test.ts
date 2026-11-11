import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { readSsoAccessToken } from "./sso-token.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const START = "https://acme.awsapps.com/start";
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

describe("readSsoAccessToken", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aws-mcp-ssotok-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const put = (name: string, body: Record<string, unknown>) => writeFileSync(join(dir, name), JSON.stringify(body));

  it("prefers sha1(session).json over a later-expiring scan match", () => {
    put(`${sha1("acme")}.json`, { startUrl: START, accessToken: "keyed", expiresAt: inHours(1) });
    put("other.json", { startUrl: START, accessToken: "scanned", expiresAt: inHours(5) });
    assert.equal(readSsoAccessToken({ ssoSession: "acme", startUrl: START }, dir)?.accessToken, "keyed");
  });

  it("falls back to a startUrl scan, latest expiry first", () => {
    put("a.json", { startUrl: START, accessToken: "older", expiresAt: inHours(1) });
    put("b.json", { startUrl: START, accessToken: "newer", expiresAt: inHours(3) });
    put("c.json", { startUrl: "https://other.awsapps.com/start", accessToken: "foreign", expiresAt: inHours(9) });
    assert.equal(readSsoAccessToken({ ssoSession: "acme", startUrl: START }, dir)?.accessToken, "newer");
  });

  it("ignores a sha1-named file whose startUrl differs (multi-org)", () => {
    put(`${sha1("acme")}.json`, {
      startUrl: "https://other.awsapps.com/start",
      accessToken: "x",
      expiresAt: inHours(2),
    });
    assert.equal(readSsoAccessToken({ ssoSession: "acme", startUrl: START }, dir), null);
  });

  it("treats expired and near-expiry tokens as absent", () => {
    put(`${sha1("acme")}.json`, {
      startUrl: START,
      accessToken: "x",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    assert.equal(readSsoAccessToken({ ssoSession: "acme", startUrl: START }, dir), null);
    put(`${sha1("acme")}.json`, {
      startUrl: START,
      accessToken: "x",
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    assert.equal(readSsoAccessToken({ ssoSession: "acme", startUrl: START }, dir), null, "30 s left is too little");
  });

  it("skips an oversize file", () => {
    put(`${sha1("acme")}.json`, {
      startUrl: START,
      accessToken: "x",
      expiresAt: inHours(2),
      pad: "p".repeat(70 * 1024),
    });
    assert.equal(readSsoAccessToken({ ssoSession: "acme", startUrl: START }, dir), null);
  });

  it("returns null for a missing cache directory", () => {
    assert.equal(readSsoAccessToken({ ssoSession: "acme", startUrl: START }, join(dir, "nope")), null);
  });
});

describe("readSsoAccessToken import guard", () => {
  // The bearer token must never reach a ToolResult. Keeping its reader out of
  // every tools module but one makes that reviewable: a new import here is a
  // new place the token could leak from, and should be a deliberate decision.
  it("is imported by no src/tools module except sso-setup.ts", () => {
    const toolsDir = join(repoRoot, "src", "tools");
    const offenders = readdirSync(toolsDir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "sso-setup.ts")
      .filter((f) => readFileSync(join(toolsDir, f), "utf-8").includes("readSsoAccessToken"));
    assert.deepEqual(offenders, []);
    // And the one allowed module really does use it -- otherwise this guard
    // would keep passing after a rename that moved the reader elsewhere.
    assert.match(readFileSync(join(toolsDir, "sso-setup.ts"), "utf-8"), /readSsoAccessToken/);
  });
});
