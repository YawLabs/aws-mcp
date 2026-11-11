/**
 * IAM Identity Center bootstrap, steps 2 and 3 (step 1 is aws_login_start with
 * `ssoSession`):
 *
 *   aws_sso_list_assignments   read-only: which accounts and roles this login
 *                              can use, and which already have a profile
 *   aws_sso_generate_profiles  writes `[profile ...]` sections for them
 *
 * Two tools rather than one with a `write` flag because MCP clients gate
 * approval on readOnlyHint: folding them together would either push a
 * read-only discovery through a write-class prompt or mislabel a writer.
 *
 * Authority stays with IAM Identity Center. Generated profiles are POINTERS
 * (session + account + role); they grant nothing until the CLI exchanges the
 * token, and IAM authorizes that exchange. Checking a selection against the
 * live assignments below catches typos and keeps the file honest -- it is not a
 * permission check.
 *
 * This is the one tools module allowed to import readSsoAccessToken (a static
 * guard test enforces it). The token goes into sso-discovery's private temp
 * file and nowhere else; nothing in a ToolResult built here is derived from it.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";
import { EMPTY_CONFIG_FILE_ERROR, resolveAwsConfigPath } from "../aws-paths.js";
import { type ManagedSectionSpec, planConfigUpserts, readSections, withLockedAtomicWrite } from "../ini-file.js";
import { findActiveSession } from "../sso.js";
import {
  DEFAULT_NAME_TEMPLATE,
  deriveProfileNames,
  isValidAccountId,
  isValidRoleName,
  nameTemplateProblem,
  profileNameProblem,
  regionProblem,
  renderProfileSpec,
  ssoSessionNameProblem,
} from "../sso-config.js";
import { type DiscoveredAccount, listAssignments } from "../sso-discovery.js";
import { readSsoAccessToken } from "../sso-token.js";
import { type AwsProfile, parseAwsConfig, parseSsoSessions } from "./profiles.js";
import type { Tool, ToolResult } from "./tool.js";

/** Generate's default (no selection) cap. Beyond it, the rest are reported as
 *  dropped rather than written: hundreds of profiles nobody chose is a config
 *  file nobody can read. */
const DEFAULT_GENERATE_CAP = 200;

function readConfigText(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

interface SessionInfo {
  ssoSession: string;
  startUrl: string;
  ssoRegion: string;
  configPath: string;
}

/** Resolve the sso-session block, or a ready-to-return failure. */
function resolveSession(ssoSession: string): { ok: true; s: SessionInfo } | { ok: false; r: ToolResult } {
  const nameErr = ssoSessionNameProblem(ssoSession);
  if (nameErr) return { ok: false, r: { ok: false, errorKind: "bad_input", error: nameErr } };
  const configPath = resolveAwsConfigPath();
  if (configPath === "") return { ok: false, r: { ok: false, errorKind: "bad_input", error: EMPTY_CONFIG_FILE_ERROR } };
  const block = parseSsoSessions(readConfigText(configPath)).find((b) => b.name === ssoSession);
  if (!block?.ssoStartUrl || !block.ssoRegion) {
    return {
      ok: false,
      r: {
        ok: false,
        errorKind: "bad_input",
        error: `No usable [sso-session ${ssoSession}] (with sso_start_url and sso_region) in ${configPath}. Call aws_login_start with ssoSession='${ssoSession}', startUrl and ssoRegion first.`,
      },
    };
  }
  return { ok: true, s: { ssoSession, startUrl: block.ssoStartUrl, ssoRegion: block.ssoRegion, configPath } };
}

/** Run discovery for a resolved session; the token never leaves this function
 *  except into listAssignments. */
async function discover(
  s: SessionInfo,
  accountIds: readonly string[] | undefined,
  includeRoles: boolean,
): Promise<{ ok: true; accounts: DiscoveredAccount[] } | { ok: false; r: ToolResult }> {
  const token = readSsoAccessToken({ ssoSession: s.ssoSession, startUrl: s.startUrl });
  if (!token) {
    return {
      ok: false,
      r: {
        ok: false,
        errorKind: "sso_expired",
        error: `No valid IAM Identity Center token for sso-session '${s.ssoSession}' (start URL ${s.startUrl}). Call aws_login_start with ssoSession='${s.ssoSession}' and complete the login, then retry.`,
      },
    };
  }
  const res = await listAssignments({
    ssoSession: s.ssoSession,
    startUrl: s.startUrl,
    ssoRegion: s.ssoRegion,
    accessToken: token.accessToken,
    accountIds,
    includeRoles,
  });
  if (!res.ok) return { ok: false, r: { ok: false, errorKind: res.errorKind, error: res.error } };
  return { ok: true, accounts: res.accounts };
}

/**
 * The existing profile (generated or hand-written) that already points at this
 * assignment, or null. "Points at" = same account and role, and either the same
 * sso_session or the same resolved start URL (an inline-style profile for the
 * same Identity Center instance counts). A managed match is preferred, so a
 * rerun keeps reporting the profile aws-mcp owns.
 */
function findConfigured(profiles: readonly AwsProfile[], s: SessionInfo, accountId: string, roleName: string) {
  const matches = profiles.filter(
    (p) =>
      p.ssoAccountId === accountId &&
      p.ssoRoleName === roleName &&
      (p.ssoSession === s.ssoSession || p.ssoStartUrl === s.startUrl),
  );
  return matches.find((p) => p.managed) ?? matches[0] ?? null;
}

function validateAccountIds(ids: readonly string[] | undefined): string | null {
  const bad = (ids ?? []).filter((id) => !isValidAccountId(id));
  return bad.length > 0 ? `Invalid accountIds ${JSON.stringify(bad)}: each must be a 12-digit account ID.` : null;
}

interface GenerateEntry {
  accountId: string;
  accountName: string;
  roleName: string;
  explicitName?: string;
}

interface PlannedItem {
  profile: string;
  accountId: string;
  roleName: string;
}

interface GeneratePlan {
  written: Array<PlannedItem & { action: "created" | "updated" }>;
  unchanged: PlannedItem[];
  skipped: Array<PlannedItem & { reason: string }>;
  text: string | null;
}

/**
 * Decide what happens to each entry against `text` and build the new text.
 * Pure: called once for dryRun, and again INSIDE the config lock for a real
 * write, so the plan that is written is computed from the file it replaces.
 */
function planGenerate(
  text: string,
  s: SessionInfo,
  entries: readonly GenerateEntry[],
  names: readonly string[],
  region: string,
): GeneratePlan {
  const plan: GeneratePlan = { written: [], unchanged: [], skipped: [], text: null };
  const sections = readSections(text);
  if (!sections.some((sec) => sec.name === `sso-session ${s.ssoSession}`)) {
    // Re-checked under the lock: profiles naming a block that does not exist
    // would each fail later with a confusing CLI error.
    throw new Error(
      `[sso-session ${s.ssoSession}] is no longer in ${s.configPath}. Call aws_login_start with ssoSession, startUrl and ssoRegion again.`,
    );
  }
  const profiles = parseAwsConfig(text);
  const specs: ManagedSectionSpec[] = [];
  const specItems: PlannedItem[] = [];
  const claimed = new Set<string>();
  entries.forEach((e, i) => {
    const name = names[i];
    const item = { profile: name, accountId: e.accountId, roleName: e.roleName };
    const existing = findConfigured(profiles, s, e.accountId, e.roleName);
    if (existing && !existing.managed) {
      plan.skipped.push({
        ...item,
        profile: existing.name,
        reason: `already configured as profile '${existing.name}'`,
      });
      return;
    }
    if (existing?.managed && existing.name !== name && e.explicitName === undefined) {
      // Same assignment already generated under another name (an account was
      // renamed, say): report it, do not write a duplicate.
      plan.unchanged.push({ ...item, profile: existing.name });
      return;
    }
    if (claimed.has(name)) {
      plan.skipped.push({ ...item, reason: "duplicate profile name in this batch" });
      return;
    }
    const section = sections.find((sec) => sec.name === `profile ${name}`);
    // An UNMANAGED section of this name needs no check here: planConfigUpserts
    // refuses it below (refused-unmanaged) and it is reported as skipped there.
    if (
      section?.managed &&
      (section.values.get("sso_account_id") !== e.accountId || section.values.get("sso_role_name") !== e.roleName)
    ) {
      // A managed profile of this name points at a DIFFERENT assignment.
      // Repointing it would silently send every later call to another account
      // -- the wrong-account blast radius the refuse policy exists to prevent.
      plan.skipped.push({
        ...item,
        reason: `profile is managed by aws-mcp but points at account ${section.values.get("sso_account_id") ?? "?"} role ${section.values.get("sso_role_name") ?? "?"}; pass a different profileName`,
      });
      return;
    }
    claimed.add(name);
    specs.push(
      renderProfileSpec({
        profileName: name,
        ssoSession: s.ssoSession,
        accountId: e.accountId,
        roleName: e.roleName,
        region,
      }),
    );
    specItems.push(item);
  });
  const out = planConfigUpserts(text, specs);
  out.outcomes.forEach((o, i) => {
    const item = specItems[i];
    if (o === "created" || o === "updated") plan.written.push({ ...item, action: o });
    else if (o === "unchanged") plan.unchanged.push(item);
    else plan.skipped.push({ ...item, reason: "profile exists and was not created by aws-mcp" });
  });
  plan.text = plan.written.length > 0 ? out.text : null;
  return plan;
}

export const ssoSetupTools: readonly Tool[] = [
  {
    name: "aws_sso_list_assignments",
    description:
      "List the AWS accounts and roles an IAM Identity Center login can use, after aws_login_start + aws_login_complete with ssoSession. Read-only. Each role shows `profile`: the existing config profile that already points at it (generated or hand-written), or null. Per-account failures come back as `rolesError` while the other accounts still list. If the token is missing or expired the error says to run aws_login_start with ssoSession again. Follow with aws_sso_generate_profiles to write profiles.",
    annotations: {
      title: "List IAM Identity Center accounts and roles",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      ssoSession: z.string().describe("sso-session name logged in via aws_login_start."),
      accountIds: z
        .array(z.string())
        .max(200)
        .optional()
        .describe("Only these 12-digit account IDs. Default: every assigned account."),
      includeRoles: z.boolean().optional().describe("Default true. false returns accounts only (one AWS call)."),
    }),
    handler: async (input: unknown): Promise<ToolResult> => {
      const i = input as { ssoSession: string; accountIds?: string[]; includeRoles?: boolean };
      const idErr = validateAccountIds(i.accountIds);
      if (idErr) return { ok: false, errorKind: "bad_input", error: idErr };
      const sess = resolveSession(i.ssoSession);
      if (!sess.ok) return sess.r;
      const s = sess.s;
      const includeRoles = i.includeRoles ?? true;
      const found = await discover(s, i.accountIds, includeRoles);
      if (!found.ok) return found.r;
      const profiles = parseAwsConfig(readConfigText(s.configPath));
      let roles = 0;
      let configured = 0;
      const accounts = found.accounts.map((a) => ({
        accountId: a.accountId,
        accountName: a.accountName,
        ...(includeRoles
          ? {
              roles: a.roles.map((r) => {
                roles++;
                const p = findConfigured(profiles, s, a.accountId, r.roleName);
                if (p) configured++;
                return p
                  ? { roleName: r.roleName, profile: p.name, managed: p.managed === true }
                  : { roleName: r.roleName, profile: null };
              }),
              rolesError: a.rolesError,
            }
          : {}),
      }));
      return {
        ok: true,
        data: {
          ssoSession: s.ssoSession,
          startUrl: s.startUrl,
          ssoRegion: s.ssoRegion,
          accounts,
          totals: { accounts: accounts.length, roles, configured },
        },
      };
    },
  },
  {
    name: "aws_sso_generate_profiles",
    description:
      "Write [profile ...] sections into the AWS config file for IAM Identity Center account/role assignments (after aws_login_start with ssoSession). Default: every assignment, capped at 200 (the rest are returned as `dropped`); or pass `selection`. Names default to '{accountName}-{roleName}', with the account ID inserted on a clash ('prod-111111111111-Admin'). Each section carries a `managed-by: aws-mcp` marker; a section without it is never modified -- a name clash with one is reported in `skipped`. `region` is written only when a profile is created. Use dryRun to preview. Selections are checked against the live assignments; IAM stays the authority.",
    annotations: {
      title: "Generate AWS profiles from Identity Center assignments",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      ssoSession: z.string().describe("sso-session name logged in via aws_login_start."),
      selection: z
        .array(
          z.object({
            accountId: z.string(),
            roleName: z.string(),
            profileName: z.string().optional(),
          }),
        )
        .max(500)
        .optional()
        .describe(
          "Which account/role pairs to write. Default: every assignment (capped at 200; pass a selection beyond that).",
        ),
      nameTemplate: z
        .string()
        .max(128)
        .optional()
        .describe(
          "Profile name template. Placeholders: {accountName} {accountId} {roleName} {ssoSession}. Default '{accountName}-{roleName}'.",
        ),
      region: z
        .string()
        .optional()
        .describe("Default region written into each new profile. Default: the sso-session's sso_region."),
      dryRun: z.boolean().optional().describe("Report what would be written without touching the file."),
    }),
    handler: async (input: unknown): Promise<ToolResult> => {
      const i = input as {
        ssoSession: string;
        selection?: Array<{ accountId: string; roleName: string; profileName?: string }>;
        nameTemplate?: string;
        region?: string;
        dryRun?: boolean;
      };
      const template = i.nameTemplate ?? DEFAULT_NAME_TEMPLATE;
      const tplErr = nameTemplateProblem(template);
      if (tplErr) return { ok: false, errorKind: "bad_input", error: tplErr };
      if (i.region !== undefined) {
        const rErr = regionProblem("region", i.region);
        if (rErr) return { ok: false, errorKind: "bad_input", error: rErr };
      }
      for (const sel of i.selection ?? []) {
        if (!isValidAccountId(sel.accountId)) {
          return {
            ok: false,
            errorKind: "bad_input",
            error: `Invalid selection accountId '${sel.accountId}': must be 12 digits.`,
          };
        }
        if (!isValidRoleName(sel.roleName)) {
          return { ok: false, errorKind: "bad_input", error: `Invalid selection roleName '${sel.roleName}'.` };
        }
        if (sel.profileName !== undefined) {
          const pErr = profileNameProblem(sel.profileName);
          if (pErr) return { ok: false, errorKind: "bad_input", error: pErr };
        }
      }
      const sess = resolveSession(i.ssoSession);
      if (!sess.ok) return sess.r;
      const s = sess.s;
      // `aws sso login` can rewrite sso_region in the block itself, outside our
      // lock. Refusing while one is in flight closes that race for logins this
      // server started; a user's own terminal is the documented residual.
      if (findActiveSession({ kind: "sso-session", name: s.ssoSession })) {
        return {
          ok: false,
          errorKind: "bad_input",
          error: `A login for sso-session '${s.ssoSession}' is in progress. Finish it with aws_login_complete (or let it expire) first.`,
        };
      }
      const region = i.region ?? s.ssoRegion;

      const selIds = i.selection ? [...new Set(i.selection.map((x) => x.accountId))] : undefined;
      const found = await discover(s, selIds, true);
      if (!found.ok) return found.r;

      const skipped: Array<PlannedItem & { reason: string }> = [];
      const assigned = new Map<string, DiscoveredAccount>(found.accounts.map((a) => [a.accountId, a]));
      let entries: GenerateEntry[] = [];
      if (i.selection) {
        for (const sel of i.selection) {
          const acct = assigned.get(sel.accountId);
          const base = { profile: sel.profileName ?? "", accountId: sel.accountId, roleName: sel.roleName };
          if (acct?.rolesError) {
            skipped.push({ ...base, reason: `could not list roles for this account: ${acct.rolesError}` });
          } else if (!acct?.roles.some((r) => r.roleName === sel.roleName)) {
            skipped.push({ ...base, reason: "not assigned to you" });
          } else {
            entries.push({
              accountId: sel.accountId,
              accountName: acct.accountName,
              roleName: sel.roleName,
              explicitName: sel.profileName,
            });
          }
        }
      } else {
        for (const a of found.accounts) {
          if (a.rolesError) {
            skipped.push({
              profile: "",
              accountId: a.accountId,
              roleName: "",
              reason: `could not list roles for this account: ${a.rolesError}`,
            });
            continue;
          }
          for (const r of a.roles)
            entries.push({ accountId: a.accountId, accountName: a.accountName, roleName: r.roleName });
        }
      }
      // API-sourced role names are untrusted text: one that IAM's own charset
      // would reject cannot be written safely into the INI file.
      entries = entries.filter((e) => {
        if (isValidRoleName(e.roleName)) return true;
        skipped.push({
          profile: "",
          accountId: e.accountId,
          roleName: e.roleName,
          reason: "role name not representable",
        });
        return false;
      });
      let dropped: Array<{ accountId: string; roleName: string }> = [];
      if (!i.selection && entries.length > DEFAULT_GENERATE_CAP) {
        dropped = entries.slice(DEFAULT_GENERATE_CAP).map((e) => ({ accountId: e.accountId, roleName: e.roleName }));
        entries = entries.slice(0, DEFAULT_GENERATE_CAP);
        console.warn(
          `[aws-mcp] aws_sso_generate_profiles: ${entries.length + dropped.length} assignments, writing the first ${DEFAULT_GENERATE_CAP}; pass a selection for the rest.`,
        );
      }

      // Names are derived for the whole batch at once so a clash group gets
      // its account-ID suffix on every member; an explicit profileName wins.
      const derived = deriveProfileNames(entries, template, s.ssoSession);
      const names = entries.map((e, idx) => e.explicitName ?? derived[idx]);

      let plan: GeneratePlan;
      try {
        if (i.dryRun) {
          plan = planGenerate(readConfigText(s.configPath), s, entries, names, region);
        } else {
          let inner: GeneratePlan | null = null;
          await withLockedAtomicWrite(
            s.configPath,
            (text) => {
              inner = planGenerate(text, s, entries, names, region);
              return inner.text;
            },
            { requirePrivate: false, ensureDir: true },
          );
          plan = inner as unknown as GeneratePlan;
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }

      // Managed profiles for this session whose assignment is gone (revoked, or
      // the account left the org). Reported, never deleted (no prune in v1):
      // removing a profile the user may still have scripts pointing at is
      // their call. Only computed against a FULL discovery -- with a selection
      // the other accounts were never listed -- and never for an account whose
      // role listing failed, which says nothing about its assignments.
      const stale = i.selection
        ? []
        : parseAwsConfig(readConfigText(s.configPath))
            .filter((p) => p.managed && p.ssoSession === s.ssoSession && p.ssoAccountId && p.ssoRoleName)
            .filter((p) => {
              const acct = assigned.get(p.ssoAccountId as string);
              if (acct?.rolesError) return false;
              return !acct?.roles.some((r) => r.roleName === p.ssoRoleName);
            })
            .map((p) => ({ profile: p.name, accountId: p.ssoAccountId as string, roleName: p.ssoRoleName as string }));

      const first = plan.written[0]?.profile ?? plan.unchanged[0]?.profile;
      return {
        ok: true,
        data: {
          configPath: s.configPath,
          dryRun: i.dryRun === true,
          written: plan.written,
          unchanged: plan.unchanged,
          skipped: [...skipped, ...plan.skipped],
          stale,
          ...(dropped.length > 0
            ? {
                dropped,
                droppedReason: `more than ${DEFAULT_GENERATE_CAP} assignments; pass a selection to write these`,
              }
            : {}),
          next: first
            ? `Use profile='${first}' with any tool, or aws_login_start {profile} to refresh later.`
            : "Nothing to use yet: see skipped for why each assignment was not written.",
        },
      };
    },
  },
];
