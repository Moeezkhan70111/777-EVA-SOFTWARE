// Raw Material QR Generator: registry of QR identities generated for raw material
// received from a supplier (party + raw material item). Mirrors the finished-goods QR
// generator in ./qrCodes.ts, but keyed by (party, item) instead of (article, color, size) —
// see packages/domain/src/rawMaterialQr.ts for the identity format.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").
// `this` is the database instance.

import type { SqliteDatabase } from "../sqliteDatabase.js";
import { MAX_RAW_MATERIAL_QR_BATCH_QUANTITY } from "./types.js";
import type {
  QrDetail,
  RawMaterialQrLabel,
  QrJourney,
  QrJourneyStep,
  QrJourneyStepKind,
  QrPlace,
  QrSearchRow,
  QrStage,
  RawMaterialMovementRecord,
  RawMaterialQrBatchRecord,
  RawMaterialQrRecord,
  RawMaterialIssueSession,
  RawMaterialIssueSessionSummary,
  RawMaterialReceivingSession,
  RawMaterialReceivingSessionSummary,
} from "./types.js";
import type { MutableTransactionContext } from "./shared.js";
import { EFFECTIVE_PACK_NAME_SQL } from "./shared.js";
import type { TransactionContext } from "@erp/application";
import {
  RAW_MATERIAL_KIND,
  RAW_MATERIAL_QR_STATUS,
  buildRawMaterialQrId,
} from "@erp/domain";
import { KIND_JOINS, KIND_SQL } from "./machineProgramSql.js";
import { allocateNumberInRange, requireSerialRange, reserveSerialRange } from "./numberRange.js";
import {
  enqueueRawMaterialQr,
  enqueueRawMaterialQrBatch,
  rawMaterialQrBatchDedupeKeys,
  withdrawUnsentSyncEvents,
} from "./syncEvents.js";

export const rawMaterialQrMethods = {
  /**
   * Reserves the next N serials for a party+item combination and permanently records each
   * QR identity. Follows the exact same concurrency/uniqueness guarantees as
   * generateQrBatch: the reservation runs inside BEGIN IMMEDIATE, the counter is
   * advanced with an atomic UPSERT, and `raw_material_qrs.id` (the QR value itself) is the
   * table's PRIMARY KEY.
   */
  generateRawMaterialQrBatch(this: SqliteDatabase, input: {
    partyId: string;
    itemId: string;
    quantity: number;
    /**
     * What one packet in this run holds, in the material's stock unit — typed by the operator
     * for every run, because the same material arrives 5 DOZEN to a packet one day and 3 the next.
     */
    packingQuantity: number;
    createdBy?: string;
    requestedBy?: string;
  }): {
    batch: RawMaterialQrBatchRecord;
    qrCodes: RawMaterialQrRecord[];
  } {
    const rawQuantity = Number(input.quantity);
    if (!Number.isFinite(rawQuantity) || !Number.isInteger(rawQuantity)) {
      throw new Error("Quantity must be a whole number.");
    }
    const quantity = Math.trunc(rawQuantity);
    if (quantity <= 0) {
      throw new Error("Quantity must be at least 1.");
    }
    if (quantity > MAX_RAW_MATERIAL_QR_BATCH_QUANTITY) {
      throw new Error(`Quantity cannot exceed ${MAX_RAW_MATERIAL_QR_BATCH_QUANTITY} codes in one batch.`);
    }

    const party = this.db
      .prepare("SELECT id, party_code, party_name FROM parties WHERE id = ? AND deleted_at IS NULL LIMIT 1")
      .get(input.partyId) as { id: string; party_code: string; party_name: string } | undefined;
    if (!party) {
      throw new Error("Selected party was not found. Create it in Party Master first.");
    }

    const item = this.db
      .prepare(
        `SELECT ii.id, ii.item_code, ii.display_name,
                COALESCE(isb.unit_id, ii.default_unit_id) AS stock_unit_id,
                ${KIND_SQL} AS kind
         FROM inventory_items ii
         ${KIND_JOINS}
         LEFT JOIN inventory_stock_balances isb ON isb.item_id = ii.id
         WHERE ii.id = ? AND ii.status = 'ACTIVE' LIMIT 1`
      )
      .get(input.itemId) as
      | { id: string; item_code: string; display_name: string; stock_unit_id: string | null; kind: string | null }
      | undefined;
    if (!item) {
      throw new Error("Selected raw material was not found. Create it in Raw Material Master first.");
    }
    // Dana is never labelled (owner, 2026-10-11): it comes in loose, is moved in by hand, and goes
    // out by a typed quantity from the machine program. A labelled Dana packet would lock that —
    // a balance with packets in it can only be scanned out, never typed out.
    if (item.kind === RAW_MATERIAL_KIND.DANA) {
      throw new Error(
        `${item.display_name} is Dana, and Dana is not labelled. Move it in by hand on Store In, and issue it from the machine program on Store Out.`
      );
    }

    // Measured in the unit the material's stock is counted in, so every scan of these labels
    // adds and removes exactly this figure without any conversion that could be missing.
    const packingQuantity = Number(input.packingQuantity);
    if (!Number.isFinite(packingQuantity) || packingQuantity <= 0) {
      throw new Error("Enter how much one packet holds — it must be greater than zero.");
    }
    if (!item.stock_unit_id) {
      throw new Error("This material has no stock unit, so a packet's contents cannot be recorded. Give it a unit first.");
    }

    // Fail before touching the database if the combination cannot be encoded as a scannable
    // identity — a registered code that the scanner cannot parse would be worthless.
    buildRawMaterialQrId({ partyCode: party.party_code, itemCode: item.item_code, sequence: 1 });

    const now = new Date().toISOString();
    const createdBy = String(input.createdBy ?? "").trim() || null;
    const requestedBy = String(input.requestedBy ?? "").trim().slice(0, 120) || null;

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      // THIS COMPUTER'S SERIAL BLOCK, exactly as the carton generator uses it (qrCodes.ts).
      // Raw-material packet labels are printed, scanned moving in and scanned moving out, so a
      // duplicate serial is two packets the store cannot tell apart.
      const serialRange = requireSerialRange(this);

      // Read, validate, then write, inside the BEGIN IMMEDIATE above. Checked BEFORE the counter
      // moves, so a refused run cannot leave it sitting in another computer's block.
      const existing = this.db
        .prepare("SELECT last_sequence FROM raw_material_qr_sequences WHERE party_id = ? AND item_id = ?")
        .get(party.id, item.id) as { last_sequence: number } | undefined;

      const { startSequence, endSequence } = reserveSerialRange(
        serialRange,
        existing === undefined ? null : Number(existing.last_sequence),
        quantity,
        "raw material QR serials"
      );

      this.db
        .prepare(
          `INSERT INTO raw_material_qr_sequences (id, party_id, item_id, last_sequence, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(party_id, item_id) DO UPDATE SET
             last_sequence = excluded.last_sequence,
             updated_at = excluded.updated_at`
        )
        .run(crypto.randomUUID(), party.id, item.id, endSequence, now);

      const batchId = crypto.randomUUID();
      this.db
        .prepare(
          `INSERT INTO raw_material_qr_batches (id, party_id, item_id, start_sequence, end_sequence, quantity, created_at, created_by, requested_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(batchId, party.id, item.id, startSequence, endSequence, quantity, now, createdBy, requestedBy);

      // Queued for other computers in this same transaction, the run ahead of its packets, so a
      // label run and its record of having to be sent are committed together or not at all.
      enqueueRawMaterialQrBatch(
        this.db,
        { batchId, partyId: party.id, itemId: item.id, startSequence, endSequence, quantity, createdAt: now, createdBy, requestedBy },
        crypto.randomUUID()
      );

      // What this run's packets hold is written onto each label, so every scan of it moves
      // exactly that much stock — two packets of one material can hold different amounts.
      const insertQr = this.db.prepare(
        `INSERT INTO raw_material_qrs
           (id, batch_id, party_id, item_id, sequence, status, current_status,
            packing_quantity, packing_unit_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'GENERATED', ?, ?, ?, ?, ?)`
      );
      const qrCodes: RawMaterialQrRecord[] = [];
      for (let sequence = startSequence; sequence <= endSequence; sequence += 1) {
        const id = buildRawMaterialQrId({ partyCode: party.party_code, itemCode: item.item_code, sequence });
        insertQr.run(
          id, batchId, party.id, item.id, sequence,
          RAW_MATERIAL_QR_STATUS.GENERATED,
          packingQuantity, item.stock_unit_id,
          now, now
        );
        enqueueRawMaterialQr(
          this.db,
          {
            qrId: id, batchId, partyId: party.id, itemId: item.id, sequence,
            packingQuantity, packingUnitId: item.stock_unit_id, createdAt: now,
          },
          crypto.randomUUID()
        );
        qrCodes.push({ id, batchId, partyId: party.id, itemId: item.id, sequence, status: "GENERATED", createdAt: now });
      }

      this.db.exec("COMMIT");

      return {
        batch: {
          id: batchId,
          partyId: party.id,
          partyCode: party.party_code,
          partyName: party.party_name,
          itemId: item.id,
          itemCode: item.item_code,
          itemDisplayName: item.display_name,
          startSequence,
          endSequence,
          quantity,
          packingQuantity,
          createdAt: now,
          createdBy,
          requestedBy,
        },
        qrCodes,
      };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }
  },

  /**
   * Where the serial sequence currently stands for a party+item combination, so the
   * generator can show the exact range it is about to register before the operator commits.
   * Read-only.
   */
  getRawMaterialQrSequenceState(this: SqliteDatabase, input: { partyId: string; itemId: string }): {
    lastSequence: number;
    nextSequence: number;
  } | null {
    if (!input.partyId || !input.itemId) return null;
    const row = this.db
      .prepare("SELECT last_sequence FROM raw_material_qr_sequences WHERE party_id = ? AND item_id = ?")
      .get(input.partyId, input.itemId) as { last_sequence: number } | undefined;
    const lastSequence = Number(row?.last_sequence ?? 0);
    return { lastSequence, nextSequence: lastSequence + 1 };
  },

  /**
   * `sinceIso` filters to batches created at or after that instant, evaluated against
   * `raw_material_qr_batches.created_at` using the existing index on that column.
   */
  listRawMaterialQrBatches(this: SqliteDatabase, input: { limit?: number; sinceIso?: string } = {}): RawMaterialQrBatchRecord[] {
    const limit = Math.max(1, Math.trunc(input.limit ?? 20));
    const params: Array<string | number> = [];
    let whereClause = "";
    if (input.sinceIso) {
      whereClause = "WHERE rqb.created_at >= ?";
      params.push(input.sinceIso);
    }
    params.push(limit);

    const rows = this.db
      .prepare(
        `SELECT rqb.id, rqb.party_id, p.party_code, p.party_name, rqb.item_id, ii.item_code, ii.display_name,
                rqb.start_sequence, rqb.end_sequence, rqb.quantity, rqb.created_at, rqb.created_by, rqb.requested_by,
                -- Every label in a run carries the same snapshot, so the first one speaks for the batch.
                (SELECT COALESCE(q.packing_quantity, ii.packing_quantity) FROM raw_material_qrs q
                  WHERE q.batch_id = rqb.id ORDER BY q.sequence LIMIT 1) AS packing_quantity
         FROM raw_material_qr_batches rqb
         JOIN parties p ON p.id = rqb.party_id
         JOIN inventory_items ii ON ii.id = rqb.item_id
         ${whereClause}
         ORDER BY rqb.created_at DESC LIMIT ?`
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      partyId: String(row.party_id),
      partyCode: String(row.party_code),
      partyName: String(row.party_name),
      itemId: String(row.item_id),
      itemCode: String(row.item_code),
      itemDisplayName: String(row.display_name),
      startSequence: Number(row.start_sequence),
      endSequence: Number(row.end_sequence),
      quantity: Number(row.quantity),
      packingQuantity: row.packing_quantity == null ? null : Number(row.packing_quantity),
      createdAt: String(row.created_at),
      createdBy: row.created_by ? String(row.created_by) : null,
      requestedBy: row.requested_by ? String(row.requested_by) : null,
    }));
  },

  listRawMaterialQrsForBatch(this: SqliteDatabase, batchId: string): RawMaterialQrRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, batch_id, party_id, item_id, sequence, status, created_at
         FROM raw_material_qrs WHERE batch_id = ? ORDER BY sequence ASC`
      )
      .all(batchId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      batchId: String(row.batch_id),
      partyId: String(row.party_id),
      itemId: String(row.item_id),
      sequence: Number(row.sequence),
      status: String(row.status),
      createdAt: String(row.created_at),
    }));
  },

  /**
   * Why a generated run cannot be erased, in the words the operator reads. Empty means not one
   * of its labels has ever been scanned, so the run exists only on paper.
   */
  rawMaterialQrBatchDeleteBlockers(this: SqliteDatabase, batchId: string): string[] {
    const blockers: string[] = [];
    const moved = this.db
      .prepare(`SELECT COUNT(1) AS n FROM raw_material_qrs WHERE batch_id = ? AND status <> ?`)
      .get(batchId, RAW_MATERIAL_QR_STATUS.GENERATED) as { n: number } | undefined;
    if (moved && moved.n > 0) blockers.push(`${moved.n} label(s) already moved`);

    const scans = this.db
      .prepare(`SELECT COUNT(1) AS n FROM raw_material_qr_events WHERE qr_id IN (SELECT id FROM raw_material_qrs WHERE batch_id = ?)`)
      .get(batchId) as { n: number } | undefined;
    if (scans && scans.n > 0) blockers.push(`${scans.n} scan(s) recorded`);
    return blockers;
  },

  /**
   * Erases a run of labels generated by mistake, as if it had never been generated.
   *
   * Only ever allowed while every label in the run is still untouched — one scan makes it part
   * of what happened in the store, and that is never deleted. The serial counter is then set
   * back to the highest serial still registered for that supplier+material, so the numbers the
   * run consumed are handed out again, and a run with surviving labels above it leaves its gap
   * rather than risking a second label carrying a number that already exists.
   */
  deleteRawMaterialQrBatch(this: SqliteDatabase, input: { batchId: string; deletedBy?: string }): {
    quantity: number;
    partyName: string;
    itemCode: string;
    itemDisplayName: string;
    firstId: string | null;
    lastId: string | null;
    nextSequence: number;
  } {
    const batch = this.db
      .prepare(
        `SELECT b.id, b.party_id, b.item_id, b.quantity, b.start_sequence, b.end_sequence,
                p.party_name, i.item_code, i.display_name
         FROM raw_material_qr_batches b
         JOIN parties p ON p.id = b.party_id
         JOIN inventory_items i ON i.id = b.item_id
         WHERE b.id = ?`
      )
      .get(input.batchId) as
      | { id: string; party_id: string; item_id: string; quantity: number; start_sequence: number; end_sequence: number; party_name: string; item_code: string; display_name: string }
      | undefined;
    if (!batch) throw new Error("That label run was not found.");

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      // Re-checked inside the transaction: a scan could have landed since the UI last looked.
      const blockers = this.rawMaterialQrBatchDeleteBlockers(input.batchId);
      if (blockers.length > 0) {
        throw new Error(`This run cannot be erased — ${blockers.join(" and ")}. Labels that have been scanned stay in the record.`);
      }

      const ids = this.db.prepare("SELECT id FROM raw_material_qrs WHERE batch_id = ? ORDER BY sequence ASC").all(input.batchId) as Array<{ id: string }>;

      // The run was queued for other computers when it was printed. Erasing it is only a local
      // act while none of that queue can have left this computer -- then the queue goes with the
      // run, and a reprint of the same serials queues afresh. Once any of it may be elsewhere,
      // the erase has to travel too (docs/37 section W.5), and until that correction exists the
      // honest answer is no.
      const withdrawal = withdrawUnsentSyncEvents(
        this.db,
        rawMaterialQrBatchDedupeKeys(input.batchId, ids.map((row) => row.id))
      );
      if (withdrawal.kind === "MAY_HAVE_LEFT") {
        throw new Error(
          "This run cannot be erased — it has already been sent to the other computers, and erasing a sent run is not supported yet."
        );
      }

      this.db.prepare("DELETE FROM raw_material_qrs WHERE batch_id = ?").run(input.batchId);
      this.db.prepare("DELETE FROM raw_material_qr_batches WHERE id = ?").run(input.batchId);

      // Back to the highest serial still registered for this supplier+material — 0 when the run
      // was all there was, so the next run starts from one again.
      const highest = this.db
        .prepare("SELECT COALESCE(MAX(sequence), 0) AS top FROM raw_material_qrs WHERE party_id = ? AND item_id = ?")
        .get(batch.party_id, batch.item_id) as { top: number };
      const now = new Date().toISOString();
      this.db
        .prepare("UPDATE raw_material_qr_sequences SET last_sequence = ?, updated_at = ? WHERE party_id = ? AND item_id = ?")
        .run(Number(highest.top), now, batch.party_id, batch.item_id);

      this.writeInventoryAudit(
        batch.item_id, "RAW_MATERIAL_QR_BATCH", input.batchId, "DELETE",
        {
          partyName: batch.party_name, itemCode: batch.item_code, quantity: batch.quantity,
          startSequence: batch.start_sequence, endSequence: batch.end_sequence,
          qrIds: ids.map((row) => row.id),
        },
        { sequenceResetTo: Number(highest.top) },
        input.deletedBy
      );
      this.db.exec("COMMIT");

      return {
        quantity: Number(batch.quantity),
        partyName: batch.party_name,
        itemCode: batch.item_code,
        itemDisplayName: batch.display_name,
        firstId: ids[0]?.id ?? null,
        lastId: ids[ids.length - 1]?.id ?? null,
        nextSequence: Number(highest.top) + 1,
      };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }
  },

  // ─── Store movement ────────────────────────────────────────────────────────────
  // One label is one packet. Store Move In receives a packet into the store, Store Move
  // Out issues it to the material's section. Raw material has no factory/gate stage — it
  // arrives from a supplier and is issued to a section — so "in store" IS its stock, held
  // in inventory_stock_balances. Every movement writes a stock event, a balance change, a
  // status change and a journey event inside one transaction.

  /**
   * The live packet behind a scanned label, with everything a movement decision needs.
   * The packing is the label's own snapshot, falling back to the material's current
   * configuration for labels printed before packing was set up.
   */
  getRawMaterialQrForMovement(this: SqliteDatabase, qrId: string, tx: TransactionContext): RawMaterialMovementRecord | null {
    const context = tx as MutableTransactionContext;
    const row = context.db
      .prepare(
        `SELECT q.id, q.item_id, q.party_id, q.status, q.current_status, q.current_section_id,
                COALESCE(q.packing_quantity, ii.packing_quantity) AS packing_quantity,
                COALESCE(q.packing_unit_id, ii.packing_unit_id)   AS packing_unit_id,
                u.code AS packing_unit_code, ${EFFECTIVE_PACK_NAME_SQL} AS pack_name,
                ii.display_name, ii.item_code, ii.status AS item_status,
                q.current_hop_index,
                NULL AS default_section_id, NULL AS default_section_name,
                p.party_name, ${KIND_SQL} AS kind,
                -- Raw material routes were removed on 2026-10-07: a packet simply leaves the
                -- store, and nothing records where it goes next.
                NULL AS next_section_id, NULL AS next_section_name, 0 AS hop_count
         FROM raw_material_qrs q
         JOIN inventory_items ii ON ii.id = q.item_id
         -- LEFT joins: the kind is extra information here, never a reason to lose a packet.
         LEFT JOIN inventory_categories kind_cat ON kind_cat.id = ii.category_id
         LEFT JOIN inventory_categories kind_parent ON kind_parent.id = kind_cat.parent_id
         JOIN parties p ON p.id = q.party_id
         LEFT JOIN inventory_units u ON u.id = COALESCE(q.packing_unit_id, ii.packing_unit_id)
         WHERE q.id = ? LIMIT 1`
      )
      .get(qrId) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      qrId: String(row.id),
      itemId: String(row.item_id),
      itemCode: String(row.item_code),
      partyId: String(row.party_id),
      partyName: String(row.party_name),
      displayName: String(row.display_name),
      itemStatus: String(row.item_status),
      registryStatus: String(row.status),
      currentStatus: String(row.current_status),
      currentSectionId: row.current_section_id ? String(row.current_section_id) : null,
      packingQuantity: row.packing_quantity == null ? null : Number(row.packing_quantity),
      packingUnitId: row.packing_unit_id ? String(row.packing_unit_id) : null,
      packingUnitCode: row.packing_unit_code ? String(row.packing_unit_code) : null,
      packName: row.pack_name ? String(row.pack_name) : null,
      defaultSectionId: row.default_section_id ? String(row.default_section_id) : null,
      defaultSectionName: row.default_section_name ? String(row.default_section_name) : null,
      currentHopIndex: Number(row.current_hop_index ?? 0),
      hopCount: Number(row.hop_count ?? 0),
      nextSectionId: row.next_section_id ? String(row.next_section_id) : null,
      nextSectionName: row.next_section_name ? String(row.next_section_name) : null,
      kind: row.kind ? String(row.kind) : null,
    };
  },

  /**
   * Guarded status move: only a packet still in `expectedStatus` changes, so two terminals
   * scanning the same label race safely and exactly one wins.
   */
  setRawMaterialQrStatus(
    this: SqliteDatabase,
    input: {
      qrId: string; expectedStatus: string; nextStatus: string; sectionId: string | null;
      updatedAt: string;
      /** Where along its route the packet now is. Omitted leaves it where it was. */
      hopIndex?: number;
    },
    tx: TransactionContext
  ): boolean {
    const context = tx as MutableTransactionContext;
    const result = context.db
      .prepare(
        `UPDATE raw_material_qrs
         SET current_status = ?, current_section_id = ?, current_hop_index = COALESCE(?, current_hop_index), updated_at = ?
         WHERE id = ? AND current_status = ?`
      )
      .run(input.nextStatus, input.sectionId, input.hopIndex ?? null, input.updatedAt, input.qrId, input.expectedStatus);
    return Number(result.changes) > 0;
  },

  /**
   * Applies a packet to the material's stock balance and records the matching stock event.
   * The balance is held in one unit per item: the first movement establishes it, and later
   * movements in another unit are converted through the existing conversion table. A
   * quantity that cannot be converted is refused rather than added as a bare number.
   */
  applyRawMaterialStockChange(
    this: SqliteDatabase,
    input: {
      itemId: string;
      quantity: number;
      unitId: string;
      direction: "IN" | "OUT";
      note: string;
      actor: string | null;
      nowIso: string;
    },
    tx: TransactionContext
  ): { quantity: number; unitId: string } {
    const context = tx as MutableTransactionContext;
    const balance = context.db
      .prepare("SELECT item_id, quantity_on_hand, unit_id FROM inventory_stock_balances WHERE item_id = ? LIMIT 1")
      .get(input.itemId) as { item_id: string; quantity_on_hand: number; unit_id: string } | undefined;

    let quantity = input.quantity;
    let unitId = input.unitId;

    if (balance) {
      unitId = balance.unit_id;
      if (input.unitId !== balance.unit_id) {
        const converted = this.convertInventoryUnit(input.quantity, input.unitId, balance.unit_id);
        if (converted == null) {
          throw new Error(
            "This packet is measured in a unit that cannot be converted to the unit this material is stocked in. Add the conversion in Raw Material Master first."
          );
        }
        quantity = converted;
      }
    }

    const signed = input.direction === "IN" ? quantity : -quantity;
    const nextOnHand = Number(balance?.quantity_on_hand ?? 0) + signed;
    if (nextOnHand < 0) {
      throw new Error("Stock for this material would go negative. Check the store balance before moving this packet out.");
    }

    if (balance) {
      context.db
        .prepare("UPDATE inventory_stock_balances SET quantity_on_hand = ?, updated_at = ? WHERE item_id = ?")
        .run(nextOnHand, input.nowIso, input.itemId);
    } else {
      context.db
        .prepare("INSERT INTO inventory_stock_balances (item_id, quantity_on_hand, unit_id, updated_at) VALUES (?, ?, ?, ?)")
        .run(input.itemId, nextOnHand, unitId, input.nowIso);
    }

    context.db
      .prepare(
        `INSERT INTO inventory_stock_events (id, item_id, event_type, quantity, unit_id, note, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        input.itemId,
        input.direction === "IN" ? "RECEIVE" : "TRANSFER_OUT",
        quantity,
        unitId,
        input.note,
        input.actor,
        input.nowIso
      );

    return { quantity, unitId };
  },

  /** One step of a packet's journey, in the same shape the carton event log records. */
  appendRawMaterialQrEvent(
    this: SqliteDatabase,
    payload: {
      eventId: string;
      qrId: string;
      itemId: string;
      partyId: string;
      eventType: "STORE_ENTRY" | "STORE_EXIT";
      occurredAt: string;
      factoryId: string;
      workstationId: string;
      deviceId: string;
      actor: string | null;
      sessionId: string | null;
      quantity: number;
      unitId: string;
      previousStatus: string;
      newStatus: string;
      sectionId: string | null;
      itemDisplayName: string;
      /**
       * The machine program upper line this movement was counted against, or null.
       *
       * On a STORE_EXIT it is the line the packet was taken for. On a STORE_ENTRY it is the
       * compensating record that puts the packet's quantity back on that line. This stamp is the
       * ONE ownership rule behind Reserved — see database/machineProgramSql.ts. (The first-shape
       * column machine_program_line_id is history and is no longer written.)
       */
      machineProgramLineId?: string | null;
      /**
       * The saved Store Out batch that committed this movement, or null.
       *
       * Beside machineProgramLineId, which says which ALLOCATION authorised the packet. This says
       * which Save Batch recorded it (migration 062). The generic store scanner has no batch, so
       * a packet it issues carries the line stamp and nothing here.
       */
      machineProgramBatchId?: string | null;
      /** Upper Move Out: the machine the packet was issued to (migration 079). Null otherwise. */
      machineId?: string | null;
      /**
       * Scan Out: who the packet was moved out to (0.3.6). In metadata_json rather than a column
       * because 0.3.6 ships no migration -- getRawMaterialQrJourney reads it back with json_extract.
       */
      issuedToPartyId?: string | null;
    },
    tx: TransactionContext
  ): void {
    const context = tx as MutableTransactionContext;
    const result = context.db
      .prepare(
        `INSERT INTO raw_material_qr_events
           (id, qr_id, item_id, party_id, event_type, event_ts_local, event_date,
            factory_id, workstation_id, device_id, actor, session_id,
            quantity, unit_id, previous_status, new_status, section_id, item_display_name,
            machine_program_upper_line_id, machine_program_batch_id, machine_id, metadata_json, created_at, sync_status, source_app)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 'desktop-store-scanner')`
      )
      .run(
        payload.eventId,
        payload.qrId,
        payload.itemId,
        payload.partyId,
        payload.eventType,
        payload.occurredAt,
        payload.occurredAt.slice(0, 10),
        payload.factoryId,
        payload.workstationId,
        payload.deviceId,
        payload.actor,
        payload.sessionId,
        payload.quantity,
        payload.unitId,
        payload.previousStatus,
        payload.newStatus,
        payload.sectionId,
        payload.itemDisplayName,
        payload.machineProgramLineId ?? null,
        payload.machineProgramBatchId ?? null,
        payload.machineId ?? null,
        JSON.stringify({
          eventType: payload.eventType,
          actor: payload.actor ?? null,
          sessionId: payload.sessionId ?? null,
          ...(payload.issuedToPartyId ? { issuedToPartyId: payload.issuedToPartyId } : {}),
        }),
        payload.occurredAt
      );

    if (Number(result.changes) === 0) {
      throw new Error("Raw material movement event insert failed.");
    }
  },

  /** A party as the Scan Out rule judges it: does it exist, is it active, what type is it. */
  getRawMaterialIssueParty(
    this: SqliteDatabase,
    partyId: string,
    tx: TransactionContext
  ): { id: string; partyName: string; partyType: string; status: string } | null {
    const context = tx as MutableTransactionContext;
    const row = context.db
      .prepare("SELECT id, party_name, party_type, status FROM parties WHERE id = ? AND deleted_at IS NULL LIMIT 1")
      .get(partyId) as { id: string; party_name: string; party_type: string; status: string } | undefined;
    return row ? { id: row.id, partyName: row.party_name, partyType: row.party_type, status: row.status } : null;
  },

  // ─── QR Management / QR Journey reads ──────────────────────────────────────────
  // Raw material packets answer the same questions a carton does — what is this, is the
  // code registered, where is it now, what has happened to it — through the same
  // QrDetail / QrJourney shapes, so both screens stay one screen.

  /** A packet's identity row, shared by the detail and journey reads. */
  getRawMaterialQrHead(this: SqliteDatabase, qrId: string): Record<string, unknown> | undefined {
    return this.db
      .prepare(
        `SELECT q.id, q.sequence, q.status, q.current_status, q.created_at, q.updated_at, q.batch_id,
                COALESCE(q.packing_quantity, ii.packing_quantity) AS packing_quantity,
                u.code AS packing_unit_code,
                ii.display_name, ii.item_code,
                p.party_name,
                ws.name AS section_name
         FROM raw_material_qrs q
         JOIN inventory_items ii ON ii.id = q.item_id
         JOIN parties p ON p.id = q.party_id
         LEFT JOIN inventory_units u ON u.id = COALESCE(q.packing_unit_id, ii.packing_unit_id)
         LEFT JOIN work_sections ws ON ws.id = q.current_section_id
         WHERE q.id = ? LIMIT 1`
      )
      .get(qrId) as Record<string, unknown> | undefined;
  },

  /** One packet lifecycle status in the shared QrStage vocabulary. */
  rawMaterialStatusAsStage(status: string): QrStage {
    if (status === RAW_MATERIAL_QR_STATUS.IN_STORE) return "WAREHOUSE";
    if (status === RAW_MATERIAL_QR_STATUS.ISSUED) return "ISSUED";
    return "REGISTERED";
  },

  /** GENERATED / IN_STORE / ISSUED expressed in the shared QrStage vocabulary. */
  rawMaterialStageOf(registryStatus: string, currentStatus: string): QrStage {
    if (registryStatus === "VOID") return "VOID";
    if (currentStatus === RAW_MATERIAL_QR_STATUS.IN_STORE) return "WAREHOUSE";
    if (currentStatus === RAW_MATERIAL_QR_STATUS.ISSUED) return "ISSUED";
    return "REGISTERED";
  },

  /** The packing, written the way it is printed on the label: "2 DOZ". */
  rawMaterialPackingLabel(row: Record<string, unknown>): string {
    if (row.packing_quantity == null) return "";
    return `${Number(row.packing_quantity)} ${row.packing_unit_code ? String(row.packing_unit_code) : ""}`.trim();
  },

  /**
   * Everything one already-generated packet label says, for reprinting it exactly as it was
   * first printed.
   *
   * The figures are the LABEL's own, not the material's current ones: `packing_quantity` is
   * stamped on each QR when it is generated, because the same material arrives 5 DOZEN to a
   * packet one day and 3 the next. Reprinting a sticker must reproduce the sticker, not
   * describe the material as it stands today.
   *
   * `values` is returned in the same shape listInventoryItems gives, so the screen builds the
   * attribute lines with materialLabelAttributes — the one function the generator already uses,
   * including the Urdu colour. Nothing about the layout is decided twice.
   */
  getRawMaterialQrLabel(this: SqliteDatabase, qrId: string): RawMaterialQrLabel | null {
    const row = this.db
      .prepare(
        `SELECT q.id, q.packing_quantity,
                p.party_name,
                ic.name AS category_name, parent.name AS parent_category_name,
                ii.id AS item_id, ii.display_name
         FROM raw_material_qrs q
         JOIN parties p ON p.id = q.party_id
         JOIN inventory_items ii ON ii.id = q.item_id
         JOIN inventory_categories ic ON ic.id = ii.category_id
         LEFT JOIN inventory_categories parent ON parent.id = ic.parent_id
         WHERE q.id = ?`
      )
      .get(String(qrId ?? "").trim()) as Record<string, unknown> | undefined;
    if (!row) return null;

    const values = this.db
      .prepare(
        `SELECT f.field_key, f.label, f.field_type, v.text_value, v.number_value, v.text_value_urdu
         FROM inventory_item_values v JOIN inventory_category_fields f ON f.id = v.field_id
         WHERE v.item_id = ? ORDER BY f.sort_order`
      )
      .all(String(row.item_id)) as Array<Record<string, unknown>>;

    return {
      qrId: String(row.id),
      displayName: String(row.display_name ?? ""),
      partyName: String(row.party_name ?? ""),
      categoryLine: String(row.parent_category_name ?? row.category_name ?? ""),
      subCategoryLine: row.parent_category_name ? String(row.category_name ?? "") : "",
      packingQuantity: row.packing_quantity == null ? null : Number(row.packing_quantity),
      values,
    };
  },

  getRawMaterialQrDetail(this: SqliteDatabase, qrId: string): QrDetail | null {
    const head = this.getRawMaterialQrHead(qrId);
    if (!head) return null;

    const events = this.db
      .prepare(
        `SELECT e.id, e.event_type, e.event_ts_local, e.device_id, e.actor, e.quantity,
                e.previous_status, e.new_status, e.sync_status,
                u.code AS unit_code, ws.name AS section_name,
                f.name AS factory_name, w.name AS workstation_name,
                issued_to.party_name AS issued_to_party_name
         FROM raw_material_qr_events e
         LEFT JOIN inventory_units u ON u.id = e.unit_id
         LEFT JOIN work_sections ws ON ws.id = e.section_id
         LEFT JOIN factories f ON f.id = e.factory_id
         LEFT JOIN workstations w ON w.id = e.workstation_id
         LEFT JOIN parties issued_to ON issued_to.id = json_extract(e.metadata_json, '$.issuedToPartyId')
         WHERE e.qr_id = ?
         ORDER BY e.event_ts_local ASC, e.rowid ASC`
      )
      .all(qrId) as Array<Record<string, unknown>>;

    const packing = this.rawMaterialPackingLabel(head);
    const firstEvent = events[0];

    return {
      qrId: String(head.id),
      kind: "RAW_MATERIAL",
      supplierName: String(head.party_name),
      sectionName: head.section_name ? String(head.section_name) : null,
      stageLabel: this.rawMaterialStageLabel(head),
      // A packet has no article / colour / size of its own. The material's own name fills
      // the product line and the packing fills the size line, so every screen that joins
      // these three reads correctly without a second layout.
      article: String(head.display_name),
      color: "",
      size: packing,
      serial: String(head.sequence).padStart(6, "0"),
      stage: this.rawMaterialStageOf(String(head.status), String(head.current_status)),
      productVariantId: null,
      sellingPrice: null,
      stockOnHand: null,
      registry: {
        status: String(head.status),
        registeredAt: String(head.created_at),
        voidReason: null,
        voidedAt: null,
        voidedBy: null,
      },
      batch: null,
      lifecycle: firstEvent
        ? {
            currentStatus: String(head.current_status),
            locationType: String(head.current_status) === RAW_MATERIAL_QR_STATUS.IN_STORE ? "WAREHOUSE" : "UNKNOWN",
            locationId: null,
            firstScannedAt: String(firstEvent.event_ts_local),
            updatedAt: String(head.updated_at),
          }
        : null,
      events: events.map((row) => ({
        id: String(row.id),
        eventType: "MOVED",
        subType: String(row.event_type),
        occurredAt: String(row.event_ts_local),
        factory: row.factory_name ? String(row.factory_name) : null,
        workstation: row.workstation_name ? String(row.workstation_name) : null,
        operator: row.actor ? String(row.actor) : null,
        deviceId: String(row.device_id),
        note: this.rawMaterialEventNote(row),
        syncStatus: String(row.sync_status),
      })),
    };
  },

  /** "Issued to PACKING" once a packet has left, else nothing to add to the stage. */
  rawMaterialStageLabel(row: Record<string, unknown>): string | null {
    if (String(row.current_status) !== RAW_MATERIAL_QR_STATUS.ISSUED) return null;
    return row.section_name ? `Issued to ${String(row.section_name)}` : null;
  },

  /**
   * What the movement did, in words: "2 DOZ in" / "2 DOZ issued to SHEHZAD RUBBER". The party
   * chosen on Scan Out (0.3.6) is named in preference to the section, because it is the more
   * specific answer to "where did it go".
   */
  rawMaterialEventNote(row: Record<string, unknown>): string {
    const amount = `${Number(row.quantity)} ${row.unit_code ? String(row.unit_code) : ""}`.trim();
    if (String(row.event_type) === "STORE_EXIT") {
      const to = row.issued_to_party_name ?? row.section_name;
      return `${amount} issued${to ? ` to ${String(to)}` : ""}`;
    }
    return `${amount} received into the store`;
  },

  getRawMaterialQrJourney(this: SqliteDatabase, qrId: string): QrJourney | null {
    const head = this.getRawMaterialQrHead(qrId);
    if (!head) return null;

    const rows = this.db
      .prepare(
        `SELECT e.id, e.event_type, e.event_ts_local, e.device_id, e.actor, e.quantity,
                e.previous_status, e.new_status, e.sync_status,
                u.code AS unit_code, ws.name AS section_name,
                f.name AS factory_name, w.name AS workstation_name,
                issued_to.party_name AS issued_to_party_name
         FROM raw_material_qr_events e
         LEFT JOIN inventory_units u ON u.id = e.unit_id
         LEFT JOIN work_sections ws ON ws.id = e.section_id
         LEFT JOIN factories f ON f.id = e.factory_id
         LEFT JOIN workstations w ON w.id = e.workstation_id
         LEFT JOIN parties issued_to ON issued_to.id = json_extract(e.metadata_json, '$.issuedToPartyId')
         WHERE e.qr_id = ?
         ORDER BY e.event_ts_local ASC, e.rowid ASC`
      )
      .all(qrId) as Array<Record<string, unknown>>;

    // A packet in the store is in the same physical place a carton in the store is; once
    // issued it has left every place this model names, so it has none.
    const placeOf = (stage: QrStage): QrPlace | null => (stage === "WAREHOUSE" ? "WAREHOUSE" : null);

    const steps: QrJourneyStep[] = [];
    const counts: Partial<Record<QrJourneyStepKind, number>> = {};
    const dwellMs: Record<string, number> = {};
    const registeredAt = String(head.created_at);
    let previousAt = registeredAt;

    const push = (step: Omit<QrJourneyStep, "index" | "sinceMs">) => {
      const sinceMs = steps.length === 0 ? null : new Date(step.occurredAt).getTime() - new Date(previousAt).getTime();
      steps.push({ ...step, index: steps.length + 1, sinceMs });
      counts[step.kind] = (counts[step.kind] ?? 0) + 1;
      if (step.fromStatus) {
        dwellMs[step.fromStatus] =
          (dwellMs[step.fromStatus] ?? 0) + (new Date(step.occurredAt).getTime() - new Date(previousAt).getTime());
      }
      previousAt = step.occurredAt;
    };

    push({
      id: `registry:${head.id}`,
      kind: "REGISTERED",
      eventType: null,
      occurredAt: registeredAt,
      fromStatus: null,
      toStatus: "REGISTERED",
      fromPlace: null,
      toPlace: null,
      actor: null,
      deviceId: null,
      workstation: null,
      factory: null,
      note: `Label printed for ${String(head.party_name)}`,
      syncStatus: null,
    });

    for (const row of rows) {
      const from = this.rawMaterialStatusAsStage(String(row.previous_status));
      const to = this.rawMaterialStatusAsStage(String(row.new_status));
      // An exit hop names where it went, because "Issued" on its own does not tell the operator
      // whether it went to packing or to the upper maker. The Scan Out party wins when there is one.
      const issuedTo = row.issued_to_party_name ?? row.section_name;
      const toStatusLabel = to === "ISSUED" && issuedTo ? `Issued to ${String(issuedTo)}` : null;
      push({
        id: String(row.id),
        kind: String(row.event_type) === "STORE_EXIT" ? "STORE_EXIT" : "STORE_ENTRY",
        eventType: "MOVED",
        occurredAt: String(row.event_ts_local),
        fromStatus: from,
        toStatus: to,
        toStatusLabel,
        fromPlace: placeOf(from),
        toPlace: placeOf(to),
        actor: row.actor ? String(row.actor) : null,
        deviceId: String(row.device_id),
        workstation: row.workstation_name ? String(row.workstation_name) : null,
        factory: row.factory_name ? String(row.factory_name) : null,
        note: this.rawMaterialEventNote(row),
        syncStatus: String(row.sync_status),
      });
    }

    const asOf = new Date().toISOString();
    const currentStatus = String(head.current_status);
    const currentStage = this.rawMaterialStatusAsStage(currentStatus);
    dwellMs[currentStage] = (dwellMs[currentStage] ?? 0) + (new Date(asOf).getTime() - new Date(previousAt).getTime());

    return {
      qrId: String(head.id),
      kind: "RAW_MATERIAL",
      supplierName: String(head.party_name),
      article: String(head.display_name),
      color: "",
      size: this.rawMaterialPackingLabel(head),
      serial: String(head.sequence).padStart(6, "0"),
      stage: this.rawMaterialStageOf(String(head.status), currentStatus),
      stageLabel: this.rawMaterialStageLabel(head),
      currentStatus: this.rawMaterialStatusAsStage(currentStatus),
      currentPlace: placeOf(currentStage),
      registeredAt,
      batchId: String(head.batch_id),
      firstScannedAt: rows.length ? String(rows[0].event_ts_local) : null,
      lastActivityAt: rows.length ? String(rows[rows.length - 1].event_ts_local) : registeredAt,
      steps,
      counts,
      dwellMs,
      asOf,
    };
  },

  /** Raw material packets matching every search term, in the shared search-row shape. */
  searchRawMaterialQrs(this: SqliteDatabase, terms: string[], limit: number): QrSearchRow[] {
    if (terms.length === 0) return [];
    const escape = (term: string) => term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const where = terms.map(() => "(q.id LIKE ? ESCAPE '\\' OR UPPER(ii.display_name) LIKE ? ESCAPE '\\')").join(" AND ");
    const params: Array<string | number> = [];
    for (const term of terms) {
      params.push(`%${escape(term)}%`, `%${escape(term)}%`);
    }
    params.push(Math.min(Math.max(1, Math.trunc(limit)), 500));

    const rows = this.db
      .prepare(
        `SELECT q.id, q.sequence, q.status, q.current_status, q.created_at, q.updated_at, q.batch_id,
                COALESCE(q.packing_quantity, ii.packing_quantity) AS packing_quantity,
                u.code AS packing_unit_code, ii.display_name
         FROM raw_material_qrs q
         JOIN inventory_items ii ON ii.id = q.item_id
         LEFT JOIN inventory_units u ON u.id = COALESCE(q.packing_unit_id, ii.packing_unit_id)
         WHERE ${where}
         ORDER BY q.created_at DESC, q.sequence DESC
         LIMIT ?`
      )
      .all(...params) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      qrId: String(row.id),
      article: String(row.display_name),
      color: "",
      size: this.rawMaterialPackingLabel(row),
      sequence: Number(row.sequence),
      batchId: String(row.batch_id),
      registeredAt: String(row.created_at),
      stage: this.rawMaterialStageOf(String(row.status), String(row.current_status)),
      lastActivityAt: String(row.updated_at ?? row.created_at),
    }));
  },

  // ─── Raw Material Input sessions ───────────────────────────────────────────────
  // A session is one supplier's delivery being received at one terminal. It exists so every
  // scan can be checked against the supplier, and so the storekeeper can print exactly what
  // that delivery contained when they close it.

  mapRawMaterialSession(row: Record<string, unknown>): RawMaterialReceivingSession {
    const sessionNumber = Number(row.session_number);
    return {
      id: String(row.id),
      code: `RMI-${String(sessionNumber).padStart(6, "0")}`,
      sessionNumber,
      partyId: String(row.party_id),
      partyName: String(row.party_name ?? ""),
      deviceId: String(row.device_id),
      startedBy: row.started_by ? String(row.started_by) : null,
      status: row.status === "CLOSED" ? "CLOSED" : "OPEN",
      startedAt: String(row.started_at),
      closedAt: row.closed_at ? String(row.closed_at) : null,
    };
  },

  /**
   * Opens a receiving session for one supplier. Any session still open on this terminal is
   * closed first: a storekeeper can only be unloading one delivery at a time, and leaving
   * an old one open would let packets land in the wrong delivery.
   */
  startRawMaterialReceivingSession(
    this: SqliteDatabase,
    input: { partyId: string; deviceId: string; startedBy?: string | null }
  ): RawMaterialReceivingSession {
    const partyId = String(input.partyId ?? "").trim();
    const deviceId = String(input.deviceId ?? "").trim();
    if (!partyId) throw new Error("Choose the supplier whose delivery you are receiving.");
    if (!deviceId) throw new Error("Device is required to start a receiving session.");

    const party = this.db
      .prepare("SELECT id FROM parties WHERE id = ? AND deleted_at IS NULL LIMIT 1")
      .get(partyId) as { id: string } | undefined;
    if (!party) throw new Error("That supplier was not found.");

    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.db
        .prepare("UPDATE raw_material_receiving_sessions SET status = 'CLOSED', closed_at = ?, updated_at = ? WHERE device_id = ? AND status = 'OPEN'")
        .run(now, now, deviceId);

      const next = allocateNumberInRange(this, "rmReceivingSession");
      const id = crypto.randomUUID();
      this.db
        .prepare(
          `INSERT INTO raw_material_receiving_sessions
             (id, session_number, party_id, device_id, started_by, status, started_at, closed_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'OPEN', ?, NULL, ?, ?)`
        )
        .run(id, next, partyId, deviceId, input.startedBy?.trim() || null, now, now, now);
      this.db.exec("COMMIT");

      return this.getRawMaterialReceivingSession(id)!;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }
  },

  getRawMaterialReceivingSession(this: SqliteDatabase, sessionId: string): RawMaterialReceivingSession | null {
    const row = this.db
      .prepare(
        `SELECT s.*, p.party_name FROM raw_material_receiving_sessions s
         JOIN parties p ON p.id = s.party_id
         WHERE s.id = ? LIMIT 1`
      )
      .get(String(sessionId ?? "").trim()) as Record<string, unknown> | undefined;
    return row ? this.mapRawMaterialSession(row) : null;
  },

  /** The session this terminal is currently receiving into, if any. */
  getOpenRawMaterialReceivingSession(this: SqliteDatabase, deviceId: string): RawMaterialReceivingSession | null {
    const row = this.db
      .prepare(
        `SELECT s.*, p.party_name FROM raw_material_receiving_sessions s
         JOIN parties p ON p.id = s.party_id
         WHERE s.device_id = ? AND s.status = 'OPEN'
         ORDER BY s.started_at DESC LIMIT 1`
      )
      .get(String(deviceId ?? "").trim()) as Record<string, unknown> | undefined;
    return row ? this.mapRawMaterialSession(row) : null;
  },

  closeRawMaterialReceivingSession(this: SqliteDatabase, sessionId: string): RawMaterialReceivingSession | null {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE raw_material_receiving_sessions SET status = 'CLOSED', closed_at = ?, updated_at = ? WHERE id = ? AND status = 'OPEN'")
      .run(now, now, String(sessionId ?? "").trim());
    return this.getRawMaterialReceivingSession(sessionId);
  },

  /**
   * Everything received in one session, for the on-screen list and the printed receipt.
   * Derived from the movement events that carry the session id — nothing is tallied
   * separately, so the print and the journey can never disagree.
   */
  getRawMaterialReceivingSessionSummary(this: SqliteDatabase, sessionId: string): RawMaterialReceivingSessionSummary | null {
    const session = this.getRawMaterialReceivingSession(sessionId);
    if (!session) return null;

    const scans = this.db
      .prepare(
        `SELECT e.qr_id, e.item_display_name, e.quantity, e.event_ts_local, e.actor, u.code AS unit_code
         FROM raw_material_qr_events e
         LEFT JOIN inventory_units u ON u.id = e.unit_id
         WHERE e.session_id = ? AND e.event_type = 'STORE_ENTRY'
         ORDER BY e.event_ts_local ASC, e.rowid ASC`
      )
      .all(session.id) as Array<Record<string, unknown>>;

    const byMaterial = new Map<string, { itemDisplayName: string; packets: number; quantity: number; unitCode: string }>();
    for (const scan of scans) {
      const name = String(scan.item_display_name);
      const unitCode = scan.unit_code ? String(scan.unit_code) : "";
      const key = `${name}|${unitCode}`;
      const existing = byMaterial.get(key);
      if (existing) {
        existing.packets += 1;
        existing.quantity += Number(scan.quantity);
      } else {
        byMaterial.set(key, { itemDisplayName: name, packets: 1, quantity: Number(scan.quantity), unitCode });
      }
    }

    return {
      session,
      totalPackets: scans.length,
      byMaterial: [...byMaterial.values()].sort((a, b) => a.itemDisplayName.localeCompare(b.itemDisplayName)),
      scans: scans.map((scan) => ({
        qrId: String(scan.qr_id),
        itemDisplayName: String(scan.item_display_name),
        quantity: Number(scan.quantity),
        unitCode: scan.unit_code ? String(scan.unit_code) : "",
        receivedAt: String(scan.event_ts_local),
        actor: scan.actor ? String(scan.actor) : null,
      })),
    };
  },

  /**
   * Sessions for the Deliveries history: every delivery received, or just the open/closed
   * ones, one supplier's, or one calendar-day window's — so a delivery received earlier can
   * be found and reprinted, and an open one can be found and continued. `dateFrom`/`dateTo`
   * are local calendar days (as the date picker gives them); `started_at` is a UTC instant,
   * so the boundary is converted through `localDayStartIso` rather than compared as text.
   */
  listRawMaterialReceivingSessions(
    this: SqliteDatabase,
    filters: { status?: "OPEN" | "CLOSED"; partyId?: string; dateFrom?: string; dateTo?: string; limit?: number } = {}
  ): RawMaterialReceivingSession[] {
    const limit = Math.max(1, Math.min(Math.trunc(filters.limit ?? 200), 1000));
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filters.status) {
      where.push("s.status = ?");
      params.push(filters.status);
    }
    if (filters.partyId) {
      where.push("s.party_id = ?");
      params.push(filters.partyId);
    }
    const fromIso = filters.dateFrom ? this.localDayStartIso(filters.dateFrom) : null;
    const toIso = filters.dateTo ? this.localDayStartIso(filters.dateTo, 1) : null;
    if (fromIso) {
      where.push("s.started_at >= ?");
      params.push(fromIso);
    }
    if (toIso) {
      where.push("s.started_at < ?");
      params.push(toIso);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    params.push(limit);

    const rows = this.db
      .prepare(
        `SELECT s.*, p.party_name FROM raw_material_receiving_sessions s
         JOIN parties p ON p.id = s.party_id
         ${whereClause}
         ORDER BY s.started_at DESC LIMIT ?`
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRawMaterialSession(row));
  },

  // ─── Raw Material Output sessions ──────────────────────────────────────────────
  // The mirror of receiving, minus the supplier: where a packet goes is a property of its
  // material, so an issue session is only an operational grouping for one terminal's run.

  mapRawMaterialIssueSession(row: Record<string, unknown>): RawMaterialIssueSession {
    const sessionNumber = Number(row.session_number);
    return {
      id: String(row.id),
      code: `RMO-${String(sessionNumber).padStart(6, "0")}`,
      sessionNumber,
      deviceId: String(row.device_id),
      startedBy: row.started_by ? String(row.started_by) : null,
      status: row.status === "CLOSED" ? "CLOSED" : "OPEN",
      startedAt: String(row.started_at),
      closedAt: row.closed_at ? String(row.closed_at) : null,
    };
  },

  /**
   * The session this terminal issues into. Reopening the station on the same local day
   * resumes its open session rather than starting a new one; an open session left over
   * from an earlier day is closed and a fresh one started, so a run means one day's work.
   */
  startOrResumeRawMaterialIssueSession(
    this: SqliteDatabase,
    input: { deviceId: string; startedBy?: string | null; startNew?: boolean }
  ): RawMaterialIssueSession {
    const deviceId = String(input.deviceId ?? "").trim();
    if (!deviceId) throw new Error("Device is required to start an issue session.");

    if (!input.startNew) {
      const open = this.db
        .prepare("SELECT * FROM raw_material_issue_sessions WHERE device_id = ? AND status = 'OPEN' ORDER BY started_at DESC LIMIT 1")
        .get(deviceId) as Record<string, unknown> | undefined;
      if (open) {
        const todayStart = this.localDayStartIso(this.localYmd(new Date()));
        if (todayStart && String(open.started_at) >= todayStart) {
          return this.mapRawMaterialIssueSession(open);
        }
      }
    }

    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.db
        .prepare("UPDATE raw_material_issue_sessions SET status = 'CLOSED', closed_at = ?, updated_at = ? WHERE device_id = ? AND status = 'OPEN'")
        .run(now, now, deviceId);

      const next = allocateNumberInRange(this, "rmIssueSession");
      const id = crypto.randomUUID();
      this.db
        .prepare(
          `INSERT INTO raw_material_issue_sessions
             (id, session_number, device_id, started_by, status, started_at, closed_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'OPEN', ?, NULL, ?, ?)`
        )
        .run(id, next, deviceId, input.startedBy?.trim() || null, now, now, now);
      this.db.exec("COMMIT");

      return this.getRawMaterialIssueSession(id)!;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }
  },

  getRawMaterialIssueSession(this: SqliteDatabase, sessionId: string): RawMaterialIssueSession | null {
    const row = this.db
      .prepare("SELECT * FROM raw_material_issue_sessions WHERE id = ? LIMIT 1")
      .get(String(sessionId ?? "").trim()) as Record<string, unknown> | undefined;
    return row ? this.mapRawMaterialIssueSession(row) : null;
  },

  closeRawMaterialIssueSession(this: SqliteDatabase, sessionId: string): RawMaterialIssueSession | null {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE raw_material_issue_sessions SET status = 'CLOSED', closed_at = ?, updated_at = ? WHERE id = ? AND status = 'OPEN'")
      .run(now, now, String(sessionId ?? "").trim());
    return this.getRawMaterialIssueSession(sessionId);
  },

  /**
   * Everything issued in one session, for the on-screen list and the printed slip. Grouped
   * by destination first, because that is how the slip is read: one section at a time.
   */
  getRawMaterialIssueSessionSummary(this: SqliteDatabase, sessionId: string): RawMaterialIssueSessionSummary | null {
    const session = this.getRawMaterialIssueSession(sessionId);
    if (!session) return null;

    const rows = this.db
      .prepare(
        `SELECT e.qr_id, e.item_display_name, e.quantity, e.event_ts_local, e.actor,
                u.code AS unit_code, ws.name AS section_name
         FROM raw_material_qr_events e
         LEFT JOIN inventory_units u ON u.id = e.unit_id
         LEFT JOIN work_sections ws ON ws.id = e.section_id
         WHERE e.session_id = ? AND e.event_type = 'STORE_EXIT'
         ORDER BY e.event_ts_local ASC, e.rowid ASC`
      )
      .all(session.id) as Array<Record<string, unknown>>;

    const bySection = new Map<
      string,
      { sectionName: string; packets: number; materials: Map<string, { itemDisplayName: string; packets: number; quantity: number; unitCode: string }> }
    >();

    for (const row of rows) {
      // Nothing carries a destination since routes were removed, so the slip is one list.
      const sectionName = row.section_name ? String(row.section_name) : "Out of the store";
      const name = String(row.item_display_name);
      const unitCode = row.unit_code ? String(row.unit_code) : "";
      const section = bySection.get(sectionName) ?? { sectionName, packets: 0, materials: new Map() };
      section.packets += 1;
      const material = section.materials.get(`${name}|${unitCode}`);
      if (material) {
        material.packets += 1;
        material.quantity += Number(row.quantity);
      } else {
        section.materials.set(`${name}|${unitCode}`, { itemDisplayName: name, packets: 1, quantity: Number(row.quantity), unitCode });
      }
      bySection.set(sectionName, section);
    }

    return {
      session,
      totalPackets: rows.length,
      bySection: [...bySection.values()]
        .sort((a, b) => a.sectionName.localeCompare(b.sectionName))
        .map((section) => ({
          sectionName: section.sectionName,
          packets: section.packets,
          materials: [...section.materials.values()].sort((a, b) => a.itemDisplayName.localeCompare(b.itemDisplayName)),
        })),
      scans: rows.map((row) => ({
        qrId: String(row.qr_id),
        itemDisplayName: String(row.item_display_name),
        quantity: Number(row.quantity),
        unitCode: row.unit_code ? String(row.unit_code) : "",
        sectionName: row.section_name ? String(row.section_name) : null,
        issuedAt: String(row.event_ts_local),
        actor: row.actor ? String(row.actor) : null,
      })),
    };
  },
};

export type RawMaterialQrMethods = typeof rawMaterialQrMethods;
