import { describe, expect, it } from "vitest";
import { DATA_KIND, dataKindsOf, readDataChange } from "./dataChange";

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

  it("checks the message a screen receives, and drops what it does not know", () => {
    expect(readDataChange({ kinds: ["STOCK", "NOT_A_KIND", 7] })).toEqual({ kinds: ["STOCK"] });
    expect(readDataChange({ kinds: "STOCK" })).toBeNull();
    expect(readDataChange(null)).toBeNull();
  });
});
