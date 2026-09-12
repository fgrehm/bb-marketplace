import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": new URL(".", import.meta.url).pathname,
    },
  },
  test: {
    maxWorkers: 1,
    minWorkers: 1,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["server.ts", "app.tsx", "lib/**/*.ts"],
      exclude: ["**/*.test.*"],
    },
  },
});
