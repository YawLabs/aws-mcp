import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { describe, it } from "node:test";
import { _ttlKillswitchTick, CODE_RE, parseLoginOutput, URL_RE } from "./sso.js";

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
