// Reconciliation (Phase 4) — Upper Out against Production Received for one machine program.
// Read-only: nothing here writes, adjusts or corrects anything.
//
//   UPPER OUT            raw_material_qr_events, event_type STORE_EXIT, one row per packet issued:
//                          * issued to the program's machine on the program's business day
//                            (machine_id, migration 079 — Upper Move Out), or
//                          * issued against one of the program's own upper lines
//                            (machine_program_upper_line_id — the retired planning workflow)
//                        Each event is counted once, whichever of the two it matches. Quantities stay
//                        in each material's own unit, added up per unit.
//   PRODUCTION RECEIVED  production_events, event_type PRODUCED, for the program's carton QRs:
//                          * runs generated for the program (qr_batches.machine_program_id, migration 078)
//                          * labels the retired workflow printed for it (068 / 071 / 076 link tables)
//                        Counted as DISTINCT cartons — a carton is produced once (qr_master.qr_id is its
//                        PRIMARY KEY), and a repeated scan was refused, so it left no second event.
//
// A program is one machine on one business day (Phase 1.1), so the day is the program's own
// program_date, read through businessDayStartIso (Asia/Karachi). The comparison itself is the
// domain's (compareUpperOutToProduction).
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import type { SqliteDatabase } from "../sqliteDatabase.js";
import type { ProgramReconciliation, ReconcilableProgram, UpperIssueTotals } from "./types.js";
import { formatMachineProgramCodeNumber } from "@erp/application";
import { CARTON_GRADE, MACHINE_PROGRAM_STATUS, businessDayStartIso, compareUpperOutToProduction, roundQuantity } from "@erp/domain";

type Row = Record<string, unknown>;

const text = (value: unknown): string => (value == null ? "" : String(value));
const textOrNull = (value: unknown): string | null => (value == null || value === "" ? null : String(value));

const PROGRAM_SELECT = `SELECT id, program_number, program_date, machine_id, machine_name_snapshot,
  contractor_name_snapshot, packing_contractor_name_snapshot FROM machine_programs`;

const toProgram = (row: Row): ReconcilableProgram => ({
  programId: text(row.id),
  code: formatMachineProgramCodeNumber(Number(row.program_number)),
  programDate: text(row.program_date),
  machineId: text(row.machine_id),
  machineName: text(row.machine_name_snapshot),
});

/** The program's carton QR runs, however they were linked to it. Four `?` for the program id. */
const PROGRAM_BATCHES_SQL = `(
  b.machine_program_id = ?
  OR b.id IN (SELECT qr_batch_id FROM machine_program_carton_labels WHERE program_id = ?)
  OR b.id IN (SELECT qr_batch_id FROM machine_program_fix_carton_labels WHERE program_id = ?)
  OR b.id IN (SELECT qr_batch_id FROM machine_program_upper_b_labels WHERE program_id = ?)
)`;

export const productionReconciliationMethods = {
  /** Every machine program of one business date, in program-number order (not the deleted ones). */
  listReconcilablePrograms(this: SqliteDatabase, programDate: string): ReconcilableProgram[] {
    const rows = this.db
      .prepare(`${PROGRAM_SELECT} WHERE program_date = ? AND status <> ? ORDER BY program_number`)
      .all(text(programDate), MACHINE_PROGRAM_STATUS.CANCELLED) as Row[];
    return rows.map(toProgram);
  },

  /** Upper Out against Production Received for one program, or null when there is no such program. */
  getProgramReconciliation(this: SqliteDatabase, programId: string): ProgramReconciliation | null {
    const row = this.db.prepare(`${PROGRAM_SELECT} WHERE id = ? LIMIT 1`).get(text(programId).trim()) as Row | undefined;
    if (!row) return null;
    const program = toProgram(row);
    const upperOut = this.programUpperOut(program);
    const productionReceived = this.programProductionReceived(program.programId);
    return {
      program: { ...program, contractorName: textOrNull(row.contractor_name_snapshot), packingContractorName: textOrNull(row.packing_contractor_name_snapshot) },
      upperOut,
      productionReceived,
      comparison: compareUpperOutToProduction({ upperOut: upperOut.quantities, receivedCartons: productionReceived.cartons }),
    };
  },

  /** @internal The packets issued for a program, per unit — each STORE_EXIT once. */
  programUpperOut(this: SqliteDatabase, program: ReconcilableProgram): UpperIssueTotals {
    const fromIso = businessDayStartIso(program.programDate);
    const toIso = businessDayStartIso(program.programDate, 1);
    // A program with no readable date can still have issues against its own lines.
    const day = fromIso && toIso ? [fromIso.slice(0, 10), toIso.slice(0, 10), fromIso, toIso] : ["", "", "", ""];
    const rows = this.db
      .prepare(
        `SELECT u.code AS unit_code, COUNT(*) AS packets, SUM(e.quantity) AS quantity
         FROM raw_material_qr_events e
         LEFT JOIN inventory_units u ON u.id = e.unit_id
         WHERE e.event_type = 'STORE_EXIT' AND (
           (e.machine_id = ? AND e.event_date BETWEEN ? AND ? AND e.event_ts_local >= ? AND e.event_ts_local < ?)
           OR e.machine_program_upper_line_id IN (
             SELECT l.id FROM machine_program_upper_lines l JOIN machine_program_runs r ON r.id = l.run_id WHERE r.program_id = ?
           )
         )
         GROUP BY u.code ORDER BY u.code`
      )
      .all(program.machineId, ...day, program.programId) as Row[];
    return {
      packets: rows.reduce((total, unit) => total + Number(unit.packets ?? 0), 0),
      quantities: rows.map((unit) => ({ unitCode: text(unit.unit_code), quantity: roundQuantity(Number(unit.quantity ?? 0)) })),
    };
  },

  /** @internal The program's cartons recorded as produced — each carton once. */
  programProductionReceived(this: SqliteDatabase, programId: string): { cartons: number; bCartons: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT pe.qr_id) AS cartons,
                COUNT(DISTINCT CASE WHEN b.grade = ? THEN pe.qr_id END) AS b_cartons
         FROM production_events pe
         JOIN qr_codes c ON c.id = pe.qr_id
         JOIN qr_batches b ON b.id = c.batch_id
         WHERE pe.event_type = 'PRODUCED' AND ${PROGRAM_BATCHES_SQL}`
      )
      .get(CARTON_GRADE.B, programId, programId, programId, programId) as Row;
    return { cartons: Number(row.cartons ?? 0), bCartons: Number(row.b_cartons ?? 0) };
  },
};

export type ProductionReconciliationMethods = typeof productionReconciliationMethods;
