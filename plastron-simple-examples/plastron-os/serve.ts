// ============================================================================
// serve.ts — a 30-line dev server for the bundled single-file index.html.
//
// Why: opening `dist/index.html` via `file://` fails — Chrome treats each
// file: URL as a unique opaque origin, the bundle's own script can't run, and
// OPFS (which segment-store needs for the file-store backend in the browser)
// requires a secure HTTP origin. This serves dist/ over http://localhost:5173
// so the browser sees a normal origin and OPFS works.
//
// Usage:  bun serve.ts            # default port 5173
//         PORT=8080 bun serve.ts  # override
// Then open http://localhost:5173.
// ============================================================================

import { join } from "node:path";
import { readFile, stat } from "node:fs/promises";

const port = Number(process.env.PORT ?? 5173);
const dist = new URL("./dist/", import.meta.url).pathname;
// Doom's wasm + WAD live in the sibling doom example, NOT in our bundle.
// We proxy them on demand so the OS's Doom app can `fetch("./doom.wasm")` and
// `fetch("./freedoom1.wad")` against this same origin. The WAD is the user's
// (a symlink at plastron-simple-examples/doom/freedoom1.wad).
const doomDir = new URL("../doom/", import.meta.url).pathname;

const mime = (p: string): string =>
  p.endsWith(".html") ? "text/html; charset=utf-8" :
  p.endsWith(".js")   ? "text/javascript; charset=utf-8" :
  p.endsWith(".css")  ? "text/css; charset=utf-8" :
  p.endsWith(".json") ? "application/json; charset=utf-8" :
  p.endsWith(".svg")  ? "image/svg+xml" :
  p.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";

const respond = async (file: string): Promise<Response> => {
  const s = await stat(file);
  if (!s.isFile()) return new Response("Not Found", { status: 404 });
  const body = await readFile(file);
  return new Response(body, {
    headers: {
      "Content-Type": mime(file),
      // Headers OPFS / SharedArrayBuffer / cross-origin isolation need.
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  });
};

Bun.serve({
  port,
  async fetch(req: Request): Promise<Response> {
    let path = new URL(req.url).pathname;

    // Doom assets — served from the sibling example dir.
    if (path === "/doom.wasm") {
      try { return await respond(join(doomDir, "doom.wasm")); }
      catch { return new Response("doom.wasm not built — see plastron-simple-examples/doom/README.md", { status: 404 }); }
    }
    if (/^\/[\w.-]+\.wad$/i.test(path)) {
      try { return await respond(join(doomDir, path.slice(1))); }
      catch { return new Response(`${path.slice(1)} not present (symlink one into plastron-simple-examples/doom/ — see README)`, { status: 404 }); }
    }

    if (path === "/") path = "/index.html";
    try { return await respond(join(dist, path)); }
    catch { return new Response("Not Found", { status: 404 }); }
  },
});

console.log(`📦 plastron-OS dev server: http://localhost:${port}`);
console.log(`    serving ${dist}`);
console.log(`    doom assets from ${doomDir}`);
console.log(`    Ctrl-C to stop.`);
