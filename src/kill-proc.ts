/**
 * SIGTERM-then-SIGKILL escalation for a child process. Extracted here so
 * aws-cli.ts and sso.ts share one implementation instead of two copies.
 *
 * The SIGTERM->SIGKILL escalation matters on Unix, where a stubborn child
 * (a daemon, a process in uninterruptible sleep) can ignore SIGTERM and needs
 * the uncatchable SIGKILL to die. The escalation timer is .unref()'d so a
 * still-pending kill can't keep the Node event loop alive past shutdown.
 *
 * On Windows the escalation branch is effectively dead: Node maps every
 * kill() signal to TerminateProcess, which terminates the child immediately
 * and unconditionally, so the SIGTERM call already killed it and the
 * post-window SIGKILL never has a live proc to act on.
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
    // Unix escalation path. On Windows this is effectively unreachable: the
    // SIGTERM above maps to TerminateProcess and kills the child immediately,
    // so by the time this fires proc.killed is true (or exitCode is set) and
    // the guard short-circuits. SIGKILL only does real work for a Unix child
    // that ignored SIGTERM and is still alive after the grace window.
    if (!proc.killed && proc.exitCode === null) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // best effort
      }
    }
  }, escalationMs).unref();
}
