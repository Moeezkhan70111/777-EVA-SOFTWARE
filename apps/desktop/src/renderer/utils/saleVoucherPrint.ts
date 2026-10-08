import type { SaleVoucher } from "../types/desktopApi";
import { calculateSaleLine, discountPerPairFromTotal } from "@erp/domain";
import { formatMoney } from "../app/format";
import { escapeHtml } from "./html";
import { formatBookDate, formatDateTime } from "./dates";
import { loadLogoDataUrl, openPrintDocumentAsync } from "../platform/print";

// Printable Sale Voucher (the bill):
//
//   ┌ letterhead ─────────────────────────────────────────────────────┐
//   │ Voucher No. ____  Date ____  Book No. ____  Gatepass ____        │
//   │ Party ___________________________________________________________│
//   ├ # │ Article │ Size │ Dozens │ Rate/pair │ Rate/dozen │ Total ───────────┤
//   │ … │         │      │        │           │            │                  │
//   ├───┴─────────┴──────┴────────┴───────────┴────────────┴──────────────────┤
//   │ Total dozens · Net payable                                              │
//   └─────────────────────────────────────────────────────────────────────────┘
//
// The gross amount and the "less" stay off the printed bill — the party is shown the
// net figure it owes. Both remain on the Sale Voucher screen and in the ledger.
//
// A bill is per article + size — colour belongs to the gatepass, never to the bill.
//
// Every figure comes from the stored lines through the one sale-line formula in
// @erp/domain, so the print-out cannot disagree with the ledger.

const PRINT_STYLES = `
  * { box-sizing: border-box; }
  @page { size: A4 portrait; margin: 12mm; }
  body { font-family: "Segoe UI", Helvetica, Arial, sans-serif; margin: 24px; color: #111; font-size: 13px; }
  .print-actions { text-align: center; margin-bottom: 18px; }
  .print-actions button {
    padding: 10px 26px; font-size: 13px; font-weight: 600; letter-spacing: .04em;
    text-transform: uppercase; background: #17365d; color: #fff; border: none; border-radius: 4px; cursor: pointer;
  }
  .doc { max-width: 800px; margin: 0 auto; }
  .letterhead { display: flex; justify-content: space-between; align-items: center; gap: 24px; padding-bottom: 10px; border-bottom: 3px solid #17365d; }
  .letterhead img { height: 54px; width: auto; }
  .letterhead .brand-text { font-size: 22px; font-weight: 900; letter-spacing: .04em; color: #17365d; }
  .letterhead .brand-text small { display: block; font-size: 10px; font-weight: 700; letter-spacing: .14em; color: #555; }
  .letterhead .doc-title { text-align: right; }
  .letterhead .doc-title h1 { margin: 0; font-size: 20px; letter-spacing: .16em; color: #17365d; }
  .letterhead .doc-title .no { font-family: Consolas, "Courier New", monospace; font-size: 18px; font-weight: 700; margin-top: 2px; }
  .head-box { margin-top: 14px; border: 1.5px solid #111; border-radius: 8px; padding: 10px 14px; }
  .head-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px 20px; align-items:center}
  .head-row + .head-row { margin-top: 10px; padding-top: 10px; border-top: 1px dashed #bbb; }
  .head-row.party { grid-template-columns: 1fr; }
  .field { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .field label { flex: none; font-size: 10px; font-weight: 700; color: #555; text-transform: uppercase; letter-spacing: .08em; }
  .field .val { flex: 1; min-height: 18px; border-bottom: 1px solid #111; font-weight: 700; font-size: 13px; padding: 0 4px 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .field .val.blank { border-bottom-style: dotted; }
  .field .val.party { font-size: 17px; letter-spacing: .02em; display: flex; justify-content: space-between; gap: 16px; }
  .field .val.party .party-en { overflow: hidden; text-overflow: ellipsis; }
  .field .val.party .party-ur { flex: none; font-size: 19px; }
  .grid { width: 100%; border-collapse: collapse; margin-top: 14px; }
  .grid th, .grid td { border: 1px solid #111; padding: 6px 6px; font-variant-numeric: tabular-nums; }
  .grid thead th { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; background: #eef2f7; color: #17365d; text-align: center; }
  .grid tbody td { font-size: 13px; font-weight: 600; text-align: right; }
  .grid tbody td.text { text-align: left; }
  .grid tbody td.num { text-align: center; }
  .grid tfoot td { font-weight: 800; font-size: 13px; background: #eef2f7; text-align: right; }
  .grid tfoot td.label { text-align: left; }
  .grid tfoot td.net { font-size: 16px; }
  .remarks {font-size: 12px; color: #333; }
  .urdu { direction: rtl; unicode-bidi: isolate; font-family: "Noto Nastaliq Urdu", "Noto Naskh Arabic", Tahoma, sans-serif; }
  .SUBPARTY .field span{font-size : 18px;}
  .sign { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 40px; margin-top: 44px; }
  .sign div { border-top: 1px solid #111; padding-top: 6px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: #444; text-align: center; }
  .foot { margin-top: 22px; font-size: 10px; color: #777; text-align: center; }
  @media print {
    .print-actions { display: none; }
    body { margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
`;

export interface SaleVoucherPrintOptions {
  /** Letterhead logo as a data URL; when absent the brand name is printed as text. */
  logoDataUrl?: string;
}

/** dd/mm/yyyy from a plain YYYY-MM-DD voucher date. */
const formatBookDay = (ymd: string): string =>
  /^\d{4}-\d{2}-\d{2}$/.test(ymd ?? "")
    ? formatBookDate(`${ymd}T00:00:00`, ymd)
    : ymd || "";

/** Builds the printable HTML for a sale voucher. Exported so it can be tested without a window. */
export const renderSaleVoucherPrintHtml = (
  voucher: SaleVoucher,
  options: SaleVoucherPrintOptions = {},
): string => {
  const lines = voucher.lineItems.map((item) => {
    const pairDiscount = discountPerPairFromTotal({
      dozens: item.quantity,
      totalDiscount: item.discount,
    });
    return {
      item,
      figures: calculateSaleLine({
        dozens: item.quantity,
        pairRate: item.unitPrice,
        pairDiscount,
      }),
    };
  });
  const totals = lines.reduce(
    (acc, { item, figures }) => ({
      dozens: acc.dozens + item.quantity,
      net: acc.net + figures.total,
    }),
    { dozens: 0, net: 0 },
  );

  const bodyRows = lines
    .map(
      ({ item, figures }, index) => `<tr>
        <td class="num">${index + 1}</td>
        <td class="text">${escapeHtml(item.article)}</td>
        <td class="num">${escapeHtml(item.size)}</td>
        <td>${escapeHtml(item.quantity)}</td>
        <td>${escapeHtml(formatMoney(item.unitPrice))}</td>
        <td>${escapeHtml(formatMoney(figures.dozenRate))}</td>
        <td>${escapeHtml(formatMoney(figures.total))}</td>
      </tr>`,
    )
    .join("");

  // The party as it is known on both sides of the bill: the English name it is keyed by,
  // and its Urdu name beside it when the party has one.
  const partyUrdu = (sale: SaleVoucher): string =>
    sale.partyNameUrdu ? `<span class="urdu party-ur">${escapeHtml(sale.partyNameUrdu)}</span>` : "";
  const field = (label: string, value: string | null | undefined) =>
    `<div class="field"><label>${escapeHtml(label)}</label><span class="val ${value ? "" : "blank"}">${escapeHtml(value ?? "")}</span></div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Sale Voucher #${escapeHtml(voucher.voucherNumber)}</title>
  <style>${PRINT_STYLES}</style>
</head>
<body>
  <div class="print-actions"><button onclick="window.print()">🖨 Print / Save as PDF</button></div>
  <div class="doc">
    <div class="letterhead">
      ${options.logoDataUrl ? `<img src="${options.logoDataUrl}" alt="777 Seven" />` : `<div class="brand-text">777 SEVEN<small>T&amp;T TRADERS</small></div>`}
      <div class="doc-title">
        <h1>SALE VOUCHER</h1>
        <div class="no">No. ${escapeHtml(voucher.voucherNumber)}</div>
      </div>
    </div>

    <div class="head-box">
      <div class="head-row">
        ${field("Date", formatBookDay(voucher.voucherDate))}
    
        ${field("Gatepass", voucher.gatepassCode ?? null)}
        ${voucher.remarks ? `<div class="remarks"><strong>Remarks:</strong> <span class="urdu">${escapeHtml(voucher.remarks)}</span></div>` : ""}

      </div>
      <div class="head-row party">
        <div class="field"><label>Party</label><span class="val party"><span class="party-en">${escapeHtml(voucher.partyName)}</span>${partyUrdu(voucher)}</span></div>
      </div>
      <span class="SUBPARTY">${field("Sub party", voucher.subPartyNameUrdu ?? voucher.subPartyName ?? null)}</span>

    </div>

    <table class="grid">
      <thead>
        <tr><th>#</th><th>Article</th><th>Size</th><th>Dozens</th><th>Rate / pair</th><th>Rate / dozen</th><th>Total</th></tr>
      </thead>
      <tbody>${bodyRows}</tbody>
      <tfoot>
        <tr>
          <td class="label" colspan="3">Total</td>
          <td>${escapeHtml(totals.dozens)}</td>
          <td></td>
          <td></td>
          <td class="net">Rs ${escapeHtml(formatMoney(totals.net))}</td>
        </tr>
      </tfoot>
    </table>

    <div class="sign">
      <div>Prepared by</div>
      <div>Checked by</div>
      <div>Received by</div>
    </div>
    <div class="foot">Printed ${escapeHtml(formatDateTime(new Date().toISOString()))}.</div>
  </div>
</body>
</html>`;
};

/** Opens the print-ready window; false when the popup was blocked so the caller can tell the operator. */
export const openSaleVoucherPrintWindow = (voucher: SaleVoucher): boolean =>
  openPrintDocumentAsync(
    loadLogoDataUrl().then((logoDataUrl) =>
      renderSaleVoucherPrintHtml(voucher, { logoDataUrl }),
    ),
  );
