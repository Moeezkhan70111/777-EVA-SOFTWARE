import { describe, expect, it } from "vitest";
import type { HandVoucher } from "../../../types/desktopApi";
import { renderHandSlipHtml } from "./handSlip";

// A store hand voucher's slip is the store's own slip (storeVoucher.ts): its number under "Voucher", one time, and
// each line as it was typed. A typed voucher has no packets, so the slip has no packets column to print zeros in.

const VOUCHER: HandVoucher = {
  id: "v-1",
  direction: "IN",
  voucherNumber: 100012,
  code: "SIV-100012",
  businessDate: "2026-11-15",
  partyId: "party-1",
  partyName: "SHEHZAD <RUBBER>",
  note: "Bilty 42",
  status: "POSTED",
  revision: 1,
  createdBy: "aslam",
  createdAt: "2026-11-15T09:00:00.000Z",
  updatedBy: null,
  updatedAt: "2026-11-15T09:00:00.000Z",
  deletedBy: null,
  deletedAt: null,
  editable: true,
  lines: [
    { lineNo: 1, itemId: "a", itemName: "NAWAAR 5 SOOTAR", typedQuantity: 3, typedUnitCode: "RULE", quantity: 2925, stockUnitCode: "INCH" },
    { lineNo: 2, itemId: "b", itemName: "DANA EVA", typedQuantity: 50, typedUnitCode: "KG", quantity: 50, stockUnitCode: "KG" },
  ],
};

describe("store hand voucher slip", () => {
  it("prints the voucher number, the supplier, each line as typed, and no packets", () => {
    const html = renderHandSlipHtml(VOUCHER, { noPrintButton: true });
    expect(html).toContain("<th>Voucher</th>");
    expect(html).toContain("SIV-100012");
    expect(html).toContain("SHEHZAD &lt;RUBBER&gt;");
    expect(html).toContain("3 RULE");
    expect(html).toContain("50 KG");
    expect(html).toContain("Raw Material Received");
    expect(html).toContain("Reference: Bilty 42");
    expect(html).not.toContain("Pkts");
    expect(html).not.toContain("Total packets");
    expect(html).toContain("2:00 PM");
  });

  it("a Move Out voucher prints as issued, to its party, with what it was for", () => {
    const html = renderHandSlipHtml({ ...VOUCHER, direction: "OUT", code: "SOV-100007", partyName: "ASLAM", note: "cutting table" }, { noPrintButton: true });
    expect(html).toContain("Raw Material Issued");
    expect(html).toContain("SOV-100007");
    expect(html).toContain("ASLAM");
    expect(html).toContain("What for: cutting table");
  });
});
