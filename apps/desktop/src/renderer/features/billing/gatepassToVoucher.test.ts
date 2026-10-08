import { describe, expect, it } from "vitest";
import type { Gatepass } from "../../types/desktopApi";
import { billLinesFromGatepass, voucherDraftFromGatepass } from "./gatepassToVoucher";
import { notificationTarget } from "../users/notificationTarget";

const gatepass: Gatepass = {
  id: "gp-7", code: "GP-000007", gatepassNumber: 7, partyId: "p-abc", partyName: "ABC Traders", partyCode: "P-0001", partyCity: "Lahore",
  gatepassDate: "2026-09-18", status: "CREATED", biltyNumber: "B-4471", transportVia: null, remarks: null, totalQuantity: 27, dispatchedFromStoreQuantity: 0, outstandingQuantity: 27, lineCount: 4,
  createdBy: "clerk", createdAt: "", updatedAt: "", cancelledAt: null, cancelledBy: null, cancelReason: null,
  lines: [
    { id: "l1", lineNo: 1, productVariantId: "v-blue", groupName: null, article: "SK6", color: "BLUE", size: "7/10", quantity: 20, storeQuantityAtCreation: 120, dispatchedFromStoreQuantity: 0, outstandingQuantity: 20 },
    { id: "l2", lineNo: 2, productVariantId: "v-black-l", groupName: null, article: "SK9", color: "BLACK", size: "11/13", quantity: 3, storeQuantityAtCreation: 40, dispatchedFromStoreQuantity: 0, outstandingQuantity: 3 },
    { id: "l3", lineNo: 3, productVariantId: "v-red", groupName: null, article: "SK6", color: "RED", size: "7/10", quantity: 1, storeQuantityAtCreation: 85, dispatchedFromStoreQuantity: 0, outstandingQuantity: 1 },
    { id: "l4", lineNo: 4, productVariantId: "v-blue-s", groupName: null, article: "SK6", color: "BLUE", size: "4/6", quantity: 2, storeQuantityAtCreation: 30, dispatchedFromStoreQuantity: 0, outstandingQuantity: 2 },
  ],
};

describe("voucherDraftFromGatepass", () => {
  it("carries party and date, leaves the remarks for the desk to write, and bills each article + size once — every colour folded in, cartons → dozens (2 cartons = 1 dozen)", () => {
    expect(voucherDraftFromGatepass(gatepass)).toEqual({
      partyId: "p-abc",
      voucherDate: "2026-09-18",
      lines: [
        // SK6 7/10: BLUE 20 + RED 1 = 21 cartons = 10.5 dozens, priced under the first colour seen
        { productVariantId: "v-blue", article: "SK6", size: "7/10", dozens: 10.5 },
        { productVariantId: "v-black-l", article: "SK9", size: "11/13", dozens: 1.5 },
        { productVariantId: "v-blue-s", article: "SK6", size: "4/6", dozens: 1 },
      ],
    });
  });

  it("keeps the gatepass order and never carries a colour", () => {
    const lines = billLinesFromGatepass(gatepass.lines);
    expect(lines.map((line) => `${line.article} ${line.size}`)).toEqual(["SK6 7/10", "SK9 11/13", "SK6 4/6"]);
    expect(lines.every((line) => !("color" in line))).toBe(true);
    expect(billLinesFromGatepass([])).toEqual([]);
  });
});

describe("notificationTarget", () => {
  it("sends gatepass notices to the sale voucher screen for that gatepass, and nothing else anywhere", () => {
    expect(notificationTarget({ kind: "GATEPASS_CREATED", entityId: "gp-7" })).toEqual({ route: "sale-voucher-form", gatepassId: "gp-7" });
    expect(notificationTarget({ kind: "GATEPASS_CANCELLED", entityId: "gp-7" })).toEqual({ route: "sale-voucher-form", gatepassId: "gp-7" });
    expect(notificationTarget({ kind: "GATEPASS_CREATED", entityId: null })).toBeNull();
    expect(notificationTarget({ kind: null, entityId: "x" })).toBeNull();
    expect(notificationTarget({})).toBeNull();
  });
});
