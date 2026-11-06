import { RAW_MATERIAL_KIND, type StockKind } from "@erp/domain";
import { copy } from "../../config/copy";
import { formatQuantity } from "../rawMaterial/rawMaterial";
import type { StockReply } from "./useStockList";

// What the Upper Stock and Dana Stock pages read, checked at the boundary (R25): a type says what
// a reply should hold, this says what it does.

export interface KindStockRow {
  id: string;
  code: string;
  name: string;
  subCategory: string;
  quantity: number;
  unitCode: string;
}

export interface KindStockTotal {
  unitId: string;
  unitCode: string;
  quantity: number;
}

export interface KindStockPage {
  items: KindStockRow[];
  itemCount: number;
  totalsByUnit: KindStockTotal[];
  page: number;
  pages: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const isRow = (value: unknown): value is KindStockRow =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.code === "string" &&
  typeof value.name === "string" &&
  typeof value.subCategory === "string" &&
  isNumber(value.quantity) &&
  typeof value.unitCode === "string";

const isTotal = (value: unknown): value is KindStockTotal =>
  isRecord(value) && typeof value.unitId === "string" && typeof value.unitCode === "string" && isNumber(value.quantity);

/** The main process's answer as the page can use it. Anything malformed is a failure, never a blank list. */
export const parseKindStockReply = (reply: unknown): StockReply<KindStockPage> => {
  if (!isRecord(reply)) return { ok: false, reason: copy.kindStock.unreadable };
  if (reply.accepted !== true) return { ok: false, reason: typeof reply.reason === "string" ? reply.reason : copy.kindStock.unreadable };
  const { items, itemCount, totalsByUnit, page, pages } = reply;
  const wellFormed =
    Array.isArray(items) && items.every(isRow) && Array.isArray(totalsByUnit) && totalsByUnit.every(isTotal) && isNumber(itemCount) && isNumber(page) && isNumber(pages);
  return wellFormed ? { ok: true, data: { items, itemCount, totalsByUnit, page, pages } } : { ok: false, reason: copy.kindStock.unreadable };
};

/** "1,200 DOZEN": a balance as the store says it. */
export const quantityLabel = (quantity: number, unitCode: string): string =>
  `${Number(formatQuantity(quantity)).toLocaleString()} ${unitCode}`.trim();

/** The words on each kind's page. */
export const KIND_STOCK_TEXT: Record<StockKind, { title: string; emptyTitle: string; emptyHint: string }> = {
  [RAW_MATERIAL_KIND.UPPER]: { title: copy.nav.items.upperStock.label, emptyTitle: copy.kindStock.upperEmptyTitle, emptyHint: copy.kindStock.upperEmptyHint },
  [RAW_MATERIAL_KIND.DANA]: { title: copy.nav.items.danaStock.label, emptyTitle: copy.kindStock.danaEmptyTitle, emptyHint: copy.kindStock.danaEmptyHint },
};
