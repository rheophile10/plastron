import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// sqlite-wasm + OPFS persistence works without COOP/COEP because OPFS
// itself doesn't require SharedArrayBuffer; only the synchronous-OPFS
// access in workers does. The plain OpfsDb in the main thread is
// fine without cross-origin isolation. If a host wants the SAHPool VFS
// (faster, sync), they need the headers — but that's a host opt-in.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    // Optional: enable cross-origin isolation for SAHPool support.
    // headers: {
    //   "Cross-Origin-Opener-Policy": "same-origin",
    //   "Cross-Origin-Embedder-Policy": "require-corp",
    // },
  },
  build: {
    sourcemap: true,
    target: "es2022",
  },
  // sqlite-wasm ships its own .wasm; Vite needs to know to leave it alone
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
});
