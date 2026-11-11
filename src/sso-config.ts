/**
 * Validation and rendering for the IAM Identity Center bootstrap: the
 * `[sso-session]` block aws_login_start creates and the `[profile]` sections
 * aws_sso_generate_profiles writes.
 *
 * Everything that reaches argv or the config file passes through a validator
 * here first, whether it came from the caller or back from AWS (account names
 * and role names are admin-controlled, but still untrusted text). The INI-level
 * guard (iniValueProblem) is the floor under every one of them: it is what
 * keeps a value from opening a new line or a new `[section]` in the user's
 * config.
 */

import { iniValueProblem, type ManagedSectionSpec } from "./ini-file.js";
import { isValidProfileName, isValidRegionName } from "./session.js";

/**
 * The marker comment written as the first body line of every section aws-mcp
 * creates. Its presence is the ONLY thing that lets aws-mcp change a section
 * later, and the text tells a human reading the file how to take it back.
 * Part of the README's stability contract -- do not reword the `managed-by:
 * aws-mcp` prefix (MANAGED_MARKER_RE in ini-file.ts matches on it).
 */
export const MANAGED_MARKER =
  "# managed-by: aws-mcp -- delete this line to take ownership; aws-mcp will then never change this section";

/**
 * What a created sso-session block asks the device flow for. Matches what
 * `aws configure sso-session` writes. Without it the CLI registers an UNSCOPED
 * client, which yields a legacy token with no refresh token -- and whether the
 * sso:ListAccounts / ListAccountRoles APIs accept one was not something we
 * could verify, so we do not depend on it.
 */
export const SSO_REGISTRATION_SCOPES = "sso:account:access";

/** Role-name charset IAM itself enforces (1-64 of [\w+=,.@-]). */
export const ROLE_NAME_RE = /^[\w+=,.@-]{1,64}$/;
export const ACCOUNT_ID_RE = /^\d{12}$/;

/** Problem text for a profile or sso-session NAME, or null. */
function nameProblem(kind: "ssoSession" | "profileName", name: string): string | null {
  if (name === "default") {
    // `[default]` and `[profile default]` / `[sso-session default]` are three
    // different things to botocore and the same thing to most humans.
    return `Invalid ${kind} 'default': pick a specific name, 'default' is too easily confused with the [default] profile.`;
  }
  if (!isValidProfileName(name)) {
    return `Invalid ${kind} '${name}'. Must be 1-128 chars from [A-Za-z0-9_+=,.@:-]; the first char must be a letter, digit, or one of _+,.@: (not '-' or '='); no whitespace or brackets.`;
  }
  const ini = iniValueProblem(name);
  return ini ? `Invalid ${kind} '${name}': the value ${ini}.` : null;
}

export function ssoSessionNameProblem(name: string): string | null {
  return nameProblem("ssoSession", name);
}

export function profileNameProblem(name: string): string | null {
  return nameProblem("profileName", name);
}

/**
 * Validate and normalize an Identity Center start URL. Returns the URL to store
 * (fragment stripped; everything else EXACTLY as typed) or a problem.
 *
 * Not restricted to `*.awsapps.com`: Identity Center issuer URLs
 * (`https://identitycenter.amazonaws.com/ssoins-...`) and custom aliases are
 * both real. The path, trailing slash included, is kept as typed because the
 * CLI compares start URLs as exact strings and keys its token cache on them --
 * a "helpful" normalization here would make our block disagree with a token the
 * user's own terminal login wrote.
 */
export function normalizeStartUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const hash = raw.indexOf("#");
  const url = hash >= 0 ? raw.slice(0, hash) : raw;
  const bad = (why: string) => ({ ok: false as const, error: `Invalid startUrl '${raw}': ${why}.` });
  if (/\s/.test(url)) return bad("it contains whitespace");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return bad("it is not a URL");
  }
  if (parsed.protocol !== "https:") return bad("it must use https://");
  if (parsed.username || parsed.password) return bad("it must not carry a username or password");
  const ini = iniValueProblem(url);
  if (ini) return bad(`the value ${ini}`);
  return { ok: true, url };
}

export function regionProblem(field: string, region: string): string | null {
  return isValidRegionName(region)
    ? null
    : `Invalid ${field} '${region}'. Must match /^[a-z][a-z0-9-]{2,30}$/ (e.g. 'us-east-1').`;
}

export function isValidAccountId(v: string): boolean {
  return ACCOUNT_ID_RE.test(v);
}

export function isValidRoleName(v: string): boolean {
  return ROLE_NAME_RE.test(v);
}

/** A copy of `env` with the profile selectors removed. See the README / design:
 *  with AWS_PROFILE naming a profile that does not exist (common in a fresh
 *  per-user HOME that inherited the operator's environment), botocore resolves
 *  the scoped config first and fails with ProfileNotFound before a profile-free
 *  `--sso-session` login or `sso list-*` call ever runs. Neither needs a
 *  profile, so neither should be able to trip over one. */
export function envWithoutProfile(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out.AWS_PROFILE;
  delete out.AWS_DEFAULT_PROFILE;
  return out;
}

/** The managed `[sso-session <name>]` block. */
export function renderSessionSpec(name: string, startUrl: string, ssoRegion: string): ManagedSectionSpec {
  return {
    header: `sso-session ${name}`,
    marker: MANAGED_MARKER,
    keys: [
      ["sso_start_url", startUrl],
      ["sso_region", ssoRegion],
      ["sso_registration_scopes", SSO_REGISTRATION_SCOPES],
    ],
  };
}

/**
 * A managed `[profile <name>]` section. `region` is create-only (maintainer
 * decision): once the profile exists the user owns that value, and a later
 * generate run must not reset it.
 */
export function renderProfileSpec(p: {
  profileName: string;
  ssoSession: string;
  accountId: string;
  roleName: string;
  region: string;
}): ManagedSectionSpec {
  return {
    header: `profile ${p.profileName}`,
    marker: MANAGED_MARKER,
    keys: [
      ["sso_session", p.ssoSession],
      ["sso_account_id", p.accountId],
      ["sso_role_name", p.roleName],
    ],
    createOnlyKeys: [["region", p.region]],
  };
}

// ---------------------------------------------------------------------------
// Profile-name derivation
// ---------------------------------------------------------------------------

export const DEFAULT_NAME_TEMPLATE = "{accountName}-{roleName}";
const PLACEHOLDERS = ["accountName", "accountId", "roleName", "ssoSession"] as const;
const MAX_PROFILE_NAME = 128;

/** Problem with a caller's nameTemplate, or null. Only the four known
 *  placeholders may appear; any other brace is a typo we refuse rather than
 *  write literally into a profile name. */
export function nameTemplateProblem(template: string): string | null {
  const stripped = template.replace(/\{(accountName|accountId|roleName|ssoSession)\}/g, "");
  if (/[{}]/.test(stripped)) {
    return `Invalid nameTemplate '${template}': only {${PLACEHOLDERS.join("} {")}} may appear in braces.`;
  }
  if (!/\{(accountName|accountId|roleName)\}/.test(template)) {
    return `Invalid nameTemplate '${template}': it must contain at least one of {accountName} {accountId} {roleName}, or every profile would get the same name.`;
  }
  return null;
}

/**
 * Make an account NAME usable inside a profile name: every character outside
 * the profile charset becomes `-`, runs of `-` collapse, a leading `-`/`=` is
 * trimmed (the profile rule forbids it as the first character), and the result
 * is capped. Unicode names therefore come out as ASCII dashes -- the original
 * name is still reported in tool output, it is just never written to the INI.
 */
export function sanitizeAccountName(name: string): string {
  return name
    .replace(/[^A-Za-z0-9_+=,.@:-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-=]+/, "")
    .slice(0, MAX_PROFILE_NAME);
}

export interface NameInput {
  accountId: string;
  accountName: string;
  roleName: string;
}

function expand(template: string, e: NameInput, ssoSession: string): string {
  return template
    .replace(/\{accountName\}/g, sanitizeAccountName(e.accountName))
    .replace(/\{accountId\}/g, e.accountId)
    .replace(/\{roleName\}/g, e.roleName)
    .replace(/\{ssoSession\}/g, ssoSession)
    .slice(0, MAX_PROFILE_NAME);
}

/**
 * Derive a profile name for each entry.
 *
 * Collisions inside one batch -- two accounts both called "prod", say -- are
 * resolved by giving EVERY member of the colliding group the account ID right
 * after the account name (`prod-111111111111-Admin`). The whole group, not just
 * the second one, so the names do not depend on the order AWS lists accounts
 * in: a rerun after AWS reorders them must produce the same names, or it would
 * create duplicates. A template without {accountName} gets `-<accountId>`
 * appended instead.
 *
 * A name that is still invalid after sanitizing (an account name made entirely
 * of non-ASCII, say) falls back to `{accountId}-{roleName}`.
 */
export function deriveProfileNames(entries: readonly NameInput[], template: string, ssoSession: string): string[] {
  const fallback = (e: NameInput) => `${e.accountId}-${e.roleName}`;
  const valid = (n: string) => profileNameProblem(n) === null;
  const first = entries.map((e) => {
    const n = expand(template, e, ssoSession);
    return valid(n) ? n : fallback(e);
  });
  const counts = new Map<string, number>();
  for (const n of first) counts.set(n, (counts.get(n) ?? 0) + 1);
  const clashTemplate = template.includes("{accountName}")
    ? template.replace("{accountName}", "{accountName}-{accountId}")
    : `${template}-{accountId}`;
  return entries.map((e, i) => {
    if ((counts.get(first[i]) ?? 0) < 2) return first[i];
    const n = expand(clashTemplate, e, ssoSession);
    return valid(n) ? n : fallback(e);
  });
}
