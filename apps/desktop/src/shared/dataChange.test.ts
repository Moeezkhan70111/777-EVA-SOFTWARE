import { describe, expect, it } from "vitest";
import { DATA_KIND, dataKindsOf, readDataChange, readDataChangeTrace } from "./dataChange";

// What kind of data a sync changed, as every open screen hears it.

describe("data kinds", () => {
  it("names the kinds of business data the applied records touched, and always the waits", () => {
    expect(dataKindsOf(["STOCK_EVENT", "INVENTORY_ITEM", "RAW_MATERIAL_QR", "PARTY"])).toEqual(["LABELS", "MATERIALS", "PARTIES", "STOCK", "SYNC"]);
    // A read that applied nothing can still settle a wait, and an unmapped type is never silent.
    expect(dataKindsOf([])).toEqual([DATA_KIND.SYNC]);
    expect(dataKindsOf(["SOMETHING_NEW"])).toEqual([DATA_KIND.SYNC]);
  });

  it("covers every record type the store PC sends", () => {
    for (const type of ["INVENTORY_CATEGORY", "INVENTORY_UNIT", "UNIT_LADDER_PRESET", "WORK_SECTION", "MACHINE"]) {
      expect(dataKindsOf([type])).toContain(DATA_KIND.MATERIALS);
    }
    expect(dataKindsOf(["PARTY_GROUP"])).toContain(DATA_KIND.PARTIES);
    expect(dataKindsOf(["RAW_MATERIAL_QR_BATCH"])).toContain(DATA_KIND.LABELS);
  });

  it("work arriving from another computer reloads the screens that show it (docs/43)", () => {
    for (const type of ["CARTON_STOCK_EVENT", "MANUAL_PRODUCTION_ENTRY"]) expect(dataKindsOf([type])).toContain(DATA_KIND.CARTONS);
    for (const type of ["GATEPASS", "SALE_VOUCHER"]) expect(dataKindsOf([type])).toContain(DATA_KIND.BILLING);
    expect(dataKindsOf(["CASH_VOUCHER"])).toContain(DATA_KIND.CASH);
    for (const type of ["MAIN_GROUP", "PRODUCT_GROUP", "ARTICLE_SERIES", "PRODUCT_TYPE", "PRODUCT_SUB_GROUP", "ARTICLE_SIZE"]) expect(dataKindsOf([type])).toContain(DATA_KIND.PRODUCTS);
  });

  it("checks the message a screen receives, and drops what it does not know", () => {
    expect(readDataChange({ kinds: ["STOCK", "NOT_A_KIND", 7] })).toEqual({ kinds: ["STOCK"] });
    expect(readDataChange({ kinds: "STOCK" })).toBeNull();
    expect(readDataChange(null)).toBeNull();
  });
});

describe("following one change through app.log", () => {
  it("keeps a well-formed change id, and drops one that is not", () => {
    expect(readDataChange({ kinds: ["CARTONS"], id: "6f1c2a9e-1b2c-4d5e-8f90-123456789abc" })).toEqual({ kinds: ["CARTONS"], id: "6f1c2a9e-1b2c-4d5e-8f90-123456789abc" });
    expect(readDataChange({ kinds: ["CARTONS"], id: "<script>" })).toEqual({ kinds: ["CARTONS"] });
    expect(readDataChange({ kinds: ["CARTONS"], id: 7 })).toEqual({ kinds: ["CARTONS"] });
  });

  it("logs only a trace it can read: a known step, a plain id and screen, a short printable note", () => {
    expect(readDataChangeTrace({ id: "abc-1", screen: "carton-stock", stage: "shown", detail: "movements=24" })).toEqual({ id: "abc-1", screen: "carton-stock", stage: "shown", detail: "movements=24" });
    expect(readDataChangeTrace({ id: "abc-1", screen: "carton-stock", stage: "received" })).toEqual({ id: "abc-1", screen: "carton-stock", stage: "received" });
    expect(readDataChangeTrace({ id: "abc-1", screen: "carton-stock", stage: "deleted-everything" })).toBeNull();
    expect(readDataChangeTrace({ id: "abc 1", screen: "carton-stock", stage: "shown" })).toBeNull();
    expect(readDataChangeTrace({ id: "abc-1", screen: "Carton Stock!", stage: "shown" })).toBeNull();
    expect(readDataChangeTrace(null)).toBeNull();
    const long = readDataChangeTrace({ id: "abc-1", screen: "carton-stock", stage: "shown", detail: `line one\nline two ${"x".repeat(400)}` });
    expect(long?.detail).not.toContain("\n");
    expect(long?.detail?.length).toBe(160);
  });
});
