// CUSTOMER ORDERS (docs/52, local migration 112): what a party ordered, by product, in cartons.
//
//   WRITE  saveCustomerOrder     ORD-000014 for BEHRAAM SHOES: every line, or none
//   WRITE  editCustomerOrder     the order said again: lines raised, lowered, added or taken off, or nothing
//   WRITE  cancelCustomerOrder   the order closed, with a reason: its lines stay, nothing is pending any more
//   READ   customerOrderView     one order by number (or the newest), with the numbers either side
//
// AN ORDER MOVES NOTHING: no stock, no money, no ledger. What it still owes is computed from the gatepasses allocated
// against it (orderAllocation.ts), never stored.
//
// EVERY LINE IS A LIVE PRODUCT. A line names a product_variants row (article + colour + size) that is active in Product
// Master, so an order can only ask for a combination that exists. Article, colour and size are copied onto the line,
// as a gatepass line copies them, so the order reads the same if Product Master is changed later.
//
// SAFE TO CHANGE. Every write carries the revision the screen was showing, so a change made since is never overwritten
// blind. An edit may not take a line below what gatepasses have already dispatched against it, nor take such a line off,
// nor move a dispatched order to another party. A line taken off is kept, marked REMOVED, so an allocation that names
// it still finds it. A save retried after a lost answer finds the order it already made (its id is the request id).
// Every write leaves an audit_log row saying what it changed.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import crypto from "node:crypto";
import {
  CUSTOMER_ORDER_LINE_STATUS,
  CUSTOMER_ORDER_MAX_LINES,
  CUSTOMER_ORDER_MAX_QUANTITY,
  CUSTOMER_ORDER_NOTE_MAX,
  CUSTOMER_ORDER_STATUS,
  businessDateOf,
  formatCustomerOrderCode,
} from "@erp/domain";
import type { SqliteDatabase } from "../sqliteDatabase.js";
import { allocateNumberInRange } from "./numberRange.js";
import { insertAuditRow } from "./gatepass.js";
import { ORDER_LINE_DISPATCHED_SQL } from "./orderAllocation.js";
import { readCustomerOrder, type CustomerOrder, type CustomerOrderLine } from "./customerOrderRead.js";

export type { CustomerOrder, CustomerOrderLine } from "./customerOrderRead.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = Record<string, unknown>;
const text = (value: unknown): string => (value == null ? "" : String(value));

export interface CustomerOrderLineInput {
  readonly productVariantId: string;
  readonly quantity: unknown;
}

/** Who is writing: from the session, never the screen. */
export interface CustomerOrderActor {
  readonly actor: string;
  readonly actorUserId?: string | null;
  readonly deviceId?: string | null;
}

/** The order's own words, the same for a new order and an edited one. */
export interface CustomerOrderBody extends CustomerOrderActor {
  readonly partyId: string;
  readonly note?: string | null;
  readonly lines: readonly CustomerOrderLineInput[];
}

export interface CustomerOrderSaveInput extends CustomerOrderBody {
  /** The screen's id for this order: a Save retried after a lost answer finds it. */
  readonly requestId: string;
}

export interface CustomerOrderEditInput extends CustomerOrderBody {
  readonly orderId: string;
  /** The revision the screen was showing. */
  readonly revision: number;
}

export interface CustomerOrderCancelInput extends CustomerOrderActor {
  readonly orderId: string;
  readonly revision: number;
  readonly reason: string;
}

/** One order and where it sits in the run of numbers, for Previous / Next. */
export interface CustomerOrderView {
  readonly order: CustomerOrder | null;
  readonly previousNumber: number | null;
  readonly nextNumber: number | null;
  readonly latestNumber: number | null;
}

/** A refusal the screen shows as it is: nothing was written. */
export class CustomerOrderRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomerOrderRefused";
  }
}

/** A line every rule accepted, ready to be written. */
interface CheckedLine {
  readonly productVariantId: string;
  readonly article: string;
  readonly color: string;
  readonly size: string;
  readonly quantity: number;
}

const describe = (line: { article: string; color: string; size: string }) => `${line.article} / ${line.color} / ${line.size}`;

function checkedNote(note: unknown): string | null {
  const value = text(note).trim();
  if (value.length > CUSTOMER_ORDER_NOTE_MAX) throw new CustomerOrderRefused(`Keep the note under ${CUSTOMER_ORDER_NOTE_MAX} characters.`);
  return value || null;
}

function checkedBody(body: CustomerOrderBody): void {
  if (!text(body.actor).trim()) throw new CustomerOrderRefused("This order must name who wrote it. Sign in again.");
  if (!text(body.partyId).trim()) throw new CustomerOrderRefused("Choose the party this order is for.");
  if (!Array.isArray(body.lines) || body.lines.length === 0) throw new CustomerOrderRefused("Enter a quantity for at least one colour and size.");
  if (body.lines.length > CUSTOMER_ORDER_MAX_LINES) throw new CustomerOrderRefused(`One order may hold at most ${CUSTOMER_ORDER_MAX_LINES} lines. Split it into two orders.`);
}

/** A whole number of cartons, 1 up to the limit, or null. */
function cartonsOf(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(text(value).trim() === "" ? Number.NaN : value);
  return Number.isInteger(number) && number > 0 && number <= CUSTOMER_ORDER_MAX_QUANTITY ? number : null;
}

/** The request says what the order already says: same party, note, and products with the same quantities. */
function sameBody(order: CustomerOrder, partyId: string, note: string | null, lines: readonly CheckedLine[]): boolean {
  if (order.partyId !== partyId || order.note !== note || order.lines.length !== lines.length) return false;
  const held = new Map(order.lines.map((line) => [line.productVariantId, line.quantity]));
  return lines.every((line) => held.get(line.productVariantId) === line.quantity);
}

const linesSummary = (lines: ReadonlyArray<{ productVariantId: string; article: string; color: string; size: string; quantity: number }>) =>
  lines.map(({ productVariantId, article, color, size, quantity }) => ({ productVariantId, article, color, size, quantity }));

export const customerOrderMethods = {
  /** Writes a new order with every line, in one transaction. */
  saveCustomerOrder(this: SqliteDatabase, input: CustomerOrderSaveInput): { order: CustomerOrder; duplicate: boolean } {
    if (!UUID.test(text(input.requestId))) throw new CustomerOrderRefused("This order could not be identified. Nothing was saved. Try again.");
    checkedBody(input);
    const note = checkedNote(input.note);
    const partyId = text(input.partyId).trim();
    return this.inOrderTransaction(() => {
      const lines = this.checkedOrderLines(input.lines);
      if (this.db.prepare("SELECT 1 AS here FROM customer_orders WHERE id = ?").get(input.requestId)) {
        const held = this.requireCustomerOrder(input.requestId);
        if (!sameBody(held, partyId, note, lines)) throw new CustomerOrderRefused(`This Save was already recorded as ${held.code}, with different details. Open ${held.code} to check it.`);
        return { order: held, duplicate: true };
      }
      this.requireActiveOrderParty(partyId);
      const orderNumber = allocateNumberInRange(this, "customerOrder");
      const nowIso = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO customer_orders (id, order_number, business_date, party_id, note, status, revision, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
        )
        .run(input.requestId, orderNumber, businessDateOf(nowIso), partyId, note, CUSTOMER_ORDER_STATUS.OPEN, input.actor, nowIso, nowIso);
      lines.forEach((line, index) => this.insertOrderLine(input.requestId, index + 1, line));
      this.auditOrder("ORDER_CREATED", input.requestId, input, nowIso, { code: formatCustomerOrderCode(orderNumber), partyId, note, lines: linesSummary(lines) });
      return { order: this.requireCustomerOrder(input.requestId), duplicate: false };
    });
  },

  /** The order said again: each product's quantity set, new products added, missing ones taken off, or nothing. */
  editCustomerOrder(this: SqliteDatabase, input: CustomerOrderEditInput): { order: CustomerOrder; changed: boolean } {
    checkedBody(input);
    const note = checkedNote(input.note);
    const partyId = text(input.partyId).trim();
    return this.inOrderTransaction(() => {
      const held = this.changeableCustomerOrder(input.orderId, input.revision);
      const lines = this.checkedOrderLines(input.lines);
      if (sameBody(held, partyId, note, lines)) return { order: held, changed: false };
      if (partyId !== held.partyId) {
        if (held.totals.dispatched > 0) throw new CustomerOrderRefused(`${held.code} has already been partly dispatched to ${held.partyName}, so its party cannot change. Cancel it and enter a new order.`);
        this.requireActiveOrderParty(partyId);
      }
      this.applyOrderLines(held, lines);
      const nowIso = new Date().toISOString();
      this.db
        .prepare("UPDATE customer_orders SET party_id = ?, note = ?, revision = revision + 1, updated_by = ?, updated_at = ? WHERE id = ?")
        .run(partyId, note, input.actor, nowIso, held.id);
      this.auditOrder("ORDER_EDITED", held.id, input, nowIso, {
        code: held.code, before: { partyId: held.partyId, note: held.note, lines: linesSummary(held.lines) }, after: { partyId, note, lines: linesSummary(lines) },
      });
      return { order: this.requireCustomerOrder(held.id), changed: true };
    });
  },

  /** Closes an open order, with a reason. Its lines and what was dispatched stay; nothing is pending any more. */
  cancelCustomerOrder(this: SqliteDatabase, input: CustomerOrderCancelInput): CustomerOrder {
    if (!text(input.actor).trim()) throw new CustomerOrderRefused("This order must name who cancelled it. Sign in again.");
    const reason = text(input.reason).trim();
    if (!reason) throw new CustomerOrderRefused("Give a reason for cancelling this order.");
    if (reason.length > CUSTOMER_ORDER_NOTE_MAX) throw new CustomerOrderRefused(`Keep the reason under ${CUSTOMER_ORDER_NOTE_MAX} characters.`);
    return this.inOrderTransaction(() => {
      const held = this.changeableCustomerOrder(input.orderId, input.revision);
      const nowIso = new Date().toISOString();
      this.db
        .prepare("UPDATE customer_orders SET status = ?, cancelled_by = ?, cancelled_at = ?, cancel_reason = ?, revision = revision + 1, updated_by = ?, updated_at = ? WHERE id = ?")
        .run(CUSTOMER_ORDER_STATUS.CANCELLED, input.actor, nowIso, reason, input.actor, nowIso, held.id);
      this.auditOrder("ORDER_CANCELLED", held.id, input, nowIso, { code: held.code, reason, ...held.totals });
      return this.requireCustomerOrder(held.id);
    });
  },

  /** One order by number, or the newest when `orderNumber` is null, with its neighbours. */
  customerOrderView(this: SqliteDatabase, orderNumber: number | null): CustomerOrderView {
    const scalar = (sql: string, ...args: number[]): number | null => {
      const value = (this.db.prepare(sql).get(...args) as Row).n;
      return value == null ? null : Number(value);
    };
    const latestNumber = scalar("SELECT MAX(order_number) AS n FROM customer_orders");
    const wanted = orderNumber ?? latestNumber;
    if (wanted === null) return { order: null, previousNumber: null, nextNumber: null, latestNumber: null };
    const row = this.db.prepare("SELECT id FROM customer_orders WHERE order_number = ?").get(wanted) as Row | undefined;
    return {
      order: row ? this.requireCustomerOrder(text(row.id)) : null,
      previousNumber: scalar("SELECT MAX(order_number) AS n FROM customer_orders WHERE order_number < ?", wanted),
      nextNumber: scalar("SELECT MIN(order_number) AS n FROM customer_orders WHERE order_number > ?", wanted),
      latestNumber,
    };
  },

  /** @internal The order and its active lines, each with what was dispatched against it. */
  requireCustomerOrder(this: SqliteDatabase, orderId: string): CustomerOrder {
    const order = readCustomerOrder(this.db, orderId);
    if (!order) throw new CustomerOrderRefused("This order is not on this computer.");
    return order;
  },

  /** @internal Runs `work` in one BEGIN IMMEDIATE transaction: all of it, or none. */
  inOrderTransaction<T>(this: SqliteDatabase, work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }
  },

  /** @internal An order that may still be changed: here, open, and at the revision the screen showed. */
  changeableCustomerOrder(this: SqliteDatabase, orderId: string, revision: number): CustomerOrder {
    const held = this.requireCustomerOrder(text(orderId));
    if (held.status === CUSTOMER_ORDER_STATUS.CANCELLED) throw new CustomerOrderRefused(`${held.code} has been cancelled. Nothing was changed.`);
    if (Number(revision) !== held.revision) {
      throw new CustomerOrderRefused(`${held.code} was changed by ${held.updatedBy ?? held.createdBy} since you opened it. Open it again, then make your change.`);
    }
    return held;
  },

  /** @internal The party must be in Party Master and active, as a gatepass's must. */
  requireActiveOrderParty(this: SqliteDatabase, partyId: string): void {
    const party = this.db.prepare("SELECT party_name, status FROM parties WHERE id = ? AND deleted_at IS NULL").get(partyId) as Row | undefined;
    if (!party) throw new CustomerOrderRefused("That party is not in the Party Master. Choose a party from the list.");
    if (text(party.status || "ACTIVE") !== "ACTIVE") throw new CustomerOrderRefused(`${text(party.party_name)} is inactive. Only active parties can be given an order.`);
  },

  /** @internal Every line a live product with a whole number of cartons. Duplicates are refused. */
  checkedOrderLines(this: SqliteDatabase, lines: readonly CustomerOrderLineInput[]): CheckedLine[] {
    const read = this.db.prepare(
      `SELECT pv.id, pv.article, pv.color, pv.size FROM product_variants pv JOIN article_sizes ass ON ass.id = pv.article_size_id
        WHERE pv.id = ? AND pv.status = 'ACTIVE' AND pv.deleted_at IS NULL AND ass.status = 'ACTIVE' AND ass.deleted_at IS NULL`
    );
    const seen = new Set<string>();
    return lines.map((line, index) => {
      const row = read.get(text(line.productVariantId).trim()) as Row | undefined;
      if (!row) throw new CustomerOrderRefused(`Line ${index + 1}: that colour and size is not an active product in Product Master. Refresh and try again.`);
      const checked = { productVariantId: text(row.id), article: text(row.article), color: text(row.color), size: text(row.size) };
      const quantity = cartonsOf(line.quantity);
      if (quantity === null) throw new CustomerOrderRefused(`${describe(checked)}: type a whole number of cartons, 1 to ${CUSTOMER_ORDER_MAX_QUANTITY}.`);
      if (seen.has(checked.productVariantId)) throw new CustomerOrderRefused(`${describe(checked)} is entered twice. Put it on one line.`);
      seen.add(checked.productVariantId);
      return { ...checked, quantity };
    });
  },

  /** @internal One new line. Call ONLY inside BEGIN IMMEDIATE. */
  insertOrderLine(this: SqliteDatabase, orderId: string, lineNo: number, line: CheckedLine): void {
    this.db
      .prepare(
        `INSERT INTO customer_order_lines (id, order_id, line_no, product_variant_id, article_snapshot, color_snapshot, size_snapshot, quantity, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(crypto.randomUUID(), orderId, lineNo, line.productVariantId, line.article, line.color, line.size, line.quantity, CUSTOMER_ORDER_LINE_STATUS.ACTIVE);
  },

  /**
   * @internal The order's lines become `lines`: each kept product set to its new quantity (never below what was
   * dispatched), a new product added, and a product no longer asked for taken off (only if nothing was dispatched).
   */
  applyOrderLines(this: SqliteDatabase, held: CustomerOrder, lines: readonly CheckedLine[]): void {
    const stored = this.db
      .prepare(`SELECT ol.id, ol.product_variant_id, ol.status, ${ORDER_LINE_DISPATCHED_SQL} AS dispatched FROM customer_order_lines ol WHERE ol.order_id = ?`)
      .all(held.id) as Row[];
    const byVariant = new Map(stored.map((row) => [text(row.product_variant_id), row]));
    let lastLineNo = Number((this.db.prepare("SELECT COALESCE(MAX(line_no), 0) AS n FROM customer_order_lines WHERE order_id = ?").get(held.id) as Row).n);
    const update = this.db.prepare("UPDATE customer_order_lines SET quantity = ?, status = ? WHERE id = ?");
    for (const line of lines) {
      const row = byVariant.get(line.productVariantId);
      if (!row) { lastLineNo += 1; this.insertOrderLine(held.id, lastLineNo, line); continue; }
      const dispatched = Number(row.dispatched ?? 0);
      if (line.quantity < dispatched) throw new CustomerOrderRefused(`${describe(line)}: ${dispatched} carton(s) have already been dispatched against ${held.code}. The order cannot be lowered below that.`);
      update.run(line.quantity, CUSTOMER_ORDER_LINE_STATUS.ACTIVE, text(row.id));
    }
    const asked = new Set(lines.map((line) => line.productVariantId));
    for (const kept of held.lines) {
      if (asked.has(kept.productVariantId)) continue;
      if (kept.dispatched > 0) throw new CustomerOrderRefused(`${describe(kept)}: ${kept.dispatched} carton(s) have already been dispatched against ${held.code}, so it cannot be taken off the order.`);
      this.db.prepare("UPDATE customer_order_lines SET status = ? WHERE id = ?").run(CUSTOMER_ORDER_LINE_STATUS.REMOVED, kept.id);
    }
  },

  /** @internal The audit row for one order write, in the caller's transaction. */
  auditOrder(this: SqliteDatabase, eventType: string, orderId: string, who: CustomerOrderActor, nowIso: string, payload: Record<string, unknown>): void {
    insertAuditRow(
      this.db,
      { id: crypto.randomUUID(), eventType, entityType: "CUSTOMER_ORDER", entityId: orderId, actorUserId: who.actorUserId ?? null, actorDeviceId: who.deviceId ?? null, occurredAt: nowIso, payload: { actor: who.actor, ...payload } },
      nowIso
    );
  },
};

export type CustomerOrderMethods = typeof customerOrderMethods;
