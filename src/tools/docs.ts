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
// as a moving target. A session id is generated once per process, mirroring
// how the AWS Labs documentation server scopes a search session.
const SEARCH_API_URL = "https://proxy.search.docs.aws.com/search";
const SESSION_UUID = randomUUID();
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

export interface DocsSearchResult {
  title: string;
  url: string;
  summary?: string;
  excerpt?: string;
}

/**
 * Pull the fields callers want off the search backend's `suggestions[]`.
 * Each suggestion nests the useful bits under `textExcerptSuggestion`;
 * entries without a `link` are dropped (can't act on a result with no URL).
 */
export function parseSearchResults(json: unknown, limit: number): DocsSearchResult[] {
  if (!json || typeof json !== "object") return [];
  const suggestions = (json as { suggestions?: unknown }).suggestions;
  if (!Array.isArray(suggestions)) return [];
  const out: DocsSearchResult[] = [];
  for (const s of suggestions) {
    if (out.length >= limit) break;
    if (!s || typeof s !== "object") continue;
    const tes = (s as { textExcerptSuggestion?: unknown }).textExcerptSuggestion;
    if (!tes || typeof tes !== "object") continue;
    const t = tes as Record<string, unknown>;
    const url = typeof t.link === "string" ? t.link : undefined;
    if (!url) continue;
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
  }
  return turndown;
}

/**
 * Convert an AWS doc page's HTML to markdown. After conversion, drop
 * empty-text links (`[](url)`) -- AWS doc chrome (PDF-download buttons,
 * icon-only links) converts to these, and a link with no visible text
 * carries no information for a reader. Also collapse 3+ consecutive blank
 * lines that the chrome removal can leave behind.
 */
export function htmlToMarkdown(html: string): string {
  const main = extractMainContent(html);
  const md = getTurndown().turndown(main);
  return md
    .replace(/\[\]\([^)]*\)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface PaginatedContent {
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
export type FetchImpl = typeof fetch;

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

export function buildDocsTools(fetchImpl: FetchImpl = fetch): readonly Tool[] {
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
        const limit = i.limit ?? DEFAULT_SEARCH_LIMIT;
        let response: Response;
        try {
          response = await fetchWithTimeout(
            fetchImpl,
            `${SEARCH_API_URL}?session=${SESSION_UUID}`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "User-Agent": USER_AGENT,
                "X-MCP-Session-Id": SESSION_UUID,
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
        const startIndex = i.startIndex ?? 0;
        const maxLength = i.maxLength ?? DEFAULT_MAX_LENGTH;

        let response: Response;
        try {
          response = await fetchWithTimeout(
            fetchImpl,
            i.url,
            { method: "GET", headers: { "User-Agent": USER_AGENT, Accept: "text/html" } },
            FETCH_TIMEOUT_MS,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { ok: false, error: `Failed to fetch ${i.url}: ${msg}.` };
        }
        if (!response.ok) {
          return { ok: false, error: `Fetching ${i.url} returned HTTP ${response.status} ${response.statusText}.` };
        }
        const html = await response.text();
        const markdown = htmlToMarkdown(html);
        const page = paginateContent(markdown, startIndex, maxLength);

        return {
          ok: true,
          data: {
            url: i.url,
            ...page,
          },
        };
      },
    },
  ];
}

export const docsTools: readonly Tool[] = buildDocsTools();
