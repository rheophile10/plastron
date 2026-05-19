import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Single-file build target for the HN GitHub-Pages drop. Per the
// locked decision (#4 in notes/todo.md), the deliverable is one
// self-contained `dist/index.html` with every script + style inlined.
// `npm run build` produces that file; serve it from any static host
// (or just open via file://).
//
// Dev mode is unchanged — `npm run dev` still uses Vite's separate
// dev server on port 5174 with HMR.
export default defineConfig({
  server: { port: 5174 },
  plugins: [viteSingleFile()],
  build: {
    target: "es2022",
    sourcemap: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
