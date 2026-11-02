import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    printWidth: 80,
    ignorePatterns: [
      "**/*.md",
      "pnpm-lock.yaml",
      "dist/**",
      ".tools/**",
      ".output/**",
      "models/**",
    ],
    sortPackageJson: false,
  },
  test: {
    include: ["test/**/*.test.ts"],
    maxWorkers: 3,
    testTimeout: 20000,
    restoreMocks: true,
  },
});
