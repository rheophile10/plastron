import { defineConfig } from "vite";

// The plastron source lives at ../../plastron/src and the shared Excel
// parser at ../08_excel — both are above the project root, so we widen
// the dev-server file allow-list. Build still works since Vite bundles
// the imported files as part of the graph.
export default defineConfig({
  server: {
    port: 5176,
    strictPort: true,
    fs: { allow: ["../..", "."] },
  },
});
