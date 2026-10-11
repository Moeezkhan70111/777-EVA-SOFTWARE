// Machine Program — everything read or written inside a transaction: the repository behind the
// program use cases, and the reads Raw Material Output and Input use to consume and give back a
// line.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules"). Every
// one takes the caller's transaction and uses its connection, so a check and the write it guards
// happen under the same lock.

import type { SqliteDatabase } from "../sqliteDatabase.js";
import type {
  MachineProgramLineForWrite,
  MachineProgramRunForWrite,
  TransactionContext,
} from "@erp/application";
import {
  MACHINE_PROGRAM_STATUS,
  NOTIFICATION_KIND,
  NOTIFICATION_SEVERITY,
  PERMISSION,
  QUANTITY_EPSILON,
  roundQuantity,
  type MachineContractorRole,
} from "@erp/domain";
import type { MutableTransactionContext } from "./shared.js";
import { LINE_CONSUMED_SQL } from "./machineProgramSql.js";
import { INJECTOR_LAYOUT } from "./machinePrograms.js";

const text = (value: unknown): string => (value == null ? "" : String(value));
const dbOf = (tx: TransactionContext) => (tx as MutableTransactionContext).db;

/** Whether any packet was ever scanned against the line aliased `mul`. */
const LINE_HAS_SCANS_SQL = "EXISTS (SELECT 1 FROM raw_material_qr_events rme WHERE rme.machine_program_upper_line_id = mul.id)";

export const machineProgramWritesMethods = {
  // ─── Machine and contractor ─────────────────────────────────────────────────

  async getMachineForProgram(
    this: SqliteDatabase,
    machineId: string,
    tx: TransactionContext
  ): Promise<{
    id: string; name: string; sectionId: string; status: string;
    contractorPartyId: string | null; packingContractorPartyId: string | null;
  } | null> {
    const row = dbOf(tx)
      .prepare("SELECT id, name, section_id, status, contractor_party_id, packing_contractor_party_id FROM machines WHERE id = ? LIMIT 1")
      .get(text(machineId).trim()) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: text(row.id),
      name: text(row.name),
      sectionId: text(row.section_id),
      status: text(row.status),
      contractorPartyId: row.contractor_party_id ? text(row.contractor_party_id) : null,
      packingContractorPartyId: row.packing_contractor_party_id ? text(row.packing_contractor_party_id) : null,
    };
  },

  async getContractorForProgram(
    this: SqliteDatabase,
    partyId: string,
    tx: TransactionContext
  ): Promise<{ id: string; partyName: string; partyType: string; status: string } | null> {
    const row = dbOf(tx)
      .prepare("SELECT id, party_name, party_type, status FROM parties WHERE id = ? AND deleted_at IS NULL LIMIT 1")
      .get(text(partyId).trim()) as Record<string, unknown> | undefined;
    return row
      ? { id: text(row.id), partyName: text(row.party_name), partyType: text(row.party_type), status: text(row.status) || "ACTIVE" }
      : null;
  },

  /**
   * Assigns one of the machine's two contractors. The role picks the pair of columns, so the
   * machine contractor and the packing contractor can never overwrite one another.
   */
  async setMachineContractor(
    this: SqliteDatabase,
    input: { machineId: string; role: MachineContractorRole; contractorPartyId: string; nowIso: string },
    tx: TransactionContext
  ): Promise<void> {
    const sql =
      input.role === "PACKING"
        ? "UPDATE machines SET packing_contractor_party_id = ?, packing_contractor_assigned_at = ?, updated_at = ? WHERE id = ?"
        : "UPDATE machines SET contractor_party_id = ?, contractor_assigned_at = ?, updated_at = ? WHERE id = ?";
    dbOf(tx).prepare(sql).run(input.contractorPartyId, input.nowIso, input.nowIso, input.machineId);
  },

  // ─── The program for a date ─────────────────────────────────────────────────

  async getMachineProgramByDateForWrite(
    this: SqliteDatabase,
    machineId: string,
    programDate: string,
    tx: TransactionContext
  ): Promise<{ id: string; status: string; shiftStartMinute: number; shiftEndMinute: number } | null> {
    const row = dbOf(tx)
      .prepare(
        `SELECT id, status, shift_start_minute, shift_end_minute FROM machine_programs
         WHERE machine_id = ? AND program_date = ? AND layout = ? AND status <> ? LIMIT 1`
      )
      .get(machineId, programDate, INJECTOR_LAYOUT, MACHINE_PROGRAM_STATUS.CANCELLED) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: text(row.id),
      status: text(row.status),
      shiftStartMinute: Number(row.shift_start_minute ?? 0),
      shiftEndMinute: Number(row.shift_end_minute ?? 0),
    };
  },

  async allocateMachineProgramNumber(this: SqliteDatabase, tx: TransactionContext): Promise<number> {
    const row = dbOf(tx).prepare("SELECT COALESCE(MAX(program_number), 0) + 1 AS n FROM machine_programs").get() as { n: number };
    return Number(row.n);
  },

  async insertMachineProgram(
    this: SqliteDatabase,
    payload: {
      id: string; programNumber: number; machineId: string; machineName: string; contractorPartyId: string;
      contractorName: string; packingContractorPartyId: string; packingContractorName: string;
      programDate: string; shiftStartMinute: number; shiftEndMinute: number;
      createdBy: string; createdAt: string;
    },
    tx: TransactionContext
  ): Promise<void> {
    // The partial unique index on (machine_id, program_date) is the last word on "one program
    // per machine per date" — two terminals racing to make the same date cannot both succeed.
    dbOf(tx)
      .prepare(
        `INSERT INTO machine_programs (
           id, program_number, machine_id, contractor_party_id, machine_name_snapshot, contractor_name_snapshot,
           packing_contractor_party_id, packing_contractor_name_snapshot,
           program_date, shift_start_minute, shift_end_minute, status, layout, created_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        payload.id, payload.programNumber, payload.machineId, payload.contractorPartyId, payload.machineName,
        payload.contractorName, payload.packingContractorPartyId, payload.packingContractorName,
        payload.programDate, payload.shiftStartMinute, payload.shiftEndMinute,
        MACHINE_PROGRAM_STATUS.PROGRAMMED, INJECTOR_LAYOUT, payload.createdBy, payload.createdAt, payload.createdAt
      );
  },

  /**
   * Changes which shift a saved program is for.
   *
   * The shift describes the program, never a line, so this moves no quantity and releases no
   * reservation. A deleted program is not written — the use case refuses it before here.
   */
  async setMachineProgramShift(
    this: SqliteDatabase,
    payload: { programId: string; shiftStartMinute: number; shiftEndMinute: number; nowIso: string },
    tx: TransactionContext
  ): Promise<void> {
    dbOf(tx)
      .prepare("UPDATE machine_programs SET shift_start_minute = ?, shift_end_minute = ?, updated_at = ? WHERE id = ?")
      .run(payload.shiftStartMinute, payload.shiftEndMinute, payload.nowIso, text(payload.programId).trim());
  },

  // ─── Masters a run names ────────────────────────────────────────────────────

  async getArticleSizeForProgram(
    this: SqliteDatabase,
    articleSizeId: string,
    tx: TransactionContext
  ): Promise<{ id: string; article: string; size: string; active: boolean } | null> {
    const row = dbOf(tx)
      .prepare("SELECT id, article, size, status, deleted_at FROM article_sizes WHERE id = ? LIMIT 1")
      .get(text(articleSizeId)) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { id: text(row.id), article: text(row.article), size: text(row.size), active: text(row.status) === "ACTIVE" && !row.deleted_at };
  },

  // ─── Runs ───────────────────────────────────────────────────────────────────

  async getMachineProgramRunForWrite(this: SqliteDatabase, runId: string, tx: TransactionContext): Promise<MachineProgramRunForWrite | null> {
    const row = dbOf(tx)
      .prepare(
        `SELECT mpr.id, mpr.program_id, mpr.injector_no, mpr.article_size_id, ass.article, ass.size,
                mp.status AS program_status, mp.machine_id, m.section_id,
                (SELECT COUNT(1) FROM machine_program_upper_lines mul WHERE mul.run_id = mpr.id) AS line_count,
                (SELECT COALESCE(SUM(${LINE_CONSUMED_SQL}), 0) FROM machine_program_upper_lines mul WHERE mul.run_id = mpr.id) AS consumed,
                (SELECT COUNT(1) FROM machine_program_upper_lines mul WHERE mul.run_id = mpr.id AND ${LINE_HAS_SCANS_SQL}) AS scanned_lines
         FROM machine_program_runs mpr
         JOIN machine_programs mp ON mp.id = mpr.program_id
         JOIN machines m ON m.id = mp.machine_id
         JOIN article_sizes ass ON ass.id = mpr.article_size_id
         WHERE mpr.id = ? LIMIT 1`
      )
      .get(text(runId)) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: text(row.id),
      programId: text(row.program_id),
      programStatus: text(row.program_status),
      machineId: text(row.machine_id),
      machineSectionId: text(row.section_id),
      injectorNo: Number(row.injector_no),
      articleSizeId: text(row.article_size_id),
      article: text(row.article),
      size: text(row.size),
      lineCount: Number(row.line_count ?? 0),
      consumedQuantity: roundQuantity(Math.max(0, Number(row.consumed ?? 0))),
      hasScans: Number(row.scanned_lines ?? 0) > 0,
    };
  },

  async nextMachineProgramRunNo(this: SqliteDatabase, programId: string, injectorNo: number, tx: TransactionContext): Promise<number> {
    const row = dbOf(tx)
      .prepare("SELECT COALESCE(MAX(run_no), 0) + 1 AS n FROM machine_program_runs WHERE program_id = ? AND injector_no = ?")
      .get(programId, injectorNo) as { n: number };
    return Number(row.n);
  },

  async insertMachineProgramRun(
    this: SqliteDatabase,
    payload: {
      id: string; programId: string; injectorNo: number; runNo: number; soleColour: string;
      articleSizeId: string; createdBy: string; createdAt: string;
    },
    tx: TransactionContext
  ): Promise<void> {
    // sole_type_id is left NULL. It was dropped from the program on 2026-10-07 (migration 057)
    // and is kept only so the runs saved before that still say which sole they were made for.
    dbOf(tx)
      .prepare(
        `INSERT INTO machine_program_runs (
           id, program_id, injector_no, run_no, sole_colour, article_size_id, created_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        payload.id, payload.programId, payload.injectorNo, payload.runNo, payload.soleColour,
        payload.articleSizeId, payload.createdBy, payload.createdAt, payload.createdAt
      );
  },

  async updateMachineProgramRun(
    this: SqliteDatabase,
    payload: { id: string; soleColour: string; articleSizeId: string; updatedAt: string },
    tx: TransactionContext
  ): Promise<void> {
    dbOf(tx)
      .prepare("UPDATE machine_program_runs SET sole_colour = ?, article_size_id = ?, updated_at = ? WHERE id = ?")
      .run(payload.soleColour, payload.articleSizeId, payload.updatedAt, payload.id);
  },

  async deleteMachineProgramRunLines(this: SqliteDatabase, runId: string, tx: TransactionContext): Promise<void> {
    dbOf(tx).prepare("DELETE FROM machine_program_upper_lines WHERE run_id = ?").run(runId);
  },

  async deleteMachineProgramRun(this: SqliteDatabase, runId: string, tx: TransactionContext): Promise<void> {
    await this.deleteMachineProgramRunLines(runId, tx);
    dbOf(tx).prepare("DELETE FROM machine_program_runs WHERE id = ?").run(runId);
  },

  async countMachineProgramRunLines(this: SqliteDatabase, runId: string, tx: TransactionContext): Promise<number> {
    const row = dbOf(tx).prepare("SELECT COUNT(1) AS n FROM machine_program_upper_lines WHERE run_id = ?").get(runId) as { n: number };
    return Number(row.n ?? 0);
  },

  // ─── Upper lines ────────────────────────────────────────────────────────────

  async getMachineProgramLineForWrite(this: SqliteDatabase, lineId: string, tx: TransactionContext): Promise<MachineProgramLineForWrite | null> {
    const row = dbOf(tx)
      .prepare(
        `SELECT mul.id, mul.run_id, mul.item_id, mul.quantity, mpr.program_id, mp.status AS program_status,
                ${LINE_CONSUMED_SQL} AS consumed, ${LINE_HAS_SCANS_SQL} AS has_scans
         FROM machine_program_upper_lines mul
         JOIN machine_program_runs mpr ON mpr.id = mul.run_id
         JOIN machine_programs mp ON mp.id = mpr.program_id
         WHERE mul.id = ? LIMIT 1`
      )
      .get(text(lineId)) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: text(row.id),
      runId: text(row.run_id),
      programId: text(row.program_id),
      programStatus: text(row.program_status),
      itemId: text(row.item_id),
      quantity: Number(row.quantity ?? 0),
      consumed: roundQuantity(Math.max(0, Number(row.consumed ?? 0))),
      hasScans: Number(row.has_scans ?? 0) === 1,
    };
  },

  /**
   * The line a run already has for one upper, or null.
   *
   * One upper is one line on a sole — a second ADD of it changes its quantity. A line saved before
   * 2026-10-07 also names the supplier it was taken from, and is still that run's one line for
   * that upper, so the supplier is deliberately not part of the match.
   */
  async findMachineProgramLineForItem(this: SqliteDatabase, runId: string, itemId: string, tx: TransactionContext): Promise<string | null> {
    const row = dbOf(tx)
      .prepare("SELECT id FROM machine_program_upper_lines WHERE run_id = ? AND item_id = ? LIMIT 1")
      .get(runId, itemId) as { id: string } | undefined;
    return row ? text(row.id) : null;
  },

  async nextMachineProgramLineNo(this: SqliteDatabase, runId: string, tx: TransactionContext): Promise<number> {
    const row = dbOf(tx).prepare("SELECT COALESCE(MAX(line_no), 0) + 1 AS n FROM machine_program_upper_lines WHERE run_id = ?").get(runId) as {
      n: number;
    };
    return Number(row.n);
  },

  async insertMachineProgramLine(
    this: SqliteDatabase,
    payload: {
      id: string; runId: string; lineNo: number; itemId: string; quantity: number;
      unitId: string; availableAtSave: number; createdBy: string; createdAt: string;
    },
    tx: TransactionContext
  ): Promise<void> {
    // supplier_party_id is left NULL: a program says how much of an upper a machine takes, not
    // whose packets it takes (changed 2026-10-07). The column keeps what older lines named.
    dbOf(tx)
      .prepare(
        `INSERT INTO machine_program_upper_lines (
           id, run_id, line_no, item_id, quantity, unit_id, available_at_save, created_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        payload.id, payload.runId, payload.lineNo, payload.itemId, payload.quantity, payload.unitId,
        payload.availableAtSave, payload.createdBy, payload.createdAt, payload.createdAt
      );
  },

  async updateMachineProgramLine(
    this: SqliteDatabase,
    payload: { id: string; quantity: number; availableAtSave: number; updatedAt: string },
    tx: TransactionContext
  ): Promise<void> {
    dbOf(tx)
      .prepare("UPDATE machine_program_upper_lines SET quantity = ?, available_at_save = ?, updated_at = ? WHERE id = ?")
      .run(payload.quantity, payload.availableAtSave, payload.updatedAt, payload.id);
  },

  async deleteMachineProgramLine(this: SqliteDatabase, lineId: string, tx: TransactionContext): Promise<void> {
    dbOf(tx).prepare("DELETE FROM machine_program_upper_lines WHERE id = ?").run(lineId);
  },

  // ─── Program status ─────────────────────────────────────────────────────────

  /** True when the program has uppers on it and every one of them has left the store. */
  async machineProgramIsFullyConsumed(this: SqliteDatabase, programId: string, tx: TransactionContext): Promise<boolean> {
    const row = dbOf(tx)
      .prepare(
        `SELECT COUNT(mul.id) AS lines, COALESCE(SUM(MAX(0, mul.quantity - ${LINE_CONSUMED_SQL})), 0) AS outstanding
         FROM machine_program_upper_lines mul
         JOIN machine_program_runs mpr ON mpr.id = mul.run_id
         WHERE mpr.program_id = ?`
      )
      .get(text(programId)) as { lines: number; outstanding: number };
    return Number(row.lines ?? 0) > 0 && Number(row.outstanding ?? 0) <= QUANTITY_EPSILON;
  },

  /**
   * Closes a program: CANCELLED when the operator deletes it, COMPLETED when everything on it has
   * been scanned out. The document and every line are kept. Its outstanding reservation is
   * released by the status change alone — Reserved only ever counts PROGRAMMED programs.
   */
  async closeMachineProgram(
    this: SqliteDatabase,
    input: { programId: string; status: "COMPLETED" | "CANCELLED"; actor: string | null; reason: string | null; nowIso: string },
    tx: TransactionContext
  ): Promise<boolean> {
    const db = dbOf(tx);
    const result =
      input.status === MACHINE_PROGRAM_STATUS.CANCELLED
        ? db
            .prepare(
              `UPDATE machine_programs SET status = ?, cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, updated_at = ?
               WHERE id = ? AND status <> ?`
            )
            .run(MACHINE_PROGRAM_STATUS.CANCELLED, input.nowIso, input.actor, input.reason, input.nowIso, input.programId, MACHINE_PROGRAM_STATUS.CANCELLED)
        : db
            .prepare("UPDATE machine_programs SET status = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status = ?")
            .run(MACHINE_PROGRAM_STATUS.COMPLETED, input.nowIso, input.nowIso, input.programId, MACHINE_PROGRAM_STATUS.PROGRAMMED);
    return Number(result.changes) > 0;
  },

  /** Puts a completed program back in service — something on it is owed again. */
  async reopenMachineProgram(this: SqliteDatabase, programId: string, nowIso: string, tx: TransactionContext): Promise<boolean> {
    const result = dbOf(tx)
      .prepare("UPDATE machine_programs SET status = ?, completed_at = NULL, updated_at = ? WHERE id = ? AND status = ?")
      .run(MACHINE_PROGRAM_STATUS.PROGRAMMED, nowIso, text(programId), MACHINE_PROGRAM_STATUS.COMPLETED);
    return Number(result.changes) > 0;
  },

  /** The program a delete is about to close, with what has been taken for it, read in the lock. */
  async getMachineProgramForClose(
    this: SqliteDatabase,
    programId: string,
    tx: TransactionContext
  ): Promise<{
    id: string; programNumber: number; machineName: string; contractorName: string; programDate: string; status: string;
    totalQuantity: number; consumedQuantity: number; outstandingQuantity: number;
  } | null> {
    const db = dbOf(tx);
    const row = db.prepare("SELECT * FROM machine_programs WHERE id = ? AND layout = ? LIMIT 1").get(text(programId), INJECTOR_LAYOUT) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    const lines = this.readMachineProgramRuns(text(row.id), db).flatMap((run) => run.lines);
    const total = (pick: (line: (typeof lines)[number]) => number) => roundQuantity(lines.reduce((sum, line) => sum + pick(line), 0));
    return {
      id: text(row.id),
      programNumber: Number(row.program_number ?? 0),
      machineName: text(row.machine_name_snapshot),
      contractorName: text(row.contractor_name_snapshot),
      programDate: text(row.program_date),
      status: text(row.status),
      totalQuantity: total((line) => line.quantity),
      consumedQuantity: total((line) => line.consumed),
      outstandingQuantity: total((line) => line.outstanding),
    };
  },

  // ─── Raw Material Output and Input: consuming and giving back a line ─────────

  /**
   * The upper line this packet should be counted against as it leaves the store, or null.
   *
   * Matched on the exact inventory identity — the material itself, never a colour string. A
   * program says how much of an upper a machine takes and no longer names a supplier
   * (2026-10-07), so any packet of that upper satisfies it, and a line saved before that date is
   * matched the same way rather than staying locked to the supplier it happened to name. A
   * section narrows it to the machines standing there; raw material stopped carrying a
   * destination when routes were removed, so none is passed.
   *
   * Oldest first — program date, then program number, injector, run and line — a deterministic
   * FIFO. Read inside the scan's write lock.
   */
  async findOutstandingMachineProgramLine(
    this: SqliteDatabase,
    input: { itemId: string; sectionId?: string | null },
    tx: TransactionContext
  ): Promise<{
    lineId: string; programId: string; programNumber: number; machineName: string; contractorName: string;
    itemDisplayName: string; quantity: number; consumedQuantity: number; unitCode: string | null;
  } | null> {
    const row = dbOf(tx)
      .prepare(
        `SELECT mul.id AS line_id, mp.id AS program_id, mp.program_number, mp.machine_name_snapshot, mp.contractor_name_snapshot,
                ii.display_name, mul.quantity, u.code AS unit_code, ${LINE_CONSUMED_SQL} AS consumed
         FROM machine_program_upper_lines mul
         JOIN machine_program_runs mpr ON mpr.id = mul.run_id
         JOIN machine_programs mp ON mp.id = mpr.program_id
         JOIN machines m ON m.id = mp.machine_id
         JOIN inventory_items ii ON ii.id = mul.item_id
         LEFT JOIN inventory_units u ON u.id = mul.unit_id
         WHERE mp.status = ? AND (? IS NULL OR m.section_id = ?) AND mul.item_id = ?
           AND mul.quantity - ${LINE_CONSUMED_SQL} > ${QUANTITY_EPSILON}
         ORDER BY mp.program_date ASC, mp.program_number ASC, mpr.injector_no ASC, mpr.run_no ASC, mul.line_no ASC
         LIMIT 1`
      )
      .get(
        MACHINE_PROGRAM_STATUS.PROGRAMMED,
        input.sectionId ? text(input.sectionId).trim() : null,
        input.sectionId ? text(input.sectionId).trim() : null,
        text(input.itemId).trim()
      ) as
      | Record<string, unknown>
      | undefined;
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
    };
  },

  /**
   * The line this exact packet's most recent Store exit was counted against, or null. Stamping
   * the same line on the compensating STORE_ENTRY puts the quantity back on the line.
   */
  async findMachineProgramLineOfLastStoreExit(this: SqliteDatabase, qrId: string, tx: TransactionContext): Promise<string | null> {
    const row = dbOf(tx)
      .prepare(
        `SELECT machine_program_upper_line_id FROM raw_material_qr_events
         WHERE qr_id = ? AND event_type = 'STORE_EXIT'
         ORDER BY event_ts_local DESC, created_at DESC LIMIT 1`
      )
      .get(text(qrId).trim()) as { machine_program_upper_line_id: string | null } | undefined;
    return row?.machine_program_upper_line_id ? text(row.machine_program_upper_line_id) : null;
  },

  /**
   * One notice per user who works Store Scanning (and every administrator), written through the
   * caller's transaction — so a program that rolls back leaves no notice behind.
   *
   * STORE_SCANNING is exactly who the Store Out page is open to (session.ts), which is where the
   * notice leads, so the notice reaches the people who can act on it and nobody else.
   */
  async notifyMachineProgramIssued(
    this: SqliteDatabase,
    notice: { entityId: string; title: string; message: string },
    tx: TransactionContext
  ): Promise<void> {
    this.notifyUsersWithPermission(
      PERMISSION.STORE_SCANNING,
      {
        kind: NOTIFICATION_KIND.MACHINE_PROGRAM_ISSUED,
        severity: NOTIFICATION_SEVERITY.INFO,
        entityId: notice.entityId,
        title: notice.title,
        message: notice.message,
      },
      tx
    );
  },

  async getMachineProgramOfLine(
    this: SqliteDatabase,
    lineId: string,
    tx: TransactionContext
  ): Promise<{ programId: string; status: string } | null> {
    const row = dbOf(tx)
      .prepare(
        `SELECT mp.id, mp.status FROM machine_program_upper_lines mul
         JOIN machine_program_runs mpr ON mpr.id = mul.run_id
         JOIN machine_programs mp ON mp.id = mpr.program_id WHERE mul.id = ? LIMIT 1`
      )
      .get(text(lineId).trim()) as { id: string; status: string } | undefined;
    return row ? { programId: text(row.id), status: text(row.status) } : null;
  },
};

export type MachineProgramWritesMethods = typeof machineProgramWritesMethods;
