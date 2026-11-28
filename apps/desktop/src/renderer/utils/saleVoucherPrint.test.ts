import { describe, expect, it } from "vitest";
import type { SaleVoucher } from "../types/desktopApi";
import { LINES_PER_PAGE, pagesOf, renderSaleVoucherPrintHtml } from "./saleVoucherPrint";

// What the party is handed. The figures come from the stored lines through @erp/domain. Each line's total is its
// amount before the less, and so is the bill's total: the less is confidential and never printed (owner, 28 Nov 2026).

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
    { id: "li-1", productVariantId: "v-1", quantity: 10, priceType: "NORMAL", unitPrice: 550, discount: 1200, discountPerPair: 10, discountSource: "ARTICLE", totalPrice: 64800, article: "SK6", color: "BLUE", size: "7/10", groupName: "EVR GENTS" },
    { id: "li-2", productVariantId: "v-2", quantity: 5, priceType: "NORMAL", unitPrice: 600, discount: 0, discountPerPair: 0, discountSource: "NONE", totalPrice: 36000, article: "SK9", color: "RED", size: "11/13" },
  ],
  createdAt: "",
  updatedAt: "",
};

describe("Sale voucher print", () => {
  // Owner, 28 Nov 2026: "the printed bill should print the amount before the less".
  it("bills each line by dozens, rate per pair and rate per dozen, its total before the less", () => {
    const html = renderSaleVoucherPrintHtml(voucher);
    expect(html).toContain("<th>ریٹ جوڑا</th><th>ریٹ درجن</th><th>ٹوٹل</th>");
    // Rs 550 / pair is Rs 6,600 / dozen; 10 dozens is Rs 66,000 before the Rs 1,200 less. Whole rupees, as on the old bill.
    const line = html.slice(html.indexOf("SK6") - 200, html.indexOf("SK6") + 400).replace(/\s+/g, "");
    expect(line).toContain('<spanclass="ltr">6,600</span>');
    expect(line).toContain('<spanclass="ltr">66,000</span>');
    expect(line).not.toContain("64,800");
  });

  it("bills the party by its Urdu name only (owner, 26 Nov 2026), and prints the Urdu remarks line", () => {
    const html = renderSaleVoucherPrintHtml(voucher);
    expect(html).toContain('<span class="urdu party-name">ماما چپل کراچی</span>');
    expect(html).not.toContain("MAMA CHAPPAL KARACHI</span>");
    expect(html).toContain('<span class="urdu">احمد علی</span>');
  });

  it("falls back to the English name when the party has no Urdu name, so the bill is never addressed to no one", () => {
    const html = renderSaleVoucherPrintHtml({ ...voucher, partyNameUrdu: null });
    expect(html).toContain('<span class="party-name">MAMA CHAPPAL KARACHI</span>');
  });

  // Owner, 28 Nov 2026: "the less should not be mentioned on printed bill. the less is very confidential".
  it("ends on one total row before the less, and never prints the less or the net, with no payable box", () => {
    const html = renderSaleVoucherPrintHtml(voucher);
    const total = html.slice(html.indexOf('<tbody class="total">'), html.indexOf("</table>", html.indexOf('<tbody class="total">'))).replace(/\s+/g, "");
    // 66,000 + 36,000 = 102,000 before the Rs 1,200 less.
    expect(total).toContain('<spanclass="ltr">15.00</span>');
    expect(total).toContain('<spanclass="ltr">102,000</span>');
    expect(html).not.toContain('<tbody class="sums">');
    expect(html).not.toContain("لیس");
    expect(html).not.toContain("نیٹ");
    expect(html).not.toContain("1,200");
    expect(html).not.toContain("100,800");
    expect(html).not.toContain("64,800");
    expect(html).not.toContain("payable-box");
    expect(html.indexOf("Bill to")).toBeLessThan(html.indexOf('<table class="grid"'));
  });

  it("prints no remarks line when there are none, and keeps the sub party inside Bill to", () => {
    const html = renderSaleVoucherPrintHtml({ ...voucher, remarks: null });
    expect(html).not.toContain('<div class="remarks">');
    const billTo = html.slice(html.indexOf('<div class="party-box">'), html.indexOf('<table class="grid"'));
    expect(billTo).toContain('<span class="sub-party-name blank"></span>');
    const named = renderSaleVoucherPrintHtml({ ...voucher, subPartyName: "ALI", subPartyNameUrdu: "علی" });
    expect(named).toContain('<span class="urdu sub-party-name">علی</span>');
    expect(named).not.toContain(">ALI<");
  });

  it("heads the bill with the company's address and numbers, and the bill number above the date", () => {
    const html = renderSaleVoucherPrintHtml(voucher);
    expect(html).not.toContain("SALE VOUCHER");
    expect(html).toContain("<span>Javed Nager, Misra&#39;n wala Sua,</span><span>Near AL-Mashoor Chamma Hotel,</span><span>Sheikhupura.</span>");
    for (const phone of ["+92 320 3033331", "+92 303 0776776", "+92 321 4205286"]) expect(html).toContain(phone);
    expect(html).toContain('<div class="bill-no"><dt class="caps">Bill No.</dt><dd>45</dd></div>');
    expect(html.indexOf("Bill No.")).toBeLessThan(html.indexOf('<dt class="caps">Date</dt>'));
    // The details on the left, Bill to on the right (owner, 26 Nov 2026).
    expect(html.indexOf('<dl class="meta">')).toBeLessThan(html.indexOf('<div class="party-box">'));
  });

  it("lays the table out as the old bill: Urdu, right to left, dozens first, then the description, and signs at the foot", () => {
    const html = renderSaleVoucherPrintHtml(voucher);
    expect(html).toContain("<tr><th>تعداد</th><th>تفصیل</th><th>آرٹیکل</th><th>سائز</th><th>ریٹ جوڑا</th><th>ریٹ درجن</th><th>ٹوٹل</th></tr>");
    expect(html).toContain("direction: rtl");
    expect(html).not.toContain("<th>#</th>");
    const flat = html.replace(/\s+/g, "");
    expect(flat).toContain('<tr><td><spanclass="ltr">10.00</span></td><tdclass="desc">EVRGENTS</td><td><spanclass="ltr">SK6</span></td>');
    expect(html).toContain('<footer class="page-foot">');
  });

  it("keeps a rate's paisa when it has any, instead of rounding it away", () => {
    const html = renderSaleVoucherPrintHtml({ ...voucher, lineItems: [{ ...voucher.lineItems[1]!, unitPrice: 550.5 }] });
    expect(html).toContain('<span class="ltr">550.50</span>');
  });

  it("prints the gatepass QR at the bottom right of the page, and none on a bill made without a gatepass", () => {
    const html = renderSaleVoucherPrintHtml({ ...voucher, gatepassId: "3f2b9c1e-8a4d-4c55-9e1f-2a7b6c0d9e11" });
    expect(html).toContain('<figure class="gp-qr"><svg');
    expect(html).toContain("Scan to Open Gatepass");
    // In the page foot, bottom right after the signatures, not among the details (owner, 26 Nov 2026).
    const foot = html.slice(html.indexOf('<footer class="page-foot">'));
    expect(foot.indexOf('<figure class="gp-qr">')).toBeGreaterThan(-1);
    expect(foot.indexOf('<figure class="gp-qr">')).toBeGreaterThan(foot.indexOf("Received by"));
    expect(renderSaleVoucherPrintHtml({ ...voucher, gatepassId: null, gatepassCode: null })).not.toContain("gp-qr\">");
  });

  it("still prints the bill when the gatepass id is not one a QR can carry", () => {
    const html = renderSaleVoucherPrintHtml({ ...voucher, gatepassId: "gp 7" });
    expect(html).not.toContain('<figure class="gp-qr">');
    expect(html).toContain('<tbody class="total">');
  });

  // Every page the same (owner, 26 Nov 2026): header, headings and footer on each page; the total only on the last.
  it("cuts a long bill into pages, each with the whole header and footer and its page number, the total on the last only", () => {
    const lines = Array.from({ length: 22 }, (_, index) => ({ ...voucher.lineItems[1]!, id: `l${index}` }));
    const html = renderSaleVoucherPrintHtml({ ...voucher, lineItems: lines });
    const pages = html.split('<section class="page">').slice(1);
    expect(pages).toHaveLength(2);
    pages.forEach((page, index) => {
      expect(page).toContain('<span class="urdu party-name">ماما چپل کراچی</span>');
      expect(page).toContain('<div class="bill-no"><dt class="caps">Bill No.</dt><dd>45</dd></div>');
      expect(page).toContain("<th>تعداد</th>");
      expect(page).toContain("Prepared by");
      expect(page).toContain(`Page ${index + 1} of 2`);
    });
    expect(pages[0]).not.toContain('<tbody class="total">');
    // P.T.O under the lines of every page but the last (owner, 26 Nov 2026).
    expect(pages[0]).toContain('<div class="pto">');
    expect(pages[1]).not.toContain('<div class="pto">');
    expect(pages[1]).toContain('<tbody class="total">');
  });

  // The company logo, faint, in a page's free space only (owner, 26 Nov 2026).
  it("sets the logo faintly in a page with room, and never on a full page or without a logo", () => {
    const lines = (count: number) => Array.from({ length: count }, (_, index) => ({ ...voucher.lineItems[1]!, id: `l${index}` }));
    const withLogo = { logoDataUrl: "data:image/png;base64,AAAA" };
    expect(renderSaleVoucherPrintHtml({ ...voucher, lineItems: lines(2) }, withLogo)).toContain('<div class="watermark" aria-hidden="true">');
    expect(renderSaleVoucherPrintHtml({ ...voucher, lineItems: lines(15) }, withLogo)).not.toContain('class="watermark"');
    expect(renderSaleVoucherPrintHtml({ ...voucher, lineItems: lines(2) })).not.toContain('class="watermark"');
    const twoPages = renderSaleVoucherPrintHtml({ ...voucher, lineItems: lines(22) }, withLogo).split('<section class="page">').slice(1);
    expect(twoPages[0]).not.toContain('class="watermark"');
    expect(twoPages[1]).toContain('class="watermark"');
  });

  it("keeps room for the total on the last page, and never leaves it alone on a page", () => {
    const sizes = (count: number) => pagesOf(Array.from({ length: count }, (_, index) => index)).map((page) => page.length);
    expect(sizes(3)).toEqual([3]);
    expect(sizes(LINES_PER_PAGE - 1)).toEqual([LINES_PER_PAGE - 1]);
    expect(sizes(LINES_PER_PAGE)).toEqual([LINES_PER_PAGE - 1, 1]);
    expect(sizes(22)).toEqual([16, 6]);
    expect(sizes(24)).toEqual([16, 8]);
    expect(sizes(32)).toEqual([16, 15, 1]);
    expect(sizes(0)).toEqual([0]);
  });
});