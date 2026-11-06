// A gatepass line is split when it is made (docs/42 section 3.5, revised 2026-11-03):
//
//   QR cartons the store holds, not claimed by another live gatepass   -> RESERVED, for the QR
//                                                                         scanners, exactly as before
//   the shortfall (cartons with no QR: Manual Production)               -> ISSUED DIRECTLY now, one
//                                                                         GATEPASS_ISSUE movement
//
//   issueGatepassCartons    splits each line and issues the shortfall, in the create transaction
//   returnGatepassCartons   one GATEPASS_CANCEL movement for each issue not yet reversed, from the same
//                           store row, in the cancel transaction. Read from the movements, so a
//                           gatepass that issued nothing puts nothing back, and nothing is put back
//                           twice. The cancel's guarded status move already refuses a second cancel,
//                           and the database's unique index is under that.
//
// THE QR COUNT IS THE AUTHORITATIVE ONE: qr_master rows of the variant whose status is In Store --
// never estimated from the projections, which count QR and Manual Production cartons together.
// What other live gatepasses still owe the scanners for the variant comes off it, so two gatepasses
// can never both reserve the same QR cartons. With every carton a QR carton this reserves the whole
// line and issues nothing: today's behaviour, unchanged.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import type { SqliteDatabase } from "../sqliteDatabase.js";
import { IN_STORE_STATUS, type GatepassLineToIssue, type TransactionContext } from "@erp/application";
import { CARTON_STOCK_EVENT_TYPE, splitGatepassLine } from "@erp/domain";
import { CartonStockWouldGoNegative, recordCartonStockMovement, storeRowsToTakeFrom, type CartonSql } from "./cartonStock.js";
import { LINE_SETTLED_SQL } from "./gatepassLineSql.js";
import type { MutableTransactionContext } from "./shared.js";

/** QR cartons of the variant in the store that no other live gatepass still owes its scanners. */
function qrAvailableFor(sql: CartonSql, line: GatepassLineToIssue): number {
  const inStore = sql
    .prepare("SELECT COUNT(1) AS n FROM qr_master WHERE product_variant_id = ? AND current_status = ?")
    .get(line.productVariantId, IN_STORE_STATUS) as { n: number };
  const claimed = sql
    .prepare(
      `SELECT COALESCE(SUM(gl.quantity - ${LINE_SETTLED_SQL}), 0) AS n
         FROM gatepass_lines gl JOIN gatepasses g ON g.id = gl.gatepass_id
        WHERE g.status <> 'CANCELLED' AND gl.product_variant_id = ? AND gl.gatepass_id <> ?`
    )
    .get(line.productVariantId, line.gatepassId) as { n: number };
  return Number(inStore.n) - Number(claimed.n);
}

/** Takes `cartons` of the line out of the store now, row by row. Refuses rather than overdraw. */
function issueNow(sql: CartonSql, line: GatepassLineToIssue, cartons: number, issuedBy: string, nowIso: string): void {
  let rows: Array<{ locationId: string; cartons: number }>;
  try {
    rows = storeRowsToTakeFrom(sql, line.productVariantId, cartons);
  } catch (error) {
    if (!(error instanceof CartonStockWouldGoNegative)) throw error;
    throw new Error(`The store does not hold ${cartons} carton(s) of ${line.label}. Nothing was saved.`);
  }
  for (const row of rows) {
    recordCartonStockMovement(sql, {
      variantId: line.productVariantId,
      eventType: CARTON_STOCK_EVENT_TYPE.GATEPASS_ISSUE,
      cartons: row.cartons,
      locationId: row.locationId,
      createdBy: issuedBy,
      createdAt: nowIso,
      gatepassId: line.gatepassId,
      gatepassLineId: line.lineId,
    });
  }
}

export const gatepassCartonsMethods = {
  /**
   * Splits every line and takes its shortfall out of the store. Inside the create transaction only,
   * after the lines are written and the Reflected Stock check has passed, under the same write lock.
   */
  async issueGatepassCartons(this: SqliteDatabase, lines: GatepassLineToIssue[], issuedBy: string, tx: TransactionContext): Promise<void> {
    const context = tx as MutableTransactionContext;
    for (const line of lines) {
      // While carton QR is on hold nothing would ever scan a reservation out: the whole line leaves now.
      const qrAvailable = this.cartonQrOnHold ? 0 : qrAvailableFor(context.db, line);
      const split = splitGatepassLine(line.quantity, qrAvailable);
      if (split.issueNow > 0) issueNow(context.db, line, split.issueNow, issuedBy, context.nowIso);
    }
  },

  /** Puts back exactly what the gatepass issued directly, row by row. Returns the cartons put back. */
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
