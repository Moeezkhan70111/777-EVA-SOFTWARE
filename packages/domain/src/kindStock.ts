// The Upper Stock and Dana Stock pages: one kind of raw material each, behind a permission of its
// own. One list, read by the main process that enforces it and the screens that offer the pages,
// so the two cannot disagree. The kinds are the store's own top-level categories (RAW_MATERIAL_KIND).

import { PERMISSION, type PermissionCode } from "./constants.js";
import { RAW_MATERIAL_KIND } from "./machineProgram.js";

export type StockKind = (typeof RAW_MATERIAL_KIND)[keyof typeof RAW_MATERIAL_KIND];

export const STOCK_KIND_PERMISSION: Record<StockKind, PermissionCode> = {
  [RAW_MATERIAL_KIND.UPPER]: PERMISSION.STOCK_UPPER_VIEW,
  [RAW_MATERIAL_KIND.DANA]: PERMISSION.STOCK_DANA_VIEW,
};

export const isStockKind = (value: unknown): value is StockKind =>
  typeof value === "string" && Object.hasOwn(STOCK_KIND_PERMISSION, value);

/** Rows on one page of a kind's stock list, and the most a caller may ask for. */
export const KIND_STOCK_PAGE_SIZE = 50;
export const KIND_STOCK_MAX_PAGE_SIZE = 100;
