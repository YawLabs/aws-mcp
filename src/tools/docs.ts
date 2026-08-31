import { randomUUID } from "node:crypto";
import { parse as parseHtml } from "node-html-parser";
import TurndownService from "turndown";
import { z } from "zod";
import type { Tool, ToolResult } from "./tool.js";

/**
 * Live AWS documentation: search + read. Unlike every other tool in this
 * server, these do raw HTTP instead of shelling to the aws CLI -- AWS docs
 * aren't an API the CLI covers. The point is to make this server
 * self-sufficient for the docs use case so a user doesn't have to install a
 * second MCP server just to look things up.
 *
 * search hits the same backend that powers the docs.aws.amazon.com search box
 * (`proxy.search.docs.aws.com/search`). That endpoint is undocumented and
 * could change without notice -- if search starts returning empty, check
 * whether the request/response shape moved. read fetches a docs page, pulls
 * the main content region out of the surrounding chrome, and converts it to
 * markdown.
 */

// Powers the docs.aws.amazon.com search box. Undocumented/internal -- treat
// as a moving target. A session id is generated per `buildDocsTools` call
// (one per process in production, distinct per test instance) rather than
// at module load, so tests get isolation without paying the cost of a
// shared module-global handle.
const SEARCH_API_URL = "https://proxy.search.docs.aws.com/search";
const USER_AGENT = "@yawlabs/aws-mcp (https://github.com/YawLabs/aws-mcp)";

// read_documentation only accepts AWS doc pages, and only .html ones --
// AWS docs are served as .html; anything else is an asset or an off-site
// link we shouldn't be fetching.
const DOCS_URL_RE = /^https:\/\/docs\.aws\.amazon\.com\/[^\s]*\.html(?:[?#][^\s]*)?$/i;

const DEFAULT_MAX_LENGTH = 5_000;
const MAX_MAX_LENGTH = 1_000_000;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const FETCH_TIMEOUT_MS = 30_000;

// Hard ceiling on the HTML we will pull down for one page. FETCH_TIMEOUT_MS
// bounds LATENCY, not SIZE -- a steady multi-hundred-MB body streams in well
// under 30s, buffers entirely in memory, and then blocks the event loop of
// this single-threaded stdio server inside turndown's synchronous conversion.
// 5 MB mirrors aws-cli.ts's per-stream stdout cap so both ingress paths into
// this process carry the same ceiling; real AWS doc pages are 10-800 KB.
const MAX_DOC_HTML_BYTES = 5 * 1024 * 1024;

// aws_docs_read is paginated: an agent reading a long page calls it N times
// with different startIndex windows. Without a cache that's N full fetches +
// N full HTML->markdown conversions of the same document. Cache the
// *converted markdown* (conversion is the expensive half) keyed by URL,
// bounded by size + TTL. TTL is short because docs do change -- but not
// within the seconds-to-minutes window a single paginated read spans.
//
// Cap sized for typical multi-doc agent workflows (read N service overviews
// in one session) without unbounded memory growth. Each entry is bounded
// by MAX_MAX_LENGTH (1MB) of converted markdown, so worst-case footprint
// is ~64MB; typical doc pages are 10-100 KB after chrome stripping.
//
// Two things make that bound real rather than aspirational: the body read is
// capped at MAX_DOC_HTML_BYTES, and the handler only caches a conversion whose
// markdown fits MAX_MAX_LENGTH (an over-size page is still served in full via
// pagination -- it just re-fetches per window instead of blowing the bound).
export const DOC_CACHE_MAX_ENTRIES = 64;
const DOC_CACHE_TTL_MS = 5 * 60_000;

interface DocsSearchResult {
  title: string;
  url: string;
  summary?: string;
  excerpt?: string;
}

/**
 * Once-per-process flag so the schema-drift warn doesn't spam stderr on
 * every search after the first hit. Exported reset for tests.
 *
 * Intentionally MODULE-LEVEL, not per-`buildDocsTools` instance like the
 * sibling session UUID at lines below. The session UUID is per-instance
 * because it identifies a logical client to the upstream backend; the warn
 * flag tracks something different -- the upstream proxy.search.docs.aws.com
 * response SHAPE -- which is a process-wide singleton (one upstream, one
 * schema). Per-instance would warn N times per process when the same break
 * surfaces in N instances, defeating the once-per-process intent.
 */
let schemaWarned = false;
/** Test-only: reset the once-per-process schema-drift warn flag. */
export function _resetParseSearchSchemaWarn(): void {
  schemaWarned = false;
}

/**
 * Pull the fields callers want off the search backend's `suggestions[]`.
 * Each suggestion nests the useful bits under `textExcerptSuggestion`;
 * entries without a `link` are dropped (can't act on a result with no URL).
 *
 * If the response is a non-empty object that lacks a `suggestions` array,
 * warn once -- the undocumented backend at proxy.search.docs.aws.com may
 * have changed its shape, and the silent-empty-results that would otherwise
 * result is the kind of thing operators only notice after debugging an
 * agent's "I couldn't find any docs" complaint. A legitimately empty
 * `suggestions: []` is not warned (real no-match case).
 */
export function parseSearchResults(json: unknown, limit: number): DocsSearchResult[] {
  if (!json || typeof json !== "object") return [];
  const suggestions = (json as { suggestions?: unknown }).suggestions;
  if (!Array.isArray(suggestions)) {
    if (!schemaWarned && Object.keys(json as object).length > 0) {
      schemaWarned = true;
      console.warn(
        "[aws-mcp] aws_docs_search: response from proxy.search.docs.aws.com is missing the expected 'suggestions' array. The undocumented backend shape may have changed; aws_docs_search will return empty results until parseSearchResults is updated.",
      );
    }
    return [];
  }
  const out: DocsSearchResult[] = [];
  for (const s of suggestions) {
    if (out.length >= limit) break;
    if (!s || typeof s !== "object") continue;
    const tes = (s as { textExcerptSuggestion?: unknown }).textExcerptSuggestion;
    if (!tes || typeof tes !== "object") continue;
    const t = tes as Record<string, unknown>;
    const url = typeof t.link === "string" ? t.link : undefined;
    if (!url) continue;
    // Apply the read-side allowlist here too so search and read agree on
    // what counts as a valid AWS docs URL. The undocumented backend at
    // proxy.search.docs.aws.com is a moving target, and an off-domain or
    // non-https link surfaced to the agent would only be blocked when the
    // agent tried to read it -- cheaper to drop the result up front.
    if (!isValidDocsUrl(url)) continue;
    const title = typeof t.title === "string" ? t.title : url;
    const result: DocsSearchResult = { title, url };
    if (typeof t.summary === "string" && t.summary.length > 0) result.summary = t.summary;
    if (typeof t.suggestionBody === "string" && t.suggestionBody.length > 0) result.excerpt = t.suggestionBody;
    out.push(result);
  }
  return out;
}

/** Match the read-side URL allowlist. Exposed for tests. */
export function isValidDocsUrl(url: string): boolean {
  return DOCS_URL_RE.test(url);
}

// AWS doc pages wrap the real content in a lot of nav/chrome. Try these
// selectors in order; the first that matches is the content root. Mirrors
// the containers the AWS Labs documentation server looks for.
const CONTENT_SELECTORS = ["#awsdocs-content", "main", "article", "[role=main]"];

// Chrome to strip before conversion -- scripts/styles are noise, and AWS
// doc pages carry cookie banners, feedback widgets, breadcrumb nav, a
// toolbar with a PDF-download link, and page-header cruft that all turn
// into markdown garbage. Selectors that don't match are harmless no-ops,
// so the list errs toward covering known AWS-doc chrome patterns.
const STRIP_SELECTORS = [
  "script",
  "style",
  "noscript",
  "nav",
  "header",
  "footer",
  "#awsdocs-cookie-banner",
  ".awsdocs-cookie-banner",
  "#awsdocs-page-header",
  "awsdocs-page-header",
  "#awsdocs-toolbar",
  ".awsdocs-toolbar",
  "awsdocs-toolbar",
  "#breadcrumbs",
  ".breadcrumb",
  ".breadcrumbs",
  "awsdocs-breadcrumbs",
  "#awsdocs-language-banner",
  ".feedback",
  "#feedback",
  "awsdocs-feedback-modal",
  "awsdocs-page-utilities",
];

/**
 * Extract the main content region of an AWS doc page as an HTML string,
 * stripped of nav/script/style chrome. Falls back to the whole body when no
 * known content container matches (better some markdown than none).
 */
export function extractMainContent(html: string): string {
  const root = parseHtml(html);
  for (const sel of STRIP_SELECTORS) {
    for (const el of root.querySelectorAll(sel)) {
      el.remove();
    }
  }
  for (const sel of CONTENT_SELECTORS) {
    const found = root.querySelector(sel);
    if (found) return found.toString();
  }
  const body = root.querySelector("body");
  return body ? body.toString() : html;
}

let turndown: TurndownService | undefined;
function getTurndown(): TurndownService {
  if (!turndown) {
    turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
    });
    // Drop anchors with no visible text -- AWS doc chrome (PDF-download
    // buttons, icon-only nav links) renders as `<a href="...">` with empty
    // text and would otherwise convert to a useless `[](url)`. Doing this as
    // a turndown rule (DOM level) instead of a regex on the output is robust
    // to URLs that themselves contain `)`. An anchor wrapping an <img> is
    // kept -- it carries a real image, not chrome.
    turndown.addRule("dropEmptyAnchors", {
      filter: (node) => {
        if (node.nodeName !== "A") return false;
        if (node.textContent.trim() !== "") return false;
        const inner = (node as unknown as { innerHTML?: string }).innerHTML ?? "";
        return !/<img/i.test(inner);
      },
      replacement: () => "",
    });
  }
  return turndown;
}

/**
 * Convert an AWS doc page's HTML to markdown. Empty-text links are dropped at
 * the turndown rule level (see getTurndown). Here we just collapse 3+
 * consecutive blank lines that chrome removal can leave behind.
 */
export function htmlToMarkdown(html: string): string {
  const main = extractMainContent(html);
  const md = getTurndown().turndown(main);
  return md.replace(/\n{3,}/g, "\n\n").trim();
}

interface PaginatedContent {
  content: string;
  startIndex: number;
  endIndex: number;
  totalLength: number;
  hasMore: boolean;
  nextStartIndex: number | null;
}

/**
 * Slice a long markdown doc for paginated reads. The agent reads one window,
 * then calls again with `nextStartIndex` if `hasMore`. Out-of-range
 * startIndex clamps to the end and returns an empty window rather than
 * throwing -- the agent gets `hasMore: false` and stops.
 */
export function paginateContent(markdown: string, startIndex: number, maxLength: number): PaginatedContent {
  const total = markdown.length;
  const start = Math.max(0, Math.min(startIndex, total));
  const end = Math.min(start + maxLength, total);
  const hasMore = end < total;
  return {
    content: markdown.slice(start, end),
    startIndex: start,
    endIndex: end,
    totalLength: total,
    hasMore,
    nextStartIndex: hasMore ? end : null,
  };
}

/** Fetch with an AbortController-backed timeout. Injectable for tests. */
type FetchImpl = typeof fetch;

async function fetchWithTimeout(
  fetchImpl: FetchImpl,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True when an error is the AbortController firing our timeout. Node's fetch
 * rejects with a DOMException (name "AbortError") which isn't always an
 * `instanceof Error`, so we read `.name` defensively rather than relying on
 * the prototype chain.
 */
function isAbortError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}

/**
 * Outcome of a capped body read. `too_large` carries the observed byte count
 * when we learned it from Content-Length (i.e. before downloading anything)
 * and null when we hit the cap mid-stream and stopped counting.
 */
type BodyReadOutcome =
  | { kind: "ok"; html: string }
  | { kind: "too_large"; bytes: number | null }
  | { kind: "error"; message: string };

/**
 * Read a response body with a hard byte ceiling.
 *
 * Three layers, cheapest first:
 *   1. A Content-Length over the cap rejects before a single byte is pulled.
 *   2. A streaming body is read chunk-by-chunk and cancelled the moment the
 *      running total crosses the cap -- the bytes past it are never buffered.
 *   3. A Response-like object with no stream body (test doubles, a fetch impl
 *      that only implements text()) is buffered and then measured, which
 *      still enforces the same ceiling on what reaches turndown.
 */
async function readBodyWithCap(response: Response, maxBytes: number): Promise<BodyReadOutcome> {
  const declaredHeader = response.headers.get("content-length");
  if (declaredHeader !== null) {
    const declared = Number(declaredHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { kind: "too_large", bytes: declared };
    }
  }

  try {
    const body = (response as { body?: ReadableStream<Uint8Array> | null }).body;
    if (body && typeof body.getReader === "function") {
      const reader = body.getReader();
      const decoder = new TextDecoder("utf-8");
      let bytes = 0;
      let html = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          // Stop the transfer; we already have more than we are willing to
          // convert. cancel() can reject on an already-errored stream, and
          // that is not the failure we want to report.
          await reader.cancel().catch(() => {});
          return { kind: "too_large", bytes: null };
        }
        // stream: true so a multi-byte UTF-8 sequence split across chunks
        // doesn't decode to U+FFFD.
        html += decoder.decode(value, { stream: true });
      }
      html += decoder.decode();
      return { kind: "ok", html };
    }
    const html = await response.text();
    const bytes = Buffer.byteLength(html, "utf8");
    if (bytes > maxBytes) return { kind: "too_large", bytes };
    return { kind: "ok", html };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

interface DocCacheEntry {
  markdown: string;
  storedAt: number;
}

interface DocCache {
  get(url: string): string | undefined;
  set(url: string, markdown: string): void;
}

/**
 * Bounded, TTL'd LRU cache of converted markdown keyed by doc URL. Created
 * per `buildDocsTools` call so each instance (and each test) gets an isolated
 * cache -- a module-level cache would leak one test's fetch result into
 * another test reading the same URL with a different injected fetch.
 */
export function makeDocCache(): DocCache {
  const map = new Map<string, DocCacheEntry>();
  return {
    get(url) {
      const entry = map.get(url);
      if (!entry) return undefined;
      if (Date.now() - entry.storedAt > DOC_CACHE_TTL_MS) {
        map.delete(url);
        return undefined;
      }
      // Refresh recency: re-insert so this URL is now the newest entry.
      map.delete(url);
      map.set(url, entry);
      return entry.markdown;
    },
    set(url, markdown) {
      map.delete(url);
      map.set(url, { markdown, storedAt: Date.now() });
      while (map.size > DOC_CACHE_MAX_ENTRIES) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
  };
}

export function buildDocsTools(fetchImpl: FetchImpl = fetch): readonly Tool[] {
  const docCache = makeDocCache();
  // One session per buildDocsTools() instance. Production calls
  // buildDocsTools once at module load, so the prod-server lifetime UUID
  // is unchanged. Tests get isolated UUIDs without sharing module state.
  const sessionUuid = randomUUID();
  return [
    {
      name: "aws_docs_search",
      description:
        "Search the live AWS documentation (the same backend that powers the docs.aws.amazon.com search box). Use this to discover the right doc page for a service, API, or concept the model may not know about -- new services, recently changed APIs, exact parameter names. Returns ranked results as {title, url, summary, excerpt}. Follow up with aws_docs_read on a result's url to get the full page as markdown.",
      annotations: {
        title: "Search live AWS documentation",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .max(500)
          .describe("Search phrase, e.g. 'S3 bucket naming rules', 'Lambda environment variables', 'DynamoDB GSI'."),
        limit: z
          .number()
          .int()
          .positive()
          .max(MAX_SEARCH_LIMIT)
          .optional()
          .describe(`Max results to return (1-${MAX_SEARCH_LIMIT}). Default ${DEFAULT_SEARCH_LIMIT}.`),
      }),
      handler: async (input: unknown): Promise<ToolResult> => {
        const i = input as { query: string; limit?: number };
        // Clamp limit into the valid range. No caller currently reaches this
        // handler unvalidated -- index.ts registers inputSchema at the MCP
        // boundary and the aws_script bridge runs inputSchema.parse first
        // (script.ts:158-161) -- so this is a local invariant kept next to the
        // code that depends on it, not a live guard against a known caller.
        const limit = Math.min(Math.max(1, i.limit ?? DEFAULT_SEARCH_LIMIT), MAX_SEARCH_LIMIT);
        let response: Response;
        try {
          response = await fetchWithTimeout(
            fetchImpl,
            `${SEARCH_API_URL}?session=${sessionUuid}`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "User-Agent": USER_AGENT,
                "X-MCP-Session-Id": sessionUuid,
              },
              body: JSON.stringify({
                textQuery: { input: i.query },
                contextAttributes: [{ key: "domain", value: "docs.aws.amazon.com" }],
                acceptSuggestionBody: "RawText",
                locales: ["en_us"],
              }),
            },
            FETCH_TIMEOUT_MS,
          );
        } catch (err) {
          if (isAbortError(err)) {
            return {
              ok: false,
              error: `AWS docs search timed out after ${FETCH_TIMEOUT_MS / 1000}s. The search backend (proxy.search.docs.aws.com) may be slow or unreachable.`,
            };
          }
          const msg = err instanceof Error ? err.message : String(err);
          return {
            ok: false,
            error: `AWS docs search request failed: ${msg}. The search backend (proxy.search.docs.aws.com) is undocumented and may have changed or be unreachable.`,
          };
        }
        if (!response.ok) {
          return {
            ok: false,
            error: `AWS docs search returned HTTP ${response.status} ${response.statusText}.`,
          };
        }
        let json: unknown;
        try {
          json = await response.json();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { ok: false, error: `AWS docs search returned a non-JSON body: ${msg}.` };
        }
        const results = parseSearchResults(json, limit);
        return {
          ok: true,
          data: {
            query: i.query,
            count: results.length,
            results,
          },
        };
      },
    },

    {
      name: "aws_docs_read",
      description:
        "Fetch an AWS documentation page and return it as markdown. `url` must be an https://docs.aws.amazon.com/...html page (typically one returned by aws_docs_search). Long pages are paginated: pass `startIndex` (default 0) and `maxLength` (default 5000 chars); the response includes `hasMore` and `nextStartIndex` -- call again with nextStartIndex to continue. Strips nav/cookie-banner/feedback chrome before converting.",
      annotations: {
        title: "Read an AWS documentation page as markdown",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: z.object({
        url: z
          .string()
          .min(1)
          .max(2048)
          .describe(
            "AWS docs page URL: https://docs.aws.amazon.com/<...>.html. Usually from an aws_docs_search result.",
          ),
        startIndex: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Character offset to start from (for paginated reads). Default 0."),
        maxLength: z
          .number()
          .int()
          .positive()
          .max(MAX_MAX_LENGTH)
          .optional()
          .describe(`Max characters of markdown to return. Default ${DEFAULT_MAX_LENGTH}; max ${MAX_MAX_LENGTH}.`),
      }),
      handler: async (input: unknown): Promise<ToolResult> => {
        const i = input as { url: string; startIndex?: number; maxLength?: number };
        if (!isValidDocsUrl(i.url)) {
          return {
            ok: false,
            error: `Invalid url '${i.url}'. Must be an 'https://docs.aws.amazon.com/...html' page. Use aws_docs_search to find one.`,
          };
        }
        const startIndex = Math.max(0, i.startIndex ?? 0);
        // Clamp maxLength into the valid range. Same status as the limit clamp
        // in aws_docs_search above: every entry point parses the schema first
        // (MCP boundary in index.ts, inputSchema.parse in script.ts:158-161),
        // so this keeps the invariant local rather than covering a caller that
        // actually bypasses validation.
        const maxLength = Math.min(Math.max(1, i.maxLength ?? DEFAULT_MAX_LENGTH), MAX_MAX_LENGTH);

        // Paginated reads of the same page hit the cache -- one fetch +
        // convert per URL, then every subsequent window is a slice.
        let markdown = docCache.get(i.url);
        let cached = true;
        if (markdown === undefined) {
          cached = false;
          let response: Response;
          try {
            response = await fetchWithTimeout(
              fetchImpl,
              i.url,
              { method: "GET", headers: { "User-Agent": USER_AGENT, Accept: "text/html" } },
              FETCH_TIMEOUT_MS,
            );
          } catch (err) {
            if (isAbortError(err)) {
              return { ok: false, error: `Fetching ${i.url} timed out after ${FETCH_TIMEOUT_MS / 1000}s.` };
            }
            const msg = err instanceof Error ? err.message : String(err);
            return { ok: false, error: `Failed to fetch ${i.url}: ${msg}.` };
          }
          if (!response.ok) {
            return { ok: false, error: `Fetching ${i.url} returned HTTP ${response.status} ${response.statusText}.` };
          }
          // fetch FOLLOWS redirects, so the isValidDocsUrl check on i.url above
          // only vouches for the first hop. Re-check where we actually landed:
          // without this, an allowlisted docs URL that 302s off-domain gets
          // fetched and converted with nothing but the content-type gate
          // between us and arbitrary third-party HTML.
          // `response.url` is absent/empty on a Response-like object that
          // doesn't set it (test doubles); that means "no redirect
          // information", so fall back to the URL we already validated.
          const finalUrl = typeof response.url === "string" && response.url.length > 0 ? response.url : i.url;
          if (!isValidDocsUrl(finalUrl)) {
            return {
              ok: false,
              error: `${i.url} redirected to '${finalUrl}', which is not an 'https://docs.aws.amazon.com/...html' page. aws_docs_read only follows redirects that stay inside the AWS documentation allowlist.`,
            };
          }
          // A 200 doesn't guarantee HTML -- a docs URL can redirect to a
          // login wall, an error page, or an asset. Feeding non-HTML to the
          // parser produces junk markdown; reject it with a clear message
          // instead.
          const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
          if (!contentType.includes("text/html")) {
            return {
              ok: false,
              error: `${i.url} returned content-type '${contentType || "unknown"}', not text/html -- the URL may have redirected to a non-documentation page (login wall, error page, or asset). aws_docs_read only handles AWS documentation HTML pages.`,
            };
          }
          const body = await readBodyWithCap(response, MAX_DOC_HTML_BYTES);
          if (body.kind === "error") {
            return { ok: false, error: `Failed to read the response body from ${i.url}: ${body.message}.` };
          }
          if (body.kind === "too_large") {
            const observed = body.bytes !== null ? ` (content-length ${body.bytes} bytes)` : "";
            return {
              ok: false,
              error: `${i.url} returned more than ${MAX_DOC_HTML_BYTES / 1024 / 1024} MB of HTML${observed} -- too large to convert. AWS documentation pages are far smaller than this, so the URL is likely a generated dump or a non-documentation asset.`,
            };
          }
          markdown = htmlToMarkdown(body.html);
          // Only cache what the DOC_CACHE_MAX_ENTRIES footprint math assumes:
          // at most MAX_MAX_LENGTH of markdown per entry. An over-size page is
          // still served in full (paginateContent slices the whole string
          // below) -- it just costs a fetch + convert per window instead of
          // silently breaking the cache bound.
          if (markdown.length <= MAX_MAX_LENGTH) docCache.set(i.url, markdown);
        }

        const page = paginateContent(markdown, startIndex, maxLength);

        return {
          ok: true,
          data: {
            url: i.url,
            cached,
            ...page,
          },
        };
      },
    },
  ];
}

export const docsTools: readonly Tool[] = buildDocsTools();
