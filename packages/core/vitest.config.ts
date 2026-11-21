import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "live",
          include: ["test/live/**/*.test.ts"],
          setupFiles: ["test/live/setup.ts"],
          testTimeout: 240_000,
          hookTimeout: 240_000,
          // Live runs call the model; keep them sequential so logs and timing stay readable.
          fileParallelism: false,
        },
      },
    ],
  },
});
