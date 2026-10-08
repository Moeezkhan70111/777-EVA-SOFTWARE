// Production scans, stock projection increments, the dashboard snapshot, history and reports.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").
// `this` is the database instance; bodies are unchanged from the original class.

import type { SqliteDatabase } from "../sqliteDatabase.js";
import type { BreakdownRow, DashboardSnapshot, HistoryQuery, HistoryRow, PagedResult, ReportSummary } from "./types.js";
import { fromPaisa, operationalDayBounds } from "@erp/domain";
import type { CanonicalQrPayload } from "@erp/domain";
import { IN_STORE_STOCK_TOTAL_SQL, orderBy } from "./shared.js";
import type { MutableTransactionContext } from "./shared.js";
import type { ScanOperationalContext, TransactionContext } from "@erp/application";

export const productionMethods = {
  async existsByQrId(this: SqliteDatabase, qrId: string, tx: TransactionContext): Promise<boolean> {
    const context = tx as MutableTransactionContext;
    const row = context.db.prepare("SELECT 1 as ok FROM qr_master WHERE qr_id = ? LIMIT 1").get(qrId) as
      | { ok: number }
      | undefined;
    return Boolean(row?.ok);
  },

  // Lookup-only: the production scanner must never create products. A product/variant
  // must already exist via Product Master (createProduct) before it can be scanned.
  async getOrCreateVariant(this: SqliteDatabase, payload: CanonicalQrPayload, tx: TransactionContext): Promise<{ id: string }> {
    const context = tx as MutableTransactionContext;
    const existing = context.db
      .prepare(
        "SELECT id FROM product_variants WHERE article = ? AND color = ? AND size = ? AND deleted_at IS NULL LIMIT 1"
      )
      .get(payload.article, payload.color, payload.size) as { id: string } | undefined;

    if (existing) {
      return { id: existing.id };
    }

    throw new Error(
      "PRODUCT_NOT_FOUND: This product/QR code is not registered. Add the product in Product Master and generate its QR code before production scanning."
    );
  },

  async insertProduced(this: SqliteDatabase, 
    payload: { qrId: string; productVariantId: string; createdAt: string },
    tx: TransactionContext
  ): Promise<void> {
    const context = tx as MutableTransactionContext;
    context.db
      .prepare(
        `INSERT INTO qr_master (
          qr_id, product_variant_id, current_status, current_location_type, current_location_id,
          first_event_id, created_at, updated_at, deleted_at, deleted_by, delete_reason
        ) VALUES (?, ?, 'PRODUCED', 'FACTORY', NULL, NULL, ?, ?, NULL, NULL, NULL)`
      )
      .run(payload.qrId, payload.productVariantId, payload.createdAt, payload.createdAt);
  },

  async appendProducedEvent(this: SqliteDatabase, 
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
    },
    tx: TransactionContext
  ): Promise<void> {
    const context = tx as MutableTransactionContext;
    const eventDate = payload.occurredAt.slice(0, 10);
    const eventHour = new Date(payload.occurredAt).getHours();

    context.db
      .prepare(
        `INSERT INTO production_events (
          id, qr_id, product_variant_id, event_type, event_ts_local, event_date, event_hour,
          factory_id, workstation_id, operator_id, device_id,
          article_snapshot, color_snapshot, size_snapshot, serial_snapshot,
          metadata_json, created_at, sync_status, synced_at, sync_error, retry_count, source_app
        ) VALUES (?, ?, ?, 'PRODUCED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL, NULL, 0, 'desktop-scanner')`
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
        JSON.stringify({ parserVersion: payload.parserVersion }),
        context.nowIso
      );

    context.db
      .prepare("UPDATE qr_master SET first_event_id = COALESCE(first_event_id, ?), updated_at = ? WHERE qr_id = ?")
      .run(payload.eventId, context.nowIso, payload.qrId);
  },

  async incrementProduced(this: SqliteDatabase, 
    productVariantId: string,
    occurredAt: string,
    operationalContext: ScanOperationalContext,
    tx: TransactionContext
  ): Promise<void> {
    const context = tx as MutableTransactionContext;
    context.db
      .prepare(
        `INSERT INTO stock_projection_by_variant (
          product_variant_id, quantity_on_hand, quantity_reserved, quantity_damaged, last_event_ts, updated_at
        ) VALUES (?, 1, 0, 0, ?, ?)
        ON CONFLICT(product_variant_id) DO UPDATE SET
          quantity_on_hand = quantity_on_hand + 1,
          last_event_ts = excluded.last_event_ts,
          updated_at = excluded.updated_at`
      )
      .run(productVariantId, occurredAt, context.nowIso);

    context.db
      .prepare(
        `INSERT INTO stock_projection_by_location (
          product_variant_id, location_type, location_id, quantity_on_hand, updated_at
        ) VALUES (?, 'FACTORY', ?, 1, ?)
        ON CONFLICT(product_variant_id, location_type, location_id) DO UPDATE SET
          quantity_on_hand = quantity_on_hand + 1,
          updated_at = excluded.updated_at`
      )
      .run(productVariantId, operationalContext.factoryId, context.nowIso);
  },

  async enqueueProduced(this: SqliteDatabase, 
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

  getDashboardSnapshot(this: SqliteDatabase): DashboardSnapshot {
    // ── 6AM→6AM production session boundary ──────────────────────────────────
    // Before 06:00 → session started yesterday at 06:00
    // At/after 06:00 → session started today at 06:00
    const now = new Date();
    const sessionStart = new Date(now);
    if (now.getHours() < 6) {
      sessionStart.setDate(sessionStart.getDate() - 1);
    }
    sessionStart.setHours(6, 0, 0, 0);
    const sessionEnd = new Date(sessionStart);
    sessionEnd.setDate(sessionEnd.getDate() + 1);
    const startIso = sessionStart.toISOString();
    const endIso   = sessionEnd.toISOString();

    const todaysProduction = this.scalarCount(
      "SELECT COUNT(1) as c FROM production_events WHERE event_type = 'PRODUCED' AND event_ts_local >= ? AND event_ts_local < ?",
      [startIso, endIso]
    );

    // Current Stock: cartons In Store right now — Store Move In adds, Store Move Out removes.
    const stockTotal = this.scalarNumber(
      `SELECT COALESCE(SUM(quantity_on_hand), 0) as total FROM (${IN_STORE_STOCK_TOTAL_SQL})`,
      []
    );
    const queueCount = this.scalarCount(
      "SELECT COUNT(1) as c FROM sync_outbox WHERE status IN ('PENDING','IN_FLIGHT','FAILED')",
      []
    );

    // Today's dispatched — calendar day (midnight→midnight), session-independent
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(todayStart);
    todayEnd.setDate(todayEnd.getDate() + 1);
    const todayStartIso = todayStart.toISOString();
    const todayEndIso   = todayEnd.toISOString();

    const todaysDispatched = this.scalarCount(
      "SELECT COUNT(1) as c FROM production_events WHERE event_type = 'DISPATCHED' AND event_ts_local >= ? AND event_ts_local < ?",
      [todayStartIso, todayEndIso]
    );
    // cost_price_paisa × quantity_on_hand (cartons) is exact integer arithmetic throughout —
    // summing REAL cost_price × quantity across many rows is exactly the drift this avoids.
    const inventoryValue = fromPaisa(this.scalarNumber(
      `SELECT COALESCE(SUM(COALESCE(ass.cost_price_paisa,0) * spv.quantity_on_hand), 0) as v
       FROM (${IN_STORE_STOCK_TOTAL_SQL}) spv
       JOIN product_variants pv ON pv.id = spv.product_variant_id
       JOIN article_sizes ass ON ass.id = pv.article_size_id`,
      []
    ));

    const recentRows = this.db
      .prepare(
        `SELECT qr_id, article_snapshot, color_snapshot, size_snapshot, serial_snapshot, event_ts_local
         FROM production_events
         WHERE event_type = 'PRODUCED'
           AND event_ts_local >= ?
           AND event_ts_local < ?
         ORDER BY event_ts_local DESC
         LIMIT 15`
      )
      .all(startIso, endIso) as Array<Record<string, unknown>>;

    return {
      todaysProduction,
      todaysDispatched,
      currentStockTotal: stockTotal,
      inventoryValue,
      syncQueuePending: queueCount,
      productionCounter: todaysProduction,
      recentScans: recentRows.map((row) => ({
        qrId: String(row.qr_id ?? ""),
        article: String(row.article_snapshot ?? ""),
        color: String(row.color_snapshot ?? ""),
        size: String(row.size_snapshot ?? ""),
        serial: String(row.serial_snapshot ?? ""),
        occurredAt: String(row.event_ts_local ?? ""),
      })),
      byHour: this.getBreakdown(
        `SELECT printf('%02d', event_hour) as key, COUNT(1) as quantity
         FROM production_events
         WHERE event_type = 'PRODUCED' AND event_ts_local >= ? AND event_ts_local < ?
         GROUP BY event_hour
         ORDER BY event_hour ASC`,
        [startIso, endIso]
      ),
      byProduct: this.getBreakdown(
        `SELECT article_snapshot || '_' || color_snapshot || '_' || size_snapshot as key, COUNT(1) as quantity
         FROM production_events
         WHERE event_type = 'PRODUCED' AND event_ts_local >= ? AND event_ts_local < ?
         GROUP BY article_snapshot, color_snapshot, size_snapshot
         ORDER BY quantity DESC LIMIT 10`,
        [startIso, endIso]
      ),
      byColor: this.getBreakdown(
        `SELECT color_snapshot as key, COUNT(1) as quantity
         FROM production_events
         WHERE event_type = 'PRODUCED' AND event_ts_local >= ? AND event_ts_local < ?
         GROUP BY color_snapshot
         ORDER BY quantity DESC`,
        [startIso, endIso]
      ),
      bySize: this.getBreakdown(
        `SELECT size_snapshot as key, COUNT(1) as quantity
         FROM production_events
         WHERE event_type = 'PRODUCED' AND event_ts_local >= ? AND event_ts_local < ?
         GROUP BY size_snapshot
         ORDER BY quantity DESC`,
        [startIso, endIso]
      ),
    };
  },

  listHistory(this: SqliteDatabase, query: HistoryQuery = {}): PagedResult<HistoryRow> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const offset = (page - 1) * pageSize;
    const orderClause = orderBy(
      query.sortBy,
      ["event_ts_local", "article_snapshot", "color_snapshot", "size_snapshot", "qr_id"],
      "event_ts_local",
      query.sortOrder
    );

    const where: string[] = ["pe.event_type = 'PRODUCED'"];
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

  getReport(this: SqliteDatabase, 
    range: "DAILY" | "WEEKLY" | "MONTHLY" | "CUSTOM",
    fromDate?: string,
    toDate?: string,
    eventType: string = "PRODUCED"
  ): ReportSummary {
    const now = new Date();
    let from = fromDate;
    let to = toDate;

    if (!from || !to) {
      const start = new Date(now);
      const end = new Date(now);

      if (range === "DAILY") {
        start.setHours(0, 0, 0, 0);
      } else if (range === "WEEKLY") {
        const day = start.getDay();
        const diff = day === 0 ? 6 : day - 1;
        start.setDate(start.getDate() - diff);
        start.setHours(0, 0, 0, 0);
      } else if (range === "MONTHLY") {
        start.setDate(1);
        start.setHours(0, 0, 0, 0);
      }

      from = start.toISOString();
      to = end.toISOString();
    }

    // ── CUSTOM date range: apply operational-day boundaries ─────────────────
    // DailyProductionPage / DailyDispatchPage pass plain "YYYY-MM-DD" strings. The
    // operational day (06:00 → next day 06:00) is defined once in @erp/domain.
    // event_ts_local stores local timestamps, so the bounds stay in the same
    // local-time string space — no UTC conversion. SQL uses >= from AND < to.
    let fromBound = from!;
    let toBound   = to!;

    if (range === "CUSTOM" && from && to) {
      fromBound = operationalDayBounds(from).from;
      toBound = operationalDayBounds(to).to;
    }

    const validEventType = eventType === "DISPATCHED" || eventType === "RETURNED" ? eventType : "PRODUCED";
    const args = [validEventType, fromBound, toBound] as [string, string, string];

    // All five queries use >= ? AND < ? (not BETWEEN) so the upper bound is exclusive.
    const eventFilter = `event_type = ? AND event_ts_local >= ? AND event_ts_local < ?
      AND NOT (event_type = 'DISPATCHED' AND EXISTS (
        SELECT 1
        FROM sale_vouchers sv
        JOIN sale_voucher_line_items svli ON svli.voucher_id = sv.id
        JOIN product_variants bill_pv ON bill_pv.id = svli.product_variant_id
        JOIN product_variants event_pv ON event_pv.id = production_events.product_variant_id
        WHERE sv.deleted_at IS NOT NULL
          AND svli.deleted_at IS NULL
          AND bill_pv.article = event_pv.article
          AND bill_pv.size = event_pv.size
          AND production_events.event_ts_local >= sv.created_at
      ))`;

    const totalProduction = this.scalarCount(
      `SELECT COUNT(1) as c FROM production_events WHERE ${eventFilter}`,
      args
    );

    // Exact integer arithmetic (cost_price_paisa × cartons), converted back to rupees once.
    const inventoryValue = fromPaisa(this.scalarNumber(
      `SELECT COALESCE(SUM(COALESCE(pv.cost_price_paisa, 0) * spv.quantity_on_hand), 0) as value
       FROM (${IN_STORE_STOCK_TOTAL_SQL}) spv
       JOIN product_variants pv ON pv.id = spv.product_variant_id`,
      []
    ));

    return {
      totalProduction,
      inventoryValue,
      byArticle: this.getBreakdown(
        `SELECT article_snapshot as key, COUNT(1) as quantity
         FROM production_events
         WHERE ${eventFilter}
         GROUP BY article_snapshot
         ORDER BY quantity DESC`,
        args
      ),
      byColor: this.getBreakdown(
        `SELECT color_snapshot as key, COUNT(1) as quantity
         FROM production_events
         WHERE ${eventFilter}
         GROUP BY color_snapshot
         ORDER BY quantity DESC`,
        args
      ),
      bySize: this.getBreakdown(
        `SELECT size_snapshot as key, COUNT(1) as quantity
         FROM production_events
         WHERE ${eventFilter}
         GROUP BY size_snapshot
         ORDER BY quantity DESC`,
        args
      ),
      byHour: this.getBreakdown(
        `SELECT printf('%02d', event_hour) as key, COUNT(1) as quantity
         FROM production_events
         WHERE ${eventFilter}
         GROUP BY event_hour
         ORDER BY event_hour ASC`,
        args
      ),
      topProducts: this.getBreakdown(
        `SELECT article_snapshot || '_' || color_snapshot || '_' || size_snapshot as key, COUNT(1) as quantity
         FROM production_events
         WHERE ${eventFilter}
         GROUP BY article_snapshot, color_snapshot, size_snapshot
         ORDER BY quantity DESC`,
        args
      ),
    };
  },

  getBreakdown(this: SqliteDatabase, sql: string, args: Array<string | number>): BreakdownRow[] {
    const rows = this.db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      key: String(row.key ?? ""),
      quantity: Number(row.quantity ?? 0),
    }));
  },
};

export type ProductionMethods = typeof productionMethods;
