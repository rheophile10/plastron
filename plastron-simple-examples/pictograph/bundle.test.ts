// Verifies the single-file bundling pipeline. Runs `bun bundle.ts`, then
// asserts the emitted dist/index.html is genuinely self-contained.
//
// Run from this directory:  bun test bundle.test.ts
// (Deliberately NOT part of the kernel suite under plastron-simple/test.)

import { test, beforeAll } from "bun:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const DIR = import.meta.dir;
const DIST = join(DIR, "dist");
const HTML = join(DIST, "index.html");

let html = "";
let bytes = 0;

beforeAll(async () => {
  const proc = Bun.spawnSync(["bun", "bundle.ts"], { cwd: DIR, stdout: "pipe", stderr: "pipe" });
  assert.equal(proc.exitCode, 0, `bundle failed:\n${proc.stderr.toString()}`);
  html = await readFile(HTML, "utf8");
  bytes = (await stat(HTML)).size;
});

test("bundle emits a single file in dist/", async () => {
  const entries = await readdir(DIST);
  assert.deepEqual(entries, ["index.html"], `dist/ should contain only index.html, found: ${entries.join(", ")}`);
});

test("output mounts at #app", () => {
  assert.match(html, /<div id="app">/);
});

test("output ships an inline module script with no src", () => {
  assert.match(html, /<script[^>]*type="module"[^>]*>/);
  // No <script> tag carries a src= attribute — everything is inlined.
  const srcScripts = html.match(/<script[^>]*\ssrc=/gi) ?? [];
  assert.equal(srcScripts.length, 0, "no <script src=…> should survive inlining");
});

test("output has no external stylesheet link", () => {
  const linkStyles = html.match(/<link[^>]*rel=["']stylesheet["'][^>]*>/gi) ?? [];
  assert.equal(linkStyles.length, 0, "stylesheets must be inlined as <style>");
});

test("output makes no external network request for code/assets", () => {
  // No http(s) URL pointing at a script/style/wasm asset. (Bare
  // dynamic import() specifiers for the externalized kind runtimes are
  // never executed by the formula-domain demo and resolve to nothing —
  // they are not network requests at load time.)
  const ext = html.match(/(src|href)=["']https?:\/\/[^"']+/gi) ?? [];
  assert.equal(ext.length, 0, `external asset refs found: ${ext.join(", ")}`);
});

test("bundle is under the 5 MB budget", () => {
  assert.ok(bytes > 0, "bundle is non-empty");
  assert.ok(bytes < 5 * 1024 * 1024, `bundle is ${(bytes / 1024 / 1024).toFixed(2)} MB, over budget`);
});

test("the boot entry actually computes the reactive graph (headless)", async () => {
  // Importing browser-main runs the real kernel boot (hydrate → precompute
  // → runCycle); the `document` guard skips rendering under bun. The
  // exported state proves the formula graph computed: price*qty = subtotal,
  // subtotal*tax-rate = tax, subtotal+tax = total.
  const { state } = await import("./browser-main.js");
  const v = (k: string) => Number(state.cels.get(k)?.v);
  const near = (got: number, want: number) =>
    assert.ok(Math.abs(got - want) < 1e-9, `expected ≈${want}, got ${got}`);
  assert.equal(v("subtotal"), 12);   // 3 * 4
  near(v("tax"), 1.2);               // 12 * 0.1 (float)
  near(v("total"), 13.2);            // 12 + 1.2
});

test("bundle includes both the app segment and the kernel", () => {
  // App segment data made it in…
  assert.match(html, /invoice/);
  assert.match(html, /subtotal/);
  // …and so did kernel machinery (a known boot-time error string from
  // createInitialState survives minification as a string literal).
  assert.match(html, /no loader is registered/);
});
