// Store station: receiving (Move In), move-out (To Gate) and their daily sessions.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").
// `this` is the database instance; bodies are unchanged from the original class.

import type { SqliteDatabase } from "../sqliteDatabase.js";
import { GATE_LOCATION_TYPE, IN_STORE_LOCATION_TYPE, IN_STORE_STATUS, StoreEntryRejectedError, StoreExitRejectedError, TO_GATE_STATUS } from "@erp/application";
import type { ScanOperationalContext, StoreEntryEventPayload, StoreEntryQrRecord, StoreExitEventPayload, StoreExitQrRecord, TransactionContext } from "@erp/application";
import { businessHourOf } from "@erp/domain";
import { STORE_SESSION_TABLES } from "./shared.js";
import type { MutableTransactionContext, StoreSessionKind } from "./shared.js";
import type { StoreMoveOutSession, StoreMoveOutSessionSummary, StoreMovedOutRow, StoreReceivedRow, StoreReceivingSession, StoreReceivingSessionSummary } from "./types.js";
import { allocateNumberInRange } from "./numberRange.js";

export const storeMethods = {
  async getQrForStoreEntry(this: SqliteDatabase, qrId: string, tx: TransactionContext): Promise<StoreEntryQrRecord | null> {
    const context = tx as MutableTransactionContext;
    const row = context.db
      .prepare(
        `SELECT qm.qr_id, qm.product_variant_id, qm.current_status, qm.current_location_type, qm.current_location_id,
                pv.article, pv.color, pv.size
         FROM qr_master qm
         JOIN product_variants pv ON pv.id = qm.product_variant_id
         WHERE qm.qr_id = ? LIMIT 1`
      )
      .get(qrId) as
      | { qr_id: string; product_variant_id: string; current_status: string; current_location_type: string | null; current_location_id: string | null; article: string; color: string; size: string }
      | undefined;

    if (!row) return null;

    return {
      qrId: String(row.qr_id),
      productVariantId: String(row.product_variant_id),
      currentStatus: String(row.current_status),
      currentLocationType: String(row.current_location_type ?? "FACTORY"),
      currentLocationId: row.current_location_id ? String(row.current_location_id) : null,
      article: String(row.article),
      color: String(row.color),
      size: String(row.size),
    };
  },

  /**
   * Guarded status move. The WHERE clause is the concurrency protection: two terminals
   * that both read the unit as PRODUCED will both reach this update, but only the first
   * changes a row; the second sees zero changes and is rejected without writing anything.
   */
  async markInStore(this: SqliteDatabase, payload: { qrId: string; locationId: string; updatedAt: string }, tx: TransactionContext): Promise<void> {
    const context = tx as MutableTransactionContext;
    const result = context.db
      .prepare(
        `UPDATE qr_master
         SET current_status = ?, current_location_type = ?, current_location_id = ?, updated_at = ?
         WHERE qr_id = ? AND current_status IN ('PRODUCED','RETURNED','ON_GATE','TO_GATE')`
      )
      .run(IN_STORE_STATUS, IN_STORE_LOCATION_TYPE, payload.locationId, payload.updatedAt, payload.qrId);

    if (result.changes === 0) {
      const current = context.db
        .prepare("SELECT current_status FROM qr_master WHERE qr_id = ? LIMIT 1")
        .get(payload.qrId) as { current_status?: string } | undefined;
      if (current?.current_status === IN_STORE_STATUS) {
        throw new StoreEntryRejectedError("ALREADY_IN_STORE", "This carton has already been received.", {
          previousStatus: current.current_status,
          currentStatus: current.current_status,
        });
      }
      throw new StoreEntryRejectedError(
        "STATUS_CHANGED",
        "This carton's status changed while it was being received. Scan it again to see its current status.",
        { previousStatus: current?.current_status ?? null, currentStatus: current?.current_status ?? null }
      );
    }
  },

  async appendStoreEntryEvent(this: SqliteDatabase, payload: StoreEntryEventPayload, tx: TransactionContext): Promise<void> {
    const context = tx as MutableTransactionContext;
    const eventDate = payload.occurredAt.slice(0, 10);
    const eventHour = businessHourOf(payload.occurredAt);

    // gatepass_id is set only for a bring-back from the gate: the compensating record for
    // the STORE_EXIT that took this carton out for that Gatepass (see database/gatepass.ts).
    const insertResult = context.db
      .prepare(
        `INSERT INTO production_events (
          id, qr_id, product_variant_id, event_type, event_ts_local, event_date, event_hour,
          factory_id, workstation_id, operator_id, device_id,
          article_snapshot, color_snapshot, size_snapshot, serial_snapshot,
          metadata_json, created_at, sync_status, synced_at, sync_error, retry_count, source_app, gatepass_id
        ) VALUES (?, ?, ?, 'MOVED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL, NULL, 0, 'desktop-store-scanner', ?)`
      )
      .run(
        payload.eventId,
        payload.qrId,
        payload.productVariantId,
        payload.occurredAt,
        eventDate,
        eventHour,
        payload.factoryId,
        payload.workstationId,
        payload.operatorId ?? null,
        payload.deviceId,
        payload.article,
        payload.color,
        payload.size,
        payload.serial,
        JSON.stringify({
          parserVersion: payload.parserVersion,
          eventType: "STORE_ENTRY",
          previousStatus: payload.previousStatus,
          newStatus: IN_STORE_STATUS,
          fromLocationType: payload.fromLocationType,
          fromLocationId: payload.fromLocationId,
          toLocationType: payload.toLocationType,
          toLocationId: payload.toLocationId,
          actor: payload.actor ?? null,
          sessionId: payload.sessionId ?? null,
          gatepassId: payload.gatepassId ?? null,
        }),
        context.nowIso,
        payload.gatepassId ?? null
      );

    if (insertResult.changes === 0) {
      throw new Error("Store entry event insert failed.");
    }

    context.db
      .prepare("UPDATE qr_master SET first_event_id = COALESCE(first_event_id, ?), updated_at = ? WHERE qr_id = ?")
      .run(payload.eventId, context.nowIso, payload.qrId);
  },

  async moveStockToStore(this: SqliteDatabase, 
    payload: { productVariantId: string; fromLocationType: string; fromLocationId: string | null; toLocationId: string; occurredAt: string },
    operationalContext: ScanOperationalContext,
    tx: TransactionContext
  ): Promise<void> {
    const context = tx as MutableTransactionContext;

    // Still one unit on hand for the variant; only its location changes.
    context.db
      .prepare(
        `UPDATE stock_projection_by_variant SET last_event_ts = ?, updated_at = ? WHERE product_variant_id = ?`
      )
      .run(payload.occurredAt, context.nowIso, payload.productVariantId);

    // Units that predate location tracking carry UNKNOWN / NULL; they were at the factory.
    const fromType = payload.fromLocationType && payload.fromLocationType !== "UNKNOWN" ? payload.fromLocationType : "FACTORY";
    const fromId = payload.fromLocationId ?? operationalContext.factoryId;
    // The location projection carries no CHECK (>= 0); clamp rather than go negative on an already-drifted row.
    context.db
      .prepare(
        `UPDATE stock_projection_by_location
         SET quantity_on_hand = MAX(quantity_on_hand - 1, 0), updated_at = ?
         WHERE product_variant_id = ? AND location_type = ? AND location_id = ?`
      )
      .run(context.nowIso, payload.productVariantId, fromType, fromId);

    context.db
      .prepare(
        `INSERT INTO stock_projection_by_location (
          product_variant_id, location_type, location_id, quantity_on_hand, updated_at
        ) VALUES (?, ?, ?, 1, ?)
        ON CONFLICT(product_variant_id, location_type, location_id) DO UPDATE SET
          quantity_on_hand = quantity_on_hand + 1,
          updated_at = excluded.updated_at`
      )
      .run(payload.productVariantId, IN_STORE_LOCATION_TYPE, payload.toLocationId, context.nowIso);
  },

  /**
   * Receives a carton that is coming back from a customer (ON_GATE). Unlike moveStockToStore
   * this ADDS to the variant total: dispatch took that unit out of the pool and the recorded
   * return deliberately did not put it back, because the carton had not arrived yet. There is
   * no source location to debit — the unit was outside the company.
   *
   * This is the only place a returned carton re-enters physical stock.
   */
  async receiveReturnedStockIntoStore(this: SqliteDatabase,
    payload: { productVariantId: string; toLocationId: string; occurredAt: string },
    _operationalContext: ScanOperationalContext,
    tx: TransactionContext
  ): Promise<void> {
    const context = tx as MutableTransactionContext;

    const updated = context.db
      .prepare(
        `UPDATE stock_projection_by_variant
         SET quantity_on_hand = quantity_on_hand + 1, last_event_ts = ?, updated_at = ?
         WHERE product_variant_id = ?`
      )
      .run(payload.occurredAt, context.nowIso, payload.productVariantId);

    // A variant whose every unit had been dispatched may have no projection row left.
    if (updated.changes === 0) {
      context.db
        .prepare(
          `INSERT INTO stock_projection_by_variant (product_variant_id, quantity_on_hand, last_event_ts, updated_at)
           VALUES (?, 1, ?, ?)
           ON CONFLICT(product_variant_id) DO UPDATE SET
             quantity_on_hand = quantity_on_hand + 1,
             last_event_ts = excluded.last_event_ts,
             updated_at = excluded.updated_at`
        )
        .run(payload.productVariantId, payload.occurredAt, context.nowIso);
    }

    context.db
      .prepare(
        `INSERT INTO stock_projection_by_location (
          product_variant_id, location_type, location_id, quantity_on_hand, updated_at
        ) VALUES (?, ?, ?, 1, ?)
        ON CONFLICT(product_variant_id, location_type, location_id) DO UPDATE SET
          quantity_on_hand = quantity_on_hand + 1,
          updated_at = excluded.updated_at`
      )
      .run(payload.productVariantId, IN_STORE_LOCATION_TYPE, payload.toLocationId, context.nowIso);
  },

  async enqueueStoreEntry(this: SqliteDatabase, 
    payload: {
      outboxId: string;
      eventId: string;
      qrId: string;
      createdAt: string;
      parserVersion: string;
      factoryId: string;
      workstationId: string;
      deviceId: string;
      sessionId?: string;
    },
    tx: TransactionContext
  ): Promise<void> {
    const context = tx as MutableTransactionContext;
    // sync_outbox.aggregate_type is CHECK-constrained; like DAMAGED, a store entry travels as
    // a PRODUCTION_EVENT whose payload names the business event.
    const outboxPayload = {
      eventId: payload.eventId,
      qrId: payload.qrId,
      parserVersion: payload.parserVersion,
      factoryId: payload.factoryId,
      workstationId: payload.workstationId,
      deviceId: payload.deviceId,
      createdAt: payload.createdAt,
      eventType: "STORE_ENTRY",
      sessionId: payload.sessionId ?? null,
    };

    context.db
      .prepare(
        `INSERT INTO sync_outbox (
          id, aggregate_type, aggregate_id, operation, dedupe_key,
          payload_json, status, lock_token, available_at, attempts, last_error, created_at, updated_at
        ) VALUES (?, 'PRODUCTION_EVENT', ?, 'INSERT', ?, ?, 'PENDING', NULL, ?, 0, NULL, ?, ?)`
      )
      .run(
        payload.outboxId,
        payload.eventId,
        `PRODUCTION_EVENT:${payload.eventId}`,
        JSON.stringify(outboxPayload),
        payload.createdAt,
        payload.createdAt,
        payload.createdAt
      );
  },

  // ─── Store Move Out (store exit) ─────────────────────────────────────────────────
  // Repository side of StoreExitScanUseCase — the mirror of store entry above: qr_master
  // (WAREHOUSE → TO_GATE, location WAREHOUSE → GATE), a MOVED event whose metadata says
  // STORE_EXIT, stock_projection_by_location (WAREHOUSE −1, GATE +1) and sync_outbox. The
  // variant total in stock_projection_by_variant is untouched — the unit is still in stock,
  // it is just waiting at the gate to be dispatched.

  /** Same read as store entry: the live unit plus its variant identity. */
  getQrForStoreExit(this: SqliteDatabase, qrId: string, tx: TransactionContext): Promise<StoreExitQrRecord | null> {
    return this.getQrForStoreEntry(qrId, tx);
  },

  /**
   * Guarded status move, same concurrency shape as `markInStore`: only a unit that is still
   * In Store changes; a second terminal sees zero changes and is rejected without writing.
   */
  async markAtGate(this: SqliteDatabase, payload: { qrId: string; locationId: string; updatedAt: string }, tx: TransactionContext): Promise<void> {
    const context = tx as MutableTransactionContext;
    const result = context.db
      .prepare(
        `UPDATE qr_master
         SET current_status = ?, current_location_type = ?, current_location_id = ?, updated_at = ?
         WHERE qr_id = ? AND current_status = ?`
      )
      .run(TO_GATE_STATUS, GATE_LOCATION_TYPE, payload.locationId, payload.updatedAt, payload.qrId, IN_STORE_STATUS);

    if (result.changes === 0) {
      const current = context.db
        .prepare("SELECT current_status FROM qr_master WHERE qr_id = ? LIMIT 1")
        .get(payload.qrId) as { current_status?: string } | undefined;
      if (current?.current_status === TO_GATE_STATUS) {
        throw new StoreExitRejectedError("ALREADY_AT_GATE", "This carton has already been moved out to the gate.", {
          previousStatus: current.current_status,
          currentStatus: current.current_status,
        });
      }
      throw new StoreExitRejectedError(
        "STATUS_CHANGED",
        "This carton's status changed while it was being moved out. Scan it again to see its current status.",
        { previousStatus: current?.current_status ?? null, currentStatus: current?.current_status ?? null }
      );
    }
  },

  async appendStoreExitEvent(this: SqliteDatabase, payload: StoreExitEventPayload, tx: TransactionContext): Promise<void> {
    const context = tx as MutableTransactionContext;
    const eventDate = payload.occurredAt.slice(0, 10);
    const eventHour = businessHourOf(payload.occurredAt);

    // gatepass_id is the exact owner of this move-out (the Gatepass the operator selected),
    // the way dispatch_session_id owns a DISPATCHED event. It is what a Gatepass line's
    // "dispatched from store" is counted from (see database/gatepass.ts).
    const insertResult = context.db
      .prepare(
        `INSERT INTO production_events (
          id, qr_id, product_variant_id, event_type, event_ts_local, event_date, event_hour,
          factory_id, workstation_id, operator_id, device_id,
          article_snapshot, color_snapshot, size_snapshot, serial_snapshot,
          metadata_json, created_at, sync_status, synced_at, sync_error, retry_count, source_app, gatepass_id
        ) VALUES (?, ?, ?, 'MOVED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL, NULL, 0, 'desktop-store-scanner', ?)`
      )
      .run(
        payload.eventId,
        payload.qrId,
        payload.productVariantId,
        payload.occurredAt,
        eventDate,
        eventHour,
        payload.factoryId,
        payload.workstationId,
        payload.operatorId ?? null,
        payload.deviceId,
        payload.article,
        payload.color,
        payload.size,
        payload.serial,
        JSON.stringify({
          parserVersion: payload.parserVersion,
          eventType: "STORE_EXIT",
          previousStatus: payload.previousStatus,
          newStatus: TO_GATE_STATUS,
          fromLocationType: payload.fromLocationType,
          fromLocationId: payload.fromLocationId,
          toLocationType: payload.toLocationType,
          toLocationId: payload.toLocationId,
          actor: payload.actor ?? null,
          sessionId: payload.sessionId ?? null,
          gatepassId: payload.gatepassId ?? null,
        }),
        context.nowIso,
        payload.gatepassId ?? null
      );

    if (insertResult.changes === 0) {
      throw new Error("Store exit event insert failed.");
    }
  },

  async moveStockToGate(this: SqliteDatabase, 
    payload: { productVariantId: string; fromLocationType: string; fromLocationId: string | null; toLocationId: string; occurredAt: string },
    operationalContext: ScanOperationalContext,
    tx: TransactionContext
  ): Promise<void> {
    const context = tx as MutableTransactionContext;

    // Still one unit on hand for the variant; only its location changes.
    context.db
      .prepare(
        `UPDATE stock_projection_by_variant SET last_event_ts = ?, updated_at = ? WHERE product_variant_id = ?`
      )
      .run(payload.occurredAt, context.nowIso, payload.productVariantId);

    // A moved-out unit always comes from the store; fall back to it if the row predates location tracking.
    const fromType = payload.fromLocationType && payload.fromLocationType !== "UNKNOWN" ? payload.fromLocationType : IN_STORE_LOCATION_TYPE;
    const fromId = payload.fromLocationId ?? operationalContext.factoryId;
    // The location projection carries no CHECK (>= 0); clamp rather than go negative on an already-drifted row.
    context.db
      .prepare(
        `UPDATE stock_projection_by_location
         SET quantity_on_hand = MAX(quantity_on_hand - 1, 0), updated_at = ?
         WHERE product_variant_id = ? AND location_type = ? AND location_id = ?`
      )
      .run(context.nowIso, payload.productVariantId, fromType, fromId);

    context.db
      .prepare(
        `INSERT INTO stock_projection_by_location (
          product_variant_id, location_type, location_id, quantity_on_hand, updated_at
        ) VALUES (?, ?, ?, 1, ?)
        ON CONFLICT(product_variant_id, location_type, location_id) DO UPDATE SET
          quantity_on_hand = quantity_on_hand + 1,
          updated_at = excluded.updated_at`
      )
      .run(payload.productVariantId, GATE_LOCATION_TYPE, payload.toLocationId, context.nowIso);
  },

  async enqueueStoreExit(this: SqliteDatabase, 
    payload: {
      outboxId: string;
      eventId: string;
      qrId: string;
      createdAt: string;
      parserVersion: string;
      factoryId: string;
      workstationId: string;
      deviceId: string;
      sessionId?: string;
      gatepassId?: string | null;
    },
    tx: TransactionContext
  ): Promise<void> {
    const context = tx as MutableTransactionContext;
    // Like a store entry, a store exit travels as a PRODUCTION_EVENT whose payload names the business event.
    const outboxPayload = {
      eventId: payload.eventId,
      qrId: payload.qrId,
      parserVersion: payload.parserVersion,
      factoryId: payload.factoryId,
      workstationId: payload.workstationId,
      deviceId: payload.deviceId,
      createdAt: payload.createdAt,
      eventType: "STORE_EXIT",
      sessionId: payload.sessionId ?? null,
      gatepassId: payload.gatepassId ?? null,
    };

    context.db
      .prepare(
        `INSERT INTO sync_outbox (
          id, aggregate_type, aggregate_id, operation, dedupe_key,
          payload_json, status, lock_token, available_at, attempts, last_error, created_at, updated_at
        ) VALUES (?, 'PRODUCTION_EVENT', ?, 'INSERT', ?, ?, 'PENDING', NULL, ?, 0, NULL, ?, ?)`
      )
      .run(
        payload.outboxId,
        payload.eventId,
        `PRODUCTION_EVENT:${payload.eventId}`,
        JSON.stringify(outboxPayload),
        payload.createdAt,
        payload.createdAt,
        payload.createdAt
      );
  },

  // ─── Store sessions (receiving + move-out) ──────────────────────────────────────
  // Both stations keep one open session per device. The two tables share a shape and the
  // same rules, so the logic lives once and is keyed by the station kind.

  storeSessionCode(this: SqliteDatabase, kind: StoreSessionKind, sessionNumber: number): string {
    return `${STORE_SESSION_TABLES[kind].prefix}-${String(sessionNumber).padStart(6, "0")}`;
  },

  mapStoreSession(this: SqliteDatabase, kind: StoreSessionKind, row: Record<string, unknown>): StoreReceivingSession {
    const sessionNumber = Number(row.session_number);
    return {
      id: String(row.id),
      code: this.storeSessionCode(kind, sessionNumber),
      sessionNumber,
      deviceId: String(row.device_id),
      startedBy: row.started_by ? String(row.started_by) : null,
      status: row.status === "CLOSED" ? "CLOSED" : "OPEN",
      startedAt: String(row.started_at),
      closedAt: row.closed_at ? String(row.closed_at) : null,
    };
  },

  /**
   * The session a terminal scans into. Reopening the station during the same local day
   * resumes the device's open session rather than starting a new one; an open session from
   * an earlier day is closed and a fresh one started.
   */
  startOrResumeStoreSession(this: SqliteDatabase, kind: StoreSessionKind, input: { deviceId: string; startedBy?: string | null }): StoreReceivingSession {
    const { table, noun } = STORE_SESSION_TABLES[kind];
    const deviceId = String(input.deviceId ?? "").trim();
    if (!deviceId) throw new Error(`Device is required to start a ${noun} session.`);

    const open = this.db
      .prepare(`SELECT * FROM ${table} WHERE device_id = ? AND status = 'OPEN' ORDER BY started_at DESC LIMIT 1`)
      .get(deviceId) as Record<string, unknown> | undefined;

    if (open) {
      const todayStart = this.localDayStartIso(this.localYmd(new Date()));
      if (todayStart && String(open.started_at) >= todayStart) {
        return this.mapStoreSession(kind, open);
      }
    }

    return this.startNewStoreSession(kind, input);
  },

  /** Closes any open session on this device and starts a new one. */
  startNewStoreSession(this: SqliteDatabase, kind: StoreSessionKind, input: { deviceId: string; startedBy?: string | null }): StoreReceivingSession {
    const { table, noun } = STORE_SESSION_TABLES[kind];
    const deviceId = String(input.deviceId ?? "").trim();
    if (!deviceId) throw new Error(`Device is required to start a ${noun} session.`);
    const now = new Date().toISOString();

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.db
        .prepare(`UPDATE ${table} SET status = 'CLOSED', closed_at = ?, updated_at = ? WHERE device_id = ? AND status = 'OPEN'`)
        .run(now, now, deviceId);

      const next = allocateNumberInRange(this, kind === "receiving" ? "storeReceivingSession" : "storeMoveOutSession");
      const id = crypto.randomUUID();
      this.db
        .prepare(
          `INSERT INTO ${table} (id, session_number, device_id, started_by, status, started_at, closed_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'OPEN', ?, NULL, ?, ?)`
        )
        .run(id, next, deviceId, input.startedBy?.trim() || null, now, now, now);
      this.db.exec("COMMIT");

      const row = this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown>;
      return this.mapStoreSession(kind, row);
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }
  },

  getStoreSession(this: SqliteDatabase, kind: StoreSessionKind, sessionId: string): StoreReceivingSession | null {
    const row = this.db
      .prepare(`SELECT * FROM ${STORE_SESSION_TABLES[kind].table} WHERE id = ? LIMIT 1`)
      .get(String(sessionId ?? "").trim()) as Record<string, unknown> | undefined;
    return row ? this.mapStoreSession(kind, row) : null;
  },

  /**
   * What a session did, computed from the MOVED events of the given business sub-kind that
   * carry its id. Bounded by the session's start day so the (event_type, event_date) index
   * keeps this cheap however long the event log grows.
   */
  summariseStoreSession(this: SqliteDatabase, 
    session: StoreReceivingSession,
    eventSubType: "STORE_ENTRY" | "STORE_EXIT",
    recentLimit: number
  ): { count: number; byProduct: StoreReceivingSessionSummary["byProduct"]; recent: StoreReceivedRow[] } {
    const startDate = session.startedAt.slice(0, 10);

    const scope = `pe.event_type = 'MOVED' AND pe.event_date >= ? AND json_extract(pe.metadata_json, '$.eventType') = ? AND json_extract(pe.metadata_json, '$.sessionId') = ?`;
    const scopeArgs: Array<string | number> = [startDate, eventSubType, session.id];

    const count = this.scalarCount(`SELECT COUNT(1) AS c FROM production_events pe WHERE ${scope}`, scopeArgs);

    const byProduct = (
      this.db
        .prepare(
          `SELECT pe.article_snapshot AS article, pe.color_snapshot AS color, pe.size_snapshot AS size, COUNT(1) AS count
           FROM production_events pe
           WHERE ${scope}
           GROUP BY pe.article_snapshot, pe.color_snapshot, pe.size_snapshot
           ORDER BY count DESC, article ASC, color ASC, size ASC`
        )
        .all(...scopeArgs) as Array<Record<string, unknown>>
    ).map((row) => ({
      article: String(row.article ?? ""),
      color: String(row.color ?? ""),
      size: String(row.size ?? ""),
      count: Number(row.count ?? 0),
    }));

    const recent = (
      this.db
        .prepare(
          `SELECT pe.id, pe.qr_id, pe.article_snapshot, pe.color_snapshot, pe.size_snapshot, pe.serial_snapshot,
                  pe.event_ts_local, json_extract(pe.metadata_json, '$.actor') AS actor
           FROM production_events pe
           WHERE ${scope}
           ORDER BY pe.event_ts_local DESC, pe.created_at DESC
           LIMIT ?`
        )
        .all(...scopeArgs, recentLimit) as Array<Record<string, unknown>>
    ).map((row) => ({
      eventId: String(row.id),
      qrId: String(row.qr_id ?? ""),
      article: String(row.article_snapshot ?? ""),
      color: String(row.color_snapshot ?? ""),
      size: String(row.size_snapshot ?? ""),
      serial: String(row.serial_snapshot ?? ""),
      receivedAt: String(row.event_ts_local ?? ""),
      actor: row.actor ? String(row.actor) : null,
    }));

    return { count, byProduct, recent };
  },

  clampRecentLimit(this: SqliteDatabase, limit: number | undefined): number {
    return Math.max(1, Math.min(limit ?? 15, 100));
  },

  startOrResumeStoreReceivingSession(this: SqliteDatabase, input: { deviceId: string; startedBy?: string | null }): StoreReceivingSession {
    return this.startOrResumeStoreSession("receiving", input);
  },

  startNewStoreReceivingSession(this: SqliteDatabase, input: { deviceId: string; startedBy?: string | null }): StoreReceivingSession {
    return this.startNewStoreSession("receiving", input);
  },

  getStoreReceivingSession(this: SqliteDatabase, sessionId: string): StoreReceivingSession | null {
    return this.getStoreSession("receiving", sessionId);
  },

  /** What was received in a session, from the STORE_ENTRY events that carry its id. */
  getStoreReceivingSessionSummary(this: SqliteDatabase, sessionId: string, opts: { recentLimit?: number } = {}): StoreReceivingSessionSummary | null {
    const session = this.getStoreReceivingSession(sessionId);
    if (!session) return null;
    const { count, byProduct, recent } = this.summariseStoreSession(session, "STORE_ENTRY", this.clampRecentLimit(opts.recentLimit));
    return { session, receivedCount: count, byProduct, recent, lastReceived: recent[0] ?? null };
  },

  startOrResumeStoreMoveOutSession(this: SqliteDatabase, input: { deviceId: string; startedBy?: string | null }): StoreMoveOutSession {
    return this.startOrResumeStoreSession("move-out", input);
  },

  startNewStoreMoveOutSession(this: SqliteDatabase, input: { deviceId: string; startedBy?: string | null }): StoreMoveOutSession {
    return this.startNewStoreSession("move-out", input);
  },

  getStoreMoveOutSession(this: SqliteDatabase, sessionId: string): StoreMoveOutSession | null {
    return this.getStoreSession("move-out", sessionId);
  },

  /** What was moved out in a session, from the STORE_EXIT events that carry its id. */
  getStoreMoveOutSessionSummary(this: SqliteDatabase, sessionId: string, opts: { recentLimit?: number } = {}): StoreMoveOutSessionSummary | null {
    const session = this.getStoreMoveOutSession(sessionId);
    if (!session) return null;
    const { count, byProduct, recent } = this.summariseStoreSession(session, "STORE_EXIT", this.clampRecentLimit(opts.recentLimit));
    const movedOut: StoreMovedOutRow[] = recent.map(({ receivedAt, ...row }) => ({ ...row, movedOutAt: receivedAt }));
    return { session, movedOutCount: count, byProduct, recent: movedOut, lastMovedOut: movedOut[0] ?? null };
  },

  // ─── Gatepass ────────────────────────────────────────────────────────────────────
  // Repository side of CreateGatepassUseCase / CancelGatepassUseCase. Writes only
  // gatepasses, gatepass_lines and audit_log. Reads the store stock from the same
  // stock_projection_by_location rows Store Move In / Move Out maintain — never from a
  // separate tally — and never changes them.
};

export type StoreMethods = typeof storeMethods;
