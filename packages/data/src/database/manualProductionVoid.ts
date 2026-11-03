// Voiding a Manual Production entry (docs/42 section 5, owner decisions 2026-11-03).
//
// A delete cannot replicate: every other computer has already raised its figure for the entry. So the
// entry is KEPT and marked voided, and an opposite movement takes its cartons back out everywhere.
// The screen may call it Delete; underneath it is a void.
//
// One BEGIN IMMEDIATE transaction, three things together or not at all, mirroring recordManualProduction:
//   1. the entry is marked voided -- who, when, and why (the reason is required: it is what explains
//      an overpaid contractor to whoever reads the ledger later)
//   2. one MANUAL_PRODUCTION_VOID carton movement, -cartons, from the store row the entry stocked
//   3. the Contractor Ledger withdraws the entry: it reads only live entries (LIVE_MANUAL_ENTRY_SQL),
//      so the machine-day's owed figure falls by exactly the entry's share. Not refused when the day
//      is already paid -- the ledger then shows the overpayment, which is the true statement of fact.
//
// Two refusals, both changing nothing: the cartons must still be in the store (a gatepass that took
// them is named), and an entry is voided once.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import type { SqliteDatabase } from "../sqliteDatabase.js";
import type { ManualProductionEntry } from "./types.js";
import { IN_STORE_LOCATION_TYPE, formatGatepassCode } from "@erp/application";
import { CARTON_STOCK_EVENT_TYPE, formatManualProductionCode } from "@erp/domain";
import { recordCartonStockMovement } from "./cartonStock.js";

export interface VoidManualProductionInput {
  entryId: string;
  reason: string;
  voidedBy: string | null;
}

interface EntryToVoid {
  id: string;
  code: string;
  variantId: string;
  cartons: number;
  locationId: string;
  voidedAt: string | null;
}

const text = (value: unknown): string => (value == null ? "" : String(value));

export const manualProductionVoidMethods = {
  /** Voids one entry and takes its cartons back out of stock. Throws a readable reason when refused. */
  voidManualProduction(this: SqliteDatabase, input: VoidManualProductionInput): ManualProductionEntry {
    const entryId = text(input.entryId).trim();
    const reason = text(input.reason).trim();
    if (!entryId) throw new Error("This entry could not be found.");
    if (!reason) throw new Error("Give a reason for voiding this entry. The Contractor Ledger shows it to whoever reads it later.");

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const entry = this.manualEntryToVoid(entryId);
      if (entry.voidedAt !== null) throw new Error(`${entry.code} has already been voided.`);
      this.refuseVoidIfCartonsGone(entry);
      const nowIso = new Date().toISOString();
      this.db
        .prepare("UPDATE manual_production_entries SET voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ? AND voided_at IS NULL")
        .run(nowIso, input.voidedBy, reason, entry.id);
      recordCartonStockMovement(this.db, {
        variantId: entry.variantId,
        eventType: CARTON_STOCK_EVENT_TYPE.MANUAL_PRODUCTION_VOID,
        cartons: entry.cartons,
        locationId: entry.locationId,
        createdBy: input.voidedBy,
        createdAt: nowIso,
        manualProductionEntryId: entry.id,
      });
      this.db.exec("COMMIT");
      return this.getManualProductionEntry(entry.id);
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }
  },

  /** @internal The entry as a void needs it. Call ONLY inside BEGIN IMMEDIATE. */
  manualEntryToVoid(this: SqliteDatabase, entryId: string): EntryToVoid {
    const row = this.db
      .prepare("SELECT id, entry_number, product_variant_id, cartons, stock_location_id, voided_at FROM manual_production_entries WHERE id = ?")
      .get(entryId) as Record<string, unknown> | undefined;
    if (!row) throw new Error("This entry could not be found.");
    return {
      id: text(row.id),
      code: formatManualProductionCode(Number(row.entry_number)),
      variantId: text(row.product_variant_id),
      cartons: Number(row.cartons),
      locationId: text(row.stock_location_id),
      voidedAt: row.voided_at == null ? null : text(row.voided_at),
    };
  },

  /**
   * @internal The store must still hold the entry's cartons, on hand and in the row it stocked --
   * the current stock for the variant, never the entry's own quantity. Otherwise the void would take
   * the figure below zero, so it is refused with what to do about it.
   */
  refuseVoidIfCartonsGone(this: SqliteDatabase, entry: EntryToVoid): void {
    const onHand = this.db
      .prepare("SELECT COALESCE(SUM(quantity_on_hand), 0) AS n FROM stock_projection_by_variant WHERE product_variant_id = ?")
      .get(entry.variantId) as { n: number };
    const inStore = this.db
      .prepare(
        `SELECT COALESCE(SUM(quantity_on_hand), 0) AS n FROM stock_projection_by_location
          WHERE product_variant_id = ? AND location_type = ? AND location_id = ?`
      )
      .get(entry.variantId, IN_STORE_LOCATION_TYPE, entry.locationId) as { n: number };
    if (Number(onHand.n) >= entry.cartons && Number(inStore.n) >= entry.cartons) return;

    const gatepass = this.db
      .prepare(
        `SELECT g.gatepass_number FROM carton_stock_events e JOIN gatepasses g ON g.id = e.gatepass_id
          WHERE e.product_variant_id = ? AND e.event_type = ? AND g.status <> 'CANCELLED'
          ORDER BY e.created_at DESC LIMIT 1`
      )
      .get(entry.variantId, CARTON_STOCK_EVENT_TYPE.GATEPASS_ISSUE) as { gatepass_number: number } | undefined;
    if (gatepass) {
      throw new Error(`These cartons have already gone out on gatepass ${formatGatepassCode(Number(gatepass.gatepass_number))}. Cancel that gatepass first.`);
    }
    throw new Error(`${entry.code} cannot be voided: the store no longer holds its ${entry.cartons} carton(s).`);
  },
};

export type ManualProductionVoidMethods = typeof manualProductionVoidMethods;
