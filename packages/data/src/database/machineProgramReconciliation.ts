// Closing a machine program against the cartons that came back — and RECONCILING when they are short.
//
//   "how does MP-000001 stand: cartons due, back, uppers missing?"   getMachineProgramReconciliation
//   "close it: complete, or with every missing upper accounted for"  completeMachineProgramProduction
//   "is it closed?"                                                    isMachineProgramClosed
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").
//
// The figures are listMachineProgramCartonProgress's — due for what was ISSUED (3 DOZEN = 6
// cartons), back as stored in through Carton In — so the reconciliation screen, the cards and the
// closure can never disagree. The rule a reconciliation must meet is the domain's
// (reconciliationEntryProblem); this module applies it inside the write lock, to the shortfall it
// works out itself, never the screen's.

import type { SqliteDatabase } from "../sqliteDatabase.js";
import {
  MACHINE_PROGRAM_CLOSE_OUTCOME,
  MACHINE_PROGRAM_STATUS,
  NOTIFICATION_KIND,
  NOTIFICATION_SEVERITY,
  RECONCILIATION_LOSS_PARTY,
  reconciliationEntryProblem,
  shortfallUppers,
  type MachineProgramCloseOutcome,
  type ReconciliationEntry,
} from "@erp/domain";
import type { MachineProgramRecord } from "./types.js";

const text = (value: unknown): string => (value == null ? "" : String(value));

/** A party a claim can be made against. */
export interface ReconciliationParty {
  partyId: string;
  name: string;
}

/** One upper line of a program, as the reconciliation screen reads it. */
export interface ReconciliationLine {
  lineId: string;
  itemId: string;
  upperName: string;
  article: string;
  size: string;
  soleColour: string;
  upperColour: string;
  /** Null when the upper is not counted in whole cartons of DOZEN — it cannot be reconciled here. */
  cartonsDue: number | null;
  cartonsBack: number;
  /** Uppers to account for: the missing cartons, 6 uppers each. */
  shortfallUppers: number;
  /** The suppliers whose packets of this upper went out for the program — who wastage is claimed against. */
  suppliers: ReconciliationParty[];
  /** What was recorded when the program was closed, or null while it is open. */
  saved: (ReconciliationEntry & { wastagePartyName: string | null; lostPartyName: string | null }) | null;
}

export interface MachineProgramClosure {
  outcome: MachineProgramCloseOutcome;
  cartonsDue: number;
  cartonsBack: number;
  closedBy: string;
  closedAt: string;
}

export interface MachineProgramReconciliation {
  programId: string;
  code: string;
  closure: MachineProgramClosure | null;
  /** Who a LOST upper can be claimed against. */
  machineContractor: ReconciliationParty | null;
  packingContractor: ReconciliationParty | null;
  lines: ReconciliationLine[];
  cartonsDue: number;
  cartonsBack: number;
  /** Why the program cannot be closed here at all, or null when it can. */
  blockedReason: string | null;
}

export type ReconciliationInputEntry = ReconciliationEntry & { lineId: string };

const party = (partyId: string | null, name: string | null): ReconciliationParty | null =>
  partyId ? { partyId, name: name ?? "" } : null;

const closureOf = (row: Record<string, unknown> | undefined): MachineProgramClosure | null =>
  row
    ? {
        outcome: text(row.outcome) as MachineProgramCloseOutcome,
        cartonsDue: Number(row.cartons_due ?? 0),
        cartonsBack: Number(row.cartons_back ?? 0),
        closedBy: text(row.closed_by),
        closedAt: text(row.closed_at),
      }
    : null;

const savedOf = (row: Record<string, unknown> | undefined): ReconciliationLine["saved"] =>
  row
    ? {
        cutSize: Number(row.cut_size_uppers ?? 0),
        wastage: Number(row.wastage_uppers ?? 0),
        wastagePartyId: row.wastage_party_id ? text(row.wastage_party_id) : null,
        wastagePartyName: row.wastage_party_name ? text(row.wastage_party_name) : null,
        wastageReason: text(row.wastage_reason),
        lost: Number(row.lost_uppers ?? 0),
        lostParty: row.lost_role ? (text(row.lost_role) as ReconciliationEntry["lostParty"]) : null,
        lostPartyName: row.lost_party_name ? text(row.lost_party_name) : null,
        lostReason: text(row.lost_reason),
      }
    : null;

/** The claims a reconciliation makes, in one sentence for the administrators. */
const claimSummary = (lines: ReconciliationLine[], entries: Map<string, ReconciliationInputEntry>, program: MachineProgramRecord): string => {
  const parts: string[] = [];
  for (const line of lines) {
    const entry = entries.get(line.lineId);
    if (!entry) continue;
    const upper = `${line.article} ${line.size} ${line.upperColour}`;
    if (entry.wastage > 0) {
      const supplier = line.suppliers.find((candidate) => candidate.partyId === entry.wastagePartyId)?.name ?? "";
      parts.push(`${entry.wastage} ${upper} wasted, claimed to ${supplier} — "${entry.wastageReason.trim()}"`);
    }
    if (entry.lost > 0) {
      const contractor = entry.lostParty === RECONCILIATION_LOSS_PARTY.PACKING ? program.packingContractorName : program.contractorName;
      parts.push(`${entry.lost} ${upper} lost, claimed to ${contractor ?? ""} — "${entry.lostReason.trim()}"`);
    }
  }
  return parts.join("; ");
};

export const machineProgramReconciliationMethods = {
  /** Whether a program has been closed (complete or reconciled). Nothing more happens on it then. */
  isMachineProgramClosed(this: SqliteDatabase, programId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM machine_program_closures WHERE program_id = ? LIMIT 1").get(text(programId).trim()));
  },

  /** How a program stands against the cartons that came back, line by line, and how it was closed. */
  getMachineProgramReconciliation(this: SqliteDatabase, programId: string): MachineProgramReconciliation | null {
    const program = this.getMachineProgram(text(programId).trim());
    if (!program) return null;
    const progress = new Map(this.listMachineProgramCartonProgress(program.id).map((row) => [row.lineId, row]));
    const suppliersOf = this.db.prepare(
      `SELECT DISTINCT p.id, p.party_name FROM raw_material_qr_events rme
         JOIN parties p ON p.id = rme.party_id
        WHERE rme.machine_program_upper_line_id = ? AND rme.event_type = 'STORE_EXIT'
        ORDER BY p.party_name`
    );
    const savedLine = this.db.prepare(
      `SELECT r.*, ws.party_name AS wastage_party_name, lp.party_name AS lost_party_name
         FROM machine_program_reconciliation_lines r
         LEFT JOIN parties ws ON ws.id = r.wastage_party_id
         LEFT JOIN parties lp ON lp.id = r.lost_party_id
        WHERE r.program_id = ? AND r.upper_line_id = ?`
    );

    const lines: ReconciliationLine[] = program.runs.flatMap((run) =>
      run.lines.map((line) => {
        const figures = progress.get(line.id);
        const cartonsDue = figures ? figures.cartonsDue : 0;
        const cartonsBack = figures?.cartonsBack ?? 0;
        return {
          lineId: line.id,
          itemId: line.itemId,
          upperName: line.itemDisplayName,
          article: run.article,
          size: run.size,
          soleColour: run.soleColour,
          upperColour: line.upperColour,
          cartonsDue,
          cartonsBack,
          shortfallUppers: cartonsDue == null ? 0 : shortfallUppers(cartonsDue, cartonsBack),
          suppliers: (suppliersOf.all(line.id) as Array<Record<string, unknown>>).map((row) => ({ partyId: text(row.id), name: text(row.party_name) })),
          saved: savedOf(savedLine.get(program.id, line.id) as Record<string, unknown> | undefined),
        };
      })
    );

    const notWhole = lines.find((line) => line.cartonsDue == null);
    return {
      programId: program.id,
      code: program.code,
      closure: closureOf(this.db.prepare("SELECT * FROM machine_program_closures WHERE program_id = ?").get(program.id) as Record<string, unknown> | undefined),
      machineContractor: party(program.contractorPartyId, program.contractorName),
      packingContractor: party(program.packingContractorPartyId, program.packingContractorName),
      lines,
      cartonsDue: lines.reduce((total, line) => total + (line.cartonsDue ?? 0), 0),
      cartonsBack: lines.reduce((total, line) => total + line.cartonsBack, 0),
      blockedReason:
        program.status === MACHINE_PROGRAM_STATUS.CANCELLED
          ? `${program.code} has been deleted, so it cannot be completed.`
          : notWhole
            ? `${notWhole.upperName} is not counted in whole cartons of DOZEN, so its cartons cannot be reconciled here.`
            : null,
    };
  },

  /**
   * Closes a program, exactly once: COMPLETE when every carton due is back, otherwise RECONCILED with
   * every missing upper accounted for as cut size, wastage or lost.
   *
   * One transaction: the closure, its lines, the program's status (COMPLETED — no reservation is
   * held, so uppers planned but never issued are released) and, when anything is claimed, a notice
   * to every administrator. The shortfall is worked out HERE from the stored-in cartons; what the
   * screen sends is only what the store says became of it. Throws with the operator's sentence.
   */
  completeMachineProgramProduction(
    this: SqliteDatabase,
    input: { programId: string; entries: ReconciliationInputEntry[]; closedBy: string; deviceId: string }
  ): MachineProgramClosure {
    const closedBy = text(input.closedBy).trim();
    if (!closedBy) throw new Error("Closing a program needs the signed-in user.");

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const view = this.getMachineProgramReconciliation(input.programId);
      if (!view) throw new Error("This machine program no longer exists.");
      if (view.closure) throw new Error(`${view.code} is already closed.`);
      if (view.blockedReason) throw new Error(view.blockedReason);
      const program = this.getMachineProgram(view.programId)!;

      const entries = new Map(input.entries.map((entry) => [text(entry.lineId), entry]));
      const unknown = [...entries.keys()].find((lineId) => !view.lines.some((line) => line.lineId === lineId));
      if (unknown) throw new Error("Part of this reconciliation is for an upper that is not on the program. Reload and try again.");

      const short = view.lines.filter((line) => line.shortfallUppers > 0);
      for (const line of short) {
        const entry = entries.get(line.lineId);
        const upper = `${line.article} ${line.size} ${line.upperColour}`;
        if (!entry) throw new Error(`Account for the ${line.shortfallUppers} missing uppers of ${upper}.`);
        const problem = reconciliationEntryProblem(line.shortfallUppers, entry);
        if (problem) throw new Error(`${upper}: ${problem}`);
        if (entry.wastage > 0 && !line.suppliers.some((supplier) => supplier.partyId === entry.wastagePartyId)) {
          throw new Error(`${upper}: wastage can only be claimed to a supplier whose uppers went out for this program.`);
        }
        if (entry.lost > 0 && entry.lostParty === RECONCILIATION_LOSS_PARTY.PACKING && !view.packingContractor) {
          throw new Error(`${view.code} has no packing contractor to claim the lost uppers against.`);
        }
      }

      const now = new Date().toISOString();
      const outcome = short.length > 0 ? MACHINE_PROGRAM_CLOSE_OUTCOME.RECONCILED : MACHINE_PROGRAM_CLOSE_OUTCOME.COMPLETE;
      this.db
        .prepare(
          `INSERT INTO machine_program_closures (program_id, outcome, cartons_due, cartons_back, closed_by, device_id, closed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(view.programId, outcome, view.cartonsDue, view.cartonsBack, closedBy, input.deviceId, now);

      const insertLine = this.db.prepare(
        `INSERT INTO machine_program_reconciliation_lines
           (id, program_id, upper_line_id, item_id, cartons_due, cartons_back, shortfall_uppers,
            cut_size_uppers, wastage_uppers, wastage_party_id, wastage_reason,
            lost_uppers, lost_role, lost_party_id, lost_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const line of short) {
        const entry = entries.get(line.lineId)!;
        const lostPartyId =
          entry.lost > 0
            ? (entry.lostParty === RECONCILIATION_LOSS_PARTY.PACKING ? view.packingContractor : view.machineContractor)?.partyId ?? null
            : null;
        insertLine.run(
          crypto.randomUUID(), view.programId, line.lineId, line.itemId, line.cartonsDue, line.cartonsBack, line.shortfallUppers,
          entry.cutSize, entry.wastage, entry.wastage > 0 ? entry.wastagePartyId : null, entry.wastage > 0 ? entry.wastageReason.trim() : null,
          entry.lost, entry.lost > 0 ? entry.lostParty : null, lostPartyId, entry.lost > 0 ? entry.lostReason.trim() : null, now
        );
      }

      // COMPLETED holds no reservation: whatever was planned and never issued is free stock again.
      this.db
        .prepare("UPDATE machine_programs SET status = ?, completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ?")
        .run(MACHINE_PROGRAM_STATUS.COMPLETED, now, now, view.programId);

      const claims = claimSummary(short, entries, program);
      if (claims) {
        this.notifyAdministrators({
          kind: NOTIFICATION_KIND.MACHINE_PROGRAM_RECONCILED,
          severity: NOTIFICATION_SEVERITY.WARNING,
          entityId: view.programId,
          title: `Uppers claimed on ${view.code}`,
          message: `${view.code} (${program.machineName}) closed ${view.cartonsBack} of ${view.cartonsDue} cartons back by ${closedBy}: ${claims}.`,
        });
      }

      this.db.exec("COMMIT");
      return { outcome, cartonsDue: view.cartonsDue, cartonsBack: view.cartonsBack, closedBy, closedAt: now };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* no transaction to roll back */ }
      throw error;
    }
  },
};

export type MachineProgramReconciliationMethods = typeof machineProgramReconciliationMethods;
