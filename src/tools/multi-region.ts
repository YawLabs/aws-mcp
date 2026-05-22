import { z } from "zod";
import { runAwsCall } from "../aws-cli.js";
import type { Tool, ToolResult } from "./tool.js";

/**
 * aws_multi_region runs the same AWS operation across N regions in parallel.
 * Common ops pain point: "is X running in any of our regions?", "what does
 * the IAM password policy look like across the fleet?", "describe-instances
 * everywhere and count by state."
 *
 * AWS's official MCP server is single-region-per-call; this saves the agent
 * from emitting one tool call per region and then aggregating itself.
 *
 * Returns an array of per-region results: each has `region`, `ok`, and
 * either `data` or `error`. Partial failure is expected and surfaced --
 * authorization may be region-scoped, services may not be available in every
 * region, transient errors happen. The caller decides what to do with the
 * mix.
 */

const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 32;
const MAX_REGIONS = 32;

// AWS region IDs are e.g. us-east-1, eu-west-3, ap-northeast-1, us-gov-east-1,
// cn-north-1, me-central-1. The pattern is <area>-<direction>-<digit>(-<digit>).
// We enforce a conservative regex: lowercase letters, digits, hyphens, must
// contain at least one hyphen, must not start with a hyphen. Length-capped.
// This is also argv-injection defense: a region of "--profile evil" must not
// pose as a CLI flag when we append it to the aws CLI argv.
const REGION_RE = /^[a-z][a-z0-9-]{2,30}$/;

export interface RegionResult {
  region: string;
  ok: boolean;
  data?: unknown;
  command?: string;
  error?: string;
  errorKind?: string;
}

/**
 * Run a bounded set of async tasks in parallel. Plain Promise.all with a
 * window pointer -- no external dep. Each task gets a slot; when one
 * finishes, the next pending task starts. Order of `results` matches the
 * order of `inputs`.
 */
export async function runWithConcurrency<I, R>(
  inputs: readonly I[],
  concurrency: number,
  fn: (input: I, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(inputs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= inputs.length) return;
      results[i] = await fn(inputs[i], i);
    }
  };
  const workerCount = Math.min(concurrency, inputs.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export const multiRegionTools: readonly Tool[] = [
  {
    name: "aws_multi_region",
    description:
      "Run the same AWS API operation across multiple regions in parallel. Same shape as aws_call (service, operation, params?, query?, outputFormat?, timeoutMs?) but takes `regions: string[]` instead of `region`. Returns an array of `{region, ok, data?, command?, error?, errorKind?}` -- partial failure is expected (services aren't everywhere, perms may be region-scoped). Duplicate regions in the input are collapsed (first occurrence wins), so `results.length` may be less than `regions.length`; use the returned `regionCount` for the actual count run. Use for fleet-wide reads: 'describe-instances across all our regions', 'list buckets in every region', 'check IAM password policy everywhere'.",
    annotations: {
      title: "Run an AWS operation across multiple regions in parallel",
      // The operation can be anything -- we conservatively annotate as not
      // read-only / not destructive. The caller chooses what to invoke.
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      service: z.string().describe("AWS service in kebab-case: 's3api', 'ec2', 'iam', etc."),
      operation: z.string().describe("Operation in kebab-case: 'describe-instances', 'list-buckets', etc."),
      regions: z
        .array(z.string().min(1))
        .min(1)
        .max(MAX_REGIONS)
        .describe(
          `Region IDs (e.g. ['us-east-1','us-west-2','eu-west-1']). 1-${MAX_REGIONS}. Validated for argv-safety; bad region names fail per-region rather than poisoning the batch.`,
        ),
      params: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Operation parameters (PascalCase keys) -- same shape as aws_call."),
      query: z.string().optional().describe("JMESPath expression for --query (server-side trimming per region)."),
      outputFormat: z.enum(["json", "text", "table", "yaml"]).optional().describe("Output format. Default 'json'."),
      profile: z.string().optional().describe("Override session profile for the batch."),
      timeoutMs: z.number().int().positive().optional().describe("Timeout in ms applied PER region. Default 60000."),
      concurrency: z
        .number()
        .int()
        .positive()
        .max(MAX_CONCURRENCY)
        .optional()
        .describe(`Max regions in flight at once (1-${MAX_CONCURRENCY}). Default ${DEFAULT_CONCURRENCY}.`),
    }),
    handler: async (input: unknown): Promise<ToolResult> => {
      const i = input as {
        service: string;
        operation: string;
        regions: string[];
        params?: Record<string, unknown>;
        query?: string;
        outputFormat?: "json" | "text" | "table" | "yaml";
        profile?: string;
        timeoutMs?: number;
        concurrency?: number;
      };

      // De-dupe regions: a model may accidentally pass us-east-1 twice. We
      // dedupe preserving first occurrence so the result order is the
      // dedup'd input order.
      const seen = new Set<string>();
      const regions: string[] = [];
      for (const r of i.regions) {
        if (!seen.has(r)) {
          seen.add(r);
          regions.push(r);
        }
      }

      const concurrency = i.concurrency ?? DEFAULT_CONCURRENCY;

      const results = await runWithConcurrency(regions, concurrency, async (region): Promise<RegionResult> => {
        if (!REGION_RE.test(region)) {
          return {
            region,
            ok: false,
            error: `Invalid region '${region}'. Must match /^[a-z][a-z0-9-]{2,30}$/.`,
            errorKind: "bad_input",
          };
        }
        const r = await runAwsCall({
          service: i.service,
          operation: i.operation,
          params: i.params,
          query: i.query,
          profile: i.profile,
          region,
          outputFormat: i.outputFormat,
          timeoutMs: i.timeoutMs,
        });
        if (!r.ok) {
          return {
            region,
            ok: false,
            command: r.command,
            error: r.error,
            errorKind: r.kind,
          };
        }
        return { region, ok: true, command: r.command, data: r.data };
      });

      const okCount = results.filter((r) => r.ok).length;
      const errCount = results.length - okCount;

      return {
        ok: true,
        data: {
          service: i.service,
          operation: i.operation,
          regionCount: regions.length,
          okCount,
          errorCount: errCount,
          results,
        },
      };
    },
  },
];
