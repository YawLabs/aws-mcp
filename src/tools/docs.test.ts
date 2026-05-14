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
}): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    statusText: opts.statusText ?? "OK",
    json: async () => {
      if (opts.json === undefined) throw new Error("no json body");
      return opts.json;
    },
    text: async () => opts.text ?? "",
  } as unknown as Response;
}

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
