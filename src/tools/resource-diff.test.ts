import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyJsonPatch,
  type JsonPatchOp,
  type PatchChange,
  parseJsonPointer,
  resolvePointer,
  resourceTools,
  type SimulatedJsonPatchOp,
  summarizePatch,
} from "./resource.js";

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

  it("add at idx === array length appends (boundary: distinguishes > from >=)", () => {
    // RFC 6902 permits `add` at index === length (the slot just past the last
    // element) -- it's an append, identical to `/Tags/-`. The bounds guard is
    // `idx > parent.length` (strict): if it were `>=`, this exact case would
    // wrongly throw "out of bounds". Tags has length 2, so /Tags/2 is the
    // append boundary.
    const r = applyJsonPatch({ Tags: ["a", "b"] }, [{ op: "add", path: "/Tags/2", value: "c" }]);
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
  // applyJsonPatch now narrows to SimulatedJsonPatchOp (add/remove/replace), so
  // move/copy/test are type-unrepresentable at the call site. These tests pin
  // the runtime throw that stays as defense for callers who widen past the
  // type -- the explicit cast simulates that widening.
  it("move throws with a clear message", () => {
    const ops: JsonPatchOp[] = [{ op: "move", path: "/A", from: "/B" }];
    assert.throws(() => applyJsonPatch({ A: 1, B: 2 }, ops as SimulatedJsonPatchOp[]), /move.*not implemented/i);
  });

  it("copy throws", () => {
    const ops: JsonPatchOp[] = [{ op: "copy", path: "/B", from: "/A" }];
    assert.throws(() => applyJsonPatch({ A: 1 }, ops as SimulatedJsonPatchOp[]));
  });

  it("test throws", () => {
    const ops: JsonPatchOp[] = [{ op: "test", path: "/A", value: 1 }];
    assert.throws(() => applyJsonPatch({ A: 1 }, ops as SimulatedJsonPatchOp[]));
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

  it("reports per-op `after` for sequential replace on the same path", () => {
    // Two replaces on /X: op 0 sets it to 1, op 1 sets it to 2. The naive
    // implementation (resolve against final `after` doc) would report
    // after=2 for both ops. Per-op replay must show op 0 -> 1, op 1 -> 2.
    const before = { X: 0 };
    const after = { X: 2 };
    const changes = summarizePatch(
      [
        { op: "replace", path: "/X", value: 1 },
        { op: "replace", path: "/X", value: 2 },
      ],
      before,
      after,
    );
    assert.equal(changes.length, 2);
    assert.deepEqual(changes[0], { op: "replace", path: "/X", before: 0, after: 1 });
    assert.deepEqual(changes[1], { op: "replace", path: "/X", before: 0, after: 2 });
  });

  it("reports remove-then-add at same path with op 0 after = undefined", () => {
    // After op 0 (remove /X), the path is absent -- op 0's `after` must
    // reflect that, not the value op 1 puts back.
    const before = { X: "old" };
    const after = { X: "new" };
    const changes = summarizePatch(
      [
        { op: "remove", path: "/X" },
        { op: "add", path: "/X", value: "new" },
      ],
      before,
      after,
    );
    assert.equal(changes.length, 2);
    assert.deepEqual(changes[0], { op: "remove", path: "/X", before: "old", after: undefined });
    assert.deepEqual(changes[1], { op: "add", path: "/X", before: "old", after: "new" });
  });
});

describe("applyJsonPatch -- add auto-creates missing object parents", () => {
  it("creates intermediate objects when adding through a missing parent", () => {
    // CCAPI accepts /Environment/Variables/NEW even when /Environment is
    // absent. RFC 6902 is strict; we relax for `add` only.
    const r = applyJsonPatch({}, [{ op: "add", path: "/Environment/Variables/NEW_KEY", value: "v" }]);
    assert.deepEqual(r, { Environment: { Variables: { NEW_KEY: "v" } } });
  });

  it("creates intermediate objects when partial parent chain exists", () => {
    const r = applyJsonPatch({ Environment: {} }, [{ op: "add", path: "/Environment/Variables/NEW_KEY", value: "v" }]);
    assert.deepEqual(r, { Environment: { Variables: { NEW_KEY: "v" } } });
  });

  it("does NOT auto-create when traversing an empty array (index 0 missing)", () => {
    // `/list/0/foo` with /list present but empty: index 0 is out of
    // bounds, and array indices must never be auto-created. Must throw.
    assert.throws(() => applyJsonPatch({ list: [] }, [{ op: "add", path: "/list/0/foo", value: 1 }]));
  });

  it("replace still rejects a missing intermediate path", () => {
    assert.throws(() => applyJsonPatch({}, [{ op: "replace", path: "/Environment/Variables/X", value: 1 }]));
  });

  it("remove still rejects a missing intermediate path", () => {
    assert.throws(() => applyJsonPatch({}, [{ op: "remove", path: "/Environment/Variables/X" }]));
  });
});

describe("applyJsonPatch -- clearer intermediate array-bounds errors", () => {
  it("traversing past array length names the segment, length, and 'intermediate'", () => {
    // `add /Tags/2/foo` on Tags=["a","b"] tries to traverse INTO a not-yet-
    // existing array element (index 2 doesn't exist; the array has 2
    // elements at indices 0 and 1). The error should name the segment,
    // the array length, and call out the intermediate-traversal case so
    // it's distinguishable from final-token bounds errors.
    assert.throws(
      () => applyJsonPatch({ Tags: ["a", "b"] }, [{ op: "add", path: "/Tags/2/foo", value: 1 }]),
      (err: Error) => {
        const msg = err.message;
        // Names the path so the caller can find it.
        assert.match(msg, /\/Tags\/2\/foo/);
        // Names the offending segment.
        assert.match(msg, /segment '2'/);
        // Reports the array length.
        assert.match(msg, /length 2/);
        // Reports the bad index explicitly.
        assert.match(msg, /index 2/);
        // Distinguishes from the final-token "Add index ... out of bounds"
        // error by calling out the intermediate traversal explicitly.
        assert.match(msg, /intermediate|traverse into/i);
        return true;
      },
    );
  });

  it("non-integer intermediate array segment still rejects with a useful message", () => {
    assert.throws(
      () => applyJsonPatch({ Tags: ["a", "b"] }, [{ op: "add", path: "/Tags/notanint/foo", value: 1 }]),
      /Tags\/notanint\/foo/,
    );
  });
});

describe("summarizePatch -- per-op replay perf refactor", () => {
  it("produces identical output to the previous per-op clone path on a 50-op patch", () => {
    // Build a 50-op patch that exercises add/replace/remove on object keys
    // and array indices, then assert the refactored summarizePatch returns
    // the same shape and values it would have produced before. The previous
    // implementation called the public applyJsonPatch (which clones at
    // entry) once per op -- this version uses a single clone + in-place
    // replay. The diff list must be deep-equal.
    const before: Record<string, unknown> = {
      Counters: { a: 0, b: 0, c: 0, d: 0 },
      Tags: ["t0", "t1", "t2", "t3", "t4"],
      Meta: { keep: "yes", drop: "soon" },
    };

    const ops: SimulatedJsonPatchOp[] = [];
    // 40 alternating replace/add ops on Counters.*
    for (let i = 0; i < 40; i++) {
      const key = ["a", "b", "c", "d", `new${i}`][i % 5];
      if (i % 5 === 4) {
        ops.push({ op: "add", path: `/Counters/${key}`, value: i });
      } else {
        ops.push({ op: "replace", path: `/Counters/${key}`, value: i });
      }
    }
    // 5 array appends
    for (let i = 0; i < 5; i++) {
      ops.push({ op: "add", path: "/Tags/-", value: `tnew${i}` });
    }
    // 1 nested add through a missing parent
    ops.push({ op: "add", path: "/Nested/Inner/Leaf", value: "deep" });
    // 1 remove on Meta.drop
    ops.push({ op: "remove", path: "/Meta/drop" });
    // 3 replaces on the same path -- verifies per-op `after` snapshots
    // still reflect each op individually, not the final value.
    ops.push({ op: "replace", path: "/Meta/keep", value: "v1" });
    ops.push({ op: "replace", path: "/Meta/keep", value: "v2" });
    ops.push({ op: "replace", path: "/Meta/keep", value: "v3" });

    assert.equal(ops.length, 50);

    // Reference: run the patch end-to-end via the public applyJsonPatch
    // (which now goes through the in-place helper internally) and compute
    // the diff.
    const after = applyJsonPatch(before, ops);
    const fastChanges = summarizePatch(ops, before, after);

    // Manually compute the expected per-op `after` using a slow path that
    // clones the full doc per op -- exactly what the previous
    // summarizePatch did. The two must agree.
    let slowWorking: unknown = clone(before);
    const slowChanges: PatchChange[] = [];
    for (const op of ops) {
      const beforeAt = resolvePointer(before, op.path);
      // Slow: re-clone working copy through the public API each op.
      slowWorking = applyJsonPatch(slowWorking, [op]);
      let afterAt = resolvePointer(slowWorking, op.path);
      if (op.op === "add" && afterAt === undefined && op.path.endsWith("/-")) {
        afterAt = op.value;
      }
      slowChanges.push({ op: op.op as "add" | "remove" | "replace", path: op.path, before: beforeAt, after: afterAt });
    }

    assert.deepEqual(fastChanges, slowChanges);
    // Sanity: the three replace ops on /Meta/keep show their individual
    // `after` values, not all "v3".
    const keepChanges = fastChanges.filter((c) => c.path === "/Meta/keep");
    assert.equal(keepChanges.length, 3);
    assert.equal(keepChanges[0].after, "v1");
    assert.equal(keepChanges[1].after, "v2");
    assert.equal(keepChanges[2].after, "v3");
  });

  it("does not mutate the caller's `before` document during replay", () => {
    // Regression guard: the in-place refactor must still clone once at
    // entry to summarizePatch, so the caller's original object is never
    // touched.
    const before = { Counters: { a: 0 } };
    const ops: SimulatedJsonPatchOp[] = [
      { op: "replace", path: "/Counters/a", value: 1 },
      { op: "replace", path: "/Counters/a", value: 2 },
    ];
    const after = applyJsonPatch(before, ops);
    summarizePatch(ops, before, after);
    assert.equal(before.Counters.a, 0);
  });
});

// Local clone helper for the perf test above (avoids importing the
// internal one). Mirrors the implementation: JSON round-trip.
function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

describe("applyJsonPatch -- whole-document ops (path: '')", () => {
  // The `path: ""` branch is the RFC 6902 whole-document target. The helper
  // (a) clones and re-binds `root` for add/replace, (b) throws for remove
  // (you can't unset the root). Each case below pins one of those branches.
  it("replace at root swaps the entire document", () => {
    // before is an object; after is also an object but with completely
    // different shape -- the patch result must be the value verbatim, not
    // a merge.
    const r = applyJsonPatch({ A: 1, B: 2 }, [{ op: "replace", path: "", value: { C: 3 } }]);
    assert.deepEqual(r, { C: 3 });
  });

  it("replace at root can swap object for primitive", () => {
    // The wrapper reassigns its local `doc` so a primitive root is
    // observable to callers (the comment at _applyJsonPatchInPlace's
    // top calls this out explicitly).
    const r = applyJsonPatch({ A: 1 }, [{ op: "replace", path: "", value: "hello" }]);
    assert.equal(r, "hello");
  });

  it("add at root behaves the same as replace (sets the document)", () => {
    // RFC 6902 says add at root replaces the target -- there's no
    // semantic difference at the root because there's nowhere to insert.
    const r = applyJsonPatch({ A: 1 }, [{ op: "add", path: "", value: { B: 2 } }]);
    assert.deepEqual(r, { B: 2 });
  });

  it("remove at root throws 'Cannot remove the document root'", () => {
    // The error must name "root" so the caller understands they hit the
    // whole-document remove branch rather than a missing-key error.
    assert.throws(() => applyJsonPatch({ A: 1 }, [{ op: "remove", path: "" }]), /Cannot remove the document root/);
  });

  it("does not mutate the caller's original on whole-document replace", () => {
    const original = { A: 1 };
    applyJsonPatch(original, [{ op: "replace", path: "", value: { B: 2 } }]);
    assert.deepEqual(original, { A: 1 });
  });

  it("add at root materializes the document when the original is undefined", () => {
    // applyJsonPatch clones `undefined` (clone() returns undefined for it), so
    // the working root starts undefined. A whole-document `add` then sets the
    // root to the cloned value -- the result is the value verbatim, NOT a
    // merge against a (nonexistent) prior document.
    const r = applyJsonPatch(undefined, [{ op: "add", path: "", value: { X: 1 } }]);
    assert.deepEqual(r, { X: 1 });
  });

  it("replace at root materializes the document when the original is undefined", () => {
    // RFC 6902 add/replace collapse to the same reassignment at the root, so
    // `replace` on an undefined original behaves like `add` -- it sets the
    // document rather than throwing on a missing target.
    const r = applyJsonPatch(undefined, [{ op: "replace", path: "", value: { Y: 2 } }]);
    assert.deepEqual(r, { Y: 2 });
  });
});

describe("applyJsonPatch -- specific error paths", () => {
  it("remove on '-' (end-of-array marker) throws 'Cannot remove'", () => {
    // RFC 6901's '-' is a WRITE-ONLY pointer (append). Remove on it has
    // no defined target, so the helper must reject it explicitly rather
    // than silently no-op or pop the last element. The error message
    // must name '-' so the caller can spot the bad pointer.
    assert.throws(() => applyJsonPatch({ list: [] }, [{ op: "remove", path: "/list/-" }]), /Cannot remove '-'/);
  });

  it("intermediate traversal through a non-container (string) throws", () => {
    // 3+ tokens so the parent-walk loop runs and hits a string in the
    // middle. /A is a string, so descending into /A/B during the walk
    // (looking for /A/B/C's parent) hits the else-branch that says
    // "traverses a non-container value at index i" -- distinct from
    // the final-token "parent is not a container" message below.
    assert.throws(
      () => applyJsonPatch({ A: "string-not-object" }, [{ op: "add", path: "/A/B/C", value: 1 }]),
      /traverses a non-container value/,
    );
  });

  it("intermediate traversal through a non-container (number) throws", () => {
    // Same branch, different primitive -- guards against the check
    // being string-specific.
    assert.throws(
      () => applyJsonPatch({ A: 42 }, [{ op: "replace", path: "/A/B/C", value: 1 }]),
      /traverses a non-container value/,
    );
  });

  it("final-token op on a primitive parent throws 'parent is not a container'", () => {
    // Distinct from the intermediate-traversal branch above: a SINGLE-token
    // path means the parent-walk loop never runs, so `parent` stays as the
    // root. When the root is itself a primitive (string/number), the final
    // dispatch falls through to the else-branch that says "parent is not a
    // container" -- the message at the very end of _applyJsonPatchInPlace,
    // NOT the mid-walk "traverses a non-container value" one.
    assert.throws(() => applyJsonPatch("hello", [{ op: "add", path: "/key", value: 1 }]), /parent is not a container/);
  });

  it("final-token op on a numeric primitive root also throws 'parent is not a container'", () => {
    // Same final-token branch, numeric root -- guards against the check being
    // string-specific and pins that the message is the parent-not-a-container
    // one rather than the intermediate-traversal wording.
    assert.throws(
      (): unknown => applyJsonPatch(42, [{ op: "replace", path: "/key", value: 1 }]),
      (err: Error) => {
        assert.match(err.message, /parent is not a container/);
        assert.doesNotMatch(err.message, /traverses a non-container value/);
        return true;
      },
    );
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

  it("does not reject typeName at schema level (handler validates)", () => {
    const r = diffTool.inputSchema.safeParse({
      typeName: "lambda::function",
      identifier: "x",
      patchDocument: [{ op: "replace", path: "/A", value: 1 }],
    });
    assert.equal(r.success, true); // schema-level passes (it's a string); validation happens in handler
  });

  it("rejects move/copy/test ops at schema (diff only simulates add/remove/replace locally)", () => {
    // Sibling aws_resource_update accepts the full RFC 6902 op set because
    // CCAPI does. aws_resource_diff is the strict one -- only the subset
    // applyJsonPatch can simulate. Catch at schema so the model gets a
    // clean "invalid enum" error instead of "Patch application failed".
    for (const op of ["move", "copy", "test"] as const) {
      const r = diffTool.inputSchema.safeParse({
        typeName: "AWS::Lambda::Function",
        identifier: "my-fn",
        patchDocument: [{ op, path: "/A", from: "/B" }],
      });
      assert.equal(r.success, false, `expected schema to reject op '${op}'`);
    }
  });
});
