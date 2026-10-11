// Store Out against a Machine Program: what the program's own screens never had to answer.
//
//   "is MP-000012 a program I may issue against?"          findMachineProgramForStoreOut
//   "does it ask for THIS upper, and how much is left?"    getMachineProgramItemAllocation
//   "which allocation does this packet keep?"              findOutstandingMachineProgramLineOfProgram
//   "has this Save Batch already been committed?"          findMachineProgramIssueBatchByKey
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").
// `this` is the database instance. Everything here is the SAME arithmetic the program screens
// use — LINE_CONSUMED_SQL from machineProgramSql.ts, recomputed from raw_material_qr_events every
// time — narrowed to one program. No quantity is cached and none is stored by a batch.

import type { SqliteDatabase } from "../sqliteDatabase.js";
import type {
  MachineProgramIssueBatchRecord,
  MachineProgramItemAllocation,
  MachineProgramLookup,
  MachineProgramStoreOutHead,
  TransactionContext,
} from "@erp/application";
import { QUANTITY_EPSILON, attributeKey, roundQuantity, type MachineProgramCartonTarget } from "@erp/domain";
import type { MutableTransactionContext } from "./shared.js";
import { COLOUR_SQL, LINE_CONSUMED_SQL } from "./machineProgramSql.js";
import { INJECTOR_LAYOUT } from "./machinePrograms.js";

const text = (value: unknown): string => (value == null ? "" : String(value));
const dbOf = (tx: TransactionContext) => (tx as MutableTransactionContext).db;

/** The program's own totals, in the one form both the screen and the write judge it by. */
const PROGRAM_TOTALS_SQL = `(SELECT COALESCE(SUM(mul.quantity), 0)
                             FROM machine_program_upper_lines mul
                             JOIN machine_program_runs mpr ON mpr.id = mul.run_id
                             WHERE mpr.program_id = mp.id) AS authorized,
                            (SELECT COALESCE(SUM(${LINE_CONSUMED_SQL}), 0)
                             FROM machine_program_upper_lines mul
                             JOIN machine_program_runs mpr ON mpr.id = mul.run_id
                             WHERE mpr.program_id = mp.id) AS issued,
                            (SELECT COALESCE(SUM(MAX(0, mul.quantity - ${LINE_CONSUMED_SQL})), 0)
                             FROM machine_program_upper_lines mul
                             JOIN machine_program_runs mpr ON mpr.id = mul.run_id
                             WHERE mpr.program_id = mp.id) AS outstanding`;

const mapHead = (row: Record<string, unknown>): MachineProgramStoreOutHead => ({
  id: text(row.id),
  programNumber: Number(row.program_number ?? 0),
  status: text(row.status),
  machineName: text(row.machine_name_snapshot),
  programDate: text(row.program_date),
  authorizedQuantity: roundQuantity(Number(row.authorized ?? 0)),
  issuedQuantity: roundQuantity(Math.max(0, Number(row.issued ?? 0))),
  outstandingQuantity: roundQuantity(Number(row.outstanding ?? 0)),
});

export const machineProgramStoreOutMethods = {
  /**
   * The program a Store Out lookup named, with its totals, or null.
   *
   * By id (what a notification carries) or by program number (what the printed sheet says and
   * what the lookup box takes). Only INJECTORS-layout programs are findable: the first shape of
   * this feature is history and nothing can be issued against it. A CANCELLED program IS returned
   * — the use case has to be able to say "that one was deleted" rather than "no such program".
   */
  async findMachineProgramForStoreOut(
    this: SqliteDatabase,
    lookup: MachineProgramLookup,
    tx: TransactionContext
  ): Promise<MachineProgramStoreOutHead | null> {
    const where = lookup.kind === "ID" ? "mp.id = ?" : "mp.program_number = ?";
    const key = lookup.kind === "ID" ? text(lookup.id).trim() : lookup.programNumber;
    const row = dbOf(tx)
      .prepare(`SELECT mp.*, ${PROGRAM_TOTALS_SQL} FROM machine_programs mp WHERE ${where} AND mp.layout = ? LIMIT 1`)
      .get(key, INJECTOR_LAYOUT) as Record<string, unknown> | undefined;
    return row ? mapHead(row) : null;
  },

  /**
   * What one program promises of one upper, across every run it appears on, or null when it does
   * not ask for that upper at all.
   *
   * Summed across runs on purpose: the same upper can be on two soles of the same machine, and to
   * the storekeeper fetching packets they are one quantity of one material. "Already fulfilled" is
   * therefore judged against the program's whole claim on the upper, never one line of it.
   */
  async getMachineProgramItemAllocation(
    this: SqliteDatabase,
    input: { programId: string; itemId: string },
    tx: TransactionContext
  ): Promise<MachineProgramItemAllocation | null> {
    const row = dbOf(tx)
      .prepare(
        `SELECT COUNT(mul.id) AS lines,
                COALESCE(SUM(mul.quantity), 0) AS authorized,
                COALESCE(SUM(${LINE_CONSUMED_SQL}), 0) AS issued,
                COALESCE(SUM(MAX(0, mul.quantity - ${LINE_CONSUMED_SQL})), 0) AS outstanding,
                MAX(u.code) AS unit_code
         FROM machine_program_upper_lines mul
         JOIN machine_program_runs mpr ON mpr.id = mul.run_id
         LEFT JOIN inventory_units u ON u.id = mul.unit_id
         WHERE mpr.program_id = ? AND mul.item_id = ?`
      )
      .get(text(input.programId).trim(), text(input.itemId).trim()) as Record<string, unknown> | undefined;
    if (!row || Number(row.lines ?? 0) === 0) return null;
    return {
      itemId: text(input.itemId).trim(),
      authorized: roundQuantity(Number(row.authorized ?? 0)),
      issued: roundQuantity(Math.max(0, Number(row.issued ?? 0))),
      outstanding: roundQuantity(Number(row.outstanding ?? 0)),
      unitCode: row.unit_code ? text(row.unit_code) : null,
    };
  },

  /**
   * The allocation ON THIS PROGRAM that a packet of `itemId` should be counted against, or null.
   *
   * The same read as findOutstandingMachineProgramLine, narrowed to one program and with the
   * FIFO across programs deliberately dropped: the storekeeper opened this program, and that is a
   * stronger instruction than which program's date came first. Inside the program the order is
   * still deterministic — injector, run, line — so two terminals issuing the same upper against
   * the same program fill its soles in the same order.
   *
   * Only a PROGRAMMED program is matched, so a deleted or finished one consumes nothing.
   */
  async findOutstandingMachineProgramLineOfProgram(
    this: SqliteDatabase,
    input: { programId: string; itemId: string },
    tx: TransactionContext
  ): Promise<{
    lineId: string; programId: string; programNumber: number; machineName: string; contractorName: string;
    itemDisplayName: string; quantity: number; consumedQuantity: number; unitCode: string | null;
    cartonTarget: MachineProgramCartonTarget | null;
  } | null> {
    const row = dbOf(tx)
      .prepare(
        `SELECT mul.id AS line_id, mp.id AS program_id, mp.program_number, mp.machine_name_snapshot, mp.contractor_name_snapshot,
                ii.display_name, mul.quantity, u.code AS unit_code, ${LINE_CONSUMED_SQL} AS consumed,
                mpr.sole_colour, ${COLOUR_SQL} AS upper_colour,
                asz.id AS article_size_id, asz.article, asz.size
         FROM machine_program_upper_lines mul
         JOIN machine_program_runs mpr ON mpr.id = mul.run_id
         JOIN machine_programs mp ON mp.id = mpr.program_id
         JOIN inventory_items ii ON ii.id = mul.item_id
         LEFT JOIN inventory_units u ON u.id = mul.unit_id
         LEFT JOIN article_sizes asz ON asz.id = mpr.article_size_id AND asz.deleted_at IS NULL
         WHERE mp.id = ? AND mp.status = 'PROGRAMMED' AND mul.item_id = ?
           AND mul.quantity - ${LINE_CONSUMED_SQL} > ${QUANTITY_EPSILON}
         ORDER BY mpr.injector_no ASC, mpr.run_no ASC, mul.line_no ASC
         LIMIT 1`
      )
      .get(text(input.programId).trim(), text(input.itemId).trim()) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      lineId: text(row.line_id),
      programId: text(row.program_id),
      programNumber: Number(row.program_number ?? 0),
      machineName: text(row.machine_name_snapshot),
      contractorName: text(row.contractor_name_snapshot),
      itemDisplayName: text(row.display_name),
      quantity: Number(row.quantity ?? 0),
      consumedQuantity: roundQuantity(Math.max(0, Number(row.consumed ?? 0))),
      unitCode: row.unit_code ? text(row.unit_code) : null,
      // Null when the run's product master row has been deleted: the store is then told the
      // cartons cannot be labelled, rather than being given an identity built on a guess.
      cartonTarget: row.article_size_id
        ? {
            articleSizeId: text(row.article_size_id),
            article: text(row.article),
            size: text(row.size),
            soleColour: attributeKey(text(row.sole_colour)),
            upperColour: attributeKey(text(row.upper_colour)),
          }
        : null,
    };
  },

  // ─── Saved batches ──────────────────────────────────────────────────────────

  /**
   * The batch already saved under this key, or null.
   *
   * This read inside the write lock, plus the UNIQUE constraint on batch_key, is the whole of the
   * retry safety: a Save Batch that reaches the database twice finds its own first attempt here.
   */
  async findMachineProgramIssueBatchByKey(
    this: SqliteDatabase,
    batchKey: string,
    tx: TransactionContext
  ): Promise<MachineProgramIssueBatchRecord | null> {
    const row = dbOf(tx)
      .prepare("SELECT * FROM machine_program_issue_batches WHERE batch_key = ? LIMIT 1")
      .get(text(batchKey).trim()) as Record<string, unknown> | undefined;
    return row ? mapBatch(row) : null;
  },

  async insertMachineProgramIssueBatch(
    this: SqliteDatabase,
    payload: {
      id: string; batchKey: string; programId: string; sessionId: string | null;
      deviceId: string; issuedBy: string | null; packetCount: number; createdAt: string;
    },
    tx: TransactionContext
  ): Promise<void> {
    dbOf(tx)
      .prepare(
        `INSERT INTO machine_program_issue_batches
           (id, batch_key, program_id, session_id, device_id, issued_by, packet_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        payload.id, text(payload.batchKey).trim(), payload.programId, payload.sessionId,
        payload.deviceId, payload.issuedBy, payload.packetCount, payload.createdAt
      );
  },

  /**
   * Every batch issued against a program, newest first, with the packets each one took.
   *
   * The audit trail the Store Out screen shows under the program: who fetched what, when, and in
   * which saved batch. Read from the events themselves, so a batch can never claim a packet that
   * did not leave.
   */
  listMachineProgramIssueBatches(
    this: SqliteDatabase,
    programId: string
  ): Array<{
    batch: MachineProgramIssueBatchRecord;
    packets: Array<{ qrId: string; itemDisplayName: string; quantity: number; unitCode: string | null; issuedAt: string }>;
  }> {
    const batches = this.db
      .prepare("SELECT * FROM machine_program_issue_batches WHERE program_id = ? ORDER BY created_at DESC, rowid DESC")
      .all(text(programId).trim()) as Array<Record<string, unknown>>;
    if (batches.length === 0) return [];

    const rows = this.db
      .prepare(
        `SELECT rme.machine_program_batch_id AS batch_id, rme.qr_id, rme.item_display_name, rme.quantity,
                u.code AS unit_code, rme.event_ts_local
         FROM raw_material_qr_events rme
         LEFT JOIN inventory_units u ON u.id = rme.unit_id
         WHERE rme.machine_program_batch_id IN (SELECT id FROM machine_program_issue_batches WHERE program_id = ?)
           AND rme.event_type = 'STORE_EXIT'
         ORDER BY rme.event_ts_local ASC, rme.rowid ASC`
      )
      .all(text(programId).trim()) as Array<Record<string, unknown>>;

    return batches.map((row) => {
      const batch = mapBatch(row);
      return {
        batch,
        packets: rows
          .filter((packet) => text(packet.batch_id) === batch.id)
          .map((packet) => ({
            qrId: text(packet.qr_id),
            itemDisplayName: text(packet.item_display_name),
            quantity: Number(packet.quantity ?? 0),
            unitCode: packet.unit_code ? text(packet.unit_code) : null,
            issuedAt: text(packet.event_ts_local),
          })),
      };
    });
  },
};

const mapBatch = (row: Record<string, unknown>): MachineProgramIssueBatchRecord => ({
  id: text(row.id),
  batchKey: text(row.batch_key),
  programId: text(row.program_id),
  sessionId: row.session_id ? text(row.session_id) : null,
  deviceId: text(row.device_id),
  issuedBy: row.issued_by ? text(row.issued_by) : null,
  packetCount: Number(row.packet_count ?? 0),
  createdAt: text(row.created_at),
});

export type MachineProgramStoreOutMethods = typeof machineProgramStoreOutMethods;
