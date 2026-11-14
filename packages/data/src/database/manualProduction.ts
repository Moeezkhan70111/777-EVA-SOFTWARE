// Manual Production — cartons recorded by typing them in, with no carton QR (owner, 2026-10-14).
//
//   WRITE  recordManualProduction    MACHINE 1 · SK6 7/10 RED · 10 DOZEN  ->  MAN-000001, 20 cartons
//   WRITE  recordManualProductionBatch   the Manual Production page's Save: every line, or none (docs/48)
//   READ   listManualProduction      one business day: the entries, and the day per article/size/colour
//
// One entry, in ONE BEGIN IMMEDIATE transaction, does three things together or not at all:
//   1. joins the machine's program for today — openMachineDayProgramInTransaction, the very call the
//      QR Generator's runs make, so the program, its contractors and its rates are the same ones
//   2. writes the entry (manual_production_entries, migration 080), which is never changed afterwards
//      except to be voided (manualProductionVoid.ts)
//   3. adds the cartons to store stock as one MANUAL_PRODUCE carton movement (cartonStock.ts): the
//      event every other computer receives, and the figure Current Stock reads (IN_STORE_STOCK_SQL)
// The Contractor Ledger and Reconciliation read the entries beside the carton QRs, voided ones never.
//
// AN ENTRY STANDS ON ITS OWN (docs/43). It carries its program's number and reference, the machine's name, both
// contractors and the rates in force when it was saved. So a later price change does not rewrite what a
// contractor earned, and the entry reads the same on a computer that does not have the program.
//
// The quantity is checked by @erp/domain's manualProductionCartons, the same rule the screen shows.
// Only an existing, active colour of an active product can be stocked — no variant is created here.
// A Save retried with the same request id returns the entry it already made and adds nothing.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import type { SqliteDatabase } from "../sqliteDatabase.js";
import type { ManualProductionBatchResult, ManualProductionEntry, ManualProductionPage, ManualProductionResult, ProductionReceiptSummaryLine } from "./types.js";
import { formatMachineProgramCodeNumber } from "@erp/application";
import { CARTON_STOCK_EVENT_TYPE, MANUAL_PRODUCTION_MOST_LINES, RATE_SOURCE, businessDayStartIso, cartonsToDozens, formatManualProductionCode, manualProductionCartons } from "@erp/domain";
import { allocateNumberInRange } from "./numberRange.js";
import { recordCartonStockMovement } from "./cartonStock.js";

/** A voided entry counts nowhere: not in totals, not in Reconciliation, not in the Contractor Ledger. */
export const LIVE_MANUAL_ENTRY_SQL = "voided_at IS NULL";

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

/** One line of the Manual Production page's Save. */
export interface ManualProductionBatchLine {
  requestId: string;
  machineId: string;
  articleSizeId: string;
  color: string;
  /** As typed, in DOZEN. */
  dozens: unknown;
}

export interface ManualProductionBatchInput {
  lines: readonly ManualProductionBatchLine[];
  storeLocationId: string;
  createdBy: string | null;
}

/** A line as it will be written: identified, its quantity in whole cartons. Throws the reason, naming the line. */
const checkedBatchLine = (line: ManualProductionBatchLine, index: number) => {
  const lineNo = index + 1;
  const requestId = text(line.requestId).trim();
  if (!requestId) throw new Error(`Line ${String(lineNo)} could not be identified. Press Save again.`);
  const quantity = manualProductionCartons(line.dozens);
  if (!quantity.ok) throw new Error(`Line ${String(lineNo)}: ${quantity.reason}`);
  return { lineNo, requestId, machineId: text(line.machineId), articleSizeId: text(line.articleSizeId), color: text(line.color), dozens: line.dozens, cartons: quantity.cartons };
};

const ENTRY_SELECT = `
  SELECT e.id, e.entry_number, e.article, e.size, e.color, e.cartons, e.entry_ts, e.created_by,
         e.voided_at, e.voided_by, e.void_reason, e.program_number, e.machine_name
  FROM manual_production_entries e`;

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
    machineName: text(row.machine_name),
    enteredAt: text(row.entry_ts),
    enteredBy: textOrNull(row.created_by),
    voidedAt: textOrNull(row.voided_at),
    voidedBy: textOrNull(row.voided_by),
    voidReason: textOrNull(row.void_reason),
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
      const result = this.recordManualProductionInTransaction({ ...input, requestId, storeLocationId }, quantity.cartons, new Date().toISOString());
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }
  },

  /**
   * The Manual Production page's Save (docs/48): several lines, for one machine or several, in ONE transaction --
   * every line is recorded or none is. Each line is exactly one recordManualProduction: its own entry number, its
   * own movement, its machine's program for today. Each carries its own request id, so a Save retried after no
   * answer returns the entries already made and adds nothing. A line that is refused refuses the whole Save, and
   * its reason says which line.
   */
  recordManualProductionBatch(this: SqliteDatabase, input: ManualProductionBatchInput): ManualProductionBatchResult {
    const storeLocationId = text(input.storeLocationId).trim();
    if (!storeLocationId) throw new Error("This computer has no store set up to stock the cartons in.");
    const lines = input.lines.map((line, index) => checkedBatchLine(line, index));
    if (lines.length === 0) throw new Error("Add at least one quantity before saving.");
    if (lines.length > MANUAL_PRODUCTION_MOST_LINES) throw new Error(`Save at most ${String(MANUAL_PRODUCTION_MOST_LINES)} lines at a time.`);
    if (new Set(lines.map((line) => line.requestId)).size !== lines.length) throw new Error("This Save could not be identified. Press Save again.");

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const nowIso = new Date().toISOString();
      const results = lines.map((line) => {
        try {
          return this.recordManualProductionInTransaction({ ...line, storeLocationId, createdBy: input.createdBy }, line.cartons, nowIso);
        } catch (error) {
          throw new Error(`Line ${String(line.lineNo)}: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
      this.db.exec("COMMIT");
      return { entries: results.map((result) => result.entry), duplicates: results.filter((result) => result.duplicate).length };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }
  },

  /**
   * @internal One entry: the machine's program for today, the entry, its movement. A request id already used
   * returns the entry it made. Call ONLY inside BEGIN IMMEDIATE, with the quantity already checked.
   */
  recordManualProductionInTransaction(this: SqliteDatabase, input: ManualProductionInput, cartons: number, nowIso: string): ManualProductionResult {
    const already = this.findManualProductionByRequest(input.requestId);
    if (already) return { entry: already, duplicate: true };
    const variant = this.stockableVariant(input.articleSizeId, input.color);
    const program = this.openMachineDayProgramInTransaction({ machineId: input.machineId, createdBy: input.createdBy, nowIso });
    const id = this.insertManualProductionEntry({ requestId: input.requestId, variant, cartons, programId: program.id, storeLocationId: input.storeLocationId, createdBy: input.createdBy, nowIso });
    recordCartonStockMovement(this.db, {
      variantId: variant.id,
      eventType: CARTON_STOCK_EVENT_TYPE.MANUAL_PRODUCE,
      cartons,
      locationId: input.storeLocationId,
      createdBy: input.createdBy,
      createdAt: nowIso,
      manualProductionEntryId: id,
    });
    return { entry: this.getManualProductionEntry(id), duplicate: false };
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
    input: { requestId: string; variant: StockableVariant; cartons: number; programId: string; storeLocationId: string; createdBy: string | null; nowIso: string }
  ): string {
    const next = { n: allocateNumberInRange(this, "manualProduction") };
    const id = crypto.randomUUID();
    const { variant } = input;
    const program = this.db
      .prepare("SELECT program_number, machine_id, machine_name_snapshot, contractor_party_id, packing_contractor_party_id FROM machine_programs WHERE id = ?")
      .get(input.programId) as Row;
    const rates = this.manualProductionRates(input.programId, variant.articleSizeId);
    this.db
      .prepare(
        `INSERT INTO manual_production_entries (
           id, entry_number, request_id, machine_program_id, machine_id, article_size_id, product_variant_id,
           article, size, color, cartons, stock_location_id, entry_ts, created_by, created_at,
           program_ref, program_number, machine_name, contractor_party_id, packing_contractor_party_id,
           machine_rate_paisa, packing_rate_paisa, printing_rate_paisa, rate_source
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id, Number(next.n), input.requestId, input.programId, text(program.machine_id), variant.articleSizeId, variant.id,
        variant.article, variant.size, variant.color, input.cartons, input.storeLocationId, input.nowIso, input.createdBy, input.nowIso,
        input.programId, Number(program.program_number), text(program.machine_name_snapshot), textOrNull(program.contractor_party_id), textOrNull(program.packing_contractor_party_id),
        rates.machine, rates.packing, rates.printing, rates.source
      );
    return id;
  },

  /**
   * @internal The rates this work is paid at, as they stand now: what the program agreed for the product, or the
   * product's standard (Add Product). The same rule the Contractor Ledger reads (docs/28). Copied onto the entry.
   */
  manualProductionRates(this: SqliteDatabase, programId: string, articleSizeId: string): { machine: number | null; packing: number | null; printing: number | null; source: string | null } {
    const agreed = this.db
      .prepare("SELECT machine_rate_paisa, packing_rate_paisa, printing_rate_paisa FROM machine_program_article_rates WHERE program_id = ? AND article_size_id = ?")
      .get(programId, articleSizeId) as Row | undefined;
    const standard = this.db
      .prepare("SELECT machine_rate_paisa, packing_rate_paisa, printing_rate_paisa FROM article_sizes WHERE id = ?")
      .get(articleSizeId) as Row | undefined;
    const row = agreed ?? standard;
    const paisa = (value: unknown): number | null => (value == null ? null : Number(value));
    const machine = paisa(row?.machine_rate_paisa);
    const packing = paisa(row?.packing_rate_paisa);
    const printing = paisa(row?.printing_rate_paisa);
    if (machine === null && packing === null && printing === null) return { machine, packing, printing, source: null };
    return { machine, packing, printing, source: agreed ? RATE_SOURCE.PROGRAM : RATE_SOURCE.PRODUCT };
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

    // Every entry is listed, voided ones marked as such, so paging counts them all. Cartons do not.
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS entries, COALESCE(SUM(CASE WHEN e.${LIVE_MANUAL_ENTRY_SQL} THEN e.cartons ELSE 0 END), 0) AS cartons
         FROM manual_production_entries e WHERE ${day}`
      )
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
         WHERE e.entry_ts >= ? AND e.entry_ts < ? AND e.${LIVE_MANUAL_ENTRY_SQL}
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
      .prepare(`SELECT COALESCE(SUM(cartons), 0) AS cartons FROM manual_production_entries WHERE machine_program_id = ? AND ${LIVE_MANUAL_ENTRY_SQL}`)
      .get(programId) as Row;
    return Number(row.cartons ?? 0);
  },
};

export type ManualProductionMethods = typeof manualProductionMethods;
