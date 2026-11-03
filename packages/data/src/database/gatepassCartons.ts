// A gatepass takes its cartons out of stock the moment it is made, and its cancel puts them back
// (docs/42, owner decision 2026-11-03: dispatch cannot be tracked, so there is no later stage).
//
//   issueGatepassCartons    one GATEPASS_ISSUE movement per line (per store row it takes from --
//                           one row with one store), in the create transaction
//   returnGatepassCartons   one GATEPASS_CANCEL movement for each issue, from the same store row, in
//                           the cancel transaction. Read from the events, so a gatepass made before
//                           this existed (nothing issued) puts nothing back, and nothing is put back
//                           twice. The cancel use case's guarded status move already refuses a
//                           second cancel, and the database's unique index is under that.
//
// A LINE ISSUED AT CREATION IS SETTLED (ISSUED_AT_CREATION_SQL). It reserves nothing, because its
// cartons are already out of Current Stock: counting it in Reserved as well would take them out
// twice. And no Store Move Out scan can be attributed to it, so carton QR, when it returns, cannot
// take the same cartons out a second time. Gatepasses from before this keep reserving as they did.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import type { SqliteDatabase } from "../sqliteDatabase.js";
import type { GatepassLineToIssue, TransactionContext } from "@erp/application";
import { CARTON_STOCK_EVENT_TYPE } from "@erp/domain";
import { CartonStockWouldGoNegative, recordCartonStockMovement, storeRowsToTakeFrom } from "./cartonStock.js";
import type { MutableTransactionContext } from "./shared.js";

/** `gl` is the gatepass_lines alias. True when the line took its cartons out of stock when it was made. */
export const ISSUED_AT_CREATION_SQL = `EXISTS (SELECT 1 FROM carton_stock_events ce
                                         WHERE ce.gatepass_line_id = gl.id AND ce.event_type = '${CARTON_STOCK_EVENT_TYPE.GATEPASS_ISSUE}')`;

export const gatepassCartonsMethods = {
  /** Takes every line's cartons out of the store. Inside the create transaction only. */
  async issueGatepassCartons(this: SqliteDatabase, lines: GatepassLineToIssue[], issuedBy: string, tx: TransactionContext): Promise<void> {
    const context = tx as MutableTransactionContext;
    for (const line of lines) {
      let rows: Array<{ locationId: string; cartons: number }>;
      try {
        rows = storeRowsToTakeFrom(context.db, line.productVariantId, line.quantity);
      } catch (error) {
        if (!(error instanceof CartonStockWouldGoNegative)) throw error;
        throw new Error(`The store does not hold ${line.quantity} carton(s) of ${line.label}. Nothing was saved.`);
      }
      for (const row of rows) {
        recordCartonStockMovement(context.db, {
          variantId: line.productVariantId,
          eventType: CARTON_STOCK_EVENT_TYPE.GATEPASS_ISSUE,
          cartons: row.cartons,
          locationId: row.locationId,
          createdBy: issuedBy,
          createdAt: context.nowIso,
          gatepassId: line.gatepassId,
          gatepassLineId: line.lineId,
        });
      }
    }
  },

  /** Puts back exactly what the gatepass took, row by row. Returns the cartons put back. */
  async returnGatepassCartons(this: SqliteDatabase, gatepassId: string, returnedBy: string, tx: TransactionContext): Promise<number> {
    const context = tx as MutableTransactionContext;
    const issues = context.db
      .prepare(
        `SELECT i.product_variant_id, i.quantity, i.location_id, i.gatepass_line_id FROM carton_stock_events i
          WHERE i.gatepass_id = ? AND i.event_type = ?
            AND NOT EXISTS (SELECT 1 FROM carton_stock_events c
                             WHERE c.gatepass_line_id = i.gatepass_line_id AND c.location_id = i.location_id AND c.event_type = ?)
          ORDER BY i.created_at, i.id`
      )
      .all(gatepassId, CARTON_STOCK_EVENT_TYPE.GATEPASS_ISSUE, CARTON_STOCK_EVENT_TYPE.GATEPASS_CANCEL) as Array<Record<string, unknown>>;
    let returned = 0;
    for (const issue of issues) {
      recordCartonStockMovement(context.db, {
        variantId: String(issue.product_variant_id),
        eventType: CARTON_STOCK_EVENT_TYPE.GATEPASS_CANCEL,
        cartons: Number(issue.quantity),
        locationId: String(issue.location_id),
        createdBy: returnedBy,
        createdAt: context.nowIso,
        gatepassId,
        gatepassLineId: String(issue.gatepass_line_id),
      });
      returned += Number(issue.quantity);
    }
    return returned;
  },
};

export type GatepassCartonsMethods = typeof gatepassCartonsMethods;
