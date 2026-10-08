import { describe, expect, it } from "vitest";
import type { SaleVoucher } from "../types/desktopApi";
import { renderSaleVoucherPrintHtml } from "./saleVoucherPrint";

// What the party is handed. The figures come from the stored lines through @erp/domain, and
// the paper shows the party what it owes: rates and the net total, not the gross and the less.

const voucher: SaleVoucher = {
  id: "sv-1",
  voucherNumber: "45",
  partyId: "p-abc",
  partyName: "MAMA CHAPPAL KARACHI",
  partyNameUrdu: "ماما چپل کراچی",
  voucherDate: "2026-09-18",
  bookNo: "B1",
  subPartyName: null,
  subPartyNameUrdu: null,
  subPartyNumber: null,
  remarks: "احمد علی",
  totalQuantity: 15,
  totalAmount: 97200,
  status: "DRAFT",
  gatepassId: "gp-7",
  gatepassCode: "GP-000007",
  gatepassStatus: "CREATED",
  lineItems: [
    // 10 dozens at Rs 550 / pair = Rs 66,000 gross, less Rs 10 / pair = Rs 1,200 → Rs 64,800.
    { id: "li-1", productVariantId: "v-1", quantity: 10, priceType: "NORMAL", unitPrice: 550, discount: 1200, discountPerPair: 10, discountSource: "ARTICLE", totalPrice: 64800, article: "SK6", color: "BLUE", size: "7/10" },
    { id: "li-2", productVariantId: "v-2", quantity: 5, priceType: "NORMAL", unitPrice: 600, discount: 0, discountPerPair: 0, discountSource: "NONE", totalPrice: 36000, article: "SK9", color: "RED", size: "11/13" },
  ],
  createdAt: "",
  updatedAt: "",
};

describe("Sale voucher print", () => {
  it("bills each line by dozens, rate per pair and rate per dozen, and shows no gross amount or less", () => {
    const html = renderSaleVoucherPrintHtml(voucher);
    expect(html).toContain("<th>Rate / pair</th><th>Rate / dozen</th><th>Total</th>");
    expect(html).not.toContain("<th>Amount</th>");
    expect(html).not.toContain("<th>Less</th>");
    // Rs 550 / pair is Rs 6,600 / dozen; the total is net of the Rs 1,200 less.
    expect(html).toContain("6,600.00");
    expect(html).toContain("64,800.00");
    expect(html).not.toContain("66,000.00");
    // Footer: total dozens and the net payable only.
    expect(html).toContain("Rs 100,800.00");
  });

  it("names the party in English and in Urdu, and prints the Urdu remarks line", () => {
    const html = renderSaleVoucherPrintHtml(voucher);
    expect(html).toContain('<span class="party-en">MAMA CHAPPAL KARACHI</span>');
    expect(html).toContain('<span class="urdu party-ur">ماما چپل کراچی</span>');
    expect(html).toContain('<span class="urdu">احمد علی</span>');
  });

  it("leaves the party line to the English name alone when the party has no Urdu name", () => {
    const html = renderSaleVoucherPrintHtml({ ...voucher, partyNameUrdu: null });
    expect(html).toContain('<span class="party-en">MAMA CHAPPAL KARACHI</span>');
    expect(html).not.toContain('<span class="urdu party-ur">');
  });
});
