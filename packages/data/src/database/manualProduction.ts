// Manual Production — cartons recorded by typing them in, with no carton QR (owner, 2026-10-14).
//
//   WRITE  recordManualProduction    MACHINE 1 · SK6 7/10 RED · 10 DOZEN  ->  MAN-000001, 20 cartons
//   READ   listManualProduction      one business day: the entries, and the day per article/size/colour
//
// One entry, in ONE BEGIN IMMEDIATE transaction, does three things together or not at all:
//   1. joins the machine's program for today — openMachineDayProgramInTransaction, the very call the
//      QR Generator's runs make, so the program, its contractors and its rates are the same ones
//   2. writes the entry (manual_production_entries, migration 080), which is never changed afterwards
//   3. adds the cartons to store stock: stock_projection_by_variant and the WAREHOUSE row of
//      stock_projection_by_location, the figure Current Stock reads (IN_STORE_STOCK_SQL)
// The Contractor Ledger and Reconciliation read the entries beside the carton QRs.
//
// The quantity is checked by @erp/domain's manualProductionCartons, the same rule the screen shows.
// Only an existing, active colour of an active product can be stocked — no variant is created here.
// A Save retried with the same request id returns the entry it already made and adds nothing.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import type { SqliteDatabase } from "../sqliteDatabase.js";
import type { ManualProductionEntry, ManualProductionPage, ManualProductionResult, ProductionReceiptSummaryLine } from "./types.js";
import { IN_STORE_LOCATION_TYPE, formatMachineProgramCodeNumber } from "@erp/application";
import { businessDayStartIso, cartonsToDozens, formatManualProductionCode, manualProductionCartons } from "@erp/domain";

type Row = Record<string, unknown>;

const text = (value: unknown): string => (value == null ? "" : String(value));
const textOrNull = (value: unknown): string | null => (value == null || value === "" ? null : String(value));

const MAX_PAGE_SIZE = 100;

export interface ManualProductionInput {
  /** The screen's key for one press of Save. */
  requestId: string;
  machineId: string;
  /** The product (article + size) and one of its colours. */
  articleSizeId: string;
  color: string;
  /** As typed, in DOZEN. */
  dozens: unknown;
  /** The store the cartons are stocked in — the location Store In credits. */
  storeLocationId: string;
  createdBy: string | null;
}

const ENTRY_SELECT = `
  SELECT e.id, e.entry_number, e.article, e.size, e.color, e.cartons, e.entry_ts, e.created_by,
         mp.program_number, mp.machine_name_snapshot
  FROM manual_production_entries e
  JOIN machine_programs mp ON mp.id = e.machine_program_id`;

const toEntry = (row: Row): ManualProductionEntry => {
  const cartons = Number(row.cartons ?? 0);
  return {
    id: text(row.id),
    code: formatManualProductionCode(Number(row.entry_number)),
    article: text(row.article),
    size: text(row.size),
    color: text(row.color),
    cartons,
    equivalentDozens: cartonsToDozens(cartons),
    programCode: formatMachineProgramCodeNumber(Number(row.program_number)),
    machineName: text(row.machine_name_snapshot),
    enteredAt: text(row.entry_ts),
    enteredBy: textOrNull(row.created_by),
  };
};

interface StockableVariant {
  id: string;
  articleSizeId: string;
  article: string;
  size: string;
  color: string;
}

export const manualProductionMethods = {
  /** Records one entry and stocks its cartons. Throws a readable reason when it is refused. */
  recordManualProduction(this: SqliteDatabase, input: ManualProductionInput): ManualProductionResult {
    const requestId = text(input.requestId).trim();
    if (!requestId) throw new Error("This entry could not be identified. Press Save again.");
    const quantity = manualProductionCartons(input.dozens);
    if (!quantity.ok) throw new Error(quantity.reason);
    const storeLocationId = text(input.storeLocationId).trim();
    if (!storeLocationId) throw new Error("This computer has no store set up to stock the cartons in.");

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const already = this.findManualProductionByRequest(requestId);
      if (already) {
        this.db.exec("COMMIT");
        return { entry: already, duplicate: true };
      }
      const variant = this.stockableVariant(input.articleSizeId, input.color);
      const nowIso = new Date().toISOString();
      const program = this.openMachineDayProgramInTransaction({ machineId: input.machineId, createdBy: input.createdBy, nowIso });
      const id = this.insertManualProductionEntry({ requestId, variant, cartons: quantity.cartons, programId: program.id, machineId: input.machineId, storeLocationId, createdBy: input.createdBy, nowIso });
      this.addManualCartonsToStore({ variantId: variant.id, cartons: quantity.cartons, storeLocationId, nowIso });
      this.db.exec("COMMIT");
      return { entry: this.getManualProductionEntry(id), duplicate: false };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }
  },

  /**
   * @internal The colour of a product that may take stock: it exists already, and neither it nor the
   * product is disabled. Colours are stored upper-case (Product Master), so the match is exact.
   */
  stockableVariant(this: SqliteDatabase, articleSizeId: string, color: string): StockableVariant {
    const row = this.db
      .prepare(
        `SELECT pv.id, pv.article_size_id, a.article, a.size, pv.color, pv.status, pv.deleted_at,
                a.status AS product_status, a.deleted_at AS product_deleted_at
         FROM product_variants pv
         JOIN article_sizes a ON a.id = pv.article_size_id
         WHERE pv.article_size_id = ? AND pv.color = ?
         ORDER BY pv.deleted_at IS NOT NULL, pv.created_at LIMIT 1`
      )
      .get(text(articleSizeId).trim(), text(color).trim().toUpperCase()) as Row | undefined;
    if (!row) throw new Error("Choose the article, size and colour again — that colour of the product was not found.");
    const name = `${text(row.article)} ${text(row.size)} ${text(row.color)}`;
    if (row.deleted_at || text(row.status) === "DISABLED" || row.product_deleted_at || text(row.product_status) !== "ACTIVE") {
      throw new Error(`${name} is disabled in Product Master. Re-enable it before recording production.`);
    }
    return { id: text(row.id), articleSizeId: text(row.article_size_id), article: text(row.article), size: text(row.size), color: text(row.color) };
  },

  /** @internal Writes the entry under the next number. Call ONLY inside BEGIN IMMEDIATE. */
  insertManualProductionEntry(
    this: SqliteDatabase,
    input: { requestId: string; variant: StockableVariant; cartons: number; programId: string; machineId: string; storeLocationId: string; createdBy: string | null; nowIso: string }
  ): string {
    const next = this.db.prepare("SELECT COALESCE(MAX(entry_number), 0) + 1 AS n FROM manual_production_entries").get() as { n: number };
    const id = crypto.randomUUID();
    const { variant } = input;
    this.db
      .prepare(
        `INSERT INTO manual_production_entries (
           id, entry_number, request_id, machine_program_id, machine_id, article_size_id, product_variant_id,
           article, size, color, cartons, stock_location_id, entry_ts, created_by, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id, Number(next.n), input.requestId, input.programId, input.machineId, variant.articleSizeId, variant.id,
        variant.article, variant.size, variant.color, input.cartons, input.storeLocationId, input.nowIso, input.createdBy, input.nowIso
      );
    return id;
  },

  /** @internal The cartons go on hand and into the store — the two figures Store In moves for a scanned carton. */
  addManualCartonsToStore(this: SqliteDatabase, input: { variantId: string; cartons: number; storeLocationId: string; nowIso: string }): void {
    this.db
      .prepare(
        `INSERT INTO stock_projection_by_variant (product_variant_id, quantity_on_hand, last_event_ts, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(product_variant_id) DO UPDATE SET
           quantity_on_hand = quantity_on_hand + excluded.quantity_on_hand,
           last_event_ts = excluded.last_event_ts,
           updated_at = excluded.updated_at`
      )
      .run(input.variantId, input.cartons, input.nowIso, input.nowIso);
    this.db
      .prepare(
        `INSERT INTO stock_projection_by_location (product_variant_id, location_type, location_id, quantity_on_hand, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(product_variant_id, location_type, location_id) DO UPDATE SET
           quantity_on_hand = quantity_on_hand + excluded.quantity_on_hand,
           updated_at = excluded.updated_at`
      )
      .run(input.variantId, IN_STORE_LOCATION_TYPE, input.storeLocationId, input.cartons, input.nowIso);
  },

  /** @internal The entry a Save already made, if it was made. */
  findManualProductionByRequest(this: SqliteDatabase, requestId: string): ManualProductionEntry | null {
    const row = this.db.prepare(`${ENTRY_SELECT} WHERE e.request_id = ? LIMIT 1`).get(requestId) as Row | undefined;
    return row ? toEntry(row) : null;
  },

  /** @internal One entry, as just written. */
  getManualProductionEntry(this: SqliteDatabase, id: string): ManualProductionEntry {
    const row = this.db.prepare(`${ENTRY_SELECT} WHERE e.id = ? LIMIT 1`).get(id) as Row | undefined;
    if (!row) throw new Error("The entry was not saved. Check the list before saving again.");
    return toEntry(row);
  },

  /**
   * One business day's entries, newest first, a page at a time (R20), with the whole day added up.
   * Null when the date is not a `YYYY-MM-DD`.
   */
  listManualProduction(this: SqliteDatabase, input: { date: string; page?: number; pageSize?: number }): ManualProductionPage | null {
    const fromIso = businessDayStartIso(input.date);
    const toIso = businessDayStartIso(input.date, 1);
    if (!fromIso || !toIso) return null;
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(Number(input.pageSize) || 25)));
    const page = Math.max(1, Math.trunc(Number(input.page) || 1));
    const day = "e.entry_ts >= ? AND e.entry_ts < ?";

    const totals = this.db
      .prepare(`SELECT COUNT(*) AS entries, COALESCE(SUM(e.cartons), 0) AS cartons FROM manual_production_entries e WHERE ${day}`)
      .get(fromIso, toIso) as Row;
    const rows = this.db
      .prepare(`${ENTRY_SELECT} WHERE ${day} ORDER BY e.entry_ts DESC, e.entry_number DESC LIMIT ? OFFSET ?`)
      .all(fromIso, toIso, pageSize, (page - 1) * pageSize) as Row[];
    const totalCartons = Number(totals.cartons ?? 0);
    return {
      date: input.date,
      rows: rows.map(toEntry),
      page,
      pageSize,
      totalEntries: Number(totals.entries ?? 0),
      totalCartons,
      equivalentDozens: cartonsToDozens(totalCartons),
      summary: this.manualProductionSummary(fromIso, toIso),
    };
  },

  /** @internal The day's entries added up per article, size and colour — the whole day, not one page. */
  manualProductionSummary(this: SqliteDatabase, fromIso: string, toIso: string): ProductionReceiptSummaryLine[] {
    const rows = this.db
      .prepare(
        `SELECT e.article, e.size, e.color, SUM(e.cartons) AS cartons
         FROM manual_production_entries e
         WHERE e.entry_ts >= ? AND e.entry_ts < ?
         GROUP BY e.article, e.size, e.color
         ORDER BY e.article, e.size, e.color`
      )
      .all(fromIso, toIso) as Row[];
    return rows.map((row) => {
      const cartons = Number(row.cartons ?? 0);
      return { article: text(row.article), size: text(row.size), color: text(row.color), grade: null, cartons, equivalentDozens: cartonsToDozens(cartons) };
    });
  },

  /** @internal A program's Manual Production cartons, for Reconciliation. */
  programManualCartons(this: SqliteDatabase, programId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(cartons), 0) AS cartons FROM manual_production_entries WHERE machine_program_id = ?")
      .get(programId) as Row;
    return Number(row.cartons ?? 0);
  },
};

export type ManualProductionMethods = typeof manualProductionMethods;
