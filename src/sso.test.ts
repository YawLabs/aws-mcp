import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { describe, it } from "node:test";
import {
  _buildLoginArgs,
  _ttlKillswitchTick,
  CODE_RE,
  DEVICE_CODE_MIN_CLI,
  PKCE_URL_RE,
  parseAwsCliVersion,
  parseLoginOutput,
  startSsoLogin,
  supportsDeviceCodeFlag,
  URL_RE,
} from "./sso.js";

describe("URL_RE", () => {
  it("matches standard AWS SSO device URLs across regions", () => {
    assert.match("https://device.sso.us-east-1.amazonaws.com/", URL_RE);
    assert.match("https://device.sso.us-west-2.amazonaws.com/", URL_RE);
    assert.match("https://device.sso.eu-west-1.amazonaws.com/", URL_RE);
    assert.match("https://device.sso.ap-southeast-2.amazonaws.com/", URL_RE);
  });

  it("matches URL embedded in surrounding text", () => {
    const line =
      "If the browser does not open, open the following URL:\n\nhttps://device.sso.us-east-1.amazonaws.com/\n\nThen enter the code:";
    assert.match(line, URL_RE);
  });

  it("matches URL with query string (pre-filled code)", () => {
    assert.match("https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH", URL_RE);
  });

  it("rejects non-AWS URLs", () => {
    assert.doesNotMatch("https://example.com/", URL_RE);
    assert.doesNotMatch("https://sso.amazonaws.com/", URL_RE);
    assert.doesNotMatch("http://device.sso.us-east-1.amazonaws.com/", URL_RE); // http, not https
  });
});

describe("CODE_RE", () => {
  it("matches well-formed 4-4 alphanumeric codes", () => {
    assert.match("ABCD-EFGH", CODE_RE);
    assert.match("WXYZ-1234", CODE_RE);
    assert.match("A1B2-C3D4", CODE_RE);
  });

  it("matches code embedded in surrounding text", () => {
    assert.match("Then enter the code:\n\nABCD-EFGH\n", CODE_RE);
  });

  it("rejects malformed codes", () => {
    assert.doesNotMatch("ABC-EFGH", CODE_RE); // 3 chars on left
    assert.doesNotMatch("ABCD-EFG", CODE_RE); // 3 chars on right
    assert.doesNotMatch("abcd-efgh", CODE_RE); // lowercase
    assert.doesNotMatch("ABCDEFGH", CODE_RE); // no hyphen
  });
});

describe("parseLoginOutput", () => {
  it("extracts both URL and code from full aws sso login output", () => {
    const sample = `Attempting to automatically open the SSO authorization page in your default browser.
If the browser does not open or you wish to use a different device to authorize this request, open the following URL:

https://device.sso.us-east-1.amazonaws.com/

Then enter the code:

ABCD-EFGH
`;
    const { url, code } = parseLoginOutput(sample);
    assert.equal(url, "https://device.sso.us-east-1.amazonaws.com/");
    assert.equal(code, "ABCD-EFGH");
  });

  it("returns null for both when no match", () => {
    const { url, code } = parseLoginOutput("Nothing of interest here");
    assert.equal(url, null);
    assert.equal(code, null);
  });

  it("returns partial result when only URL has appeared yet", () => {
    const partial = "...open the following URL:\n\nhttps://device.sso.us-east-1.amazonaws.com/\n";
    const { url, code } = parseLoginOutput(partial);
    assert.equal(url, "https://device.sso.us-east-1.amazonaws.com/");
    assert.equal(code, null);
  });
});

describe("_ttlKillswitchTick", () => {
  // Closes the caveat that the TTL killswitch's race-window guard was
  // "verified by inspection only." Driving the actual race in a real
  // subprocess (proc.exitCode set, 'exit' event queued, TTL setTimeout fires
  // first) would need timer mocks; this seam lets us pin every guard branch
  // with synthetic ChildProcess shapes instead.
  function makeProc(exitCode: number | null, signalCode: NodeJS.Signals | null = null): ChildProcess {
    return { exitCode, signalCode } as unknown as ChildProcess;
  }

  function makeSession(overrides: Partial<{ completed: boolean; ttlExpired: boolean }> = {}): {
    completed: boolean;
    ttlExpired: boolean;
  } {
    return { completed: false, ttlExpired: false, ...overrides };
  }

  it("bails when the session is undefined (deleted from the map)", () => {
    let killCount = 0;
    _ttlKillswitchTick(undefined, makeProc(null), () => {
      killCount++;
    });
    assert.equal(killCount, 0);
  });

  it("bails when the session is already marked completed (exit handler ran first)", () => {
    let killCount = 0;
    const s = makeSession({ completed: true });
    _ttlKillswitchTick(s, makeProc(null), () => {
      killCount++;
    });
    assert.equal(s.ttlExpired, false, "should not have set ttlExpired on a completed session");
    assert.equal(killCount, 0);
  });

  it("bails when proc.exitCode is 0 (microsecond race: clean exit queued, our timer fired first)", () => {
    // The race we are guarding against. Without this guard the handler
    // would set ttlExpired=true and the queued exit handler would still
    // run with code===0 -- the success path swallows ttlExpired so this
    // particular case wouldn't misclassify, but firing kill on a dead
    // proc is wasted work and leaves spurious state.
    let killCount = 0;
    const s = makeSession();
    _ttlKillswitchTick(s, makeProc(0), () => {
      killCount++;
    });
    assert.equal(s.ttlExpired, false);
    assert.equal(killCount, 0);
  });

  it("bails when proc.exitCode is non-zero (this is the misclassification we are preventing)", () => {
    // Without this guard: TTL handler would set ttlExpired=true. The queued
    // exit handler would then see (ttlExpired && code !== 0) and report
    // "SSO login session expired" instead of the natural "exited with
    // code N" error -- the user would think their session timed out when
    // it actually failed for a different reason. This test pins the fix.
    let killCount = 0;
    const s = makeSession();
    _ttlKillswitchTick(s, makeProc(1), () => {
      killCount++;
    });
    assert.equal(s.ttlExpired, false, "ttlExpired must stay false so the exit handler reports the natural error");
    assert.equal(killCount, 0);
  });

  it("bails when proc.signalCode is set (proc was killed by something else)", () => {
    let killCount = 0;
    const s = makeSession();
    _ttlKillswitchTick(s, makeProc(null, "SIGTERM"), () => {
      killCount++;
    });
    assert.equal(s.ttlExpired, false);
    assert.equal(killCount, 0);
  });

  it("fires when the proc is alive and the session is open", () => {
    let killArg: ChildProcess | null = null;
    const proc = makeProc(null, null);
    const s = makeSession();
    _ttlKillswitchTick(s, proc, (p) => {
      killArg = p;
    });
    assert.equal(s.ttlExpired, true, "ttlExpired must be set so the exit handler can phrase the result as expiry");
    assert.equal(killArg, proc, "killFn must be invoked with the proc reference");
  });

  it("sets ttlExpired BEFORE invoking killFn (exit handler reads ttlExpired)", () => {
    // Ordering matters: the kill triggers SIGTERM -> proc exits -> exit
    // handler runs. If killFn ran before ttlExpired was set, a fast exit
    // could observe ttlExpired=false and misreport. Verify by reading
    // ttlExpired from inside the kill callback.
    let observedTtlExpired: boolean | null = null;
    const s = makeSession();
    _ttlKillswitchTick(s, makeProc(null, null), () => {
      observedTtlExpired = s.ttlExpired;
    });
    assert.equal(observedTtlExpired, true, "ttlExpired must already be true when killFn fires");
  });
});

describe("startSsoLogin -- profile validation", () => {
  // No fake-aws fixture is needed: the validator bails before spawn. If
  // validation were absent these calls would invoke `aws sso login` for
  // real (or whatever the test env's `aws` binary does with the bad arg).
  it("rejects a profile that looks like a flag without spawning", async () => {
    const result = await startSsoLogin("--query=evil");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Invalid profile name/);
  });

  it("rejects a profile with INI-breaking characters", async () => {
    const result = await startSsoLogin("evil]hack");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Invalid profile name/);
  });
});

describe("PKCE_URL_RE", () => {
  it("matches the authorize URL the PKCE flow prints, across regions", () => {
    assert.match("https://oidc.us-east-1.amazonaws.com/authorize?response_type=code", PKCE_URL_RE);
    assert.match("https://oidc.eu-central-1.amazonaws.com/authorize?client_id=x", PKCE_URL_RE);
  });

  it("does not match the device-code URL", () => {
    assert.doesNotMatch("https://device.sso.us-east-1.amazonaws.com/", PKCE_URL_RE);
  });

  it("does not match a non-authorize oidc endpoint", () => {
    assert.doesNotMatch("https://oidc.us-east-1.amazonaws.com/token", PKCE_URL_RE);
  });

  it("is disjoint from URL_RE on both real banners", () => {
    const pkce = "open the following URL.\n\nhttps://oidc.us-east-1.amazonaws.com/authorize?a=b\n";
    const device = "open the following URL:\n\nhttps://device.sso.us-east-1.amazonaws.com/\n";
    assert.match(pkce, PKCE_URL_RE);
    assert.doesNotMatch(pkce, URL_RE);
    assert.match(device, URL_RE);
    assert.doesNotMatch(device, PKCE_URL_RE);
  });
});

describe("parseAwsCliVersion", () => {
  it("parses the real `aws --version` line", () => {
    assert.deepEqual(parseAwsCliVersion("aws-cli/2.34.3 Python/3.13.11 Windows/11 exe/AMD64"), {
      major: 2,
      minor: 34,
      patch: 3,
    });
  });

  it("parses a v1 line", () => {
    assert.deepEqual(parseAwsCliVersion("aws-cli/1.42.7 Python/3.11.2 Linux/6.1.0 botocore/1.35.0"), {
      major: 1,
      minor: 42,
      patch: 7,
    });
  });

  it("returns null when no version is present", () => {
    assert.equal(parseAwsCliVersion(""), null);
    assert.equal(parseAwsCliVersion("command not found: aws"), null);
    // A login banner, i.e. what a mis-wired probe would actually be handed.
    assert.equal(parseAwsCliVersion("https://device.sso.us-east-1.amazonaws.com/\nABCD-EFGH"), null);
  });
});

describe("supportsDeviceCodeFlag", () => {
  it("is true from 2.22.0 onward", () => {
    assert.equal(supportsDeviceCodeFlag({ major: 2, minor: 22, patch: 0 }), true);
    assert.equal(supportsDeviceCodeFlag({ major: 2, minor: 22, patch: 5 }), true);
    assert.equal(supportsDeviceCodeFlag({ major: 2, minor: 34, patch: 3 }), true);
    assert.equal(supportsDeviceCodeFlag({ major: 3, minor: 0, patch: 0 }), true);
  });

  it("is false below 2.22.0", () => {
    assert.equal(supportsDeviceCodeFlag({ major: 2, minor: 21, patch: 9 }), false);
    assert.equal(supportsDeviceCodeFlag({ major: 2, minor: 0, patch: 0 }), false);
    assert.equal(supportsDeviceCodeFlag({ major: 1, minor: 99, patch: 99 }), false);
  });

  it("defaults an unknown version to true (loud failure beats silent timeout)", () => {
    assert.equal(supportsDeviceCodeFlag(null), true);
  });

  it("agrees with the exported minimum", () => {
    assert.equal(supportsDeviceCodeFlag({ ...DEVICE_CODE_MIN_CLI }), true);
    assert.equal(supportsDeviceCodeFlag({ ...DEVICE_CODE_MIN_CLI, minor: DEVICE_CODE_MIN_CLI.minor - 1 }), false);
  });
});

describe("_buildLoginArgs", () => {
  it("passes --use-device-code when supported", () => {
    assert.deepEqual(_buildLoginArgs("prod", true), [
      "sso",
      "login",
      "--no-browser",
      "--use-device-code",
      "--profile",
      "prod",
    ]);
  });

  it("omits --use-device-code when unsupported", () => {
    assert.deepEqual(_buildLoginArgs("prod", false), ["sso", "login", "--no-browser", "--profile", "prod"]);
  });

  it("keeps --use-device-code ahead of --profile so the value can't be captured", () => {
    const args = _buildLoginArgs("prod", true);
    assert.ok(args.indexOf("--use-device-code") < args.indexOf("--profile"));
  });
});
