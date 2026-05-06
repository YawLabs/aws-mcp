/**
 * Session-sticky defaults for AWS profile and region.
 *
 * An MCP session often starts with the LLM unsure which profile/region to use,
 * the user says "switch to prod / us-west-2," and every subsequent tool call
 * should inherit that choice without having to pass it explicitly. Env vars
 * (AWS_PROFILE, AWS_REGION) are the fallback; a per-session override sits on
 * top, reset only when the process exits.
 *
 * IMPORTANT: these values are MODULE-GLOBAL state, intentionally so. The MCP
 * server is designed to host one stdio client per process -- if a future
 * transport ever multiplexes multiple clients into a single process (HTTP,
 * websockets), profile/region would bleed between them. Don't multiplex
 * without first refactoring this state into a per-request context.
 *
 * Tests serialize via `_resetSession()` in afterEach, which is why the
 * existing test parallelism doesn't trip the bleed.
 */

let sessionProfile: string | undefined;
let sessionRegion: string | undefined;

export function getProfile(): string {
  return sessionProfile ?? process.env.AWS_PROFILE ?? "default";
}

export function getRegion(): string {
  return sessionRegion ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
}

export function setProfile(name: string): void {
  if (!name?.trim()) {
    throw new Error("Profile name cannot be empty");
  }
  sessionProfile = name.trim();
}

export function setRegion(name: string): void {
  if (!name?.trim()) {
    throw new Error("Region cannot be empty");
  }
  sessionRegion = name.trim();
}

export function clearProfile(): void {
  sessionProfile = undefined;
}

export function clearRegion(): void {
  sessionRegion = undefined;
}

export type SessionSource = "session" | "env" | "default";

export interface SessionState {
  profile: string;
  region: string;
  profileSource: SessionSource;
  regionSource: SessionSource;
}

export function getSessionState(): SessionState {
  return {
    profile: getProfile(),
    region: getRegion(),
    profileSource: sessionProfile ? "session" : process.env.AWS_PROFILE ? "env" : "default",
    regionSource: sessionRegion
      ? "session"
      : process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION
        ? "env"
        : "default",
  };
}

/** For tests — reset both values so env-var fallback kicks in again. */
export function _resetSession(): void {
  sessionProfile = undefined;
  sessionRegion = undefined;
}
