import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDocsTools,
  docsTools,
  extractMainContent,
  htmlToMarkdown,
  isValidDocsUrl,
  paginateContent,
  parseSearchResults,
} from "./docs.js";

const searchTool = docsTools.find((t) => t.name === "aws_docs_search");
const readTool = docsTools.find((t) => t.name === "aws_docs_read");
if (!searchTool || !readTool) throw new Error("docsTools missing aws_docs_search / aws_docs_read");

/** Build a Response-like object good enough for the handlers under test. */
function fakeResponse(opts: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  json?: unknown;
  text?: string;
  contentType?: string;
  textThrows?: boolean;
}): Response {
  const contentType = opts.contentType ?? "text/html; charset=utf-8";
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    statusText: opts.statusText ?? "OK",
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-type" ? contentType : null),
    },
    json: async () => {
      if (opts.json === undefined) throw new Error("no json body");
      return opts.json;
    },
    text: async () => {
      if (opts.textThrows) throw new Error("stream error");
      return opts.text ?? "";
    },
  } as unknown as Response;
}

/** A fetch impl that aborts -- mimics AbortController firing the timeout. */
const abortingFetch = (async (_url: string, init: RequestInit) => {
  if (init.signal?.aborted) {
    const e = new Error("This operation was aborted");
    e.name = "AbortError";
    throw e;
  }
  // Simulate the timeout firing: the AbortController in fetchWithTimeout
  // calls abort() after FETCH_TIMEOUT_MS; reproduce that synchronously by
  // throwing an AbortError-named error.
  const e = new Error("This operation was aborted");
  e.name = "AbortError";
  throw e;
}) as unknown as typeof fetch;

describe("parseSearchResults", () => {
  it("flattens textExcerptSuggestion entries", () => {
    const json = {
      queryId: "abc",
      suggestions: [
        {
          textExcerptSuggestion: {
            link: "https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html",
            title: "General purpose bucket naming rules",
            summary: "Learn about the rules.",
            suggestionBody: "The following naming rules apply.",
          },
        },
      ],
    };
    const out = parseSearchResults(json, 10);
    assert.equal(out.length, 1);
    assert.equal(out[0].url, "https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html");
    assert.equal(out[0].title, "General purpose bucket naming rules");
    assert.equal(out[0].summary, "Learn about the rules.");
    assert.equal(out[0].excerpt, "The following naming rules apply.");
  });

  it("drops suggestions with no link", () => {
    const json = {
      suggestions: [
        { textExcerptSuggestion: { title: "no link here" } },
        { textExcerptSuggestion: { link: "https://docs.aws.amazon.com/x.html", title: "kept" } },
      ],
    };
    const out = parseSearchResults(json, 10);
    assert.equal(out.length, 1);
    assert.equal(out[0].title, "kept");
  });

  it("respects the limit", () => {
    const json = {
      suggestions: Array.from({ length: 20 }, (_, i) => ({
        textExcerptSuggestion: { link: `https://docs.aws.amazon.com/page-${i}.html`, title: `Page ${i}` },
      })),
    };
    assert.equal(parseSearchResults(json, 5).length, 5);
  });

  it("returns [] for malformed input", () => {
    assert.deepEqual(parseSearchResults(null, 10), []);
    assert.deepEqual(parseSearchResults({}, 10), []);
    assert.deepEqual(parseSearchResults({ suggestions: "nope" }, 10), []);
  });

  it("falls back to url as title when title is missing", () => {
    const out = parseSearchResults(
      { suggestions: [{ textExcerptSuggestion: { link: "https://docs.aws.amazon.com/x.html" } }] },
      10,
    );
    assert.equal(out[0].title, "https://docs.aws.amazon.com/x.html");
  });
});

describe("isValidDocsUrl", () => {
  it("accepts an https docs.aws.amazon.com .html page", () => {
    assert.equal(isValidDocsUrl("https://docs.aws.amazon.com/lambda/latest/dg/welcome.html"), true);
  });

  it("accepts a .html page with query string or fragment", () => {
    assert.equal(isValidDocsUrl("https://docs.aws.amazon.com/x.html?foo=bar"), true);
    assert.equal(isValidDocsUrl("https://docs.aws.amazon.com/x.html#section"), true);
  });

  it("rejects non-docs hosts", () => {
    assert.equal(isValidDocsUrl("https://example.com/x.html"), false);
    assert.equal(isValidDocsUrl("https://aws.amazon.com/x.html"), false);
  });

  it("rejects non-.html paths", () => {
    assert.equal(isValidDocsUrl("https://docs.aws.amazon.com/lambda/latest/dg/"), false);
    assert.equal(isValidDocsUrl("https://docs.aws.amazon.com/asset.pdf"), false);
  });

  it("rejects http (non-TLS)", () => {
    assert.equal(isValidDocsUrl("http://docs.aws.amazon.com/x.html"), false);
  });
});

describe("extractMainContent", () => {
  it("prefers #awsdocs-content", () => {
    const html = `<html><body><nav>NAV</nav><div id="awsdocs-content"><p>real content</p></div></body></html>`;
    const out = extractMainContent(html);
    assert.match(out, /real content/);
    assert.doesNotMatch(out, /NAV/);
  });

  it("strips script/style/nav/footer", () => {
    const html = `<html><body><main><script>evil()</script><style>.x{}</style><p>keep</p><footer>FOOT</footer></main></body></html>`;
    const out = extractMainContent(html);
    assert.match(out, /keep/);
    assert.doesNotMatch(out, /evil/);
    assert.doesNotMatch(out, /FOOT/);
  });

  it("falls back to body when no known container matches", () => {
    const html = `<html><body><div class="weird"><p>still here</p></div></body></html>`;
    const out = extractMainContent(html);
    assert.match(out, /still here/);
  });
});

describe("htmlToMarkdown", () => {
  it("converts headings and paragraphs", () => {
    const html = `<html><body><main><h1>Title</h1><p>Some <strong>bold</strong> text.</p></main></body></html>`;
    const md = htmlToMarkdown(html);
    assert.match(md, /# Title/);
    assert.match(md, /\*\*bold\*\*/);
  });

  it("converts links", () => {
    const html = `<html><body><main><p><a href="https://x.com">link text</a></p></main></body></html>`;
    const md = htmlToMarkdown(html);
    assert.match(md, /\[link text\]\(https:\/\/x\.com\)/);
  });

  it("drops empty-text anchors, even when the URL contains parens", () => {
    // AWS doc chrome (PDF-download buttons) renders as <a> with no text. The
    // turndown rule must drop these without choking on a `)` in the href.
    const html = `<html><body><main><p>keep this</p><a href="/pdfs/lambda-dg.pdf#x(y)" title="Open PDF"></a></main></body></html>`;
    const md = htmlToMarkdown(html);
    assert.match(md, /keep this/);
    assert.doesNotMatch(md, /\]\(/);
    assert.doesNotMatch(md, /lambda-dg\.pdf/);
  });

  it("keeps an anchor that wraps an image", () => {
    const html = `<html><body><main><a href="/diagram.html"><img src="/arch.png" alt="architecture"></a></main></body></html>`;
    const md = htmlToMarkdown(html);
    assert.match(md, /diagram\.html/);
  });
});

describe("paginateContent", () => {
  it("returns the full content when it fits", () => {
    const p = paginateContent("hello world", 0, 100);
    assert.equal(p.content, "hello world");
    assert.equal(p.hasMore, false);
    assert.equal(p.nextStartIndex, null);
  });

  it("slices and reports hasMore + nextStartIndex", () => {
    const p = paginateContent("0123456789", 0, 4);
    assert.equal(p.content, "0123");
    assert.equal(p.hasMore, true);
    assert.equal(p.nextStartIndex, 4);
    assert.equal(p.totalLength, 10);
  });

  it("resumes from a startIndex", () => {
    const p = paginateContent("0123456789", 4, 4);
    assert.equal(p.content, "4567");
    assert.equal(p.hasMore, true);
    assert.equal(p.nextStartIndex, 8);
  });

  it("clamps an out-of-range startIndex to the end", () => {
    const p = paginateContent("short", 999, 100);
    assert.equal(p.content, "");
    assert.equal(p.hasMore, false);
    assert.equal(p.startIndex, 5);
  });
});

describe("aws_docs_search handler", () => {
  it("posts the query and returns parsed results", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    const fetchImpl = (async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedBody = init.body as string;
      return fakeResponse({
        json: {
          suggestions: [
            {
              textExcerptSuggestion: {
                link: "https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html",
                title: "Bucket naming rules",
                summary: "rules",
              },
            },
          ],
        },
      });
    }) as unknown as typeof fetch;
    const [search] = buildDocsTools(fetchImpl);
    const r = await search.handler({ query: "S3 bucket naming" });
    assert.equal(r.ok, true);
    const data = r.data as { count: number; results: { url: string }[] };
    assert.equal(data.count, 1);
    assert.match(data.results[0].url, /bucketnamingrules\.html/);
    assert.match(capturedUrl, /proxy\.search\.docs\.aws\.com\/search\?session=/);
    assert.match(capturedBody, /"S3 bucket naming"/);
  });

  it("surfaces an HTTP error from the search backend", async () => {
    const fetchImpl = (async () =>
      fakeResponse({ ok: false, status: 503, statusText: "Service Unavailable" })) as unknown as typeof fetch;
    const [search] = buildDocsTools(fetchImpl);
    const r = await search.handler({ query: "x" });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /503/);
  });

  it("surfaces a network failure", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const [search] = buildDocsTools(fetchImpl);
    const r = await search.handler({ query: "x" });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /ECONNREFUSED/);
  });

  it("reports a timeout distinctly from a generic failure", async () => {
    const [search] = buildDocsTools(abortingFetch);
    const r = await search.handler({ query: "x" });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /timed out/);
  });
});

describe("aws_docs_read handler", () => {
  it("rejects a non-docs URL before fetching", async () => {
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      return fakeResponse({ text: "" });
    }) as unknown as typeof fetch;
    const [, read] = buildDocsTools(fetchImpl);
    const r = await read.handler({ url: "https://example.com/evil.html" });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Invalid url/);
    assert.equal(fetched, false);
  });

  it("fetches, converts to markdown, and paginates", async () => {
    const html = `<html><body><main><h1>Lambda</h1><p>${"x".repeat(200)}</p></main></body></html>`;
    const fetchImpl = (async () => fakeResponse({ text: html })) as unknown as typeof fetch;
    const [, read] = buildDocsTools(fetchImpl);
    const r = await read.handler({
      url: "https://docs.aws.amazon.com/lambda/latest/dg/welcome.html",
      maxLength: 20,
    });
    assert.equal(r.ok, true);
    const data = r.data as { content: string; hasMore: boolean; totalLength: number };
    assert.equal(data.content.length, 20);
    assert.equal(data.hasMore, true);
    assert.ok(data.totalLength > 20);
  });

  it("surfaces an HTTP error from the doc page fetch", async () => {
    const fetchImpl = (async () =>
      fakeResponse({ ok: false, status: 404, statusText: "Not Found" })) as unknown as typeof fetch;
    const [, read] = buildDocsTools(fetchImpl);
    const r = await read.handler({ url: "https://docs.aws.amazon.com/missing.html" });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /404/);
  });

  it("rejects a 200 response that isn't text/html", async () => {
    // A docs URL can redirect to a login wall or error page that 200s with
    // JSON or plain text -- feeding that to the HTML parser is junk.
    const fetchImpl = (async () =>
      fakeResponse({ contentType: "application/json", text: '{"error":"auth required"}' })) as unknown as typeof fetch;
    const [, read] = buildDocsTools(fetchImpl);
    const r = await read.handler({ url: "https://docs.aws.amazon.com/protected.html" });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /content-type/);
    assert.match(r.error ?? "", /application\/json/);
  });

  it("surfaces a body-stream read failure", async () => {
    const fetchImpl = (async () => fakeResponse({ textThrows: true })) as unknown as typeof fetch;
    const [, read] = buildDocsTools(fetchImpl);
    const r = await read.handler({ url: "https://docs.aws.amazon.com/x.html" });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /response body/);
  });

  it("reports a fetch timeout distinctly", async () => {
    const [, read] = buildDocsTools(abortingFetch);
    const r = await read.handler({ url: "https://docs.aws.amazon.com/x.html" });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /timed out/);
  });

  it("caches the converted page: a second read of the same URL does not re-fetch", async () => {
    let fetchCount = 0;
    const html = `<html><body><main><h1>Lambda</h1><p>${"y".repeat(300)}</p></main></body></html>`;
    const fetchImpl = (async () => {
      fetchCount++;
      return fakeResponse({ text: html });
    }) as unknown as typeof fetch;
    const [, read] = buildDocsTools(fetchImpl);
    const url = "https://docs.aws.amazon.com/lambda/latest/dg/welcome.html";

    const first = await read.handler({ url, startIndex: 0, maxLength: 50 });
    assert.equal(first.ok, true);
    assert.equal((first.data as { cached: boolean }).cached, false);

    const second = await read.handler({ url, startIndex: 50, maxLength: 50 });
    assert.equal(second.ok, true);
    assert.equal((second.data as { cached: boolean }).cached, true);

    // One fetch served both windows.
    assert.equal(fetchCount, 1);
    // The second window is a real slice, not a repeat of the first.
    assert.notEqual((first.data as { content: string }).content, (second.data as { content: string }).content);
  });

  it("scopes the cache per buildDocsTools instance", async () => {
    let fetchCount = 0;
    const fetchImpl = (async () => {
      fetchCount++;
      return fakeResponse({ text: "<html><body><main><p>doc</p></main></body></html>" });
    }) as unknown as typeof fetch;
    const url = "https://docs.aws.amazon.com/x.html";
    const [, readA] = buildDocsTools(fetchImpl);
    const [, readB] = buildDocsTools(fetchImpl);
    await readA.handler({ url });
    await readB.handler({ url });
    // Separate instances => separate caches => two fetches.
    assert.equal(fetchCount, 2);
  });
});

describe("aws_docs_* schema", () => {
  it("search rejects an empty query", () => {
    assert.equal(searchTool.inputSchema.safeParse({ query: "" }).success, false);
  });

  it("search rejects limit above the cap", () => {
    assert.equal(searchTool.inputSchema.safeParse({ query: "x", limit: 999 }).success, false);
  });

  it("read rejects maxLength above the cap", () => {
    assert.equal(
      readTool.inputSchema.safeParse({ url: "https://docs.aws.amazon.com/x.html", maxLength: 9_999_999 }).success,
      false,
    );
  });

  it("read rejects a negative startIndex", () => {
    assert.equal(
      readTool.inputSchema.safeParse({ url: "https://docs.aws.amazon.com/x.html", startIndex: -1 }).success,
      false,
    );
  });
});
