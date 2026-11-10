import type { CartonMatrixArticle, CartonMatrixRow, CartonStockMatrix } from "@erp/domain";
import { copy } from "../../config/copy";
import type { StockReply } from "../kindStock/useStockList";

// What the Carton Stock matrix reads, checked at the boundary (R25). Every figure is the main
// process's (@erp/domain buildCartonStockMatrix); this only checks the reply.

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isText = (value: unknown): value is string => typeof value === "string";
const isTextList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isText);

const isRow = (value: unknown, columns: number): value is CartonMatrixRow =>
  isRecord(value) &&
  isText(value.key) &&
  isText(value.size) &&
  isNumber(value.total) &&
  Array.isArray(value.quantities) &&
  value.quantities.length === columns &&
  value.quantities.every(isNumber);

const isArticle = (value: unknown): value is CartonMatrixArticle =>
  isRecord(value) &&
  isText(value.key) &&
  isText(value.article) &&
  isTextList(value.colours) &&
  Array.isArray(value.rows) &&
  value.rows.every((row) => isRow(row, (value.colours as string[]).length));

/** The main process's answer as the page can use it. Anything malformed is a failure, never a blank list. */
export const parseCartonMatrixReply = (reply: unknown): StockReply<CartonStockMatrix> => {
  if (!isRecord(reply)) return { ok: false, reason: copy.cartonStock.failed };
  if (reply.accepted !== true) return { ok: false, reason: isText(reply.reason) ? reply.reason : copy.cartonStock.failed };
  const { articles, articleCount, page, pages, seriesOptions } = reply;
  const wellFormed =
    Array.isArray(articles) && articles.every(isArticle) && isNumber(articleCount) && isNumber(page) && isNumber(pages) && isTextList(seriesOptions);
  return wellFormed ? { ok: true, data: { articles, articleCount, page, pages, seriesOptions } } : { ok: false, reason: copy.cartonStock.failed };
};
