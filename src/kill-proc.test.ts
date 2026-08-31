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
// carrying the fields the escalation guard reads -- `exitCode` and
// `signalCode`, via procHasExited -- plus `killed` (which the guard
// deliberately does NOT consult) and a `kill` spy that records every signal it
// was sent. `killed` is modeled the way Node sets it: true as soon as a signal
// has been DISPATCHED, whether or not the child honored it. `onTerm` lets a
// test simulate "SIGTERM was delivered and the proc died" so we can assert
// SIGKILL is then skipped.
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
      // Model a proc that ignores SIGTERM (the stubborn-daemon case killProc
      // exists for): kill() records the signal and Node latches `killed`, but
      // the child never exits, so exitCode / signalCode stay null. No fixup of
      // `killed` here -- the guard is procHasExited, so the latched `killed`
      // must not suppress the escalation.
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
      // `killed` stays latched true, as Node leaves it -- exitCode is what the
      // guard trips on.
      proc.onTerm = () => {
        proc.exitCode = 0;
      };
      killProc(proc as unknown as ChildProcess);
      assert.deepEqual(proc.signals, ["SIGTERM"]);

      mock.timers.tick(KILL_ESCALATION_MS);
      // Escalation timer ran but procHasExited was true.
      assert.deepEqual(proc.signals, ["SIGTERM"]);
      assert.equal(proc.kill.mock.callCount(), 1);
    } finally {
      mock.timers.reset();
    }
  });

  it("does NOT send SIGKILL when the proc was reaped via signalCode alone", () => {
    // procHasExited reads BOTH fields. A child killed by a signal reports
    // signalCode with exitCode still null, so an exitCode-only guard would
    // escalate against an already-dead proc.
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const proc = makeFakeProc();
      proc.onTerm = () => {
        proc.signalCode = "SIGTERM";
      };
      killProc(proc as unknown as ChildProcess);

      mock.timers.tick(KILL_ESCALATION_MS);
      assert.deepEqual(proc.signals, ["SIGTERM"]);
      assert.equal(proc.kill.mock.callCount(), 1);
    } finally {
      mock.timers.reset();
    }
  });

  it("STILL escalates when proc.killed is true but the child never exited", () => {
    // Regression guard for the bug this replaced: the guard used to be
    // `!proc.killed && proc.exitCode === null`. Node sets `killed` when the
    // signal is DISPATCHED, so it is always true here and the SIGKILL branch
    // was unreachable on every platform -- the comment blamed Windows, but a
    // stubborn Unix daemon never got its SIGKILL either.
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const proc = makeFakeProc();
      killProc(proc as unknown as ChildProcess);
      assert.equal(proc.killed, true, "Node latches killed on dispatch, before the child dies");
      assert.equal(proc.exitCode, null, "the child ignored SIGTERM -- still alive");

      mock.timers.tick(KILL_ESCALATION_MS);
      assert.deepEqual(proc.signals, ["SIGTERM", "SIGKILL"]);
      assert.equal(proc.kill.mock.callCount(), 2);
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
      // exitCode / signalCode stay null, so procHasExited is false and SIGKILL
      // is still attempted despite the SIGTERM throw.
      assert.doesNotThrow(() => killProc(proc as unknown as ChildProcess));
      mock.timers.tick(KILL_ESCALATION_MS);
      assert.deepEqual(proc.signals, ["SIGTERM", "SIGKILL"]);
    } finally {
      mock.timers.reset();
    }
  });
});
