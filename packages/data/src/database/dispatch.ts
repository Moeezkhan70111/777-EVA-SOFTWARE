// Dispatch and return scans, per-location stock moves, dispatch sessions (bill allowance in cartons).
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").
// `this` is the database instance; bodies are unchanged from the original class.

import type { SqliteDatabase } from "../sqliteDatabase.js";
import type { DispatchAllowance, DispatchSessionDetail, DispatchSessionSummary, HistoryQuery, HistoryRow, PagedResult } from "./types.js";
import { orderBy } from "./shared.js";
import type { MutableTransactionContext } from "./shared.js";
import { ON_GATE_LOCATION_TYPE, ON_GATE_STATUS, RETURNABLE_STATUS, ReturnRejectedError } from "@erp/application";
import type { DispatchAttribution, ReturnEventPayload, ReturnQrRecord, ScanOperationalContext, StockLocationRef, TransactionContext } from "@erp/application";
import { businessHourOf, cartonReturnCredit, cartonsToPairs, dozensToCartons, dozensToPairs, fromPaisa } from "@erp/domain";

export const dispatchMethods = {
  // A read must not mutate historical data. This used to also "self-heal" by reversing a
  // DISPATCHED event it guessed belonged to a since-deleted voucher (by article + size + a
  // timestamp bound — the same ambiguous heuristic deleteSaleVoucher used to use). That ran
  // on every dispatch scan, with no ordering guarantee against a QR's other DISPATCHED
  // events, and could phantom-credit stock. Reversal now happens exactly and only as part of
  // voucher cancellation (see deleteSaleVoucher / reverseDispatchedEvent), which knows the
  // exact dispatch_session_id instead of guessing. If a QR's state here is stale or wrong,
  // that is surfaced by the normal status checks in DispatchScanUseCase (e.g. "ERROR:
  // PRODUCT HAS ALREADY BEEN DISPATCHED"), never silently corrected by a lookup.
  async getQrForDispatch(this: SqliteDatabase, qrId: string, tx: TransactionContext): Promise<{ qrId: string; productVariantId: string; currentStatus: string; article: string; color: string; size: string; stockOnHand: number; currentLocationType: string; currentLocationId: string | null } | null> {
    const context = tx as MutableTransactionContext;
    const row = context.db
      .prepare(
        `SELECT qm.qr_id, qm.product_variant_id, qm.current_status, qm.current_location_type, qm.current_location_id,
                pv.article, pv.color, pv.size,
                COALESCE(spv.quantity_on_hand, 0) as stock_on_hand
         FROM qr_master qm
         JOIN product_variants pv ON pv.id = qm.product_variant_id
         LEFT JOIN stock_projection_by_variant spv ON spv.product_variant_id = qm.product_variant_id
         WHERE qm.qr_id = ? LIMIT 1`
      )
      .get(qrId) as
      | { qr_id: string; product_variant_id: string; current_status: string; current_location_type: string | null; current_location_id: string | null; article: string; color: string; size: string; stock_on_hand: number }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      qrId: String(row.qr_id),
      productVariantId: String(row.product_variant_id),
      currentStatus: String(row.current_status),
      article: String(row.article),
      color: String(row.color),
      size: String(row.size),
      stockOnHand: Number(row.stock_on_hand ?? 0),
      currentLocationType: String(row.current_location_type ?? "FACTORY"),
      currentLocationId: row.current_location_id ? String(row.current_location_id) : null,
    };
  },

  async getQrForReturn(this: SqliteDatabase, qrId: string, tx: TransactionContext): Promise<ReturnQrRecord | null> {
    const context = tx as MutableTransactionContext;
    const row = context.db
      .prepare(
        `SELECT qm.qr_id, qm.product_variant_id, qm.current_status, pv.article, pv.color, pv.size
         FROM qr_master qm
         JOIN product_variants pv ON pv.id = qm.product_variant_id
         WHERE qm.qr_id = ? LIMIT 1`
      )
      .get(qrId) as
      | { qr_id: string; product_variant_id: string; current_status: string; article: string; color: string; size: string }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      qrId: String(row.qr_id),
      productVariantId: String(row.product_variant_id),
      currentStatus: String(row.current_status),
      article: String(row.article),
      color: String(row.color),
      size: String(row.size),
    };
  },

  /**
   * Who a carton is currently out with, read from its own latest DISPATCHED event — the
   * exact chain migration 028 recorded: event → dispatch_session_id → session → voucher →
   * party. Nothing here is inferred from article, colour, size or a timestamp window.
   *
   * "Current" is the newest dispatch, so a carton that has been out, come back and gone out
   * again resolves to whoever has it NOW; the earlier parties stay in history and can never
   * be credited a second time.
   *
   * The rate is read from the voucher line this carton was sold on — matched by article and
   * size, which is how a bill is written (a line is an article + size, colour is not part of
   * a bill) and how the dispatch allowance already picks a line within the same session. The
   * session narrows it to one voucher first, so this is a choice within one bill, never
   * across bills. A dispatch made with no bill selected has no session and resolves to null,
   * which the use case refuses rather than guessing a party.
   */
  async findActiveDispatchAttribution(this: SqliteDatabase, qrId: string, tx: TransactionContext): Promise<DispatchAttribution | null> {
    const context = tx as MutableTransactionContext;
    const row = context.db
      .prepare(
        `SELECT pe.id AS dispatch_event_id, pe.event_ts_local, pe.dispatch_session_id,
                pe.article_snapshot, pe.size_snapshot,
                sv.id AS voucher_id, sv.voucher_number,
                p.id AS party_id, p.party_name
         FROM production_events pe
         JOIN dispatch_sessions ds ON ds.id = pe.dispatch_session_id
         JOIN sale_vouchers sv ON sv.id = ds.voucher_id AND sv.deleted_at IS NULL
         JOIN parties p ON p.id = sv.party_id
         WHERE pe.qr_id = ? AND pe.event_type = 'DISPATCHED'
         ORDER BY pe.event_ts_local DESC, pe.created_at DESC
         LIMIT 1`
      )
      .get(qrId) as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    // The bill line this carton was sold on. Colour is deliberately not part of the match.
    const line = context.db
      .prepare(
        `SELECT svli.id, svli.unit_price_paisa, svli.discount_per_pair_paisa
         FROM sale_voucher_line_items svli
         JOIN product_variants pv ON pv.id = svli.product_variant_id
         WHERE svli.voucher_id = ? AND svli.deleted_at IS NULL AND pv.article = ? AND pv.size = ?
         ORDER BY svli.created_at ASC
         LIMIT 1`
      )
      .get(String(row.voucher_id ?? ""), String(row.article_snapshot ?? ""), String(row.size_snapshot ?? "")) as
      | { id: string; unit_price_paisa: number; discount_per_pair_paisa: number }
      | undefined;

    const unitPrice = fromPaisa(Number(line?.unit_price_paisa ?? 0));
    const discountPerPair = fromPaisa(Number(line?.discount_per_pair_paisa ?? 0));

    return {
      dispatchEventId: String(row.dispatch_event_id ?? ""),
      dispatchedAt: String(row.event_ts_local ?? ""),
      dispatchSessionId: row.dispatch_session_id ? String(row.dispatch_session_id) : null,
      partyId: String(row.party_id ?? ""),
      partyName: String(row.party_name ?? ""),
      saleVoucherId: row.voucher_id ? String(row.voucher_id) : null,
      saleVoucherNumber: row.voucher_number ? String(row.voucher_number) : null,
      saleVoucherLineItemId: line ? String(line.id) : null,
      unitPrice,
      discountPerPair,
      creditAmount: cartonReturnCredit({ pairRate: unitPrice, pairDiscount: discountPerPair }),
    };
  },

  async markDispatched(this: SqliteDatabase, qrId: string, updatedAt: string, tx: TransactionContext): Promise<void> {
    const context = tx as MutableTransactionContext;
    const row = context.db
      .prepare("SELECT 1 as ok FROM qr_master WHERE qr_id = ? AND current_status IN ('DISPATCHED','SOLD','DAMAGED','SCRAPPED') LIMIT 1")
      .get(qrId) as { ok: number } | undefined;

    if (row) {
      throw new Error("ERROR: PRODUCT HAS ALREADY BEEN DISPATCHED");
    }

    const updateResult = context.db
      .prepare("UPDATE qr_master SET current_status = 'DISPATCHED', updated_at = ? WHERE qr_id = ?")
      .run(updatedAt, qrId);

    if (updateResult.changes === 0) {
      throw new Error("ERROR: PRODUCT WAS NEVER PRODUCED");
    }
  },

  async decrementStock(this: SqliteDatabase, 
    productVariantId: string,
    occurredAt: string,
    operationalContext: ScanOperationalContext,
    tx: TransactionContext,
    from?: StockLocationRef
  ): Promise<void> {
    const context = tx as MutableTransactionContext;

    const result = context.db
      .prepare(
        `UPDATE stock_projection_by_variant
         SET quantity_on_hand = quantity_on_hand - 1,
             last_event_ts = ?,
             updated_at = ?
         WHERE product_variant_id = ? AND quantity_on_hand > 0`
      )
      .run(occurredAt, context.nowIso, productVariantId);

    if (result.changes === 0) {
      throw new Error("ERROR: PRODUCT NOT FOUND IN STOCK");
    }

    // Take the unit from wherever it actually is: the factory floor, or the store once
    // Store Scanning has received it. Units that predate location tracking sit at the factory.
    const locationType = from?.type && from.type !== "UNKNOWN" ? from.type : "FACTORY";
    const locationId = from?.id ?? operationalContext.factoryId;
    context.db
      .prepare(
        `UPDATE stock_projection_by_location
         SET quantity_on_hand = quantity_on_hand - 1,
             updated_at = ?
         WHERE product_variant_id = ? AND location_type = ? AND location_id = ? AND quantity_on_hand > 0`
      )
      .run(context.nowIso, productVariantId, locationType, locationId);
  },

  async appendDispatchedEvent(this: SqliteDatabase,
    payload: {
      eventId: string;
      qrId: string;
      productVariantId: string;
      article: string;
      color: string;
      size: string;
      serial: string;
      occurredAt: string;
      parserVersion: string;
      factoryId: string;
      workstationId: string;
      deviceId: string;
      operatorId?: string;
      /** The session (⇒ voucher) this scan was validated against, or null if none was selected. */
      dispatchSessionId: string | null;
      /** The QR's own current_status/location immediately before this dispatch — the exact
       *  state a later cancellation restores. Recorded once, here, never inferred afterward. */
      previousStatus: string;
      previousLocationType: string;
      previousLocationId: string;
    },
    tx: TransactionContext
  ): Promise<void> {
    const context = tx as MutableTransactionContext;
    const eventDate = payload.occurredAt.slice(0, 10);
    const eventHour = businessHourOf(payload.occurredAt);

    const insertResult = context.db
      .prepare(
        `INSERT INTO production_events (
          id, qr_id, product_variant_id, event_type, event_ts_local, event_date, event_hour,
          factory_id, workstation_id, operator_id, device_id,
          article_snapshot, color_snapshot, size_snapshot, serial_snapshot,
          metadata_json, created_at, sync_status, synced_at, sync_error, retry_count, source_app,
          dispatch_session_id, previous_status, previous_location_type, previous_location_id
        ) VALUES (?, ?, ?, 'DISPATCHED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL, NULL, 0, 'desktop-scanner', ?, ?, ?, ?)`
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
        JSON.stringify({ parserVersion: payload.parserVersion, eventType: "DISPATCHED" }),
        context.nowIso,
        payload.dispatchSessionId,
        payload.previousStatus,
        payload.previousLocationType,
        payload.previousLocationId
      );

    if (insertResult.changes === 0) {
      throw new Error("Dispatch event insert failed.");
    }

    context.db
      .prepare("UPDATE qr_master SET first_event_id = COALESCE(first_event_id, ?), updated_at = ? WHERE qr_id = ?")
      .run(payload.eventId, context.nowIso, payload.qrId);
  },

  async enqueueDispatch(this: SqliteDatabase, 
    payload: {
      outboxId: string;
      eventId: string;
      qrId: string;
      createdAt: string;
      parserVersion: string;
      factoryId: string;
      workstationId: string;
      deviceId: string;
    },
    tx: TransactionContext
  ): Promise<void> {
    const context = tx as MutableTransactionContext;
    const outboxPayload = {
      eventId: payload.eventId,
      qrId: payload.qrId,
      parserVersion: payload.parserVersion,
      factoryId: payload.factoryId,
      workstationId: payload.workstationId,
      deviceId: payload.deviceId,
      createdAt: payload.createdAt,
      eventType: "DISPATCHED",
    };

    context.db
      .prepare(
        `INSERT INTO sync_outbox (
          id, aggregate_type, aggregate_id, operation, dedupe_key,
          payload_json, status, lock_token, available_at, attempts, last_error, created_at, updated_at
        ) VALUES (?, 'DISPATCH_EVENT', ?, 'INSERT', ?, ?, 'PENDING', NULL, ?, 0, NULL, ?, ?)`
      )
      .run(
        payload.outboxId,
        payload.eventId,
        `DISPATCH_EVENT:${payload.eventId}`,
        JSON.stringify(outboxPayload),
        payload.createdAt,
        payload.createdAt,
        payload.createdAt
      );
  },

  /**
   * Guarded status move, the same concurrency shape as markInStore: two terminals that both
   * read the carton as DISPATCHED will both reach this update, but only the first changes a
   * row — the second is rejected without writing anything, so exactly one return is recorded.
   *
   * The carton is put at the GATE, because that is where it physically is: off the customer,
   * not yet in the store, counted in nobody's stock. Only a normal Store Move In moves it on.
   */
  async markOnGate(this: SqliteDatabase, payload: { qrId: string; locationId: string; updatedAt: string }, tx: TransactionContext): Promise<void> {
    const context = tx as MutableTransactionContext;
    const result = context.db
      .prepare(
        `UPDATE qr_master
         SET current_status = ?, current_location_type = ?, current_location_id = ?, updated_at = ?
         WHERE qr_id = ? AND current_status = ?`
      )
      .run(ON_GATE_STATUS, ON_GATE_LOCATION_TYPE, payload.locationId, payload.updatedAt, payload.qrId, RETURNABLE_STATUS);

    if (result.changes === 0) {
      const current = context.db
        .prepare("SELECT current_status FROM qr_master WHERE qr_id = ? LIMIT 1")
        .get(payload.qrId) as { current_status?: string } | undefined;

      if (current?.current_status === ON_GATE_STATUS) {
        throw new ReturnRejectedError(
          "ALREADY_RETURNED",
          "This carton's return has already been recorded. It is waiting to be received by Store Move In.",
          { currentStatus: current.current_status }
        );
      }

      throw new ReturnRejectedError(
        "NOT_DISPATCHED",
        "This carton's status changed while its return was being recorded. Scan it again to see where it stands.",
        { currentStatus: current?.current_status ?? null }
      );
    }
  },

  /**
   * The audit record of a recorded return. Written as a RETURNED production_event so it sits
   * in the one event log every other scan writes to, with metadata saying the carton went to
   * ON_GATE (not back into stock) and naming the dispatch it answers and the credit it
   * created. Legacy RETURNED events, written by the pre-ON_GATE flow, carry no newStatus and
   * are still read correctly as ending in RETURNED.
   */
  async appendReturnRecordedEvent(this: SqliteDatabase, payload: ReturnEventPayload, tx: TransactionContext): Promise<void> {
    const context = tx as MutableTransactionContext;
    const eventDate = payload.occurredAt.slice(0, 10);
    const eventHour = businessHourOf(payload.occurredAt);

    const insertResult = context.db
      .prepare(
        `INSERT INTO production_events (
          id, qr_id, product_variant_id, event_type, event_ts_local, event_date, event_hour,
          factory_id, workstation_id, operator_id, device_id,
          article_snapshot, color_snapshot, size_snapshot, serial_snapshot,
          metadata_json, created_at, sync_status, synced_at, sync_error, retry_count, source_app,
          dispatch_session_id, previous_status, previous_location_type, previous_location_id, sale_return_id
        ) VALUES (?, ?, ?, 'RETURNED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL, NULL, 0, 'desktop-scanner', ?, ?, ?, ?, ?)`
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
          eventType: "RETURN_RECORDED",
          previousStatus: payload.previousStatus,
          newStatus: ON_GATE_STATUS,
          fromLocationType: payload.fromLocationType,
          fromLocationId: payload.fromLocationId,
          toLocationType: ON_GATE_LOCATION_TYPE,
          toLocationId: payload.factoryId,
          actor: payload.actor ?? null,
          dispatchEventId: payload.dispatchEventId,
          partyId: payload.partyId,
          saleVoucherId: payload.saleVoucherId,
          saleReturnId: payload.saleReturnId,
        }),
        context.nowIso,
        payload.dispatchSessionId,
        payload.previousStatus,
        payload.fromLocationType,
        payload.fromLocationId,
        payload.saleReturnId
      );

    if (insertResult.changes === 0) {
      throw new Error("Return event insert failed.");
    }

    context.db
      .prepare("UPDATE qr_master SET first_event_id = COALESCE(first_event_id, ?), updated_at = ? WHERE qr_id = ?")
      .run(payload.eventId, context.nowIso, payload.qrId);
  },

  async enqueueReturn(this: SqliteDatabase, 
    payload: {
      outboxId: string;
      eventId: string;
      qrId: string;
      createdAt: string;
      parserVersion: string;
      factoryId: string;
      workstationId: string;
      deviceId: string;
    },
    tx: TransactionContext
  ): Promise<void> {
    const context = tx as MutableTransactionContext;
    const outboxPayload = {
      eventId: payload.eventId,
      qrId: payload.qrId,
      parserVersion: payload.parserVersion,
      factoryId: payload.factoryId,
      workstationId: payload.workstationId,
      deviceId: payload.deviceId,
      createdAt: payload.createdAt,
      eventType: "RETURNED",
    };

    context.db
      .prepare(
        `INSERT INTO sync_outbox (
          id, aggregate_type, aggregate_id, operation, dedupe_key,
          payload_json, status, lock_token, available_at, attempts, last_error, created_at, updated_at
        ) VALUES (?, 'RETURN_EVENT', ?, 'INSERT', ?, ?, 'PENDING', NULL, ?, 0, NULL, ?, ?)`
      )
      .run(
        payload.outboxId,
        payload.eventId,
        `RETURN_EVENT:${payload.eventId}`,
        JSON.stringify(outboxPayload),
        payload.createdAt,
        payload.createdAt,
        payload.createdAt
      );
  },

  // ─── Store Scanning (store entry) ────────────────────────────────────────────────
  // Repository side of StoreEntryScanUseCase. Same tables the other scanners write:
  // qr_master (status + location), production_events (a MOVED event whose metadata says
  // STORE_ENTRY), stock_projection_by_location (FACTORY −1, WAREHOUSE +1) and sync_outbox.
  // The variant total in stock_projection_by_variant is untouched — the unit is still in
  // stock, it has just changed location.

  listDispatchHistory(this: SqliteDatabase, query: HistoryQuery = {}): PagedResult<HistoryRow> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const offset = (page - 1) * pageSize;
    const orderClause = orderBy(
      query.sortBy,
      ["event_ts_local", "article_snapshot", "color_snapshot", "size_snapshot", "qr_id"],
      "event_ts_local",
      query.sortOrder
    );

    const where: string[] = ["pe.event_type = 'DISPATCHED'"];
    const values: Array<string | number> = [];

    if (query.search?.trim()) {
      const needle = `%${query.search.trim()}%`;
      where.push("(pe.qr_id LIKE ? OR pe.article_snapshot LIKE ? OR pe.color_snapshot LIKE ? OR pe.size_snapshot LIKE ?)");
      values.push(needle, needle, needle, needle);
    }

    if (query.fromDate) {
      where.push("pe.event_ts_local >= ?");
      values.push(query.fromDate);
    }

    if (query.toDate) {
      where.push("pe.event_ts_local <= ?");
      values.push(query.toDate);
    }

    const whereClause = where.join(" AND ");
    const total = this.scalarCount(`SELECT COUNT(1) as c FROM production_events pe WHERE ${whereClause}`, values);
    const rows = this.db
      .prepare(
        `SELECT pe.qr_id, pe.article_snapshot, pe.color_snapshot, pe.size_snapshot, pe.event_ts_local,
                op.display_name as operator_name, pe.device_id, f.name as factory_name, pe.sync_status
         FROM production_events pe
         JOIN factories f ON f.id = pe.factory_id
         LEFT JOIN operators op ON op.id = pe.operator_id
         WHERE ${whereClause}
         ORDER BY ${orderClause}
         LIMIT ? OFFSET ?`
      )
      .all(...values, pageSize, offset) as Array<Record<string, unknown>>;

    return {
      rows: rows.map((row) => ({
        qrId: String(row.qr_id ?? ""),
        article: String(row.article_snapshot ?? ""),
        color: String(row.color_snapshot ?? ""),
        size: String(row.size_snapshot ?? ""),
        timestamp: String(row.event_ts_local ?? ""),
        operator: row.operator_name ? String(row.operator_name) : null,
        device: String(row.device_id ?? ""),
        factory: String(row.factory_name ?? ""),
        status: String(row.sync_status ?? "PENDING"),
      })),
      total,
      page,
      pageSize,
    };
  },

  /**
   * Create a dispatch session for a voucher (called automatically when a voucher is saved).
   * If one already exists for this voucher, do nothing.
   */
  createDispatchSession(this: SqliteDatabase, voucherId: string): string {
    const existing = this.db
      .prepare("SELECT id FROM dispatch_sessions WHERE voucher_id = ? LIMIT 1")
      .get(voucherId) as { id: string } | undefined;
    if (existing) return existing.id;

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO dispatch_sessions (id, voucher_id, status, started_at, completed_at, created_at, updated_at)
         VALUES (?, ?, 'PENDING', NULL, NULL, ?, ?)`
      )
      .run(id, voucherId, now, now);
    return id;
  },

  /**
   * List dispatch sessions with voucher + party info.
   * status filter: 'PENDING' | 'IN_PROGRESS' | 'ALL'
   */
  listDispatchSessions(this: SqliteDatabase, filter: { status?: string } = {}): DispatchSessionSummary[] {
    const where: string[] = ["sv.deleted_at IS NULL"];
    if (filter.status && filter.status !== "ALL") {
      where.push("ds.status = ?");
    }
    const values: string[] = filter.status && filter.status !== "ALL" ? [filter.status] : [];

    const rows = this.db
      .prepare(
        `SELECT ds.id as session_id, ds.voucher_id, sv.voucher_number, p.party_name,
                sv.voucher_date, sv.total_quantity, sv.total_amount_paisa, ds.status, ds.started_at
         FROM dispatch_sessions ds
         JOIN sale_vouchers sv ON sv.id = ds.voucher_id
         JOIN parties p ON p.id = sv.party_id
         WHERE ${where.join(" AND ")}
         ORDER BY sv.voucher_date DESC, sv.created_at DESC`
      )
      .all(...values) as Array<Record<string, unknown>>;

    return rows.map((r) => {
      const session = this.getDispatchSession(String(r.session_id ?? ""));
      const requiredCartons = session?.allowedItems.reduce((sum, item) => sum + item.requiredCartons, 0) ?? 0;
      const dispatchedCartons = session?.allowedItems.reduce((sum, item) => sum + item.dispatchedCartons, 0) ?? 0;
      const remainingCartons = Math.max(0, requiredCartons - dispatchedCartons);

      return {
        sessionId:     String(r.session_id ?? ""),
        voucherId:     String(r.voucher_id ?? ""),
        voucherNumber: String(r.voucher_number ?? ""),
        partyName:     String(r.party_name ?? ""),
        voucherDate:   String(r.voucher_date ?? ""),
        totalQuantity: Number(r.total_quantity ?? 0),
        totalAmount:   fromPaisa(Number(r.total_amount_paisa ?? 0)),
        status:        String(r.status ?? "PENDING"),
        startedAt:     r.started_at ? String(r.started_at) : null,
        remainingCartons,
        remainingPairs: cartonsToPairs(remainingCartons),
      };
    });
  },

  /**
   * Get full details of one dispatch session including allowed variants and
   * how many cartons have already been dispatched for each line item.
   *
   * Units (see @erp/domain units.ts): a voucher line is in dozens; one scanned QR is one
   * carton; 1 dozen = 2 cartons = 12 pairs. The allowance is enforced in cartons, which is
   * what the scanner counts; the pair figures are derived for display and reporting.
   */
  getDispatchSession(this: SqliteDatabase, sessionId: string): DispatchSessionDetail | null {
    const session = this.db
      .prepare(
        `SELECT ds.id, ds.voucher_id, ds.status, sv.voucher_number, p.party_name, sv.voucher_date
         FROM dispatch_sessions ds
         JOIN sale_vouchers sv ON sv.id = ds.voucher_id
         JOIN parties p ON p.id = sv.party_id
         WHERE ds.id = ? LIMIT 1`
      )
      .get(sessionId) as Record<string, unknown> | undefined;

    if (!session) return null;

    const items = this.db
      .prepare(
        `SELECT MIN(svli.id) as id, MIN(svli.product_variant_id) as product_variant_id,
          SUM(svli.quantity) as quantity, pv.article, pv.size
         FROM sale_voucher_line_items svli
         JOIN product_variants pv ON pv.id = svli.product_variant_id
         WHERE svli.voucher_id = ? AND svli.deleted_at IS NULL
         GROUP BY pv.article, pv.size
         ORDER BY MIN(svli.id)`
      )
      .all(String(session.voucher_id)) as Array<Record<string, unknown>>;

    // Dispatched-so-far, per line: scoped to THIS session's own events (dispatch_session_id),
    // never by article + size + a timestamp bound — that was the ambiguous heuristic that let
    // one voucher's scans count toward a different voucher ordering the same article/size.
    // Article + size here only pick which line within this session a count belongs to.
    const allowedItems = items.map((it) => {
      const dispatched = this.db
        .prepare(
          `SELECT COUNT(1) as cnt
           FROM production_events pe
           JOIN product_variants pv ON pv.id = pe.product_variant_id
           WHERE pe.event_type = 'DISPATCHED'
             AND pe.dispatch_session_id = ?
             AND pv.article = ?
             AND pv.size = ?`
        )
        .get(sessionId, String(it.article ?? ""), String(it.size ?? "")) as { cnt: number };

      const requiredDzn = Number(it.quantity ?? 0);
      const dispatchedCartons = Number(dispatched.cnt ?? 0); // one DISPATCHED event per scanned carton
      return {
        lineItemId:        String(it.id ?? ""),
        productVariantId:  String(it.product_variant_id ?? ""),
        article:           String(it.article ?? ""),
        color:             "ALL COLORS",
        size:              String(it.size ?? ""),
        requiredDzn,
        requiredCartons:   dozensToCartons(requiredDzn),
        dispatchedCartons,
        requiredPairs:     dozensToPairs(requiredDzn),
        dispatchedPairs:   cartonsToPairs(dispatchedCartons),
      };
    });

    return {
      sessionId:     String(session.id ?? ""),
      voucherId:     String(session.voucher_id ?? ""),
      voucherNumber: String(session.voucher_number ?? ""),
      partyName:     String(session.party_name ?? ""),
      voucherDate:   String(session.voucher_date ?? ""),
      status:        String(session.status ?? "PENDING"),
      allowedItems,
    };
  },

  /** Mark session as IN_PROGRESS when first scan starts */
  startDispatchSession(this: SqliteDatabase, sessionId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE dispatch_sessions SET status = 'IN_PROGRESS', started_at = ?, updated_at = ? WHERE id = ? AND status = 'PENDING'")
      .run(now, now, sessionId);
  },

  /** Mark session as COMPLETED */
  completeDispatchSession(this: SqliteDatabase, sessionId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE dispatch_sessions SET status = 'COMPLETED', completed_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, sessionId);
  },

  /** Mark session as CANCELLED — its voucher was deleted. */
  cancelDispatchSession(this: SqliteDatabase, sessionId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE dispatch_sessions SET status = 'CANCELLED', updated_at = ? WHERE id = ?")
      .run(now, sessionId);
  },

  /**
   * Every DISPATCHED event exactly attributed to this session that is still, right now,
   * actually DISPATCHED. The current-status check is what makes voucher cancellation
   * idempotent (an event already reversed by an earlier cancel attempt is naturally excluded)
   * and correct (a unit that came back through a normal Return already has its own, separate,
   * correct restoration and must not be touched again here).
   */
  listDispatchedEventsForSession(this: SqliteDatabase, sessionId: string): Array<{
    id: string;
    qrId: string;
    productVariantId: string;
    article: string;
    color: string;
    size: string;
    serial: string;
    factoryId: string;
    workstationId: string;
    deviceId: string;
    previousStatus: string;
    previousLocationType: string;
    previousLocationId: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT pe.id, pe.qr_id, pe.product_variant_id,
                pe.article_snapshot, pe.color_snapshot, pe.size_snapshot, pe.serial_snapshot,
                pe.factory_id, pe.workstation_id, pe.device_id,
                pe.previous_status, pe.previous_location_type, pe.previous_location_id
         FROM production_events pe
         JOIN qr_master qm ON qm.qr_id = pe.qr_id
         WHERE pe.event_type = 'DISPATCHED'
           AND pe.dispatch_session_id = ?
           AND qm.current_status = 'DISPATCHED'`
      )
      .all(sessionId) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id ?? ""),
      qrId: String(row.qr_id ?? ""),
      productVariantId: String(row.product_variant_id ?? ""),
      article: String(row.article_snapshot ?? ""),
      color: String(row.color_snapshot ?? ""),
      size: String(row.size_snapshot ?? ""),
      serial: String(row.serial_snapshot ?? ""),
      factoryId: String(row.factory_id ?? ""),
      workstationId: String(row.workstation_id ?? ""),
      deviceId: String(row.device_id ?? ""),
      // Only ever null on pre-migration rows, which never carry a dispatch_session_id either —
      // so a row selected by this query (dispatch_session_id = ?) always has these set.
      previousStatus: String(row.previous_status ?? "PRODUCED"),
      previousLocationType: String(row.previous_location_type ?? "FACTORY"),
      previousLocationId: row.previous_location_id ? String(row.previous_location_id) : "",
    }));
  },

  /**
   * Read-only diagnostic: DISPATCHED events with no session attribution (written before this
   * attribution existed) that plausibly — by the retired article + size + timestamp heuristic —
   * belong to this voucher. Never touched automatically. Cancellation surfaces these so an
   * operator can reconcile them by hand instead of the system guessing.
   */
  findAmbiguousLegacyDispatchEvents(this: SqliteDatabase, voucherId: string, voucherCreatedAt: string): Array<{ id: string; qrId: string }> {
    const rows = this.db
      .prepare(
        `SELECT pe.id, pe.qr_id
         FROM production_events pe
         JOIN qr_master qm ON qm.qr_id = pe.qr_id
         JOIN product_variants pv ON pv.id = pe.product_variant_id
         WHERE pe.event_type = 'DISPATCHED'
           AND pe.dispatch_session_id IS NULL
           AND qm.current_status = 'DISPATCHED'
           AND pe.event_ts_local >= ?
           AND EXISTS (
             SELECT 1 FROM sale_voucher_line_items svli
             JOIN product_variants bill_pv ON bill_pv.id = svli.product_variant_id
             WHERE svli.voucher_id = ?
               AND svli.deleted_at IS NULL
               AND bill_pv.article = pv.article
               AND bill_pv.size = pv.size
           )`
      )
      .all(voucherCreatedAt, voucherId) as Array<{ id: string; qr_id: string }>;

    return rows.map((row) => ({ id: String(row.id), qrId: String(row.qr_id) }));
  },

  /**
   * Reverses one exactly-attributed DISPATCHED event because its voucher was cancelled:
   * restores qr_master and stock to the event's own previous_status/previous_location_* (the
   * exact prior state, never a guess), and records the correction as a new ADJUSTMENT event
   * that references the original. The original DISPATCHED row and its outbox entry are never
   * touched — production_events is immutable (see docs/16).
   *
   * Returns false (no-op) if the QR is no longer DISPATCHED — e.g. this exact event was
   * already reversed by an earlier call — which is what makes cancellation safe to repeat.
   */
  reverseDispatchedEvent(this: SqliteDatabase, event: {
    id: string;
    qrId: string;
    productVariantId: string;
    article: string;
    color: string;
    size: string;
    serial: string;
    factoryId: string;
    workstationId: string;
    deviceId: string;
    previousStatus: string;
    previousLocationType: string;
    previousLocationId: string;
  }, input: { voucherId: string; dispatchSessionId: string; nowIso: string }): boolean {
    const restoreResult = this.db
      .prepare(
        "UPDATE qr_master SET current_status = ?, current_location_type = ?, current_location_id = ?, updated_at = ? WHERE qr_id = ? AND current_status = 'DISPATCHED'"
      )
      .run(event.previousStatus, event.previousLocationType, event.previousLocationId || null, input.nowIso, event.qrId);

    if (restoreResult.changes === 0) {
      return false;
    }

    this.db
      .prepare("UPDATE stock_projection_by_variant SET quantity_on_hand = quantity_on_hand + 1, updated_at = ? WHERE product_variant_id = ?")
      .run(input.nowIso, event.productVariantId);
    this.db
      .prepare(
        "UPDATE stock_projection_by_location SET quantity_on_hand = quantity_on_hand + 1, updated_at = ? WHERE product_variant_id = ? AND location_type = ? AND location_id = ?"
      )
      .run(input.nowIso, event.productVariantId, event.previousLocationType, event.previousLocationId || null);

    const adjustmentId = crypto.randomUUID();
    const eventDate = input.nowIso.slice(0, 10);
    const eventHour = businessHourOf(input.nowIso);
    this.db
      .prepare(
        `INSERT INTO production_events (
          id, qr_id, product_variant_id, event_type, event_ts_local, event_date, event_hour,
          factory_id, workstation_id, operator_id, device_id,
          article_snapshot, color_snapshot, size_snapshot, serial_snapshot,
          metadata_json, created_at, sync_status, synced_at, sync_error, retry_count, source_app,
          dispatch_session_id
        ) VALUES (?, ?, ?, 'ADJUSTMENT', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL, NULL, 0, 'desktop-scanner', ?)`
      )
      .run(
        adjustmentId,
        event.qrId,
        event.productVariantId,
        input.nowIso,
        eventDate,
        eventHour,
        event.factoryId,
        event.workstationId,
        event.deviceId,
        event.article,
        event.color,
        event.size,
        event.serial,
        JSON.stringify({
          reason: "VOUCHER_CANCELLED",
          reversedEventId: event.id,
          voucherId: input.voucherId,
          previousStatus: "DISPATCHED",
        }),
        input.nowIso,
        input.dispatchSessionId
      );

    // Every other event type enqueues its own sync_outbox row in the same write (see
    // appendProducedEvent, enqueueDispatch, enqueueReturn, enqueueStoreEntry/Exit) — this
    // correction is no different, or the cloud would never learn a dispatch was reversed.
    // No dedicated aggregate_type exists for corrections, so it travels as a PRODUCTION_EVENT,
    // exactly like PRODUCED/MOVED already do.
    this.db
      .prepare(
        `INSERT INTO sync_outbox (
          id, aggregate_type, aggregate_id, operation, dedupe_key,
          payload_json, status, lock_token, available_at, attempts, last_error, created_at, updated_at
        ) VALUES (?, 'PRODUCTION_EVENT', ?, 'INSERT', ?, ?, 'PENDING', NULL, ?, 0, NULL, ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        adjustmentId,
        `PRODUCTION_EVENT:${adjustmentId}`,
        JSON.stringify({
          eventId: adjustmentId,
          qrId: event.qrId,
          factoryId: event.factoryId,
          workstationId: event.workstationId,
          deviceId: event.deviceId,
          createdAt: input.nowIso,
          eventType: "ADJUSTMENT",
          reason: "VOUCHER_CANCELLED",
          reversedEventId: event.id,
          voucherId: input.voucherId,
        }),
        input.nowIso,
        input.nowIso,
        input.nowIso
      );

    return true;
  },

  /**
   * Check if a scanned QR's variant is allowed by the active dispatch session.
   * A scan is one carton, so the bill's remaining allowance is counted in cartons:
   * a 1-dozen line accepts 2 scans (12 pairs), not 12.
   */
  checkDispatchSessionAllowance(this: SqliteDatabase, sessionId: string, productVariantId: string): DispatchAllowance | null {
    const session = this.getDispatchSession(sessionId);
    if (!session) return null;
    const scanned = this.db
      .prepare("SELECT article, size FROM product_variants WHERE id = ? LIMIT 1")
      .get(productVariantId) as { article: string; size: string } | undefined;
    const item = scanned
      ? session.allowedItems.find((it) => it.article === scanned.article && it.size === scanned.size)
      : undefined;
    if (!item) {
      return { allowed: false, lineItemId: null, article: "", color: "", size: "", requiredCartons: 0, dispatchedCartons: 0, requiredPairs: 0, dispatchedPairs: 0 };
    }

    const remainingCartons = item.requiredCartons - item.dispatchedCartons;

    return {
      allowed: remainingCartons > 0,
      lineItemId: item.lineItemId,
      article: item.article,
      color: item.color,
      size: item.size,
      requiredCartons: item.requiredCartons,
      dispatchedCartons: item.dispatchedCartons,
      requiredPairs: item.requiredPairs,
      dispatchedPairs: item.dispatchedPairs,
    };
  },
};

export type DispatchMethods = typeof dispatchMethods;
