// EDITING TODAY'S MANUAL PRODUCTION (owner, 14 Nov 2026).
//
//   "Old stock 10, production 5, stock 15. Someone edits 5 to 3: stock 13, and the Contractor Ledger shows 3.
//    Like reversing the first production and adding the new one."
//
// That is exactly what this does, with the two operations that already exist, so nothing about stock, programs,
// contractors or rates is decided twice:
//
//   READ   manualProductionArticleToday   one machine and one article, today: the live cartons per size and colour
//   WRITE  editManualProduction           the article's new figures, per size and colour, in ONE transaction:
//            for each size and colour whose figure changes,
//              1. the new figure is recorded as a new entry (recordManualProductionInTransaction: its own MAN-
//                 number, the machine's program for today, the rates in force), unless it is 0;
//              2. every live entry that made the old figure is voided (voidManualEntryInTransaction), its reason
//                 saying what it became, so the Entries list and the Contractor Ledger explain the change.
//            Every changed figure, or none.
//
// RECORDED FIRST, VOIDED SECOND, so only the DIFFERENCE must still be in the store: 5 edited to 3 needs 2 cartons on
// hand, not 5. A figure that would take the store below what has already gone out is refused, naming the gatepass,
// by the void's own check.
//
// TODAY ONLY. An edit is recorded now, so it can only correct today's figures; an earlier day's entries stay
// void-only, for an administrator (manualProductionVoid.ts). A figure that already equals what is asked for is left
// alone, so a Save retried after a lost answer changes nothing.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import type { SqliteDatabase } from "../sqliteDatabase.js";
import { MANUAL_PRODUCTION_MOST_LINES, businessDateOf, businessDayStartIso, cartonsToDozens, formatManualProductionCode, manualProductionCartons } from "@erp/domain";
import { LIVE_MANUAL_ENTRY_SQL } from "./manualProduction.js";
import type { EntryToVoid } from "./manualProductionVoid.js";

type Row = Record<string, unknown>;
const text = (value: unknown): string => (value == null ? "" : String(value));

/** One size and colour of the article on that machine today. */
export interface ManualProductionArticleCell {
  articleSizeId: string;
  size: string;
  color: string;
  cartons: number;
}

export interface ManualProductionArticleToday {
  date: string;
  /** The machine the entries were saved on; null when it has nothing of this article today. */
  machineId: string | null;
  machineName: string;
  article: string;
  cells: ManualProductionArticleCell[];
}

/** One box of the edit grid: the figure it should be, in DOZEN. Blank or 0 means none. */
export interface ManualProductionEditCell {
  articleSizeId: string;
  color: string;
  dozens: unknown;
}

export interface ManualProductionEditInput {
  /** The screen's key for one press of Save. */
  requestId: string;
  machineId: string;
  article: string;
  cells: readonly ManualProductionEditCell[];
  storeLocationId: string;
  editedBy: string | null;
}

/** What one changed size and colour became. */
export interface ManualProductionEditChange {
  size: string;
  color: string;
  fromCartons: number;
  toCartons: number;
  /** The entries voided, by code. */
  voided: string[];
  /** The new entry's code; null when the figure became 0. */
  recorded: string | null;
}

export interface ManualProductionEditResult {
  date: string;
  changes: ManualProductionEditChange[];
}

const dozensWords = (cartons: number): string => `${cartonsToDozens(cartons).toLocaleString("en-US")} dozen`;

/** The figure a box asks for, in whole cartons. Throws the reason, naming the box. */
const targetCartons = (cell: ManualProductionEditCell, label: string): number => {
  const typed = text(cell.dozens).trim();
  if (typed === "" || Number(typed) === 0) return 0;
  const quantity = manualProductionCartons(typed);
  if (!quantity.ok) throw new Error(`${label}: ${quantity.reason}`);
  return quantity.cartons;
};

/** The reason each replaced entry carries: what its figure became, and the entry that holds it now. */
const editReason = (from: number, to: number, recorded: string | null): string =>
  recorded
    ? `Edited on the Manual Production page: ${dozensWords(from)} became ${dozensWords(to)} (now ${recorded}).`
    : `Edited on the Manual Production page: ${dozensWords(from)} removed.`;

const todayWindow = (nowIso: string): { date: string; fromIso: string; toIso: string } => {
  const date = businessDateOf(nowIso);
  const fromIso = businessDayStartIso(date);
  const toIso = businessDayStartIso(date, 1);
  if (!fromIso || !toIso) throw new Error("Today's date could not be worked out on this computer. Nothing was changed.");
  return { date, fromIso, toIso };
};

export const manualProductionEditMethods = {
  /** One machine and one article, today: what the edit grid starts from. Voided entries count nowhere. */
  manualProductionArticleToday(this: SqliteDatabase, input: { machineName: string; article: string }): ManualProductionArticleToday {
    const machineName = text(input.machineName).trim();
    const article = text(input.article).trim();
    const { date, fromIso, toIso } = todayWindow(new Date().toISOString());
    const rows = this.db
      .prepare(
        `SELECT e.machine_id, e.article_size_id, e.size, e.color, SUM(e.cartons) AS cartons
           FROM manual_production_entries e
          WHERE e.entry_ts >= ? AND e.entry_ts < ? AND e.${LIVE_MANUAL_ENTRY_SQL} AND e.machine_name = ? AND e.article = ?
          GROUP BY e.machine_id, e.article_size_id, e.size, e.color
          ORDER BY e.size, e.color`
      )
      .all(fromIso, toIso, machineName, article) as Row[];
    const machineIds = [...new Set(rows.map((row) => text(row.machine_id)))];
    if (machineIds.length > 1) {
      throw new Error(`Today's ${article} on ${machineName} was saved under more than one machine record. Correct it from the Entries list instead.`);
    }
    return {
      date,
      machineId: machineIds[0] ?? null,
      machineName,
      article,
      cells: rows.map((row) => ({ articleSizeId: text(row.article_size_id), size: text(row.size), color: text(row.color), cartons: Number(row.cartons ?? 0) })),
    };
  },

  /** Sets one article's figures for one machine today. Every changed figure, or none. Throws a readable reason. */
  editManualProduction(this: SqliteDatabase, input: ManualProductionEditInput): ManualProductionEditResult {
    const requestId = text(input.requestId).trim();
    const machineId = text(input.machineId).trim();
    const article = text(input.article).trim();
    const storeLocationId = text(input.storeLocationId).trim();
    if (!requestId) throw new Error("This edit could not be identified. Press Save again.");
    if (!machineId || !article) throw new Error("Choose the machine and article to edit.");
    if (!storeLocationId) throw new Error("This computer has no store set up to stock the cartons in.");
    if (input.cells.length === 0) throw new Error("There is nothing to change.");
    if (input.cells.length > MANUAL_PRODUCTION_MOST_LINES) throw new Error(`Edit at most ${String(MANUAL_PRODUCTION_MOST_LINES)} sizes and colours at a time.`);
    const keys = input.cells.map((cell) => `${text(cell.articleSizeId)}|${text(cell.color)}`);
    if (new Set(keys).size !== keys.length) throw new Error("The same size and colour was sent twice. Nothing was changed.");

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const nowIso = new Date().toISOString();
      const day = todayWindow(nowIso);
      const changes: ManualProductionEditChange[] = [];
      for (const cell of input.cells) {
        const change = this.editManualProductionCell({ requestId, machineId, article, storeLocationId, editedBy: input.editedBy, cell, nowIso, ...day });
        if (change) changes.push(change);
      }
      this.db.exec("COMMIT");
      return { date: day.date, changes };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }
  },

  /**
   * @internal One size and colour: record the new figure, then void what made the old one. Null when it already
   * equals the figure asked for. Call ONLY inside BEGIN IMMEDIATE.
   */
  editManualProductionCell(
    this: SqliteDatabase,
    input: { requestId: string; machineId: string; article: string; storeLocationId: string; editedBy: string | null; cell: ManualProductionEditCell; nowIso: string; fromIso: string; toIso: string }
  ): ManualProductionEditChange | null {
    const articleSizeId = text(input.cell.articleSizeId);
    const color = text(input.cell.color);
    const product = this.db.prepare("SELECT article, size FROM article_sizes WHERE id = ?").get(articleSizeId) as Row | undefined;
    if (!product || text(product.article) !== input.article) throw new Error(`A size that is not part of ${input.article} was sent. Nothing was changed.`);
    const label = `${input.article} ${text(product.size)} ${color}`;
    const target = targetCartons(input.cell, label);

    const live = this.db
      .prepare(
        `SELECT id, entry_number, product_variant_id, cartons, stock_location_id, entry_ts
           FROM manual_production_entries
          WHERE entry_ts >= ? AND entry_ts < ? AND ${LIVE_MANUAL_ENTRY_SQL} AND machine_id = ? AND article_size_id = ? AND color = ?
          ORDER BY entry_number`
      )
      .all(input.fromIso, input.toIso, input.machineId, articleSizeId, color) as Row[];
    const from = live.reduce((sum, row) => sum + Number(row.cartons ?? 0), 0);
    if (from === target) return null;

    try {
      const recorded =
        target > 0
          ? this.recordManualProductionInTransaction(
              { requestId: `${input.requestId}|${articleSizeId}|${color}`, machineId: input.machineId, articleSizeId, color, dozens: cartonsToDozens(target), storeLocationId: input.storeLocationId, createdBy: input.editedBy },
              target,
              input.nowIso
            ).entry.code
          : null;
      const reason = editReason(from, target, recorded);
      for (const row of live) this.voidManualEntryInTransaction(toEntryToVoid(row), { reason, voidedBy: input.editedBy, nowIso: input.nowIso });
      return { size: text(product.size), color, fromCartons: from, toCartons: target, voided: live.map((row) => formatManualProductionCode(Number(row.entry_number))), recorded };
    } catch (error) {
      throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

const toEntryToVoid = (row: Row): EntryToVoid => ({
  id: text(row.id),
  code: formatManualProductionCode(Number(row.entry_number)),
  variantId: text(row.product_variant_id),
  cartons: Number(row.cartons ?? 0),
  locationId: text(row.stock_location_id),
  enteredAt: text(row.entry_ts),
  voidedAt: null,
});

export type ManualProductionEditMethods = typeof manualProductionEditMethods;
