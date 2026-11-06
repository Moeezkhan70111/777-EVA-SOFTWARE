// READ-ONLY: DOES THIS COMPUTER'S CARTON FIGURE MATCH ITS MOVEMENTS? (docs/42 section 12)
//
// One row per product: the store figure against what the replicated movements add up to, with QR
// cartons counted apart. While carton QR is on hold every computer should read the same:
//
//   figure in store = net of the movements + QR cartons in store here
//
// A difference names a figure moved by something no movement records. QR cartons in store are local
// to this computer, so they are shown beside the shared stock and never mixed into it.
//
// The fingerprint is a hash of every movement's id and change. Two computers that have applied the
// same movements show the same fingerprint, whatever order they arrived in: that is how convergence
// is read across computers, without one being able to see the other.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import { createHash } from "node:crypto";
import type { SqliteDatabase } from "../sqliteDatabase.js";
import { IN_STORE_LOCATION_TYPE, IN_STORE_STATUS } from "@erp/application";
import { CARTON_STOCK_EVENT_TYPE as TYPE } from "@erp/domain";
import { SYNC_AGGREGATE } from "./syncEvents.js";

const MAX_PAGE_SIZE = 100;

export interface CartonReconciliationRow {
  readonly variantId: string;
  readonly article: string;
  readonly size: string;
  readonly color: string;
  /** Manual Production, less voids. */
  readonly produced: number;
  /** Adjustments, in less out. */
  readonly adjusted: number;
  /** Issued on gatepasses, less cancels. */
  readonly issued: number;
  /** What the movements add up to: the stock every computer should share. */
  readonly movementStock: number;
  /** QR cartons in store on this computer. Local, and on hold. */
  readonly qrInStore: number;
  /** The WAREHOUSE figure the screens read. */
  readonly storeFigure: number;
  /** storeFigure - movementStock - qrInStore. Zero when they agree. */
  readonly difference: number;
}

export interface CartonReconciliation {
  readonly rows: readonly CartonReconciliationRow[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly movements: number;
  readonly fingerprint: string;
  /** Products whose figure does not match, across every page. */
  readonly differences: number;
  /** Recorded here and not yet accepted by the cloud. */
  readonly unsent: number;
  /** Refused by the cloud: this computer's figure holds them and other computers' do not. */
  readonly refused: number;
  /** Received from another computer and waiting to apply. */
  readonly waiting: number;
  /** Live Manual Production entries from before the fresh start: no movement, kept for the ledger. */
  readonly entriesBeforeFreshStart: number;
}

const netOf = (...types: string[]) =>
  `COALESCE(SUM(CASE WHEN event_type IN (${types.map((type) => `'${type}'`).join(", ")}) THEN balance_delta ELSE 0 END), 0)`;

const ROWS_SQL = `
  WITH movement AS (
    SELECT product_variant_id AS variant_id, SUM(balance_delta) AS net,
           ${netOf(TYPE.MANUAL_PRODUCE, TYPE.MANUAL_PRODUCTION_VOID)} AS produced,
           ${netOf(TYPE.CARTON_ADJUST_IN, TYPE.CARTON_ADJUST_OUT)} AS adjusted,
           ${netOf(TYPE.GATEPASS_ISSUE, TYPE.GATEPASS_CANCEL)} AS issued
      FROM carton_stock_events GROUP BY product_variant_id
  ),
  figure AS (
    SELECT product_variant_id AS variant_id, SUM(quantity_on_hand) AS quantity
      FROM stock_projection_by_location WHERE location_type = '${IN_STORE_LOCATION_TYPE}' GROUP BY product_variant_id
  ),
  qr AS (
    SELECT product_variant_id AS variant_id, COUNT(1) AS quantity
      FROM qr_master WHERE current_status = '${IN_STORE_STATUS}' GROUP BY product_variant_id
  ),
  joined AS (
    SELECT pv.id AS variant_id, pv.article, pv.size, pv.color,
           COALESCE(m.produced, 0) AS produced, COALESCE(m.adjusted, 0) AS adjusted, -COALESCE(m.issued, 0) AS issued,
           COALESCE(m.net, 0) AS movement_stock, COALESCE(q.quantity, 0) AS qr_in_store, COALESCE(f.quantity, 0) AS store_figure
      FROM product_variants pv
      LEFT JOIN movement m ON m.variant_id = pv.id
      LEFT JOIN figure f ON f.variant_id = pv.id
      LEFT JOIN qr q ON q.variant_id = pv.id
     WHERE m.variant_id IS NOT NULL OR COALESCE(f.quantity, 0) <> 0 OR COALESCE(q.quantity, 0) <> 0
  )`;

type Row = Record<string, unknown>;

const toRow = (row: Row): CartonReconciliationRow => {
  const movementStock = Number(row.movement_stock);
  const qrInStore = Number(row.qr_in_store);
  const storeFigure = Number(row.store_figure);
  return {
    variantId: String(row.variant_id),
    article: String(row.article),
    size: String(row.size),
    color: String(row.color),
    produced: Number(row.produced),
    adjusted: Number(row.adjusted),
    issued: Number(row.issued),
    movementStock,
    qrInStore,
    storeFigure,
    difference: storeFigure - movementStock - qrInStore,
  };
};

export const cartonStockReconciliationMethods = {
  /** Reads only. One page of products, and the totals across all of them. */
  cartonStockReconciliation(this: SqliteDatabase, input: { page?: number; pageSize?: number } = {}): CartonReconciliation {
    const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(Number(input.pageSize) || 25)));
    const page = Math.max(1, Math.trunc(Number(input.page) || 1));
    const rows = this.db
      .prepare(`${ROWS_SQL} SELECT * FROM joined ORDER BY article, size, color LIMIT ? OFFSET ?`)
      .all(pageSize, (page - 1) * pageSize) as Row[];
    const totals = this.db
      .prepare(`${ROWS_SQL} SELECT COUNT(1) AS total, COALESCE(SUM(store_figure - movement_stock - qr_in_store <> 0), 0) AS differences FROM joined`)
      .get() as { total: number; differences: number };
    const count = (sql: string, ...params: string[]): number => Number((this.db.prepare(sql).get(...params) as { n: number }).n);
    const type = SYNC_AGGREGATE.CARTON_STOCK_EVENT;
    return {
      rows: rows.map(toRow),
      page,
      pageSize,
      total: Number(totals.total),
      differences: Number(totals.differences),
      movements: count("SELECT COUNT(1) AS n FROM carton_stock_events"),
      fingerprint: movementFingerprint(this),
      unsent: count("SELECT COUNT(1) AS n FROM sync_outbox WHERE aggregate_type = ? AND status IN ('PENDING', 'IN_FLIGHT', 'FAILED')", type)
        + count("SELECT COUNT(1) AS n FROM sync_dirty_records WHERE aggregate_type = ?", type),
      refused: count("SELECT COUNT(1) AS n FROM sync_outbox WHERE aggregate_type = ? AND status = 'DEAD_LETTER'", type),
      waiting: count("SELECT COUNT(1) AS n FROM sync_inbox_parked WHERE dedupe_key LIKE ?", `${type}:%`),
      entriesBeforeFreshStart: count(
        `SELECT COUNT(1) AS n FROM manual_production_entries e
          WHERE e.voided_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM carton_stock_events c WHERE c.manual_production_entry_id = e.id AND c.event_type = ?)`,
        TYPE.MANUAL_PRODUCE
      ),
    };
  },
};

function movementFingerprint(database: SqliteDatabase): string {
  const hash = createHash("sha256");
  const movements = database.db.prepare("SELECT id, balance_delta FROM carton_stock_events ORDER BY id").iterate() as Iterable<Row>;
  for (const movement of movements) hash.update(`${String(movement.id)}|${String(movement.balance_delta)}\n`);
  return hash.digest("hex").slice(0, 16);
}

export type CartonStockReconciliationMethods = typeof cartonStockReconciliationMethods;
