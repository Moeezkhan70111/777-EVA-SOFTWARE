import { describe, expect, it } from "vitest";
import { buildColorDictionary } from "@erp/domain";
import { buildStockSheet, parseStockSheetReply, sheetColourName, type StockSheetRow } from "./stockSheet";
import { buildStockSheetFailureHtml, buildStockSheetHtml } from "./stockSheetPrint";

// The Dana Stock Sheet: grouped like the store's paper sheet, checked before it is believed (R25),
// never adding units together, and drawn with every material even when it is empty.

const row = (overrides: Partial<StockSheetRow>): StockSheetRow => ({
  id: "i", path: [], colour: "BLACK", colourUrdu: "", size: "1.65", quantity: 0, unitCode: "BAG", ...overrides,
});

const rows = [
  row({ id: "1", path: ["SPECIAL EVA/EVR COMPOUND", "EVA"], colour: "BLACK", quantity: 40 }),
  row({ id: "2", path: ["SPECIAL EVA/EVR COMPOUND", "EVR"], colour: "NAVY", quantity: 45 }),
  row({ id: "3", path: ["SPECIAL EVA/EVR COMPOUND", "EVA"], colour: "NAVY", quantity: 31 }),
  row({ id: "4", path: ["LASTING EVA/EVR", "LASTING EVA"], colour: "GREY", quantity: 0 }),
  row({ id: "5", path: ["RECYCLE"], colour: "WHITE", quantity: 2 }),
];

describe("buildStockSheet", () => {
  it("puts a banner over each compound and a table per kind, in store order, with totals", () => {
    const sheet = buildStockSheet(rows, "DANA");
    expect(sheet.sections.map((section) => section.banner)).toEqual(["SPECIAL EVA/EVR COMPOUND", "LASTING EVA/EVR", null]);
    const special = sheet.sections[0]?.tables ?? [];
    expect(special.map((table) => [table.title, table.rows.map((r) => r.id), table.totals])).toEqual([
      ["EVA", ["1", "3"], [{ unitCode: "BAG", quantity: 71 }]],
      ["EVR", ["2"], [{ unitCode: "BAG", quantity: 45 }]],
    ]);
    expect(sheet.sections[2]?.tables[0]?.title).toBe("RECYCLE");
    expect(sheet.totals).toEqual([{ unitCode: "BAG", quantity: 118 }]);
  });

  it("files a material on DANA itself under DANA, and never adds two units together", () => {
    const sheet = buildStockSheet([row({ quantity: 3 }), row({ id: "k", quantity: 25, unitCode: "KG" })], "DANA");
    expect(sheet.sections[0]?.tables[0]?.title).toBe("DANA");
    expect(sheet.totals).toEqual([{ unitCode: "BAG", quantity: 3 }, { unitCode: "KG", quantity: 25 }]);
  });
});

describe("parseStockSheetReply", () => {
  it("accepts a well-formed reply and refuses anything else", () => {
    expect(parseStockSheetReply({ accepted: true, kind: "DANA", rows })).toEqual({ ok: true, rows });
    expect(parseStockSheetReply({ accepted: false, reason: "No permission" })).toEqual({ ok: false, reason: "No permission" });
    expect(parseStockSheetReply({ accepted: true, rows: [{ ...rows[0], quantity: "40" }] }).ok).toBe(false);
    expect(parseStockSheetReply(null).ok).toBe(false);
  });
});

describe("the printed sheet", () => {
  const colours = buildColorDictionary([{ englishName: "BLACK", urduName: "سیاہ" }]);

  it("writes colours in Urdu: the material's own first, then the colour list, else English", () => {
    expect(sheetColourName(row({ colourUrdu: "کالا" }), colours)).toBe("کالا");
    expect(sheetColourName(row({}), colours)).toBe("سیاہ");
    expect(sheetColourName(row({ colour: "ZEBRA" }), colours)).toBe("ZEBRA");
  });

  it("carries the title, date, banners, Urdu columns, every row and the grand total", () => {
    const html = buildStockSheetHtml(buildStockSheet(rows, "DANA"), colours, "", new Date("2026-11-25T08:00:00Z"));
    for (const text of ["DANA STOCK SHEET", "25 Nov 2026", "SPECIAL EVA/EVR COMPOUND", "LASTING EVA", "رنگ", "سائز", "تعداد", "ٹوٹل", "سیاہ", ">71<", ">118<"]) {
      expect(html).toContain(text);
    }
    expect(html.match(/<tbody><tr>|<\/tr><tr><td class="ur">/g)?.length).toBe(rows.length);
    expect(html).not.toContain(" BAG");
  });

  it("escapes names, and says why when the stock could not be read", () => {
    const html = buildStockSheetHtml(buildStockSheet([row({ path: ["<b>X</b>"] })], "DANA"), colours, "", new Date());
    expect(html).toContain("&lt;b&gt;X&lt;/b&gt;");
    expect(buildStockSheetFailureHtml("No permission")).toContain("No permission");
  });
});
