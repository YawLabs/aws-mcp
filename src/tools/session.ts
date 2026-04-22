import { z } from "zod";
import { clearProfile, clearRegion, getSessionState, setProfile, setRegion } from "../session.js";

type ToolResult = { ok: boolean; data?: unknown; error?: string };

export const sessionTools = [
  {
    name: "aws_session_set",
    description:
      "Set the default AWS profile and/or region for the rest of this MCP session. Subsequent calls to aws_whoami, aws_login_*, and other AWS tools will use these values unless they override explicitly. Use when the user says 'switch to prod', 'use us-west-2', 'look at the staging account', etc. Both params are optional; pass whichever changed. Returns the resulting session state.",
    annotations: {
      title: "Set session default profile/region",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({
      profile: z.string().optional().describe("AWS profile name to use as default. Omit to leave unchanged."),
      region: z
        .string()
        .optional()
        .describe("AWS region to use as default (e.g. 'us-west-2'). Omit to leave unchanged."),
    }),
    handler: async (input: unknown): Promise<ToolResult> => {
      const { profile, region } = input as { profile?: string; region?: string };
      if (profile === undefined && region === undefined) {
        return {
          ok: false,
          error:
            "Nothing to set — pass at least one of 'profile' or 'region'. Use aws_session_get to read current values.",
        };
      }
      try {
        if (profile !== undefined) setProfile(profile);
        if (region !== undefined) setRegion(region);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      return { ok: true, data: getSessionState() };
    },
  },
  {
    name: "aws_session_get",
    description:
      "Show the current session's default AWS profile and region, and where each value came from ('session' = set by aws_session_set, 'env' = AWS_PROFILE/AWS_REGION env var, 'default' = built-in fallback). Useful for confirming state before running operations or debugging why a call hit the wrong account.",
    annotations: {
      title: "Show session default profile/region",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({}),
    handler: async (_input: unknown): Promise<ToolResult> => {
      return { ok: true, data: getSessionState() };
    },
  },
  {
    name: "aws_session_clear",
    description:
      "Remove session-set profile and/or region overrides so subsequent calls fall back to env vars / defaults. No args clears both. Pass `profile: true` or `region: true` to clear just one. Use when the user says 'go back to the default profile,' 'unset the region,' or 'reset session.'",
    annotations: {
      title: "Clear session profile/region overrides",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({
      profile: z.boolean().optional().describe("If true, clear the session profile override. Default false."),
      region: z.boolean().optional().describe("If true, clear the session region override. Default false."),
    }),
    handler: async (input: unknown): Promise<ToolResult> => {
      const { profile, region } = input as { profile?: boolean; region?: boolean };
      // No flags = clear both. Explicit flags = clear selectively.
      const clearBoth = profile === undefined && region === undefined;
      if (clearBoth || profile === true) clearProfile();
      if (clearBoth || region === true) clearRegion();
      return { ok: true, data: getSessionState() };
    },
  },
] as const;
