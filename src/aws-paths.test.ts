import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expandVars, resolveAwsConfigPath, resolveAwsCredentialsPath } from "./aws-paths.js";

// A literal "${NAME}" is what these tests feed in; building it from `$` keeps
// the lint rule against accidental template placeholders meaningful elsewhere.
const braced = (name: string): string => `$\{${name}}`;

describe("expandVars (Python os.path.expandvars)", () => {
  const env = { HOME: "/home/u", CFG_DIR: "/etc/aws", USERPROFILE: "C:/Users/u" };

  it("expands $NAME and the braced form", () => {
    assert.equal(expandVars("$HOME/.aws/alt", env, false), "/home/u/.aws/alt");
    assert.equal(expandVars(`${braced("CFG_DIR")}/config`, env, false), "/etc/aws/config");
    assert.equal(expandVars("$CFG_DIR-x/$HOME", env, false), "/etc/aws-x//home/u");
  });

  it("leaves references to unset variables exactly as written", () => {
    assert.equal(expandVars("$NOPE/cfg", env, false), "$NOPE/cfg");
    assert.equal(expandVars(`${braced("NOPE")}/cfg`, env, false), `${braced("NOPE")}/cfg`);
    assert.equal(expandVars("a$/b", env, false), "a$/b");
  });

  it("expands %NAME% only on Windows", () => {
    assert.equal(expandVars("%USERPROFILE%/.aws/cfg", env, true), "C:/Users/u/.aws/cfg");
    assert.equal(expandVars("%USERPROFILE%/.aws/cfg", env, false), "%USERPROFILE%/.aws/cfg");
    assert.equal(expandVars("%NOPE%/cfg", env, true), "%NOPE%/cfg");
  });

  it("never re-expands a substituted value", () => {
    const tricky = { A: "%B%", B: "boom", C: "$B" };
    assert.equal(expandVars("$A", tricky, true), "%B%");
    assert.equal(expandVars("%C%", tricky, true), "$B");
  });
});

describe("resolveAwsConfigPath / resolveAwsCredentialsPath", () => {
  let cfgBackup: string | undefined;
  let credBackup: string | undefined;

  beforeEach(() => {
    cfgBackup = process.env.AWS_CONFIG_FILE;
    credBackup = process.env.AWS_SHARED_CREDENTIALS_FILE;
  });

  afterEach(() => {
    if (cfgBackup === undefined) delete process.env.AWS_CONFIG_FILE;
    else process.env.AWS_CONFIG_FILE = cfgBackup;
    if (credBackup === undefined) delete process.env.AWS_SHARED_CREDENTIALS_FILE;
    else process.env.AWS_SHARED_CREDENTIALS_FILE = credBackup;
  });

  it("falls back to ~/.aws/<file> only when the variable is unset", () => {
    delete process.env.AWS_CONFIG_FILE;
    delete process.env.AWS_SHARED_CREDENTIALS_FILE;
    assert.equal(resolveAwsConfigPath(), join(homedir(), ".aws", "config"));
    assert.equal(resolveAwsCredentialsPath(), join(homedir(), ".aws", "credentials"));
  });

  it("returns a set-but-empty value as empty (the CLI then loads no file)", () => {
    process.env.AWS_CONFIG_FILE = "";
    process.env.AWS_SHARED_CREDENTIALS_FILE = "";
    assert.equal(resolveAwsConfigPath(), "");
    assert.equal(resolveAwsCredentialsPath(), "");
  });

  it("does not trim the value", () => {
    process.env.AWS_CONFIG_FILE = " /x/cfg";
    assert.equal(resolveAwsConfigPath(), " /x/cfg");
  });

  it("expands variables before ~", () => {
    process.env.AWS_MCP_TEST_TILDE = "~";
    try {
      process.env.AWS_CONFIG_FILE = "$AWS_MCP_TEST_TILDE/cfg";
      assert.equal(resolveAwsConfigPath(), join(homedir(), "cfg"));
    } finally {
      delete process.env.AWS_MCP_TEST_TILDE;
    }
  });
});
