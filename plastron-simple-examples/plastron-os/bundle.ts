// ============================================================================
// bundle — produce a single self-contained dist/index.html.
//
//   bun run bundle
//
// Bun's HTML-entrypoint bundler does the heavy lifting (bundles
// browser-main.ts + the kernel reachable from it, target=browser,
// minified). inline-assets.ts then folds every emitted sidecar back
// into the HTML so the deliverable is ONE file that runs off `file://`.
//
// The heavy, dynamic-imported kind runtimes are marked `external`:
// the kernel statically imports the wat / py / quickjs compiler SEGMENTS
// (small), but each only `import()`s its runtime (wabt ~1 MB, Pyodide
// ~10 MB, quickjs-emscripten) on first compile of that kind. The
// formula-domain demo never triggers them, so leaving the import()s
// external keeps them out of the static bundle without breaking the
// build. node:* specifiers (file-store's node-fs backend) are external
// for the same reason — the browser selects the OPFS backend.
// ============================================================================

import { join } from "node:path";
import { rm, readdir } from "node:fs/promises";
import { inlineAssets } from "./inline-assets.js";

const OUT = join(import.meta.dir, "dist");
const HTML = join(OUT, "index.html");
const BUDGET = 5 * 1024 * 1024; // 5 MB

await rm(OUT, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "index.html")],
  outdir: OUT,
  target: "browser",
  minify: true,
  sourcemap: "none",
  external: ["pyodide", "quickjs-emscripten", "wabt", "node:fs/promises", "node:path"],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("bundle: Bun.build failed");
}

await inlineAssets(HTML);

const bytes = (await Bun.file(HTML).bytes()).length;
const leftovers = (await readdir(OUT)).filter((f) => f !== "index.html");

console.log(`✔ dist/index.html — ${(bytes / 1024).toFixed(1)} KB`);
if (leftovers.length) {
  throw new Error(`bundle: expected a single file, found extra: ${leftovers.join(", ")}`);
}
if (bytes > BUDGET) {
  throw new Error(`bundle: ${(bytes / 1024 / 1024).toFixed(2)} MB exceeds the 5 MB budget`);
}
