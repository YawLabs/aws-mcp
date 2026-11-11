import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_NAME_TEMPLATE,
  deriveProfileNames,
  envWithoutProfile,
  isValidAccountId,
  isValidRoleName,
  nameTemplateProblem,
  normalizeStartUrl,
  profileNameProblem,
  regionProblem,
  sanitizeAccountName,
  ssoSessionNameProblem,
} from "./sso-config.js";

describe("ssoSessionNameProblem / profileNameProblem", () => {
  const good = ["acme", "my-org", "org.prod@x", "a_b+c,d:e"];
  const bad = ["", "default", "has space", "-lead", "=lead", "a]b", "[a", "a\nb", "a\rb", "x".repeat(129)];
  for (const fn of [ssoSessionNameProblem, profileNameProblem]) {
    it(`${fn.name} accepts ${good.join(", ")}`, () => {
      for (const n of good) assert.equal(fn(n), null, n);
    });
    for (const n of bad) {
      it(`${fn.name} rejects ${JSON.stringify(n.slice(0, 20))}`, () => {
        assert.notEqual(fn(n), null);
      });
    }
  }
});

describe("normalizeStartUrl", () => {
  it("keeps the URL exactly as typed, trailing slash and path included", () => {
    for (const u of [
      "https://acme.awsapps.com/start",
      "https://acme.awsapps.com/start/",
      "https://identitycenter.amazonaws.com/ssoins-1234567890abcdef",
      "https://login.example.com/custom/path",
    ]) {
      assert.deepEqual(normalizeStartUrl(u), { ok: true, url: u });
    }
  });
  it("strips a fragment", () => {
    assert.deepEqual(normalizeStartUrl("https://acme.awsapps.com/start#/"), {
      ok: true,
      url: "https://acme.awsapps.com/start",
    });
  });
  for (const [label, u] of [
    ["http:", "http://acme.awsapps.com/start"],
    ["embedded credentials", "https://user:pw@acme.awsapps.com/start"],
    ["username only", "https://user@acme.awsapps.com/start"],
    ["whitespace", "https://acme.awsapps.com/st art"],
    ["newline", "https://acme.awsapps.com/start\n[profile x]"],
    ["bracket", "https://acme.awsapps.com/start]"],
    ["not a url", "acme.awsapps.com/start"],
    ["overlength", `https://acme.awsapps.com/${"x".repeat(600)}`],
  ] as const) {
    it(`rejects ${label}`, () => {
      assert.equal(normalizeStartUrl(u).ok, false);
    });
  }
});

describe("field validators", () => {
  it("regionProblem", () => {
    assert.equal(regionProblem("ssoRegion", "us-east-1"), null);
    assert.notEqual(regionProblem("ssoRegion", "--region"), null);
    assert.notEqual(regionProblem("ssoRegion", "US-EAST-1"), null);
  });
  it("isValidAccountId", () => {
    assert.equal(isValidAccountId("123456789012"), true);
    for (const v of ["12345678901", "1234567890123", "12345678901a", " 123456789012"]) {
      assert.equal(isValidAccountId(v), false, v);
    }
  });
  it("isValidRoleName", () => {
    assert.equal(isValidRoleName("AWSReservedSSO_Admin+x=y,z.w@q-1"), true);
    for (const v of ["Bad Role", "", "x".repeat(65), "a]b", "a\nb"]) {
      assert.equal(isValidRoleName(v), false, v);
    }
  });
  it("nameTemplateProblem: only known placeholders", () => {
    assert.equal(nameTemplateProblem(DEFAULT_NAME_TEMPLATE), null);
    assert.equal(nameTemplateProblem("{ssoSession}-{accountId}-{roleName}"), null);
    assert.notEqual(nameTemplateProblem("{accountName}-{role}"), null);
    assert.notEqual(nameTemplateProblem("{accountName}-{roleName"), null);
    assert.notEqual(nameTemplateProblem("{ssoSession}-fixed"), null, "a template that names every profile the same");
  });
  it("envWithoutProfile drops both profile selectors and nothing else", () => {
    const out = envWithoutProfile({ AWS_PROFILE: "x", AWS_DEFAULT_PROFILE: "y", HOME: "/h", AWS_CONFIG_FILE: "/c" });
    assert.deepEqual(out, { HOME: "/h", AWS_CONFIG_FILE: "/c" });
  });
});

describe("deriveProfileNames", () => {
  const e = (accountId: string, accountName: string, roleName: string) => ({ accountId, accountName, roleName });

  it("sanitizes the account name", () => {
    assert.equal(sanitizeAccountName("My Prod (EU)!"), "My-Prod-EU-");
    assert.equal(sanitizeAccountName("--=x"), "x");
    assert.equal(sanitizeAccountName("日本"), "");
    assert.deepEqual(deriveProfileNames([e("111111111111", "My Prod", "Admin")], DEFAULT_NAME_TEMPLATE, "acme"), [
      "My-Prod-Admin",
    ]);
  });

  it("gives EVERY member of a clash group the account ID, independent of order", () => {
    const a = e("111111111111", "prod", "Admin");
    const b = e("333333333333", "prod", "Admin");
    const c = e("222222222222", "dev", "Admin");
    const forward = deriveProfileNames([a, b, c], DEFAULT_NAME_TEMPLATE, "acme");
    assert.deepEqual(forward, ["prod-111111111111-Admin", "prod-333333333333-Admin", "dev-Admin"]);
    const reversed = deriveProfileNames([c, b, a], DEFAULT_NAME_TEMPLATE, "acme");
    assert.deepEqual(reversed, ["dev-Admin", "prod-333333333333-Admin", "prod-111111111111-Admin"]);
  });

  it("appends the account ID when the template has no {accountName}", () => {
    const names = deriveProfileNames(
      [e("111111111111", "a", "Admin"), e("222222222222", "b", "Admin")],
      "{roleName}",
      "acme",
    );
    assert.deepEqual(names, ["Admin-111111111111", "Admin-222222222222"]);
  });

  it("falls back to {accountId}-{roleName} when the name is unusable", () => {
    assert.deepEqual(deriveProfileNames([e("111111111111", "日本", "Admin")], "{accountName}", "acme"), [
      "111111111111-Admin",
    ]);
  });

  it("expands every placeholder", () => {
    assert.deepEqual(
      deriveProfileNames(
        [e("111111111111", "prod", "Admin")],
        "{ssoSession}.{accountName}.{accountId}.{roleName}",
        "acme",
      ),
      ["acme.prod.111111111111.Admin"],
    );
  });
});
