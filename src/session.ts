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

// Argv-safety validators for the two values that flow into `aws --profile X
// --region Y`. Without these, an AWS_PROFILE env var of `--query=...` (or a
// caller passing the same as opts.profile) would slot in as a flag to the
// aws CLI. Mirrors the leading-hyphen + control-char defense applied to
// typeName / identifier / opaque tokens in tools/resource.ts and to region
// IDs in tools/multi-region.ts. Centralized here so every consumer
// (runAwsCall, startSsoLogin, aws_assume_role) shares one definition.
//
// The profile char set matches what aws_assume_role's sessionName schema
// accepts ([\w+=,.@-]) plus `:` for SSO profile names like
// 'org-name:account:role'. First char rules out leading `-` so the value
// can't pose as a CLI flag, and rules out the few INI-special chars
// (`[`, `]`, `=`, whitespace, newlines) so a malformed name can't break
// `~/.aws/credentials` parsing when assume.ts writes a section header.
// Length capped at 128 to match AWS's profile name limit.
export const PROFILE_NAME_RE = /^[A-Za-z0-9_+,.@:][A-Za-z0-9_+=,.@:-]{0,127}$/;

// AWS region IDs: lowercase letters, digits, hyphens, must start with a
// letter, must contain at least one hyphen-separated segment. Matches
// us-east-1, eu-west-3, ap-northeast-1, us-gov-east-1, cn-north-1,
// me-central-1. Mirrors REGION_RE in tools/multi-region.ts.
export const REGION_NAME_RE = /^[a-z][a-z0-9-]{2,30}$/;

export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_RE.test(name);
}

export function isValidRegionName(name: string): boolean {
  return REGION_NAME_RE.test(name);
}

/**
 * Single source for the "that profile name is not usable" text. Three call
 * sites need it -- setProfile below, the pre-mutation validation in
 * tools/session.ts, and runAwsCall's post-resolution check in aws-cli.ts --
 * and they carried three hand-maintained near-copies that had already drifted
 * apart. `tail` is the call-site-specific hint appended after the shared rule
 * statement; omit it for the bare form.
 */
export function invalidProfileMessage(name: string, tail?: string): string {
  const base = `Invalid profile name '${name}'. Must be 1-128 chars from [A-Za-z0-9_+=,.@:-]; the first char must be a letter, digit, or one of _+,.@: (not '-' or '='); no whitespace or shell metacharacters.`;
  return tail ? `${base} ${tail}` : base;
}

/** Region counterpart to {@link invalidProfileMessage}. */
export function invalidRegionMessage(name: string, tail?: string): string {
  const base = `Invalid region '${name}'. Must match /^[a-z][a-z0-9-]{2,30}$/ (e.g. 'us-east-1', 'eu-west-3').`;
  return tail ? `${base} ${tail}` : base;
}

// `||`, not `??`, on every env link below. An env var set to the EMPTY STRING
// is routine in CI (`AWS_PROFILE: ${{ inputs.profile }}` with nothing passed,
// a `.env` line with no value, `export AWS_REGION=` in a wrapper script), and
// `??` treats "" as PRESENT -- so the chain would stop dead on it and hand
// `aws --profile ''` to the CLI instead of falling through to the next link.
// Empty means absent here.
//
// AWS_DEFAULT_PROFILE is the legacy spelling of AWS_PROFILE; botocore honors
// both, so a config that only sets the old name still resolves. AWS_PROFILE
// wins when both are set, mirroring the AWS_REGION / AWS_DEFAULT_REGION
// precedence already used below.
export function getProfile(): string {
  return sessionProfile || process.env.AWS_PROFILE || process.env.AWS_DEFAULT_PROFILE || "default";
}

export function getRegion(): string {
  return sessionRegion || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
}

export function setProfile(name: string): void {
  if (!name?.trim()) {
    throw new Error("Profile name cannot be empty");
  }
  const trimmed = name.trim();
  if (!isValidProfileName(trimmed)) {
    throw new Error(invalidProfileMessage(trimmed));
  }
  sessionProfile = trimmed;
}

export function setRegion(name: string): void {
  if (!name?.trim()) {
    throw new Error("Region cannot be empty");
  }
  const trimmed = name.trim();
  if (!isValidRegionName(trimmed)) {
    throw new Error(invalidRegionMessage(trimmed));
  }
  sessionRegion = trimmed;
}

export function clearProfile(): void {
  sessionProfile = undefined;
}

export function clearRegion(): void {
  sessionRegion = undefined;
}

// Neither type is exported: getSessionState's return value is consumed
// structurally (tools/session.ts hands it straight to the MCP envelope), and
// no .d.ts ships, so there is no caller that needs to name them.
type SessionSource = "session" | "env" | "default";

interface SessionState {
  profile: string;
  region: string;
  profileSource: SessionSource;
  regionSource: SessionSource;
}

export function getSessionState(): SessionState {
  return {
    profile: getProfile(),
    region: getRegion(),
    // Truthiness, matching the `||` chains in getProfile / getRegion exactly:
    // an empty-string env var is skipped by the getter, so labelling it "env"
    // here would report a source the returned VALUE didn't actually come from
    // (the pre-fix pairing was region:"" with regionSource:"default").
    profileSource: sessionProfile
      ? "session"
      : process.env.AWS_PROFILE || process.env.AWS_DEFAULT_PROFILE
        ? "env"
        : "default",
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
