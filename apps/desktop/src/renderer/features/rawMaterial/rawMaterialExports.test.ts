import { describe, expect, it } from "vitest";
import type { RawMaterialMovementConfigRow } from "../../types/desktopApi";
import { toCsv } from "../../utils/exportFile";
import { buildReportHtml } from "../../utils/reportDocument";
import { parseDelimitedText } from "../../utils/importFile";
import { buildMaterialsSheet, buildStockReport } from "./rawMaterialExports";
import type { CategoryRow, InventoryItemRow } from "./rawMaterial";

// The two things worth pinning down about an export: it carries the figures the screen was
// showing, and a materials export can be edited and imported back without a conversion step.

const CATEGORIES: CategoryRow[] = [
  {
    id: "cat-1",
    name: "RUBBER UPPER",
    fields: [
      { id: "f1", field_key: "article", label: "ARTICLE", field_type: "TEXT" },
      { id: "f2", field_key: "color", label: "COLOR", field_type: "DROPDOWN" },
      { id: "f3", field_key: "unit", label: "UNIT", field_type: "UNIT" },
    ],
  },
];

const ITEMS: InventoryItemRow[] = [
  {
    id: "i1",
    item_code: "RM-000001",
    display_name: "RUBBER UPPER — SK6 — RED",
    category_name: "RUBBER UPPER",
    top_category_name: "RUBBER UPPER",
    sub_category_name: "",
    unit_code: "DZN",
    quantity_on_hand: 148,
    cost_price: 420,
    values: [
      { field_key: "article", label: "ARTICLE", text_value: "SK6", number_value: null },
      { field_key: "color", label: "COLOR", text_value: "RED", number_value: null },
    ],
  },
  {
    id: "i2",
    item_code: "RM-000002",
    display_name: "RAGZINE — BLACK",
    category_name: "RAGZINE",
    top_category_name: "RAGZINE",
    sub_category_name: "",
    unit_code: "MTR",
    quantity_on_hand: 0,
    cost_price: null,
    values: [],
  },
];

const CONFIG = new Map<string, RawMaterialMovementConfigRow>([
  [
    "i1",
    {
      itemId: "i1",
      itemCode: "RM-000001",
      displayName: "RUBBER UPPER — SK6 — RED",
      packName: "PACKET",
      packingQuantity: 2,
      packetsInStore: 30,
      packingUnitId: "u1",
      packingUnitCode: "DZN",
      stockUnitId: "u1",
      stockUnitCode: "DZN",
      packingConvertsToStock: true,
      packSizeInStockUnit: 2,
      defaultSectionId: "ws1",
      defaultSectionName: "PACKING",
      hops: [{ hopIndex: 1, sectionId: "ws1", sectionName: "PACKING" }],
    },
  ],
]);

describe("buildMaterialsSheet", () => {
  it("carries the master columns the import template uses, then the live figures", () => {
    const sheet = buildMaterialsSheet(ITEMS, CONFIG, CATEGORIES, []);

    expect(sheet.headers.slice(0, 7)).toEqual(["Category", "Sub-category", "ARTICLE", "COLOR", "Unit", "Cost price", "Item code"]);
    // A UNIT-typed attribute is the item's unit, not part of its identity, so it is not a column.
    expect(sheet.headers).not.toContain("UNIT");
    // 148 dozen on the shelf in 30 labelled packets — counted, since packets hold different amounts.
    expect(sheet.rows[0]).toEqual(["RUBBER UPPER", "", "SK6", "RED", "DZN", 420, "RM-000001", 30, "148"]);
  });

  it("carries no setup flag: there is nothing left to set up on a material", () => {
    const sheet = buildMaterialsSheet(ITEMS, CONFIG, CATEGORIES, []);
    expect(sheet.headers).not.toContain("Ready to issue");
    // The last column is the live balance, not a flag.
    expect(sheet.rows[0].at(-1)).toBe("148");
  });

  it("records the filters the export was taken under", () => {
    const sheet = buildMaterialsSheet(ITEMS, CONFIG, CATEGORIES, ["Category: RUBBER UPPER"]);
    expect(sheet.preamble).toContain("Category: RUBBER UPPER");
  });

  it("can be read back by the importer — the round trip an operator will actually do", () => {
    const csv = toCsv(buildMaterialsSheet(ITEMS, CONFIG, CATEGORIES, ["Category: RUBBER UPPER"]));
    const parsed = parseDelimitedText(csv);

    expect(parsed.headers).toContain("ARTICLE");
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({ Category: "RUBBER UPPER", ARTICLE: "SK6", COLOR: "RED", Unit: "DZN" });
  });
});

describe("buildStockReport", () => {
  it("is a narrower page than the spreadsheet — no cost, no setup flags", () => {
    const report = buildStockReport(ITEMS, CONFIG, [], [{ unitCode: "DZN", quantity: 148 }]);
    const labels = report.columns.map((column) => column.label);

    expect(labels).toEqual(["Material", "Code", "In store", "Total qty"]);
    expect(labels).not.toContain("Cost");
  });

  it("still lists a material that has no packing yet", () => {
    const report = buildStockReport(ITEMS, CONFIG, [], []);
    expect(report.rows).toHaveLength(2);
  });

  it("leads with packs — what somebody walking the store actually counts", () => {
    const report = buildStockReport(ITEMS, CONFIG, [], []);
    // The labelled packets standing in the store, beside the measured total.
    expect(report.rows[0][2]).toBe("30 PACKETS");
    expect(report.rows[0][3]).toBe("148 DZN");
    // No labelled packets: there is no packet count, so it shows the measured figure.
    expect(report.rows[1][2]).toBe("0 MTR");
  });

  it("totals only what is on the page, and names the filters it was taken under", () => {
    const report = buildStockReport(ITEMS, CONFIG, [{ label: "Category", value: "RUBBER UPPER" }], [
      { unitCode: "DZN", quantity: 148 },
    ]);

    expect(report.totals).toEqual([
      { label: "Materials", value: "2" },
      { label: "DZN", value: "148" },
    ]);
    expect(report.filters).toEqual([{ label: "Category", value: "RUBBER UPPER" }]);
  });
});

describe("buildReportHtml", () => {
  it("escapes material names rather than letting them become markup", () => {
    const html = buildReportHtml(
      {
        title: "Raw Material Stock Report",
        columns: [{ label: "Material" }],
        rows: [['<script>alert("x")</script>']],
      },
      ""
    );

    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("says so on the page when nothing matched, instead of printing an empty table", () => {
    const html = buildReportHtml(
      { title: "Raw Material Stock Report", columns: [{ label: "Material" }], rows: [], emptyMessage: "No raw materials matched these filters." },
      ""
    );

    expect(html).toContain("No raw materials matched these filters.");
    expect(html).not.toContain("<tbody>");
  });
});
