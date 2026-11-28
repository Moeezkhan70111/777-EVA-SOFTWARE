import type { SaleVoucher } from "../types/desktopApi";
import { addMoney, buildGatepassQr, calculateSaleLine, discountPerPairFromTotal } from "@erp/domain";
import { formatMoney, formatWholeMoney } from "../app/format";
import { copy } from "../config/copy";
import { escapeHtml as e } from "./html";
import { renderQrSvgMarkup } from "./qrLabels";
import { formatBookDate, formatDateTime } from "./dates";
import { loadLogoDataUrl, openPrintDocumentAsync, urduFontFaceCss } from "../platform/print";

// THE PRINTED SALE VOUCHER, the bill the party is handed (26 Nov 2026 redesign, docs/56):
//
//   [777 logo]     ADDRESS  Javed Nager, Misra'n wala Sua,  │ CONTACT #  +92 320 3033331   side by side;
//                           Near AL-Mashoor Chamma Hotel,   │            +92 303 0776776   one a line,
//                           Sheikhupura.                    │            +92 321 4205286   tabular digits
//   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   navy rule
//   BILL NO.   45            ┌ BILL TO ──────────────────────────────┐
//   DATE       18/09/2026    │                         ماما چپل کراچی │   the party in Urdu only
//   GATEPASS   GP-000007     │ SUB PARTY ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ │   (English only when it has no Urdu name)
//                            └───────────────────────────────────────┘
//   Remarks  احمد علی                                       (only when there are any)
//   ٹوٹل │ ریٹ درجن │ ریٹ جوڑا │ سائز │ آرٹیکل │ تفصیل │ تعداد      the old bill's table, right to left;
//                                                                     each line's ٹوٹل before the less
//   112,500 │                                          ٹوٹل │ 17.00   the amount before the less,
//   −5,100  │                                           لیس │         the less,
//   107,400 │                                      نیٹ ٹوٹل │         and the net owed, in the total bar
//   Prepared by            Checked by            Received by      at the foot of the page, wherever the lines end
//
// WHO it is for and HOW MUCH they owe are the two things the paper is for: the party first and boxed with its sub
// party (serial position, common region), the total last, on the table's own total row (owner, 26 Nov 2026: no
// separate payable box). Bill no., date and gatepass are reference, to its left in small caps (proximity).
//
// The less on paper (owner, 28 Nov 2026: "the printed bill should print the amount before the less"): each line's
// ٹوٹل is its amount before the less, and a bill with a less ends on three rows, the amount before it, the less and the
// net owed, the net in the total bar so it is still the figure that stands out. A bill with no less keeps its one
// total row. A bill is per article and size, never colour; every figure
// comes from the stored lines through the one sale-line formula in @erp/domain, and the total is added in paisa
// (addMoney), so the paper cannot disagree with the ledger. Standalone HTML in its own print window, so its colours
// are literals here, as in every other print-out.

const text = copy.saleVoucherPrint;

/** A map pin and a telephone instead of the words "Address" and "Contact #" (owner, 26 Nov 2026); the words stay for a reader. */
const PIN_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.1-7-11.5A7 7 0 0 1 19 9.5C19 14.9 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>`;
const PHONE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/></svg>`;

/**
 * EVERY PAGE THE SAME (owner, 26 Nov 2026): every printed page carries the whole header (letterhead, details, Bill to,
 * remarks), the column headings and the footer (signatures, QR, printed time, page number) in the same places; only
 * the total row waits for the last page. The bill is cut into pages here rather than left to the browser, which will
 * not repeat a header block taller than a quarter of the page and so ran page 2's lines under nothing (or under the
 * header). Every line row is the same fixed height, so a page always holds LINES_PER_PAGE of them.
 */
export const LINES_PER_PAGE = 16;

/** Rows a page must have free before the company's logo is set faintly in the space (owner, 26 Nov 2026). */
export const WATERMARK_MIN_FREE_ROWS = 6;

const PRINT_STYLES = `
  * { box-sizing: border-box; }
  @page { size: A4 portrait; margin: 8mm; }
  body { font-family: "Segoe UI", Helvetica, Arial, sans-serif; margin: 24px; color: #14213d; font-size: 13px; line-height: 1.45; font-kerning: normal; background: #e9edf3; }
  .print-actions { text-align: center; margin-bottom: 18px; }
  .print-actions button { padding: 10px 26px; font-size: 13px; font-weight: 700; background: #17365d; color: #fff; border: none; border-radius: 6px; cursor: pointer; }
  /* One A4 page (297 mm less the 8 mm margins), framed by a thin navy border (owner, 26 Nov 2026) 4 mm out from the
     content, so the content keeps the same 186 x 273 mm: header at the top, footer at the foot, lines between. */
  .page { display: flex; flex-direction: column; width: 194mm; height: 281mm; margin: 0 auto 24px; padding: 4mm; border: 1px solid #17365d; overflow: hidden; background: #fff; box-shadow: 0 2px 10px rgba(20, 33, 61, .12); }
  /* As tall as its content: a bill with no remarks gives their line to the table (owner, 26 Nov 2026). Capped, so a long
     remark can never push the lines off the page. */
  .page-head { flex: none; max-height: 88mm; padding-bottom: 14px; overflow: hidden; }
  .page-body { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
  /* The logo, faint and grey, centred in the space under the lines: only where a page has room, never behind a line. */
  /* Under the lines of every page but the last: the bill goes on overleaf (owner, 26 Nov 2026). */
  .pto { margin-top: 6px; text-align: right; color: #17365d; font-size: 18px; font-weight: 800; letter-spacing: .08em; line-height: 1.2; }
  .watermark { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 12px 0; }
  .watermark img { max-width: 55%; max-height: 100%; opacity: .05; filter: grayscale(1); }
  .page-foot { flex: none; padding-top: 8px; }
  .page-no { font-size: 8px; color: #8d9ab2; }
  .urdu { direction: rtl; unicode-bidi: isolate; font-family: "Noto Nastaliq Urdu", "Noto Naskh Arabic", Tahoma, sans-serif; font-weight: 400; line-height: 2.1; }
  .caps { font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: #5e6e8a; }
  /* Numbers and articles in Times New Roman (owner, 26 Nov 2026): the table, bill no., date, gatepass and phones. It sits smaller than Segoe UI at the same size, so those figures are a step larger. */
  .company .phones, .meta dd, .grid tbody td { font-family: "Times New Roman", Times, serif; }

  .letterhead { display: flex; justify-content: space-between; align-items: center; gap: 32px; padding: 4px 0 18px; border-bottom: 3px solid #17365d; }
  .letterhead img { height: 76px; width: auto; }
  .brand-text { font-size: 22px; font-weight: 900; letter-spacing: .04em; color: #17365d; }
  .brand-text small { display: block; font-size: 10px; font-weight: 700; letter-spacing: .14em; color: #5e6e8a; }
  .company { display: grid; grid-template-columns: repeat(4, auto); align-items: start; column-gap: 10px; margin: 0; font-style: normal; font-size: 13px; line-height: 1.5; color: #14213d; }
  .company dt { padding-top: 1px; color: #17365d; }
  .company dt svg { display: block; width: 18px; height: 18px; }
  .company dt:nth-of-type(2) { margin-left: 14px; padding-left: 16px; border-left: 1px solid #c9d3e3; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .company dd { margin: 0; }
  .company dd span { display: block; }
  .company .phones { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: .01em; }

  .head { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.6fr); gap: 16px 24px; margin-top: 16px; align-items: stretch; }
  .party-box { padding: 12px 16px; border: 1.5px solid #17365d; border-radius: 8px; background: #f3f8ff; }
  .val.party { margin-top: 4px; font-size: 20px; font-weight: 800; letter-spacing: .01em; color: #14213d; }
  /* Party and sub party set in from the box's right edge (owner, 26 Nov 2026). */
  .party-name.urdu { display: block; padding-right: 12px; font-size: 26px; font-weight: 700; text-align: right; }
  .sub-party { display: flex; align-items: baseline; gap: 12px; margin-top: 6px; padding-top: 6px; border-top: 1px dashed #c9d3e3; }
  .sub-party-name { flex: 1; font-size: 15px; font-weight: 700; }
  .sub-party-name.urdu { padding-right: 12px; font-size: 19px; text-align: right; }
  .sub-party-name.blank { min-height: 20px; border-bottom: 1px dotted #5e6e8a; }
  .meta { display: grid; gap: 8px; align-content: center; margin: 0; }
  .foot-row { display: flex; align-items: flex-end; gap: 32px; }
  .foot-row .sign { flex: 1; }
  .gp-qr { flex: none; white-space: nowrap; margin: 0; text-align: center; }
  .gp-qr svg { display: block; width: 76px; height: 76px; margin: 0 auto; }
  .gp-qr figcaption { margin-top: 2px; color: #5e6e8a; font-size: 8px; line-height: 1.25; }
  .meta .bill-no dd { color: #17365d; }
  .meta div { display: grid; grid-template-columns: 88px 1fr; align-items: end; gap: 8px; min-height: 30px; }
  .meta dt { margin: 0; }
  .meta dd { margin: 0; min-height: 22px; padding: 0 2px 2px; line-height: 20px; border-bottom: 1px solid #c9d3e3; font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .meta dd.blank { border-bottom: 1px dotted #5e6e8a; }
  .remarks { margin-top: 12px; display: flex; align-items: baseline; gap: 10px; }
  .remarks .urdu { font-size: 18px; }

  /* The old bill's table (owner, 26 Nov 2026): Urdu, right to left, every cell ruled, every value centred:
     تعداد · تفصیل · آرٹیکل · سائز · ریٹ جوڑا · ریٹ درجن · ٹوٹل. */
  .grid { width: 100%; border-collapse: collapse; margin-top: 0; direction: rtl; font-variant-numeric: tabular-nums; }
  .grid th, .grid td { padding: 0 8px; border: 1px solid #14213d; text-align: center; }
  .grid thead th { height: 30px; padding-top: 2px; padding-bottom: 2px; white-space: nowrap; background: #eef2f7; color: #14213d; font-family: "Noto Nastaliq Urdu", "Noto Naskh Arabic", Tahoma, sans-serif; font-size: 14px; font-weight: 700; line-height: 20px; }
  .grid td.desc { direction: rtl; unicode-bidi: isolate; }
  .grid .ltr { direction: ltr; unicode-bidi: isolate; }
  /* The three money columns, ریٹ جوڑا · ریٹ درجن · ٹوٹل, right-aligned (owner, 26 Nov 2026), and the bill total under them. */
  .grid th:nth-child(n + 5), .grid tbody td:nth-child(n + 5), .grid tbody.total td:last-child { text-align: right; padding-right: 12px; }
  /* Column widths as on the old bill: a wide description, narrow figures (right to left). */
  .grid th:nth-child(1) { width: 11.5%; } .grid th:nth-child(2) { width: 29%; } .grid th:nth-child(3) { width: 18%; } .grid th:nth-child(4) { width: 8.5%; }
  .grid th:nth-child(5) { width: 10%; } .grid th:nth-child(6) { width: 10.5%; } .grid th:nth-child(7) { width: 12.5%; }
  /* Every line of the table the same height and weight (owner, 26 Nov 2026); the total bar is set apart below. */
  .grid tr { break-inside: avoid; }
  .grid tbody td { height: 32px; padding-top: 0; padding-bottom: 0; font-size: 16px; font-weight: 700; line-height: 18px; vertical-align: middle; }
  /* تفصیل in regular weight, so the description reads quieter than the figures (owner, 26 Nov 2026). */
  .grid tbody td.desc { font-weight: 400; }
  .grid tbody tr:nth-child(even) td { background: #f7f9fc; }
  /* The total row prints once, after the last line, in a body of its own: a table foot repeats on every page, which put
     the whole bill's total under page 1's lines (seen on a 22-line bill, 26 Nov 2026). The head repeats. */
  /* The total bar in bold at title size, so the total stands apart from the lines at a glance (owner, 26 Nov 2026). No word in the bar: its place under تعداد and ٹوٹل says what it is. */
  .grid tbody.total td { height: 40px; border-top: 2px solid #14213d; background: #eef2f7; font-size: 22px; font-weight: 700; line-height: 24px; }
  /* The amount before the less and the less, above the net (owner, 28 Nov 2026): line height, their word on the right. */
  .grid tbody.sums td { height: 32px; border-top: 2px solid #14213d; font-size: 17px; font-weight: 700; line-height: 20px; vertical-align: middle; }
  .grid tbody.sums tr + tr td { border-top-width: 1px; }
  .grid td.sum-label { text-align: left; padding-left: 12px; font-family: "Noto Nastaliq Urdu", "Noto Naskh Arabic", Tahoma, sans-serif; font-size: 15px; font-weight: 700; }
  .grid tbody.sums td:last-child { text-align: right; padding-right: 12px; }


  .sign { display: grid; grid-template-columns: repeat(3, 1fr); gap: 40px; }
  .sign div { padding-top: 6px; border-top: 1px solid #14213d; text-align: center; }
  .foot { margin-top: 6px; font-size: 10px; color: #5e6e8a; text-align: center; }
  @media print {
    .print-actions { display: none; }
    body { margin: 0; background: none; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .page { margin: 0; box-shadow: none; break-after: page; }
    .page:last-child { break-after: auto; }
  }
`;

export interface SaleVoucherPrintOptions {
  /** Letterhead logo as a data URL; when absent the brand name is printed as text. */
  logoDataUrl?: string;
  /** The app's bundled Nastaliq as @font-face rules (urduFontFaceCss), so the Urdu prints as it shows on screen. */
  urduFontCss?: string;
}

/** dd/mm/yyyy from a plain YYYY-MM-DD voucher date. */
const formatBookDay = (ymd: string): string =>
  /^\d{4}-\d{2}-\d{2}$/.test(ymd ?? "") ? formatBookDate(`${ymd}T00:00:00`, ymd) : ymd || "";

/** Each line's figures through the one sale-line formula, and the bill's totals added exactly. */
const billOf = (voucher: SaleVoucher) => {
  const lines = voucher.lineItems.map((item) => ({
    item,
    figures: calculateSaleLine({
      dozens: item.quantity,
      pairRate: item.unitPrice,
      pairDiscount: discountPerPairFromTotal({ dozens: item.quantity, totalDiscount: item.discount }),
    }),
  }));
  return {
    lines,
    dozens: lines.reduce((sum, { item }) => sum + item.quantity, 0),
    gross: addMoney(...lines.map(({ figures }) => figures.amount)),
    less: addMoney(...lines.map(({ figures }) => figures.totalDiscount)),
    net: addMoney(...lines.map(({ figures }) => figures.total)),
  };
};

/** Dozens as the old bill wrote them: two decimals ("12.00", "7.50"). */
const dozensText = (dozens: number): string => dozens.toFixed(2);

/** Rupees as the old bill wrote them: whole with commas ("6,600"); paisa only when there are any, never rounded away. */
const rupeesText = (rupees: number): string => (Number.isInteger(rupees) ? formatWholeMoney(rupees) : formatMoney(rupees));

/** A cell of figures, kept left to right inside the right-to-left table ("7/10", "6,600"). */
const ltr = (value: string): string => `<span class="ltr">${e(value)}</span>`;

const rowHtml = ({ item, figures }: ReturnType<typeof billOf>["lines"][number]): string => `<tr>
        <td>${ltr(dozensText(item.quantity))}</td>
        <td class="desc">${e(item.groupName ?? "")}</td>
        <td>${ltr(item.article)}</td>
        <td>${ltr(item.size)}</td>
        <td>${ltr(rupeesText(item.unitPrice))}</td>
        <td>${ltr(rupeesText(figures.dozenRate))}</td>
        <td>${ltr(rupeesText(figures.amount))}</td>
      </tr>`;

/** A reference line beside the party (date, gatepass); an empty one is left as a dotted line to write on. */
const metaHtml = (label: string, value: string | null | undefined): string =>
  `<div><dt class="caps">${e(label)}</dt><dd class="${value ? "" : "blank"}">${e(value ?? "")}</dd></div>`;

/** A name as the bill shows it: in Urdu when there is one (owner, 26 Nov 2026), else in English, never left blank. */
const nameHtml = (className: string, urdu: string | null | undefined, english: string | null | undefined): string =>
  urdu ? `<span class="urdu ${className}">${e(urdu)}</span>` : `<span class="${className}">${e(english ?? "")}</span>`;

/** Bill to: the party, and under it the sub party (a dotted line to write on when there is none). */
const billToHtml = (voucher: SaleVoucher): string => {
  const subParty = voucher.subPartyNameUrdu || voucher.subPartyName
    ? nameHtml("sub-party-name", voucher.subPartyNameUrdu, voucher.subPartyName)
    : `<span class="sub-party-name blank"></span>`;
  return `<div class="party-box">
        <div class="caps">${e(text.billTo)}</div>
        <div class="val party">${nameHtml("party-name", voucher.partyNameUrdu, voucher.partyName)}</div>
        <div class="sub-party"><span class="caps">${e(text.subParty)}</span>${subParty}</div>
      </div>`;
};

/**
 * The gatepass the bill was made from, as a QR the ERP opens (owner, 26 Nov 2026): in the page foot, bottom right,
 * after the signatures, so the details above keep their width. Only on a bill made from a gatepass. The ERP's own code, not a web link (gatepassQr.ts).
 */
const gatepassQrHtml = (voucher: SaleVoucher): string => {
  if (!voucher.gatepassId) return "";
  let code: string;
  try { code = buildGatepassQr(voucher.gatepassId); } catch { return ""; } // never let the QR stop the bill printing
  return `<figure class="gp-qr">${renderQrSvgMarkup(code)}<figcaption>${e(text.gatepassQrHint)}</figcaption></figure>`;
};

const headHtml = (voucher: SaleVoucher): string => {
  return `<div class="head">
      <dl class="meta">
        <div class="bill-no"><dt class="caps">${e(text.billNo)}</dt><dd>${e(voucher.voucherNumber)}</dd></div>
        ${metaHtml(text.date, formatBookDay(voucher.voucherDate))}
        ${metaHtml(text.gatepass, voucher.gatepassCode ?? null)}
      </dl>
      ${billToHtml(voucher)}
    </div>
    ${voucher.remarks ? `<div class="remarks"><span class="caps">${e(text.remarks)}</span><span class="urdu">${e(voucher.remarks)}</span></div>` : ""}`;
};

type BillLine = ReturnType<typeof billOf>["lines"][number];

/**
 * The lines, page by page: LINES_PER_PAGE to a page, and the last page keeps room for the total row, so it is never
 * left alone on a page of its own nor squeezed off the bottom.
 */
export const pagesOf = <T>(lines: readonly T[], totalRows = 1): T[][] => {
  const pages: T[][] = [];
  let rest = [...lines];
  // The total rows are a little taller than a line: room is kept for one line more than there are total rows' worth.
  const room = totalRows === 1 ? 1 : totalRows + 1;
  while (rest.length > LINES_PER_PAGE - room) {
    const take = Math.min(LINES_PER_PAGE, rest.length - 1);
    pages.push(rest.slice(0, take));
    rest = rest.slice(take);
  }
  pages.push(rest);
  return pages;
};

/** How many rows the bill's total takes: the net alone, or the amount before the less, the less and the net. */
const totalRowsOf = (bill: ReturnType<typeof billOf>): number => (bill.less > 0 ? 3 : 1);

/** The bill's end: the total row, or, with a less, the amount before it, the less and the net (owner, 28 Nov 2026). */
const totalHtml = (bill: ReturnType<typeof billOf>): string => {
  const t = text.totals;
  if (totalRowsOf(bill) === 1) {
    return `<tbody class="total">
        <tr><td>${ltr(dozensText(bill.dozens))}</td><td class="total-gap" colspan="5"></td><td>${ltr(rupeesText(bill.net))}</td></tr>
      </tbody>`;
  }
  return `<tbody class="sums">
        <tr><td>${ltr(dozensText(bill.dozens))}</td><td class="sum-label" colspan="5">${e(t.gross)}</td><td>${ltr(rupeesText(bill.gross))}</td></tr>
        <tr><td></td><td class="sum-label" colspan="5">${e(t.less)}</td><td>${ltr(`−${rupeesText(bill.less)}`)}</td></tr>
      </tbody>
      <tbody class="total">
        <tr><td></td><td class="sum-label" colspan="5">${e(t.net)}</td><td>${ltr(rupeesText(bill.net))}</td></tr>
      </tbody>`;
};

/** One page's share of the table: the headings always, the total row only on the last page. */
const tableHtml = (lines: readonly BillLine[], bill: ReturnType<typeof billOf> | null): string => {
  const c = text.columns;
  const total = bill ? totalHtml(bill) : "";
  return `<table class="grid" lang="ur">
      <thead>
        <tr><th>${e(c.dozens)}</th><th>${e(c.description)}</th><th>${e(c.article)}</th><th>${e(c.size)}</th><th>${e(c.pairRate)}</th><th>${e(c.dozenRate)}</th><th>${e(c.total)}</th></tr>
      </thead>
      <tbody>${lines.map(rowHtml).join("")}</tbody>
      ${total}
    </table>`;
};

/** Builds the printable HTML for a sale voucher. Exported so it can be tested without a window. */
export const renderSaleVoucherPrintHtml = (voucher: SaleVoucher, options: SaleVoucherPrintOptions = {}): string => {
  const bill = billOf(voucher);
  const brand = options.logoDataUrl
    ? `<img src="${options.logoDataUrl}" alt="${e(copy.app.brandLine)}" />`
    : `<div class="brand-text">${e(copy.app.brandLine)}<small>${e(copy.app.brandSub)}</small></div>`;
  const header = `<header class="page-head">
    <div class="letterhead">
      ${brand}
      <dl class="company">
        <dt>${PIN_ICON}<span class="sr-only">${e(text.addressLabel)}</span></dt><dd>${copy.app.addressLines.map((line) => `<span>${e(line)}</span>`).join("")}</dd>
        <dt>${PHONE_ICON}<span class="sr-only">${e(text.contactLabel)}</span></dt><dd class="phones">${copy.app.phones.map((phone) => `<span>${e(phone)}</span>`).join("")}</dd>
      </dl>
    </div>
    ${headHtml(voucher)}
    </header>`;
  const printed = e(text.printed(formatDateTime(new Date().toISOString())));
  const qr = gatepassQrHtml(voucher);
  const pages = pagesOf(bill.lines, totalRowsOf(bill));
  // The logo in a page's free space, when the page has enough of it and there is a logo to show.
  const watermarkHtml = (lineCount: number, last: boolean): string =>
    options.logoDataUrl && LINES_PER_PAGE - lineCount - (last ? 1 : 0) >= WATERMARK_MIN_FREE_ROWS
      ? `<div class="watermark" aria-hidden="true"><img src="${options.logoDataUrl}" alt="" /></div>`
      : "";
  const pageHtml = (lines: readonly BillLine[], index: number): string => `<section class="page">
    ${header}
    <div class="page-body">${tableHtml(lines, index === pages.length - 1 ? bill : null)}${index < pages.length - 1 ? `<div class="pto">${e(text.pto)}</div>` : ""}${watermarkHtml(lines.length, index === pages.length - 1)}</div>
    <footer class="page-foot">
    <div class="foot-row">
      <div class="sign">
        <div class="caps">${e(text.sign.prepared)}</div>
        <div class="caps">${e(text.sign.checked)}</div>
        <div class="caps">${e(text.sign.received)}</div>
      </div>
      ${qr}
    </div>
    <div class="foot">${printed} &nbsp;·&nbsp; <span class="page-no">${e(text.pageOf(index + 1, pages.length))}</span></div>
    </footer>
  </section>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${e(text.docTitle(voucher.voucherNumber))}</title>
  <style>${options.urduFontCss ?? ""}${PRINT_STYLES}</style>
</head>
<body>
  <div class="print-actions"><button onclick="window.print()">${e(copy.reports.printOrSave)}</button></div>
  ${pages.map(pageHtml).join("\n  ")}
</body>
</html>`;
};

/** Opens the print-ready window; false when the popup was blocked so the caller can tell the operator. */
export const openSaleVoucherPrintWindow = (voucher: SaleVoucher): boolean =>
  openPrintDocumentAsync(loadLogoDataUrl().then((logoDataUrl) => renderSaleVoucherPrintHtml(voucher, { logoDataUrl, urduFontCss: urduFontFaceCss() })));
