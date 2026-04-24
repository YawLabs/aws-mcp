import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Tool, ToolResult } from "./tool.js";

export interface AwsProfile {
  name: string;
  ssoStartUrl?: string;
  ssoRegion?: string;
  ssoSession?: string;
  region?: string;
  isSso: boolean;
}

interface SsoSession {
  ssoStartUrl?: string;
  ssoRegion?: string;
}

/**
 * Parse an `~/.aws/config`-style INI file into a list of profiles.
 *
 * AWS's config format has two section shapes:
 *   [default]            -- the unnamed default profile
 *   [profile foo]        -- all other profiles are prefixed with "profile "
 *   [sso-session bar]    -- named sso-session blocks (newer format). A profile
 *                           with `sso_session = bar` inherits the start URL +
 *                           region from the matching block; we resolve that
 *                           indirection here so callers never have to.
 *
 * Keys and values are separated by '=', with leading/trailing whitespace
 * trimmed. Lines starting with '#' or ';' are comments.
 */
export function parseAwsConfig(text: string): AwsProfile[] {
  const profiles: AwsProfile[] = [];
  const ssoSessions = new Map<string, SsoSession>();
  let current: AwsProfile | null = null;
  let currentSsoSession: { name: string; data: SsoSession } | null = null;

  const finishSection = (): void => {
    if (current) {
      profiles.push(current);
      current = null;
    }
    if (currentSsoSession) {
      ssoSessions.set(currentSsoSession.name, currentSsoSession.data);
      currentSsoSession = null;
    }
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;

    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      finishSection();
      const sectionName = sectionMatch[1].trim();
      if (sectionName.startsWith("sso-session ")) {
        const ssoName = sectionName.slice("sso-session ".length).trim();
        currentSsoSession = { name: ssoName, data: {} };
        continue;
      }
      const name = sectionName === "default" ? "default" : sectionName.replace(/^profile\s+/, "");
      current = { name, isSso: false };
      continue;
    }

    const eqIdx = line.indexOf("=");
    if (eqIdx < 0) continue;
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();

    if (currentSsoSession) {
      if (key === "sso_start_url") currentSsoSession.data.ssoStartUrl = value;
      else if (key === "sso_region") currentSsoSession.data.ssoRegion = value;
      continue;
    }

    if (!current) continue;

    switch (key) {
      case "sso_start_url":
        current.ssoStartUrl = value;
        current.isSso = true;
        break;
      case "sso_region":
        current.ssoRegion = value;
        current.isSso = true;
        break;
      case "sso_session":
        current.ssoSession = value;
        current.isSso = true;
        break;
      case "region":
        current.region = value;
        break;
    }
  }
  finishSection();

  // Resolve sso_session references: a profile with `sso_session = my-org`
  // inherits ssoStartUrl + ssoRegion from `[sso-session my-org]`, unless the
  // profile already set them inline (explicit wins).
  for (const p of profiles) {
    if (!p.ssoSession) continue;
    const ref = ssoSessions.get(p.ssoSession);
    if (!ref) continue;
    if (!p.ssoStartUrl && ref.ssoStartUrl) p.ssoStartUrl = ref.ssoStartUrl;
    if (!p.ssoRegion && ref.ssoRegion) p.ssoRegion = ref.ssoRegion;
  }

  return profiles;
}

/**
 * Look up a profile's resolved SSO start URL from `~/.aws/config` text.
 * Returns null if the profile isn't SSO, isn't present, or the config file
 * can't be parsed. Used to filter the shared SSO token cache by the startUrl
 * belonging to the profile the caller asked about.
 */
export function resolveProfileStartUrl(configText: string, profileName: string): string | null {
  const profiles = parseAwsConfig(configText);
  const match = profiles.find((p) => p.name === profileName);
  return match?.ssoStartUrl ?? null;
}

export const profilesTools: readonly Tool[] = [
  {
    name: "aws_list_profiles",
    description:
      "List AWS profiles configured in ~/.aws/config. Returns profile name, region, and SSO metadata (start URL, region, session name) where set, plus an `isSso` flag. Use when the user hasn't named a profile, when they ask to switch profiles, or when an SSO-expired error mentions a profile you haven't seen.",
    annotations: {
      title: "List configured AWS profiles",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({}),
    handler: async (_input: unknown): Promise<ToolResult> => {
      const configPath = join(homedir(), ".aws", "config");
      try {
        const text = readFileSync(configPath, "utf-8");
        const profiles = parseAwsConfig(text);
        return { ok: true, data: { configPath, profiles } };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("ENOENT")) {
          return {
            ok: false,
            error: `${configPath} not found. Run 'aws configure sso' to set up a profile, or create the file manually.`,
          };
        }
        return { ok: false, error: `Failed to read ${configPath}: ${msg}` };
      }
    },
  },
];
