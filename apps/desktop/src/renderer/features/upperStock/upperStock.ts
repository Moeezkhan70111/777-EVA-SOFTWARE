import { UPPER_STOCK_CATEGORY, UPPER_STOCK_SORT, type UpperMatrixArticle, type UpperMatrixRow, type UpperStockCategory, type UpperStockMatrix, type UpperStockSort } from "@erp/domain";
import { copy } from "../../config/copy";
import { formatQuantity } from "../rawMaterial/rawMaterial";
import type { NavIconId } from "../navigation/navCatalogue";
import type { StockReply } from "../kindStock/useStockList";

// What the Upper Stock page shows and reads. Every figure comes from the data layer's matrix
// (@erp/domain, buildUpperStockMatrix); this only checks the reply and words it.

export const UPPER_CATEGORY_TABS: ReadonlyArray<{ id: UpperStockCategory; label: string; icon: NavIconId }> = [
  { id: UPPER_STOCK_CATEGORY.ALL, label: copy.upperStock.categories.all, icon: "dashboard" },
  { id: UPPER_STOCK_CATEGORY.RUBBER, label: copy.upperStock.categories.rubber, icon: "upper" },
  { id: UPPER_STOCK_CATEGORY.RAGZINE, label: copy.upperStock.categories.ragzine, icon: "ragzine" },
  { id: UPPER_STOCK_CATEGORY.PVC, label: copy.upperStock.categories.pvc, icon: "pvc" },
  { id: UPPER_STOCK_CATEGORY.PASTING, label: copy.upperStock.categories.pasting, icon: "pasting" },
];

export const UPPER_SORT_OPTIONS: ReadonlyArray<{ id: UpperStockSort; label: string }> = [
  { id: UPPER_STOCK_SORT.NAME_ASC, label: copy.upperStock.sorts.nameAsc },
  { id: UPPER_STOCK_SORT.NAME_DESC, label: copy.upperStock.sorts.nameDesc },
  { id: UPPER_STOCK_SORT.STOCK_DESC, label: copy.upperStock.sorts.stockDesc },
  { id: UPPER_STOCK_SORT.STOCK_ASC, label: copy.upperStock.sorts.stockAsc },
];

/** A balance as the table prints it: a dash for nothing, thousands separated. */
export const cellText = (quantity: number): string => (quantity === 0 ? "-" : Number(formatQuantity(quantity)).toLocaleString());

/** "PVC UPPER" as its tab names it: "PVC Upper". A sub-category with no tab keeps its own name. */
export const categoryLabel = (categoryName: string): string =>
  UPPER_CATEGORY_TABS.find((tab) => tab.id === categoryName)?.label ?? categoryName;

/** "413 Dozen": what the article holds, on its card's head. */
export const stockPillText = (total: number, unitCode: string): string =>
  `${cellText(total)} ${unitCode.charAt(0)}${unitCode.slice(1).toLowerCase()}`.trim();

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isText = (value: unknown): value is string => typeof value === "string";

const isRow = (value: unknown, columns: number): value is UpperMatrixRow =>
  isRecord(value) &&
  isText(value.key) &&
  isText(value.size) &&
  isText(value.type) &&
  isNumber(value.total) &&
  Array.isArray(value.quantities) &&
  value.quantities.length === columns &&
  value.quantities.every(isNumber);

const isArticle = (value: unknown): value is UpperMatrixArticle =>
  isRecord(value) &&
  isText(value.key) &&
  isText(value.article) &&
  isText(value.categoryName) &&
  isText(value.unitCode) &&
  isNumber(value.total) &&
  Array.isArray(value.colours) &&
  value.colours.every(isText) &&
  Array.isArray(value.rows) &&
  value.rows.every((row) => isRow(row, (value.colours as unknown[]).length));

/** The main process's answer as the page can use it. Anything malformed is a failure, never a blank list. */
export const parseUpperStockReply = (reply: unknown): StockReply<UpperStockMatrix> => {
  if (!isRecord(reply)) return { ok: false, reason: copy.kindStock.unreadable };
  if (reply.accepted !== true) return { ok: false, reason: isText(reply.reason) ? reply.reason : copy.kindStock.unreadable };
  const { articles, articleCount, page, pages } = reply;
  const wellFormed = Array.isArray(articles) && articles.every(isArticle) && isNumber(articleCount) && isNumber(page) && isNumber(pages);
  return wellFormed ? { ok: true, data: { articles, articleCount, page, pages } } : { ok: false, reason: copy.kindStock.unreadable };
};
