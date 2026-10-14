// Production receipts — the cartons recorded as produced, as Receive Production lists them.
//
// Read-only. A receipt is a PRODUCED event in production_events (one per carton: qr_master.qr_id is
// the PRIMARY KEY of the unit it creates), whichever station recorded it. The product, grade and
// machine program are read through the registry (qr_codes → qr_batches → machine_programs), and
// where the carton is now from qr_master, so the screen shows the database's answer, never its own.
//
// A day is the BUSINESS day (Asia/Karachi): the window is converted through businessDayStartIso, and
// event_date (the stored UTC date) narrows the scan to the two UTC dates a business day can span.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import type { SqliteDatabase } from "../sqliteDatabase.js";
import type { ProductionReceipt, ProductionReceiptPage, ProductionReceiptSummaryLine } from "./types.js";
import { formatMachineProgramCodeNumber } from "@erp/application";
import { CARTON_GRADE, businessDayStartIso, cartonsToDozens } from "@erp/domain";

type Row = Record<string, unknown>;

const text = (value: unknown): string => (value == null ? "" : String(value));
const textOrNull = (value: unknown): string | null => (value == null || value === "" ? null : String(value));

const MAX_PAGE_SIZE = 100;

const RECEIPT_SELECT = `
  SELECT pe.qr_id, pe.article_snapshot, pe.size_snapshot, pe.color_snapshot, pe.event_ts_local,
         json_extract(pe.metadata_json, '$.actor') AS actor,
         json_extract(pe.metadata_json, '$.station') AS station,
         qm.current_status, b.grade, mp.program_number, mp.machine_name_snapshot
  FROM production_events pe
  JOIN qr_master qm ON qm.qr_id = pe.qr_id
  LEFT JOIN qr_codes c ON c.id = pe.qr_id
  LEFT JOIN qr_batches b ON b.id = c.batch_id
  LEFT JOIN machine_programs mp ON mp.id = b.machine_program_id`;

const toReceipt = (row: Row): ProductionReceipt => ({
  qrId: text(row.qr_id),
  article: text(row.article_snapshot),
  size: text(row.size_snapshot),
  color: text(row.color_snapshot),
  grade: row.grade === CARTON_GRADE.B ? CARTON_GRADE.B : null,
  receivedAt: text(row.event_ts_local),
  receivedBy: textOrNull(row.actor),
  station: textOrNull(row.station),
  stage: text(row.current_status),
  programCode: row.program_number == null ? null : formatMachineProgramCodeNumber(Number(row.program_number)),
  machineName: textOrNull(row.machine_name_snapshot),
});

export const productionReceiptsMethods = {
  /** The receipt of one carton, or null when it has not been produced. */
  findProductionReceipt(this: SqliteDatabase, qrId: string): ProductionReceipt | null {
    const row = this.db
      .prepare(`${RECEIPT_SELECT} WHERE pe.qr_id = ? AND pe.event_type = 'PRODUCED' ORDER BY pe.event_ts_local LIMIT 1`)
      .get(text(qrId).trim().toUpperCase()) as Row | undefined;
    return row ? toReceipt(row) : null;
  },

  /**
   * One business day's receipts, newest first, a page at a time (R20), with the day's totals.
   * Null when the date is not a `YYYY-MM-DD`.
   */
  listProductionReceipts(
    this: SqliteDatabase,
    input: { date: string; page?: number; pageSize?: number }
  ): ProductionReceiptPage | null {
    const fromIso = businessDayStartIso(input.date);
    const toIso = businessDayStartIso(input.date, 1);
    if (!fromIso || !toIso) return null;
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(Number(input.pageSize) || 25)));
    const page = Math.max(1, Math.trunc(Number(input.page) || 1));
    const day = `pe.event_type = 'PRODUCED' AND pe.event_date BETWEEN ? AND ? AND pe.event_ts_local >= ? AND pe.event_ts_local < ?`;
    const window = [fromIso.slice(0, 10), toIso.slice(0, 10), fromIso, toIso];

    const counted = this.db.prepare(`SELECT COUNT(*) AS n FROM production_events pe WHERE ${day}`).get(...window) as { n: number };
    const rows = this.db
      .prepare(`${RECEIPT_SELECT} WHERE ${day} ORDER BY pe.event_ts_local DESC, pe.qr_id DESC LIMIT ? OFFSET ?`)
      .all(...window, pageSize, (page - 1) * pageSize) as Row[];

    const totalCartons = Number(counted.n ?? 0);
    return {
      date: input.date,
      rows: rows.map(toReceipt),
      page,
      pageSize,
      totalCartons,
      equivalentDozens: cartonsToDozens(totalCartons),
      summary: this.productionReceiptSummary(day, window),
    };
  },

  /**
   * @internal The day's receipts added up per article, size and colour (a B carton is its own
   * line) — the whole day, not one page. Counted by the database, never on the screen.
   */
  productionReceiptSummary(this: SqliteDatabase, day: string, window: string[]): ProductionReceiptSummaryLine[] {
    const rows = this.db
      .prepare(
        `SELECT pe.article_snapshot AS article, pe.size_snapshot AS size, pe.color_snapshot AS color, b.grade,
                COUNT(*) AS cartons
         FROM production_events pe
         LEFT JOIN qr_codes c ON c.id = pe.qr_id
         LEFT JOIN qr_batches b ON b.id = c.batch_id
         WHERE ${day}
         GROUP BY pe.article_snapshot, pe.size_snapshot, pe.color_snapshot, b.grade
         ORDER BY pe.article_snapshot, pe.size_snapshot, b.grade IS NOT NULL, pe.color_snapshot`
      )
      .all(...window) as Row[];
    return rows.map((row) => {
      const cartons = Number(row.cartons ?? 0);
      return {
        article: text(row.article),
        size: text(row.size),
        color: text(row.color),
        grade: row.grade === CARTON_GRADE.B ? CARTON_GRADE.B : null,
        cartons,
        equivalentDozens: cartonsToDozens(cartons),
      };
    });
  },
};

export type ProductionReceiptsMethods = typeof productionReceiptsMethods;
