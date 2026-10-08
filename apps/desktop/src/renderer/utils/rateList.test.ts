import { describe, expect, it } from "vitest";
import { buildRateListHtml, buildRateListRows, groupRateListRows } from "./rateList";

const products = [
  { id: "a1", article: "SK6", color: "BLUE", size: "7/10", sellingPrice: 550, status: "ACTIVE" },
  { id: "a2", article: "SK6", color: "BLUE", size: "4/6", sellingPrice: 580, status: "ACTIVE" },
  { id: "disabled", article: "SK7", color: "BLUE", size: "7/10", sellingPrice: 600, status: "DISABLED" },
  { id: "no-price", article: "SK8", color: "BLUE", size: "7/10", sellingPrice: null, status: "ACTIVE" },
] as never[];

describe("rate list generation", () => {
  it("uses enabled products, groups by article, and preserves current A-Type rates", () => {
    const rows = buildRateListRows(products, "A_TYPE", {});

    expect(rows.map((row) => [row.article, row.size, row.newRate])).toEqual([
      ["SK6", "4/6", 580],
      ["SK6", "7/10", 550],
      ["SK8", "7/10", null],
    ]);
    expect(groupRateListRows(rows).map(([article, grouped]) => [article, grouped.length])).toEqual([
      ["SK6", 2],
      ["SK8", 1],
    ]);
    expect(rows.every((row) => row.oldRate === null)).toBe(true);
  });

  it("derives B-Type from the existing pricing rule and excludes products without a valid rate", () => {
    const rows = buildRateListRows(products, "B_TYPE", {});

    expect(rows.map((row) => [row.article, row.size, row.newRate])).toEqual([
      ["SK6", "4/6", 410],
      ["SK6", "7/10", 380],
    ]);
  });

  it("includes both A and B rates when ALL selling types are selected", () => {
    const rows = buildRateListRows([
      { id: "all-1", article: "SK6", size: "7/10", sellingPrice: 550, status: "ACTIVE" },
    ] as never[], "ALL", {});
    const html = buildRateListHtml({ format: "PICTURES", type: "ALL", rows, logo: null, generatedAt: "9/5/2026" });

    expect(rows[0]).toMatchObject({ aRate: 550, bRate: 380 });
    expect(html).toContain("Picture");
    expect(html).toContain("Article");
    expect(html).toContain("A Rate");
    expect(html).toContain("B Rate");
    expect(html).toContain(">550<");
    expect(html).toContain(">380<");
  });

  it("applies custom article and size hierarchy before natural fallback ordering", () => {
    const rows = buildRateListRows([
      { id: "sk6-large", article: "SK6", size: "7/10", sellingPrice: 500, status: "ACTIVE" },
      { id: "sk6-small", article: "SK6", size: "4/6", sellingPrice: 500, status: "ACTIVE" },
      { id: "sk10", article: "SK10", size: "7/10", sellingPrice: 500, status: "ACTIVE" },
    ] as never[], "A_TYPE", {}, { articleOrder: ["SK10", "SK6"], sizeOrder: ["7/10", "4/6"] });

    expect(rows.map((row) => [row.article, row.size])).toEqual([
      ["SK10", "7/10"],
      ["SK6", "7/10"],
      ["SK6", "4/6"],
    ]);
  });

  it("sorts SK articles naturally and renders an accessible missing-image box", () => {
    const rows = buildRateListRows([
      { id: "sk12", article: "SK12", size: "7/10", sellingPrice: 500, status: "ACTIVE" },
      { id: "sk6", article: "SK6", size: "7/10", sellingPrice: 500, status: "ACTIVE" },
      { id: "sk10", article: "SK10", size: "7/10", sellingPrice: 500, status: "ACTIVE" },
    ] as never[], "A_TYPE", {});
    expect(rows.map((row) => row.article)).toEqual(["SK6", "SK10", "SK12"]);

    const html = buildRateListHtml({ format: "PICTURES", type: "A_TYPE", rows, logo: null, generatedAt: "9/5/2026" });
    expect(html).toContain('aria-label="Image not available"');
    expect(html).toContain("Image not available");
    expect(html).toContain("500");
    expect(html).not.toContain("500.00");
    expect(html).not.toContain("No active products with a rate.");
  });

  it("renders grouped article cells and the correct document columns", () => {
    const rows = buildRateListRows(products, "A_TYPE", {});
    const html = buildRateListHtml({ format: "DIFFERENCE", type: "A_TYPE", rows, logo: null, generatedAt: "9/5/2026" });

    expect(html).toContain("New Rate");
    expect(html).toContain("Old Rate");
    expect(html).toContain('rowspan="2"');
    expect(html).toContain("SK6");
    expect(html).toContain("550");
    expect(html).not.toContain("650.00");
  });

  it("uses the previous generated rate and omits pictures in Difference format", () => {
    const rows = buildRateListRows(products, "A_TYPE", { SK6: "data:image/png;base64,image" }, undefined, {
      "A_TYPE:SK6:7/10": 500,
    });
    const html = buildRateListHtml({ format: "DIFFERENCE", type: "A_TYPE", rows, logo: null, generatedAt: "9/5/2026" });

    expect(rows.find((row) => row.article === "SK6" && row.size === "7/10")?.oldRate).toBe(500);
    expect(html).toContain("New Rate");
    expect(html).toContain("Old Rate");
    expect(html).not.toContain('class="image-heading"');
    expect(html).not.toContain("data:image/png");
    expect(html).toContain(">500<");
  });

  it("hides Old Rate when the historical rate is unchanged", () => {
    const rows = buildRateListRows([
      { id: "same", article: "SK6", size: "7/10", sellingPrice: 550, status: "ACTIVE" },
      { id: "changed", article: "SK6", size: "4/6", sellingPrice: 580, status: "ACTIVE" },
    ] as never[], "A_TYPE", {}, undefined, {
      "A_TYPE:SK6:7/10": 550,
      "A_TYPE:SK6:4/6": 500,
    });

    expect(rows.find((row) => row.size === "7/10")?.oldRate).toBeNull();
    expect(rows.find((row) => row.size === "4/6")?.oldRate).toBe(500);
  });

  it("leaves an empty rate-list table blank", () => {
    const html = buildRateListHtml({ format: "PICTURES", type: "A_TYPE", rows: [], logo: null, generatedAt: "9/5/2026" });

    expect(html).not.toContain("No active products with a rate.");
    expect(html).toContain("<tbody></tbody>");
  });

  it("fills the left column with the first article groups before starting the right column", () => {
    const rows = buildRateListRows([
      { id: "sk6", article: "SK6", size: "7/10", sellingPrice: 500, status: "ACTIVE" },
      { id: "sk10", article: "SK10", size: "7/10", sellingPrice: 500, status: "ACTIVE" },
      { id: "sk12", article: "SK12", size: "7/10", sellingPrice: 500, status: "ACTIVE" },
      { id: "sk27", article: "SK27", size: "7/10", sellingPrice: 500, status: "ACTIVE" },
      { id: "sk35", article: "SK35", size: "7/10", sellingPrice: 500, status: "ACTIVE" },
      { id: "sk40", article: "SK40", size: "7/10", sellingPrice: 500, status: "ACTIVE" },
      { id: "sk41", article: "SK41", size: "7/10", sellingPrice: 500, status: "ACTIVE" },
      { id: "sk42", article: "SK42", size: "7/10", sellingPrice: 500, status: "ACTIVE" },
    ] as never[], "A_TYPE", {});
    const html = buildRateListHtml({ format: "PICTURES", type: "A_TYPE", rows, logo: null, generatedAt: "9/5/2026" });
    const firstTable = html.indexOf("<table>");
    const secondTable = html.indexOf("<table>", firstTable + 1);
    expect(html.slice(firstTable, secondTable)).toContain("SK12");
    expect(html.slice(firstTable, secondTable)).toContain("SK10");
    expect(html.slice(firstTable, secondTable)).toContain("SK27");
    expect(html.slice(firstTable, secondTable)).not.toContain("SK35");
    expect(html.slice(secondTable)).toContain("SK35");
  });
});