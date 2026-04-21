import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CODE_RE, parseLoginOutput, URL_RE } from "./sso.js";

describe("URL_RE", () => {
  it("matches standard AWS SSO device URLs across regions", () => {
    assert.match("https://device.sso.us-east-1.amazonaws.com/", URL_RE);
    assert.match("https://device.sso.us-west-2.amazonaws.com/", URL_RE);
    assert.match("https://device.sso.eu-west-1.amazonaws.com/", URL_RE);
    assert.match("https://device.sso.ap-southeast-2.amazonaws.com/", URL_RE);
  });

  it("matches URL embedded in surrounding text", () => {
    const line =
      "If the browser does not open, open the following URL:\n\nhttps://device.sso.us-east-1.amazonaws.com/\n\nThen enter the code:";
    assert.match(line, URL_RE);
  });

  it("matches URL with query string (pre-filled code)", () => {
    assert.match("https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH", URL_RE);
  });

  it("rejects non-AWS URLs", () => {
    assert.doesNotMatch("https://example.com/", URL_RE);
    assert.doesNotMatch("https://sso.amazonaws.com/", URL_RE);
    assert.doesNotMatch("http://device.sso.us-east-1.amazonaws.com/", URL_RE); // http, not https
  });
});

describe("CODE_RE", () => {
  it("matches well-formed 4-4 alphanumeric codes", () => {
    assert.match("ABCD-EFGH", CODE_RE);
    assert.match("WXYZ-1234", CODE_RE);
    assert.match("A1B2-C3D4", CODE_RE);
  });

  it("matches code embedded in surrounding text", () => {
    assert.match("Then enter the code:\n\nABCD-EFGH\n", CODE_RE);
  });

  it("rejects malformed codes", () => {
    assert.doesNotMatch("ABC-EFGH", CODE_RE); // 3 chars on left
    assert.doesNotMatch("ABCD-EFG", CODE_RE); // 3 chars on right
    assert.doesNotMatch("abcd-efgh", CODE_RE); // lowercase
    assert.doesNotMatch("ABCDEFGH", CODE_RE); // no hyphen
  });
});

describe("parseLoginOutput", () => {
  it("extracts both URL and code from full aws sso login output", () => {
    const sample = `Attempting to automatically open the SSO authorization page in your default browser.
If the browser does not open or you wish to use a different device to authorize this request, open the following URL:

https://device.sso.us-east-1.amazonaws.com/

Then enter the code:

ABCD-EFGH
`;
    const { url, code } = parseLoginOutput(sample);
    assert.equal(url, "https://device.sso.us-east-1.amazonaws.com/");
    assert.equal(code, "ABCD-EFGH");
  });

  it("returns null for both when no match", () => {
    const { url, code } = parseLoginOutput("Nothing of interest here");
    assert.equal(url, null);
    assert.equal(code, null);
  });

  it("returns partial result when only URL has appeared yet", () => {
    const partial = "...open the following URL:\n\nhttps://device.sso.us-east-1.amazonaws.com/\n";
    const { url, code } = parseLoginOutput(partial);
    assert.equal(url, "https://device.sso.us-east-1.amazonaws.com/");
    assert.equal(code, null);
  });
});
