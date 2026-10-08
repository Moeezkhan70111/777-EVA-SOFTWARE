// Machine Programs: the machines and their contractors, the articles a program can be cut for,
// and the programs themselves, date by date.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").
// `this` is the database instance. The stock a program is cut against lives in
// machineProgramStock.ts, and everything written inside a transaction in machineProgramWrites.ts.

import type { DatabaseSync } from "node:sqlite";
import type { SqliteDatabase } from "../sqliteDatabase.js";
import { formatMachineProgramCode } from "@erp/application";
import {
  DEFAULT_MACHINE_SHIFT,
  MACHINE_PROGRAM_STATUS,
  attributeKey,
  machineProgramDisplayStatus,
  programOutstanding,
  roundQuantity,
} from "@erp/domain";
import { COLOUR_SQL, LINE_CONSUMED_SQL, TYPE_SQL } from "./machineProgramSql.js";
import type {
  MachineProgramArticle,
  MachineProgramBoardRow,
  MachineProgramRecord,
  MachineProgramRunRecord,
  MachineProgramUpperLineRecord,
  MachineRecord,
} from "./types.js";

const MACHINE_CODE_PREFIX = "M-";

/**
 * The section a machine is filed under when it is added by name alone. machines.section_id is
 * required by the schema, but since raw material routes were removed (migration 056) which
 * section a machine stands in no longer decides anything it can be programmed with — only that
 * it has one — so an operator adding "Machine 4" is not asked for it.
 */
const DEFAULT_MACHINE_SECTION_NAME = "MACHINES";

/** Programs of the injector shape. The first shape (time slots and bags) is history only. */
export const INJECTOR_LAYOUT = "INJECTORS";

const MACHINE_SELECT = `SELECT m.id, m.machine_code, m.name, m.section_id, ws.name AS section_name, m.sort_order, m.status,
         m.contractor_party_id, cp.party_name AS contractor_name
  FROM machines m
  JOIN work_sections ws ON ws.id = m.section_id
  LEFT JOIN parties cp ON cp.id = m.contractor_party_id`;

const text = (value: unknown): string => (value == null ? "" : String(value));

const mapMachine = (row: Record<string, unknown>): MachineRecord => ({
  id: text(row.id),
  machineCode: text(row.machine_code),
  name: text(row.name),
  sectionId: text(row.section_id),
  sectionName: text(row.section_name),
  sortOrder: Number(row.sort_order ?? 0),
  status: text(row.status) || "ACTIVE",
  contractorPartyId: row.contractor_party_id ? text(row.contractor_party_id) : null,
  contractorName: row.contractor_name ? text(row.contractor_name) : null,
});

const mapLine = (row: Record<string, unknown>): MachineProgramUpperLineRecord => {
  const quantity = Number(row.quantity ?? 0);
  const consumed = roundQuantity(Math.max(0, Number(row.consumed ?? 0)));
  return {
    id: text(row.id),
    runId: text(row.run_id),
    lineNo: Number(row.line_no ?? 0),
    itemId: text(row.item_id),
    itemDisplayName: text(row.display_name),
    upperColour: attributeKey(text(row.colour)),
    upperType: attributeKey(text(row.type)) || null,
    subCategoryName: text(row.category_name),
    quantity,
    unitCode: row.unit_code ? text(row.unit_code) : null,
    consumed,
    outstanding: programOutstanding(quantity, consumed),
    availableAtSave: Number(row.available_at_save ?? 0),
  };
};

/** The one unit a set of lines shares, or null when they are counted in different ones. */
const sharedUnit = (lines: ReadonlyArray<{ unitCode: string | null }>): string | null => {
  const units = new Set(lines.map((line) => line.unitCode ?? ""));
  return units.size === 1 ? [...units][0] || null : null;
};

const sum = (values: number[]): number => roundQuantity(values.reduce((total, value) => total + value, 0));

const mapRun = (row: Record<string, unknown>, lines: MachineProgramUpperLineRecord[]): MachineProgramRunRecord => ({
  id: text(row.id),
  programId: text(row.program_id),
  injectorNo: Number(row.injector_no ?? 0),
  runNo: Number(row.run_no ?? 0),
  soleColour: text(row.sole_colour),
  articleSizeId: text(row.article_size_id),
  article: text(row.article),
  size: text(row.size),
  totalQuantity: sum(lines.map((line) => line.quantity)),
  consumedQuantity: sum(lines.map((line) => line.consumed)),
  unitCode: sharedUnit(lines),
  lines,
});

const mapProgram = (row: Record<string, unknown>, runs: MachineProgramRunRecord[]): MachineProgramRecord => {
  const lines = runs.flatMap((run) => run.lines);
  const totalQuantity = sum(lines.map((line) => line.quantity));
  const consumedQuantity = sum(lines.map((line) => line.consumed));
  const status = text(row.status) || MACHINE_PROGRAM_STATUS.PROGRAMMED;
  const programNumber = Number(row.program_number ?? 0);
  return {
    id: text(row.id),
    programNumber,
    code: formatMachineProgramCode(programNumber),
    machineId: text(row.machine_id),
    machineName: text(row.machine_name_snapshot),
    contractorPartyId: text(row.contractor_party_id),
    contractorName: text(row.contractor_name_snapshot),
    programDate: text(row.program_date),
    shiftStartMinute: Number(row.shift_start_minute ?? DEFAULT_MACHINE_SHIFT.startMinute),
    shiftEndMinute: Number(row.shift_end_minute ?? DEFAULT_MACHINE_SHIFT.endMinute),
    status,
    displayStatus: machineProgramDisplayStatus(status, totalQuantity, consumedQuantity),
    totalQuantity,
    consumedQuantity,
    outstandingQuantity: sum(lines.map((line) => line.outstanding)),
    unitCode: sharedUnit(lines),
    createdBy: row.created_by ? text(row.created_by) : null,
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    completedAt: row.completed_at ? text(row.completed_at) : null,
    cancelledAt: row.cancelled_at ? text(row.cancelled_at) : null,
    cancelledBy: row.cancelled_by ? text(row.cancelled_by) : null,
    cancelReason: row.cancel_reason ? text(row.cancel_reason) : null,
    runs,
  };
};

export const machineProgramsMethods = {
  // ─── Machines ───────────────────────────────────────────────────────────────

  listMachines(this: SqliteDatabase, includeInactive = false): MachineRecord[] {
    const rows = this.db
      .prepare(`${MACHINE_SELECT} ${includeInactive ? "" : "WHERE m.status = 'ACTIVE'"} ORDER BY m.sort_order, m.name`)
      .all() as Array<Record<string, unknown>>;
    return rows.map(mapMachine);
  },

  /**
   * Idempotent on name, the same way createWorkSection is: an existing machine is returned.
   *
   * The section is optional. Given, it must exist. Left out, the machine goes in the floor's
   * first active section, or — on a floor with none yet — in a MACHINES section made for it,
   * in the same transaction as the machine.
   */
  createMachine(this: SqliteDatabase, input: { name: string; sectionId?: string | null }): MachineRecord {
    const name = text(input.name).trim().toUpperCase();
    if (!name) throw new Error("Machine name is required.");
    const chosenSectionId = text(input.sectionId).trim();
    if (chosenSectionId && !this.db.prepare("SELECT id FROM work_sections WHERE id = ? LIMIT 1").get(chosenSectionId)) {
      throw new Error("The section chosen for this machine no longer exists.");
    }

    const existing = this.db.prepare(`${MACHINE_SELECT} WHERE m.name = ? LIMIT 1`).get(name) as Record<string, unknown> | undefined;
    if (existing) return mapMachine(existing);

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const machine = this.insertMachine(name, chosenSectionId || this.defaultMachineSectionId());
      this.db.exec("COMMIT");
      return machine;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  },

  /** @internal The section a machine added without one goes in. Call inside a transaction. */
  defaultMachineSectionId(this: SqliteDatabase): string {
    const first = this.db
      .prepare("SELECT id FROM work_sections WHERE status = 'ACTIVE' ORDER BY created_at, name LIMIT 1")
      .get() as { id: string } | undefined;
    return first ? first.id : this.createWorkSection({ name: DEFAULT_MACHINE_SECTION_NAME }).id;
  },

  /** @internal Writes one new machine row. Call inside a transaction. */
  insertMachine(this: SqliteDatabase, name: string, sectionId: string): MachineRecord {
    const next = this.db
      .prepare(
        `SELECT COALESCE(MAX(CAST(SUBSTR(machine_code, 3) AS INTEGER)), 0) + 1 AS n
         FROM machines WHERE machine_code LIKE '${MACHINE_CODE_PREFIX}%'`
      )
      .get() as { n: number };
    const order = this.db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM machines").get() as { n: number };
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO machines (id, machine_code, name, section_id, sort_order, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`
      )
      .run(id, `${MACHINE_CODE_PREFIX}${String(next.n).padStart(3, "0")}`, name, sectionId, Number(order.n), now, now);
    return mapMachine(this.db.prepare(`${MACHINE_SELECT} WHERE m.id = ? LIMIT 1`).get(id) as Record<string, unknown>);
  },

  /**
   * Retires or restores a machine. A retired machine keeps its programs — they are history —
   * and simply stops being offered. Retiring one that still holds a live program is refused,
   * because that program's reservation would go on holding stock nobody can see.
   */
  setMachineStatus(this: SqliteDatabase, machineId: string, status: "ACTIVE" | "INACTIVE"): void {
    if (status === "INACTIVE") {
      const live = this.db
        .prepare("SELECT id FROM machine_programs WHERE machine_id = ? AND status = ? LIMIT 1")
        .get(text(machineId), MACHINE_PROGRAM_STATUS.PROGRAMMED);
      if (live) throw new Error("This machine still has a live program. Delete or finish it before retiring the machine.");
    }
    this.db.prepare("UPDATE machines SET status = ?, updated_at = ? WHERE id = ?").run(status, new Date().toISOString(), text(machineId));
  },

  // ─── Articles from the Product Master ─────────────────────────────────────

  /** Every active article in the Product Master with the sizes it is made in. Not a second list. */
  listMachineProgramArticles(this: SqliteDatabase): MachineProgramArticle[] {
    const rows = this.db
      .prepare(
        `SELECT id, article, size FROM article_sizes
         WHERE deleted_at IS NULL AND status = 'ACTIVE'
         ORDER BY article, size`
      )
      .all() as Array<Record<string, unknown>>;

    const byArticle = new Map<string, MachineProgramArticle>();
    for (const row of rows) {
      const article = text(row.article);
      const entry = byArticle.get(article) ?? { article, sizes: [] };
      entry.sizes.push({ articleSizeId: text(row.id), size: text(row.size) });
      byArticle.set(article, entry);
    }
    return [...byArticle.values()];
  },

  // ─── Programs ───────────────────────────────────────────────────────────────

  /** The board for one date: every active machine, its contractor, and that date's program. */
  listMachineProgramBoard(this: SqliteDatabase, programDate: string): MachineProgramBoardRow[] {
    return this.listMachines().map((machine) => ({
      machine,
      program: this.getMachineProgramForDate(machine.id, programDate),
    }));
  },

  /** A machine's program for one date, or null. A deleted program frees its date. */
  getMachineProgramForDate(this: SqliteDatabase, machineId: string, programDate: string): MachineProgramRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM machine_programs
         WHERE machine_id = ? AND program_date = ? AND layout = ? AND status <> ? LIMIT 1`
      )
      .get(text(machineId).trim(), text(programDate).trim(), INJECTOR_LAYOUT, MACHINE_PROGRAM_STATUS.CANCELLED) as
      | Record<string, unknown>
      | undefined;
    return row ? mapProgram(row, this.readMachineProgramRuns(text(row.id), this.db)) : null;
  },

  getMachineProgram(this: SqliteDatabase, programId: string): MachineProgramRecord | null {
    const row = this.db.prepare("SELECT * FROM machine_programs WHERE id = ? LIMIT 1").get(text(programId).trim()) as
      | Record<string, unknown>
      | undefined;
    return row ? mapProgram(row, this.readMachineProgramRuns(text(row.id), this.db)) : null;
  },

  /**
   * @internal Every sole run of a program with its upper lines, injector by injector.
   *
   * `db` is passed explicitly so a read inside a transaction uses that transaction's connection.
   */
  readMachineProgramRuns(this: SqliteDatabase, programId: string, db: DatabaseSync): MachineProgramRunRecord[] {
    const runs = db
      .prepare(
        `SELECT mpr.*, ass.article, ass.size
         FROM machine_program_runs mpr
         JOIN article_sizes ass ON ass.id = mpr.article_size_id
         WHERE mpr.program_id = ? ORDER BY mpr.injector_no, mpr.run_no`
      )
      .all(text(programId).trim()) as Array<Record<string, unknown>>;
    if (runs.length === 0) return [];

    const lines = db
      .prepare(
        `SELECT mul.*, ii.display_name, ic.name AS category_name, u.code AS unit_code,
                ${COLOUR_SQL} AS colour, ${TYPE_SQL} AS type, ${LINE_CONSUMED_SQL} AS consumed
         FROM machine_program_upper_lines mul
         JOIN machine_program_runs mpr ON mpr.id = mul.run_id
         JOIN inventory_items ii ON ii.id = mul.item_id
         JOIN inventory_categories ic ON ic.id = ii.category_id
         LEFT JOIN inventory_units u ON u.id = mul.unit_id
         WHERE mpr.program_id = ? ORDER BY mul.line_no`
      )
      .all(text(programId).trim()) as Array<Record<string, unknown>>;
    const mapped = lines.map(mapLine);
    return runs.map((run) => mapRun(run, mapped.filter((line) => line.runId === text(run.id))));
  },
};

export type MachineProgramsMethods = typeof machineProgramsMethods;
