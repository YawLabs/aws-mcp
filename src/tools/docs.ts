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

/* ---------------------------------------------------------------------------
 * Lexical relevance signal for aws_docs_search.
 *
 * The backend at proxy.search.docs.aws.com ALWAYS returns a full page of fuzzy
 * matches and has no way to answer "nothing here matches". Searching the
 * nonsense string "zzzzqqq-nonexistent-service-xyzzy" against the published
 * server returned ten confidently ranked hits topped by a Ruby SDK
 * `Route53::Errors::NoSuchHealthCheck` reference page. The response carries no
 * score, no confidence, and no relevance field of any kind, so there is nothing
 * in it a caller could threshold on -- a model sees `count: 10` and cannot tell
 * ten good hits from ten irrelevant ones, which is how an unrelated page ends
 * up cited as authoritative. An empty result set would have been more useful.
 *
 * So the signal is computed LOCALLY and named for exactly what it is: lexical
 * term overlap. How many of the query's own words literally appear in a
 * result's title/summary/excerpt. It is NOT a backend score (there is none),
 * NOT semantic ranking, and NOT a claim about which result is best. It answers
 * one narrow question honestly: did the words you searched for show up at all?
 *
 * Results stay in the backend's own order -- this annotates the ranking, it
 * does not replace it.
 * ------------------------------------------------------------------------- */

/**
 * Below this fraction of query terms found in the best result, the whole
 * response is flagged `lowRelevance`. Deliberately conservative: half the
 * terms is an easy bar for a genuinely on-topic page to clear, so tripping it
 * is evidence the backend had nothing rather than evidence of a strict
 * threshold.
 */
export const LOW_RELEVANCE_OVERLAP = 0.5;

/**
 * Terms too common to carry signal, dropped from the QUERY only.
 *
 * The direction of the error is what matters: these words are near-certain to
 * appear somewhere in any AWS doc excerpt, so leaving them in inflates overlap
 * on every result -- it makes bad matches look good, which is the exact
 * failure this signal exists to prevent. The list is deliberately tiny and
 * holds English function words only, no AWS vocabulary: "service", "api" and
 * "aws" are precisely the terms a caller may mean literally.
 */
const RELEVANCE_STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "do",
  "does",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "use",
  "using",
  "what",
  "when",
  "where",
  "which",
  "with",
  "you",
  "your",
]);

/**
 * Split text into runs of alphanumerics, preserving case for the CamelCase
 * pass below.
 *
 * A naive whitespace split is wrong for this domain: `Route53::Errors::
 * NoSuchHealthCheck`, `s3:GetObject`, `aws-sdk-js` and `dynamodb.describe_table`
 * are each ONE whitespace token, so real matches would be scored as misses.
 * Splitting on every non-alphanumeric run covers hyphens, colons, `::`, dots,
 * slashes and underscores in a single rule.
 */
function alnumRuns(text: string): string[] {
  return text.split(/[^A-Za-z0-9]+/).filter((r) => r.length > 0);
}

/**
 * Split one run on CamelCase / PascalCase boundaries and lowercase the pieces.
 * Two rules, because AWS identifiers use both forms:
 *   `NoSuchHealthCheck` -> no such health check   (lower|digit then upper)
 *   `HTTPSListener`     -> https listener         (acronym then word)
 */
function camelPieces(run: string): string[] {
  return run
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(" ")
    .filter((p) => p.length > 0);
}

/**
 * Every term a reader could reasonably consider "present" in a piece of doc
 * text, in each spelling AWS uses.
 *
 * Four expansions, each killing a false NEGATIVE that would otherwise make a
 * real match look irrelevant:
 *   1. the run as printed     -- a typed `getobject` matches `GetObject`
 *   2. its CamelCase pieces   -- typed `get object` matches `GetObject`
 *   3. glue [letters][digits] -- docs print "Route 53", users type "route53"
 *   4. split `letters+digits` -- docs print "Route53", users type "route 53"
 *
 * The expansion lives on the HAYSTACK side only, never on the query's.
 * Expanding the query would grow the denominator with words the user never
 * typed, which silently changes what the published fraction means.
 */
export function docTerms(text: string): Set<string> {
  const runs = alnumRuns(text);
  const terms = new Set<string>();
  for (let i = 0; i < runs.length; i++) {
    const lower = runs[i].toLowerCase();
    terms.add(lower);
    for (const piece of camelPieces(runs[i])) terms.add(piece);
    const split = /^([a-z]+)(\d+)$/.exec(lower);
    if (split) {
      terms.add(split[1]);
      terms.add(split[2]);
    }
    const next = runs[i + 1]?.toLowerCase();
    if (next && /^[a-z]+$/.test(lower) && /^\d+$/.test(next)) terms.add(lower + next);
  }
  return terms;
}

/**
 * The query's terms -- the denominator of the published fraction, and so
 * deliberately the words the USER typed rather than an expanded set.
 *
 * Runs, not CamelCase pieces: `NoSuchHealthCheck` is one word from the
 * caller's point of view, and counting it as four would quietly reweight a
 * query toward whichever term happened to be written as an identifier.
 * Matching still understands the pieces -- see `queryTermMatches`.
 */
interface QueryTerm {
  /** Lowercased run, as published in `queryTerms`. */
  term: string;
  /**
   * The run's CamelCase pieces, derived from the ORIGINAL casing. Carried
   * alongside because `term` is already lowercased and a typed `GetObject`
   * would be unsplittable by then.
   */
  pieces: string[];
}

function queryTermList(query: string): QueryTerm[] {
  const runs = alnumRuns(query);
  const kept = runs.filter((r) => !RELEVANCE_STOPWORDS.has(r.toLowerCase()));
  // A query that is nothing but stopwords ("how do i") still needs a
  // denominator; fall back to every run rather than dividing by zero.
  const chosen = kept.length > 0 ? kept : runs;
  const seen = new Set<string>();
  const out: QueryTerm[] = [];
  for (const run of chosen) {
    const term = run.toLowerCase();
    if (seen.has(term)) continue;
    seen.add(term);
    out.push({ term, pieces: camelPieces(run) });
  }
  return out;
}

export function queryTerms(query: string): string[] {
  return queryTermList(query).map((t) => t.term);
}

/**
 * Is `term` present in a result's expanded term set?
 *
 * Beyond a literal hit, two allowances -- both for false negatives common
 * enough to distort the number:
 *   - English plural: "url" vs "URLs", "bucket" vs "buckets". Only a trailing
 *     -s, and only on terms long enough that stripping it is not destructive
 *     (so "aws" keeps its s). This is the ONLY normalization applied; no
 *     stemming, because stemming makes the number look better without making
 *     it truer, and a conservative under-count reads as "verify this yourself"
 *     where an over-count reads as "cite this".
 *   - A typed identifier counts as present when ALL of its CamelCase pieces
 *     are: a query for `NoSuchHealthCheck` matches a page spelling it "no such
 *     health check". All, not any -- matching on "check" alone would hand
 *     almost any AWS page a free point.
 */
function queryTermMatches(qt: QueryTerm, terms: ReadonlySet<string>): boolean {
  const has = (t: string): boolean =>
    terms.has(t) || terms.has(`${t}s`) || (t.length > 3 && t.endsWith("s") && terms.has(t.slice(0, -1)));
  if (has(qt.term)) return true;
  return qt.pieces.length > 1 && qt.pieces.every(has);
}

/** Per-result lexical overlap. `null` when the query had no scorable terms. */
export interface LexicalMatch {
  /** Fraction (0-1) of `queryTerms` found in this result's title/summary/excerpt. */
  overlap: number;
  matchedTerms: string[];
  unmatchedTerms: string[];
}

/** A search result plus its locally computed lexical signal. */
export interface ScoredSearchResult extends DocsSearchResult {
  lexicalMatch: LexicalMatch | null;
}

export interface SearchRelevance {
  /** The terms the fraction is computed against -- published so the number is auditable. */
  queryTerms: string[];
  /** Highest per-result overlap; null when the query had no scorable terms. */
  /** Query terms absent from EVERY result -- the backend having nothing. */
  termsMatchedNowhere?: string[];
  bestLexicalOverlap: number | null;
  lowRelevance: boolean;
  relevanceNote?: string;
  results: ScoredSearchResult[];
}

/**
 * Annotate a page of results with lexical overlap and decide whether the page
 * as a whole should be flagged as a non-answer.
 *
 * Only title, summary and excerpt are scored. The URL is deliberately left
 * out: every AWS docs URL contains docs/aws/amazon/com/latest, which would
 * hand a free match to any query mentioning those, and the slug itself
 * ("bucketnamingrules") is an unsegmentable run that scores nothing useful.
 */
export function scoreSearchResults(query: string, results: readonly DocsSearchResult[]): SearchRelevance {
  const queryTermObjs = queryTermList(query);
  const terms = queryTermObjs.map((t) => t.term);

  if (terms.length === 0) {
    // A query of pure punctuation. Reporting 0% here would assert "the backend
    // had nothing" when the truth is "this heuristic has no opinion" -- so it
    // asserts nothing instead.
    return {
      queryTerms: [],
      bestLexicalOverlap: null,
      lowRelevance: false,
      relevanceNote:
        "The query contained no comparable terms, so no lexical relevance signal was computed for these results.",
      results: results.map((r) => ({ ...r, lexicalMatch: null })),
    };
  }

  const scored: ScoredSearchResult[] = results.map((r) => {
    const found = docTerms([r.title, r.summary ?? "", r.excerpt ?? ""].join(" "));
    const matchedTerms = queryTermObjs.filter((t) => queryTermMatches(t, found)).map((t) => t.term);
    const unmatchedTerms = queryTermObjs.filter((t) => !queryTermMatches(t, found)).map((t) => t.term);
    return {
      // Spread first so every existing field is passed through untouched --
      // this signal is strictly additive to the result shape callers already
      // parse.
      ...r,
      lexicalMatch: {
        // 2dp: a coarse heuristic, and printing 0.3333333333333333 would imply
        // a precision it does not have.
        overlap: Math.round((matchedTerms.length / terms.length) * 100) / 100,
        matchedTerms,
        unmatchedTerms,
      },
    };
  });

  const best = scored.reduce((max, r) => Math.max(max, r.lexicalMatch?.overlap ?? 0), 0);

  // Terms no result matched ANYWHERE in the page. This is the strongest signal
  // available, and it is why `best` alone is not enough: best takes the MAX
  // across results, so one incidental hit speaks for the whole set. Measured
  // against the live backend, "zzzzqqq-nonexistent-service-xyzzy" scored
  // best = 0.5 because a single unrelated page happened to contain the ordinary
  // English words "nonexistent" and "service" -- while "zzzzqqq" and "xyzzy",
  // the terms that actually identify the query, matched nothing at all. A term
  // absent from every result is the backend saying it had nothing, in the one
  // form it can.
  const termsMatchedNowhere = terms.filter((t) => !scored.some((r) => r.lexicalMatch?.matchedTerms.includes(t)));

  // <= not <: the threshold is the boundary of "weak", so landing exactly on it
  // is weak. The gibberish query above sat at exactly 0.5 and escaped a `<`
  // test, which is the case this signal exists to catch.
  const lowRelevance = scored.length === 0 || best <= LOW_RELEVANCE_OVERLAP || termsMatchedNowhere.length > 0;

  let relevanceNote: string | undefined;
  if (scored.length === 0) {
    relevanceNote = "The search backend returned no results for this query.";
  } else if (lowRelevance) {
    relevanceNote =
      `No result matched more than ${Math.round(best * 100)}% of the query terms (${terms.join(", ")}). ` +
      (termsMatchedNowhere.length > 0
        ? `These terms appear in NO result at all: ${termsMatchedNowhere.join(", ")}. `
        : "") +
      "The AWS docs search backend always returns a full page of fuzzy matches and never reports 'no good match', " +
      "so a low overlap means the backend had nothing close for these terms -- not that this tool failed. Treat " +
      "these results as weak leads: re-query with different wording, or confirm with aws_docs_read before citing " +
      "any of them. This is literal word overlap, not semantic relevance, so a correct page that shares no " +
      "vocabulary with the query scores low too.";
  }

  return {
    queryTerms: terms,
    termsMatchedNowhere,
    bestLexicalOverlap: best,
    lowRelevance,
    ...(relevanceNote !== undefined ? { relevanceNote } : {}),
    results: scored,
  };
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
        "Search the live AWS documentation (the same backend that powers the docs.aws.amazon.com search box). Use this to discover the right doc page for a service, API, or concept the model may not know about -- new services, recently changed APIs, exact parameter names. Returns ranked results as {title, url, summary, excerpt}. IMPORTANT: that backend always returns a full page of fuzzy matches and has no way to answer 'no good match' -- a nonsense query still comes back with ten confident-looking hits. So each result also carries `lexicalMatch` ({overlap 0-1, matchedTerms, unmatchedTerms}), computed locally by this server: literal word overlap between your query's terms and the result's title/summary/excerpt, NOT a backend score and NOT semantic ranking. The response adds `queryTerms`, `termsMatchedNowhere`, `bestLexicalOverlap`, and `lowRelevance: true` when the best result matched at or under half your terms OR any term appears in no result at all (a term matching nothing anywhere is the clearest sign the backend had nothing -- one incidental hit on a common word can otherwise carry the average) -- that means the backend had nothing close for those terms, NOT that the search failed, so re-query with different wording rather than citing a weak hit. Follow up with aws_docs_read on a result's url to get the full page as markdown.",
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
        // Strictly additive: `count` and every pre-existing per-result field
        // are untouched, and result order is the backend's. See
        // scoreSearchResults for why the backend response on its own cannot
        // tell a caller whether any of this was actually a match.
        const relevance = scoreSearchResults(i.query, results);
        return {
          ok: true,
          data: {
            query: i.query,
            count: results.length,
            results: relevance.results,
            queryTerms: relevance.queryTerms,
            ...(relevance.termsMatchedNowhere !== undefined
              ? { termsMatchedNowhere: relevance.termsMatchedNowhere }
              : {}),
            bestLexicalOverlap: relevance.bestLexicalOverlap,
            lowRelevance: relevance.lowRelevance,
            ...(relevance.relevanceNote !== undefined ? { relevanceNote: relevance.relevanceNote } : {}),
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
