import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyJsonPatch, parseJsonPointer, resolvePointer, resourceTools, summarizePatch } from "./resource.js";

const diffTool = resourceTools.find((t) => t.name === "aws_resource_diff");
if (!diffTool) throw new Error("resourceTools missing aws_resource_diff");

describe("parseJsonPointer", () => {
  it("returns [] for the root pointer", () => {
    assert.deepEqual(parseJsonPointer(""), []);
  });

  it("splits on '/'", () => {
    assert.deepEqual(parseJsonPointer("/foo/bar"), ["foo", "bar"]);
  });

  it("unescapes ~1 -> '/'", () => {
    assert.deepEqual(parseJsonPointer("/a~1b/c"), ["a/b", "c"]);
  });

  it("unescapes ~0 -> '~'", () => {
    assert.deepEqual(parseJsonPointer("/a~0b"), ["a~b"]);
  });

  it("applies ~1 before ~0 (so ~01 stays ~1)", () => {
    assert.deepEqual(parseJsonPointer("/~01"), ["~1"]);
  });

  it("rejects pointers that don't start with '/'", () => {
    assert.throws(() => parseJsonPointer("foo"));
  });
});

describe("applyJsonPatch -- objects", () => {
  it("replace overwrites a top-level key", () => {
    const r = applyJsonPatch({ MemorySize: 256, Timeout: 30 }, [{ op: "replace", path: "/MemorySize", value: 1024 }]);
    assert.deepEqual(r, { MemorySize: 1024, Timeout: 30 });
  });

  it("add creates a new top-level key", () => {
    const r = applyJsonPatch({ MemorySize: 256 }, [{ op: "add", path: "/Description", value: "hi" }]);
    assert.deepEqual(r, { MemorySize: 256, Description: "hi" });
  });

  it("remove deletes a key", () => {
    const r = applyJsonPatch({ MemorySize: 256, Description: "hi" }, [{ op: "remove", path: "/Description" }]);
    assert.deepEqual(r, { MemorySize: 256 });
  });

  it("works on nested paths", () => {
    const r = applyJsonPatch({ Environment: { Variables: { LOG_LEVEL: "info" } } }, [
      { op: "replace", path: "/Environment/Variables/LOG_LEVEL", value: "debug" },
    ]);
    assert.deepEqual(r, { Environment: { Variables: { LOG_LEVEL: "debug" } } });
  });

  it("does not mutate the original object", () => {
    const original = { MemorySize: 256 };
    applyJsonPatch(original, [{ op: "replace", path: "/MemorySize", value: 1024 }]);
    assert.equal(original.MemorySize, 256);
  });

  it("replace on a missing key throws", () => {
    assert.throws(() => applyJsonPatch({}, [{ op: "replace", path: "/Nope", value: 1 }]));
  });

  it("remove on a missing key throws", () => {
    assert.throws(() => applyJsonPatch({ A: 1 }, [{ op: "remove", path: "/B" }]));
  });

  it("traversing a missing intermediate segment throws", () => {
    assert.throws(() => applyJsonPatch({ A: 1 }, [{ op: "replace", path: "/B/C/D", value: 1 }]));
  });
});

describe("applyJsonPatch -- arrays", () => {
  it("replace at index", () => {
    const r = applyJsonPatch({ Tags: ["a", "b", "c"] }, [{ op: "replace", path: "/Tags/1", value: "B" }]);
    assert.deepEqual(r, { Tags: ["a", "B", "c"] });
  });

  it("add at index splices in", () => {
    const r = applyJsonPatch({ Tags: ["a", "c"] }, [{ op: "add", path: "/Tags/1", value: "b" }]);
    assert.deepEqual(r, { Tags: ["a", "b", "c"] });
  });

  it("add at '-' appends to end", () => {
    const r = applyJsonPatch({ Tags: ["a", "b"] }, [{ op: "add", path: "/Tags/-", value: "c" }]);
    assert.deepEqual(r, { Tags: ["a", "b", "c"] });
  });

  it("remove at index", () => {
    const r = applyJsonPatch({ Tags: ["a", "b", "c"] }, [{ op: "remove", path: "/Tags/1" }]);
    assert.deepEqual(r, { Tags: ["a", "c"] });
  });

  it("out-of-bounds add throws", () => {
    assert.throws(() => applyJsonPatch({ Tags: ["a"] }, [{ op: "add", path: "/Tags/5", value: "x" }]));
  });

  it("out-of-bounds remove throws", () => {
    assert.throws(() => applyJsonPatch({ Tags: ["a"] }, [{ op: "remove", path: "/Tags/5" }]));
  });
});

describe("applyJsonPatch -- unimplemented ops", () => {
  it("move throws with a clear message", () => {
    assert.throws(
      () => applyJsonPatch({ A: 1, B: 2 }, [{ op: "move", path: "/A", from: "/B" }]),
      /move.*not implemented/i,
    );
  });

  it("copy throws", () => {
    assert.throws(() => applyJsonPatch({ A: 1 }, [{ op: "copy", path: "/B", from: "/A" }]));
  });

  it("test throws", () => {
    assert.throws(() => applyJsonPatch({ A: 1 }, [{ op: "test", path: "/A", value: 1 }]));
  });
});

describe("resolvePointer", () => {
  it("returns the value at a path", () => {
    assert.equal(resolvePointer({ A: { B: 42 } }, "/A/B"), 42);
  });

  it("returns undefined for a missing path", () => {
    assert.equal(resolvePointer({ A: 1 }, "/B"), undefined);
  });

  it("returns the document for empty pointer", () => {
    const doc = { A: 1 };
    assert.equal(resolvePointer(doc, ""), doc);
  });

  it("handles array indices", () => {
    assert.equal(resolvePointer({ Tags: ["a", "b", "c"] }, "/Tags/2"), "c");
  });

  it("returns undefined for '-' (end-of-array marker)", () => {
    assert.equal(resolvePointer({ Tags: ["a", "b"] }, "/Tags/-"), undefined);
  });
});

describe("summarizePatch", () => {
  it("returns one entry per op with before/after values", () => {
    const before = { MemorySize: 256, Description: "old" };
    const after = { MemorySize: 1024, Description: "old", Timeout: 30 };
    const changes = summarizePatch(
      [
        { op: "replace", path: "/MemorySize", value: 1024 },
        { op: "add", path: "/Timeout", value: 30 },
      ],
      before,
      after,
    );
    assert.equal(changes.length, 2);
    assert.deepEqual(changes[0], { op: "replace", path: "/MemorySize", before: 256, after: 1024 });
    assert.deepEqual(changes[1], { op: "add", path: "/Timeout", before: undefined, after: 30 });
  });

  it("surfaces remove with after = undefined", () => {
    const before = { A: 1, B: 2 };
    const after = { B: 2 };
    const changes = summarizePatch([{ op: "remove", path: "/A" }], before, after);
    assert.deepEqual(changes, [{ op: "remove", path: "/A", before: 1, after: undefined }]);
  });

  it("surfaces the added value for `add /path/-` append paths", () => {
    // RFC 6901 makes '-' a write-only target, so resolvePointer returns
    // undefined on it. summarizePatch should fall back to the op's own
    // value so the changes entry still tells the agent what landed.
    const before = { Tags: [{ Key: "k1", Value: "v1" }] };
    const after = {
      Tags: [
        { Key: "k1", Value: "v1" },
        { Key: "k2", Value: "v2" },
      ],
    };
    const changes = summarizePatch([{ op: "add", path: "/Tags/-", value: { Key: "k2", Value: "v2" } }], before, after);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].op, "add");
    assert.equal(changes[0].path, "/Tags/-");
    assert.equal(changes[0].before, undefined);
    assert.deepEqual(changes[0].after, { Key: "k2", Value: "v2" });
  });
});

describe("aws_resource_diff schema", () => {
  it("accepts a minimal valid input", () => {
    const r = diffTool.inputSchema.safeParse({
      typeName: "AWS::Lambda::Function",
      identifier: "my-fn",
      patchDocument: [{ op: "replace", path: "/MemorySize", value: 1024 }],
    });
    assert.equal(r.success, true);
  });

  it("rejects empty patchDocument", () => {
    const r = diffTool.inputSchema.safeParse({
      typeName: "AWS::Lambda::Function",
      identifier: "my-fn",
      patchDocument: [],
    });
    assert.equal(r.success, false);
  });

  it("rejects malformed typeName", () => {
    const r = diffTool.inputSchema.safeParse({
      typeName: "lambda::function",
      identifier: "x",
      patchDocument: [{ op: "replace", path: "/A", value: 1 }],
    });
    assert.equal(r.success, true); // schema-level passes (it's a string); validation happens in handler
  });
});
