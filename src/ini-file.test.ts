import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  iniValueProblem,
  type ManagedSectionSpec,
  normalizeHeaderName,
  planConfigUpserts,
  readSections,
  withLockedAtomicWrite,
} from "./ini-file.js";
import { MANAGED_MARKER, renderProfileSpec, renderSessionSpec } from "./sso-config.js";

const PROD = renderProfileSpec({
  profileName: "prod-Admin",
  ssoSession: "acme",
  accountId: "111111111111",
  roleName: "Admin",
  region: "us-east-1",
});

describe("planConfigUpserts", () => {
  it("creates a section in an empty file with no leading blank line", () => {
    const r = planConfigUpserts("", [PROD]);
    assert.deepEqual(r.outcomes, ["created"]);
    assert.equal(
      r.text,
      `[profile prod-Admin]\n${MANAGED_MARKER}\nsso_session = acme\nsso_account_id = 111111111111\nsso_role_name = Admin\nregion = us-east-1\n`,
    );
  });

  it("appends to a file with no trailing newline, separated by a blank line", () => {
    const r = planConfigUpserts("[default]\nregion = eu-west-1", [PROD]);
    assert.deepEqual(r.outcomes, ["created"]);
    assert.ok(r.text.startsWith("[default]\nregion = eu-west-1\n\n[profile prod-Admin]\n"), r.text);
  });

  it("keeps a CRLF file CRLF", () => {
    const r = planConfigUpserts("[default]\r\nregion = eu-west-1\r\n", [PROD]);
    assert.ok(r.text.startsWith("[default]\r\nregion = eu-west-1\r\n\r\n[profile prod-Admin]\r\n"), r.text);
    assert.doesNotMatch(r.text.replace(/\r\n/g, ""), /\n/, "no bare LF may be introduced");
  });

  it("preserves every byte of unrelated sections, comments and odd spacing", () => {
    const fixture =
      "; leading comment\n" +
      "[default]\n" +
      "region=us-west-2   \n" +
      "\n" +
      "[services my-endpoints]\n" +
      "dynamodb =\n" +
      "  endpoint_url = http://localhost:8000\n" +
      "\n" +
      "[plugins]\n" +
      "cli_legacy_plugin_path = /x\n" +
      "# trailing comment\t\n";
    const r = planConfigUpserts(fixture, [PROD]);
    assert.ok(r.text.startsWith(fixture), "the original text must survive as an exact prefix");
    // And applying nothing is the identity.
    assert.equal(planConfigUpserts(fixture, []).text, fixture);
  });

  it("updates only the managed keys of a managed section, keeping user keys, comments and spacing", () => {
    const before =
      "[profile prod-Admin]\n" +
      `${MANAGED_MARKER}\n` +
      "sso_session = old-session\n" +
      "sso_account_id=111111111111\n" +
      "; my note\n" +
      "sso_role_name = Admin\n" +
      "region = eu-central-1\n" +
      "output = table\n" +
      "\n" +
      "[profile other]\n" +
      "region = us-east-1\n";
    const r = planConfigUpserts(before, [PROD]);
    assert.deepEqual(r.outcomes, ["updated"]);
    assert.equal(r.text, before.replace("sso_session = old-session", "sso_session = acme"));
    // region is create-only: the user's eu-central-1 survives.
    assert.match(r.text, /region = eu-central-1/);
    assert.match(r.text, /output = table/);
  });

  it("inserts a missing managed key after the last managed key", () => {
    const before = `[profile prod-Admin]\n${MANAGED_MARKER}\nsso_session = acme\nsso_account_id = 111111111111\noutput = json\n`;
    const r = planConfigUpserts(before, [PROD]);
    assert.deepEqual(r.outcomes, ["updated"]);
    assert.equal(
      r.text,
      `[profile prod-Admin]\n${MANAGED_MARKER}\nsso_session = acme\nsso_account_id = 111111111111\nsso_role_name = Admin\noutput = json\n`,
    );
  });

  it("reports an identical managed section as unchanged and leaves its bytes alone", () => {
    const first = planConfigUpserts("", [PROD]).text;
    const again = planConfigUpserts(first, [PROD]);
    assert.deepEqual(again.outcomes, ["unchanged"]);
    assert.equal(again.text, first);
  });

  it("refuses an unmanaged section and leaves the text identical", () => {
    const before = "[profile prod-Admin]\nsso_session = mine\nsso_account_id = 999999999999\n";
    const r = planConfigUpserts(before, [PROD]);
    assert.deepEqual(r.outcomes, ["refused-unmanaged"]);
    assert.equal(r.text, before);
  });

  it("treats [profile  x] and [ profile x ] as the same section as profile x", () => {
    for (const header of ["[profile  prod-Admin]", "[ profile prod-Admin ]", "[profile\tprod-Admin]"]) {
      const before = `${header}\nsso_session = mine\n`;
      const r = planConfigUpserts(before, [PROD]);
      assert.deepEqual(r.outcomes, ["refused-unmanaged"], header);
      assert.equal(r.text, before);
    }
    assert.equal(normalizeHeaderName(" sso-session   acme "), "sso-session acme");
  });

  it("accepts a hand-typed marker variant (ownership can be handed TO aws-mcp)", () => {
    const before = "[sso-session acme]\n;managed-by: aws-mcp\nsso_start_url = https://old.awsapps.com/start\n";
    const r = planConfigUpserts(before, [renderSessionSpec("acme", "https://new.awsapps.com/start", "us-east-1")]);
    assert.deepEqual(r.outcomes, ["updated"]);
    assert.match(r.text, /sso_start_url = https:\/\/new\.awsapps\.com\/start/);
  });

  it("never targets [default]", () => {
    const spec: ManagedSectionSpec = { header: "default", marker: MANAGED_MARKER, keys: [["region", "x"]] };
    assert.throws(() => planConfigUpserts("", [spec]), /never a managed target/);
  });

  it("readSections reports managed + values with normalized names", () => {
    const text = planConfigUpserts("[ profile  hand ]\nregion = x\n", [PROD]).text;
    const secs = readSections(text);
    assert.deepEqual(
      secs.map((s) => [s.name, s.managed]),
      [
        ["profile hand", false],
        ["profile prod-Admin", true],
      ],
    );
    assert.equal(secs[1].values.get("sso_account_id"), "111111111111");
  });
});

describe("iniValueProblem", () => {
  const rejects = ["", "a\nb", "a\rb", "a\0b", "a\tb", "x]", "[x", " lead", "trail ", "#c", ";c", "x".repeat(513)];
  for (const v of rejects) {
    it(`rejects ${JSON.stringify(v.length > 20 ? `${v.slice(0, 10)}...` : v)}`, () => {
      assert.notEqual(iniValueProblem(v), null);
    });
  }
  it("accepts ordinary values", () => {
    for (const v of ["https://acme.awsapps.com/start", "us-east-1", "Admin+x=y,z.w@q-1", "a#b"]) {
      assert.equal(iniValueProblem(v), null, v);
    }
  });
});

describe("withLockedAtomicWrite", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aws-mcp-ini-"));
    path = join(dir, "config");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const append = (spec: ManagedSectionSpec) => (text: string) => planConfigUpserts(text, [spec]).text;

  it("creates a nonexistent file", async () => {
    const r = await withLockedAtomicWrite(path, append(PROD), { requirePrivate: false });
    assert.equal(r.changed, true);
    assert.match(readFileSync(path, "utf-8"), /\[profile prod-Admin\]/);
  });

  it("ensureDir creates a missing .aws directory (fresh per-user HOME)", async () => {
    const nested = join(dir, "home", ".aws", "config");
    await withLockedAtomicWrite(nested, append(PROD), { requirePrivate: false, ensureDir: true });
    assert.ok(existsSync(nested));
  });

  it("without ensureDir a missing directory surfaces the real error", async () => {
    const nested = join(dir, "nope", "config");
    await assert.rejects(withLockedAtomicWrite(nested, append(PROD), { requirePrivate: false }), /ENOENT/);
  });

  it("an identical rerun reports changed:false and does not move the mtime", async () => {
    await withLockedAtomicWrite(path, append(PROD), { requirePrivate: false });
    const before = statSync(path).mtimeMs;
    const bytes = readFileSync(path);
    await new Promise((r) => setTimeout(r, 30));
    const r = await withLockedAtomicWrite(
      path,
      (text) => {
        const p = planConfigUpserts(text, [PROD]);
        return p.outcomes[0] === "unchanged" ? null : p.text;
      },
      { requirePrivate: false },
    );
    assert.equal(r.changed, false);
    assert.equal(statSync(path).mtimeMs, before);
    assert.deepEqual(readFileSync(path), bytes);
  });

  it("two concurrent writers both land", async () => {
    const other = renderProfileSpec({
      profileName: "dev-Admin",
      ssoSession: "acme",
      accountId: "222222222222",
      roleName: "Admin",
      region: "us-east-1",
    });
    await Promise.all([
      withLockedAtomicWrite(path, append(PROD), { requirePrivate: false }),
      withLockedAtomicWrite(path, append(other), { requirePrivate: false }),
    ]);
    const text = readFileSync(path, "utf-8");
    assert.match(text, /\[profile prod-Admin\]/);
    assert.match(text, /\[profile dev-Admin\]/);
  });

  it("waits for a lock another writer holds before reading the file", async () => {
    // In-process concurrency alone cannot prove the lock: the transform is
    // synchronous, so two calls would serialize anyway. Hold the lock by hand
    // instead and check the write does not happen until it is released.
    writeFileSync(`${path}.lock`, "pid=0\n");
    let read: string | null = null;
    const pending = withLockedAtomicWrite(
      path,
      (text) => {
        read = text;
        return planConfigUpserts(text, [PROD]).text;
      },
      { requirePrivate: false },
    );
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(read, null, "the transform ran while another writer held the lock");
    writeFileSync(path, "[default]\nregion = x\n");
    rmSync(`${path}.lock`);
    await pending;
    assert.equal(read, "[default]\nregion = x\n", "the transform must see the text written under the other lock");
    assert.ok(!existsSync(`${path}.lock`));
  });

  it("a throwing transform leaves no tmp file and releases the lock", async () => {
    writeFileSync(path, "[default]\n");
    await assert.rejects(
      withLockedAtomicWrite(
        path,
        () => {
          throw new Error("boom");
        },
        { requirePrivate: false },
      ),
      /boom/,
    );
    assert.deepEqual(
      readdirSync(dir).filter((n) => n !== "config"),
      [],
      "no tmp and no lock may remain",
    );
    assert.equal(readFileSync(path, "utf-8"), "[default]\n");
  });

  it("requirePrivate:false writes through a mode-ignoring filesystem; requirePrivate:true refuses it", async () => {
    const ignoring = { platform: "linux" as NodeJS.Platform, probe: () => 0o777 };
    await withLockedAtomicWrite(path, append(PROD), { requirePrivate: false, privateModeOpts: ignoring });
    assert.match(readFileSync(path, "utf-8"), /prod-Admin/);
    // The same stub DOES trip the private path, so the pass above is not vacuous.
    await assert.rejects(
      withLockedAtomicWrite(path, () => "x", { requirePrivate: true, privateModeOpts: ignoring }),
      /does not honour file modes/,
    );
    assert.deepEqual(
      readdirSync(dir).filter((n) => n !== "config"),
      [],
    );
  });
});
