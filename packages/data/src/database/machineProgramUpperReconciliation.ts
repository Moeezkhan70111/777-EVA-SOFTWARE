// Reconciling an UPPER line of a machine program — the writes behind it (EVR FIX is elsewhere and
// unchanged). The view and the closing itself are machineProgramReconciliation.ts.
//
//   "these missing cartons came back as B"          convertUpperCartonsToB      (before closing)
//   "labels that can never come back now"            voidUnreturnedUpperLabels   (on closing)
//   "cut size back into the store"                   receiveCutSize              (on closing)
//   "claim these pairs against that party"           postPartyClaim              (on closing)
//
// The closing calls the last three inside its own transaction, so nothing here opens one except
// convertUpperCartonsToB, which stands alone. These methods are merged onto SqliteDatabase (see
// sqliteDatabase.ts, "Feature modules").

import type { SqliteDatabase } from "../sqliteDatabase.js";
import {
  B_CARTON_COLOUR,
  CARTON_GRADE,
  PARTY_CLAIM_STATUS,
  QR_BATCH_SOURCE,
  STOCK_EVENT_NOTE,
  claimAmountPaisa,
  upperBConversionProblem,
  type ClaimPartyRole,
} from "@erp/domain";
import type { GeneratedQrBatch } from "./qrCodes.js";

const text = (value: unknown): string => (value == null ? "" : String(value));

/** The two kinds of cut size, each kept as its own raw material counted in pairs. */
export const CUT_SIZE_KIND = {
  /** Loose uppers from an opened packet. */
  UPPER: "CUT SIZE UPPER",
  /** Slippers made but never packed in a carton. */
  PAIRS: "CUT SIZE PAIRS",
} as const;
export type CutSizeKind = (typeof CUT_SIZE_KIND)[keyof typeof CUT_SIZE_KIND];

const PAIR_UNIT = "PAIR";
const CUT_SIZE_FIELD = "item";

// An upper line's ORIGINAL labels that have not come back: printed for its packets, not void, never
// produced. The highest serials first, so a partly returned run gives up its last labels.
const UNRETURNED_LINE_LABELS_SQL = `
  SELECT qc.id FROM qr_codes qc
  WHERE qc.batch_id IN (SELECT l.qr_batch_id FROM machine_program_carton_labels l
                         JOIN raw_material_qr_events rme ON rme.id = l.store_exit_event_id
                        WHERE l.program_id = ? AND rme.machine_program_upper_line_id = ?)
    AND qc.status <> 'VOID'
    AND NOT EXISTS (SELECT 1 FROM qr_master qm WHERE qm.qr_id = qc.id)
  ORDER BY qc.sequence DESC`;

// The same, for every upper line of the program at once.
const UNRETURNED_PROGRAM_LABELS_SQL = `
  SELECT qc.id FROM qr_codes qc
  WHERE qc.batch_id IN (SELECT l.qr_batch_id FROM machine_program_carton_labels l WHERE l.program_id = ?)
    AND qc.status <> 'VOID'
    AND NOT EXISTS (SELECT 1 FROM qr_master qm WHERE qm.qr_id = qc.id)
  ORDER BY qc.sequence DESC`;

/** One upper line's labels, as many cartons as were printed for its packets in all. */
const LINE_LABELLED_SQL = `
  SELECT COALESCE(SUM(l.carton_count), 0) AS n FROM machine_program_carton_labels l
  JOIN raw_material_qr_events rme ON rme.id = l.store_exit_event_id
  WHERE l.program_id = ? AND rme.machine_program_upper_line_id = ?`;

export interface UpperBConversion extends GeneratedQrBatch {
  voidedQrIds: string[];
}

export const machineProgramUpperReconciliationMethods = {
  /**
   * An upper line's original labels not back yet — at most what its own packets were printed,
   * less its own cartons back, so a run shared with another line never gives up that line's share.
   */
  unreturnedUpperLabelIds(this: SqliteDatabase, programId: string, lineId: string, originalsBack: number): string[] {
    const labelled = Number((this.db.prepare(LINE_LABELLED_SQL).get(programId, lineId) as { n: number }).n ?? 0);
    const owed = Math.max(0, labelled - originalsBack);
    const ids = (this.db.prepare(UNRETURNED_LINE_LABELS_SQL).all(programId, lineId) as Array<{ id: string }>).map((row) => row.id);
    return ids.slice(0, owed);
  },

  /**
   * Some of an upper line's missing cartons came off the machine in mixed colours: `count` of them
   * become B cartons.
   *
   *   every original label of the line that is not back is VOIDED (the owner's rule, 2026-10-13:
   *   5 expected, 2 come back as B → 2 MIX labels, and all 5 originals are cancelled)
   *   `count` new labels, MIX, grade B, are generated for the line's article and size
   *   Store In scans THOSE back on Carton In, and each one stored in is a carton back
   *
   * ONE transaction under the write lock. How many cartons are missing is worked out HERE, and the
   * labels voided are chosen here — never sent by the screen. Each original's replacement is kept
   * in machine_program_b_conversions, whose primary key refuses a label converted twice.
   */
  convertUpperCartonsToB(
    this: SqliteDatabase,
    input: { programId: string; lineId: string; count: number; convertedBy: string | null; deviceId: string }
  ): UpperBConversion {
    const programId = text(input.programId).trim();
    const lineId = text(input.lineId).trim();
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const { code, line } = this.upperLineForBConversion(programId, lineId);
      const missing = Math.max(0, (line.cartonsDue ?? 0) - line.cartonsBack - (line.bCartons - line.bBack));
      const problem = upperBConversionProblem(Number(input.count), missing);
      if (problem) throw new Error(problem);

      const voidedQrIds = this.unreturnedUpperLabelIds(programId, lineId, line.cartonsBack - line.bBack);
      for (const qrId of voidedQrIds) {
        this.voidQrCode({ qrId, reason: `Replaced by a B carton (${code})`, actor: input.convertedBy });
      }
      const generated = this.reserveQrBatchInTransaction({
        articleSizeId: line.articleSizeId,
        color: B_CARTON_COLOUR,
        quantity: Number(input.count),
        createdBy: input.convertedBy ?? undefined,
        requestedBy: code,
        grade: CARTON_GRADE.B,
        source: QR_BATCH_SOURCE.MACHINE_PROGRAM,
      });
      this.recordUpperBConversion({ ...input, programId, lineId, runId: line.runId, batchId: generated.batch.id, createdAt: generated.batch.createdAt, voidedQrIds });
      this.db.exec("COMMIT");
      return { ...generated, voidedQrIds };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }
  },

  /** @internal The program and upper line a B conversion is for, refused unless both are open. */
  upperLineForBConversion(
    this: SqliteDatabase,
    programId: string,
    lineId: string
  ): { code: string; line: { runId: string; articleSizeId: string; cartonsDue: number | null; cartonsBack: number; bCartons: number; bBack: number } } {
    const program = this.getMachineProgram(programId);
    if (!program) throw new Error("This machine program no longer exists.");
    if (this.isMachineProgramClosed(programId)) throw new Error(`${program.code} is closed — no more cartons are labelled for it.`);
    const run = program.runs.find((candidate) => candidate.lines.some((line) => line.id === lineId));
    if (!run || !run.articleSizeId) throw new Error("That upper is no longer on this program. Reload the program and try again.");
    const progress = this.listMachineProgramCartonProgress(programId).find((row) => row.lineId === lineId);
    if (!progress || progress.cartonsDue == null) throw new Error("This upper is not counted in whole cartons of DOZEN, so it cannot have B cartons.");
    return { code: program.code, line: { runId: run.id, articleSizeId: run.articleSizeId, ...progress } };
  },

  /** @internal Links a B run to its program and line, and records which original each B replaced. */
  recordUpperBConversion(
    this: SqliteDatabase,
    input: { programId: string; lineId: string; runId: string; batchId: string; count: number; voidedQrIds: string[]; convertedBy: string | null; deviceId: string; createdAt: string }
  ): void {
    this.db
      .prepare(
        `INSERT INTO machine_program_upper_b_labels (qr_batch_id, program_id, upper_line_id, carton_count, printed_by, device_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(input.batchId, input.programId, input.lineId, Number(input.count), input.convertedBy, input.deviceId, input.createdAt);
    const record = this.db.prepare(
      `INSERT INTO machine_program_b_conversions (original_qr_id, b_qr_batch_id, program_id, run_id, converted_by, device_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const qrId of input.voidedQrIds) {
      record.run(qrId, input.batchId, input.programId, input.runId, input.convertedBy, input.deviceId, input.createdAt);
    }
  },

  /**
   * On closing: every original upper label of the program still not back is voided, because no
   * carton can be stored in against a closed program — a label left usable would be a carton QR
   * with nothing behind it. FIX labels are not touched: EVR FIX closes only when all are back.
   */
  voidUnreturnedUpperLabels(this: SqliteDatabase, programId: string, code: string, actor: string): string[] {
    const ids = (this.db.prepare(UNRETURNED_PROGRAM_LABELS_SQL).all(programId) as Array<{ id: string }>).map((row) => row.id);
    for (const qrId of ids) this.voidQrCode({ qrId, reason: `Not back when ${code} was reconciled`, actor });
    return ids;
  },

  /** @internal The PAIR unit, made the first time cut size is received. */
  pairUnitId(this: SqliteDatabase): string {
    const unit = this.db.prepare("SELECT id FROM inventory_units WHERE UPPER(code) = ? LIMIT 1").get(PAIR_UNIT) as { id: string } | undefined;
    return unit?.id ?? this.createInventoryUnit({ code: PAIR_UNIT, name: "Pair", unitFamily: "COUNT" });
  },

  /** @internal The top-level category one kind of cut size is kept in, with the one field naming it. */
  cutSizeCategoryId(this: SqliteDatabase, kind: CutSizeKind): string {
    const found = this.db
      .prepare("SELECT id FROM inventory_categories WHERE UPPER(name) = ? AND parent_id IS NULL AND status = 'ACTIVE' LIMIT 1")
      .get(kind) as { id: string } | undefined;
    const categoryId = found?.id ?? this.createInventoryCategory({ name: kind, description: "Returned when a machine program was reconciled" });
    const field = this.db
      .prepare("SELECT 1 AS ok FROM inventory_category_fields WHERE category_id = ? AND field_key = ? AND is_active = 1")
      .get(categoryId, CUT_SIZE_FIELD);
    if (!field) this.addInventoryCategoryField({ categoryId, fieldKey: CUT_SIZE_FIELD, label: "ITEM", fieldType: "TEXT", required: true });
    return categoryId;
  },

  /**
   * Puts `pairs` of cut size back in the store: onto the raw material "<kind> <what>", counted in
   * pairs, made the first time it is needed. Assumes the caller's transaction.
   */
  receiveCutSize(this: SqliteDatabase, input: { kind: CutSizeKind; what: string; pairs: number; code: string; actor: string }): void {
    const unitId = this.pairUnitId();
    const item = this.insertInventoryItem({ categoryId: this.cutSizeCategoryId(input.kind), values: { [CUT_SIZE_FIELD]: input.what }, unitId, createdBy: input.actor });
    this.applyInventoryStockChange({
      itemId: item.id,
      quantity: input.pairs,
      eventType: "RECEIVE",
      unitId,
      note: `${STOCK_EVENT_NOTE.CUT_SIZE} — ${input.pairs} ${PAIR_UNIT} — ${input.code}`,
      createdBy: input.actor,
    });
  },

  /**
   * Posts one claim against a party: a numbered deduction that stands on their ledger from today.
   * Assumes the caller's transaction. The amount is worked out here from the pairs and the amount
   * a pair, and the table checks it again.
   */
  postPartyClaim(
    this: SqliteDatabase,
    input: { partyId: string; role: ClaimPartyRole; programId: string; lineId: string; itemId: string; pairs: number; ratePaisa: number; reason: string; actor: string }
  ): string {
    const next = this.db
      .prepare("SELECT COALESCE(MAX(CAST(SUBSTR(claim_number, 4) AS INTEGER)), 0) + 1 AS n FROM party_claims")
      .get() as { n: number };
    const claimNumber = `CL-${String(next.n).padStart(6, "0")}`;
    this.db
      .prepare(
        `INSERT INTO party_claims (id, claim_number, party_id, party_role, program_id, upper_line_id, item_id,
           quantity_pairs, rate_paisa, amount_paisa, reason, claim_date, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        crypto.randomUUID(), claimNumber, input.partyId, input.role, input.programId, input.lineId, input.itemId,
        input.pairs, input.ratePaisa, claimAmountPaisa(input), input.reason.trim(), this.localYmd(new Date()),
        PARTY_CLAIM_STATUS.POSTED, input.actor, new Date().toISOString()
      );
    return claimNumber;
  },
};

export type MachineProgramUpperReconciliationMethods = typeof machineProgramUpperReconciliationMethods;
