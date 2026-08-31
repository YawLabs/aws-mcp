/**
 * Bundles the MCP server into a single self-contained file.
 *
 * Why: `npx` has to install all runtime dependencies on every cold start.
 * By bundling everything into one file and declaring zero runtime dependencies,
 * npx downloads only the tarball and runs immediately.
 */

import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "dist/index.js",
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
  external: ["node:*"],
  // Defines a module-scope `require` in the ESM output.
  //
  // NOT for the AWS SDK -- this package has no @aws-sdk dependency at all.
  // Every AWS call is a subprocess to the `aws` binary; that is the whole
  // point of the zero-runtime-deps design. The old note here blamed
  // "@aws-sdk dist-cjs modules", which were never in this graph.
  //
  // The real reason is the CommonJS packages that ARE bundled. Nearly the
  // entire dependency graph is type=commonjs -- @modelcontextprotocol/sdk,
  // zod, zod-to-json-schema, ajv (+ ajv-formats, fast-uri,
  // json-schema-traverse, fast-deep-equal), turndown and its
  // @mixmark-io/domino -- and esbuild wraps each one in a __commonJS shim
  // (~130 of them in the current bundle). Where such a module performs a
  // DYNAMIC require, esbuild emits interop that falls back to a bare
  // `require`, which plain ESM output does not define; without this line that
  // path throws "Dynamic require of X is not supported" at run time.
  //
  // Honest status: at the current dependency set the emitted bundle contains
  // no such fallback, so today this is one line of insurance rather than a
  // load-bearing shim. It goes back to load-bearing the moment a bundled CJS
  // dependency introduces a dynamic require -- a dependency bump away, and a
  // failure that would only show up at run time in a published artifact. Keep
  // it; re-check with `grep "Dynamic require" dist/index.js` if you ever want
  // to know whether it is currently doing work.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  sourcemap: true,
  minify: false,
});
