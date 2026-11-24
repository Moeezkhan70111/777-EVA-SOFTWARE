import { CARTONS_PER_DOZEN, cartonsToDozens, dozensToCartons } from "./units.js";

// CUSTOMER ORDERS AND PENDING ORDERS (docs/52).
//
//   ORD-000014 · 17 Nov · BEHRAAM SHOES
//     SK6 / RED   / 7/10   20 ordered
//     SK6 / BLACK / 8/11   15 ordered
//
// An order is what a party asked for, by article, colour and size, in cartons. It moves no stock, no money and no
// ledger: Gatepass stays the only document that does. What an order is still owed is
//
//   pending = ordered − dispatched
//
// where DISPATCHED is what gatepasses for that party were allocated against the line. The allocation is written when
// the gatepass is made, in the gatepass's own transaction (data layer, customerOrders.ts), and reversed when the
// gatepass is cancelled. It is never recomputed from what a screen shows.
//
// FIFO. A gatepass line for a party and a product (article + colour + size) is allocated to that party's open order
// lines for the same product, the OLDEST ORDER FIRST, each taking no more than it still owes. What is left over once
// every matching line is covered stays UNALLOCATED: a pending quantity never goes below zero.
//
// Pure: these are the rules the screen and the data layer share.

/** An order is OPEN until it is cancelled. "Fully dispatched" is not a status: it is pending = 0, computed. */
export const CUSTOMER_ORDER_STATUS = { OPEN: "OPEN", CANCELLED: "CANCELLED" } as const;
export type CustomerOrderStatus = (typeof CUSTOMER_ORDER_STATUS)[keyof typeof CUSTOMER_ORDER_STATUS];

/** An order line is ACTIVE until it is taken off the order by an edit. It is never deleted: allocations may name it. */
export const CUSTOMER_ORDER_LINE_STATUS = { ACTIVE: "ACTIVE", REMOVED: "REMOVED" } as const;
export type CustomerOrderLineStatus = (typeof CUSTOMER_ORDER_LINE_STATUS)[keyof typeof CUSTOMER_ORDER_LINE_STATUS];

/** A gatepass's allocation is ACTIVE until the gatepass is cancelled. */
export const ORDER_ALLOCATION_STATUS = { ACTIVE: "ACTIVE", REVERSED: "REVERSED" } as const;
export type OrderAllocationStatus = (typeof ORDER_ALLOCATION_STATUS)[keyof typeof ORDER_ALLOCATION_STATUS];

/** How far an order line, or a party, has been dispatched. Shown in words and by a mark, never by colour alone. */
export const ORDER_PROGRESS = { PENDING: "PENDING", PARTIAL: "PARTIAL", DISPATCHED: "DISPATCHED" } as const;
export type OrderProgress = (typeof ORDER_PROGRESS)[keyof typeof ORDER_PROGRESS];

/** Which lines the Pending Orders screen lists. */
export const PENDING_ORDER_FILTER = { OUTSTANDING: "OUTSTANDING", DISPATCHED: "DISPATCHED", ALL: "ALL" } as const;
export type PendingOrderFilter = (typeof PENDING_ORDER_FILTER)[keyof typeof PENDING_ORDER_FILTER];

/** The most lines (article × colour × size cells) one order may hold. */
export const CUSTOMER_ORDER_MAX_LINES = 600;

/** The largest quantity one cell may hold, in cartons: a typing slip, not an order, beyond this. */
export const CUSTOMER_ORDER_MAX_QUANTITY = 100_000;

/** The longest note or cancel reason an order may carry. */
export const CUSTOMER_ORDER_NOTE_MAX = 200;

/** "ORD-000014" — an order's number as screens show it. */
export const formatCustomerOrderCode = (orderNumber: number): string => `ORD-${String(orderNumber).padStart(6, "0")}`;

export const isCustomerOrderStatus = (value: unknown): value is CustomerOrderStatus =>
  value === CUSTOMER_ORDER_STATUS.OPEN || value === CUSTOMER_ORDER_STATUS.CANCELLED;

export const isOrderProgress = (value: unknown): value is OrderProgress =>
  value === ORDER_PROGRESS.PENDING || value === ORDER_PROGRESS.PARTIAL || value === ORDER_PROGRESS.DISPATCHED;

export const isPendingOrderFilter = (value: unknown): value is PendingOrderFilter =>
  value === PENDING_ORDER_FILTER.OUTSTANDING || value === PENDING_ORDER_FILTER.DISPATCHED || value === PENDING_ORDER_FILTER.ALL;

/** What an order line still owes. Never below zero, whatever the figures say. */
export const pendingOrderQuantity = (ordered: number, dispatched: number): number => Math.max(ordered - dispatched, 0);

/** Pending, partly dispatched, or fully dispatched. */
export function orderProgressOf(ordered: number, dispatched: number): OrderProgress {
  if (pendingOrderQuantity(ordered, dispatched) === 0) return ORDER_PROGRESS.DISPATCHED;
  return dispatched > 0 ? ORDER_PROGRESS.PARTIAL : ORDER_PROGRESS.PENDING;
}

/** Why a typed cell quantity cannot be saved, or null when it can. An empty box is not an error: it is no line. */
export function orderQuantityProblem(typed: string): string | null {
  const text = typed.trim();
  if (text === "") return null;
  const value = Number(text);
  if (!Number.isInteger(value) || value <= 0) return "Type a whole number of cartons above 0.";
  if (value > CUSTOMER_ORDER_MAX_QUANTITY) return `Keep a quantity under ${CUSTOMER_ORDER_MAX_QUANTITY.toLocaleString("en-US")} cartons.`;
  return null;
}

/**
 * ORDERS ARE TYPED IN DOZENS (owner, 24 Nov 2026: "the order is dozen, not carton"), and STORED in cartons like every
 * other carton figure (1 dozen = CARTONS_PER_DOZEN cartons, units.ts), so allocation against gatepasses is unchanged.
 * A box takes whole or half dozens: what becomes a whole number of cartons. Why a typed box cannot be saved, or null.
 */
export function orderDozensProblem(typed: string): string | null {
  const text = typed.trim();
  if (text === "") return null;
  const dozens = Number(text);
  if (!Number.isFinite(dozens) || dozens <= 0) return "Type the dozens, above 0.";
  if (!Number.isInteger(dozensToCartons(dozens))) return `Type whole or half dozens (1 dozen = ${CARTONS_PER_DOZEN} cartons).`;
  if (dozensToCartons(dozens) > CUSTOMER_ORDER_MAX_QUANTITY) {
    return `Keep a quantity under ${cartonsToDozens(CUSTOMER_ORDER_MAX_QUANTITY).toLocaleString("en-US")} dozen.`;
  }
  return null;
}

/** A typed box's dozens as the cartons an order line stores. Only for a box orderDozensProblem accepts. */
export const orderDozensToCartons = (typed: string): number => dozensToCartons(Number(typed.trim()));

/** One open order line a gatepass line may be allocated to, with what it still owes. */
export interface AllocationCandidate {
  readonly orderLineId: string;
  /** Ordered − already allocated, at the moment of allocation. */
  readonly pending: number;
}

export interface AllocationShare {
  readonly orderLineId: string;
  readonly quantity: number;
}

export interface FifoAllocation {
  readonly shares: readonly AllocationShare[];
  /** What no order line was owed: dispatched beyond the orders. */
  readonly unallocated: number;
}

/**
 * Allocates `dispatched` cartons to `candidates`, which the caller has put OLDEST ORDER FIRST. Each candidate takes
 * at most what it still owes; a candidate owed nothing is skipped. Whatever is left is unallocated.
 */
export function allocateFifo(dispatched: number, candidates: readonly AllocationCandidate[]): FifoAllocation {
  if (!Number.isInteger(dispatched) || dispatched < 0) throw new RangeError("A dispatched quantity is a whole number of cartons, 0 or more.");
  let left = dispatched;
  const shares: AllocationShare[] = [];
  for (const candidate of candidates) {
    if (left === 0) break;
    const owed = Math.max(Math.trunc(candidate.pending), 0);
    if (owed === 0) continue;
    const quantity = Math.min(owed, left);
    shares.push({ orderLineId: candidate.orderLineId, quantity });
    left -= quantity;
  }
  return { shares, unallocated: left };
}
