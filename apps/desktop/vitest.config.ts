import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/renderer/test/setup.ts"],
    // Renderer tests run in jsdom; main-process modules opt into node with
    // `// @vitest-environment node` at the top of the file.
    include: ["src/renderer/**/*.test.ts", "src/renderer/**/*.test.tsx", "src/main/**/*.test.ts", "src/shared/**/*.test.ts"],
  },
});
