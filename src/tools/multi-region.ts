import { z } from "zod";
import { runAwsCall } from "../aws-cli.js";
import { isValidRegionName, REGION_NAME_RE } from "../session.js";
import type { Tool, ToolContext, ToolResult } from "./tool.js";

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

// Per-CALL output is capped (aws-cli.ts kills a subprocess whose stdout passes
// 5 MB), but the BATCH had no ceiling of its own: 32 regions x 5 MB each is
// 160 MB held in `results` and then JSON-serialized into a single MCP response.
// Cap the aggregate at the same 5 MB one call is allowed. Entries are kept in
// order and counted until the budget is spent; past it, an entry's `data` is
// DROPPED (not string-truncated, which would emit unparseable JSON) and the
// entry is flagged `truncated: true` so the caller can see exactly which
// regions to re-run on their own or narrow with `query` / `params`.
const MAX_TOTAL_RESULT_BYTES = 5 * 1024 * 1024;

// Region validation comes from session.ts (REGION_NAME_RE / isValidRegionName)
// so the argv-safety contract for region IDs is defined in one place. Previously
// this file carried a duplicate regex with the identical pattern -- harmless
// today, drift risk tomorrow.

/**
 * The part of a fan-out entry {@link capAggregateResults} needs to reason about:
 * whether the call succeeded, and whether it carries a payload big enough to be
 * worth dropping.
 *
 * Everything that identifies the entry -- `region` here, `accountId` in
 * aws_multi_account -- is deliberately NOT in this shape. The cap function
 * reads the identifier through the `idOf` accessor its caller passes and
 * otherwise copies the entry wholesale, so it stays honest about entries whose
 * key it has never heard of.
 */
export interface CappableResult {
  ok: boolean;
  data?: unknown;
  command?: string;
  error?: string;
  errorKind?: string;
  /**
   * True when this entry's call finished but its `data` was dropped to keep the
   * aggregate response under the byte budget. `ok` still reports what the CALL
   * did -- an ok:true entry with truncated:true succeeded and its payload
   * didn't fit, which is a different thing from a failure.
   */
  truncated?: boolean;
}

export interface RegionResult extends CappableResult {
  region: string;
}

/**
 * Enforce the aggregate response budget across a batch of per-item results.
 *
 * Walks entries in order, charging each one its serialized size, and once the
 * budget is spent drops `data` from any entry that carries one. Error entries
 * are left intact: their text is already bounded (aws-cli.ts truncates error
 * messages at 8 KB) and losing the reason an item failed is worse than the
 * bytes it costs. Returns the ids whose data was dropped so the handler can
 * surface them.
 *
 * `idOf` is required rather than defaulted because this function is shared by
 * fan-outs keyed on different fields (aws_multi_region on `region`,
 * aws_multi_account on `accountId`); a default would silently name the wrong
 * thing -- or nothing -- for the next one.
 */
export function capAggregateResults<T extends CappableResult>(
  results: readonly T[],
  maxBytes: number,
  idOf: (entry: T) => string,
): { results: T[]; truncatedIds: string[] } {
  const truncatedIds: string[] = [];
  let used = 0;
  const out = results.map((r) => {
    const size = Buffer.byteLength(JSON.stringify(r), "utf8");
    if (used + size <= maxBytes || r.data === undefined) {
      used += size;
      return r;
    }
    // Copy-minus-`data`, not a hand-written field list. A literal would have to
    // name every key worth keeping, and the identifier key differs per caller --
    // so the entry the caller got back would be one it could not match to its
    // own input. The rest-destructure also means a field added to an entry type
    // later survives truncation without anyone remembering to update this.
    const { data: _dropped, ...withoutData } = r;
    const trimmed = { ...withoutData, truncated: true } as T;
    truncatedIds.push(idOf(r));
    used += Buffer.byteLength(JSON.stringify(trimmed), "utf8");
    return trimmed;
  });
  return { results: out, truncatedIds };
}

/**
 * Run a bounded set of async tasks in parallel. Plain Promise.all with a
 * window pointer -- no external dep. Each task gets a slot; when one
 * finishes, the next pending task starts. Order of `results` matches the
 * order of `inputs`.
 *
 * Contract: `fn` MUST resolve, never reject. We do NOT convert a rejection
 * into a per-input result -- the generic `R` can't express an error variant,
 * and inventing one would silently reshape every caller's result type. A
 * rejection still fails the whole batch (rejects the `Promise.all`, abandons
 * every other still-running task). What the try/catch below buys is a LEGIBLE
 * failure: the re-thrown error names the offending index and states the
 * contract, instead of surfacing an opaque error from an anonymous worker with
 * no indication of which input caused it.
 *
 * Both current callers (aws_multi_region, aws_multi_account) are safe because
 * their `fn` wraps each item in a try/catch and runAwsCall is itself
 * resolve-only -- it returns an `{ok: false, ...}` result on failure instead of
 * rejecting. Any NEW caller must uphold the same discipline: catch inside `fn`
 * and return a result, never let `fn` reject.
 *
 * `concurrency` is floored at 1: a zero or negative value would spawn zero
 * workers, so `Promise.all([])` resolves instantly and every slot of `results`
 * stays a hole. Callers see a full-length array of `null`s (holes serialize as
 * null) and a success envelope, having never run a single task. Clamping here
 * makes that unrepresentable no matter who calls.
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
      try {
        results[i] = await fn(inputs[i], i);
      } catch (err) {
        throw new Error(
          `runWithConcurrency: the task at index ${i} rejected, but fn must always resolve -- catch inside fn and return a result instead. Every other in-flight task was abandoned.`,
          { cause: err },
        );
      }
    }
  };
  const safeConcurrency = Number.isFinite(concurrency) ? Math.max(1, Math.trunc(concurrency)) : 1;
  const workerCount = Math.min(safeConcurrency, inputs.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export const multiRegionTools: readonly Tool[] = [
  {
    name: "aws_multi_region",
    description:
      "Run the same AWS API operation across multiple regions in parallel. Same shape as aws_call (service, operation, params?, query?, outputFormat?, timeoutMs?) but takes `regions: string[]` instead of `region`. Returns an array of `{region, ok, data?, command?, error?, errorKind?}` -- partial failure is expected (services aren't everywhere, perms may be region-scoped). Duplicate regions in the input are collapsed (first occurrence wins), so `results.length` may be less than `regions.length`; use the returned `regionCount` for the actual count run. The whole batch is capped at 5 MB of results: if it would exceed that, later entries keep their status but lose `data` and are flagged `truncated: true`, with the affected regions listed in a top-level `truncatedRegions` -- re-run those regions individually or narrow with `query`/`params`. Use for fleet-wide reads: 'describe-instances across all our regions', 'list buckets in every region', 'check IAM password policy everywhere'.",
    annotations: {
      title: "Run an AWS operation across multiple regions in parallel",
      // Same reasoning as aws_call (see call.ts), and strictly more so: this
      // runs the caller's chosen operation across up to 32 regions at once, so
      // a destructive one is destructive N times in parallel. destructiveHint
      // MUST stay true -- `false` asserts "only additive updates", which this
      // cannot promise, and it suppresses the host's confirmation prompt.
      readOnlyHint: false,
      destructiveHint: true,
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
          `Region IDs (e.g. ['us-east-1','us-west-2','eu-west-1']). 1-${MAX_REGIONS}. Validated for argv-safety; a bad region name yields a clear per-region error and skips its CLI spawn (per-region isolation comes from each region being a separate call, not from this pre-check).`,
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
    handler: async (input: unknown, ctx?: ToolContext): Promise<ToolResult> => {
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

      // Defense-in-depth, matching the handler-level clamps in paginate.ts and
      // docs.ts: the schema bounds regions at MAX_REGIONS and concurrency at
      // 1..MAX_CONCURRENCY, but callers that reach the handler directly (the
      // aws_script bridge before it began parsing, tests, future internal
      // callers) never see those bounds.
      //
      // Bound the RAW list, BEFORE the dedup below, for two reasons:
      //   - The schema's .max(MAX_REGIONS) also applies to the raw array.
      //     Checking the deduped count instead would make this handler ACCEPT
      //     input the MCP boundary REJECTS (e.g. 40 entries with 10 duplicates
      //     = 30 distinct), so the same call would succeed or fail depending on
      //     which entry point it came through.
      //   - The dedup loop allocates proportional to the input, so guarding
      //     after it means doing the unbounded work first.
      // Reject rather than truncate: silently dropping regions the caller asked
      // about is worse than an explicit error.
      if (i.regions.length > MAX_REGIONS) {
        return {
          ok: false,
          error: `Too many regions: ${i.regions.length} requested, max ${MAX_REGIONS}. Split the batch.`,
        };
      }

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

      const requestedConcurrency = Number(i.concurrency ?? DEFAULT_CONCURRENCY);
      const concurrency = Number.isFinite(requestedConcurrency)
        ? Math.min(Math.max(1, Math.trunc(requestedConcurrency)), MAX_CONCURRENCY)
        : DEFAULT_CONCURRENCY;

      // Progress denominator: the DEDUPED region count, which is what actually
      // gets dispatched (and what `regionCount` reports below). Using
      // i.regions.length would leave the bar short of its own total whenever
      // the caller repeated a region.
      const total = regions.length;
      let completed = 0;

      const runRegion = async (region: string): Promise<RegionResult> => {
        try {
          if (!isValidRegionName(region)) {
            return {
              region,
              ok: false,
              error: `Invalid region '${region}'. Must match ${REGION_NAME_RE} (e.g. 'us-east-1').`,
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
        } catch (err) {
          return {
            region,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            errorKind: "unexpected",
          };
        }
      };

      const results = await runWithConcurrency(regions, concurrency, async (region): Promise<RegionResult> => {
        const result = await runRegion(region);
        // Report on COMPLETION, never on dispatch. The concurrency limiter
        // keeps only `concurrency` regions in flight at a time, so counting at
        // dispatch would race ahead of what has actually settled -- and would
        // hit `total` while the last window was still running.
        //
        // `completed++` needs no lock: the workers interleave at await
        // boundaries on one thread, so the increment is atomic with respect to
        // them and the sequence 1..total is emitted in order, satisfying the
        // spec's monotonicity requirement.
        completed++;
        try {
          ctx?.reportProgress(completed, total, `${region}: ${result.ok ? "ok" : "failed"} (${completed}/${total})`);
        } catch {
          // Progress is advisory. runWithConcurrency's contract is that `fn`
          // MUST resolve -- a throw here would abandon every other in-flight
          // region over a notification, so swallow it and return the result we
          // already have.
        }
        return result;
      });

      // Counted BEFORE the aggregate cap runs: okCount/errorCount describe what
      // the CALLS did, which is unchanged by whether a payload fit in the
      // response budget.
      const okCount = results.filter((r) => r.ok).length;
      const errCount = results.length - okCount;
      const capped = capAggregateResults(results, MAX_TOTAL_RESULT_BYTES, (r) => r.region);

      return {
        ok: true,
        data: {
          service: i.service,
          operation: i.operation,
          regionCount: regions.length,
          okCount,
          errorCount: errCount,
          // The envelope field stays `truncatedRegions` even though the shared
          // helper now returns the neutral `truncatedIds`: it is a published
          // response field this tool's callers already read.
          ...(capped.truncatedIds.length > 0
            ? {
                truncated: true,
                truncatedRegions: capped.truncatedIds,
                maxTotalResultBytes: MAX_TOTAL_RESULT_BYTES,
              }
            : {}),
          results: capped.results,
        },
      };
    },
  },
];
