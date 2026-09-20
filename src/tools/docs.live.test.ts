/**
 * Live aws_docs_read checks against docs.aws.amazon.com.
 *
 * NO CREDENTIALS, NO AWS API, NO SUBPROCESS. The docs tools are the only tools
 * in this server that do raw HTTP instead of shelling out to the aws CLI, so
 * this file needs nothing but outbound HTTPS to the public documentation site --
 * which is why it is `.live.` rather than `.integration.`, the suffix this repo
 * uses for suites that talk to a real AWS account with real credentials.
 *
 * What it is for: every fact the redirect and landing-page fixes are built on is
 * a fact about AWS's web server -- that `<path>/index.html` 301s to `<path>/`,
 * that a missing page 302s to the guide's landing page instead of 404ing, that
 * guide landing pages are meta-refresh stubs and the JS SDK v3 reference is an
 * empty application shell. A unit test proves the handler's reaction to those
 * shapes; only this file proves the shapes are still what the site does.
 *
 * Gated behind AWS_MCP_LIVE_DOCS=1 (or AWS_MCP_LIVE_TESTS=1), so a normal
 * `npm test` reports the block as skipped.
 *
 * Run THIS FILE ONLY. Do NOT reach for `AWS_MCP_LIVE_TESTS=1 npm test`: that
 * also fires resource.integration.test.ts's live Cloud Control create/delete,
 * which writes a real SSM parameter in whatever account the default profile
 * points at. After `npm run build`:
 *   Git Bash:    AWS_MCP_LIVE_DOCS=1 node --test dist/tools/docs.live.test.js
 *   PowerShell:  $env:AWS_MCP_LIVE_DOCS='1'; node --test dist/tools/docs.live.test.js
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { docsTools } from "./docs.js";

const LIVE = process.env.AWS_MCP_LIVE_DOCS === "1" || process.env.AWS_MCP_LIVE_TESTS === "1";

const read = docsTools.find((t) => t.name === "aws_docs_read");
if (!read) throw new Error("docsTools missing aws_docs_read");

const DOCS = "https://docs.aws.amazon.com";

describe("aws_docs_read -- live docs.aws.amazon.com", { skip: !LIVE }, () => {
  it("(a) reads the index.html URLs the search backend returns", async () => {
    // Both 301 to their directory form. One in six search results is a URL of
    // this shape, and the CLI's own per-service command indexes are among them.
    for (const [url, expected] of [
      [`${DOCS}/powertools/typescript/latest/environment-variables/index.html`, /Environment variable/i],
      [`${DOCS}/cli/latest/reference/s3api/index.html`, /s3api/i],
    ] as const) {
      const r = await read.handler({ url, maxLength: 4000 });
      assert.equal(r.ok, true, `${url} must be readable: ${r.error}`);
      const data = r.data as { content: string; totalLength: number };
      assert.match(data.content, expected);
      assert.ok(data.totalLength > 200, `${url} returned ${data.totalLength} characters`);
    }
  });

  it("(b) says a page that does not exist does not exist", async () => {
    // The site answers both of these with a 302 to a landing page, not a 404.
    for (const url of [
      `${DOCS}/lambda/latest/dg/no-such-page-zz.html`,
      `${DOCS}/cli/latest/reference/s3api/no-such-cmd-zz.html`,
    ]) {
      const r = await read.handler({ url });
      assert.equal(r.ok, false, `${url} must not come back as content`);
      assert.match(r.error ?? "", /does not exist/, url);
    }
  });

  it("(c) refuses a guide landing page, naming the page it forwards to", async () => {
    const r = await read.handler({ url: `${DOCS}/lambda/latest/dg/index.html` });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /only forwards the browser/);
    assert.match(r.error ?? "", /lambda\/latest\/dg\/welcome\.html/);
  });

  it("(d) refuses a client-rendered API reference", async () => {
    const r = await read.handler({
      url: `${DOCS}/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-client-s3/Variable/PutObject$/index.html`,
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /rendered in the browser by JavaScript/);
  });
});
