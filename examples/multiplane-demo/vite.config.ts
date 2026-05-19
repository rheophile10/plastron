import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Single-file HTML output. Drop dist/index.html anywhere static —
// GH Pages, S3, file:// — and it runs. No backend, no external
// asset requests; all JS/CSS inlined.
export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    target: "es2022",
    // viteSingleFile defaults: inline all JS/CSS, no code-splitting.
    assetsInlineLimit: 100_000_000,
  },
  esbuild: { target: "es2022" },
});
