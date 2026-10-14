// Machine Move Out: the carton QR labels owed for the uppers a program has taken out.
//
//   MP-000008 · 2 DOZEN of SK12 BLACK RED out   →   4 carton QR labels   (1 DOZEN = 2 cartons)
//
//   "which packets still need their cartons labelled?"   listMachineProgramCartonPackets
//   "label these packets' cartons, exactly once"          printMachineProgramCartons
//   "which program was this carton label printed for?"   findMachineProgramOfCartonQr
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").
// `this` is the database instance.
//
// Both are read from the STORE_EXIT events themselves, so whatever the screen remembers, a
// packet issued in an earlier sitting or on another terminal is still owed its cartons — and one
// already labelled (machine_program_carton_labels, migration 068) is never offered again.

import type { SqliteDatabase } from "../sqliteDatabase.js";
import {
  cartonPlanFor,
  formatMachineProgramCodeNumber,
  type IssuedCartonPlan,
  type MachineProgramCartonOrigin,
  type TransactionContext,
} from "@erp/application";
import type { MutableTransactionContext } from "./shared.js";
import { B_CARTON_COLOUR, CARTON_GRADE, QR_BATCH_SOURCE, attributeKey, bConversionProblem, buildQrId, cartonsExpectedFromUppers, roundQuantity, type CartonGrade } from "@erp/domain";
import { COLOUR_SQL, LINE_CONSUMED_SQL } from "./machineProgramSql.js";
import type { GeneratedQrBatch } from "./qrCodes.js";

const text = (value: unknown): string => (value == null ? "" : String(value));

/** The carton QR run one packet was labelled in. */
export interface MachineProgramCartonLabel {
  qrBatchId: string;
  /** The run's first and last carton QR, e.g. `SK12_BLACKRED_7/10_000001` → `…_000008`. */
  firstQrId: string;
  lastQrId: string;
  /** How many of the run's cartons this packet accounts for. */
  cartonCount: number;
  /** How many of the WHOLE run's cartons have come back and been stored in so far. */
  receivedInRun: number;
  /** How many of the run's labels are void — on a FIX run, the ones converted to B cartons. */
  voidedInRun: number;
  /** The colour the run's labels carry — MIX on a B run. */
  colour: string;
  /** "B" on a run of B carton labels (migration 074), null on an ordinary run. */
  grade: CartonGrade | null;
  printedBy: string | null;
  printedAt: string;
}

/** One packet of uppers that left for a program, and the cartons it is owed back. */
export interface MachineProgramCartonPacket {
  /** The STORE_EXIT event — the issuance, which is what a carton label is owed to. */
  eventId: string;
  qrId: string;
  itemDisplayName: string;
  quantity: number;
  unitCode: string | null;
  issuedAt: string;
  cartons: IssuedCartonPlan | null;
  /** Why the cartons cannot be labelled here. Set only when `cartons` is null. */
  cartonNote: string | null;
  /** Null while the cartons are still owed. */
  label: MachineProgramCartonLabel | null;
}

/**
 * A FIX article's cartons (migration 071).
 *
 * An ordinary article's cartons are owed to an ISSUED PACKET of uppers. A fix article has no
 * upper, so nothing ever leaves the store for it and there is no packet to hang them on: what it
 * is owed is its PLAN — the dozens typed on the run, two cartons to the dozen — and it is owed
 * them from the moment the run is saved.
 */
export interface MachineProgramFixCartonRun {
  runId: string;
  articleSizeId: string;
  article: string;
  size: string;
  /** The OUTER sole: what the finished slipper is sold as, and what the carton QR carries. */
  outerSoleColour: string;
  /** The second sole, shown so the floor can tell two runs of one article apart. */
  innerSoleColour: string;
  /** What the run plans to make. */
  quantity: number;
  unitCode: string | null;
  /** The whole plan's cartons — 32 DOZEN is 64. Null when no carton figure can be said. */
  cartonsPlanned: number | null;
  /** Still to label: the plan minus what has already been printed. */
  cartonsToPrint: number;
  /** Why these cartons cannot be labelled here. Set only when cartonsPlanned is null. */
  cartonNote: string | null;
  /** The carton runs already printed for this fix run, newest last. */
  labels: MachineProgramCartonLabel[];
}

/** One upper line's cartons, as Store In counts them coming back. */
export interface MachineProgramLineCartons {
  lineId: string;
  /**
   * Cartons owed for what has been ISSUED of this upper so far — 3 DOZEN out is 6 cartons. Null
   * when the upper is not counted in whole cartons of DOZEN, so no carton figure can be said.
   */
  cartonsDue: number | null;
  /** Cartons of this line's printed labels that have been stored in — B cartons included. */
  cartonsBack: number;
  /** B carton labels printed for this line in its reconciliation, and how many are stored in. */
  bCartons: number;
  bBack: number;
}

export interface PrintedMachineProgramCartons extends GeneratedQrBatch {
  /** The packets these cartons were printed for. */
  eventIds: string[];
}

// How many of a printed run's cartons have been stored in: a STORE_ENTRY (written to
// production_events as MOVED, see database/store.ts) for any QR of the run. `l` is the label row.
const RECEIVED_IN_RUN_SQL = `(SELECT COUNT(*) FROM qr_codes qc
    WHERE l.qr_batch_id IS NOT NULL AND qc.batch_id = l.qr_batch_id
      AND EXISTS (SELECT 1 FROM production_events pe
                  WHERE pe.qr_id = qc.id AND pe.event_type = 'MOVED'
                    AND json_extract(pe.metadata_json, '$.eventType') = 'STORE_ENTRY'))`;

// An upper line's B carton runs (migration 076), each with how many of its cartons are stored in.
const UPPER_B_LABELS_SQL = `
  SELECT l.qr_batch_id, l.carton_count, l.upper_line_id AS line_id, ${RECEIVED_IN_RUN_SQL} AS received_in_run
  FROM machine_program_upper_b_labels l
  WHERE l.program_id = ?
  ORDER BY l.created_at, l.rowid`;

// How many of a printed run's labels are void — on a FIX run, the ones turned into B cartons.
const VOIDED_IN_RUN_SQL = `(SELECT COUNT(*) FROM qr_codes qv
    WHERE l.qr_batch_id IS NOT NULL AND qv.batch_id = l.qr_batch_id AND qv.status = 'VOID')`;

// A FIX run's labels that were printed and have NOT come back — the only ones that can become B
// cartons. Never produced (no qr_master row: Carton In produces and stores in together), not
// void, not converted already, and on an ordinary run (a B label is not converted again). The
// highest serials first, so converting fewer than all of them takes the last labels printed.
const CONVERTIBLE_FIX_LABELS_SQL = `
  SELECT qc.id FROM machine_program_fix_carton_labels l
  JOIN qr_batches qb ON qb.id = l.qr_batch_id AND qb.grade IS NULL
  JOIN qr_codes qc ON qc.batch_id = qb.id
  WHERE l.program_id = ? AND l.run_id = ? AND qc.status <> 'VOID'
    AND NOT EXISTS (SELECT 1 FROM qr_master qm WHERE qm.qr_id = qc.id)
    AND NOT EXISTS (SELECT 1 FROM machine_program_b_conversions c WHERE c.original_qr_id = qc.id)
  ORDER BY qc.sequence DESC`;

// Every upper issued against the program — through Machine Move Out or the generic store
// scanner, both of which stamp the program line on the event. A packet that has since come back
// to the store (a STORE_ENTRY carrying the same line stamp) owes no cartons, unless they were
// already printed, in which case the record of that print stays on screen.
const CARTON_PACKETS_SQL = `
  SELECT rme.id AS event_id, rme.qr_id, rme.item_display_name, rme.quantity, rme.event_ts_local,
         u.code AS unit_code, mpr.sole_colour, ${COLOUR_SQL} AS upper_colour,
         asz.id AS article_size_id, asz.article, asz.size,
         l.qr_batch_id, l.carton_count AS labelled_cartons, l.printed_by, l.created_at AS labelled_at,
         qb.article AS qb_article, qb.color AS qb_color, qb.size AS qb_size, qb.start_sequence, qb.end_sequence, qb.grade AS qb_grade,
         ${VOIDED_IN_RUN_SQL} AS voided_in_run,
         ${RECEIVED_IN_RUN_SQL} AS received_in_run
  FROM raw_material_qr_events rme
  JOIN machine_program_upper_lines mul ON mul.id = rme.machine_program_upper_line_id
  JOIN machine_program_runs mpr ON mpr.id = mul.run_id
  JOIN inventory_items ii ON ii.id = mul.item_id
  LEFT JOIN inventory_units u ON u.id = mul.unit_id
  LEFT JOIN article_sizes asz ON asz.id = mpr.article_size_id AND asz.deleted_at IS NULL
  LEFT JOIN machine_program_carton_labels l ON l.store_exit_event_id = rme.id
  LEFT JOIN qr_batches qb ON qb.id = l.qr_batch_id
  WHERE mpr.program_id = ? AND rme.event_type = 'STORE_EXIT'
    AND (l.store_exit_event_id IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM raw_material_qr_events back
      WHERE back.event_type = 'STORE_ENTRY' AND back.qr_id = rme.qr_id
        AND back.machine_program_upper_line_id = rme.machine_program_upper_line_id
        AND back.rowid > rme.rowid))
  ORDER BY rme.event_ts_local ASC, rme.rowid ASC`;

// Every FIX run of a program, with the cartons its plan owes and whatever has been printed
// against it so far. A fix run is marked by its inner sole (migration 067) — the article has no
// upper at all, so there is nothing here to join to a packet or a store event.
const FIX_CARTON_RUNS_SQL = `
  SELECT mpr.id AS run_id, mpr.sole_colour, mpr.inner_sole_colour, mpr.quantity,
         u.code AS unit_code, asz.id AS article_size_id, asz.article, asz.size,
         -- B runs REPLACE labels already printed, so they never count toward the plan (migration 074).
         (SELECT COALESCE(SUM(l.carton_count), 0) FROM machine_program_fix_carton_labels l
           JOIN qr_batches qb ON qb.id = l.qr_batch_id AND qb.grade IS NULL
           WHERE l.run_id = mpr.id) AS printed_cartons
  FROM machine_program_runs mpr
  LEFT JOIN inventory_units u ON u.id = mpr.unit_id
  LEFT JOIN article_sizes asz ON asz.id = mpr.article_size_id AND asz.deleted_at IS NULL
  WHERE mpr.program_id = ? AND mpr.inner_sole_colour IS NOT NULL
  ORDER BY mpr.injector_no IS NULL, mpr.injector_no, mpr.run_no`;

// The printed runs of one fix run, with how many of each run's cartons are back in the store.
const FIX_CARTON_LABELS_SQL = `
  SELECT l.run_id, l.qr_batch_id, l.carton_count AS labelled_cartons, l.printed_by,
         l.created_at AS labelled_at,
         qb.article AS qb_article, qb.color AS qb_color, qb.size AS qb_size,
         qb.start_sequence, qb.end_sequence, qb.grade AS qb_grade,
         ${VOIDED_IN_RUN_SQL} AS voided_in_run,
         ${RECEIVED_IN_RUN_SQL} AS received_in_run
  FROM machine_program_fix_carton_labels l
  JOIN qr_batches qb ON qb.id = l.qr_batch_id
  WHERE l.program_id = ?
  ORDER BY l.created_at, l.rowid`;

const labelOf = (row: Record<string, unknown>): MachineProgramCartonLabel | null => {
  if (!row.qr_batch_id) return null;
  const identity = { article: text(row.qb_article), color: text(row.qb_color), size: text(row.qb_size) };
  return {
    qrBatchId: text(row.qr_batch_id),
    firstQrId: buildQrId({ ...identity, sequence: Number(row.start_sequence ?? 0) }),
    lastQrId: buildQrId({ ...identity, sequence: Number(row.end_sequence ?? 0) }),
    cartonCount: Number(row.labelled_cartons ?? 0),
    receivedInRun: Number(row.received_in_run ?? 0),
    voidedInRun: Number(row.voided_in_run ?? 0),
    colour: identity.color,
    grade: text(row.qb_grade) === CARTON_GRADE.B ? CARTON_GRADE.B : null,
    printedBy: row.printed_by ? text(row.printed_by) : null,
    printedAt: text(row.labelled_at),
  };
};

const mapCartonPacket = (row: Record<string, unknown>): MachineProgramCartonPacket => {
  const quantity = roundQuantity(Number(row.quantity ?? 0));
  const unitCode = row.unit_code ? text(row.unit_code) : null;
  // The same rule the scan itself used, so a packet offers the same cartons whenever it is read.
  const plan = cartonPlanFor({
    name: text(row.item_display_name),
    target: row.article_size_id
      ? {
          articleSizeId: text(row.article_size_id),
          article: text(row.article),
          size: text(row.size),
          soleColour: attributeKey(text(row.sole_colour)),
          upperColour: attributeKey(text(row.upper_colour)),
        }
      : null,
    cartonCount: cartonsExpectedFromUppers(quantity, unitCode),
  });
  return {
    eventId: text(row.event_id),
    qrId: text(row.qr_id),
    itemDisplayName: text(row.item_display_name),
    quantity,
    unitCode,
    issuedAt: text(row.event_ts_local),
    ...plan,
    label: labelOf(row),
  };
};

/**
 * The one carton run the chosen packets make, or an Error saying why they cannot be printed.
 *
 * Every chosen packet must be on the program, still unlabelled, have a carton plan, and share
 * one product and colour — a carton QR run is one identity, so two products are two runs.
 */
const cartonRunOf = (
  packets: MachineProgramCartonPacket[],
  eventIds: string[]
): { plan: IssuedCartonPlan; packets: MachineProgramCartonPacket[] } => {
  const chosen = packets.filter((packet) => eventIds.includes(packet.eventId));
  if (chosen.length !== eventIds.length) {
    throw new Error("Some of these packets are no longer out for this program. Reload the program and try again.");
  }
  const labelled = chosen.find((packet) => packet.label);
  if (labelled?.label) {
    throw new Error(
      `The cartons for ${labelled.itemDisplayName} were already printed (${labelled.label.firstQrId} → ${labelled.label.lastQrId}). Reprint them from QR Management.`
    );
  }
  const unplanned = chosen.find((packet) => !packet.cartons);
  if (unplanned) throw new Error(unplanned.cartonNote ?? "These cartons cannot be labelled here.");

  const plan = chosen[0].cartons!;
  const mixed = chosen.some(
    (packet) => packet.cartons!.articleSizeId !== plan.articleSizeId || packet.cartons!.colour !== plan.colour
  );
  if (mixed) throw new Error("Print one product and colour at a time.");
  return { plan, packets: chosen };
};

/**
 * Shares each printed run's stored-in cartons out over the packets it was printed for, in the
 * order they were labelled. A run's labels are one product and colour and go onto whichever
 * carton comes off the machine, so there is no carton-to-packet fact to read — this fixed order is
 * the rule, and it can never count one carton twice or more cartons than a packet was owed.
 */
const backBy = (rows: Array<Record<string, unknown>>, column: "line_id" | "event_id"): Map<string, number> => {
  const left = new Map<string, number>();
  const back = new Map<string, number>();
  for (const row of rows) {
    const batch = text(row.qr_batch_id);
    if (!left.has(batch)) left.set(batch, Number(row.received_in_run ?? 0));
    const take = Math.min(left.get(batch)!, Number(row.carton_count ?? 0));
    left.set(batch, left.get(batch)! - take);
    const key = text(row[column]);
    back.set(key, (back.get(key) ?? 0) + take);
  }
  return back;
};

// Every label row of a program, in the order it was printed, with its run's stored-in count.
const PROGRAM_LABEL_ROWS_SQL = `
  SELECT l.qr_batch_id, l.carton_count, l.store_exit_event_id AS event_id,
         rme.machine_program_upper_line_id AS line_id, ${RECEIVED_IN_RUN_SQL} AS received_in_run
    FROM machine_program_carton_labels l
    JOIN raw_material_qr_events rme ON rme.id = l.store_exit_event_id
   WHERE l.program_id = ?
   ORDER BY l.rowid`;

/**
 * Why a FIX run's cartons cannot be labelled here, or null.
 *
 * The same three refusals an upper's cartons get (cartonPlanFor), said for an article that has
 * no upper: no product left in the master, no colour to put on the identity, or a quantity that
 * is not a whole number of cartons. A carton QR is a permanent identity, so a figure that had to
 * be guessed at is refused rather than rounded.
 */
const fixCartonNote = (run: {
  article: string;
  size: string;
  articleSizeId: string;
  outerSoleColour: string;
  planned: number | null;
}): string | null => {
  const what = `${run.article} ${run.size}`.trim() || "this article";
  if (!run.articleSizeId) return `This program line has no product left in Product Master, so cartons for ${what} cannot be labelled here.`;
  if (!run.outerSoleColour) return `${what} has no outer sole colour on it, and a carton QR needs one.`;
  if (run.planned == null) return `${what} is not planned in whole cartons of DOZEN, so its cartons have to be generated in QR Generator.`;
  return null;
};

export const machineProgramCartonsMethods = {
  /**
   * Store In's figures for a program, per upper line: the cartons owed back for what has been
   * issued, and how many of them are back in the store.
   */
  /**
   * How many of the cartons printed for a packet's last issue are already stored in — by the same
   * print-order rule the line figures use. 0 for a packet whose cartons were never printed.
   */
  cartonsBackOfIssuedPacket(this: SqliteDatabase, qrId: string, tx: TransactionContext): number {
    const db = (tx as MutableTransactionContext).db;
    const label = db
      .prepare(
        `SELECT l.program_id, l.store_exit_event_id FROM machine_program_carton_labels l
          WHERE l.store_exit_event_id = (SELECT rme.id FROM raw_material_qr_events rme
                                          WHERE rme.qr_id = ? AND rme.event_type = 'STORE_EXIT'
                                          ORDER BY rme.event_ts_local DESC, rme.created_at DESC LIMIT 1)`
      )
      .get(text(qrId).trim().toUpperCase()) as { program_id: string; store_exit_event_id: string } | undefined;
    if (!label) return 0;
    const rows = db.prepare(PROGRAM_LABEL_ROWS_SQL).all(label.program_id) as Array<Record<string, unknown>>;
    return backBy(rows, "event_id").get(label.store_exit_event_id) ?? 0;
  },

  listMachineProgramCartonProgress(this: SqliteDatabase, programId: string): MachineProgramLineCartons[] {
    const id = text(programId).trim();
    const lines = this.db
      .prepare(
        `SELECT mul.id, u.code AS unit_code, ${LINE_CONSUMED_SQL} AS consumed
           FROM machine_program_upper_lines mul
           JOIN machine_program_runs mpr ON mpr.id = mul.run_id
           LEFT JOIN inventory_units u ON u.id = mul.unit_id
          WHERE mpr.program_id = ?`
      )
      .all(id) as Array<Record<string, unknown>>;
    const labels = this.db.prepare(PROGRAM_LABEL_ROWS_SQL).all(id) as Array<Record<string, unknown>>;
    const back = backBy(labels, "line_id");
    // A B carton is one of the line's cartons, labelled again as MIX: once stored in, it is back.
    const bRuns = this.db.prepare(UPPER_B_LABELS_SQL).all(id) as Array<Record<string, unknown>>;
    const sumFor = (lineId: string, column: string): number =>
      bRuns.filter((row) => text(row.line_id) === lineId).reduce((total, row) => total + Number(row[column] ?? 0), 0);
    return lines.map((line) => {
      const lineId = text(line.id);
      const consumed = roundQuantity(Math.max(0, Number(line.consumed ?? 0)));
      const bBack = sumFor(lineId, "received_in_run");
      return {
        lineId,
        cartonsDue: consumed > 0 ? cartonsExpectedFromUppers(consumed, line.unit_code ? text(line.unit_code) : null) : 0,
        cartonsBack: (back.get(lineId) ?? 0) + bBack,
        bCartons: sumFor(lineId, "carton_count"),
        bBack,
      };
    });
  },


  /**
   * The machine program a carton QR was printed for, or null when it was not printed through
   * Machine Move Out (an ordinary QR Generator run). Read through the label rows, so the answer
   * is fixed the moment the label is printed and can never drift.
   */
  async findMachineProgramOfCartonQr(
    this: SqliteDatabase,
    qrId: string,
    tx: TransactionContext
  ): Promise<MachineProgramCartonOrigin | null> {
    // Every label table: an upper's cartons hang off its issued packet (068), a FIX article's off
    // its run (071), and an upper line's B cartons off the line (076) — a carton coming back is
    // the same carton whichever printed it.
    const row = (tx as MutableTransactionContext).db
      .prepare(
        `SELECT mp.id, mp.program_number,
                EXISTS (SELECT 1 FROM machine_program_closures c WHERE c.program_id = mp.id) AS closed
         FROM qr_codes qc
         JOIN machine_programs mp ON mp.id = (
           SELECT l.program_id FROM machine_program_carton_labels l WHERE l.qr_batch_id = qc.batch_id
           UNION ALL
           SELECT f.program_id FROM machine_program_fix_carton_labels f WHERE f.qr_batch_id = qc.batch_id
           UNION ALL
           SELECT b.program_id FROM machine_program_upper_b_labels b WHERE b.qr_batch_id = qc.batch_id
           LIMIT 1
         )
         WHERE qc.id = ? LIMIT 1`
      )
      .get(text(qrId).trim()) as { id: string; program_number: number; closed: number } | undefined;
    return row ? { programId: row.id, programNumber: Number(row.program_number), closed: Boolean(row.closed) } : null;
  },

  /**
   * Every FIX run of a program and the cartons it is owed — the second half of "what cartons
   * does this program need labelled", for the articles that have no upper to issue.
   *
   * The figure is the PLAN, never an issuance: 32 DOZEN of DC3 is 64 cartons, ready the moment
   * the run is saved. What has already been printed is taken off, so raising the quantity later
   * offers only the difference and a run printed in full offers nothing.
   */
  listMachineProgramFixCartonRuns(this: SqliteDatabase, programId: string): MachineProgramFixCartonRun[] {
    const id = text(programId).trim();
    const rows = this.db.prepare(FIX_CARTON_RUNS_SQL).all(id) as Array<Record<string, unknown>>;
    if (rows.length === 0) return [];

    const labelRows = this.db.prepare(FIX_CARTON_LABELS_SQL).all(id) as Array<Record<string, unknown>>;
    const labelsByRun = new Map<string, MachineProgramCartonLabel[]>();
    for (const row of labelRows) {
      const label = labelOf(row);
      if (!label) continue;
      const runId = text(row.run_id);
      labelsByRun.set(runId, [...(labelsByRun.get(runId) ?? []), label]);
    }

    return rows.map((row) => {
      const quantity = roundQuantity(Number(row.quantity ?? 0));
      const unitCode = row.unit_code ? text(row.unit_code) : null;
      const article = text(row.article);
      const size = text(row.size);
      const outerSoleColour = attributeKey(text(row.sole_colour));
      // The same dozens-to-cartons rule every other carton on the program follows.
      const planned = row.article_size_id && outerSoleColour ? cartonsExpectedFromUppers(quantity, unitCode) : null;
      const printed = Number(row.printed_cartons ?? 0);
      return {
        runId: text(row.run_id),
        articleSizeId: text(row.article_size_id),
        article,
        size,
        outerSoleColour,
        innerSoleColour: attributeKey(text(row.inner_sole_colour)),
        quantity,
        unitCode,
        cartonsPlanned: planned,
        cartonsToPrint: planned == null ? 0 : Math.max(0, planned - printed),
        cartonNote: fixCartonNote({ article, size, articleSizeId: text(row.article_size_id), outerSoleColour, planned }),
        labels: labelsByRun.get(text(row.run_id)) ?? [],
      };
    });
  },

  /**
   * Generates the carton QR labels a FIX run still owes, and records the print — in ONE
   * transaction, so a run of carton identities never exists without the row that says which fix
   * run justified it.
   *
   * The count is worked out here, inside the write lock, from the run's plan minus what is
   * already printed. Nothing comes from the screen but which run to print, so two terminals
   * asking at the same moment cannot between them print more cartons than the program plans.
   */
  printMachineProgramFixCartons(
    this: SqliteDatabase,
    input: { programId: string; runId: string; printedBy: string | null; deviceId: string }
  ): PrintedMachineProgramCartons {
    const programId = text(input.programId).trim();
    const runId = text(input.runId).trim();
    if (!runId) throw new Error("Choose the article to print cartons for.");

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const program = this.db.prepare("SELECT program_number FROM machine_programs WHERE id = ? LIMIT 1").get(programId) as
        | { program_number: number }
        | undefined;
      if (!program) throw new Error("This machine program no longer exists.");
      if (this.isMachineProgramClosed(programId)) {
        throw new Error(`${formatMachineProgramCodeNumber(Number(program.program_number))} is closed — no more carton labels are printed for it.`);
      }

      const run = this.listMachineProgramFixCartonRuns(programId).find((candidate) => candidate.runId === runId);
      if (!run) throw new Error("That article is no longer on this program. Reload the program and try again.");
      if (run.cartonNote) throw new Error(run.cartonNote);
      if (run.cartonsToPrint <= 0) {
        throw new Error(
          `Every carton ${run.article} ${run.size} plans has already been labelled. Reprint them from QR Management.`
        );
      }

      const generated = this.reserveQrBatchInTransaction({
        articleSizeId: run.articleSizeId,
        // A fix article has no upper: the colour the carton is sold as is its OUTER sole.
        color: run.outerSoleColour,
        quantity: run.cartonsToPrint,
        createdBy: input.printedBy ?? undefined,
        requestedBy: formatMachineProgramCodeNumber(Number(program.program_number)),
        source: QR_BATCH_SOURCE.MACHINE_PROGRAM,
      });

      this.db
        .prepare(
          `INSERT INTO machine_program_fix_carton_labels
             (run_id, qr_batch_id, program_id, carton_count, printed_by, device_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(runId, generated.batch.id, programId, run.cartonsToPrint, input.printedBy, input.deviceId, generated.batch.createdAt);

      this.db.exec("COMMIT");
      return { ...generated, eventIds: [] };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }
  },

  /** How many of a FIX run's printed labels have not come back — the most that can become B. */
  countConvertibleFixLabels(this: SqliteDatabase, programId: string, runId: string): number {
    return (this.db.prepare(CONVERTIBLE_FIX_LABELS_SQL).all(text(programId).trim(), text(runId).trim()) as unknown[]).length;
  },

  /**
   * Turns `count` of a FIX run's labels that did not come back into B cartons (migration 074):
   *
   *   the labels not back are VOIDED  →  as many new labels, MIX, grade B, are generated for the
   *   same article and size and linked to the same run  →  Store In scans THOSE back
   *
   * ONE transaction under the write lock: the voids, the new run, its link to the program and the
   * record of which label became B all land together or not at all. The labels converted are
   * chosen HERE from the database — never sent by the screen — and the conversion record's
   * primary key refuses a label converted twice, whichever terminal asks.
   */
  convertFixCartonsToB(
    this: SqliteDatabase,
    input: { programId: string; runId: string; count: number; convertedBy: string | null; deviceId: string }
  ): PrintedMachineProgramCartons & { voidedQrIds: string[] } {
    const programId = text(input.programId).trim();
    const runId = text(input.runId).trim();
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const { code, articleSizeId } = this.fixRunForBConversion(programId, runId);
      const convertible = (this.db.prepare(CONVERTIBLE_FIX_LABELS_SQL).all(programId, runId) as Array<{ id: string }>).map((row) => row.id);
      const problem = bConversionProblem(Number(input.count), convertible.length);
      if (problem) throw new Error(problem);

      const voidedQrIds = convertible.slice(0, Number(input.count));
      for (const qrId of voidedQrIds) {
        this.voidQrCode({ qrId, reason: `Converted to a B carton (${code})`, actor: input.convertedBy });
      }
      const generated = this.reserveQrBatchInTransaction({
        articleSizeId,
        color: B_CARTON_COLOUR,
        quantity: voidedQrIds.length,
        createdBy: input.convertedBy ?? undefined,
        requestedBy: code,
        grade: CARTON_GRADE.B,
        source: QR_BATCH_SOURCE.MACHINE_PROGRAM,
      });
      this.recordBConversion({ ...input, programId, runId, batchId: generated.batch.id, createdAt: generated.batch.createdAt, voidedQrIds });
      this.db.exec("COMMIT");
      return { ...generated, eventIds: [], voidedQrIds };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }
  },

  /** @internal The program and FIX run a B conversion is for, refused unless both are open. */
  fixRunForBConversion(this: SqliteDatabase, programId: string, runId: string): { code: string; articleSizeId: string } {
    const program = this.db.prepare("SELECT program_number FROM machine_programs WHERE id = ? LIMIT 1").get(programId) as
      | { program_number: number }
      | undefined;
    if (!program) throw new Error("This machine program no longer exists.");
    const code = formatMachineProgramCodeNumber(Number(program.program_number));
    if (this.isMachineProgramClosed(programId)) throw new Error(`${code} is closed — no more cartons are labelled for it.`);
    const run = this.listMachineProgramFixCartonRuns(programId).find((candidate) => candidate.runId === runId);
    if (!run || !run.articleSizeId) throw new Error("That article is no longer on this program. Reload the program and try again.");
    return { code, articleSizeId: run.articleSizeId };
  },

  /** @internal Links a B run to its program and FIX run, and records which label became B. */
  recordBConversion(
    this: SqliteDatabase,
    input: { programId: string; runId: string; batchId: string; voidedQrIds: string[]; convertedBy: string | null; deviceId: string; createdAt: string }
  ): void {
    this.db
      .prepare(
        `INSERT INTO machine_program_fix_carton_labels (run_id, qr_batch_id, program_id, carton_count, printed_by, device_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(input.runId, input.batchId, input.programId, input.voidedQrIds.length, input.convertedBy, input.deviceId, input.createdAt);
    const record = this.db.prepare(
      `INSERT INTO machine_program_b_conversions (original_qr_id, b_qr_batch_id, program_id, run_id, converted_by, device_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const qrId of input.voidedQrIds) {
      record.run(qrId, input.batchId, input.programId, input.runId, input.convertedBy, input.deviceId, input.createdAt);
    }
  },

  /** Every packet of uppers out for a program, oldest first, with the cartons it is owed. */
  listMachineProgramCartonPackets(this: SqliteDatabase, programId: string): MachineProgramCartonPacket[] {
    const rows = this.db.prepare(CARTON_PACKETS_SQL).all(text(programId).trim()) as Array<Record<string, unknown>>;
    return rows.map(mapCartonPacket);
  },

  /**
   * Generates the carton QR labels for the chosen packets and records them as labelled — in ONE
   * transaction, so a run of carton identities never exists without the packets it was printed
   * for. The count is worked out here from the packets themselves, never taken from the screen.
   *
   * Exactly once: the packets are re-read inside the write lock, and the PRIMARY KEY on
   * store_exit_event_id refuses a second label for the same issuance even if two terminals ask
   * at the same moment.
   */
  printMachineProgramCartons(
    this: SqliteDatabase,
    input: { programId: string; eventIds: string[]; printedBy: string | null; deviceId: string }
  ): PrintedMachineProgramCartons {
    const programId = text(input.programId).trim();
    const eventIds = [...new Set(input.eventIds.map((id) => text(id).trim()).filter(Boolean))];
    if (eventIds.length === 0) throw new Error("Choose the cartons to print.");

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const program = this.db.prepare("SELECT program_number FROM machine_programs WHERE id = ? LIMIT 1").get(programId) as
        | { program_number: number }
        | undefined;
      if (!program) throw new Error("This machine program no longer exists.");
      if (this.isMachineProgramClosed(programId)) {
        throw new Error(`${formatMachineProgramCodeNumber(Number(program.program_number))} is closed — no more carton labels are printed for it.`);
      }

      const run = cartonRunOf(this.listMachineProgramCartonPackets(programId), eventIds);
      const generated = this.reserveQrBatchInTransaction({
        articleSizeId: run.plan.articleSizeId,
        color: run.plan.colour,
        quantity: run.packets.reduce((total, packet) => total + packet.cartons!.count, 0),
        createdBy: input.printedBy ?? undefined,
        requestedBy: formatMachineProgramCodeNumber(Number(program.program_number)),
        source: QR_BATCH_SOURCE.MACHINE_PROGRAM,
      });

      const insertLabel = this.db.prepare(
        `INSERT INTO machine_program_carton_labels
           (store_exit_event_id, program_id, qr_batch_id, carton_count, printed_by, device_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const packet of run.packets) {
        insertLabel.run(
          packet.eventId, programId, generated.batch.id, packet.cartons!.count,
          input.printedBy, input.deviceId, generated.batch.createdAt
        );
      }

      this.db.exec("COMMIT");
      return { ...generated, eventIds };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }
  },
};

export type MachineProgramCartonsMethods = typeof machineProgramCartonsMethods;
