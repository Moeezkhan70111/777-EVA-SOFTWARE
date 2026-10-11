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
// already labelled (machine_program_carton_labels, migration 066) is never offered again.

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
import { COLOUR_SQL } from "./machineProgramSql.js";
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

export const machineProgramCartonsMethods = {
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
        `SELECT mp.id, mp.program_number
         FROM qr_codes qc
         JOIN machine_program_carton_labels l ON l.qr_batch_id = qc.batch_id
         JOIN machine_programs mp ON mp.id = l.program_id
         WHERE qc.id = ? LIMIT 1`
      )
      .get(text(qrId).trim()) as { id: string; program_number: number } | undefined;
    return row ? { programId: row.id, programNumber: Number(row.program_number) } : null;
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
