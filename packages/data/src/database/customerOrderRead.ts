// Reading one customer order (docs/52): its header and its ACTIVE lines, each with what gatepasses dispatched against
// it (ORDER_LINE_DISPATCHED_SQL, the one definition) and what it still owes. Read only.

import { CUSTOMER_ORDER_STATUS, formatCustomerOrderCode, pendingOrderQuantity, type CustomerOrderStatus } from "@erp/domain";
import type { MutableTransactionContext } from "./shared.js";
import { ORDER_LINE_DISPATCHED_SQL } from "./orderAllocation.js";

type Row = Record<string, unknown>;
type Db = MutableTransactionContext["db"];
const text = (value: unknown): string => (value == null ? "" : String(value));
const textOrNull = (value: unknown): string | null => (value == null || String(value) === "" ? null : String(value));

export interface CustomerOrderLine {
  readonly id: string;
  readonly lineNo: number;
  readonly productVariantId: string;
  readonly article: string;
  readonly color: string;
  readonly size: string;
  readonly quantity: number;
  /** Cartons gatepasses were allocated against this line, not reversed. */
  readonly dispatched: number;
  /** quantity − dispatched, never below zero. 0 on a cancelled order. */
  readonly pending: number;
}

export interface OrderTotals {
  readonly ordered: number;
  readonly dispatched: number;
  readonly pending: number;
}

export interface CustomerOrder {
  readonly id: string;
  readonly orderNumber: number;
  readonly code: string;
  readonly businessDate: string;
  readonly partyId: string;
  readonly partyName: string;
  readonly note: string | null;
  readonly status: CustomerOrderStatus;
  readonly revision: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedBy: string | null;
  readonly updatedAt: string;
  readonly cancelledBy: string | null;
  readonly cancelledAt: string | null;
  readonly cancelReason: string | null;
  readonly totals: OrderTotals;
  readonly lines: readonly CustomerOrderLine[];
}

const totalsOf = (lines: readonly CustomerOrderLine[]): OrderTotals => ({
  ordered: lines.reduce((sum, line) => sum + line.quantity, 0),
  dispatched: lines.reduce((sum, line) => sum + line.dispatched, 0),
  pending: lines.reduce((sum, line) => sum + line.pending, 0),
});

function readLines(db: Db, orderId: string, cancelled: boolean): CustomerOrderLine[] {
  const rows = db
    .prepare(
      `SELECT ol.*, ${ORDER_LINE_DISPATCHED_SQL} AS dispatched FROM customer_order_lines ol
        WHERE ol.order_id = ? AND ol.status = 'ACTIVE' ORDER BY ol.line_no`
    )
    .all(orderId) as Row[];
  return rows.map((row) => {
    const quantity = Number(row.quantity);
    const dispatched = Number(row.dispatched ?? 0);
    return {
      id: text(row.id),
      lineNo: Number(row.line_no),
      productVariantId: text(row.product_variant_id),
      article: text(row.article_snapshot),
      color: text(row.color_snapshot),
      size: text(row.size_snapshot),
      quantity,
      dispatched,
      pending: cancelled ? 0 : pendingOrderQuantity(quantity, dispatched),
    };
  });
}

/** The order and its active lines, or null when it is not on this computer. */
export function readCustomerOrder(db: Db, orderId: string): CustomerOrder | null {
  const row = db.prepare("SELECT o.*, p.party_name FROM customer_orders o LEFT JOIN parties p ON p.id = o.party_id WHERE o.id = ?").get(orderId) as Row | undefined;
  if (!row) return null;
  const status = text(row.status) === CUSTOMER_ORDER_STATUS.CANCELLED ? CUSTOMER_ORDER_STATUS.CANCELLED : CUSTOMER_ORDER_STATUS.OPEN;
  const lines = readLines(db, orderId, status === CUSTOMER_ORDER_STATUS.CANCELLED);
  return {
    id: text(row.id),
    orderNumber: Number(row.order_number),
    code: formatCustomerOrderCode(Number(row.order_number)),
    businessDate: text(row.business_date),
    partyId: text(row.party_id),
    partyName: text(row.party_name),
    note: textOrNull(row.note),
    status,
    revision: Number(row.revision),
    createdBy: text(row.created_by),
    createdAt: text(row.created_at),
    updatedBy: textOrNull(row.updated_by),
    updatedAt: text(row.updated_at),
    cancelledBy: textOrNull(row.cancelled_by),
    cancelledAt: textOrNull(row.cancelled_at),
    cancelReason: textOrNull(row.cancel_reason),
    totals: totalsOf(lines),
    lines,
  };
}
