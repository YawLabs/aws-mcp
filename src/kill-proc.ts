/**
 * SIGTERM-then-SIGKILL escalation for a child process. Extracted here so
 * aws-cli.ts and sso.ts share one implementation instead of two copies.
 *
 * The SIGTERM->SIGKILL escalation matters on Unix, where a stubborn child
 * (a daemon, a process in uninterruptible sleep) can ignore SIGTERM and needs
 * the uncatchable SIGKILL to die. The escalation timer is .unref()'d so a
 * still-pending kill can't keep the Node event loop alive past shutdown.
 *
 * The escalation is guarded on procHasExited(), NOT on proc.killed. Node sets
 * proc.killed when a signal is DISPATCHED (the kill() call itself), not when
 * the child actually dies -- so `killed` is already true by the time the
 * escalation timer fires, on every platform, and a `!proc.killed` guard would
 * make the SIGKILL branch unreachable everywhere. exitCode / signalCode are
 * the fields that actually report the child gone.
 *
 * Windows still reaches the escalation less often in practice: Node maps every
 * kill() signal to TerminateProcess, so the SIGTERM above usually kills the
 * child outright and libuv has populated exitCode before the window elapses.
 * That is a timing observation, not a guarantee -- the guard is what makes it
 * safe, and a Windows child that has not been reaped yet still gets SIGKILL.
 */

import type { ChildProcess } from "node:child_process";

export const KILL_ESCALATION_MS = 2_000;

/**
 * True if Node has populated the child's exit/signal codes -- i.e. libuv has
 * processed the OS-level exit and the proc is dead from Node's point of view.
 *
 * Used as a guard against the race where a setTimeout (timeout in aws-cli.ts,
 * TTL killswitch in sso.ts) fires in the same event-loop iteration as a
 * queued 'exit' event: libuv sets proc.exitCode / proc.signalCode
 * synchronously BEFORE dispatching the 'exit' event, so a timer that runs
 * first in the timers phase can still detect that the proc is already gone
 * and defer to the queued exit handler instead of double-handling.
 */
export function procHasExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

export function killProc(proc: ChildProcess, escalationMs: number = KILL_ESCALATION_MS): void {
  try {
    proc.kill("SIGTERM");
  } catch {
    // proc may already be dead
  }
  setTimeout(() => {
    // Escalate only if the child is still alive after the grace window --
    // it ignored SIGTERM, or is wedged in uninterruptible sleep.
    //
    // procHasExited, NOT proc.killed: Node flips `killed` when the signal is
    // SENT (the kill() call above), so it is unconditionally true here and a
    // `!proc.killed` guard would kill this branch on every platform, not just
    // Windows. procHasExited reads exitCode / signalCode, which libuv only
    // populates once the child has actually been reaped.
    if (!procHasExited(proc)) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // best effort
      }
    }
  }, escalationMs).unref();
}
