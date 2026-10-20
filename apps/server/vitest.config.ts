import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Tests share one database and reset it, so files must not run in parallel.
    fileParallelism: false,
    testTimeout: 20000,
  },
});
