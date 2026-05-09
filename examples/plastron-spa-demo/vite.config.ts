import { defineConfig } from "vite";

// The kernel and plastron-dom are siblings in the repo; allow Vite to
// import their TypeScript sources directly via relative paths from
// src/. They depend on `zod`, which we declare as a direct dep so
// Vite's resolution can find it.
export default defineConfig({
  server: { port: 5173 },
  build: {
    sourcemap: true,
    // Top-level await in main.ts requires ES2022+; the default target
    // (chrome87 / es2020) doesn't allow it.
    target: "es2022",
  },
});
