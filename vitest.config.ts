import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@personal/runos-core": fileURLToPath(new URL("./packages/runos-core/src/index.ts", import.meta.url)),
      "@personal/wanoku-core": fileURLToPath(new URL("./packages/wanoku-core/src/index.ts", import.meta.url)),
      "@personal/storage": fileURLToPath(new URL("./packages/storage/src/index.ts", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts"]
  }
});

