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
import { attributeKey, buildQrId, cartonsExpectedFromUppers, roundQuantity } from "@erp/domain";
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

/** One upper line's cartons, as Store In counts them coming back. */
export interface MachineProgramLineCartons {
  lineId: string;
  /**
   * Cartons owed for what has been ISSUED of this upper so far — 3 DOZEN out is 6 cartons. Null
   * when the upper is not counted in whole cartons of DOZEN, so no carton figure can be said.
   */
  cartonsDue: number | null;
  /** Cartons of this line's printed labels that have been stored in. */
  cartonsBack: number;
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

// Every upper issued against the program — through Machine Move Out or the generic store
// scanner, both of which stamp the program line on the event. A packet that has since come back
// to the store (a STORE_ENTRY carrying the same line stamp) owes no cartons, unless they were
// already printed, in which case the record of that print stays on screen.
const CARTON_PACKETS_SQL = `
  SELECT rme.id AS event_id, rme.qr_id, rme.item_display_name, rme.quantity, rme.event_ts_local,
         u.code AS unit_code, mpr.sole_colour, ${COLOUR_SQL} AS upper_colour,
         asz.id AS article_size_id, asz.article, asz.size,
         l.qr_batch_id, l.carton_count AS labelled_cartons, l.printed_by, l.created_at AS labelled_at,
         qb.article AS qb_article, qb.color AS qb_color, qb.size AS qb_size, qb.start_sequence, qb.end_sequence,
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

const labelOf = (row: Record<string, unknown>): MachineProgramCartonLabel | null => {
  if (!row.qr_batch_id) return null;
  const identity = { article: text(row.qb_article), color: text(row.qb_color), size: text(row.qb_size) };
  return {
    qrBatchId: text(row.qr_batch_id),
    firstQrId: buildQrId({ ...identity, sequence: Number(row.start_sequence ?? 0) }),
    lastQrId: buildQrId({ ...identity, sequence: Number(row.end_sequence ?? 0) }),
    cartonCount: Number(row.labelled_cartons ?? 0),
    receivedInRun: Number(row.received_in_run ?? 0),
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
const backByLine = (rows: Array<Record<string, unknown>>): Map<string, number> => {
  const left = new Map<string, number>();
  const back = new Map<string, number>();
  for (const row of rows) {
    const batch = text(row.qr_batch_id);
    if (!left.has(batch)) left.set(batch, Number(row.received_in_run ?? 0));
    const take = Math.min(left.get(batch)!, Number(row.carton_count ?? 0));
    left.set(batch, left.get(batch)! - take);
    const line = text(row.line_id);
    back.set(line, (back.get(line) ?? 0) + take);
  }
  return back;
};

export const machineProgramCartonsMethods = {
  /**
   * Store In's figures for a program, per upper line: the cartons owed back for what has been
   * issued, and how many of them are back in the store.
   */
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
    // Every label row of the program, in the order it was printed, with its run's stored-in count.
    const labels = this.db
      .prepare(
        `SELECT l.qr_batch_id, l.carton_count, rme.machine_program_upper_line_id AS line_id,
                ${RECEIVED_IN_RUN_SQL} AS received_in_run
           FROM machine_program_carton_labels l
           JOIN raw_material_qr_events rme ON rme.id = l.store_exit_event_id
          WHERE l.program_id = ?
          ORDER BY l.rowid`
      )
      .all(id) as Array<Record<string, unknown>>;
    const back = backByLine(labels);
    return lines.map((line) => {
      const consumed = roundQuantity(Math.max(0, Number(line.consumed ?? 0)));
      return {
        lineId: text(line.id),
        cartonsDue: consumed > 0 ? cartonsExpectedFromUppers(consumed, line.unit_code ? text(line.unit_code) : null) : 0,
        cartonsBack: back.get(text(line.id)) ?? 0,
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
    const row = (tx as MutableTransactionContext).db
      .prepare(
        `SELECT mp.id, mp.program_number,
                EXISTS (SELECT 1 FROM machine_program_closures c WHERE c.program_id = mp.id) AS closed
         FROM qr_codes qc
         JOIN machine_program_carton_labels l ON l.qr_batch_id = qc.batch_id
         JOIN machine_programs mp ON mp.id = l.program_id
         WHERE qc.id = ? LIMIT 1`
      )
      .get(text(qrId).trim()) as { id: string; program_number: number; closed: number } | undefined;
    return row ? { programId: row.id, programNumber: Number(row.program_number), closed: Boolean(row.closed) } : null;
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
