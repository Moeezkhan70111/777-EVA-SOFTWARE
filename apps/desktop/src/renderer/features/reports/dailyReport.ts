import { cartonsToDozens, operationalDayBounds } from "@erp/domain";
import { copy } from "../../config/copy";
import { formatBookDate, formatDate } from "../../utils/dates";
import { escapeHtml } from "../../utils/html";

// Shared by Daily Production and Daily Dispatch: the article → size → colour grouping of a
// report and the black-on-white A4 print-out laid out like the paper daily sheet.
// (One template for both, CLAUDE.md R1.)

export interface ColorRow {
  color: string;
  quantity: number;
}

export interface ArticleSizeGroup {
  article: string;
  size: string;
  colors: ColorRow[];
  total: number;
}

/**
 * Groups report rows ("ARTICLE_COLOR_SIZE" keys) by article + size. Article and size never
 * contain underscores; the colour may, so it is everything in between.
 */
export function buildHierarchy(topProducts: Array<{ key: string; quantity: number }>): ArticleSizeGroup[] {
  const map = new Map<string, ArticleSizeGroup>();

  for (const row of topProducts) {
    const parts = row.key.split("_");
    if (parts.length < 3) continue;

    const article = parts[0];
    const size = parts[parts.length - 1];
    const color = parts.slice(1, parts.length - 1).join("_");
    const groupKey = `${article}__${size}`;

    if (!map.has(groupKey)) {
      map.set(groupKey, { article, size, colors: [], total: 0 });
    }
    const group = map.get(groupKey)!;
    group.colors.push({ color, quantity: row.quantity });
    group.total += row.quantity;
  }

  return Array.from(map.values()).sort((a, b) => {
    const byArticle = a.article.localeCompare(b.article);
    return byArticle !== 0 ? byArticle : a.size.localeCompare(b.size);
  });
}

/** Cartons → dozens as a plain number string (the conversion lives in @erp/domain). */
export const dozNum = (cartons: number): string => cartonsToDozens(cartons).toString();

/** Cartons → "n Dzn". */
export const toDoz = (cartons: number): string => `${dozNum(cartons)} Dzn`;

/** A plain `YYYY-MM-DD` report date is a calendar day, formatted as such. */
export const formatReportDate = (date: string): string => (date ? formatDate(`${date}T00:00:00`, date) : copy.common.none);

/** "21/08/2026 06:00 → 22/08/2026 06:00" — the operational day the report covers. */
export const formatOperationalDayRange = (date: string): string => {
  const bounds = operationalDayBounds(date);
  const startTime = bounds.from.slice(11, 16);
  return `${formatBookDate(bounds.from)} ${startTime} → ${formatBookDate(bounds.to)} ${startTime}`;
};

const PRINT_STYLES = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  @page { size: A4 portrait; margin: 20mm 18mm 20mm 18mm; }
  body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 12pt; line-height: 1.5; background: #fff; color: #000; -webkit-font-smoothing: antialiased; }
  .page-wrap { max-width: 640px; margin: 0 auto; padding: 48px 24px 64px; }
  .report-header { text-align: center; margin-bottom: 10pt; }
  .report-logo { display: block; height: 52px; width: auto; margin: 0 auto 8pt; object-fit: contain; }
  .report-title { font-size: 16pt; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 2pt; }
  .report-date { font-size: 11pt; font-weight: 600; margin-bottom: 1pt; }
  .report-range { font-size: 9.5pt; font-weight: 400; }
  .header-rule { border: none; border-top: 2px solid #000; margin: 8pt 0 14pt; }
  .article-section { border: 2px solid #000; border-radius: 5px; overflow: hidden; margin-bottom: 18pt; page-break-inside: avoid; }
  .article-heading { display: flex; justify-content: space-between; align-items: baseline; padding: 8pt 12pt; border-bottom: 2px solid #000; }
  .article-heading-name { font-size: 12pt; font-weight: 700; letter-spacing: 0.02em; }
  .article-heading-size { font-size: 11pt; font-weight: 700; }
  .color-row { display: flex; justify-content: space-between; align-items: baseline; padding: 4pt 12pt 4pt 24pt; border-bottom: 1px solid #555; }
  .color-row:last-of-type { border-bottom: none; }
  .color-name, .color-qty { font-size: 11pt; font-weight: 400; }
  .color-qty { font-variant-numeric: tabular-nums; }
  .total-row { display: flex; justify-content: space-between; align-items: baseline; padding: 7pt 12pt; border-top: 2px solid #000; }
  .total-label { font-size: 11pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
  .total-qty { font-size: 11pt; font-weight: 700; font-variant-numeric: tabular-nums; }
  .grand-total-rule { border: none; border-top: 2px solid #000; margin: 18pt 0 8pt; }
  .grand-total-row { display: flex; justify-content: space-between; align-items: baseline; }
  .grand-total-label { font-size: 13pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
  .grand-total-qty { font-size: 14pt; font-weight: 700; font-variant-numeric: tabular-nums; }
  .qty-num { font-variant-numeric: tabular-nums; }
  .qty-unit { font-size: 7.5pt; font-weight: 400; color: #555; margin-left: 3pt; letter-spacing: 0.02em; }
  .no-data { font-size: 11pt; text-align: center; padding: 24pt 0; }
  .report-footer { margin-top: 28pt; text-align: center; font-size: 8.5pt; letter-spacing: 0.02em; }
  .print-btn { display: block; margin: 36px auto 0; padding: 9px 28px; background: #fff; border: 1.5px solid #000; border-radius: 5px; font-family: inherit; font-size: 12px; font-weight: 600; color: #000; cursor: pointer; }
  .print-btn:hover { background: #f5f5f5; }
  @media print {
    .page-wrap { max-width: 100%; padding: 0; }
    .print-btn { display: none; }
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
`;

const quantity = (cartons: number) => `<span class="qty-num">${escapeHtml(dozNum(cartons))}</span><span class="qty-unit">Dzn</span>`;

export interface DailyReportPrintInput {
  /** e.g. copy.reports.dailyProduction */
  title: string;
  /** Label before the date, e.g. "Production Date". */
  dateLabel: string;
  /** `YYYY-MM-DD` operational day. */
  date: string;
  groups: ArticleSizeGroup[];
  emptyText: string;
  logoDataUrl?: string;
}

/** Builds the print-ready HTML for a daily sheet. Every value is escaped; all text comes from copy. */
export const renderDailyReportHtml = (input: DailyReportPrintInput): string => {
  const grandTotal = input.groups.reduce((sum, group) => sum + group.total, 0);
  const sections =
    input.groups.length === 0
      ? `<div class="no-data">${escapeHtml(input.emptyText)}</div>`
      : input.groups
          .map(
            (group) => `
      <div class="article-section">
        <div class="article-heading">
          <span class="article-heading-name">${escapeHtml(group.article)}</span>
          <span class="article-heading-size">${escapeHtml(group.size)}</span>
        </div>
        ${group.colors
          .map(
            (row) => `
          <div class="color-row">
            <span class="color-name">${escapeHtml(row.color)}</span>
            <span class="color-qty">${quantity(row.quantity)}</span>
          </div>`
          )
          .join("")}
        <div class="total-row">
          <span class="total-label">${escapeHtml(copy.reports.total)}</span>
          <span class="total-qty">${quantity(group.total)}</span>
        </div>
      </div>`
          )
          .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(input.title)} — ${escapeHtml(formatReportDate(input.date))}</title>
  <style>${PRINT_STYLES}</style>
</head>
<body>
<div class="page-wrap">
  <div class="report-header">
    ${input.logoDataUrl ? `<img src="${input.logoDataUrl}" alt="${escapeHtml(copy.app.brandLine)}" class="report-logo" />` : ""}
    <div class="report-title">${escapeHtml(input.title)}</div>
    <div class="report-date">${escapeHtml(input.dateLabel)}: ${escapeHtml(formatReportDate(input.date))}</div>
    <div class="report-range">${escapeHtml(formatOperationalDayRange(input.date))}</div>
  </div>
  <hr class="header-rule" />
  ${sections}
  <hr class="grand-total-rule" />
  <div class="grand-total-row">
    <span class="grand-total-label">${escapeHtml(copy.reports.grandTotal)}</span>
    <span class="grand-total-qty">${quantity(grandTotal)}</span>
  </div>
  <div class="report-footer">${escapeHtml(copy.reports.generatedOn(formatDate(new Date())))}</div>
  <button class="print-btn" onclick="window.print()">${copy.reports.printOrSave}</button>
</div>
</body>
</html>`;
};
