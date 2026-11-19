// WHAT GATEPASSES DISPATCHED AGAINST CUSTOMER ORDERS (docs/52, local migration 112).
//
//   WRITE  allocateGatepassToOrders        in the gatepass's create transaction: its lines, oldest order first
//   WRITE  reverseGatepassOrderAllocation  in the gatepass's cancel transaction: exactly what it allocated, back
//   WRITE  reallocateGatepassOrders        for a gatepass whose lines changed: old allocation reversed, new one made
//
// THE ALLOCATION IS A RECORD, NOT A READING. It is written by the transaction that makes the gatepass, so a gatepass
// that is not made allocates nothing, and one that is made always has its allocation, after a restart and on every
// computer it travels to (GATEPASS_ORDER_ALLOCATION, under SALES_DISPATCH with the gatepass). No other computer works
// it out again: a receiver writes the record as it came.
//
// FIFO (allocateFifo, @erp/domain): a gatepass line for a party and a product goes to that party's OPEN orders' ACTIVE
// lines for the same product, the oldest order first, each up to what it still owes. What is left is unallocated, and
// recorded as such. A pending quantity never goes below zero.
//
// ONCE PER GATEPASS. gatepass_order_allocations is UNIQUE on gatepass_id, and allocating a gatepass that already has an
// allocation returns it untouched, so a retried Create (which the use case answers before this, by its request id)
// could not count the same dispatch twice even if it got here. Reversing an allocation already reversed finds nothing.
//
// MOVES NOTHING ELSE. No stock, no money, no ledger, no gatepass field is touched here.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import crypto from "node:crypto";
import { ORDER_ALLOCATION_STATUS, allocateFifo, type AllocationShare } from "@erp/domain";
import type { GatepassOrderAllocationInput, GatepassOrderAllocationSummary, TransactionContext } from "@erp/application";
import type { SqliteDatabase } from "../sqliteDatabase.js";
import type { MutableTransactionContext } from "./shared.js";
import { insertAuditRow } from "./gatepass.js";

type Row = Record<string, unknown>;
type Db = MutableTransactionContext["db"];

/**
 * Cartons gatepasses dispatched against one order line, `ol` being customer_order_lines: every allocation line naming
 * it that is not reversed. The one definition, read by every figure on every screen.
 */
export const ORDER_LINE_DISPATCHED_SQL = `COALESCE((SELECT SUM(al.quantity) FROM gatepass_order_allocation_lines al
                                                     WHERE al.order_line_id = ol.id AND al.reversed_at IS NULL), 0)`;

/** One gatepass line's place in the plan: what it dispatched, and how that was shared out. */
interface PlannedLine {
  readonly gatepassLineId: string;
  readonly productVariantId: string;
  readonly shares: readonly AllocationShare[];
  readonly unallocated: number;
}

interface AllocationPlan {
  readonly lines: readonly PlannedLine[];
  readonly allocated: number;
  readonly unallocated: number;
}

/** The party's open order lines for one product, OLDEST ORDER FIRST, with what each still owes. */
function candidatesFor(db: Db, partyId: string, productVariantId: string) {
  const rows = db
    .prepare(
      `SELECT ol.id, ol.quantity - ${ORDER_LINE_DISPATCHED_SQL} AS pending
         FROM customer_order_lines ol JOIN customer_orders o ON o.id = ol.order_id
        WHERE o.party_id = ? AND o.status = 'OPEN' AND ol.status = 'ACTIVE' AND ol.product_variant_id = ?
        ORDER BY o.created_at ASC, o.order_number ASC, ol.line_no ASC`
    )
    .all(partyId, productVariantId) as Row[];
  return rows.map((row) => ({ orderLineId: String(row.id), pending: Number(row.pending ?? 0) }));
}

/** How every gatepass line is shared out among the party's orders, read under the caller's write lock. */
function planAllocation(db: Db, partyId: string, lines: GatepassOrderAllocationInput["lines"]): AllocationPlan {
  const planned = lines.map((line) => {
    const fifo = allocateFifo(line.quantity, candidatesFor(db, partyId, line.productVariantId));
    return { gatepassLineId: line.gatepassLineId, productVariantId: line.productVariantId, shares: fifo.shares, unallocated: fifo.unallocated };
  });
  const allocated = planned.reduce((sum, line) => sum + line.shares.reduce((inner, share) => inner + share.quantity, 0), 0);
  const unallocated = planned.reduce((sum, line) => sum + line.unallocated, 0);
  return { lines: planned, allocated, unallocated };
}

/** Writes the plan's shares as allocation lines numbered on from `afterLineNo`. */
function writeShares(db: Db, allocationId: string, afterLineNo: number, plan: AllocationPlan, nowIso: string): void {
  const insert = db.prepare(
    `INSERT INTO gatepass_order_allocation_lines (id, allocation_id, line_no, gatepass_line_id, order_line_id, quantity, allocated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  let lineNo = afterLineNo;
  for (const line of plan.lines) {
    for (const share of line.shares) {
      lineNo += 1;
      insert.run(crypto.randomUUID(), allocationId, lineNo, line.gatepassLineId, share.orderLineId, share.quantity, nowIso);
    }
  }
}

/** Marks every allocation line still counted as reversed, and returns how many cartons that gave back to pending. */
function reverseActiveShares(db: Db, allocationId: string, nowIso: string): number {
  const row = db.prepare("SELECT COALESCE(SUM(quantity), 0) AS n FROM gatepass_order_allocation_lines WHERE allocation_id = ? AND reversed_at IS NULL").get(allocationId) as Row;
  db.prepare("UPDATE gatepass_order_allocation_lines SET reversed_at = ? WHERE allocation_id = ? AND reversed_at IS NULL").run(nowIso, allocationId);
  return Number(row.n ?? 0);
}

/** The plan, as the audit row records it: which gatepass line went to which order line, and what was left over. */
const auditShares = (plan: AllocationPlan) =>
  plan.lines.map((line) => ({ gatepassLineId: line.gatepassLineId, productVariantId: line.productVariantId, shares: line.shares, unallocated: line.unallocated }));

interface AuditWho {
  readonly actorUserId?: string | null;
  readonly deviceId?: string | null;
}

function auditAllocation(db: Db, nowIso: string, eventType: string, allocationId: string, who: AuditWho, payload: Record<string, unknown>): void {
  insertAuditRow(
    db,
    {
      id: crypto.randomUUID(), eventType, entityType: "GATEPASS_ORDER_ALLOCATION", entityId: allocationId,
      actorUserId: who.actorUserId ?? null, actorDeviceId: who.deviceId ?? null, occurredAt: nowIso, payload,
    },
    nowIso
  );
}

const allocationOf = (db: Db, gatepassId: string): Row | undefined =>
  db.prepare("SELECT * FROM gatepass_order_allocations WHERE gatepass_id = ?").get(gatepassId) as Row | undefined;

export const orderAllocationMethods = {
  /**
   * Counts a new gatepass's lines against its party's open orders, oldest first, in the create transaction. Writes
   * nothing when no order is owed anything for these products. A gatepass already allocated is returned untouched.
   */
  async allocateGatepassToOrders(this: SqliteDatabase, payload: GatepassOrderAllocationInput, tx: TransactionContext): Promise<GatepassOrderAllocationSummary> {
    const { db, nowIso } = tx as MutableTransactionContext;
    const held = allocationOf(db, payload.gatepassId);
    if (held) return { allocatedQuantity: Number(held.allocated_quantity), unallocatedQuantity: Number(held.unallocated_quantity) };
    const plan = planAllocation(db, payload.partyId, payload.lines);
    if (plan.allocated === 0) return { allocatedQuantity: 0, unallocatedQuantity: plan.unallocated };
    const allocationId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO gatepass_order_allocations (id, gatepass_id, party_id, status, allocated_quantity, unallocated_quantity, revision, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
    ).run(allocationId, payload.gatepassId, payload.partyId, ORDER_ALLOCATION_STATUS.ACTIVE, plan.allocated, plan.unallocated, payload.actor, nowIso, nowIso);
    writeShares(db, allocationId, 0, plan, nowIso);
    auditAllocation(db, nowIso, "ORDER_ALLOCATED", allocationId, payload, {
      gatepassId: payload.gatepassId, partyId: payload.partyId, actor: payload.actor, allocated: plan.allocated, unallocated: plan.unallocated, lines: auditShares(plan),
    });
    return { allocatedQuantity: plan.allocated, unallocatedQuantity: plan.unallocated };
  },

  /** Gives back to pending exactly what a cancelled gatepass was counted against, in the cancel transaction. */
  async reverseGatepassOrderAllocation(
    this: SqliteDatabase,
    payload: { gatepassId: string; actor: string; reason: string; actorUserId?: string | null; deviceId?: string | null },
    tx: TransactionContext
  ): Promise<number> {
    const { db, nowIso } = tx as MutableTransactionContext;
    const held = allocationOf(db, payload.gatepassId);
    if (!held || String(held.status) === ORDER_ALLOCATION_STATUS.REVERSED) return 0;
    const allocationId = String(held.id);
    const reversed = reverseActiveShares(db, allocationId, nowIso);
    db.prepare(
      `UPDATE gatepass_order_allocations SET status = ?, revision = revision + 1, reversed_by = ?, reversed_at = ?, reverse_reason = ?, updated_at = ?
       WHERE id = ?`
    ).run(ORDER_ALLOCATION_STATUS.REVERSED, payload.actor, nowIso, payload.reason, nowIso, allocationId);
    auditAllocation(db, nowIso, "ORDER_ALLOCATION_REVERSED", allocationId, payload, { gatepassId: payload.gatepassId, actor: payload.actor, reason: payload.reason, reversed });
    return reversed;
  },

  /**
   * A gatepass whose lines changed: its allocation is reversed and made again from its lines as they now stand, in the
   * caller's transaction, so pending is never seen half-way. A cancelled gatepass is only reversed. There is no
   * Gatepass edit today (docs/52 section 4): this is the one call such an edit must make, in its own transaction.
   */
  async reallocateGatepassOrders(
    this: SqliteDatabase,
    payload: { gatepassId: string; actor: string; reason: string; actorUserId?: string | null; deviceId?: string | null },
    tx: TransactionContext
  ): Promise<GatepassOrderAllocationSummary> {
    const { db, nowIso } = tx as MutableTransactionContext;
    const gatepass = db.prepare("SELECT party_id, status FROM gatepasses WHERE id = ?").get(payload.gatepassId) as Row | undefined;
    if (!gatepass) throw new Error("This gatepass is not on this computer.");
    if (String(gatepass.status) === "CANCELLED") {
      await this.reverseGatepassOrderAllocation(payload, tx);
      return { allocatedQuantity: 0, unallocatedQuantity: 0 };
    }
    const partyId = String(gatepass.party_id);
    const held = allocationOf(db, payload.gatepassId);
    const reversed = held ? reverseActiveShares(db, String(held.id), nowIso) : 0;
    const lines = (db.prepare("SELECT id, product_variant_id, quantity FROM gatepass_lines WHERE gatepass_id = ? ORDER BY line_no").all(payload.gatepassId) as Row[])
      .map((row) => ({ gatepassLineId: String(row.id), productVariantId: String(row.product_variant_id), quantity: Number(row.quantity) }));
    const plan = planAllocation(db, partyId, lines);
    if (!held) {
      return plan.allocated === 0
        ? { allocatedQuantity: 0, unallocatedQuantity: plan.unallocated }
        : this.allocateGatepassToOrders({ ...payload, partyId, lines }, tx);
    }
    const allocationId = String(held.id);
    const lastLineNo = Number((db.prepare("SELECT COALESCE(MAX(line_no), 0) AS n FROM gatepass_order_allocation_lines WHERE allocation_id = ?").get(allocationId) as Row).n);
    writeShares(db, allocationId, lastLineNo, plan, nowIso);
    db.prepare(
      `UPDATE gatepass_order_allocations SET party_id = ?, status = ?, allocated_quantity = ?, unallocated_quantity = ?, revision = revision + 1,
              reversed_by = NULL, reversed_at = NULL, reverse_reason = NULL, updated_at = ? WHERE id = ?`
    ).run(partyId, ORDER_ALLOCATION_STATUS.ACTIVE, plan.allocated, plan.unallocated, nowIso, allocationId);
    auditAllocation(db, nowIso, "ORDER_REALLOCATED", allocationId, payload, {
      gatepassId: payload.gatepassId, actor: payload.actor, reason: payload.reason, reversed, allocated: plan.allocated, unallocated: plan.unallocated, lines: auditShares(plan),
    });
    return { allocatedQuantity: plan.allocated, unallocatedQuantity: plan.unallocated };
  },
};

export type OrderAllocationMethods = typeof orderAllocationMethods;
