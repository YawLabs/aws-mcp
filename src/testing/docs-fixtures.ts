/**
 * Real docs.aws.amazon.com responses, trimmed, for the aws_docs_read tests.
 *
 * TEST DATA ONLY. No production file imports this: the esbuild entry is
 * src/index.ts and package.json `files` ships dist/index.js, so nothing here is
 * bundled or published. It lives next to fake-aws.ts because that is where this
 * repo's test support lives.
 *
 * Each fixture says where it came from, what Accept header was sent, when it was
 * captured, the content-type the site actually answered with, and what was
 * trimmed -- the aws_logs_tail lesson: a test that serves an invented body
 * passes while the real shape fails. Every capture below was taken on
 * 2026-09-19 and re-verified against the live site on 2026-09-19 with the
 * server's own User-Agent.
 *
 * Bodies are LF-only, matching the site, and are built by joining line arrays
 * rather than with template literals: the pages contain `$` sequences and
 * (in the slice-2 fixtures to come) triple-backtick fences, which a template
 * literal would need escaping for -- and an escape silently changes a fixture.
 */

/**
 * https://docs.aws.amazon.com/lambda/latest/dg/ -- what every guide landing URL
 * answers, and what `lambda/latest/dg/index.html` and any nonexistent page under
 * that guide are redirected to. 1085 bytes, `text/html`. The `<body>` really is
 * empty: the page is a meta refresh plus a script that does the same thing.
 * Trimmed: the inline redirect script's body (STRIP_SELECTORS drops `script`
 * before conversion, so it can never reach the markdown either way).
 */
export const LAMBDA_LANDING_STUB_HTML = [
  "<!DOCTYPE html>",
  '        <!DOCTYPE HTML><html xmlns="http://www.w3.org/1999/xhtml"><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><title>AWS Lambda</title><meta xmlns="" name="subtitle" content="Developer Guide"><meta xmlns="" name="abstract" content="Lambda is a compute service that lets you run code without provisioning or managing servers."><meta http-equiv="refresh" content="0;URL=welcome.html"><script type="text/javascript"><!--',
  '        var myDefaultPage = "welcome.html";',
  "    --></script></head><body></body></html>",
].join("\n");

/**
 * https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-client-s3/Variable/PutObject$/
 * -- the JS SDK v3 API reference, a Next.js page whose content is assembled in
 * the browser. 3020 bytes, `text/html`. The shipped converter's entire output for
 * it is `[Skip to main content](#main)`.
 * Trimmed: seven more `_next/static` script tags, one more stylesheet, and the
 * `__NEXT_DATA__` JSON payload. Both markers this server keys on are kept -- the
 * `/_next/static/` asset path and `<div id="__next">`.
 */
export const JSV3_SHELL_HTML = [
  '<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/><title>AWS SDK for JavaScript v3</title>',
  '<meta content="API Reference" name="description"/><meta content="AWS SDK for JavaScript v3" name="service-name"/>',
  '<link rel="stylesheet" href="/AWSJavaScriptSDK/v3/latest/_next/static/css/eb2a769eb8dc9f8b.css" data-n-g=""/>',
  '<script src="/AWSJavaScriptSDK/v3/latest/_next/static/chunks/main-87182a469fdd9857.js" defer=""></script>',
  '</head><body class="awsui-visual-refresh"><div id="__next"><div class="SkipToMain_SkipToMain__Gpx2B">',
  '<a class="awsui_button_vjswe_teta5_101" href="#main"><span class="awsui_content_vjswe_teta5_97">Skip to main content</span></a>',
  "</div></div></body></html>",
].join("\n");

/**
 * https://docs.aws.amazon.com/sdk-for-swift/latest/api/awscodepipeline.doccarchive/documentation/awscodepipeline/codepipelineclienttypes/environmentvariabletype/init(rawvalue:)/
 * -- a Swift DocC page. 1819 bytes, `text/html`. Its `<noscript>` block is the
 * only prose in the response, and `noscript` is in STRIP_SELECTORS, so the
 * converter's output is the empty string. The marker this server keys on is the
 * "requires JavaScript" sentence in the raw HTML.
 * Trimmed: the `<noscript>` block's inline CSS, two `<link>` tags and the three
 * DocC bundle scripts.
 */
export const SWIFT_SHELL_HTML = [
  '<!doctype html><html lang="en-US" class="no-js"><head><meta charset="utf-8">',
  "<title>Documentation</title>",
  '</head><body data-color-scheme="auto"><noscript>',
  '<div class="noscript"><h1 class="noscript-title">This page requires JavaScript.</h1>',
  "<p>Please turn on JavaScript in your browser and refresh the page to view its content.</p></div></noscript>",
  '<div id="app"></div></body></html>',
].join("\n");

/**
 * https://docs.aws.amazon.com/cli/latest/reference/s3api/ -- the AWS CLI's own
 * per-service command index, which is where `s3api/index.html` lands and where a
 * nonexistent `s3api/<command>.html` is redirected. 23997 bytes, `text/html`.
 * It is a real page with real content: the shipped converter gets 9993
 * characters of markdown out of it, 5310 with link syntax stripped, so it is
 * nowhere near the thin-page gate.
 * Trimmed: the Sphinx sidebar and footer, the related-links bars, the heading
 * permalink anchors, and all but three of the ~160 command links.
 */
export const CLI_S3API_INDEX_HTML = [
  '<html><body><div class="body">',
  '<p>[ <a class="reference internal" href="../index.html#cli-aws"><span class="std std-ref">aws</span></a> ]</p>',
  '<div class="section" id="s3api">',
  '<span id="cli-aws-s3api"></span><h1>s3api</h1>',
  '<div class="section" id="description">',
  "<h2>Description</h2>",
  "<p>Welcome to the <em>Amazon S3 API Reference</em> . This guide explains the Amazon Simple Storage Service (Amazon S3) application programming interface (API).</p>",
  "<p>You can use any toolkit that supports HTTP to use the REST API. You can even use a browser to fetch objects, as long as they are anonymously readable.</p>",
  '<p>The current version of the Amazon S3 API is <code class="docutils literal notranslate"><span class="pre">2006-03-01</span></code> .</p>',
  "</div>",
  '<div class="section" id="available-commands">',
  "<h2>Available Commands</h2>",
  '<div class="toctree-wrapper compound"><ul>',
  '<li class="toctree-l1"><a class="reference internal" href="abort-multipart-upload.html">abort-multipart-upload</a></li>',
  '<li class="toctree-l1"><a class="reference internal" href="create-bucket.html">create-bucket</a></li>',
  '<li class="toctree-l1"><a class="reference internal" href="get-object.html">get-object</a></li>',
  "</ul></div></div></div></div></body></html>",
].join("\n");

/**
 * https://docs.aws.amazon.com/powertools/typescript/latest/environment-variables/
 * -- where `environment-variables/index.html` lands. 49035 bytes, `text/html`.
 * Powertools pages are the largest family of `index.html` hits in the search
 * backend's results, and they carry ordinary server-rendered content: 3239
 * characters of markdown from the shipped converter.
 * Trimmed: the page nav, the 60-row environment-variable table, and everything
 * after the opening section.
 */
export const POWERTOOLS_PAGE_HTML = [
  "<html><body><main>",
  "<h1>Environment variables</h1>",
  "<p>You can configure Powertools for AWS Lambda using environment variables. This is useful when you want to set configuration values in your Infrastructure as Code (IaC) templates or when you want to override default values without changing your code.</p>",
  '<details class="info" open="open">',
  "<summary>Info</summary>",
  "<p>Explicit parameters in your code take precedence over environment variables</p>",
  "</details>",
  "</main></body></html>",
].join("\n");
