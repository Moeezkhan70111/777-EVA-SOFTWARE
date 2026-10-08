import type { ProductRow } from "../types/desktopApi";
import { computeBTypePrice } from "@erp/domain";
import { escapeHtml } from "./html";

export type RateListType = "ALL" | "A_TYPE" | "B_TYPE";
export type RateListFormat = "PICTURES" | "DIFFERENCE";

export interface RateListHierarchy {
  articleOrder: string[];
  sizeOrder: string[];
}

export interface RateListRow {
  article: string;
  size: string;
  newRate: number | null;
  oldRate: number | null;
  aRate: number | null;
  bRate: number | null;
  image: string | null;
}

const compareArticles = (left: string, right: string) => {
  const leftMatch = /^SK(\d+)$/i.exec(left.trim());
  const rightMatch = /^SK(\d+)$/i.exec(right.trim());
  if (leftMatch && rightMatch) return Number(leftMatch[1]) - Number(rightMatch[1]);
  if (leftMatch) return -1;
  if (rightMatch) return 1;
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
};

const compareWithOrder = (left: string, right: string, order: string[], fallback: (a: string, b: string) => number) => {
  const leftIndex = order.indexOf(left);
  const rightIndex = order.indexOf(right);
  if (leftIndex !== -1 || rightIndex !== -1) {
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  }
  return fallback(left, right);
};

export const buildRateListRows = (
  products: ProductRow[],
  type: RateListType,
  images: Record<string, string>,
  hierarchy: RateListHierarchy = { articleOrder: [], sizeOrder: [] },
  previousRates: Record<string, number | null> = {},
): RateListRow[] => {
  const rows: RateListRow[] = [];
  const seen = new Set<string>();

  for (const product of products) {
    if (product.status !== "ACTIVE") continue;
    const aPrice = product.sellingPrice;
    const bPrice = computeBTypePrice(product.sellingPrice);
    const price = type === "B_TYPE" ? bPrice : { ok: aPrice !== null, price: aPrice };
    if (type === "B_TYPE" && !price.ok) continue;
    const key = `${type}:${product.article}:${product.size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const currentRate = price.ok ? price.price : null;
    const historicalRate = type === "B_TYPE"
      ? previousRates[`${type}:${product.article}:${product.size}`] ?? (() => {
        const previousBPrice = computeBTypePrice(previousRates[`A_TYPE:${product.article}:${product.size}`] ?? null);
        return previousBPrice.ok ? previousBPrice.price : null;
      })()
      : previousRates[`${type}:${product.article}:${product.size}`] ?? null;
    rows.push({
      article: product.article,
      size: product.size,
      newRate: currentRate,
      oldRate: historicalRate !== null && historicalRate !== currentRate ? historicalRate : null,
      aRate: type === "B_TYPE" ? null : aPrice,
      bRate: type === "A_TYPE" ? null : bPrice.ok ? bPrice.price : null,
      image: images[product.article] ?? null,
    });
  }

  return rows.sort((left, right) =>
    compareWithOrder(left.article, right.article, hierarchy.articleOrder, compareArticles) ||
    compareWithOrder(left.size, right.size, hierarchy.sizeOrder, (a, b) => a.localeCompare(b, undefined, { numeric: true })),
  );
};

export const groupRateListRows = (rows: RateListRow[]) => {
  const groups = new Map<string, RateListRow[]>();
  for (const row of rows) groups.set(row.article, [...(groups.get(row.article) ?? []), row]);
  return [...groups.entries()];
};

const formatRate = (value: number | null) => value === null ? "" : Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));

export const buildRateListHtml = (input: {
  format: RateListFormat;
  type: RateListType;
  rows: RateListRow[];
  logo: string | null;
  generatedAt: string;
}) => {
  const title = input.format === "PICTURES" ? "RATE LIST" : "RATE LIST - DIFFERENCE";
  const typeLabel = input.type === "ALL" ? "All" : input.type === "A_TYPE" ? "A-Type" : "B-Type";
  const groups = groupRateListRows(input.rows);
  const pageColumns: Array<Array<Array<[string, RateListRow[]]>>> = [];
  for (let start = 0; start < groups.length || start === 0; start += 8) {
    const pageGroups = groups.slice(start, start + 8);
    const splitIndex = Math.min(4, pageGroups.length);
    pageColumns.push([pageGroups.slice(0, splitIndex), pageGroups.slice(splitIndex)]);
    if (!pageGroups.length) break;
  }
  const renderTable = (columnGroups: Array<[string, RateListRow[]]>) => {
    const allRates = input.type === "ALL";
    const difference = input.format === "DIFFERENCE";
    const header = allRates
      ? `${difference ? "" : "<th class=\"image-heading\">Picture</th>"}<th>Article</th><th>Size</th><th>A Rate</th><th>B Rate</th>`
      : input.format === "PICTURES"
      ? "<th class=\"image-heading\">Image</th><th>Art No.</th><th>Size</th><th>Price</th>"
      : "<th>Art No.</th><th>Size</th><th>New Rate</th><th>Old Rate</th>";
    const body = columnGroups.map(([article, rows]) => rows.map((row, index) => `
      <tr>
        ${index === 0 ? `${!difference ? `<td class="picture" rowspan="${rows.length}">${row.image ? `<img src="${row.image}" alt="${escapeHtml(article)}">` : "<span class=\"no-picture\" role=\"img\" aria-label=\"Image not available\" title=\"Image not available\">Image not available</span>"}</td>` : ""}<td class="article" rowspan="${rows.length}">${escapeHtml(article)}</td>` : ""}
        <td class="size">${escapeHtml(row.size)}</td>
        ${allRates
          ? `<td class="rate">${formatRate(row.aRate)}</td><td class="rate">${formatRate(row.bRate)}</td>`
          : `<td class="rate">${formatRate(row.newRate)}</td>${input.format === "DIFFERENCE" ? `<td class="rate old-rate">${formatRate(row.oldRate)}</td>` : ""}`}
      </tr>`).join("")).join("");
    return `<table${allRates ? " class=\"all-rates\"" : ""}><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
  };

  const renderPage = (columns: Array<Array<[string, RateListRow[]]>>) => `
    <section class="rate-list-page">
      <div class="brand">${input.logo ? `<img src="${input.logo}" alt="Company logo">` : ""}<div class="brand-name">777 Seven</div></div>
      <div class="title-band"><h1>${title}</h1><div class="meta"><span>DATE:</span><span>${escapeHtml(input.generatedAt)}</span></div></div>
      <div class="type-label">${typeLabel}</div>
      <div class="columns"><div>${renderTable(columns[0])}</div><div>${renderTable(columns[1])}</div></div>
      <div class="footer">Official product rates • 777 Seven</div>
    </section>`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: A4 portrait; margin: 6mm 7mm 8mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #111; font-family: Arial, "Segoe UI", sans-serif; font-size: 9pt; }
    .brand { height: 22mm; display: flex; align-items: center; justify-content: center; border: 1.2px solid #111; }
    .brand img { width: 34mm; max-height: 16mm; object-fit: contain; }
    .brand-name { display: none; }
    .rate-list-page { break-after: page; page-break-after: always; }
    .rate-list-page:last-child { break-after: auto; page-break-after: auto; }
    .title-band { display: grid; grid-template-columns: 1.5fr 1fr; height: 8mm; margin-top: 4mm; border: 1.2px solid #111; }
    h1 { display: flex; align-items: center; justify-content: center; margin: 0; border-right: 1.2px solid #111; font-size: 13pt; }
    .meta { display: grid; grid-template-columns: 1fr 1.35fr; align-items: center; margin: 0; font-size: 9pt; font-weight: 700; }
    .meta span { padding: 0 7px; }
    .meta span:first-child { text-align: right; }
    .meta span:last-child { text-align: center; }
    .type-label { display: none; }
    .columns { display: grid; grid-template-columns: 1fr 1fr; gap: 10mm; margin-top: 6mm; align-items: start; }
    .columns > div { min-width: 0; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    thead { display: table-header-group; }
    tbody, tr { break-inside: avoid; page-break-inside: avoid; }
    th { height: 8mm; padding: 3px 2px; border-bottom: 1px solid #999; font-size: 8.5pt; }
    td { height: 7mm; padding: 1px 2px; border: 1px solid #aaa; vertical-align: middle; font-weight: 700; }
    .picture { width: 39%; max-width: 39%; overflow: hidden; text-align: center; }
    .all-rates .picture { width: 32%; max-width: 32%; }
    .picture img { display: block; width: min(24mm, 100%); height: 24mm; max-width: 100%; margin: 0 auto; object-fit: contain; }
    .no-picture { display: inline-flex; width: 24mm; height: 24mm; align-items: center; justify-content: center; padding: 3px; border: 1px dashed #999; color: #777; font-size: 7pt; font-weight: 400; line-height: 1.2; text-align: center; }
    .article { width: 20%; text-align: center; font-size: 9.5pt; }
    .all-rates .article { width: 18%; }
    .size { width: 22%; text-align: center; font-size: 8.5pt; }
    .all-rates .size { width: 18%; }
    .rate { width: 19%; color: #fff; background: #32821f; font-size: 10pt; text-align: center; }
    .all-rates .rate { width: 16%; }
    .old-rate { background: #f1f3f4; color: #111; }
    .empty { color: #777; text-align: center; }
    .footer { margin-top: 6mm; color: #777; font-size: 7pt; text-align: center; }
  </style></head><body>${pageColumns.map(renderPage).join("")}</body></html>`;
};