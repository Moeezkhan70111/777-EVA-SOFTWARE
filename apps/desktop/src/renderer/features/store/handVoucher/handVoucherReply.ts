import { isHandVoucherStatus, isStoreDirection } from "@erp/domain";
import { copy } from "../../../config/copy";
import type { HandVoucher, HandVoucherLine, HandVoucherReply, HandVoucherView, HandVoucherViewReply } from "../../../types/desktopApi";

// What the Move In voucher screen reads, checked at the boundary (R25). Every figure is the main process's; this only
// checks the reply. Anything malformed is a failure the screen shows, never a half-drawn voucher.

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isText = (value: unknown): value is string => typeof value === "string";
const isTextOrNull = (value: unknown): value is string | null => value === null || isText(value);
const isNumberOrNull = (value: unknown): value is number | null => value === null || isNumber(value);

const isLine = (value: unknown): value is HandVoucherLine =>
  isRecord(value) &&
  isNumber(value.lineNo) &&
  isText(value.itemId) &&
  isText(value.itemName) &&
  isNumber(value.typedQuantity) &&
  isText(value.typedUnitCode) &&
  isNumber(value.quantity) &&
  isText(value.stockUnitCode);

export const isHandVoucher = (value: unknown): value is HandVoucher =>
  isRecord(value) &&
  isText(value.id) &&
  isStoreDirection(value.direction) &&
  isNumber(value.voucherNumber) &&
  isText(value.code) &&
  isText(value.businessDate) &&
  isText(value.partyId) &&
  isText(value.partyName) &&
  isTextOrNull(value.note) &&
  isHandVoucherStatus(value.status) &&
  isNumber(value.revision) &&
  isText(value.createdBy) &&
  isText(value.createdAt) &&
  isTextOrNull(value.updatedBy) &&
  isTextOrNull(value.deletedBy) &&
  typeof value.editable === "boolean" &&
  Array.isArray(value.lines) &&
  value.lines.every(isLine);

const isView = (value: unknown): value is HandVoucherView =>
  isRecord(value) &&
  (value.voucher === null || isHandVoucher(value.voucher)) &&
  isNumberOrNull(value.previousNumber) &&
  isNumberOrNull(value.nextNumber) &&
  isNumberOrNull(value.latestNumber);

const refusalOf = (reply: unknown, fallback: string): { accepted: false; reason: string } => ({
  accepted: false,
  reason: isRecord(reply) && isText(reply.reason) && reply.reason.trim() ? reply.reason : fallback,
});

/** A save, edit or delete answer. */
export const parseVoucherReply = (reply: unknown): HandVoucherReply => {
  if (isRecord(reply) && reply.accepted === true && isHandVoucher(reply.voucher)) return { accepted: true, voucher: reply.voucher };
  return refusalOf(reply, copy.states.loadFailedBody);
};

/** A read: one voucher and its neighbours. */
export const parseViewReply = (reply: unknown): HandVoucherViewReply => {
  if (isRecord(reply) && reply.accepted === true && isView(reply.view)) return { accepted: true, view: reply.view };
  return refusalOf(reply, copy.handVoucher.loadFailed);
};
