import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/renderer/test/setup.ts"],
    // Renderer tests run in jsdom; main-process modules opt into node with
    // `// @vitest-environment node` at the top of the file.
    include: ["src/renderer/**/*.test.ts", "src/renderer/**/*.test.tsx", "src/main/**/*.test.ts", "src/shared/**/*.test.ts"],
    // The data package's built output is loaded by Node itself, not transformed: Vite strips the
    // `node:` prefix from `node:sqlite`, which it does not know, and the import then fails. Only a
    // main-process test that opens a real database needs this (cloudAccounts.test.ts).
    server: { deps: { external: [/packages[\\/]data[\\/]dist[\\/]/] } },
  },
});
