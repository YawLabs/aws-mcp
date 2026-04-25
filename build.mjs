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
  // AWS SDK ships dist-cjs modules that use `require("buffer")` etc. When
  // bundled into ESM output, esbuild emits a __require2 wrapper that falls
  // back to the global `require` if defined. This banner makes `require`
  // available at the top of the module via createRequire, so those runtime
  // dynamic requires resolve against Node's built-in resolver.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  sourcemap: true,
  minify: false,
});
