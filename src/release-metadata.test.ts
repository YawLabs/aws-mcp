import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Resolve via import.meta.url so this works regardless of process.cwd(). The
// file lives one level below the repo root in both layouts -- src/ under vitest,
// dist/ for the compiled node:test run -- so the same hop reaches the root.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(repoRoot, rel), "utf-8")) as Record<string, unknown>;
}

describe("release metadata", () => {
  // server.json is what the Official MCP Registry reads at publish time. It
  // carries the version twice (top-level + packages[].version) and release.sh
  // bumps it separately from package.json. Without this, an edit that updates
  // one but not the other ships a desynced registry entry -- and the failure
  // only surfaces to users, never to the release.
  //
  // Ported from tailscale-mcp, which was the only server that had it. It earned
  // its keep immediately: it caught a version skew during the 0.15.0 release
  // that every other repo would have published silently.
  it("server.json top-level version matches package.json", () => {
    const pkg = readJson("package.json");
    const server = readJson("server.json");
    assert.equal(
      server.version,
      pkg.version,
      `server.json version (${String(server.version)}) must match package.json version (${String(pkg.version)})`,
    );
  });

  it("server.json packages[].version all match package.json", () => {
    const pkg = readJson("package.json");
    const server = readJson("server.json");
    const packages = server.packages as Array<{ version: string; identifier?: string }> | undefined;
    assert.ok(Array.isArray(packages) && packages.length > 0, "server.json must declare at least one package");
    for (const entry of packages ?? []) {
      assert.equal(
        entry.version,
        pkg.version,
        `server.json packages entry (${entry.identifier ?? "<unnamed>"}) version (${entry.version}) must match package.json version (${String(pkg.version)})`,
      );
    }
  });

  it("mcpName in package.json matches server.json name", () => {
    // A different drift mode: the registry keys the package by `name`, the npm
    // consumer reads `mcpName`. Disagreement puts discovery and install on
    // different identifiers.
    const pkg = readJson("package.json");
    const server = readJson("server.json");
    // Both must be present, or the equality below passes vacuously when a
    // refactor drops both fields.
    assert.ok(
      typeof pkg.mcpName === "string" && (pkg.mcpName as string).length > 0,
      "package.json must declare a non-empty `mcpName`",
    );
    assert.ok(
      typeof server.name === "string" && (server.name as string).length > 0,
      "server.json must declare a non-empty `name`",
    );
    assert.equal(pkg.mcpName, server.name, "package.json mcpName must equal server.json name");
  });

  it("server.json declares AWS_PROFILE and AWS_REGION as optional, undefaulted inputs, each documented in the README", () => {
    // Why they are declared at all: without them a Registry-driven install writes
    // a config with no env block, so the first tool call runs `--profile default`
    // and fails `no_creds`. An installer that reads this array can offer them.
    //
    // Why NEITHER carries a `default`: a pre-filled `default` profile recreates
    // exactly that failure on a machine where no `[default]` exists, and a
    // pre-filled region would outrank the user's own AWS_DEFAULT_REGION
    // (session.ts's getRegion prefers AWS_REGION). An installer that writes an
    // EMPTY string for a skipped optional variable is safe either way: getProfile
    // and getRegion use `||`, so "" is treated as unset.
    const server = readJson("server.json");
    const packages = server.packages as Array<{ environmentVariables?: Array<Record<string, unknown>> }> | undefined;
    const vars = packages?.[0]?.environmentVariables;
    assert.ok(Array.isArray(vars), "server.json packages[0] must declare environmentVariables");
    const names = (vars ?? []).map((v) => String(v.name));
    for (const required of ["AWS_PROFILE", "AWS_REGION"]) {
      assert.ok(names.includes(required), `server.json must declare ${required}; declares ${names.join(", ")}`);
    }
    // `includes`, not an exact set: a later deliberate addition should not have to
    // edit this test. What every entry must NOT do is carry a default or demand a
    // value.
    for (const v of vars ?? []) {
      assert.ok(
        !Object.hasOwn(v, "default"),
        `${String(v.name)} must not carry a default: a pre-filled profile recreates the no_creds failure and a pre-filled region outranks AWS_DEFAULT_REGION`,
      );
      assert.notEqual(v.isRequired, true, `${String(v.name)} must stay optional -- the server runs with neither set`);
    }
    // Anything the registry offers has to be explained where users read: the
    // Environment table. The `m` flag is required -- without it `^` anchors to the
    // whole file and this can never pass. README.md is LF (.gitattributes).
    const readme = readFileSync(resolve(repoRoot, "README.md"), "utf-8");
    for (const name of names) {
      assert.match(
        readme,
        new RegExp(`^\\| \`${name}\``, "m"),
        `README.md needs an Environment-table row for ${name}, which server.json tells installers to prompt for`,
      );
    }
  });
});
