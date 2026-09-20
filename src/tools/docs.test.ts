import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";
import {
  CLI_S3API_INDEX_HTML,
  JSV3_SHELL_HTML,
  LAMBDA_LANDING_STUB_HTML,
  POWERTOOLS_PAGE_HTML,
  SWIFT_SHELL_HTML,
} from "../testing/docs-fixtures.js";
import {
  _resetParseSearchSchemaWarn,
  buildDocsTools,
  classifyFinalDocsUrl,
  DOC_CACHE_MAX_ENTRIES,
  describeFetchFailure,
  detectUnrenderablePage,
  docsTools,
  docTerms,
  extractMainContent,
  type FetchEnvFacts,
  htmlToMarkdown,
  isValidDocsUrl,
  LOW_RELEVANCE_OVERLAP,
  makeDocCache,
  paginateContent,
  parseSearchResults,
  queryTerms,
  resolveDocsLink,
  scoreSearchResults,
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
  contentLength?: string;
  textThrows?: boolean;
  url?: string;
  bodyChunks?: Array<string | Uint8Array>;
}): Response {
  const contentType = opts.contentType ?? "text/html; charset=utf-8";
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    statusText: opts.statusText ?? "OK",
    // Absent unless a case opts in, so the existing fixtures keep exercising
    // the "no redirect information" fallback to the requested URL.
    ...(opts.url !== undefined ? { url: opts.url } : {}),
    // A streaming body only when a case asks for one; otherwise the handler
    // takes the text() path, like every pre-existing fixture here.
    ...(opts.bodyChunks !== undefined
      ? {
          body: {
            getReader: () => {
              const encoder = new TextEncoder();
              const chunks = opts.bodyChunks as Array<string | Uint8Array>;
              let n = 0;
              return {
                read: async () => {
                  if (n >= chunks.length) return { done: true, value: undefined };
                  const chunk = chunks[n++];
                  return { done: false, value: typeof chunk === "string" ? encoder.encode(chunk) : chunk };
                },
                cancel: async () => {},
              };
            },
          },
        }
      : {}),
    headers: {
      get: (name: string) => {
        const key = name.toLowerCase();
        if (key === "content-type") return contentType;
        if (key === "content-length") return opts.contentLength ?? null;
        return null;
      },
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
    // The `{ suggestions: "nope" }` case below intentionally trips the
    // schema-drift codepath, which writes to console.warn AND flips the
    // module-level `schemaWarned` flag. Stub stderr for the duration of
    // the call and reset the flag after so other tests in this module see
    // a clean baseline. Without this, every test run printed the
    // schema-drift warning, and `schemaWarned=true` would block the
    // dedicated schema-drift tests below from observing their own warn.
    assert.deepEqual(parseSearchResults(null, 10), []);
    assert.deepEqual(parseSearchResults({}, 10), []);
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      assert.deepEqual(parseSearchResults({ suggestions: "nope" }, 10), []);
    } finally {
      console.warn = originalWarn;
      _resetParseSearchSchemaWarn();
    }
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

  it("rejects a URL with embedded whitespace before .html", () => {
    // The `[^\s]*` clause in DOCS_URL_RE forbids whitespace anywhere in the
    // path. A space (or tab) smuggled in ahead of the .html suffix must fail
    // -- this is the guard that keeps a crafted "...foo .html" from slipping
    // past the allowlist into a fetch.
    assert.equal(isValidDocsUrl("https://docs.aws.amazon.com/foo bar.html"), false);
    assert.equal(isValidDocsUrl("https://docs.aws.amazon.com/foo\tbar.html"), false);
  });

  it("rejects double-extension / trailing-junk after .html", () => {
    // The regex anchors `.html` to end-of-string (or a `?`/`#` boundary), so
    // `...x.html.evil` and `...x.htmlx` are NOT valid .html pages -- the
    // anchored allowlist must reject anything trailing the .html suffix.
    assert.equal(isValidDocsUrl("https://docs.aws.amazon.com/x.html.evil"), false);
    assert.equal(isValidDocsUrl("https://docs.aws.amazon.com/x.htmlx"), false);
  });
});

describe("classifyFinalDocsUrl", () => {
  const D = "https://docs.aws.amazon.com";

  it("accepts a page that landed on a page", () => {
    assert.equal(
      classifyFinalDocsUrl(`${D}/AmazonS3/latest/dev/Welcome.html`, `${D}/AmazonS3/latest/userguide/Welcome.html`),
      "page",
      "a real move 301s .html -> .html and must stay readable",
    );
  });

  it("accepts the directory form of the index.html that was requested", () => {
    // The regression: docs.aws.amazon.com answers every <path>/index.html with a
    // 301 to <path>/, and one in six search results is such a URL.
    assert.equal(
      classifyFinalDocsUrl(`${D}/cli/latest/reference/s3api/index.html`, `${D}/cli/latest/reference/s3api/`),
      "page",
    );
    assert.equal(
      classifyFinalDocsUrl(
        `${D}/powertools/typescript/latest/environment-variables/index.html`,
        `${D}/powertools/typescript/latest/environment-variables/`,
      ),
      "page",
    );
  });

  it("compares the index.html form case-insensitively", () => {
    assert.equal(classifyFinalDocsUrl(`${D}/X/Index.HTML`, `${D}/X/`), "page");
  });

  it("calls a page that landed on some other directory a soft 404", () => {
    // Not a 404: the site 302s a missing page to the guide's landing page, and a
    // missing CLI command to that service's command index.
    assert.equal(classifyFinalDocsUrl(`${D}/lambda/latest/dg/no-such.html`, `${D}/lambda/latest/dg/`), "soft_404");
    assert.equal(
      classifyFinalDocsUrl(`${D}/cli/latest/reference/s3api/no-such-cmd.html`, `${D}/cli/latest/reference/s3api/`),
      "soft_404",
    );
  });

  it("lets a directory request land on any docs directory", () => {
    // A directory was never a claim about a particular page, so a directory
    // landing cannot be "that page does not exist". (Directory input arrives in
    // 2.4.0; the classifier is written for it now so it cannot mis-report then.)
    assert.equal(classifyFinalDocsUrl(`${D}/lambda/latest/dg/`, `${D}/lambda/latest/dg/`), "page");
    assert.equal(classifyFinalDocsUrl(`${D}/a/`, `${D}/b/`), "page");
  });

  it("accepts an explicit default port and rejects any other", () => {
    assert.equal(classifyFinalDocsUrl(`${D}/x.html`, "https://docs.aws.amazon.com:443/x.html"), "page");
    assert.equal(classifyFinalDocsUrl(`${D}/x.html`, "https://docs.aws.amazon.com:8443/x.html"), "off_allowlist");
  });

  it("keeps every 2.0.0 rejection", () => {
    for (const final of [
      "https://evil.example.com/landing.html",
      "http://docs.aws.amazon.com/x.html",
      "https://user:pass@docs.aws.amazon.com/x.html",
      "https://docs.aws.amazon.com./x.html",
      "https://docs.aws.amazon.com.evil.com/x.html",
      `${D}/asset.pdf`,
      "not a url at all",
    ]) {
      assert.equal(classifyFinalDocsUrl(`${D}/x.html`, final), "off_allowlist", final);
    }
  });

  it("refuses a directory landing it cannot compare the request against", () => {
    // An unparseable request URL fails closed rather than accepting the landing.
    assert.equal(classifyFinalDocsUrl("not a url", `${D}/lambda/latest/dg/`), "off_allowlist");
  });
});

describe("resolveDocsLink", () => {
  const BASE = "https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html";

  it("makes a relative docs .md target absolute and points it at the .html twin", () => {
    // .html is the form aws_docs_read accepts, so the URL it returns is one a
    // caller can pass straight back in.
    assert.equal(
      resolveDocsLink("create-bucket-overview.md", BASE),
      "https://docs.aws.amazon.com/AmazonS3/latest/userguide/create-bucket-overview.html",
    );
  });

  it("keeps a fragment and resolves a parent-relative target against a directory base", () => {
    // The real link out of the s3api command index, whose base IS a directory:
    // `../` off `/cli/latest/reference/s3api/` is the CLI reference root.
    assert.equal(
      resolveDocsLink("../index.html#cli-aws", "https://docs.aws.amazon.com/cli/latest/reference/s3api/"),
      "https://docs.aws.amazon.com/cli/latest/reference/index.html#cli-aws",
    );
  });

  it("leaves a fragment-only link, an empty target and a non-http scheme alone", () => {
    assert.equal(resolveDocsLink("#frag", BASE), "#frag");
    assert.equal(resolveDocsLink("", BASE), "");
    assert.equal(resolveDocsLink("mailto:aws@example.com", BASE), "mailto:aws@example.com");
    assert.equal(resolveDocsLink("javascript:void(0)", BASE), "javascript:void(0)");
  });

  it("does not rewrite .md on another host", () => {
    assert.equal(resolveDocsLink("https://example.com/readme.md", BASE), "https://example.com/readme.md");
  });
});

describe("detectUnrenderablePage", () => {
  const LAMBDA_DG = "https://docs.aws.amazon.com/lambda/latest/dg/";

  it("names the page a meta-refresh stub forwards to, as an absolute URL", () => {
    const md = htmlToMarkdown(LAMBDA_LANDING_STUB_HTML);
    const reason = detectUnrenderablePage(
      LAMBDA_LANDING_STUB_HTML,
      md,
      "https://docs.aws.amazon.com/lambda/latest/dg/index.html",
      LAMBDA_DG,
    );
    assert.match(reason ?? "", /only forwards the browser/);
    assert.match(reason ?? "", /https:\/\/docs\.aws\.amazon\.com\/lambda\/latest\/dg\/welcome\.html/);
  });

  it("resolves the refresh target against the FINAL url, not the requested one", () => {
    // A page that moved guides lands in the new directory, and the stub's
    // `URL=welcome.html` means THAT directory's welcome page. Resolving against
    // the requested URL would name a page in the old, dead guide.
    const reason = detectUnrenderablePage(
      LAMBDA_LANDING_STUB_HTML,
      "",
      "https://docs.aws.amazon.com/AmazonS3/latest/dev/Foo.html",
      "https://docs.aws.amazon.com/AmazonS3/latest/userguide/",
    );
    assert.match(reason ?? "", /AmazonS3\/latest\/userguide\/welcome\.html/);
    // The requested URL is still echoed, but no target in the message points
    // back into the guide that moved.
    assert.doesNotMatch(reason ?? "", /forwards the browser to '[^']*latest\/dev\//);
    assert.doesNotMatch(reason ?? "", /aws_docs_read on '[^']*latest\/dev\//);
  });

  it("does not offer a target the read tool would refuse", () => {
    const html = '<html><head><meta http-equiv="refresh" content="0;URL=https://example.com/elsewhere"></head></html>';
    const reason = detectUnrenderablePage(html, "", "https://docs.aws.amazon.com/x.html", LAMBDA_DG);
    assert.match(reason ?? "", /not a readable AWS documentation page/);
    assert.doesNotMatch(reason ?? "", /example\.com/);
  });

  it("explains a client-rendered shell, for both shapes that produce one", () => {
    for (const html of [JSV3_SHELL_HTML, SWIFT_SHELL_HTML]) {
      const reason = detectUnrenderablePage(
        html,
        htmlToMarkdown(html),
        "https://docs.aws.amazon.com/x.html",
        LAMBDA_DG,
      );
      assert.match(reason ?? "", /rendered in the browser by JavaScript/);
    }
  });

  it("leaves a short real page alone", () => {
    // No marker, so length alone never triggers it.
    const md = "x".repeat(150);
    assert.equal(detectUnrenderablePage("<html><body><main>short</main></body></html>", md, "u", "u"), null);
  });

  it("leaves a long page alone even when it carries a marker", () => {
    // The length gate runs first: a real page that happens to ship a Next.js
    // asset must not be refused.
    const html = `<html><body><main><p>${"x".repeat(5000)}</p><script src="/_next/static/x.js"></script></main></body></html>`;
    assert.equal(detectUnrenderablePage(html, htmlToMarkdown(html), "u", "u"), null);
  });

  it("measures the text, not the link syntax", () => {
    // The JS v3 shell's whole conversion is `[Skip to main content](#main)`: 29
    // characters of markdown, 20 of text. Counting the markdown would let a
    // shell whose skip-link URL is long enough pass as content.
    const md = htmlToMarkdown(JSV3_SHELL_HTML);
    assert.equal(md, "[Skip to main content](#main)");
    assert.ok(md.length > 20, "precondition: the link syntax inflates the raw length");
  });
});

describe("describeFetchFailure", () => {
  const NO_PROXY_ENV: FetchEnvFacts = { proxyUrl: null, envProxyEnabled: false, oamVersion: null };
  /** The shape Node's fetch really rejects with: the verdict lives in .cause. */
  const fetchFailed = (message: string, code?: string): unknown =>
    Object.assign(new TypeError("fetch failed"), {
      cause: code === undefined ? new Error(message) : Object.assign(new Error(message), { code }),
    });
  /** The shape the AbortController timeout produces: a DOMException, no cause. */
  const aborted = (): unknown => Object.assign(new Error("This operation was aborted"), { name: "AbortError" });

  it("gives an untrusted certificate chain the private-CA remedy", () => {
    // Reproduced on Node 22.22.2 against a local self-signed server: cause
    // message "self-signed certificate", cause code DEPTH_ZERO_SELF_SIGNED_CERT.
    const s = describeFetchFailure(fetchFailed("self-signed certificate", "DEPTH_ZERO_SELF_SIGNED_CERT"), NO_PROXY_ENV);
    assert.match(s, /self-signed certificate \(DEPTH_ZERO_SELF_SIGNED_CERT\)/);
    assert.match(s, /TLS-inspecting gateway or a private CA/);
    assert.match(s, /NODE_EXTRA_CA_CERTS/);
    assert.match(s, /NODE_USE_SYSTEM_CA=1/);
    assert.match(s, /MCP-config `env` block/, "the variables are read at process start, not from the user's shell");
  });

  it("gives the same remedy to the sibling chain verdicts", () => {
    for (const code of [
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "CERT_UNTRUSTED",
    ]) {
      assert.match(
        describeFetchFailure(fetchFailed("unable to verify", code), NO_PROXY_ENV),
        /NODE_EXTRA_CA_CERTS/,
        code,
      );
    }
  });

  it("does not offer a CA to a verdict a CA cannot fix", () => {
    // An expired certificate or a hostname mismatch is a real failure with a
    // different cause; adding a CA would not change either.
    const s = describeFetchFailure(fetchFailed("certificate has expired", "CERT_HAS_EXPIRED"), NO_PROXY_ENV);
    assert.match(s, /certificate has expired \(CERT_HAS_EXPIRED\)/);
    assert.doesNotMatch(s, /NODE_EXTRA_CA_CERTS/);
  });

  it("explains an uncoded transport failure under the oam runtime", () => {
    // Measured on oam 0.16.2 against the same self-signed server: the identical
    // condition Node codes as DEPTH_ZERO_SELF_SIGNED_CERT arrives with no code.
    const s = describeFetchFailure(fetchFailed("error sending request for url (https://docs.aws.amazon.com/x.html)"), {
      ...NO_PROXY_ENV,
      envProxyEnabled: true,
      oamVersion: "0.16.2",
    });
    assert.match(s, /oam runtime, which reports no failure code/);
    assert.match(s, /NODE_EXTRA_CA_CERTS/);
    assert.match(s, /HTTPS_PROXY/, "an unreachable proxy looks the same under oam");
  });

  it("says when Node is ignoring the HTTPS_PROXY that is set", () => {
    // Verified on Node 22.22.2: with HTTPS_PROXY pointing at a dead port and
    // NODE_USE_ENV_PROXY unset, the request went direct and returned 200 -- so
    // on a proxy-only network it fails while the aws CLI, which reads
    // HTTPS_PROXY itself, keeps working.
    const s = describeFetchFailure(fetchFailed("connect ECONNREFUSED 10.1.2.3:443", "ECONNREFUSED"), {
      proxyUrl: "http://proxy.corp.example:3128",
      envProxyEnabled: false,
      oamVersion: null,
    });
    assert.match(s, /HTTPS_PROXY is set to 'http:\/\/proxy\.corp\.example:3128'/);
    assert.match(s, /NODE_USE_ENV_PROXY=1/);
    assert.match(s, /aws CLI/);
  });

  it("gives the ignored-proxy hint to a timeout too, which has no cause at all", () => {
    // On a proxy-only network the likelier symptom is nothing answering until
    // our own 30s abort, so the hint has to reach that branch as well.
    const s = describeFetchFailure(aborted(), {
      proxyUrl: "http://proxy.corp.example:3128",
      envProxyEnabled: false,
      oamVersion: null,
    });
    assert.match(s, /NODE_USE_ENV_PROXY=1/);
    assert.doesNotMatch(s, /Underlying failure/, "there is no cause on an abort -- do not invent one");
  });

  it("blames the proxy, not AWS, when the proxy is the one being used", () => {
    const s = describeFetchFailure(fetchFailed("connect ECONNREFUSED 127.0.0.1:3128", "ECONNREFUSED"), {
      proxyUrl: "http://127.0.0.1:3128",
      envProxyEnabled: true,
      oamVersion: null,
    });
    assert.match(s, /that proxy, not docs\.aws\.amazon\.com, that did not answer/);
    assert.doesNotMatch(s, /NODE_USE_ENV_PROXY/);
  });

  it("redacts credentials out of the proxy URL and the cause message", () => {
    const s = describeFetchFailure(
      fetchFailed("connect ECONNREFUSED http://bob:hunter2@proxy.corp.example:3128", "ECONNREFUSED"),
      { proxyUrl: "http://bob:hunter2@proxy.corp.example:3128", envProxyEnabled: false, oamVersion: null },
    );
    assert.doesNotMatch(s, /hunter2/);
    assert.match(s, /\/\/<redacted>@proxy\.corp\.example:3128/);
  });

  it("ignores a code that is not a non-empty string", () => {
    // libuv errnos are numbers; printing one would put a bare "0" in the message.
    const numeric = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("write EPIPE"), { code: 0 }),
    });
    const s = describeFetchFailure(numeric, NO_PROXY_ENV);
    assert.match(s, /Underlying failure: write EPIPE\./);
    assert.doesNotMatch(s, /\(0\)/);
  });

  it("adds nothing when there is nothing to add", () => {
    assert.equal(describeFetchFailure(new Error("plain failure"), NO_PROXY_ENV), "");
    assert.equal(describeFetchFailure(aborted(), NO_PROXY_ENV), "");
    assert.equal(describeFetchFailure("a string, not an error", NO_PROXY_ENV), "");
    assert.equal(describeFetchFailure(Object.assign(new TypeError("fetch failed"), { cause: null }), NO_PROXY_ENV), "");
  });

  it("reports an unrecognized cause without pretending to have a remedy", () => {
    const s = describeFetchFailure(fetchFailed("socket hang up", "UND_ERR_SOCKET"), NO_PROXY_ENV);
    assert.equal(s, " Underlying failure: socket hang up (UND_ERR_SOCKET).");
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

  it("surfaces the CAUSE of a network failure, and stops blaming the backend for it", async () => {
    // The shape Node's fetch really produces: a bare `TypeError: fetch failed`
    // with the verdict in err.cause. The old double here threw
    // `new Error("ECONNREFUSED")` -- a shape fetch never produces -- so the
    // suite passed while the handler reported nothing a reader could act on.
    const fetchImpl = (async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
      });
    }) as unknown as typeof fetch;
    const [search] = buildDocsTools(fetchImpl);
    const r = await search.handler({ query: "x" });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /self-signed certificate \(DEPTH_ZERO_SELF_SIGNED_CERT\)/);
    assert.match(r.error ?? "", /NODE_EXTRA_CA_CERTS/);
    // The request never reached proxy.search.docs.aws.com, so the undocumented
    // backend cannot be what went wrong.
    assert.doesNotMatch(r.error ?? "", /may have changed/);
  });

  it("keeps the undocumented-backend sentence when the failure has no cause to read", async () => {
    const fetchImpl = (async () => {
      throw new Error("something odd");
    }) as unknown as typeof fetch;
    const [search] = buildDocsTools(fetchImpl);
    const r = await search.handler({ query: "x" });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /something odd/);
    assert.match(r.error ?? "", /undocumented and may have changed/);
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

  it("rejects a 200 response with an ABSENT content-type header (-> 'unknown')", async () => {
    // When the response carries no content-type header at all, the handler's
    // `?? ""` -> empty string -> the `|| "unknown"` fallback in the error
    // message fires. Stub fetch to return a 200 whose headers.get always
    // yields null (no content-type present).
    const fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => null },
        json: async () => ({}),
        text: async () => "<html></html>",
      }) as unknown as Response) as unknown as typeof fetch;
    const [, read] = buildDocsTools(fetchImpl);
    const r = await read.handler({ url: "https://docs.aws.amazon.com/x.html" });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /content-type/);
    assert.match(r.error ?? "", /unknown/);
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

  it("rejects an over-size page from Content-Length without downloading it", async () => {
    // The 30s fetch timeout bounds LATENCY, not SIZE. A declared length over
    // the 5MB cap must bounce before any body read happens -- `textThrows`
    // makes that provable: if the handler touched the body we would get the
    // body-read error instead of the size one.
    const fetchImpl = (async () =>
      fakeResponse({ contentLength: String(6 * 1024 * 1024), textThrows: true })) as unknown as typeof fetch;
    const [, read] = buildDocsTools(fetchImpl);
    const r = await read.handler({ url: "https://docs.aws.amazon.com/huge.html" });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /more than 5 MB of HTML/);
    assert.match(r.error ?? "", /content-length 6291456 bytes/);
    assert.doesNotMatch(r.error ?? "", /response body/, "must not read a body it already knows is too large");
  });

  it("stops a streaming body once it crosses the cap", async () => {
    // No Content-Length (chunked): the cap has to be enforced mid-stream, and
    // the bytes past it are never buffered or converted.
    const oneMb = "y".repeat(1024 * 1024);
    const fetchImpl = (async () =>
      fakeResponse({ bodyChunks: Array.from({ length: 8 }, () => oneMb) })) as unknown as typeof fetch;
    const [, read] = buildDocsTools(fetchImpl);
    const r = await read.handler({ url: "https://docs.aws.amazon.com/streamed.html" });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /more than 5 MB of HTML/);
    assert.doesNotMatch(r.error ?? "", /content-length/, "size learned mid-stream, not from a header");
  });

  it("reads a normal page through the streaming path unchanged", async () => {
    // The cap must not disturb the ordinary case: chunked HTML, split so a
    // multi-byte character straddles a chunk boundary, still converts.
    const utf8 = new TextEncoder().encode("<html><body><main><h1>Café</h1><p>ok</p></main></body></html>");
    const splitAt = utf8.indexOf(0xc3) + 1; // mid-sequence: 'é' is 0xC3 0xA9
    const fetchImpl = (async () =>
      fakeResponse({ bodyChunks: [utf8.subarray(0, splitAt), utf8.subarray(splitAt)] })) as unknown as typeof fetch;
    const [, read] = buildDocsTools(fetchImpl);
    const r = await read.handler({ url: "https://docs.aws.amazon.com/small.html" });
    assert.equal(r.ok, true);
    assert.match((r.data as { content: string }).content, /# Café/, "split multi-byte sequence must not become U+FFFD");
  });

  it("re-checks the allowlist against the FINAL url after redirects", async () => {
    // isValidDocsUrl gates the REQUEST url, but fetch follows redirects -- so
    // an allowlisted docs URL that 302s off-domain was fetched and converted
    // with only the content-type gate behind it.
    const fetchImpl = (async () =>
      fakeResponse({
        url: "https://evil.example.com/landing.html",
        text: "<html><body><main><p>not aws docs</p></main></body></html>",
      })) as unknown as typeof fetch;
    const [, read] = buildDocsTools(fetchImpl);
    const r = await read.handler({ url: "https://docs.aws.amazon.com/redirector.html" });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /redirected to 'https:\/\/evil\.example\.com\/landing\.html'/);
  });

  it("allows a redirect that stays inside the docs allowlist", async () => {
    const fetchImpl = (async () =>
      fakeResponse({
        url: "https://docs.aws.amazon.com/en_us/lambda/latest/dg/welcome.html",
        text: "<html><body><main><p>localized</p></main></body></html>",
      })) as unknown as typeof fetch;
    const [, read] = buildDocsTools(fetchImpl);
    const r = await read.handler({ url: "https://docs.aws.amazon.com/lambda/latest/dg/welcome.html" });
    assert.equal(r.ok, true);
    assert.match((r.data as { content: string }).content, /localized/);
  });

  it("reads the index.html pages aws_docs_search returns", async () => {
    // The 2.0.0 regression: the site 301s every <path>/index.html to <path>/,
    // and the post-redirect check demanded a .html suffix -- so 16% of search
    // results failed with an error that read like a blocked off-site redirect.
    // Both fake `url` values are the real 301 targets (re-verified 2026-09-19).
    for (const [requested, landed, body, expect] of [
      [
        "https://docs.aws.amazon.com/powertools/typescript/latest/environment-variables/index.html",
        "https://docs.aws.amazon.com/powertools/typescript/latest/environment-variables/",
        POWERTOOLS_PAGE_HTML,
        /# Environment variables/,
      ],
      [
        "https://docs.aws.amazon.com/cli/latest/reference/s3api/index.html",
        "https://docs.aws.amazon.com/cli/latest/reference/s3api/",
        CLI_S3API_INDEX_HTML,
        /Available Commands/,
      ],
    ] as const) {
      const fetchImpl = (async () => fakeResponse({ url: landed, text: body })) as unknown as typeof fetch;
      const [, read] = buildDocsTools(fetchImpl);
      const r = await read.handler({ url: requested, maxLength: 4000 });
      assert.equal(r.ok, true, `${requested} must be readable: ${r.error}`);
      assert.match((r.data as { content: string }).content, expect);
    }
  });

  it("says a guessed page name does not exist instead of returning the guide landing page", async () => {
    // docs.aws.amazon.com does not 404 a missing page inside a guide that
    // exists: it 302s to the guide's landing page. Accepting that would answer
    // the guess with the wrong page's content under the requested url.
    let fetchCount = 0;
    const fetchImpl = (async () => {
      fetchCount++;
      return fakeResponse({ url: "https://docs.aws.amazon.com/lambda/latest/dg/", text: LAMBDA_LANDING_STUB_HTML });
    }) as unknown as typeof fetch;
    const [, read] = buildDocsTools(fetchImpl);
    const url = "https://docs.aws.amazon.com/lambda/latest/dg/no-such-page-zz.html";
    const r = await read.handler({ url });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /does not exist/);
    assert.match(r.error ?? "", /https:\/\/docs\.aws\.amazon\.com\/lambda\/latest\/dg\//);
    // Slice 1 still refuses a URL ending in '/' as input, so the message must not
    // tell the caller to read the landing page.
    assert.doesNotMatch(r.error ?? "", /aws_docs_read on/);

    assert.equal((await read.handler({ url })).ok, false);
    assert.equal(fetchCount, 2, "a failure must not be cached");
  });

  it("says a guessed CLI command does not exist instead of returning the command index", async () => {
    const fetchImpl = (async () =>
      fakeResponse({
        url: "https://docs.aws.amazon.com/cli/latest/reference/s3api/",
        text: CLI_S3API_INDEX_HTML,
      })) as unknown as typeof fetch;
    const [, read] = buildDocsTools(fetchImpl);
    const r = await read.handler({ url: "https://docs.aws.amazon.com/cli/latest/reference/s3api/no-such-cmd-zz.html" });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /does not exist/);
    // The whole s3api command index would otherwise have come back as the
    // content of a command that does not exist.
    assert.doesNotMatch(r.error ?? "", /abort-multipart-upload/);
  });

  it("refuses a landing-page stub, naming the page it forwards to", async () => {
    // lambda/latest/dg/index.html is a legitimate request that lands on the
    // guide's directory: a page by the classifier, but a meta-refresh stub with
    // nothing to read, which the redirect fix would otherwise return as an
    // empty success.
    let fetchCount = 0;
    const fetchImpl = (async () => {
      fetchCount++;
      return fakeResponse({ url: "https://docs.aws.amazon.com/lambda/latest/dg/", text: LAMBDA_LANDING_STUB_HTML });
    }) as unknown as typeof fetch;
    const [, read] = buildDocsTools(fetchImpl);
    const url = "https://docs.aws.amazon.com/lambda/latest/dg/index.html";
    const r = await read.handler({ url });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /only forwards the browser/);
    assert.match(r.error ?? "", /https:\/\/docs\.aws\.amazon\.com\/lambda\/latest\/dg\/welcome\.html/);

    assert.equal((await read.handler({ url })).ok, false);
    assert.equal(fetchCount, 2, "a thin conversion must not be cached");
  });

  it("refuses a client-rendered API reference shell", async () => {
    const fetchImpl = (async () =>
      fakeResponse({
        url: "https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-client-s3/Variable/PutObject$/",
        text: JSV3_SHELL_HTML,
      })) as unknown as typeof fetch;
    const [, read] = buildDocsTools(fetchImpl);
    const r = await read.handler({
      url: "https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-client-s3/Variable/PutObject$/index.html",
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /rendered in the browser by JavaScript/);
  });

  it("serves but does not cache a conversion larger than the per-entry bound", async () => {
    // The cache header comment's footprint math (64 entries x 1MB) is only true
    // if an over-size conversion stays out of the cache. The page is still
    // served in full -- it just costs a fetch per window.
    let fetchCount = 0;
    const html = `<html><body><main><p>${"z".repeat(1_100_000)}</p></main></body></html>`;
    const fetchImpl = (async () => {
      fetchCount++;
      return fakeResponse({ text: html });
    }) as unknown as typeof fetch;
    const [, read] = buildDocsTools(fetchImpl);
    const url = "https://docs.aws.amazon.com/enormous.html";

    const first = await read.handler({ url, maxLength: 50 });
    assert.equal(first.ok, true);
    assert.ok((first.data as { totalLength: number }).totalLength > 1_000_000, "precondition: over MAX_MAX_LENGTH");

    const second = await read.handler({ url, startIndex: 50, maxLength: 50 });
    assert.equal(second.ok, true);
    assert.equal((second.data as { cached: boolean }).cached, false, "an over-size page must not be cached");
    assert.equal(fetchCount, 2, "the second window re-fetches instead of blowing the cache bound");
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

  it("read rejects a url longer than 2048 chars", () => {
    // docs.ts url field carries .max(2048) for parity with iam-simulate's
    // resource cap. A path segment that inflates the URL past 2048 chars
    // must fail schema validation without reaching the fetch.
    const base = "https://docs.aws.amazon.com/";
    const padded = `${base}${"a".repeat(2048 - base.length + 1)}.html`;
    assert.ok(padded.length > 2048);
    assert.equal(readTool.inputSchema.safeParse({ url: padded }).success, false);
  });

  it("read rejects a negative startIndex", () => {
    assert.equal(
      readTool.inputSchema.safeParse({ url: "https://docs.aws.amazon.com/x.html", startIndex: -1 }).success,
      false,
    );
  });
});

/**
 * Cache contract pinned at docs.ts:293-318. Two behaviors matter:
 *   1. LRU eviction at the 64-entry cap (set() drops the oldest insertion).
 *   2. Move-to-end on read so the cache is true-LRU rather than insertion-
 *      ordered -- get() re-inserts the entry to make it the freshest.
 */
describe("makeDocCache — LRU eviction and recency", () => {
  // Drive eviction off the production cap rather than a hardcoded number so
  // bumping DOC_CACHE_MAX_ENTRIES doesn't silently invalidate these tests.
  const CAP = DOC_CACHE_MAX_ENTRIES;

  it("evicts the oldest entry when the cap is exceeded", () => {
    const cache = makeDocCache();
    // Insert CAP+1 entries; the first insert must be evicted.
    for (let i = 0; i < CAP + 1; i++) {
      cache.set(`https://docs.aws.amazon.com/url-${i}.html`, `markdown-${i}`);
    }
    assert.equal(cache.get("https://docs.aws.amazon.com/url-0.html"), undefined);
    // All subsequent entries (1..CAP) are still resident.
    for (let i = 1; i < CAP + 1; i++) {
      assert.equal(
        cache.get(`https://docs.aws.amazon.com/url-${i}.html`),
        `markdown-${i}`,
        `entry ${i} should still be cached`,
      );
    }
  });

  it("reading an entry refreshes its recency (move-to-end)", () => {
    const cache = makeDocCache();
    for (let i = 0; i < CAP; i++) {
      cache.set(`https://docs.aws.amazon.com/url-${i}.html`, `markdown-${i}`);
    }
    // Touch url-0 -- this re-inserts it as the newest entry.
    assert.equal(cache.get("https://docs.aws.amazon.com/url-0.html"), "markdown-0");
    cache.set("https://docs.aws.amazon.com/url-NEW.html", "markdown-NEW");
    assert.equal(
      cache.get("https://docs.aws.amazon.com/url-0.html"),
      "markdown-0",
      "url-0 should survive because it was just read",
    );
    assert.equal(
      cache.get("https://docs.aws.amazon.com/url-1.html"),
      undefined,
      "url-1 should be evicted as the now-oldest entry",
    );
    assert.equal(cache.get("https://docs.aws.amazon.com/url-NEW.html"), "markdown-NEW");
  });

  it("re-setting an existing URL re-inserts it as the newest (no growth past cap)", () => {
    const cache = makeDocCache();
    for (let i = 0; i < CAP; i++) {
      cache.set(`https://docs.aws.amazon.com/url-${i}.html`, `markdown-${i}`);
    }
    // Re-set url-0; per the implementation (delete-then-set), url-0 is
    // now the newest, not the oldest.
    cache.set("https://docs.aws.amazon.com/url-0.html", "markdown-0-v2");
    cache.set("https://docs.aws.amazon.com/url-NEW.html", "markdown-NEW");
    assert.equal(cache.get("https://docs.aws.amazon.com/url-0.html"), "markdown-0-v2");
    assert.equal(cache.get("https://docs.aws.amazon.com/url-1.html"), undefined);
  });
});

/**
 * TTL expiry pinned at docs.ts:299 (`Date.now() - entry.storedAt >
 * DOC_CACHE_TTL_MS`). The cache reads the host `Date.now()` directly, so we
 * drive virtual time with node:test's MockTimers Date support: enable Date,
 * tick past the TTL, and assert the stale entry is evicted on get() (and that
 * a paginated read therefore re-fetches). DOC_CACHE_TTL_MS is 5 minutes
 * (docs.ts:53); it isn't exported, so the tick value is anchored to that
 * literal with a comment rather than imported.
 */
describe("makeDocCache — TTL expiry", () => {
  const TTL_MS = 5 * 60_000; // mirror DOC_CACHE_TTL_MS (docs.ts:53)

  it("evicts an entry older than DOC_CACHE_TTL_MS on get()", () => {
    mock.timers.enable({ apis: ["Date"] });
    try {
      const cache = makeDocCache();
      const url = "https://docs.aws.amazon.com/x.html";
      cache.set(url, "markdown");
      // Within the TTL window the entry is still served.
      mock.timers.tick(TTL_MS - 1);
      assert.equal(cache.get(url), "markdown", "entry within TTL must still be cached");
      // One tick past the TTL boundary evicts on the next get().
      mock.timers.tick(2);
      assert.equal(cache.get(url), undefined, "entry older than DOC_CACHE_TTL_MS must be evicted on get()");
    } finally {
      mock.timers.reset();
    }
  });

  it("a read after TTL expiry re-fetches instead of serving the stale page", async () => {
    mock.timers.enable({ apis: ["Date"] });
    try {
      let fetchCount = 0;
      const html = "<html><body><main><p>doc body content</p></main></body></html>";
      const fetchImpl = (async () => {
        fetchCount++;
        return fakeResponse({ text: html });
      }) as unknown as typeof fetch;
      const [, read] = buildDocsTools(fetchImpl);
      const url = "https://docs.aws.amazon.com/x.html";

      const first = await read.handler({ url });
      assert.equal(first.ok, true);
      assert.equal((first.data as { cached: boolean }).cached, false);

      // A second read within the TTL is a cache hit -- no refetch.
      mock.timers.tick(60_000);
      const second = await read.handler({ url });
      assert.equal((second.data as { cached: boolean }).cached, true);
      assert.equal(fetchCount, 1, "within-TTL read must not re-fetch");

      // Push past the TTL: the stale entry is evicted and the read re-fetches.
      mock.timers.tick(TTL_MS + 1);
      const third = await read.handler({ url });
      assert.equal((third.data as { cached: boolean }).cached, false, "post-TTL read must report cached:false");
      assert.equal(fetchCount, 2, "post-TTL read must trigger a second fetch");
    } finally {
      mock.timers.reset();
    }
  });
});

describe("parseSearchResults — schema-drift warning", () => {
  // Module-level `schemaWarned` is one-shot per process. Reset before each
  // case so the warn-firing assertions land deterministically.
  beforeEach(() => {
    _resetParseSearchSchemaWarn();
  });

  it("warns once when a non-empty response is missing the suggestions array", () => {
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warned.push(args.map(String).join(" "));
    };
    try {
      // Response has other keys but no `suggestions` -- the schema-drift case.
      parseSearchResults({ queryId: "abc", note: "shape changed" }, 10);
      parseSearchResults({ queryId: "def" }, 10);
      parseSearchResults({ queryId: "ghi" }, 10);
    } finally {
      console.warn = original;
    }
    assert.equal(warned.length, 1, "expected exactly one warn across three schema-drift responses");
    assert.match(warned[0], /backend shape may have changed/);
  });

  it("does NOT warn on a legitimately empty {} response", () => {
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warned.push(args.map(String).join(" "));
    };
    try {
      parseSearchResults({}, 10);
    } finally {
      console.warn = original;
    }
    assert.equal(warned.length, 0, "empty object is not a schema break (could be a no-op error response)");
  });

  it("does NOT warn on a legitimate empty-results response (suggestions: [])", () => {
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warned.push(args.map(String).join(" "));
    };
    try {
      parseSearchResults({ suggestions: [] }, 10);
    } finally {
      console.warn = original;
    }
    assert.equal(warned.length, 0, "an empty suggestions array is the no-match case, not a schema break");
  });
});

describe("parseSearchResults -- URL allowlist", () => {
  // The read tool gates on DOCS_URL_RE (https://docs.aws.amazon.com/...html).
  // Mirror it on the search side so the agent never sees a result pointing at
  // a URL the read tool would refuse to fetch -- the undocumented backend at
  // proxy.search.docs.aws.com is a moving target.
  it("drops results whose link fails the read-side allowlist", () => {
    const json = {
      suggestions: [
        { textExcerptSuggestion: { link: "https://example.com/not-aws.html", title: "off-domain" } },
        { textExcerptSuggestion: { link: "http://docs.aws.amazon.com/insecure.html", title: "non-https" } },
        { textExcerptSuggestion: { link: "https://docs.aws.amazon.com/lambda/welcome", title: "missing .html" } },
        { textExcerptSuggestion: { link: "https://docs.aws.amazon.com/lambda/welcome.html", title: "kept" } },
      ],
    };
    const out = parseSearchResults(json, 10);
    assert.equal(out.length, 1);
    assert.equal(out[0].title, "kept");
    assert.equal(out[0].url, "https://docs.aws.amazon.com/lambda/welcome.html");
  });

  it("accepts a docs URL with query string and fragment (mirrors read-side regex)", () => {
    const json = {
      suggestions: [
        {
          textExcerptSuggestion: {
            link: "https://docs.aws.amazon.com/lambda/welcome.html?query=1#section",
            title: "with-query-and-fragment",
          },
        },
      ],
    };
    const out = parseSearchResults(json, 10);
    assert.equal(out.length, 1);
    assert.equal(out[0].title, "with-query-and-fragment");
  });
});

/**
 * Lexical relevance signal (docs.ts). The defect it exists for, reproduced
 * against the published 2.0.1 server: `aws_docs_search` with the nonsense
 * query "zzzzqqq-nonexistent-service-xyzzy" returned `count: 10` whose top hit
 * was a Ruby SDK `Route53::Errors::NoSuchHealthCheck` page. The backend has no
 * "no good match" answer and ships no score, so a caller could not tell ten
 * relevant results from ten irrelevant ones.
 *
 * The fixture below is that real result, shortened.
 */
const RUBY_ROUTE53_HIT = {
  title: "Class: Aws::Route53::Errors::NoSuchHealthCheck",
  url: "https://docs.aws.amazon.com/sdk-for-ruby/v3/api/Aws/Route53/Errors/NoSuchHealthCheck.html",
  summary: "AWS SDK for Ruby V3 API reference for the Route 53 service.",
  excerpt: "Raised when there is no such health check in this service account.",
};

const LAMBDA_URL_HIT = {
  title: "Lambda function URLs",
  url: "https://docs.aws.amazon.com/lambda/latest/dg/lambda-urls.html",
  summary: "A function URL is a dedicated HTTP(S) endpoint for your Lambda function.",
  excerpt: "You can create and configure a function URL through the Lambda console.",
};

describe("docTerms — AWS-shaped tokenizing", () => {
  it("splits hyphens, colons, :: and underscores rather than treating them as one word", () => {
    const terms = docTerms("aws-sdk-js s3:GetObject Route53::Errors dynamodb.describe_table");
    for (const t of ["aws", "sdk", "js", "s3", "get", "object", "route53", "errors", "dynamodb", "describe", "table"]) {
      assert.ok(terms.has(t), `expected term '${t}'`);
    }
  });

  it("splits CamelCase and the acronym-then-word form, keeping the run as printed", () => {
    const terms = docTerms("NoSuchHealthCheck HTTPSListener");
    // The whole run survives (a caller may type it verbatim)...
    assert.ok(terms.has("nosuchhealthcheck"));
    // ...alongside its pieces.
    for (const t of ["no", "such", "health", "check", "https", "listener"]) {
      assert.ok(terms.has(t), `expected piece '${t}'`);
    }
  });

  it("reconciles the digit-suffix spelling in BOTH directions", () => {
    // Docs print "Route 53", users type "route53".
    assert.ok(docTerms("Amazon Route 53 health checks").has("route53"));
    // Docs print "Route53", users type "route 53".
    const glued = docTerms("Route53::Errors");
    assert.ok(glued.has("route"));
    assert.ok(glued.has("53"));
  });
});

describe("queryTerms — the published denominator", () => {
  it("drops English stopwords so they cannot inflate every result's overlap", () => {
    assert.deepEqual(queryTerms("How do I use a Lambda function URL?"), ["lambda", "function", "url"]);
  });

  it("falls back to every term when the query is nothing but stopwords", () => {
    // Never divide by zero: a stopword-only query still gets a denominator.
    assert.deepEqual(queryTerms("how do i"), ["how", "do", "i"]);
  });

  it("keeps a punctuation-glued identifier as ONE term, not four", () => {
    // The denominator is what the USER typed. Counting NoSuchHealthCheck as
    // four terms would reweight the query toward whichever word happened to
    // be written as an identifier.
    assert.deepEqual(queryTerms("s3:GetObject"), ["s3", "getobject"]);
  });

  it("dedupes repeated terms", () => {
    assert.deepEqual(queryTerms("lambda LAMBDA lambda"), ["lambda"]);
  });

  it("returns nothing for a query with no alphanumerics", () => {
    assert.deepEqual(queryTerms("???"), []);
  });
});

describe("scoreSearchResults", () => {
  it("flags the reproduced nonsense query as lowRelevance and names the missing terms", () => {
    const r = scoreSearchResults("zzzzqqq-nonexistent-service-xyzzy", [RUBY_ROUTE53_HIT]);
    assert.equal(r.lowRelevance, true);
    assert.ok(
      (r.bestLexicalOverlap ?? 1) < LOW_RELEVANCE_OVERLAP,
      "the best hit must fall under the low-relevance bar",
    );
    const m = r.results[0].lexicalMatch;
    assert.ok(m);
    // "service" really does appear in the summary -- the signal reports what
    // is literally there, it does not pretend the page is unrelated in full.
    assert.deepEqual(m.matchedTerms, ["service"]);
    assert.deepEqual(m.unmatchedTerms, ["zzzzqqq", "nonexistent", "xyzzy"]);
    assert.match(r.relevanceNote ?? "", /full page of fuzzy matches/);
    assert.match(r.relevanceNote ?? "", /not that this tool failed/);
  });

  it("does NOT flag a genuinely on-topic query", () => {
    const r = scoreSearchResults("lambda function url", [LAMBDA_URL_HIT, RUBY_ROUTE53_HIT]);
    assert.equal(r.lowRelevance, false);
    assert.equal(r.bestLexicalOverlap, 1);
    assert.equal(r.relevanceNote, undefined);
    // Per-result, not just top-level: the irrelevant sibling still scores low.
    assert.equal(r.results[0].lexicalMatch?.overlap, 1);
    assert.ok((r.results[1].lexicalMatch?.overlap ?? 1) < LOW_RELEVANCE_OVERLAP);
  });

  it("counts a typed identifier when the page spells it out in words", () => {
    // `s3:GetObject` vs a page that writes "get object" -- a whitespace split
    // would score this 0 and call a correct page irrelevant.
    const r = scoreSearchResults("s3:GetObject permission", [
      {
        title: "Amazon S3 API: get object",
        url: "https://docs.aws.amazon.com/x.html",
        summary: "Grants permissions to retrieve objects from a bucket.",
      },
    ]);
    assert.equal(r.results[0].lexicalMatch?.overlap, 1);
    assert.equal(r.lowRelevance, false);
  });

  it("requires ALL pieces of an identifier, not just one", () => {
    // Matching on "check" alone would hand almost any AWS page a free point.
    const partial = scoreSearchResults("NoSuchHealthCheck", [
      { title: "Health check configuration", url: "https://docs.aws.amazon.com/a.html" },
    ]);
    assert.equal(partial.results[0].lexicalMatch?.overlap, 0);
    // ...but a page that spells the whole thing out does match.
    const full = scoreSearchResults("NoSuchHealthCheck", [RUBY_ROUTE53_HIT]);
    assert.equal(full.results[0].lexicalMatch?.overlap, 1);
  });

  it("does not fail a match on a plain English plural", () => {
    const singular = scoreSearchResults("lambda function url", [LAMBDA_URL_HIT]);
    assert.equal(singular.results[0].lexicalMatch?.overlap, 1, "'url' must match the page's 'URLs'");
    const plural = scoreSearchResults("lambda function urls", [
      {
        title: "Lambda function URL",
        url: "https://docs.aws.amazon.com/lambda/latest/dg/lambda-urls.html",
        summary: "A dedicated endpoint for your function.",
      },
    ]);
    assert.equal(plural.results[0].lexicalMatch?.overlap, 1, "'urls' must match the page's 'URL'");
  });

  it("matches the digit-suffix spelling the user typed, not the one the docs used", () => {
    const glued = scoreSearchResults("route53 health check", [
      { title: "Amazon Route 53 health checks", url: "https://docs.aws.amazon.com/r.html" },
    ]);
    assert.equal(glued.results[0].lexicalMatch?.overlap, 1);
    const spaced = scoreSearchResults("route 53 errors", [RUBY_ROUTE53_HIT]);
    assert.equal(spaced.results[0].lexicalMatch?.overlap, 1);
  });

  it("publishes no signal at all when the query has no comparable terms", () => {
    // Reporting 0% here would assert "the backend had nothing" when the truth
    // is "this heuristic has no opinion".
    const r = scoreSearchResults("???", [LAMBDA_URL_HIT]);
    assert.equal(r.bestLexicalOverlap, null);
    assert.equal(r.lowRelevance, false);
    assert.equal(r.results[0].lexicalMatch, null);
    assert.match(r.relevanceNote ?? "", /no comparable terms/);
  });

  it("flags an empty result page with a distinct note", () => {
    const r = scoreSearchResults("lambda", []);
    assert.equal(r.lowRelevance, true);
    assert.match(r.relevanceNote ?? "", /returned no results/);
  });

  it("is additive: existing fields and the backend's ordering are untouched", () => {
    const r = scoreSearchResults("lambda", [RUBY_ROUTE53_HIT, LAMBDA_URL_HIT]);
    // Order preserved -- this annotates the backend's ranking, it does not
    // re-rank, even though result 2 scores higher than result 1.
    assert.equal(r.results[0].url, RUBY_ROUTE53_HIT.url);
    assert.equal(r.results[1].url, LAMBDA_URL_HIT.url);
    assert.equal(r.results[0].title, RUBY_ROUTE53_HIT.title);
    assert.equal(r.results[0].summary, RUBY_ROUTE53_HIT.summary);
    assert.equal(r.results[0].excerpt, RUBY_ROUTE53_HIT.excerpt);
    // A result with no summary/excerpt does not gain empty ones.
    const sparse = scoreSearchResults("lambda", [{ title: "t", url: "https://docs.aws.amazon.com/x.html" }]);
    assert.deepEqual(Object.keys(sparse.results[0]).sort(), ["lexicalMatch", "title", "url"]);
  });
});

describe("aws_docs_search handler — relevance signal", () => {
  /** Wrap fixtures in the backend's suggestion envelope. */
  function suggestionsFor(hits: ReadonlyArray<{ title: string; url: string; summary?: string; excerpt?: string }>) {
    return {
      suggestions: hits.map((h) => ({
        textExcerptSuggestion: { link: h.url, title: h.title, summary: h.summary, suggestionBody: h.excerpt },
      })),
    };
  }

  it("flags a full page of fuzzy matches for a nonsense query", async () => {
    // The shape of the real defect: ten confident-looking hits for a query
    // that matches nothing.
    const hits = Array.from({ length: 10 }, (_, n) => ({
      ...RUBY_ROUTE53_HIT,
      url: `https://docs.aws.amazon.com/sdk-for-ruby/v3/api/page-${n}.html`,
    }));
    const fetchImpl = (async () => fakeResponse({ json: suggestionsFor(hits) })) as unknown as typeof fetch;
    const [search] = buildDocsTools(fetchImpl);
    const r = await search.handler({ query: "zzzzqqq-nonexistent-service-xyzzy" });
    assert.equal(r.ok, true);
    const data = r.data as {
      count: number;
      lowRelevance: boolean;
      bestLexicalOverlap: number;
      queryTerms: string[];
      relevanceNote?: string;
      results: Array<{ title: string; url: string; summary?: string; excerpt?: string; lexicalMatch: unknown }>;
    };
    assert.equal(data.lowRelevance, true);
    assert.ok(data.bestLexicalOverlap < LOW_RELEVANCE_OVERLAP);
    assert.deepEqual(data.queryTerms, ["zzzzqqq", "nonexistent", "service", "xyzzy"]);
    assert.match(data.relevanceNote ?? "", /weak leads/);
    // Additive: count and the existing per-result fields are unchanged.
    assert.equal(data.count, 10);
    assert.equal(data.results.length, 10);
    assert.equal(data.results[0].title, RUBY_ROUTE53_HIT.title);
    assert.equal(data.results[0].summary, RUBY_ROUTE53_HIT.summary);
    assert.equal(data.results[0].excerpt, RUBY_ROUTE53_HIT.excerpt);
    assert.ok(data.results[0].lexicalMatch, "every result carries the per-result signal");
  });

  it("does not flag an on-topic query", async () => {
    const fetchImpl = (async () =>
      fakeResponse({ json: suggestionsFor([LAMBDA_URL_HIT, RUBY_ROUTE53_HIT]) })) as unknown as typeof fetch;
    const [search] = buildDocsTools(fetchImpl);
    const r = await search.handler({ query: "lambda function url" });
    const data = r.data as { count: number; lowRelevance: boolean; bestLexicalOverlap: number; relevanceNote?: string };
    assert.equal(data.lowRelevance, false);
    assert.equal(data.bestLexicalOverlap, 1);
    assert.equal(data.relevanceNote, undefined, "no note when the page is fine");
    assert.equal(data.count, 2);
  });

  it("reports lowRelevance on a genuinely empty result set", async () => {
    const fetchImpl = (async () => fakeResponse({ json: { suggestions: [] } })) as unknown as typeof fetch;
    const [search] = buildDocsTools(fetchImpl);
    const r = await search.handler({ query: "lambda function url" });
    const data = r.data as { count: number; lowRelevance: boolean; relevanceNote?: string };
    assert.equal(data.count, 0);
    assert.equal(data.lowRelevance, true);
    assert.match(data.relevanceNote ?? "", /returned no results/);
  });

  it("documents the fixed-page-of-fuzzy-matches behavior in the tool description", () => {
    // The number is only honest if the caller is told what it measures and
    // what a low value means.
    assert.match(searchTool.description, /fuzzy matches/);
    assert.match(searchTool.description, /lexicalMatch/);
    assert.match(searchTool.description, /NOT semantic ranking/);
  });
});

/**
 * Regression cover for the two ways the low-relevance verdict let a gibberish
 * query through. Both were found by driving the built server against the LIVE
 * docs backend, not by a fixture: the real result set for
 * "zzzzqqq-nonexistent-service-xyzzy" contained one unrelated page carrying the
 * ordinary English words "nonexistent" and "service", which put
 * bestLexicalOverlap at exactly 0.5 -- escaping a `<` test and reporting
 * lowRelevance:false for pure nonsense.
 */
describe("scoreSearchResults — low-relevance verdict boundaries", () => {
  const hit = (title: string, summary = "", excerpt = "") => ({
    title,
    url: "https://docs.aws.amazon.com/x/latest/y/z.html",
    summary,
    excerpt,
  });

  it("flags a query sitting EXACTLY on the threshold (<= not <)", () => {
    // 2 of 4 terms matched = 0.5 = LOW_RELEVANCE_OVERLAP exactly. The threshold
    // is the boundary of "weak", so landing on it is weak.
    const r = scoreSearchResults("alpha beta gamma delta", [hit("alpha beta only")]);
    assert.equal(r.bestLexicalOverlap, 0.5, "fixture must sit exactly on the threshold");
    assert.equal(r.lowRelevance, true, "exactly-at-threshold must be flagged");
  });

  it("flags a query with a term that matches NO result, even when the best overlap is high", () => {
    // best = 0.67 (above threshold), but "xyzzy" appears nowhere -- the term
    // that actually identifies the query. Taking the max across results would
    // call this relevant; the per-term signal catches it.
    const r = scoreSearchResults("lambda function xyzzy", [
      hit("Creating and managing Lambda function URLs"),
      hit("Lambda function configuration"),
    ]);
    assert.ok((r.bestLexicalOverlap ?? 0) > 0.5, "best must be above the threshold for this to be the deciding signal");
    assert.deepEqual(r.termsMatchedNowhere, ["xyzzy"]);
    assert.equal(r.lowRelevance, true);
    assert.match(r.relevanceNote ?? "", /appear in NO result at all: xyzzy/);
  });

  it("does NOT flag a genuinely on-topic query", () => {
    const r = scoreSearchResults("lambda function url", [hit("Creating and managing Lambda function URLs")]);
    assert.equal(r.bestLexicalOverlap, 1);
    assert.deepEqual(r.termsMatchedNowhere, []);
    assert.equal(r.lowRelevance, false);
    assert.equal(r.relevanceNote, undefined);
  });
});
