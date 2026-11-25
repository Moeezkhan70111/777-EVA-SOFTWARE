import { describe, expect, it } from "vitest";
import type { Gatepass, GatepassStockRow } from "../../types/desktopApi";
import { canEditGatepass, draftFromDocument, partyIsLocked, stockForEdit } from "./gatepassEdit";

// What the Gatepass screen offers and shows while editing a stored gatepass (local migration 118).

type Line = Gatepass["lines"][number];
const line = (productVariantId: string, article: string, color: string, size: string, quantity: number, issuedDirectlyQuantity = 0): Line =>
  ({ id: `l-${productVariantId}`, lineNo: 1, productVariantId, article, color, size, groupName: null, quantity, storeQuantityAtCreation: 0, dispatchedFromStoreQuantity: 0, issuedDirectlyQuantity, outstandingQuantity: quantity - issuedDirectlyQuantity });
const stockRow = (productVariantId: string, storeQuantity: number, reservedQuantity: number): GatepassStockRow =>
  ({ productVariantId, article: "SK46", color: "BLACKGREY", size: "11/13", groupName: null, storeQuantity, reservedQuantity, reflectedQuantity: storeQuantity - reservedQuantity });

describe("canEditGatepass", () => {
  const doc = { status: "CREATED" as const, deletedAt: null, dispatchedFromStoreQuantity: 0 };
  it("offers Edit while Gatepass Issued or Billed and nothing has been scanned out", () => {
    expect(canEditGatepass(doc)).toBe(true);
    expect(canEditGatepass({ ...doc, status: "BILLED" })).toBe(true);
  });
  it("never once a carton has left the store, past billing, cancelled or deleted", () => {
    expect(canEditGatepass({ ...doc, status: "BILLED", dispatchedFromStoreQuantity: 1 })).toBe(false);
    expect(canEditGatepass({ ...doc, status: "AT_GATE" })).toBe(false);
    expect(canEditGatepass({ ...doc, status: "CANCELLED" })).toBe(false);
    expect(canEditGatepass({ ...doc, deletedAt: "2026-11-23T10:00:00.000Z" })).toBe(false);
  });
  it("locks the party once billed", () => {
    expect([partyIsLocked({ status: "CREATED" }), partyIsLocked({ status: "BILLED" })]).toEqual([false, true]);
  });
});

describe("stockForEdit", () => {
  it("gives the gatepass's own cartons back: what it issued to In Store, what it reserves out of Reserved", () => {
    const rows = [stockRow("v-bg", 15, 4), stockRow("v-other", 9, 2)];
    const document = { lines: [line("v-bg", "SK46", "BLACKGREY", "11/13", 8, 5)] };
    // 5 issued directly come back to In Store; the 3 it still reserves leave Reserved.
    expect(stockForEdit(rows, document)).toEqual([
      { ...rows[0], storeQuantity: 20, reservedQuantity: 1, reflectedQuantity: 19 },
      rows[1],
    ]);
  });
});

describe("draftFromDocument", () => {
  it("puts each article on once, in order (with all its sizes), and each colour's cartons as the dozens typed", () => {
    const document = { lines: [line("v-bg", "SK46", "BLACKGREY", "11/13", 10), line("v-navy", "SK46", "NAVY", "11/13", 5), line("v-red", "SK6", "RED", "7/10", 1)] };
    expect(draftFromDocument(document)).toEqual({
      articles: ["SK46", "SK6"],
      inputs: { "v-bg": "5", "v-navy": "2.5", "v-red": "0.5" },
    });
  });
});
