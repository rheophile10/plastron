import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// PGLite ships its own wasm + a postgres data dump. We exclude it from
// Vite's dep pre-bundling so its loader can resolve those assets at
// runtime. PGLite's own bundler does the right thing in dev and build.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
  },
  build: {
    sourcemap: true,
    target: "es2022",
  },
  optimizeDeps: {
    exclude: ["@electric-sql/pglite"],
  },
});
