import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// scripts/update-manifests.mjs writes package.json's description (and the
// homepage, version, license and release URLs) into Ruby double-quoted strings
// in the Homebrew formula. These tests pin the escaping that keeps each value a
// plain string (CodeQL js/incomplete-sanitization).
//
// The subject lives in scripts/, which tsconfig does not include, so the test
// lives here. The file sits one level below the repo root in both src/ and
// dist/, so the same hop reaches it. Importing the script is safe: its release
// side effects run only when it is executed directly.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(repoRoot, "scripts", "update-manifests.mjs");

interface Arch {
  url: string;
  sha256: string;
}
interface FormulaInput {
  className: string;
  cmd: string;
  description: unknown;
  homepage: string;
  version: string;
  license: string | null;
  macArm64: Arch;
  macX64: Arch;
  linuxX64: Arch;
}

let rubyString: (value: unknown) => string;
let renderFormula: (input: FormulaInput) => string;

before(async () => {
  // A computed specifier keeps tsc from resolving the untyped .mjs.
  const mod = (await import(pathToFileURL(SCRIPT).href)) as {
    rubyString: typeof rubyString;
    renderFormula: typeof renderFormula;
  };
  rubyString = mod.rubyString;
  renderFormula = mod.renderFormula;
});

// Read the body of a Ruby double-quoted literal the way Ruby does, failing on
// anything that would end the string early or interpolate code.
function parseRubyDq(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") {
      const next = body[++i];
      if (next === undefined) throw new Error("dangling backslash escapes the closing quote");
      out += next === "n" ? "\n" : next === "r" ? "\r" : next;
    } else if (c === '"') {
      throw new Error(`unescaped quote at ${i} ends the string early`);
    } else if (c === "#" && /[{@$]/.test(body[i + 1] ?? "")) {
      throw new Error(`unescaped interpolation at ${i}`);
    } else if (c === "\n" || c === "\r") {
      throw new Error(`raw line break at ${i}`);
    } else {
      out += c;
    }
  }
  return out;
}

const HOSTILE = 'evil \\" #{system("touch /tmp/pwned")} #@x #$y\nnext line';

const arch = (n: string): Arch => ({
  url: `https://github.com/YawLabs/aws-mcp/releases/download/v2.5.1/aws-mcp-${n}`,
  sha256: "a".repeat(64),
});

function formulaFor(description: unknown): string {
  return renderFormula({
    className: "AwsMcp",
    cmd: "aws-mcp",
    description,
    homepage: "https://yaw.sh/mcp-servers/aws-mcp/",
    version: "2.5.1",
    license: "MIT",
    macArm64: arch("darwin-arm64"),
    macX64: arch("darwin-x64"),
    linuxX64: arch("linux-x64"),
  });
}

describe("update-manifests rubyString", () => {
  const cases = [
    "AWS MCP server: call any AWS API from AI assistants - SSO device-code re-login, Cloud Control API CRUD",
    'He said "hi"',
    "trailing backslash \\",
    'backslash then quote \\"',
    "C:\\path\\to\\thing",
    '#{system("rm -rf ~")}',
    "#@ivar and #$global",
    "C# support, issue #12, and a lone # at the end #",
    "line one\nline two\r\n",
    "",
  ];

  for (const input of cases) {
    it(`round-trips ${JSON.stringify(input)}`, () => {
      assert.equal(parseRubyDq(rubyString(input)), input);
    });
  }

  it("escapes the backslash before the quote", () => {
    // The old `.replace(/"/g, '\\"')` turned `\"` into `\\"`, which Ruby reads
    // as an escaped backslash followed by a closing quote.
    assert.equal(rubyString('a\\"b'), 'a\\\\\\"b');
  });

  it("escapes # only where it starts interpolation", () => {
    // `brew style` flags a redundant `\#`, so a plain `#` must stay as written.
    assert.equal(rubyString("C# and #1"), "C# and #1");
    assert.equal(rubyString("#{x} #@y #$z"), "\\#{x} \\#@y \\#$z");
  });

  it("treats null and undefined as empty", () => {
    assert.equal(rubyString(undefined), "");
    assert.equal(rubyString(null), "");
  });
});

describe("update-manifests renderFormula", () => {
  it("routes the description through rubyString", () => {
    const lines = formulaFor(HOSTILE).split("\n");
    const desc = lines.find((l) => l.startsWith("  desc "));
    assert.ok(desc, "formula has a desc line");
    assert.equal(desc, `  desc "${rubyString(HOSTILE)}"`);
    const m = /^ {2}desc "(.*)"$/.exec(desc);
    assert.ok(m, "desc is a single double-quoted literal on one line");
    assert.equal(parseRubyDq(m[1]), HOSTILE);
    // The newline in the description must not add a line to the formula.
    assert.equal(lines.length, formulaFor("plain").split("\n").length);
  });

  it("keeps every string literal in the formula a plain string", () => {
    // Each `"..."` stanza value parses cleanly, except the test block's
    // deliberate `#{bin}` interpolation.
    const formula = formulaFor(HOSTILE).replace('"#{bin}/', '"BIN/');
    for (const m of formula.matchAll(/^\s*(?:desc|homepage|version|license|url|sha256) "((?:[^"\\]|\\.)*)"/gm)) {
      assert.doesNotThrow(() => parseRubyDq(m[1]), m[0]);
    }
  });

  it("renders a proprietary license as :cannot_represent", () => {
    const formula = renderFormula({
      className: "AwsMcp",
      cmd: "aws-mcp",
      description: "x",
      homepage: "https://example.com",
      version: "1.0.0",
      license: null,
      macArm64: arch("darwin-arm64"),
      macX64: arch("darwin-x64"),
      linuxX64: arch("linux-x64"),
    });
    assert.match(formula, /^ {2}license :cannot_represent$/m);
  });
});
