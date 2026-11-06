// A MANUAL CARTON ADJUSTMENT: an administrator corrects the figure, with a reason (docs/42 section 11).
//
// One movement on the same append-only table as every other, so it travels, applies once and
// reconciles like them. Administrator-only is enforced in the main process, from the session.
//
// The screen's request id is the movement's id. A Save retried after an answer that never arrived
// finds the movement it already made and adds nothing, and the same id applies once on every computer.
//
// Taking out more than the store holds is refused, never clamped.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import type { SqliteDatabase } from "../sqliteDatabase.js";
import { CARTON_STOCK_EVENT_TYPE, cartonStockDelta, type CartonStockEventType } from "@erp/domain";
import { CartonStockWouldGoNegative, recordCartonStockMovement } from "./cartonStock.js";

export const CARTON_ADJUST_DIRECTION = { IN: "IN", OUT: "OUT" } as const;
export type CartonAdjustDirection = (typeof CARTON_ADJUST_DIRECTION)[keyof typeof CARTON_ADJUST_DIRECTION];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CARTONS = 1_000_000;

export interface CartonAdjustInput {
  readonly requestId: string;
  readonly articleSizeId: string;
  readonly color: string;
  readonly direction: string;
  readonly cartons: number;
  readonly reason: string;
  readonly adjustedBy: string;
  readonly storeLocationId: string;
}

export interface CartonAdjustResult {
  readonly eventId: string;
  readonly eventType: CartonStockEventType;
  readonly cartons: number;
  readonly balanceDelta: number;
  readonly duplicate: boolean;
}

function typeFor(direction: string): CartonStockEventType {
  if (direction === CARTON_ADJUST_DIRECTION.IN) return CARTON_STOCK_EVENT_TYPE.CARTON_ADJUST_IN;
  if (direction === CARTON_ADJUST_DIRECTION.OUT) return CARTON_STOCK_EVENT_TYPE.CARTON_ADJUST_OUT;
  throw new Error("Choose whether the adjustment adds cartons or takes them out.");
}

function checkedInput(input: CartonAdjustInput): { eventType: CartonStockEventType; reason: string; storeLocationId: string } {
  if (!UUID.test(input.requestId)) throw new Error("This adjustment could not be identified. Nothing was changed. Try again.");
  const eventType = typeFor(input.direction);
  if (!Number.isInteger(input.cartons) || input.cartons <= 0 || input.cartons > MAX_CARTONS) {
    throw new Error("Enter the number of cartons as a whole number above zero.");
  }
  const reason = input.reason.trim();
  if (!reason) throw new Error("Give a reason for this adjustment. Every computer shows it with the movement.");
  if (!input.adjustedBy.trim()) throw new Error("This adjustment must name who made it.");
  const storeLocationId = input.storeLocationId.trim();
  if (!storeLocationId) throw new Error("This computer has no store set up, so it cannot hold carton stock.");
  return { eventType, reason, storeLocationId };
}

export const cartonStockAdjustMethods = {
  /** Records one adjustment and moves the figure by it, in one transaction. */
  adjustCartonStock(this: SqliteDatabase, input: CartonAdjustInput): CartonAdjustResult {
    const { eventType, reason, storeLocationId } = checkedInput(input);
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const already = this.db.prepare("SELECT event_type, quantity, balance_delta FROM carton_stock_events WHERE id = ?").get(input.requestId) as
        | { event_type: CartonStockEventType; quantity: number; balance_delta: number }
        | undefined;
      if (already) {
        this.db.exec("COMMIT");
        return { eventId: input.requestId, eventType: already.event_type, cartons: Number(already.quantity), balanceDelta: Number(already.balance_delta), duplicate: true };
      }
      const variant = this.stockableVariant(input.articleSizeId, input.color);
      const eventId = recordCartonStockMovement(this.db, {
        eventId: input.requestId,
        variantId: variant.id,
        eventType,
        cartons: input.cartons,
        locationId: storeLocationId,
        createdBy: input.adjustedBy.trim(),
        createdAt: new Date().toISOString(),
        reason,
      });
      this.db.exec("COMMIT");
      return { eventId, eventType, cartons: input.cartons, balanceDelta: cartonStockDelta(eventType, input.cartons), duplicate: false };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      if (error instanceof CartonStockWouldGoNegative) {
        throw new Error(`The store does not hold ${input.cartons} carton(s) of this product. Nothing was changed.`);
      }
      throw error;
    }
  },
};

export type CartonStockAdjustMethods = typeof cartonStockAdjustMethods;
