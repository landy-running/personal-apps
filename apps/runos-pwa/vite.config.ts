import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  base: "./",
  build: {
    outDir: "../../dist/runos-pwa",
    emptyOutDir: true
  },
  resolve: {
    alias: {
      "@personal/runos-core": fileURLToPath(new URL("../../packages/runos-core/src/index.ts", import.meta.url)),
      "@personal/storage": fileURLToPath(new URL("../../packages/storage/src/index.ts", import.meta.url))
    }
  }
});

