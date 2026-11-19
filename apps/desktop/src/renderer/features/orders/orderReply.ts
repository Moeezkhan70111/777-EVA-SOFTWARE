import { isCustomerOrderStatus, isOrderProgress } from "@erp/domain";
import { copy } from "../../config/copy";
import type {
  CustomerOrder,
  CustomerOrderArticleProduct,
  CustomerOrderLine,
  CustomerOrderView,
  PendingOrderLine,
  PendingOrderParty,
  PendingOrderPartyPage,
} from "../../types/desktopApi";

// What the order screens read, checked at the boundary (R25). Every figure is the main process's; this only checks
// the reply. Anything malformed is a failure the screen shows, never a half-drawn order.

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isText = (value: unknown): value is string => typeof value === "string";
const isTextOrNull = (value: unknown): value is string | null => value === null || isText(value);
const isNumberOrNull = (value: unknown): value is number | null => value === null || isNumber(value);
const hasFigures = (value: Record<string, unknown>, keys: readonly string[]) => keys.every((key) => isNumber(value[key]));

const isLine = (value: unknown): value is CustomerOrderLine =>
  isRecord(value) &&
  isText(value.id) && isText(value.productVariantId) && isText(value.article) && isText(value.color) && isText(value.size) &&
  hasFigures(value, ["lineNo", "quantity", "dispatched", "pending"]);

export const isCustomerOrder = (value: unknown): value is CustomerOrder =>
  isRecord(value) &&
  isText(value.id) && isNumber(value.orderNumber) && isText(value.code) && isText(value.businessDate) &&
  isText(value.partyId) && isText(value.partyName) && isTextOrNull(value.note) && isCustomerOrderStatus(value.status) &&
  isNumber(value.revision) && isText(value.createdBy) && isText(value.createdAt) && isTextOrNull(value.updatedBy) &&
  isTextOrNull(value.cancelledBy) && isTextOrNull(value.cancelReason) &&
  isRecord(value.totals) && hasFigures(value.totals, ["ordered", "dispatched", "pending"]) &&
  Array.isArray(value.lines) && value.lines.every(isLine);

const isView = (value: unknown): value is CustomerOrderView =>
  isRecord(value) &&
  (value.order === null || isCustomerOrder(value.order)) &&
  isNumberOrNull(value.previousNumber) && isNumberOrNull(value.nextNumber) && isNumberOrNull(value.latestNumber);

const isProduct = (value: unknown): value is CustomerOrderArticleProduct =>
  isRecord(value) && isText(value.productVariantId) && isText(value.size) && isText(value.color);

const isParty = (value: unknown): value is PendingOrderParty =>
  isRecord(value) && isText(value.partyId) && isText(value.partyName) && isOrderProgress(value.progress) &&
  hasFigures(value, ["ordered", "dispatched", "pending", "lineCount", "orderCount"]);

const isPartyPage = (value: unknown): value is PendingOrderPartyPage =>
  isRecord(value) && Array.isArray(value.rows) && value.rows.every(isParty) && hasFigures(value, ["total", "page", "pageSize", "totalPending"]);

const isPendingLine = (value: unknown): value is PendingOrderLine =>
  isRecord(value) && isText(value.productVariantId) && isText(value.article) && isText(value.color) && isText(value.size) &&
  isOrderProgress(value.progress) && hasFigures(value, ["ordered", "dispatched", "pending"]) &&
  Array.isArray(value.orderCodes) && value.orderCodes.every(isText);

export type Reply<T> = { accepted: true; value: T } | { accepted: false; reason: string };

const refusalOf = (reply: unknown, fallback: string): { accepted: false; reason: string } => ({
  accepted: false,
  reason: isRecord(reply) && isText(reply.reason) && reply.reason.trim() ? reply.reason : fallback,
});

/** Reads `reply[field]` when the reply was accepted and the field passes `check`. */
function parse<T>(reply: unknown, field: string, check: (value: unknown) => value is T, fallback: string): Reply<T> {
  if (isRecord(reply) && reply.accepted === true && check(reply[field])) return { accepted: true, value: reply[field] as T };
  return refusalOf(reply, fallback);
}

const isProducts = (value: unknown): value is CustomerOrderArticleProduct[] => Array.isArray(value) && value.every(isProduct);
const isPendingLines = (value: unknown): value is PendingOrderLine[] => Array.isArray(value) && value.every(isPendingLine);

/** A save, edit or cancel answer: the order as it now stands. */
export const parseOrderReply = (reply: unknown): Reply<CustomerOrder> => parse(reply, "order", isCustomerOrder, copy.orders.loadFailed);
/** One order and its neighbours. */
export const parseOrderViewReply = (reply: unknown): Reply<CustomerOrderView> => parse(reply, "view", isView, copy.orders.loadFailed);
/** One article's live products. */
export const parseArticleReply = (reply: unknown): Reply<CustomerOrderArticleProduct[]> => parse(reply, "products", isProducts, copy.orders.articleFailed);
/** A page of parties with pending orders. */
export const parsePartyPageReply = (reply: unknown): Reply<PendingOrderPartyPage> => parse(reply, "page", isPartyPage, copy.pendingOrders.loadFailed);
/** One party's products. */
export const parsePendingLinesReply = (reply: unknown): Reply<PendingOrderLine[]> => parse(reply, "lines", isPendingLines, copy.pendingOrders.linesFailed);
