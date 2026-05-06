/**
 * Classify an unknown error from the AWS SDK or the aws CLI subprocess into
 * one of a small set of actionable kinds, so callers can surface the right
 * fix-it message (re-login / fix creds / show raw error).
 *
 * Both the SDK and the CLI get routed through here — the regexes cover both
 * sources. Patterns:
 *   - SDK throws Error subclasses named SSOTokenProviderFailure,
 *     ExpiredTokenException, CredentialsProviderError.
 *   - CLI prints stderr strings like "Error loading SSO Token: ...",
 *     "Unable to locate credentials", etc. We wrap CLI stderr in `new Error()`
 *     before calling classify, so it arrives as a plain Error.
 */

export type AuthErrorKind = "sso_expired" | "no_creds" | "other";

// All gaps are bounded with `[^\n]{0,N}` so the regex can't span unrelated
// log lines or run away on long stderr blobs that happen to mention both
// "sso/session/token" and "expired/invalid" far apart. The 80/40-char
// budgets are comfortably wider than every real CLI string seen in
// errors.test.ts; tighten further if a benign false-positive shows up.
const SSO_EXPIRED_RE =
  /SSOTokenProviderFailure|SSO[^\n]{0,80}session[^\n]{0,80}(?:expired|invalid)|token[^\n]{0,40}is\s+expired|no cached sso token|error loading sso token/i;
const NO_CREDS_RE = /CredentialsProviderError|could not load credentials|no identity|unable to locate credentials/i;

export function classifyAuthError(err: unknown): { kind: AuthErrorKind; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  const blob = `${name}: ${message}`;

  if (SSO_EXPIRED_RE.test(blob) || name === "ExpiredTokenException") {
    return { kind: "sso_expired", message };
  }
  if (NO_CREDS_RE.test(blob)) {
    return { kind: "no_creds", message };
  }
  return { kind: "other", message };
}
