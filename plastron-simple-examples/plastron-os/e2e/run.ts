// ============================================================================
// e2e/run.ts — orchestrate the Playwright e2e suite.
//
//   1. Bundle dist/index.html (if it's stale).
//   2. Boot the dev server on a free localhost port.
//   3. Wait until it answers /index.html with HTTP 200.
//   4. Run the scenarios from ./scenarios.ts against the live server.
//   5. Tear the server down and propagate the exit code.
//
// The system google-chrome is used as Chromium (Playwright's browser download
// requires npm network); the symlinks in ../node_modules let us import
// "playwright" cleanly without an install step.
// ============================================================================

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;
const bundlePath = join(repoRoot, "dist/index.html");
const port = Number(process.env.PORT ?? 5173);
const baseURL = `http://localhost:${port}`;

// Wipe the node-fs store between runs — Playwright's BrowserContext gets a
// fresh OPFS, but the server side (when bun is the runtime) writes to
// ./.plastron-fs. Without this, names left over from a previous run would
// shadow the test's tag-based names if they happened to collide.
import { rmSync } from "node:fs";
const fsRoot = join(repoRoot, ".plastron-fs");
try { rmSync(fsRoot, { recursive: true, force: true }); } catch { /* noop */ }

const distStale = (): boolean => {
  if (!existsSync(bundlePath)) return true;
  const distMtime = statSync(bundlePath).mtimeMs;
  // Rebuild if any TS source is newer than dist/index.html.
  for (const f of ["browser-main.ts", "sheets.ts", "file-toolbar.ts", "file-explorer.ts", "doc-binding.ts", "desktop.ts"]) {
    const p = join(repoRoot, f);
    if (existsSync(p) && statSync(p).mtimeMs > distMtime) return true;
  }
  return false;
};

if (distStale()) {
  console.log("📦 dist is stale — rebundling...");
  const r = Bun.spawnSync(["bun", join(repoRoot, "bundle.ts")], { cwd: repoRoot, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
}

console.log(`🌐 starting dev server on port ${port}...`);
const server = spawn("bun", [join(repoRoot, "serve.ts")], {
  cwd: repoRoot,
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "inherit"],
});
let serverReady = false;
server.stdout?.on("data", (b: Buffer) => { if (b.toString().includes(`localhost:${port}`)) serverReady = true; });

const waitReady = async (): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (serverReady) {
      try {
        const r = await fetch(`${baseURL}/index.html`);
        if (r.ok) return;
      } catch { /* keep polling */ }
    }
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`dev server did not become ready on ${baseURL} within 5s`);
};

let exitCode = 1;
try {
  await waitReady();
  console.log("✅ server ready, running scenarios...\n");
  const { runScenarios } = await import("./scenarios.ts");
  exitCode = await runScenarios(baseURL);
} catch (e) {
  console.error("❌ e2e crashed:", e);
  exitCode = 1;
} finally {
  server.kill("SIGTERM");
  await new Promise((res) => setTimeout(res, 200));
}

process.exit(exitCode);
