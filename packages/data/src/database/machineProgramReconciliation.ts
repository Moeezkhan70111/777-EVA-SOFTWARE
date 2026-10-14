// Closing a machine program against the cartons that came back — and RECONCILING when they are short.
//
//   "how does MP-000001 stand: cartons due, back, pairs missing?"   getMachineProgramReconciliation
//   "close it: complete, or with every missing pair accounted for"  completeMachineProgramProduction
//   "is it closed?"                                                    isMachineProgramClosed
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").
//
// The figures are listMachineProgramCartonProgress's — due for what is still ISSUED (a packet
// scanned back lowers it), back as stored in through Carton In, B cartons included — so the
// reconciliation screen, the cards and the closure can never disagree. The rule a reconciliation
// must meet is the domain's (upperReconciliationProblem); this module applies it inside the write
// lock, to the shortfall it works out itself, never the screen's. The writes an upper line's
// reconciliation makes are machineProgramUpperReconciliation.ts. EVR FIX is read here but closes
// by its own rule (every carton back), which is unchanged.

import type { SqliteDatabase } from "../sqliteDatabase.js";
import {
  CARTON_GRADE,
  CLAIM_PARTY_ROLE,
  MACHINE_PROGRAM_CLOSE_OUTCOME,
  MACHINE_PROGRAM_STATUS,
  NOTIFICATION_KIND,
  NOTIFICATION_SEVERITY,
  cartonsExpectedFromUppers,
  cartonsToPairs,
  claimAmountPaisa,
  fromPaisa,
  shortfallUppers,
  upperReconciliationProblem,
  type ClaimPartyRole,
  type MachineProgramCloseOutcome,
  type UpperReconciliation,
} from "@erp/domain";
import { CUT_SIZE_KIND } from "./machineProgramUpperReconciliation.js";
import type { MachineProgramRecord } from "./types.js";

const text = (value: unknown): string => (value == null ? "" : String(value));

/** A party a claim can be made against. */
export interface ReconciliationParty {
  partyId: string;
  name: string;
}

/** A claim as the closed program shows it. Legacy claims (before priced claims) carry no number or amount. */
export interface SavedReconciliationClaim {
  claimNumber: string | null;
  role: ClaimPartyRole;
  partyName: string;
  pairs: number;
  amountPaisa: number | null;
  reason: string;
}

/** What was recorded for one upper line when the program closed. */
export interface SavedUpperReconciliation {
  cutSizeUppers: number;
  cutSizePairs: number;
  /** Pairs returned to the store as sealed packets before closing. */
  returnedUpperPairs: number;
  /** Missing cartons that came back as B cartons before closing. */
  bCartons: number;
  claims: SavedReconciliationClaim[];
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
  /** Cartons for everything that went out for the line, before any packet came back. Null when not whole cartons. */
  issuedCartons: number | null;
  /** Sealed packets scanned back to the store, as cartons. Null when not whole cartons. */
  returnedUpperCartons: number | null;
  /** Null when the upper is not counted in whole cartons of DOZEN — it cannot be reconciled here. */
  cartonsDue: number | null;
  /** Stored in — B cartons included. */
  cartonsBack: number;
  /** B carton labels printed for the line, and how many of them are stored in. */
  bCartons: number;
  bBack: number;
  /** Cartons still missing: due, less back, less B labels printed and not yet scanned in. */
  missingCartons: number;
  /** The pairs to account for on closing: the missing cartons, 6 pairs each. */
  shortfallUppers: number;
  /** The suppliers whose packets of this upper went out for the program — who a supplier claim is against. */
  suppliers: ReconciliationParty[];
  /** What was recorded when the program was closed, or null while it is open. */
  saved: SavedUpperReconciliation | null;
}

/**
 * One FIX run of a program (EVR FIX: two soles, no upper), as the reconciliation reads it.
 *
 * Its cartons are owed by its PLAN (32 DOZEN is 64), and back as its printed labels are stored in.
 * There is no upper behind a missing fix carton, so nothing is claimed for it: it comes back as
 * itself or as a B carton (Reconciliation), and until it does the program cannot close.
 */
export interface ReconciliationFixRun {
  runId: string;
  article: string;
  size: string;
  outerSoleColour: string;
  innerSoleColour: string;
  /** Null when the plan is not whole cartons of DOZEN — the program cannot be closed here then. */
  cartonsDue: number | null;
  cartonsBack: number;
  cartonNote: string | null;
  /** Printed labels not back — the most that can be turned into B cartons (migration 074). */
  convertible: number;
  /** B carton labels printed for this run, and how many of them are back. */
  bCartons: number;
  bBack: number;
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
  /** Who a contractor claim can be made against. */
  machineContractor: ReconciliationParty | null;
  packingContractor: ReconciliationParty | null;
  lines: ReconciliationLine[];
  /** The program's FIX runs. Counted in cartonsDue/cartonsBack beside the upper lines. */
  fixRuns: ReconciliationFixRun[];
  /** Every carton due and back — upper lines AND fix runs. */
  cartonsDue: number;
  cartonsBack: number;
  /** Fix cartons that have not come back. While any are out, the program cannot close. */
  fixCartonsShort: number;
  /** Why the program cannot be closed here at all, or null when it can. */
  blockedReason: string | null;
}

/** A fix run's cartons as the reconciliation counts them, from the run and its printed labels. */
const fixRunOf = (
  run: {
    runId: string; article: string; size: string; outerSoleColour: string; innerSoleColour: string;
    cartonsPlanned: number | null; cartonNote: string | null;
    labels: Array<{ receivedInRun: number; cartonCount: number; grade: string | null }>;
  },
  convertible: number
): ReconciliationFixRun => {
  const bLabels = run.labels.filter((label) => label.grade === CARTON_GRADE.B);
  return {
    runId: run.runId,
    article: run.article,
    size: run.size,
    outerSoleColour: run.outerSoleColour,
    innerSoleColour: run.innerSoleColour,
    cartonsDue: run.cartonsPlanned,
    // Back counts B cartons too: a B carton IS one of the run's cartons, labelled again as MIX.
    cartonsBack: run.labels.reduce((total, label) => total + label.receivedInRun, 0),
    cartonNote: run.cartonNote,
    convertible,
    bCartons: bLabels.reduce((total, label) => total + label.cartonCount, 0),
    bBack: bLabels.reduce((total, label) => total + label.receivedInRun, 0),
  };
};

const upperName = (line: Pick<ReconciliationLine, "article" | "size" | "upperColour">): string => `${line.article} ${line.size} ${line.upperColour}`;

/** Why an upper line keeps the program from closing, or null. */
const upperLineBlockedReason = (line: ReconciliationLine): string | null => {
  if (line.cartonsDue == null) return `${line.upperName} is not counted in whole cartons of DOZEN, so its cartons cannot be reconciled here.`;
  const waiting = line.bCartons - line.bBack;
  if (waiting > 0) {
    return `${waiting} B carton${waiting === 1 ? "" : "s"} of ${upperName(line)} ${waiting === 1 ? "is" : "are"} printed but not scanned in yet. Scan ${waiting === 1 ? "it" : "them"} on Carton In first.`;
  }
  // Only possible when a packet was scanned back after its own cartons had come in.
  if (line.cartonsBack > line.cartonsDue) {
    return `${upperName(line)} has more cartons back (${line.cartonsBack}) than its uppers still out make (${line.cartonsDue}). Check the packets scanned back to the store.`;
  }
  return null;
};

/** Why the program cannot be closed here, or null. */
const closeBlockedReason = (
  program: MachineProgramRecord,
  lines: ReconciliationLine[],
  fixRuns: ReconciliationFixRun[]
): string | null => {
  if (program.status === MACHINE_PROGRAM_STATUS.CANCELLED) return `${program.code} has been deleted, so it cannot be completed.`;
  for (const line of lines) {
    const reason = upperLineBlockedReason(line);
    if (reason) return reason;
  }
  const fixNotWhole = fixRuns.find((run) => run.cartonsDue == null);
  if (fixNotWhole) return fixNotWhole.cartonNote ?? `${fixNotWhole.article} ${fixNotWhole.size} is not planned in whole cartons, so its cartons cannot be reconciled here.`;
  // EVR FIX closes only when EVERY carton is back (owner, 2026-10-12). A missing fix carton has no
  // upper to account for, so there is nothing to reconcile it against: it comes back as itself, or
  // as a B carton (Reconciliation), or the program stays open.
  const fixShort = fixRuns.reduce((total, run) => total + Math.max(0, (run.cartonsDue ?? 0) - run.cartonsBack), 0);
  if (fixShort > 0) {
    return `${fixShort} EVR FIX carton${fixShort === 1 ? " is" : "s are"} still to come back. Scan ${fixShort === 1 ? "it" : "them"} on Carton In — or, if ${fixShort === 1 ? "it" : "they"} came back as B, make ${fixShort === 1 ? "it a B carton" : "them B cartons"} in Reconciliation. ${program.code} cannot close until every carton is back.`;
  }
  return null;
};

export type ReconciliationInputEntry = UpperReconciliation & { lineId: string };

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

/** A program closed before priced claims recorded wastage and loss on the line itself. */
const legacyClaims = (row: Record<string, unknown>): SavedReconciliationClaim[] => {
  const claims: SavedReconciliationClaim[] = [];
  if (Number(row.wastage_uppers ?? 0) > 0) {
    claims.push({ claimNumber: null, role: CLAIM_PARTY_ROLE.SUPPLIER, partyName: text(row.wastage_party_name), pairs: Number(row.wastage_uppers), amountPaisa: null, reason: text(row.wastage_reason) });
  }
  if (Number(row.lost_uppers ?? 0) > 0) {
    const role = text(row.lost_role) === CLAIM_PARTY_ROLE.PACKING ? CLAIM_PARTY_ROLE.PACKING : CLAIM_PARTY_ROLE.MACHINE;
    claims.push({ claimNumber: null, role, partyName: text(row.lost_party_name), pairs: Number(row.lost_uppers), amountPaisa: null, reason: text(row.lost_reason) });
  }
  return claims;
};

/** The claims a reconciliation made, in one sentence for the administrators. */
const claimSummary = (lines: ReconciliationLine[], entries: Map<string, ReconciliationInputEntry>, partyName: (role: ClaimPartyRole, supplierId: string | null) => string): string =>
  lines
    .flatMap((line) =>
      (entries.get(line.lineId)?.claims ?? []).map(
        (claim) => `${claim.pairs} pair${claim.pairs === 1 ? "" : "s"} of ${upperName(line)} claimed to ${partyName(claim.role, claim.supplierPartyId)} for Rs ${fromPaisa(claimAmountPaisa(claim)).toFixed(2)} — "${claim.reason.trim()}"`
      )
    )
    .join("; ");

export const machineProgramReconciliationMethods = {
  /** Whether a program has been closed (complete or reconciled). Nothing more happens on it then. */
  isMachineProgramClosed(this: SqliteDatabase, programId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM machine_program_closures WHERE program_id = ? LIMIT 1").get(text(programId).trim()));
  },

  /** How a program stands against the cartons that came back, line by line, and how it was closed. */
  getMachineProgramReconciliation(this: SqliteDatabase, programId: string): MachineProgramReconciliation | null {
    const program = this.getMachineProgram(text(programId).trim());
    if (!program) return null;
    const lines = this.reconciliationLinesOf(program);

    // EVR FIX has no upper line, so without these a fix-only program read "0 of 0 back" and
    // "every carton due is back" while its cartons were still out on the floor.
    const fixRuns = this.listMachineProgramFixCartonRuns(program.id).map((run) =>
      fixRunOf(run, this.countConvertibleFixLabels(program.id, run.runId))
    );
    const due = (value: number | null): number => value ?? 0;
    return {
      programId: program.id,
      code: program.code,
      closure: closureOf(this.db.prepare("SELECT * FROM machine_program_closures WHERE program_id = ?").get(program.id) as Record<string, unknown> | undefined),
      machineContractor: party(program.contractorPartyId, program.contractorName),
      packingContractor: party(program.packingContractorPartyId, program.packingContractorName),
      lines,
      fixRuns,
      cartonsDue: lines.reduce((total, line) => total + due(line.cartonsDue), 0) + fixRuns.reduce((total, run) => total + due(run.cartonsDue), 0),
      cartonsBack: lines.reduce((total, line) => total + line.cartonsBack, 0) + fixRuns.reduce((total, run) => total + run.cartonsBack, 0),
      fixCartonsShort: fixRuns.reduce((total, run) => total + Math.max(0, due(run.cartonsDue) - run.cartonsBack), 0),
      blockedReason: closeBlockedReason(program, lines, fixRuns),
    };
  },

  /** @internal Every upper line of a program with its cartons, returns, B cartons and shortfall. */
  reconciliationLinesOf(this: SqliteDatabase, program: MachineProgramRecord): ReconciliationLine[] {
    const progress = new Map(this.listMachineProgramCartonProgress(program.id).map((row) => [row.lineId, row]));
    const movements = new Map(
      (this.db
        .prepare(
          `SELECT machine_program_upper_line_id AS line_id,
                  SUM(CASE WHEN event_type = 'STORE_EXIT' THEN quantity ELSE 0 END) AS issued,
                  SUM(CASE WHEN event_type = 'STORE_ENTRY' THEN quantity ELSE 0 END) AS returned
             FROM raw_material_qr_events
            WHERE machine_program_upper_line_id IN (SELECT mul.id FROM machine_program_upper_lines mul
                                                     JOIN machine_program_runs mpr ON mpr.id = mul.run_id WHERE mpr.program_id = ?)
            GROUP BY machine_program_upper_line_id`
        )
        .all(program.id) as Array<Record<string, unknown>>).map((row) => [text(row.line_id), row])
    );
    const suppliersOf = this.db.prepare(
      `SELECT DISTINCT p.id, p.party_name FROM raw_material_qr_events rme
         JOIN parties p ON p.id = rme.party_id
        WHERE rme.machine_program_upper_line_id = ? AND rme.event_type = 'STORE_EXIT'
        ORDER BY p.party_name`
    );

    return program.runs.flatMap((run) =>
      run.lines.map((line) => {
        const figures = progress.get(line.id);
        const cartonsDue = figures ? figures.cartonsDue : 0;
        const cartonsBack = figures?.cartonsBack ?? 0;
        const bCartons = figures?.bCartons ?? 0;
        const bBack = figures?.bBack ?? 0;
        const moved = movements.get(line.id);
        const cartonsOf = (quantity: unknown): number | null =>
          Number(quantity ?? 0) > 0 ? cartonsExpectedFromUppers(Number(quantity), line.unitCode) : 0;
        const missingCartons = cartonsDue == null ? 0 : Math.max(0, cartonsDue - cartonsBack - (bCartons - bBack));
        return {
          lineId: line.id,
          itemId: line.itemId,
          upperName: line.itemDisplayName,
          article: run.article,
          size: run.size,
          soleColour: run.soleColour,
          upperColour: line.upperColour,
          issuedCartons: cartonsOf(moved?.issued),
          returnedUpperCartons: cartonsOf(moved?.returned),
          cartonsDue,
          cartonsBack,
          bCartons,
          bBack,
          missingCartons,
          shortfallUppers: shortfallUppers(missingCartons, 0),
          suppliers: (suppliersOf.all(line.id) as Array<Record<string, unknown>>).map((row) => ({ partyId: text(row.id), name: text(row.party_name) })),
          saved: this.savedUpperReconciliation(program.id, line.id),
        };
      })
    );
  },

  /** @internal What was recorded for one upper line when its program closed, or null. */
  savedUpperReconciliation(this: SqliteDatabase, programId: string, lineId: string): SavedUpperReconciliation | null {
    const row = this.db
      .prepare(
        `SELECT r.*, ws.party_name AS wastage_party_name, lp.party_name AS lost_party_name
           FROM machine_program_reconciliation_lines r
           LEFT JOIN parties ws ON ws.id = r.wastage_party_id
           LEFT JOIN parties lp ON lp.id = r.lost_party_id
          WHERE r.program_id = ? AND r.upper_line_id = ?`
      )
      .get(programId, lineId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const claims = (this.db
      .prepare(
        `SELECT c.claim_number, c.party_role, p.party_name, c.quantity_pairs, c.amount_paisa, c.reason
           FROM party_claims c JOIN parties p ON p.id = c.party_id
          WHERE c.program_id = ? AND c.upper_line_id = ? AND c.status = 'POSTED'
          ORDER BY c.claim_number`
      )
      .all(programId, lineId) as Array<Record<string, unknown>>).map((claim) => ({
      claimNumber: text(claim.claim_number),
      role: text(claim.party_role) as ClaimPartyRole,
      partyName: text(claim.party_name),
      pairs: Number(claim.quantity_pairs ?? 0),
      amountPaisa: Number(claim.amount_paisa ?? 0),
      reason: text(claim.reason),
    }));
    return {
      cutSizeUppers: Number(row.cut_size_uppers ?? 0),
      cutSizePairs: Number(row.cut_size_pairs ?? 0),
      returnedUpperPairs: Number(row.returned_upper_pairs ?? 0),
      bCartons: Number(row.b_cartons ?? 0),
      claims: [...legacyClaims(row), ...claims],
    };
  },

  /**
   * Closes a program, exactly once: COMPLETE when every carton due is back, otherwise RECONCILED
   * with every remaining pair accounted for as cut size upper, cut size pairs or a claim.
   *
   * One transaction: the closure and its lines; the cut size put back in the store; every claim
   * posted to its party's ledger; every original label still not back voided; the program's status
   * (COMPLETED — nothing planned and never issued stays reserved); and, when anything is claimed, a
   * notice to every administrator. The shortfall is worked out HERE; what the screen sends is only
   * what the store says became of it. Throws with the operator's sentence, having written nothing.
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
      for (const line of short) this.checkUpperReconciliation(view, line, entries.get(line.lineId));

      const now = new Date().toISOString();
      // A fix carton still out never gets this far (closeBlockedReason), so a shortfall here is
      // only ever an upper line's, accounted for above.
      const outcome = short.length > 0 ? MACHINE_PROGRAM_CLOSE_OUTCOME.RECONCILED : MACHINE_PROGRAM_CLOSE_OUTCOME.COMPLETE;
      this.db
        .prepare(
          `INSERT INTO machine_program_closures (program_id, outcome, cartons_due, cartons_back, closed_by, device_id, closed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(view.programId, outcome, view.cartonsDue, view.cartonsBack, closedBy, input.deviceId, now);

      for (const line of short) this.writeUpperReconciliation(view, line, entries.get(line.lineId)!, closedBy, now);
      // Nothing can be stored in against a closed program, so a label not back is a dead label.
      this.voidUnreturnedUpperLabels(view.programId, view.code, closedBy);

      // COMPLETED holds no reservation: whatever was planned and never issued is free stock again.
      this.db
        .prepare("UPDATE machine_programs SET status = ?, completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ?")
        .run(MACHINE_PROGRAM_STATUS.COMPLETED, now, now, view.programId);

      const claims = claimSummary(short, entries, (role, supplierId) => this.claimPartyOf(view, role, supplierId)?.name ?? "");
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

  /** @internal The party a claim is against: the chosen supplier of the upper, or the program's own contractor. */
  claimPartyOf(this: SqliteDatabase, view: MachineProgramReconciliation, role: ClaimPartyRole, supplierId: string | null): ReconciliationParty | null {
    if (role === CLAIM_PARTY_ROLE.MACHINE) return view.machineContractor;
    if (role === CLAIM_PARTY_ROLE.PACKING) return view.packingContractor;
    const line = view.lines.find((candidate) => candidate.suppliers.some((supplier) => supplier.partyId === supplierId));
    return line?.suppliers.find((supplier) => supplier.partyId === supplierId) ?? null;
  },

  /** @internal Throws with the operator's sentence unless the line's reconciliation can be saved. */
  checkUpperReconciliation(this: SqliteDatabase, view: MachineProgramReconciliation, line: ReconciliationLine, entry: ReconciliationInputEntry | undefined): void {
    const upper = upperName(line);
    if (!entry) throw new Error(`Account for the ${line.shortfallUppers} remaining pairs of ${upper}.`);
    const problem = upperReconciliationProblem(line.shortfallUppers, entry);
    if (problem) throw new Error(`${upper}: ${problem}`);
    for (const claim of entry.claims) {
      if (claim.role === CLAIM_PARTY_ROLE.SUPPLIER && !line.suppliers.some((supplier) => supplier.partyId === claim.supplierPartyId)) {
        throw new Error(`${upper}: a supplier claim can only be made to a supplier whose uppers went out for this program.`);
      }
      if (claim.role !== CLAIM_PARTY_ROLE.SUPPLIER && !this.claimPartyOf(view, claim.role, null)) {
        throw new Error(`${view.code} has no ${claim.role === CLAIM_PARTY_ROLE.PACKING ? "packing" : "machine"} contractor to claim against.`);
      }
    }
  },

  /** @internal Writes one short line's reconciliation: its row, its cut size stock and its claims. */
  writeUpperReconciliation(this: SqliteDatabase, view: MachineProgramReconciliation, line: ReconciliationLine, entry: ReconciliationInputEntry, actor: string, now: string): void {
    const claimedPairs = entry.claims.reduce((total, claim) => total + claim.pairs, 0);
    const returnedPairs = cartonsToPairs(line.returnedUpperCartons ?? 0);
    this.db
      .prepare(
        `INSERT INTO machine_program_reconciliation_lines
           (id, program_id, upper_line_id, item_id, cartons_due, cartons_back, shortfall_uppers,
            cut_size_uppers, cut_size_pairs, claimed_pairs, returned_upper_pairs, b_cartons, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        crypto.randomUUID(), view.programId, line.lineId, line.itemId, line.cartonsDue, line.cartonsBack, line.shortfallUppers,
        entry.cutSizeUppers, entry.cutSizePairs, claimedPairs, returnedPairs, line.bCartons, now
      );

    for (const claim of entry.claims) {
      const against = this.claimPartyOf(view, claim.role, claim.supplierPartyId)!;
      this.postPartyClaim({
        partyId: against.partyId, role: claim.role, programId: view.programId, lineId: line.lineId, itemId: line.itemId,
        pairs: claim.pairs, ratePaisa: claim.ratePaisa, reason: claim.reason, actor,
      });
    }
    if (entry.cutSizeUppers > 0) {
      this.receiveCutSize({ kind: CUT_SIZE_KIND.UPPER, what: line.upperName, pairs: entry.cutSizeUppers, code: view.code, actor });
    }
    if (entry.cutSizePairs > 0) {
      const made = `${line.article} ${line.size} ${line.soleColour} ${line.upperColour}`;
      this.receiveCutSize({ kind: CUT_SIZE_KIND.PAIRS, what: made, pairs: entry.cutSizePairs, code: view.code, actor });
    }
  },
};

export type MachineProgramReconciliationMethods = typeof machineProgramReconciliationMethods;
