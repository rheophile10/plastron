// Tiny static server for the bundled dist/. Run with `bun serve.ts`
// after `bun run bundle` (or use `bun run dev` to do both).

import { join } from "node:path";

const DIR  = import.meta.dir;
const DIST = join(DIR, "dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".map":  "application/json",
};

const ext = (p: string): string => {
  const i = p.lastIndexOf(".");
  return i < 0 ? "" : p.slice(i);
};

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3001),
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname;
    if (path === "/") path = "/index.html";
    const f = Bun.file(join(DIST, path));
    if (!(await f.exists())) return new Response("not found", { status: 404 });
    const ct = MIME[ext(path)];
    return new Response(f, ct ? { headers: { "Content-Type": ct } } : undefined);
  },
});

console.log(`→ http://localhost:${server.port}`);
console.log(`  (serving ${DIST})`);
