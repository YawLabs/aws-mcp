/**
 * SIGTERM-then-SIGKILL escalation for a child process. Extracted here so
 * aws-cli.ts and sso.ts share one implementation instead of two copies.
 *
 * SIGTERM is ignored on Windows (and some Unix daemons), so we escalate to
 * SIGKILL after a short grace window. The escalation timer is .unref()'d so
 * a still-pending kill can't keep the Node event loop alive past shutdown.
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
    if (!proc.killed && proc.exitCode === null) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // best effort
      }
    }
  }, escalationMs).unref();
}
