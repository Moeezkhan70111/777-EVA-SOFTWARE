import type { ColorDictionary } from "@erp/domain";
import { copy } from "../../config/copy";
import { formatDate } from "../../utils/dates";
import { escapeHtml as e } from "../../utils/html";
import { formatQuantity } from "../rawMaterial/rawMaterial";
import { sheetColourName, type SheetSection, type SheetTable, type SheetTotal, type StockSheet, type StockSheetRow } from "./stockSheet";

// THE DANA STOCK SHEET ON PAPER, drawn like the sheet the store filled in by hand:
//
//   ┌──────────────── 777 logo ────────────────┐
//   │ DANA STOCK SHEET          DATE: 25 Nov 2026 │
//   ├ SPECIAL EVA/EVR COMPOUND ───────────────────┤   ← a banner per compound
//   │ ┌ EVA ──────────┐ ┌ EVR ──────────┐ …        │   ← a small table per kind, four across
//   │ │ تعداد سائز رنگ │ │ تعداد سائز رنگ │          │
//   │ │  40  1.65 سیاہ │ │  13  1.65 سیاہ │          │
//   │ │ 116   ٹوٹل      │ │ 212   ٹوٹل      │          │
//   └──────────────────────────────── ٹوٹل 526 ─┘   ← the whole store
//
// Every material set up is listed, an empty one with a blank count, so the sheet can still be
// written on. Figures are the data layer's balances; units are never added together. Standalone
// HTML (its own print window), so the colours are literals here, as in every other print-out.

const URDU_FONT_STACK = `"Noto Nastaliq Urdu", "Noto Naskh Arabic", Tahoma, sans-serif`;

/** Small tables across one A4 page, as on the paper sheet. */
const SHEET_COLUMNS = 4;

const STYLES = `
  * { box-sizing: border-box; }
  @page { size: A4 portrait; margin: 8mm; }
  body { font-family: "Segoe UI", Helvetica, Arial, sans-serif; margin: 18px; color: #111; font-size: 11px; }
  .print-actions { text-align: center; margin-bottom: 14px; }
  .print-actions button { padding: 10px 26px; font-size: 13px; font-weight: 600; background: #17365d; color: #fff; border: none; border-radius: 4px; cursor: pointer; }
  .doc { max-width: 900px; margin: 0 auto; }
  .logo { text-align: center; border: 1px solid #111; border-bottom: none; padding: 4px; }
  .logo img { height: 40px; width: auto; }
  .logo .brand { font-size: 18px; font-weight: 900; letter-spacing: .06em; color: #17365d; }
  .title { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid #111; font-weight: 700; letter-spacing: .04em; }
  .title div { padding: 4px 10px; text-align: center; }
  .title div + div { border-left: 1px solid #111; }
  .sections { display: grid; grid-template-columns: repeat(${SHEET_COLUMNS}, 1fr); grid-auto-flow: row dense; gap: 16px 14px; margin-top: 14px; align-items: start; }
  .banner { margin-bottom: 8px; padding: 8px; background: #5b9bd5; color: #fff; text-align: center; font-size: 12px; letter-spacing: .04em; border: 1px solid #2f5f8f; }
  .tables { display: grid; gap: 10px 14px; align-items: start; }
  ${Array.from({ length: SHEET_COLUMNS }, (_, index) => `.span-${index + 1} { grid-column: span ${index + 1}; } .span-${index + 1} .tables { grid-template-columns: repeat(${index + 1}, 1fr); }`).join("\n  ")}
  table { width: 100%; border-collapse: collapse; direction: rtl; break-inside: avoid; }
  th, td { border: 1px solid #111; padding: 3px 5px; text-align: center; font-weight: 700; }
  th.kind { background: #5b9bd5; color: #fff; font-size: 11px; letter-spacing: .04em; direction: ltr; }
  th.col { font-size: 10px; }
  td.num { font-variant-numeric: tabular-nums; }
  .ur { font-family: ${URDU_FONT_STACK}; line-height: 1.6; }
  tfoot td.label, .grand td.label { background: #5b9bd5; color: #fff; }
  .grand { display: flex; justify-content: flex-end; margin-top: 18px; }
  .grand table { width: 260px; }
  .grand td { font-size: 14px; padding: 5px 10px; }
  .empty { padding: 24px; text-align: center; color: #555; border: 1px dashed #999; margin-top: 14px; }
  @media print { .print-actions { display: none; } body { margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
`;

/** "40", "1,200.5"; blank for nothing in store, so the sheet can still be written on. */
const figure = (quantity: number): string => (quantity === 0 ? "" : Number(formatQuantity(quantity)).toLocaleString());

/** A count, with its unit only when the sheet holds more than one unit (they are never added together). */
const countLabel = (quantity: number, unitCode: string, showUnit: boolean): string => {
  const shown = figure(quantity);
  return showUnit && shown ? `${shown} ${unitCode}` : shown;
};

const totalLabel = (totals: readonly SheetTotal[], showUnit: boolean): string =>
  totals.length === 0 ? "0" : totals.map((total) => countLabel(total.quantity, total.unitCode, showUnit) || "0").join(" + ");

const rowHtml = (row: StockSheetRow, colours: ColorDictionary, showUnit: boolean): string =>
  `<tr><td class="ur">${e(sheetColourName(row, colours))}</td><td class="num">${e(row.size)}</td><td class="num">${e(countLabel(row.quantity, row.unitCode, showUnit))}</td></tr>`;

const tableHtml = (table: SheetTable, colours: ColorDictionary, showUnit: boolean): string => `
  <table>
    <thead>
      <tr><th class="kind" colspan="3">${e(table.title)}</th></tr>
      <tr><th class="col ur">${e(copy.kindStock.sheetColour)}</th><th class="col ur">${e(copy.kindStock.sheetSize)}</th><th class="col ur">${e(copy.kindStock.sheetQuantity)}</th></tr>
    </thead>
    <tbody>${table.rows.map((row) => rowHtml(row, colours, showUnit)).join("")}</tbody>
    <tfoot><tr><td class="label ur" colspan="2">${e(copy.kindStock.sheetTotal)}</td><td class="num">${e(totalLabel(table.totals, showUnit))}</td></tr></tfoot>
  </table>`;

/** A banner and its tables, as wide as its tables need: two compounds of two kinds sit side by side, as on paper. */
const sectionHtml = (section: SheetSection, colours: ColorDictionary, showUnit: boolean): string => {
  const span = Math.min(section.tables.length, SHEET_COLUMNS);
  const banner = section.banner ? `<div class="banner">${e(section.banner)}</div>` : "";
  const tables = section.tables.map((table) => tableHtml(table, colours, showUnit)).join("");
  return `<section class="span-${span}">${banner}<div class="tables">${tables}</div></section>`;
};

const bodyHtml = (sheet: StockSheet, colours: ColorDictionary): string => {
  if (sheet.sections.length === 0) return `<div class="empty">${e(copy.kindStock.sheetEmpty)}</div>`;
  const showUnit = sheet.totals.length > 1;
  const sections = sheet.sections.map((section) => sectionHtml(section, colours, showUnit)).join("");
  const grand = `<div class="grand"><table><tr><td class="label ur">${e(copy.kindStock.sheetTotal)}</td><td class="num">${e(totalLabel(sheet.totals, showUnit))}</td></tr></table></div>`;
  return `<div class="sections">${sections}</div>${grand}`;
};

/** The sheet as a print-ready page. `takenAt` is when the balances were read; `urduFontCss` the app's bundled Nastaliq (urduFontFaceCss). */
export const buildStockSheetHtml = (sheet: StockSheet, colours: ColorDictionary, logoDataUrl: string, takenAt: Date, urduFontCss = ""): string => `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" /><title>${e(copy.kindStock.sheetTitle)}</title><style>${urduFontCss}${STYLES}</style></head>
<body>
  <div class="print-actions"><button onclick="window.print()">${e(copy.reports.printOrSave)}</button></div>
  <div class="doc">
    <div class="logo">${logoDataUrl ? `<img src="${logoDataUrl}" alt="${e(copy.app.brandLine)}" />` : `<span class="brand">${e(copy.app.brandLine)}</span>`}</div>
    <div class="title"><div>${e(copy.kindStock.sheetTitle)}</div><div>${e(copy.kindStock.sheetDate)}: ${e(formatDate(takenAt))}</div></div>
    ${bodyHtml(sheet, colours)}
  </div>
</body></html>`;

/** What the print window says when the stock could not be read: the reason, never a blank or partial sheet. */
export const buildStockSheetFailureHtml = (reason: string): string => `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" /><title>${e(copy.kindStock.sheetTitle)}</title><style>${STYLES}</style></head>
<body><div class="doc"><div class="empty" role="alert"><b>${e(copy.kindStock.failedTitle)}</b><br />${e(reason)}</div></div></body></html>`;
