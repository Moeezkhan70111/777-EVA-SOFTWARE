import { isCartonAdjustmentDirection, isCartonAdjustmentKind, type CartonAdjustmentDirection, type CartonAdjustmentKind } from "@erp/domain";
import { copy } from "../../config/copy";

// What the Stock Adjustment page reads from the main process, checked at the boundary (R25). Every figure is the
// main process's (cartonStockDocuments.ts); this only checks the reply. Anything malformed is a failure, never a
// blank list.

export interface AdjustmentChoice {
  readonly articleSizeId: string;
  readonly size: string;
  readonly color: string;
  readonly inStore: number;
  readonly hasOpening: boolean;
  /** The article has this colour on another size but not on this one yet. */
  readonly colorMissing: boolean;
}

export interface AdjustmentLine {
  readonly lineNo: number;
  readonly article: string;
  readonly size: string;
  readonly color: string;
  readonly direction: CartonAdjustmentDirection;
  readonly cartons: number;
}

export interface AdjustmentDocument {
  readonly id: string;
  readonly code: string;
  readonly kind: CartonAdjustmentKind;
  readonly businessDate: string;
  readonly reason: string;
  readonly remarks: string | null;
  readonly postedBy: string;
  readonly postedAt: string;
  readonly cartonsIn: number;
  readonly cartonsOut: number;
  readonly lines: readonly AdjustmentLine[];
}

export interface AdjustmentHistory {
  readonly documents: readonly AdjustmentDocument[];
  readonly total: number;
  readonly page: number;
  readonly pages: number;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isText = (value: unknown): value is string => typeof value === "string";
const failed = (reply: unknown): { ok: false; reason: string } => ({
  ok: false,
  reason: isRecord(reply) && isText(reply.reason) ? reply.reason : copy.stockAdjustment.failed,
});

const isChoice = (value: unknown): value is Omit<AdjustmentChoice, "colorMissing"> & { colorMissing?: unknown } =>
  isRecord(value) && isText(value.articleSizeId) && isText(value.size) && isText(value.color) && isNumber(value.inStore) && typeof value.hasOpening === "boolean" &&
  (value.colorMissing === undefined || typeof value.colorMissing === "boolean");

const isLine = (value: unknown): value is AdjustmentLine =>
  isRecord(value) && isNumber(value.lineNo) && isText(value.article) && isText(value.size) && isText(value.color) &&
  isCartonAdjustmentDirection(value.direction) && isNumber(value.cartons);

const isDocument = (value: unknown): value is AdjustmentDocument =>
  isRecord(value) && isText(value.id) && isText(value.code) && isCartonAdjustmentKind(value.kind) && isText(value.businessDate) &&
  isText(value.reason) && (value.remarks === null || isText(value.remarks)) && isText(value.postedBy) && isText(value.postedAt) &&
  isNumber(value.cartonsIn) && isNumber(value.cartonsOut) && Array.isArray(value.lines) && value.lines.every(isLine);

export const parseChoicesReply = (reply: unknown): Checked<AdjustmentChoice[]> => {
  if (!isRecord(reply) || reply.accepted !== true) return failed(reply);
  if (!Array.isArray(reply.choices) || !reply.choices.every(isChoice)) return failed(null);
  return { ok: true, value: reply.choices.map((choice) => ({ ...choice, colorMissing: choice.colorMissing === true })) };
};

export const parseHistoryReply = (reply: unknown): Checked<AdjustmentHistory> => {
  if (!isRecord(reply) || reply.accepted !== true || !isRecord(reply.page)) return failed(reply);
  const { documents, total, page, pages } = reply.page;
  const wellFormed = Array.isArray(documents) && documents.every(isDocument) && isNumber(total) && isNumber(page) && isNumber(pages);
  return wellFormed ? { ok: true, value: { documents, total, page, pages } } : failed(null);
};

export const parsePostReply = (reply: unknown): Checked<{ document: AdjustmentDocument; duplicate: boolean }> => {
  if (!isRecord(reply) || reply.accepted !== true) return failed(reply);
  return isDocument(reply.document) ? { ok: true, value: { document: reply.document, duplicate: reply.duplicate === true } } : failed(null);
};
