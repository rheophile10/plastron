// ============================================================================
// inline-assets — post-build pass (design Option B). Folds every local
// asset Bun emitted alongside dist/index.html back INTO it, producing a
// single self-contained HTML file with zero external local references.
//
// Handles:
//   • <script src="local.js">          → <script type="module">…</script>
//   • <link rel="stylesheet" href=…>   → <style>…</style>
//   • residual src=/href= to local files → base64 data: URI
// Leaves http(s):// references untouched (there should be none).
// ============================================================================

import { readFile, writeFile, unlink, readdir } from "node:fs/promises";
import { join, dirname, basename } from "node:path";

const isLocal = (url: string): boolean =>
  !/^(https?:)?\/\//.test(url) && !url.startsWith("data:") && !url.startsWith("#");

// Inlining JS into a <script> element: a literal "</script>" anywhere in
// the bytes (e.g. inside a string) would terminate the element early.
const escapeForScript = (js: string): string =>
  js.replace(/<\/(script)/gi, "<\\/$1");

const mimeFor = (file: string): string => {
  if (file.endsWith(".wasm")) return "application/wasm";
  if (file.endsWith(".css")) return "text/css";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
};

export async function inlineAssets(htmlPath: string): Promise<void> {
  const dir = dirname(htmlPath);
  let html = await readFile(htmlPath, "utf8");
  const consumed = new Set<string>();

  const readAsset = async (url: string): Promise<Uint8Array | undefined> => {
    const file = join(dir, basename(url.split("?")[0]));
    try {
      const bytes = await readFile(file);
      consumed.add(file);
      return bytes;
    } catch { return undefined; }
  };

  // 1. <script ... src="local"> → inline module
  html = await replaceAsync(
    html,
    /<script\b([^>]*?)\ssrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi,
    async (whole, pre, url, post) => {
      if (!isLocal(url)) return whole;
      const bytes = await readAsset(url);
      if (!bytes) return whole;
      const attrs = `${pre} ${post}`.replace(/\stype=["'][^"']*["']/i, "").trim();
      const typeAttr = /\bnomodule\b/.test(whole) ? "" : ' type="module"';
      const js = escapeForScript(new TextDecoder().decode(bytes));
      return `<script${typeAttr}${attrs ? " " + attrs : ""}>\n${js}\n</script>`;
    },
  );

  // 2. <link rel="stylesheet" href="local"> → inline <style>
  html = await replaceAsync(
    html,
    /<link\b([^>]*?)\shref=["']([^"']+)["']([^>]*)>/gi,
    async (whole, _pre, url) => {
      if (!/rel=["']stylesheet["']/i.test(whole) || !isLocal(url)) return whole;
      const bytes = await readAsset(url);
      if (!bytes) return whole;
      return `<style>\n${new TextDecoder().decode(bytes)}\n</style>`;
    },
  );

  // 3. residual local src=/href= → base64 data: URI
  html = await replaceAsync(
    html,
    /\b(src|href)=["']([^"']+)["']/gi,
    async (whole, attr, url) => {
      if (!isLocal(url)) return whole;
      const bytes = await readAsset(url);
      if (!bytes) return whole;
      const b64 = Buffer.from(bytes).toString("base64");
      return `${attr}="data:${mimeFor(url)};base64,${b64}"`;
    },
  );

  await writeFile(htmlPath, html, "utf8");

  // Delete the now-orphaned sidecar files Bun emitted (everything in
  // dist/ except the consolidated index.html).
  for (const entry of await readdir(dir)) {
    const full = join(dir, entry);
    if (full === htmlPath) continue;
    if (consumed.has(full)) { await unlink(full); continue; }
    // Any leftover emitted asset (e.g. a sourcemap) — drop it too so the
    // deliverable is genuinely one file.
    if (entry !== basename(htmlPath)) {
      try { await unlink(full); } catch { /* dir or in-use — ignore */ }
    }
  }
}

// String.prototype.replace with async replacer support.
async function replaceAsync(
  input: string,
  re: RegExp,
  replacer: (...m: string[]) => Promise<string>,
): Promise<string> {
  const tasks: Promise<string>[] = [];
  input.replace(re, (...args: unknown[]) => {
    tasks.push(replacer(...(args.slice(0, -2) as string[])));
    return "";
  });
  const results = await Promise.all(tasks);
  let i = 0;
  return input.replace(re, () => results[i++]);
}
