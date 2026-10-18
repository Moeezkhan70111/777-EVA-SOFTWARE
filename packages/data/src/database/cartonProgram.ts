// The Machine Program: one program per machine per business day, made of the carton QRs generated
// for that machine that day.
//
//   QR Generator  MACHINE 1 . SK6 7/10 BLACKGREY x 10  ->  MP-000123  MACHINE 1  13 Oct   10 cartons  5 DZN
//   QR Generator  MACHINE 1 . SK6 7/10 RED x 4         ->  MP-000123  (same machine, same day)
//   B-Carton      MACHINE 2 . EVR9 7/10 MIX x 3        ->  MP-000124  MACHINE 2  13 Oct    3 B cartons
//
// WRITE: openMachineDayProgramInTransaction runs inside the QR run's own BEGIN IMMEDIATE
// (qrCodes.ts generateQrBatch). The machine's first run of the day opens its program in
// machine_programs, stamped with the machine and both contractors as they stand right then; every
// later run that day joins it (owner, 2026-10-13). The program and the run commit together or not
// at all, and the partial unique index on (machine_id, program_date) keeps two terminals from
// opening two programs for one machine and day.
//
// READ: the figures are counted from the registry itself (qr_batches + qr_codes, migrations 077
// and 078), so a re-read can never add a carton and a failed generation has nothing to count. A
// code voided in QR Management drops out of `cartons` and is shown as voided instead. Each run stays
// listed on its own under its line (listCartonProgramBatches). Dozens come from @erp/domain's
// cartonsToDozens, the one conversion rule in the system.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import type { SqliteDatabase } from "../sqliteDatabase.js";
import type { CartonProgramBatch, CartonProgramLine, MachineDayProgram, MachineDayProgramRef } from "./types.js";
import { INJECTOR_LAYOUT } from "./machinePrograms.js";
import { formatMachineProgramCodeNumber } from "@erp/application";
import {
  CARTON_GRADE,
  CONTRACTOR_PARTY_TYPE,
  DEFAULT_MACHINE_SHIFT,
  MACHINE_PROGRAM_STATUS,
  QR_BATCH_SOURCE,
  businessDateOf,
  cartonsToDozens,
} from "@erp/domain";
import { allocateNumberInRange } from "./numberRange.js";

type Row = Record<string, unknown>;

const text = (value: unknown): string => (value == null ? "" : String(value));
const textOrNull = (value: unknown): string | null => (value == null || value === "" ? null : String(value));

/** The runs a program is made of: what the QR Generator and the B-Carton Labels tab generated. */
const PROGRAM_SOURCES = [QR_BATCH_SOURCE.QR_GENERATOR, QR_BATCH_SOURCE.B_CARTON] as const;
const SOURCES_SQL = `b.source IN (${PROGRAM_SOURCES.map(() => "?").join(", ")})`;

/** Counts every registered code of the runs in scope, split into live and voided. */
const CARTON_COUNTS_SQL = `
  SUM(CASE WHEN c.status <> 'VOID' THEN 1 ELSE 0 END) AS cartons,
  SUM(CASE WHEN c.status = 'VOID' THEN 1 ELSE 0 END) AS voided`;

const toLine = (row: Row): CartonProgramLine => {
  const cartons = Number(row.cartons ?? 0);
  return {
    articleSizeId: text(row.article_size_id),
    productVariantId: textOrNull(row.product_variant_id),
    article: text(row.article),
    size: text(row.size),
    color: text(row.color),
    grade: row.grade === CARTON_GRADE.B ? CARTON_GRADE.B : null,
    cartons,
    voidedCartons: Number(row.voided ?? 0),
    equivalentDozens: cartonsToDozens(cartons),
    batchCount: Number(row.batch_count ?? 0),
    lastGeneratedAt: text(row.last_generated_at),
  };
};

/** The machine as a program needs it: active, with both contractors set, active and contractors. */
interface MachineForProgram {
  id: string;
  name: string;
  contractorPartyId: string;
  contractorName: string;
  packingContractorPartyId: string;
  packingContractorName: string;
}

export const cartonProgramMethods = {
  /**
   * The machine's program for today's business date, opened if this is its first run of the day.
   * Call ONLY inside BEGIN IMMEDIATE — the look-up and the number allocation rely on the lock.
   */
  openMachineDayProgramInTransaction(
    this: SqliteDatabase,
    input: { machineId: string; createdBy: string | null; nowIso: string }
  ): MachineDayProgramRef {
    const machine = this.machineForProgram(input.machineId);
    const programDate = businessDateOf(input.nowIso);
    const existing = this.db
      .prepare(
        `SELECT id, program_number, machine_name_snapshot FROM machine_programs
         WHERE machine_id = ? AND program_date = ? AND layout = ? AND status <> ? LIMIT 1`
      )
      .get(machine.id, programDate, INJECTOR_LAYOUT, MACHINE_PROGRAM_STATUS.CANCELLED) as Row | undefined;
    if (existing) {
      const number = Number(existing.program_number);
      return { id: text(existing.id), code: formatMachineProgramCodeNumber(number), machineName: text(existing.machine_name_snapshot), programDate };
    }

    const next = { n: allocateNumberInRange(this, "machineProgram") };
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO machine_programs (
           id, program_number, machine_id, contractor_party_id, machine_name_snapshot, contractor_name_snapshot,
           packing_contractor_party_id, packing_contractor_name_snapshot,
           program_date, shift_start_minute, shift_end_minute, status, layout, created_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id, Number(next.n), machine.id, machine.contractorPartyId, machine.name, machine.contractorName,
        machine.packingContractorPartyId, machine.packingContractorName,
        programDate, DEFAULT_MACHINE_SHIFT.startMinute, DEFAULT_MACHINE_SHIFT.endMinute,
        MACHINE_PROGRAM_STATUS.PROGRAMMED, INJECTOR_LAYOUT, input.createdBy, input.nowIso, input.nowIso
      );
    return { id, code: formatMachineProgramCodeNumber(Number(next.n)), machineName: machine.name, programDate };
  },

  /** @internal The machine a run is generated for, refused unless it can carry a program. */
  machineForProgram(this: SqliteDatabase, machineId: string): MachineForProgram {
    const row = this.db
      .prepare(
        `SELECT m.id, m.name, m.status,
                m.contractor_party_id, cp.party_name AS contractor_name, cp.party_type AS contractor_type, cp.status AS contractor_status,
                m.packing_contractor_party_id, pp.party_name AS packing_name, pp.party_type AS packing_type, pp.status AS packing_status
         FROM machines m
         LEFT JOIN parties cp ON cp.id = m.contractor_party_id AND cp.deleted_at IS NULL
         LEFT JOIN parties pp ON pp.id = m.packing_contractor_party_id AND pp.deleted_at IS NULL
         WHERE m.id = ? LIMIT 1`
      )
      .get(text(machineId).trim()) as Row | undefined;
    if (!row) throw new Error("Choose a machine first — that machine is no longer set up.");
    const name = text(row.name);
    if (text(row.status) !== "ACTIVE") throw new Error(`${name} is retired. Choose another machine.`);
    const usable = (type: unknown, status: unknown) => type === CONTRACTOR_PARTY_TYPE && status === "ACTIVE";
    if (!row.contractor_name || !usable(row.contractor_type, row.contractor_status)) {
      throw new Error(`${name} has no active machine contractor. Set it in Machine Program, then generate again.`);
    }
    if (!row.packing_name || !usable(row.packing_type, row.packing_status)) {
      throw new Error(`${name} has no active packing contractor. Set it in Machine Program, then generate again.`);
    }
    return {
      id: text(row.id),
      name,
      contractorPartyId: text(row.contractor_party_id),
      contractorName: text(row.contractor_name),
      packingContractorPartyId: text(row.packing_contractor_party_id),
      packingContractorName: text(row.packing_name),
    };
  },

  /** Every machine's program for one business date (YYYY-MM-DD), in program-number order. */
  listMachineDayPrograms(this: SqliteDatabase, programDate: string): MachineDayProgram[] {
    const programs = this.db
      .prepare(
        `SELECT mp.id, mp.program_number, mp.program_date, mp.machine_id, mp.machine_name_snapshot,
                mp.contractor_name_snapshot, mp.packing_contractor_name_snapshot
         FROM machine_programs mp
         WHERE mp.program_date = ? AND EXISTS (SELECT 1 FROM qr_batches b WHERE b.machine_program_id = mp.id)
         ORDER BY mp.program_number`
      )
      .all(text(programDate)) as Row[];
    if (programs.length === 0) return [];

    const linesByProgram = new Map<string, CartonProgramLine[]>();
    for (const row of this.listDayProgramLines(text(programDate))) {
      const key = text(row.machine_program_id);
      linesByProgram.set(key, [...(linesByProgram.get(key) ?? []), toLine(row)]);
    }
    return programs.map((row) => {
      const lines = linesByProgram.get(text(row.id)) ?? [];
      const cartons = lines.reduce((total, line) => total + line.cartons, 0);
      return {
        programId: text(row.id),
        programNumber: Number(row.program_number),
        code: formatMachineProgramCodeNumber(Number(row.program_number)),
        programDate: text(row.program_date),
        machineId: text(row.machine_id),
        machineName: text(row.machine_name_snapshot),
        contractorName: text(row.contractor_name_snapshot),
        packingContractorName: textOrNull(row.packing_contractor_name_snapshot),
        cartons,
        voidedCartons: lines.reduce((total, line) => total + line.voidedCartons, 0),
        equivalentDozens: cartonsToDozens(cartons),
        lines,
      };
    });
  },

  /** @internal Each program line of a date: product, colour and grade, with its counted cartons. */
  listDayProgramLines(this: SqliteDatabase, programDate: string): Row[] {
    return this.db
      .prepare(
        `SELECT b.machine_program_id, b.article_size_id,
                COALESCE(a.article, MAX(b.article)) AS article,
                COALESCE(a.size, MAX(b.size)) AS size,
                b.color, b.grade,
                MAX(c.product_variant_id) AS product_variant_id,
                COUNT(DISTINCT b.id) AS batch_count,
                MAX(b.created_at) AS last_generated_at,
                ${CARTON_COUNTS_SQL}
         FROM qr_batches b
         JOIN machine_programs mp ON mp.id = b.machine_program_id
         JOIN qr_codes c ON c.batch_id = b.id
         LEFT JOIN article_sizes a ON a.id = b.article_size_id
         WHERE mp.program_date = ? AND ${SOURCES_SQL}
         GROUP BY b.machine_program_id, b.article_size_id, b.color, b.grade
         ORDER BY article, size, b.grade IS NOT NULL, b.color`
      )
      .all(programDate, ...PROGRAM_SOURCES) as Row[];
  },

  /** The runs behind one program line, newest first. */
  listCartonProgramBatches(
    this: SqliteDatabase,
    input: { programId: string; articleSizeId: string; color: string; grade: string | null }
  ): CartonProgramBatch[] {
    const rows = this.db
      .prepare(
        `SELECT b.id, b.article, b.color, b.size, b.start_sequence, b.end_sequence,
                b.created_at, b.created_by, b.requested_by,
                ${CARTON_COUNTS_SQL}
         FROM qr_batches b
         JOIN qr_codes c ON c.batch_id = b.id
         WHERE b.machine_program_id = ? AND b.article_size_id = ? AND b.color = ? AND b.grade IS ? AND ${SOURCES_SQL}
         GROUP BY b.id
         ORDER BY b.created_at DESC, b.start_sequence DESC`
      )
      .all(
        text(input.programId),
        text(input.articleSizeId),
        text(input.color),
        input.grade === CARTON_GRADE.B ? CARTON_GRADE.B : null,
        ...PROGRAM_SOURCES
      ) as Row[];

    return rows.map((row) => {
      const parts = { article: text(row.article), color: text(row.color), size: text(row.size) };
      const cartons = Number(row.cartons ?? 0);
      return {
        id: text(row.id),
        firstQrId: this.qrIdentityAt(parts, Number(row.start_sequence)),
        lastQrId: this.qrIdentityAt(parts, Number(row.end_sequence)),
        cartons,
        voidedCartons: Number(row.voided ?? 0),
        equivalentDozens: cartonsToDozens(cartons),
        createdAt: text(row.created_at),
        createdBy: textOrNull(row.created_by),
        requestedBy: textOrNull(row.requested_by),
      };
    });
  },
};

export type CartonProgramMethods = typeof cartonProgramMethods;
