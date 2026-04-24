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
