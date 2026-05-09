import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 5174 },
  build: {
    sourcemap: true,
    target: "es2022",
  },
});
