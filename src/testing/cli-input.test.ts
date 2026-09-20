/**
 * Unit tests for the shared fake-aws payload reader. It is the one place that
 * knows a `--cli-input-json` value can be a file path, so its failure modes are
 * asserted here rather than discovered as a confusing nonzero exit inside a
 * scenario.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { readCliInputJson } from "./cli-input.js";

describe("readCliInputJson", () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "aws-mcp-cli-input-"));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // The argv shape runAwsCall builds, so a test reading this helper's output is
  // reading the same entry the real CLI would.
  const argvWith = (value: string): string[] => [
    "dynamodb",
    "put-item",
    "--output",
    "json",
    "--profile",
    "default",
    "--region",
    "us-east-1",
    "--cli-input-json",
    value,
  ];

  it("returns null when the call carries no params", () => {
    assert.equal(readCliInputJson(["sts", "get-caller-identity", "--output", "json"]), null);
  });

  it("parses an inline payload", () => {
    const json = JSON.stringify({ TableName: "t", Item: { id: { S: "1" } } });
    const r = readCliInputJson(argvWith(json));
    assert.ok(r);
    assert.equal(r.source, "inline");
    assert.equal(r.path, null);
    assert.equal(r.bytes, null);
    assert.equal(r.text, json);
    assert.deepEqual(r.params, { TableName: "t", Item: { id: { S: "1" } } });
  });

  it("reads a file:// payload and reports the path and bytes it read", () => {
    const path = join(dir, "params.json");
    // ASCII-only, as runAwsCall's temp file is: the real CLI reads a file://
    // value in the locale code page, so this is the only content on which the
    // fake and the real CLI agree byte for byte.
    const json = '{"TableName":"t","Item":{"note":{"S":"caf\\u00e9-\\u65e5\\u672c"}}}';
    writeFileSync(path, json);
    const r = readCliInputJson(argvWith(`file://${path}`));
    assert.ok(r);
    assert.equal(r.source, "file");
    assert.equal(r.path, path);
    assert.equal(r.text, json);
    assert.equal(r.bytes?.toString("utf8"), json);
    assert.deepEqual(r.params, { TableName: "t", Item: { note: { S: "café-日本" } } });
  });

  it("reads a fileb:// payload as bytes", () => {
    const path = join(dir, "params-b.json");
    const json = JSON.stringify({ Data: "aGVsbG8=" });
    writeFileSync(path, json, "utf8");
    const r = readCliInputJson(argvWith(`fileb://${path}`));
    assert.ok(r);
    assert.equal(r.source, "fileb");
    assert.equal(r.path, path);
    assert.deepEqual(r.params, { Data: "aGVsbG8=" });
    // fileb:// is the one form where the exact bytes matter to the caller.
    assert.ok(r.bytes instanceof Buffer);
    assert.equal(r.bytes?.length, Buffer.byteLength(json));
  });

  it("does not mistake fileb:// for file:// (the prefixes are checked in full)", () => {
    const path = join(dir, "which-prefix.json");
    writeFileSync(path, JSON.stringify({ a: 1 }));
    assert.equal(readCliInputJson(argvWith(`file://${path}`))?.source, "file");
    assert.equal(readCliInputJson(argvWith(`fileb://${path}`))?.source, "fileb");
    // Not a paramfile prefix at all: the CLI only expands the exact lower-case
    // forms, so anything else is a literal value -- and an invalid one here.
    assert.throws(() => readCliInputJson(argvWith(`FILE://${path}`)), /not valid JSON/);
  });

  it("names the flag when the value is missing entirely", () => {
    assert.throws(() => readCliInputJson(["dynamodb", "put-item", "--cli-input-json"]), {
      message: /^fake-aws: --cli-input-json is the last argv entry/,
    });
  });

  it("names the file when it cannot be read", () => {
    const missing = join(dir, "not-written.json");
    assert.throws(() => readCliInputJson(argvWith(`file://${missing}`)), {
      message: new RegExp(
        `^fake-aws: could not read the --cli-input-json file:// file '${missing.replace(/\\/g, "\\\\")}'`,
      ),
    });
  });

  it("names the origin when the JSON is malformed, inline or in a file", () => {
    assert.throws(() => readCliInputJson(argvWith("{not json")), {
      message: /^fake-aws: the --cli-input-json value is not valid JSON/,
    });
    const path = join(dir, "truncated.json");
    writeFileSync(path, '{"TableName":');
    assert.throws(() => readCliInputJson(argvWith(`file://${path}`)), {
      message: /^fake-aws: the --cli-input-json file '.*truncated\.json' is not valid JSON/,
    });
  });
});
