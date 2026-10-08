import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("renderer entry HTML", () => {
  it("loads the bundled stylesheet", () => {
    const htmlPath = path.resolve(__dirname, "../index.html");
    const html = readFileSync(htmlPath, "utf8");

    expect(html).toContain('rel="stylesheet"');
    expect(html).toContain("../../dist/renderer/app.css");
  });
});
