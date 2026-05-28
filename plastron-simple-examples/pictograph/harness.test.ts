// Browser harness — drives the bundled single-file app in real headless
// Chrome via playwright-core pointed at the system google-chrome (no browser
// download). Serves the bundle over http://127.0.0.1 so OPFS works (a secure
// context WITH a real origin; file:// is a secure context but its opaque
// "null" origin makes getDirectory() throw SecurityError). Run from this dir:
//   bun run harness        (needs google-chrome installed)
//
// Covers the 10-deployment/browser-harness.md claims that need a real browser.

import { test, beforeAll, afterAll } from "bun:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

const DIR = import.meta.dir;
const HTML = join(DIR, "dist", "index.html");
const CHROME = process.env.CHROME_BIN ?? "/usr/bin/google-chrome";

let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
let page: Page;
let baseUrl: string;

beforeAll(async () => {
  // Rebuild so the bundle includes the latest browser-main (with the
  // window.__plastron test hook).
  const built = Bun.spawnSync(["bun", "bundle.ts"], { cwd: DIR, stdout: "pipe", stderr: "pipe" });
  assert.equal(built.exitCode, 0, `bundle failed:\n${built.stderr.toString()}`);
  const html = await readFile(HTML, "utf8");

  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
  });
  baseUrl = `http://127.0.0.1:${server.port}/`;

  browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  page = await browser.newPage();
  await page.goto(baseUrl);
  await page.waitForFunction(`!!window.__plastron`);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

test("the bundled app renders #app in a real browser", async () => {
  const text = await page.evaluate(`document.querySelector("#app")?.textContent ?? ""`);
  assert.match(text as string, /single-file reactive demo/);
  assert.match(text as string, /subtotal/);
});

test("the reactive graph computed in-browser (subtotal = price*qty)", async () => {
  const subtotal = await page.evaluate(`(() => {
    const row = [...document.querySelectorAll("#computed tbody tr")].find(r => r.children[0].textContent.trim() === "subtotal");
    return row?.children[1].textContent.trim() ?? "";
  })()`);
  assert.equal(subtotal, "12"); // 3 * 4
});

test("editing an input recomputes the dependent cell in the live DOM", async () => {
  await page.fill('input[data-key="price"]', "5"); // fires a real input event
  await page.waitForFunction(`(() => {
    const row = [...document.querySelectorAll("#computed tbody tr")].find(r => r.children[0].textContent.trim() === "total");
    return row?.children[1].textContent.trim() === "22";
  })()`, { timeout: 5000 }); // price 5 * qty 4 = 20; tax 2; total 22
});

test("OPFS is available AND usable over the http://127.0.0.1 origin", async () => {
  const result = await page.evaluate(`(async () => {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle("__probe", { create: true });
    const w = await fh.createWritable(); await w.write("x"); await w.close();
    return "ok";
  })()`);
  assert.equal(result, "ok");
});

test("fs.* round-trips through the OPFS backend in-browser", async () => {
  const out = await page.evaluate(`(async () => {
    const { resolveFn } = window.__plastron;
    await resolveFn("fs.writeText")("harness/probe.txt", "hi-✓");
    return await resolveFn("fs.readText")("harness/probe.txt");
  })()`);
  assert.equal(out, "hi-✓");
});

test("store.* round-trips through OPFS-backed file-store in-browser", async () => {
  const name = await page.evaluate(`(async () => {
    const { resolveFn } = window.__plastron;
    const manifest = { name: "hx", version: "1.0.0", description: "harness", dependencies: [], role: "library" };
    await resolveFn("store.put")("hx", "1.0.0", manifest, { name: "hx", cels: [] });
    const got = await resolveFn("store.get")("hx");
    return got?.manifest?.name ?? "(undefined)";
  })()`);
  assert.equal(name, "hx");
});

test("OPFS state survives a page reload", async () => {
  await page.evaluate(`window.__plastron.resolveFn("fs.writeText")("harness/persist.txt", "persisted")`);
  await page.reload();
  await page.waitForFunction(`!!window.__plastron`);
  const out = await page.evaluate(`window.__plastron.resolveFn("fs.readText")("harness/persist.txt")`);
  assert.equal(out, "persisted");
}, 30_000);
