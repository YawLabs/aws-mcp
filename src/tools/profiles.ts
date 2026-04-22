import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

type ToolResult = { ok: boolean; data?: unknown; error?: string };

export interface AwsProfile {
  name: string;
  ssoStartUrl?: string;
  ssoRegion?: string;
  ssoSession?: string;
  region?: string;
  isSso: boolean;
}

/**
 * Parse an `~/.aws/config`-style INI file into a list of profiles.
 *
 * AWS's config format has two section shapes:
 *   [default]            -- the unnamed default profile
 *   [profile foo]        -- all other profiles are prefixed with "profile "
 *   [sso-session bar]    -- named sso-session blocks (newer format). We note
 *                           these separately so a profile that references one
 *                           via sso_session=bar still reports isSso=true.
 *
 * Keys and values are separated by '=', with leading/trailing whitespace
 * trimmed. Lines starting with '#' or ';' are comments.
 */
export function parseAwsConfig(text: string): AwsProfile[] {
  const profiles: AwsProfile[] = [];
  let current: AwsProfile | null = null;
  let inSsoSessionBlock = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;

    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      if (current) profiles.push(current);
      const sectionName = sectionMatch[1].trim();
      if (sectionName.startsWith("sso-session ")) {
        inSsoSessionBlock = true;
        current = null;
        continue;
      }
      inSsoSessionBlock = false;
      const name = sectionName === "default" ? "default" : sectionName.replace(/^profile\s+/, "");
      current = { name, isSso: false };
      continue;
    }

    if (!current || inSsoSessionBlock) continue;

    const eqIdx = line.indexOf("=");
    if (eqIdx < 0) continue;
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();
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
  if (current) profiles.push(current);
  return profiles;
}

export const profilesTools = [
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
] as const;
