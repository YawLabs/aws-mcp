import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { describe, it } from "node:test";
import { procHasExited } from "./kill-proc.js";

// Synthetic ChildProcess shape: we only need the two fields procHasExited
// reads. Casting via `unknown` avoids pulling in the full ChildProcess
// surface area for a predicate test.
function makeProc(exitCode: number | null, signalCode: NodeJS.Signals | null = null): ChildProcess {
  return { exitCode, signalCode } as unknown as ChildProcess;
}

describe("procHasExited", () => {
  it("returns false when both exitCode and signalCode are null (proc still running)", () => {
    assert.equal(procHasExited(makeProc(null, null)), false);
  });

  it("returns true when exitCode is 0 (normal exit, libuv reaped)", () => {
    // The race this guard is closing: libuv has set exitCode synchronously
    // BEFORE the 'exit' event dispatches. A timer (timeout in aws-cli.ts,
    // TTL killswitch in sso.ts) firing in this window must defer to the
    // queued exit handler instead of double-handling.
    assert.equal(procHasExited(makeProc(0, null)), true);
  });

  it("returns true when exitCode is non-zero (natural failure)", () => {
    // The misclassification we're preventing: without this guard, the TTL
    // handler would set ttlExpired=true, the queued exit handler would then
    // see code !== 0 and report "session expired" instead of the real
    // non-zero exit error.
    assert.equal(procHasExited(makeProc(1, null)), true);
    assert.equal(procHasExited(makeProc(255, null)), true);
  });

  it("returns true when signalCode is set (proc was killed)", () => {
    assert.equal(procHasExited(makeProc(null, "SIGTERM")), true);
    assert.equal(procHasExited(makeProc(null, "SIGKILL")), true);
  });

  it("returns true when both fields are set (e.g. killed-then-natural-exit ordering)", () => {
    assert.equal(procHasExited(makeProc(0, "SIGTERM")), true);
  });
});
