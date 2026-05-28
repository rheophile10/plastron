// Tiny static server for the bundled dist/. Serves doom.wasm from the
// example root (it's not bundled — it's a runtime fetch). Run with
// `bun serve.ts` after `bun run bundle`.

import { join } from "node:path";

const DIR  = import.meta.dir;
const DIST = join(DIR, "dist");
const WASM = join(DIR, "doom.wasm");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".map":  "application/json",
};

const ext = (p: string): string => {
  const i = p.lastIndexOf(".");
  return i < 0 ? "" : p.slice(i);
};

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname;

    // doom.wasm and *.wad (the IWAD) live at the example root, not in
    // dist/. doom.wasm is from the factory build; the .wad is a symlink
    // to ~/test-wads/… (see README — never committed).
    if (path === "/doom.wasm") {
      const f = Bun.file(WASM);
      if (!(await f.exists())) {
        return new Response(
          "doom.wasm not present. Build it with `bash ~/projects/wasm-factory/doom/build.sh`,\n" +
          "then `cp ~/projects/wasm-factory/dist/doom.wasm ./` from this folder.",
          { status: 404 },
        );
      }
      return new Response(f, { headers: { "Content-Type": "application/wasm" } });
    }
    if (/^\/[\w.-]+\.wad$/i.test(path)) {
      const f = Bun.file(join(DIR, path.slice(1)));
      if (!(await f.exists())) {
        return new Response(
          `${path.slice(1)} not present here. Either symlink one in (see README:\n` +
          `  ln -s ~/test-wads/freedoom-0.13.0/freedoom1.wad ./freedoom1.wad\n` +
          `) or pick a WAD with the file input on the page.`,
          { status: 404 },
        );
      }
      return new Response(f, { headers: { "Content-Type": "application/octet-stream" } });
    }

    if (path === "/") path = "/index.html";
    const f = Bun.file(join(DIST, path));
    if (!(await f.exists())) return new Response("not found", { status: 404 });
    const ct = MIME[ext(path)];
    return new Response(f, ct ? { headers: { "Content-Type": ct } } : undefined);
  },
});

console.log(`→ http://localhost:${server.port}`);
console.log(`  (serving ${DIST}; doom.wasm from ${DIR})`);
