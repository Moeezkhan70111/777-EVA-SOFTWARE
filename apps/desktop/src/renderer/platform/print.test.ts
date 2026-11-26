import { afterEach, describe, expect, it } from "vitest";
import { urduFontFaceCss } from "./print";

// A print-out is its own window: it gets the app's bundled Nastaliq by copying the app's @font-face rules (26 Nov 2026).

afterEach(() => { document.head.innerHTML = ""; });

describe("urduFontFaceCss", () => {
  it("copies only the Urdu font's @font-face rules from the app's stylesheet", () => {
    const style = document.createElement("style");
    style.textContent = `@font-face { font-family: 'Noto Nastaliq Urdu'; font-weight: 400; src: url(data:font/woff2;base64,AAAA) format('woff2'); }
      @font-face { font-family: 'Inter'; src: url(inter.woff2); }
      .x { color: red; }`;
    document.head.appendChild(style);
    const css = urduFontFaceCss();
    expect(css).toContain("Noto Nastaliq Urdu");
    expect(css).toContain("data:font/woff2;base64,AAAA");
    expect(css).not.toContain("Inter");
    expect(css).not.toContain(".x");
  });

  it("is empty when the app has no Urdu font loaded, so the print-out falls back as before", () => {
    expect(urduFontFaceCss()).toBe("");
  });
});
