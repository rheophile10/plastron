import { join } from "node:path";
const DIR = import.meta.dir, DIST = join(DIR, "dist");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".map":  "application/json",
};
const ext = (p: string) => { const i = p.lastIndexOf("."); return i < 0 ? "" : p.slice(i); };
const server = Bun.serve({
  port: Number(process.env.PORT ?? 3003),
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const f = Bun.file(join(DIST, path));
    if (!(await f.exists())) return new Response("not found", { status: 404 });
    const ct = MIME[ext(path)];
    return new Response(f, ct ? { headers: { "Content-Type": ct } } : undefined);
  },
});
console.log(`→ http://localhost:${server.port}  (serving ${DIST})`);
