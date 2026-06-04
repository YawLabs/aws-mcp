import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, it, mock } from "node:test";
import { KILL_ESCALATION_MS, killProc, procHasExited } from "./kill-proc.js";

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

// Minimal child-process-like double for killProc: an EventEmitter (killProc
// itself doesn't emit, but the real ChildProcess is one and tests may want it)
// carrying the exact fields killProc's escalation guard reads -- `killed` and
// `exitCode` -- plus a `kill` spy that records every signal it was sent. The
// guard does NOT consult signalCode, so we don't model it flipping here; the
// real OS sets `killed` true on a successful kill() call, which is what the
// guard checks. `onTerm` lets a test simulate "SIGTERM was delivered and the
// proc died" so we can assert SIGKILL is then skipped.
class FakeProc extends EventEmitter {
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = mock.fn((signal?: NodeJS.Signals | number) => {
    this.signals.push(signal as NodeJS.Signals);
    // Node sets `killed` true once a signal has been dispatched to the proc,
    // regardless of whether the proc actually honors it.
    this.killed = true;
    if (signal === "SIGTERM") this.onTerm?.();
    return true;
  });
  signals: NodeJS.Signals[] = [];
  onTerm?: () => void;
}

function makeFakeProc(): FakeProc {
  return new FakeProc();
}

describe("killProc", () => {
  it("sends SIGTERM immediately", () => {
    const proc = makeFakeProc();
    killProc(proc as unknown as ChildProcess);
    assert.deepEqual(proc.signals, ["SIGTERM"]);
    assert.equal(proc.kill.mock.callCount(), 1);
  });

  it("escalates to SIGKILL when the proc is still alive after the window", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const proc = makeFakeProc();
      // Model a proc that ignores SIGTERM (the Windows / stubborn-daemon case
      // killProc exists for): kill() records the signal but the proc never
      // exits, so `killed` stays as kill() set it and exitCode stays null.
      // Reset `killed` to false after SIGTERM so the guard (`!killed`) passes;
      // this simulates a kill() impl that didn't latch killed, isolating the
      // exitCode===null branch that actually drives escalation.
      proc.onTerm = () => {
        proc.killed = false;
      };
      killProc(proc as unknown as ChildProcess);
      assert.deepEqual(proc.signals, ["SIGTERM"]);

      // Just before the window: no escalation yet.
      mock.timers.tick(KILL_ESCALATION_MS - 1);
      assert.deepEqual(proc.signals, ["SIGTERM"]);

      // Cross the escalation window: SIGKILL fires.
      mock.timers.tick(1);
      assert.deepEqual(proc.signals, ["SIGTERM", "SIGKILL"]);
      assert.equal(proc.kill.mock.callCount(), 2);
    } finally {
      mock.timers.reset();
    }
  });

  it("does NOT send SIGKILL when the proc already exited (exitCode set)", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const proc = makeFakeProc();
      // SIGTERM worked: the proc exited cleanly, so libuv populated exitCode.
      proc.onTerm = () => {
        proc.killed = false; // not the field the guard trips on here
        proc.exitCode = 0; // this is -- exitCode !== null short-circuits SIGKILL
      };
      killProc(proc as unknown as ChildProcess);
      assert.deepEqual(proc.signals, ["SIGTERM"]);

      mock.timers.tick(KILL_ESCALATION_MS);
      // Escalation timer ran but the `exitCode === null` guard was false.
      assert.deepEqual(proc.signals, ["SIGTERM"]);
      assert.equal(proc.kill.mock.callCount(), 1);
    } finally {
      mock.timers.reset();
    }
  });

  it("does NOT send SIGKILL when the proc reports killed after the window", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const proc = makeFakeProc();
      // The default FakeProc.kill leaves `killed` true after SIGTERM (the
      // normal case: the signal was delivered). The guard's `!proc.killed`
      // arm then short-circuits SIGKILL.
      killProc(proc as unknown as ChildProcess);
      assert.equal(proc.killed, true);

      mock.timers.tick(KILL_ESCALATION_MS);
      assert.deepEqual(proc.signals, ["SIGTERM"]);
      assert.equal(proc.kill.mock.callCount(), 1);
    } finally {
      mock.timers.reset();
    }
  });

  it("swallows a throwing SIGTERM and still arms the escalation timer", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const proc = makeFakeProc();
      let first = true;
      proc.kill = mock.fn((signal?: NodeJS.Signals | number) => {
        proc.signals.push(signal as NodeJS.Signals);
        if (first) {
          first = false;
          throw new Error("ESRCH"); // SIGTERM throws (proc vanished mid-call)
        }
        proc.killed = true;
        return true;
      });
      // exitCode stays null and killed stays false, so the post-window guard
      // passes and SIGKILL is attempted despite the SIGTERM throw.
      assert.doesNotThrow(() => killProc(proc as unknown as ChildProcess));
      mock.timers.tick(KILL_ESCALATION_MS);
      assert.deepEqual(proc.signals, ["SIGTERM", "SIGKILL"]);
    } finally {
      mock.timers.reset();
    }
  });
});
