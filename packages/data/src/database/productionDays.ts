// A day of production, and the mark that says it is all entered (local migration 109, docs/48).
//
//   WRITE  completeProductionDay   "Complete today's production": one row for today, written once
//   READ   productionDayMark       is this day marked complete (Carton Stock's status box)
//   READ   productionDayView       the day's live Manual Production, per machine and together (Daily Production)
//
// THE MARK MOVES NO STOCK. Every carton is already in the figure through its own entry and movement. The mark only
// says the day's figures are in. It is written on the computer that records production (the carton lease; the IPC
// write path checks it), and reaches the others as the PRODUCTION_DAY leased record (masterCapture.ts).
//
// TODAY ONLY, decided here from the clock (businessToday), never from the screen. A day with no live entry cannot
// be marked: "Production added" must never be said of a day nothing was added to. Marking twice returns the first.
// Entries made or voided after the mark are not written back to it: the day is always read from the entries.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import {
  buildProductionDay,
  businessDayStartIso,
  businessToday,
  productionDayId,
  type ProductionDayLine,
  type ProductionDayMark,
  type ProductionDayView,
} from "@erp/domain";
import type { SqliteDatabase } from "../sqliteDatabase.js";
import { LIVE_MANUAL_ENTRY_SQL } from "./manualProduction.js";

type Row = Record<string, unknown>;

const text = (value: unknown): string => (value == null ? "" : String(value));

const toMark = (row: Row): ProductionDayMark => ({
  date: text(row.business_date),
  completedAt: text(row.completed_at),
  completedBy: text(row.completed_by),
  cartons: Number(row.cartons ?? 0),
  entries: Number(row.entries ?? 0),
});

/** The UTC window of a business day, or null when the date is not a `YYYY-MM-DD`. */
const dayWindow = (date: string): { fromIso: string; toIso: string } | null => {
  const fromIso = businessDayStartIso(date);
  const toIso = businessDayStartIso(date, 1);
  return fromIso && toIso ? { fromIso, toIso } : null;
};

export interface CompleteProductionDayResult {
  mark: ProductionDayMark;
  /** True when the day was already marked: nothing was written. */
  duplicate: boolean;
}

export const productionDayMethods = {
  /** Marks TODAY's production complete. Throws a readable reason when it is refused. */
  completeProductionDay(this: SqliteDatabase, input: { completedBy: string | null }): CompleteProductionDayResult {
    const completedBy = text(input.completedBy).trim();
    if (!completedBy) throw new Error("Sign in again before completing the day's production.");
    const date = businessToday();
    const window = dayWindow(date);
    if (!window) throw new Error("Today's date could not be read. Check this computer's clock.");

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const already = this.productionDayMark(date);
      if (already) {
        this.db.exec("COMMIT");
        return { mark: already, duplicate: true };
      }
      const totals = this.db
        .prepare(
          `SELECT COUNT(*) AS entries, COALESCE(SUM(cartons), 0) AS cartons
           FROM manual_production_entries WHERE entry_ts >= ? AND entry_ts < ? AND ${LIVE_MANUAL_ENTRY_SQL}`
        )
        .get(window.fromIso, window.toIso) as Row;
      const entries = Number(totals.entries ?? 0);
      if (entries === 0) throw new Error("No production has been saved today. Save the production first, then complete the day.");
      const nowIso = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO production_days (id, business_date, completed_at, completed_by, cartons, entries, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(productionDayId(date), date, nowIso, completedBy, Number(totals.cartons ?? 0), entries, nowIso, nowIso);
      this.db.exec("COMMIT");
      return { mark: { date, completedAt: nowIso, completedBy, cartons: Number(totals.cartons ?? 0), entries }, duplicate: false };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }
  },

  /** The day's mark, or null while the day is not marked complete (or the date is not one). */
  productionDayMark(this: SqliteDatabase, date: string): ProductionDayMark | null {
    const row = this.db
      .prepare("SELECT business_date, completed_at, completed_by, cartons, entries FROM production_days WHERE business_date = ? LIMIT 1")
      .get(text(date).trim()) as Row | undefined;
    return row ? toMark(row) : null;
  },

  /** One business day's live Manual Production, added up. Null when the date is not a `YYYY-MM-DD`. */
  productionDayView(this: SqliteDatabase, date: string): ProductionDayView | null {
    const day = text(date).trim();
    const window = dayWindow(day);
    if (!window) return null;
    const rows = this.db
      .prepare(
        `SELECT machine_name, article, size, color, SUM(cartons) AS cartons, COUNT(*) AS entries
         FROM manual_production_entries
         WHERE entry_ts >= ? AND entry_ts < ? AND ${LIVE_MANUAL_ENTRY_SQL}
         GROUP BY machine_name, article, size, color`
      )
      .all(window.fromIso, window.toIso) as Row[];
    const lines: ProductionDayLine[] = rows.map((row) => ({
      machineName: text(row.machine_name),
      article: text(row.article),
      size: text(row.size),
      color: text(row.color),
      cartons: Number(row.cartons ?? 0),
      entries: Number(row.entries ?? 0),
    }));
    return buildProductionDay(day, lines, this.productionDayMark(day));
  },
};

export type ProductionDayMethods = typeof productionDayMethods;
