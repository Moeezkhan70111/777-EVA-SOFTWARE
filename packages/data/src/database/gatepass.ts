// Gatepass documents: store stock reads (Current / Reserved / Reflected), header/lines,
// audit rows, cancellation, and the reads Store Move Out uses to reconcile a reservation.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").
// `this` is the database instance.

import type { SqliteDatabase } from "../sqliteDatabase.js";
import { IN_STORE_LOCATION_TYPE, formatGatepassCode } from "@erp/application";
import type {
  AuditLogPayload,
  BillingNoticePayload,
  GatepassForCancel,
  GatepassHeaderPayload,
  GatepassLinePayload,
  GatepassPartyRecord,
  GatepassStatus,
  GatepassVariantStock,
  OutstandingGatepassLine,
  TransactionContext,
} from "@erp/application";
import {
  GATEPASS_JOURNEY,
  GATEPASS_STAGES,
  GATEPASS_STATUS,
  GATEPASS_STATUS_LABEL,
  GATEPASS_TRANSITION_NOTICE,
  NOTIFICATION_SEVERITY,
  PERMISSION,
  canTransitionGatepass,
  cartonsToPairs,
  formatQuantityInDozens,
  outstandingQuantity,
  reflectedStock,
} from "@erp/domain";
import type { DispatchAllowance, GatepassDeliveryProof, GatepassJourneyStep, GatepassListQuery, GatepassListRow, GatepassRecord, GatepassScanProgress, GatepassStockRow, PagedResult } from "./types.js";
import { IN_STORE_STOCK_SQL, type MutableTransactionContext } from "./shared.js";
import { createHash } from "node:crypto";

// ─── The one derivation of "dispatched from store" ───────────────────────────
// Per gatepass line, the cartons Store Move Out has actually taken for it: every STORE_EXIT
// event that names this gatepass and this variant, minus every STORE_ENTRY that brought one
// of those cartons back from the gate (the compensating record). Both are MOVED events;
// the business sub-kind lives in metadata_json exactly as the store sessions read it. The
// gatepass id on the event is the only ownership rule; it is stamped by the scan itself from
// findOldestOutstandingGatepassLine (oldest open line for the scanned variant) — never from
// article + size + time afterwards. Nothing is cached: Reserved and Reflected Stock are
// computed from this every time.
//
// `gl` must be the gatepass_lines alias in the enclosing query.
const LINE_DISPATCHED_SQL = `(SELECT COALESCE(SUM(CASE json_extract(pe.metadata_json, '$.eventType')
                                                    WHEN 'STORE_EXIT' THEN 1
                                                    WHEN 'STORE_ENTRY' THEN -1
                                                    ELSE 0 END), 0)
                              FROM production_events pe
                              WHERE pe.gatepass_id = gl.gatepass_id
                                AND pe.product_variant_id = gl.product_variant_id
                                AND pe.event_type = 'MOVED')`;

/**
 * Cartons still owed to live gatepasses for one variant; `pv` is the product_variants alias.
 *
 * Every status except CANCELLED counts. A document does not stop reserving when it is billed —
 * it stops reserving when its cartons are actually scanned out, which `LINE_DISPATCHED_SQL`
 * already subtracts. Past AT_GATE the subtraction has reached the full quantity, so those rows
 * contribute nothing on their own. Filtering on CREATED alone would hand the reserved cartons
 * back to Reflected Stock the moment the bill was made, and the store would promise them twice.
 */
const RESERVED_FOR_VARIANT_SQL = `COALESCE((SELECT SUM(gl.quantity - ${LINE_DISPATCHED_SQL})
                                            FROM gatepass_lines gl
                                            JOIN gatepasses g ON g.id = gl.gatepass_id
                                            WHERE g.status <> 'CANCELLED' AND gl.product_variant_id = pv.id), 0)`;

// Physical In Store cartons for one variant come from IN_STORE_STOCK_SQL in ./shared.js —
// the single definition of Current Stock, shared with the Stock screen and the dashboard.

const mapVariantStock = (row: Record<string, unknown>): GatepassVariantStock => ({
  productVariantId: String(row.id ?? ""),
  article: String(row.article ?? ""),
  color: String(row.color ?? ""),
  size: String(row.size ?? ""),
  storeQuantity: Number(row.store_quantity ?? 0),
  reservedQuantity: Number(row.reserved_quantity ?? 0),
});

const mapStockRow = (row: Record<string, unknown>): GatepassStockRow => {
  const stock = mapVariantStock(row);
  return {
    ...stock,
    // The group belongs to the article + size (article_sizes owns the relationship metadata
    // for every colour), so it is read from there, never from the variant's own column.
    groupName: row.group_name ? String(row.group_name) : null,
    reflectedQuantity: reflectedStock(stock.storeQuantity, stock.reservedQuantity),
  };
};

const mapLineProgress = (line: Record<string, unknown>) => {
  const quantity = Number(line.quantity ?? 0);
  const dispatchedFromStoreQuantity = Number(line.dispatched_from_store ?? 0);
  return {
    productVariantId: String(line.product_variant_id ?? ""),
    article: String(line.article_snapshot ?? ""),
    color: String(line.color_snapshot ?? ""),
    size: String(line.size_snapshot ?? ""),
    quantity,
    dispatchedFromStoreQuantity,
    outstandingQuantity: outstandingQuantity(quantity, dispatchedFromStoreQuantity),
  };
};

export const gatepassMethods = {
  /**
   * Live store figures for one article, one row per colour + size that currently holds
   * anything: Current Stock, Reserved and Reflected Stock.
   */
  listStoreStockByArticle(this: SqliteDatabase, article: string): GatepassStockRow[] {
    const needle = String(article ?? "").trim();
    if (!needle) return [];
    return this.queryStoreStock("pv.article = ? COLLATE NOCASE", [needle]);
  },

  /**
   * Live store figures for every active variant that physically holds anything — the whole
   * store on one grid, the way the paper gatepass book shows it (article + size rows, colour
   * columns). A fully reserved variant still appears (Current 5, Reserved 5, Reflected 0) so
   * the clerk sees why it cannot be cut. Starts from the location projection so only variants
   * with stock are visited, not the entire Product Master.
   */
  listStoreStock(this: SqliteDatabase): GatepassStockRow[] {
    return this.queryStoreStock(
      `EXISTS (SELECT 1 FROM stock_projection_by_location spl
               WHERE spl.product_variant_id = pv.id AND spl.location_type = ? AND spl.quantity_on_hand > 0)`,
      [IN_STORE_LOCATION_TYPE]
    );
  },

  queryStoreStock(this: SqliteDatabase, whereClause: string, whereValues: Array<string | number>): GatepassStockRow[] {
    const rows = this.db
      .prepare(
        `SELECT pv.id, pv.article, pv.color, pv.size, pg.group_name,
                ${IN_STORE_STOCK_SQL} AS store_quantity,
                ${RESERVED_FOR_VARIANT_SQL} AS reserved_quantity
         FROM product_variants pv
         JOIN article_sizes ass ON ass.id = pv.article_size_id
         LEFT JOIN product_groups pg ON pg.id = ass.product_group_id
         WHERE ${whereClause}
           AND pv.status = 'ACTIVE' AND pv.deleted_at IS NULL
           AND ass.status = 'ACTIVE' AND ass.deleted_at IS NULL
         ORDER BY pv.article ASC, pv.color ASC, pv.size ASC`
      )
      .all(...whereValues) as Array<Record<string, unknown>>;

    return rows.map(mapStockRow).filter((row) => row.storeQuantity > 0);
  },

  async getPartyForGatepass(this: SqliteDatabase, partyId: string, tx: TransactionContext): Promise<GatepassPartyRecord | null> {
    const context = tx as MutableTransactionContext;
    const row = context.db
      .prepare("SELECT id, party_name, status FROM parties WHERE id = ? AND deleted_at IS NULL LIMIT 1")
      .get(String(partyId ?? "").trim()) as { id: string; party_name: string; status: string } | undefined;
    return row ? { id: String(row.id), partyName: String(row.party_name), status: String(row.status ?? "ACTIVE") } : null;
  },

  /**
   * Current Stock and Reserved for exactly the variants on the document, inside the write
   * lock — the same derivation the screen showed, re-read so nothing stale can be trusted.
   */
  async getStoreStockForVariants(this: SqliteDatabase, productVariantIds: string[], tx: TransactionContext): Promise<GatepassVariantStock[]> {
    const context = tx as MutableTransactionContext;
    const ids = Array.from(new Set(productVariantIds.map((id) => String(id ?? "").trim()).filter(Boolean)));
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = context.db
      .prepare(
        `SELECT pv.id, pv.article, pv.color, pv.size,
                ${IN_STORE_STOCK_SQL} AS store_quantity,
                ${RESERVED_FOR_VARIANT_SQL} AS reserved_quantity
         FROM product_variants pv
         JOIN article_sizes ass ON ass.id = pv.article_size_id
         WHERE pv.id IN (${placeholders})
           AND pv.status = 'ACTIVE' AND pv.deleted_at IS NULL
           AND ass.status = 'ACTIVE' AND ass.deleted_at IS NULL`
      )
      .all(...ids) as Array<Record<string, unknown>>;
    return rows.map(mapVariantStock);
  },

  // ─── Store Move Out: reconciling a reservation ──────────────────────────────

  /**
   * The oldest open (CREATED) Gatepass line that still owes this exact variant, or null when
   * nothing is reserved for it. Oldest = lowest gatepass number, i.e. creation order — a
   * deterministic FIFO, never a timestamp match. Read inside the scan's write lock, so two
   * terminals moving the same variant out at once each consume a different carton of the
   * same line rather than the same one twice.
   */
  async findOldestOutstandingGatepassLine(this: SqliteDatabase, productVariantId: string, tx: TransactionContext): Promise<OutstandingGatepassLine | null> {
    const context = tx as MutableTransactionContext;
    const row = context.db
      .prepare(
        `SELECT g.id AS gatepass_id, g.gatepass_number, p.party_name,
                gl.article_snapshot, gl.color_snapshot, gl.size_snapshot, gl.quantity,
                ${LINE_DISPATCHED_SQL} AS dispatched_from_store
         FROM gatepass_lines gl
         JOIN gatepasses g ON g.id = gl.gatepass_id
         JOIN parties p ON p.id = g.party_id
         WHERE g.status <> 'CANCELLED' AND gl.product_variant_id = ?
           AND gl.quantity > ${LINE_DISPATCHED_SQL}
         ORDER BY g.gatepass_number ASC
         LIMIT 1`
      )
      .get(String(productVariantId ?? "").trim()) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      gatepassId: String(row.gatepass_id ?? ""),
      gatepassNumber: Number(row.gatepass_number ?? 0),
      partyName: String(row.party_name ?? ""),
      article: String(row.article_snapshot ?? ""),
      color: String(row.color_snapshot ?? ""),
      size: String(row.size_snapshot ?? ""),
      quantity: Number(row.quantity ?? 0),
      dispatchedFromStoreQuantity: Number(row.dispatched_from_store ?? 0),
    };
  },

  /**
   * The Gatepass this exact carton's most recent Store Move Out named, or null. A TO_GATE
   * carton got there by exactly one STORE_EXIT, so its latest one is the move being undone.
   */
  async findGatepassOfLastStoreExit(this: SqliteDatabase, qrId: string, tx: TransactionContext): Promise<string | null> {
    const context = tx as MutableTransactionContext;
    const row = context.db
      .prepare(
        `SELECT gatepass_id FROM production_events
         WHERE qr_id = ? AND event_type = 'MOVED' AND json_extract(metadata_json, '$.eventType') = 'STORE_EXIT'
         ORDER BY event_ts_local DESC, created_at DESC LIMIT 1`
      )
      .get(String(qrId ?? "").trim()) as { gatepass_id: string | null } | undefined;
    return row?.gatepass_id ? String(row.gatepass_id) : null;
  },

  /** Every line of a gatepass with what Store Move Out has taken for it, in document order. */
  readGatepassLineProgress(this: SqliteDatabase, gatepassId: string, db: MutableTransactionContext["db"]) {
    return (
      db
        .prepare(
          // Article, colour, size and quantity are the line's own snapshots — what was cut.
          // The product group is not snapshotted and is read live off the article + size, as
          // a classification for the reader rather than a figure the document is made of.
          `SELECT gl.id, gl.line_no, gl.product_variant_id, gl.article_snapshot, gl.color_snapshot, gl.size_snapshot, gl.quantity,
                  gl.store_quantity_at_creation, pg.group_name, ${LINE_DISPATCHED_SQL} AS dispatched_from_store
           FROM gatepass_lines gl
           LEFT JOIN product_variants pv ON pv.id = gl.product_variant_id
           LEFT JOIN article_sizes ass ON ass.id = pv.article_size_id
           LEFT JOIN product_groups pg ON pg.id = ass.product_group_id
           WHERE gl.gatepass_id = ? ORDER BY gl.line_no ASC`
        )
        .all(gatepassId) as Array<Record<string, unknown>>
    ).map((line) => ({
      id: String(line.id ?? ""),
      lineNo: Number(line.line_no ?? 0),
      storeQuantityAtCreation: Number(line.store_quantity_at_creation ?? 0),
      groupName: line.group_name ? String(line.group_name) : null,
      ...mapLineProgress(line),
    }));
  },

  /** MAX + 1 under the transaction's write lock, like store sessions; the UNIQUE index is the backstop. */
  async allocateGatepassNumber(this: SqliteDatabase, tx: TransactionContext): Promise<number> {
    const context = tx as MutableTransactionContext;
    const row = context.db.prepare("SELECT COALESCE(MAX(gatepass_number), 0) + 1 AS n FROM gatepasses").get() as { n: number };
    return Number(row.n);
  },

  async insertGatepass(this: SqliteDatabase, payload: GatepassHeaderPayload, tx: TransactionContext): Promise<void> {
    const context = tx as MutableTransactionContext;
    context.db
      .prepare(
        `INSERT INTO gatepasses (
          id, gatepass_number, party_id, gatepass_date, status, bilty_number, transport_via, remarks, total_quantity,
          created_by, created_at, updated_at, cancelled_at, cancelled_by, cancel_reason
        ) VALUES (?, ?, ?, ?, 'CREATED', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`
      )
      .run(
        payload.id,
        payload.gatepassNumber,
        payload.partyId,
        payload.gatepassDate,
        payload.biltyNumber,
        payload.transportVia,
        payload.remarks,
        payload.totalQuantity,
        payload.createdBy,
        payload.createdAt,
        payload.createdAt
      );
  },

  async insertGatepassLines(this: SqliteDatabase, lines: GatepassLinePayload[], tx: TransactionContext): Promise<void> {
    const context = tx as MutableTransactionContext;
    const insert = context.db.prepare(
      `INSERT INTO gatepass_lines (
        id, gatepass_id, line_no, product_variant_id, article_snapshot, color_snapshot, size_snapshot,
        quantity, store_quantity_at_creation, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const line of lines) {
      insert.run(
        line.id,
        line.gatepassId,
        line.lineNo,
        line.productVariantId,
        line.article,
        line.color,
        line.size,
        line.quantity,
        line.storeQuantityAtCreation,
        line.createdAt
      );
    }
  },

  /** Immutable audit row in the schema's audit_log table, written in the caller's transaction. */
  async appendAuditLog(this: SqliteDatabase, payload: AuditLogPayload, tx: TransactionContext): Promise<void> {
    const context = tx as MutableTransactionContext;
    const payloadJson = JSON.stringify(payload.payload ?? {});
    context.db
      .prepare(
        `INSERT INTO audit_log (
          id, event_type, event_version, entity_type, entity_id, actor_user_id, actor_device_id, actor_role_code,
          occurred_at, payload_json, hash_sha256, created_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`
      )
      .run(
        payload.id,
        payload.eventType,
        payload.entityType,
        payload.entityId,
        payload.actorUserId,
        payload.actorDeviceId,
        payload.occurredAt,
        payloadJson,
        createHash("sha256").update(payloadJson).digest("hex"),
        context.nowIso
      );
  },

  /** Every user who bills (sale voucher form permission, or administrator) gets the notice, in the same transaction. */
  async notifyBilling(this: SqliteDatabase, payload: BillingNoticePayload, tx: TransactionContext): Promise<void> {
    this.notifyUsersWithPermission(PERMISSION.SALE_VOUCHER_FORM, payload, tx);
  },

  /** The live (not deleted) sale voucher made from this gatepass, read inside the cancel transaction. */
  async getLinkedSaleVoucher(this: SqliteDatabase, gatepassId: string, tx: TransactionContext): Promise<{ id: string; voucherNumber: string } | null> {
    const context = tx as MutableTransactionContext;
    const row = context.db
      .prepare("SELECT id, voucher_number FROM sale_vouchers WHERE gatepass_id = ? AND deleted_at IS NULL LIMIT 1")
      .get(String(gatepassId ?? "").trim()) as { id: string; voucher_number: string } | undefined;
    return row ? { id: String(row.id), voucherNumber: String(row.voucher_number) } : null;
  },

  /** The document plus each line's dispatched-so-far, so the cancellation can state exactly what it releases. */
  async getGatepassForCancel(this: SqliteDatabase, gatepassId: string, tx: TransactionContext): Promise<GatepassForCancel | null> {
    const context = tx as MutableTransactionContext;
    const row = context.db
      .prepare("SELECT id, gatepass_number, status FROM gatepasses WHERE id = ? LIMIT 1")
      .get(String(gatepassId ?? "").trim()) as { id: string; gatepass_number: number; status: string } | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      gatepassNumber: Number(row.gatepass_number),
      status: String(row.status),
      lines: this.readGatepassLineProgress(String(row.id), context.db),
    };
  },

  /** Guarded: only a CREATED document changes, so two clerks cancelling at once yield one cancellation. */
  async markGatepassCancelled(this: SqliteDatabase, 
    payload: { gatepassId: string; cancelledAt: string; cancelledBy: string; reason: string },
    tx: TransactionContext
  ): Promise<boolean> {
    const context = tx as MutableTransactionContext;
    const result = context.db
      .prepare(
        `UPDATE gatepasses
         SET status = 'CANCELLED', cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, updated_at = ?
         WHERE id = ? AND status = 'CREATED'`
      )
      .run(payload.cancelledAt, payload.cancelledBy, payload.reason, context.nowIso, payload.gatepassId);
    return result.changes > 0;
  },

  mapGatepassStatus(this: SqliteDatabase, value: unknown): GatepassStatus {
    const text = String(value ?? "");
    return text in GATEPASS_STATUS ? (text as GatepassStatus) : GATEPASS_STATUS.CREATED;
  },

  // ─── The journey ────────────────────────────────────────────────────────────
  // One guarded move, and every advance in the system goes through it. The guard is the
  // WHERE clause, not a read followed by a write: two operators finishing the last scan at
  // the same instant both run this, and exactly one of them changes a row.

  /**
   * Moves a Gatepass one step along its journey, inside the caller’s transaction.
   *
   * Returns false when the document was not in `from` any more — already advanced by someone
   * else, or cancelled — so the caller can tell the difference between "I advanced it" and
   * "it was already there" without reading it back and racing again. Refuses outright, loudly,
   * when the move is not one the journey allows: that is a programming error, not a race.
   */
  advanceGatepassStatus(
    this: SqliteDatabase,
    payload: { gatepassId: string; from: GatepassStatus; to: GatepassStatus; actor?: string | null; reason?: string },
    tx?: TransactionContext
  ): boolean {
    if (!canTransitionGatepass(payload.from, payload.to)) {
      throw new Error(`A Gatepass cannot go from ${payload.from} to ${payload.to}.`);
    }
    // Callers inside a use case pass their transaction context; callers already running
    // inside an ambient BEGIN on the connection (the billing writes) pass none and share it.
    const context = tx as MutableTransactionContext | undefined;
    const db = context?.db ?? this.db;
    const nowIso = context?.nowIso ?? new Date().toISOString();
    const result = db
      .prepare("UPDATE gatepasses SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
      .run(payload.to, nowIso, payload.gatepassId, payload.from);
    if (result.changes === 0) return false;

    // Everything that follows hangs off this one place, because this is the only way a status
    // ever changes. The audit row is what the journey timeline reads its timestamps from — the
    // screen never invents one — and the notice is sent here, in the same transaction as the
    // move, so a desk can never be told about a change that was rolled back, or told twice
    // about one that was not: a repeat caller finds the row already moved and returns above.
    const doc = db
      .prepare("SELECT gatepass_number, party_id FROM gatepasses WHERE id = ?")
      .get(payload.gatepassId) as { gatepass_number: number; party_id: string } | undefined;
    const code = doc ? formatGatepassCode(Number(doc.gatepass_number)) : payload.gatepassId;

    db.prepare(
      `INSERT INTO audit_log (id, event_type, event_version, entity_type, entity_id, actor_user_id, actor_device_id, actor_role_code, occurred_at, payload_json, hash_sha256, created_at)
       VALUES (?, ?, 1, 'GATEPASS', ?, NULL, NULL, NULL, ?, ?, NULL, ?)`
    ).run(
      crypto.randomUUID(),
      `GATEPASS_${payload.to}`,
      payload.gatepassId,
      nowIso,
      JSON.stringify({ code, from: payload.from, to: payload.to, actor: payload.actor ?? null, reason: payload.reason ?? null }),
      nowIso
    );

    const notice = GATEPASS_TRANSITION_NOTICE[payload.to];
    if (notice) {
      const party = doc
        ? (db.prepare("SELECT party_name FROM parties WHERE id = ?").get(doc.party_id) as { party_name: string } | undefined)
        : undefined;
      const cartons = db
        .prepare("SELECT COALESCE(SUM(quantity), 0) AS n FROM gatepass_lines WHERE gatepass_id = ?")
        .get(payload.gatepassId) as { n: number } | undefined;
      this.notifyUsersWithPermission(
        notice.permission,
        {
          kind: notice.kind,
          severity: NOTIFICATION_SEVERITY.INFO,
          entityId: payload.gatepassId,
          title: `${notice.title} — ${code}`,
          message: `${party?.party_name ?? ""} · ${formatQuantityInDozens(Number(cartons?.n ?? 0))}`.trim(),
        },
        tx
      );
    }
    return true;
  },

  /**
   * The one line of a gatepass that a scanned carton belongs to — matched on the carton's exact
   * identity (article + colour + size IS the product_variant_id), never on article alone.
   *
   * This is what makes a gatepass-locked scan locked: a BLACK carton can only ever find the
   * BLACK line, so it can never be counted against the GREEN one. Returns null when the
   * gatepass does not ask for this carton at all, which the scanner reports as the wrong item.
   */
  findGatepassLineForVariant(
    this: SqliteDatabase,
    gatepassId: string,
    productVariantId: string,
    tx: TransactionContext
  ): { article: string; color: string; size: string; quantity: number; dispatchedFromStoreQuantity: number } | null {
    const context = tx as MutableTransactionContext;
    const row = context.db
      .prepare(
        `SELECT gl.article_snapshot, gl.color_snapshot, gl.size_snapshot, gl.quantity,
                ${LINE_DISPATCHED_SQL} AS dispatched_from_store
         FROM gatepass_lines gl
         WHERE gl.gatepass_id = ? AND gl.product_variant_id = ?`
      )
      .get(gatepassId, productVariantId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      article: String(row.article_snapshot ?? ""),
      color: String(row.color_snapshot ?? ""),
      size: String(row.size_snapshot ?? ""),
      quantity: Number(row.quantity ?? 0),
      dispatchedFromStoreQuantity: Number(row.dispatched_from_store ?? 0),
    };
  },

  /**
   * What a gatepass still needs, per line and in total, for both scanning desks.
   *
   * Store progress is the move-out events already attributed to this gatepass; dispatch
   * progress is the DISPATCHED events of its bill's session for that exact variant — so colour
   * is counted apart even though the bill itself has no colour. Everything is in cartons, the
   * unit the database counts in; the screens convert once, through formatQuantityInDozens.
   */
  getGatepassScanProgress(this: SqliteDatabase, gatepassId: string): GatepassScanProgress | null {
    const doc = this.db
      .prepare(
        `SELECT g.id, g.gatepass_number, g.status, p.party_name,
                (SELECT sv.voucher_number FROM sale_vouchers sv WHERE sv.gatepass_id = g.id AND sv.deleted_at IS NULL LIMIT 1) AS voucher_number,
                (SELECT sv.id FROM sale_vouchers sv WHERE sv.gatepass_id = g.id AND sv.deleted_at IS NULL LIMIT 1) AS voucher_id
         FROM gatepasses g JOIN parties p ON p.id = g.party_id WHERE g.id = ?`
      )
      .get(gatepassId) as
      | { id: string; gatepass_number: number; status: string; party_name: string; voucher_number: string | null; voucher_id: string | null }
      | undefined;
    if (!doc) return null;

    const sessionRow = doc.voucher_id
      ? (this.db.prepare("SELECT id FROM dispatch_sessions WHERE voucher_id = ? LIMIT 1").get(doc.voucher_id) as { id: string } | undefined)
      : undefined;
    const dispatchSessionId = sessionRow?.id ?? null;

    // One query for every line: no per-line round trip, so a ten-line gatepass costs the same
    // as a one-line gatepass on a screen the floor refreshes after every scan.
    const rows = this.db
      .prepare(
        `SELECT gl.product_variant_id, gl.article_snapshot, gl.color_snapshot, gl.size_snapshot, gl.quantity,
                ${LINE_DISPATCHED_SQL} AS moved_out,
                COALESCE((SELECT COUNT(1) FROM production_events pe
                          WHERE pe.event_type = 'DISPATCHED'
                            AND pe.dispatch_session_id = ?
                            AND pe.product_variant_id = gl.product_variant_id), 0) AS dispatched
         FROM gatepass_lines gl WHERE gl.gatepass_id = ? ORDER BY gl.line_no`
      )
      .all(dispatchSessionId, gatepassId) as Array<Record<string, unknown>>;

    const lines = rows.map((row) => {
      const quantity = Number(row.quantity ?? 0);
      const movedOut = Number(row.moved_out ?? 0);
      const dispatched = Number(row.dispatched ?? 0);
      return {
        productVariantId: String(row.product_variant_id ?? ""),
        article: String(row.article_snapshot ?? ""),
        color: String(row.color_snapshot ?? ""),
        size: String(row.size_snapshot ?? ""),
        requiredCartons: quantity,
        storeScannedCartons: movedOut,
        storeRemainingCartons: Math.max(0, quantity - movedOut),
        dispatchedCartons: dispatched,
        dispatchRemainingCartons: Math.max(0, quantity - dispatched),
      };
    });

    const sum = (pick: (line: (typeof lines)[number]) => number) => lines.reduce((total, line) => total + pick(line), 0);
    return {
      gatepassId: doc.id,
      code: formatGatepassCode(Number(doc.gatepass_number)),
      status: this.mapGatepassStatus(doc.status),
      partyName: doc.party_name,
      voucherNumber: doc.voucher_number,
      dispatchSessionId,
      lines,
      requiredCartons: sum((l) => l.requiredCartons),
      storeScannedCartons: sum((l) => l.storeScannedCartons),
      storeRemainingCartons: sum((l) => l.storeRemainingCartons),
      dispatchedCartons: sum((l) => l.dispatchedCartons),
      dispatchRemainingCartons: sum((l) => l.dispatchRemainingCartons),
    };
  },

  /**
   * The dispatch allowance for a gatepass-locked scan: the gatepass's own line for this exact
   * carton, and what its bill's session has already taken of it.
   *
   * The bill is colour-blind by design (docs/23 — price lives on article + size), so the
   * ordinary dispatch allowance matches article + size and calls every colour "ALL COLORS".
   * A gatepass knows the colour, so a gatepass-locked dispatch can hold the operator to it
   * without changing what the bill means or how the dispatch is attributed.
   */
  checkGatepassDispatchAllowance(this: SqliteDatabase, gatepassId: string, productVariantId: string): DispatchAllowance | null {
    const empty = { allowed: false, lineItemId: null, article: "", color: "", size: "", requiredCartons: 0, dispatchedCartons: 0, requiredPairs: 0, dispatchedPairs: 0 };
    const progress = this.getGatepassScanProgress(gatepassId);
    if (!progress) return null;
    const line = progress.lines.find((candidate) => candidate.productVariantId === productVariantId);
    if (!line) return empty;
    return {
      allowed: line.dispatchRemainingCartons > 0,
      lineItemId: null,
      article: line.article,
      color: line.color,
      size: line.size,
      requiredCartons: line.requiredCartons,
      dispatchedCartons: line.dispatchedCartons,
      requiredPairs: cartonsToPairs(line.requiredCartons),
      dispatchedPairs: cartonsToPairs(line.dispatchedCartons),
    };
  },

  /** Whether every line of a gatepass has had its full quantity dispatched. */
  gatepassDispatchComplete(this: SqliteDatabase, gatepassId: string): boolean {
    const progress = this.getGatepassScanProgress(gatepassId);
    return !!progress && progress.lines.length > 0 && progress.dispatchRemainingCartons === 0;
  },

  // ─── Delivery proof ─────────────────────────────────────────────────────────
  // DELIVERED means a persisted delivery proof exists. That is the whole invariant, and it
  // is kept by writing the proof row and the status change in ONE transaction: there is no
  // moment at which the database says delivered without a proof to show for it.

  /** The proof currently standing for a gatepass, or null when none has been recorded. */
  getGatepassDeliveryProof(this: SqliteDatabase, gatepassId: string): GatepassDeliveryProof | null {
    const row = this.db
      .prepare(
        `SELECT id, gatepass_id, file_name, mime_type, byte_size, original_name, uploaded_by, uploaded_at
         FROM gatepass_delivery_proofs WHERE gatepass_id = ? AND is_current = 1 LIMIT 1`
      )
      .get(gatepassId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      gatepassId: String(row.gatepass_id),
      fileName: String(row.file_name),
      mimeType: String(row.mime_type),
      byteSize: Number(row.byte_size ?? 0),
      originalName: row.original_name == null ? null : String(row.original_name),
      uploadedBy: row.uploaded_by == null ? null : String(row.uploaded_by),
      uploadedAt: String(row.uploaded_at),
    };
  },

  /**
   * Records a delivery proof against a gatepass and, when it is the first one, delivers it.
   *
   * The file is already on disk when this runs — written under a name this application chose,
   * before anything is committed. What happens here is the part that must not half-happen:
   * the previous proof stops being current, the new row becomes current, and a DISPATCHED
   * document advances. If any of it fails nothing is written, and the caller deletes the file
   * it had just written, so a rolled-back upload leaves neither a row nor an orphan.
   *
   * Replacing is deliberately NOT a status move: a document that is already DELIVERED stays
   * delivered, no second transition is recorded and no second notice is sent. The replaced row
   * is kept, so what was shown as proof before is still answerable.
   */
  saveGatepassDeliveryProof(
    this: SqliteDatabase,
    input: { gatepassId: string; fileName: string; mimeType: string; byteSize: number; originalName?: string | null; uploadedBy?: string | null }
  ): { proofId: string; delivered: boolean; replacedFileName: string | null } {
    const doc = this.db.prepare("SELECT id, status FROM gatepasses WHERE id = ?").get(input.gatepassId) as { id: string; status: string } | undefined;
    if (!doc) throw new Error("That Gatepass could not be found.");
    if (doc.status !== "DISPATCHED" && doc.status !== "DELIVERED") {
      throw new Error("A delivery proof can only be recorded once the Gatepass has been dispatched.");
    }
    if (!input.fileName.trim() || !input.mimeType.trim() || !(input.byteSize > 0)) {
      throw new Error("The delivery proof could not be saved.");
    }

    const now = new Date().toISOString();
    const proofId = crypto.randomUUID();
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const previous = this.db
        .prepare("SELECT id, file_name FROM gatepass_delivery_proofs WHERE gatepass_id = ? AND is_current = 1")
        .get(input.gatepassId) as { id: string; file_name: string } | undefined;
      if (previous) {
        this.db
          .prepare("UPDATE gatepass_delivery_proofs SET is_current = 0, replaced_at = ? WHERE id = ?")
          .run(now, previous.id);
      }

      this.db
        .prepare(
          `INSERT INTO gatepass_delivery_proofs
             (id, gatepass_id, file_name, mime_type, byte_size, original_name, is_current, uploaded_by, uploaded_at, replaced_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`
        )
        .run(proofId, input.gatepassId, input.fileName, input.mimeType, Math.trunc(input.byteSize), input.originalName ?? null, input.uploadedBy ?? null, now);

      // The first proof is what delivers the document. A replacement is not a journey step.
      const delivered = doc.status === "DISPATCHED"
        ? this.advanceGatepassStatus({ gatepassId: input.gatepassId, from: "DISPATCHED", to: "DELIVERED", actor: input.uploadedBy ?? null })
        : false;

      if (previous) {
        this.writeInventoryAudit(
          null, "GATEPASS_DELIVERY_PROOF", input.gatepassId, "REPLACE",
          { proofId: previous.id, fileName: previous.file_name },
          { proofId, fileName: input.fileName, originalName: input.originalName ?? null },
          input.uploadedBy ?? undefined
        );
      }

      this.db.exec("COMMIT");
      return { proofId, delivered, replacedFileName: previous?.file_name ?? null };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }
  },

  /**
   * How many gatepasses are sitting at each desk. One grouped count rather than a query per
   * stage, so the workspace header costs the same whether there are four stages or forty.
   */
  countGatepassesByStage(this: SqliteDatabase): Record<string, number> {
    const rows = this.db.prepare("SELECT status, COUNT(1) AS n FROM gatepasses GROUP BY status").all() as Array<{ status: string; n: number }>;
    const counts: Record<string, number> = {};
    for (const stage of GATEPASS_STAGES) counts[stage.status] = 0;
    for (const row of rows) counts[String(row.status)] = Number(row.n);
    return counts;
  },

  /**
   * The document's journey: every step, in order, with the moment it actually happened read
   * from the audit trail. Steps that have not happened carry no time — the screen shows them
   * as still to come rather than guessing a date for them.
   */
  getGatepassJourney(this: SqliteDatabase, gatepassId: string): GatepassJourneyStep[] | null {
    const doc = this.db.prepare("SELECT id, status, created_at, created_by, cancelled_at, cancelled_by FROM gatepasses WHERE id = ?").get(gatepassId) as
      | { id: string; status: string; created_at: string; created_by: string | null; cancelled_at: string | null; cancelled_by: string | null }
      | undefined;
    if (!doc) return null;

    const events = this.db
      .prepare("SELECT event_type, occurred_at, payload_json FROM audit_log WHERE entity_type = 'GATEPASS' AND entity_id = ? ORDER BY occurred_at ASC, rowid ASC")
      .all(gatepassId) as Array<{ event_type: string; occurred_at: string; payload_json: string | null }>;

    // The first time each step was reached. A document that went back and forth (a bill made,
    // deleted and made again) keeps the first arrival, which is what the timeline is about.
    const reachedAt = new Map<string, { at: string; actor: string | null }>();
    for (const event of events) {
      const status = event.event_type.replace(/^GATEPASS_/, "");
      if (reachedAt.has(status)) continue;
      let actor: string | null = null;
      try {
        actor = (JSON.parse(event.payload_json ?? "{}") as { actor?: string | null }).actor ?? null;
      } catch { /* a payload we cannot read still tells us when */ }
      reachedAt.set(status, { at: event.occurred_at, actor });
    }
    // Creation predates the audit trail on older documents, so the row itself is the fallback.
    if (!reachedAt.has("CREATED")) reachedAt.set("CREATED", { at: doc.created_at, actor: doc.created_by });

    const currentIndex = GATEPASS_JOURNEY.indexOf(doc.status as (typeof GATEPASS_JOURNEY)[number]);
    return GATEPASS_JOURNEY.map((status, index) => {
      const reached = reachedAt.get(status);
      const state =
        currentIndex < 0
          ? reached
            ? "DONE"
            : "PENDING"
          : index < currentIndex
            ? "DONE"
            : index === currentIndex
              ? "CURRENT"
              : "PENDING";
      return { status, label: GATEPASS_STATUS_LABEL[status], state, at: reached?.at ?? null, actor: reached?.actor ?? null };
    });
  },

  /** The status a Gatepass is in right now, read under the caller’s lock. */
  readGatepassStatus(this: SqliteDatabase, gatepassId: string, tx?: TransactionContext): GatepassStatus | null {
    const context = tx as MutableTransactionContext | undefined;
    const row = (context?.db ?? this.db).prepare("SELECT status FROM gatepasses WHERE id = ?").get(gatepassId) as { status: string } | undefined;
    return row ? this.mapGatepassStatus(row.status) : null;
  },

  /**
   * Whether every line of a Gatepass has had its full quantity scanned out of the store.
   * Read from the events themselves (the same derivation Reflected Stock uses), never from a
   * cached counter, so it cannot drift from what the scanners actually recorded.
   */
  gatepassStoreScanComplete(this: SqliteDatabase, gatepassId: string, tx?: TransactionContext): boolean {
    const context = tx as MutableTransactionContext | undefined;
    const outstanding = (context?.db ?? this.db)
      .prepare(`SELECT COUNT(1) AS n FROM gatepass_lines gl
                WHERE gl.gatepass_id = ? AND gl.quantity > ${LINE_DISPATCHED_SQL}`)
      .get(gatepassId) as { n: number } | undefined;
    return (outstanding?.n ?? 0) === 0;
  },

  getGatepass(this: SqliteDatabase, gatepassId: string): GatepassRecord | null {
    const row = this.db
      .prepare(
        `SELECT g.id, g.gatepass_number, g.party_id, g.gatepass_date, g.status, g.bilty_number, g.transport_via, g.remarks, g.total_quantity,
                g.created_by, g.created_at, g.updated_at, g.cancelled_at, g.cancelled_by, g.cancel_reason,
                p.party_name, p.party_code, p.city
         FROM gatepasses g
         JOIN parties p ON p.id = g.party_id
         WHERE g.id = ? LIMIT 1`
      )
      .get(String(gatepassId ?? "").trim()) as Record<string, unknown> | undefined;
    if (!row) return null;

    const lines = this.readGatepassLineProgress(String(row.id), this.db);
    const dispatchedFromStoreQuantity = lines.reduce((sum, line) => sum + line.dispatchedFromStoreQuantity, 0);
    const totalQuantity = Number(row.total_quantity ?? 0);

    const gatepassNumber = Number(row.gatepass_number ?? 0);
    return {
      id: String(row.id ?? ""),
      code: formatGatepassCode(gatepassNumber),
      gatepassNumber,
      partyId: String(row.party_id ?? ""),
      partyName: String(row.party_name ?? ""),
      partyCode: String(row.party_code ?? ""),
      partyCity: row.city ? String(row.city) : null,
      gatepassDate: String(row.gatepass_date ?? ""),
      status: this.mapGatepassStatus(row.status),
      biltyNumber: row.bilty_number ? String(row.bilty_number) : null,
      transportVia: row.transport_via ? String(row.transport_via) : null,
      remarks: row.remarks ? String(row.remarks) : null,
      totalQuantity,
      dispatchedFromStoreQuantity,
      outstandingQuantity: outstandingQuantity(totalQuantity, dispatchedFromStoreQuantity),
      lineCount: lines.length,
      createdBy: row.created_by ? String(row.created_by) : null,
      createdAt: String(row.created_at ?? ""),
      updatedAt: String(row.updated_at ?? ""),
      cancelledAt: row.cancelled_at ? String(row.cancelled_at) : null,
      cancelledBy: row.cancelled_by ? String(row.cancelled_by) : null,
      cancelReason: row.cancel_reason ? String(row.cancel_reason) : null,
      lines,
    };
  },

  /** The same document by its number (GP-000123 → 123), for previous / next / load on the Gatepass screen. */
  getGatepassByNumber(this: SqliteDatabase, gatepassNumber: number): GatepassRecord | null {
    if (!Number.isInteger(gatepassNumber) || gatepassNumber < 1) return null;
    const row = this.db.prepare("SELECT id FROM gatepasses WHERE gatepass_number = ? LIMIT 1").get(gatepassNumber) as { id: string } | undefined;
    return row ? this.getGatepass(String(row.id)) : null;
  },

  listGatepasses(this: SqliteDatabase, query: GatepassListQuery = {}): PagedResult<GatepassListRow> {
    const page = Math.max(1, Number(query.page ?? 1));
    const pageSize = Math.max(1, Math.min(Number(query.pageSize ?? 25), 200));
    const offset = (page - 1) * pageSize;

    const where: string[] = ["1 = 1"];
    const values: Array<string | number> = [];

    const search = String(query.search ?? "").trim();
    if (search) {
      // "GP-000012", "12" and "abc traders" all work.
      const digits = search.replace(/^gp-?/i, "").replace(/^0+/, "");
      const needle = `%${search}%`;
      if (/^\d+$/.test(digits)) {
        where.push("(g.gatepass_number = ? OR p.party_name LIKE ?)");
        values.push(Number(digits), needle);
      } else {
        where.push("p.party_name LIKE ?");
        values.push(needle);
      }
    }
    if (query.partyId) {
      where.push("g.party_id = ?");
      values.push(String(query.partyId));
    }
    if (query.article?.trim()) {
      where.push("EXISTS (SELECT 1 FROM gatepass_lines gl WHERE gl.gatepass_id = g.id AND gl.article_snapshot = ? COLLATE NOCASE)");
      values.push(query.article.trim());
    }
    if (query.fromDate) {
      where.push("g.gatepass_date >= ?");
      values.push(String(query.fromDate));
    }
    if (query.toDate) {
      where.push("g.gatepass_date <= ?");
      values.push(String(query.toDate));
    }
    if (query.status && query.status !== "ALL") {
      where.push("g.status = ?");
      values.push(query.status);
    }
    const whereClause = where.join(" AND ");
    const from = "FROM gatepasses g JOIN parties p ON p.id = g.party_id";

    const total = this.scalarCount(`SELECT COUNT(1) AS c ${from} WHERE ${whereClause}`, values);
    const rows = this.db
      .prepare(
        `SELECT g.id, g.gatepass_number, g.party_id, g.gatepass_date, g.status, g.total_quantity, g.created_by, g.created_at,
                p.party_name,
                (SELECT COUNT(1) FROM gatepass_lines gl WHERE gl.gatepass_id = g.id) AS line_count,
                (SELECT COALESCE(SUM(${LINE_DISPATCHED_SQL}), 0) FROM gatepass_lines gl WHERE gl.gatepass_id = g.id) AS dispatched_from_store,
                (SELECT GROUP_CONCAT(article, '|') FROM (
                   SELECT DISTINCT gl.article_snapshot AS article FROM gatepass_lines gl WHERE gl.gatepass_id = g.id ORDER BY gl.article_snapshot
                 )) AS articles
         ${from}
         WHERE ${whereClause}
         ORDER BY g.gatepass_number DESC
         LIMIT ? OFFSET ?`
      )
      .all(...values, pageSize, offset) as Array<Record<string, unknown>>;

    return {
      rows: rows.map((row) => {
        const gatepassNumber = Number(row.gatepass_number ?? 0);
        const totalQuantity = Number(row.total_quantity ?? 0);
        const dispatchedFromStoreQuantity = Number(row.dispatched_from_store ?? 0);
        return {
          id: String(row.id ?? ""),
          code: formatGatepassCode(gatepassNumber),
          gatepassNumber,
          partyId: String(row.party_id ?? ""),
          partyName: String(row.party_name ?? ""),
          gatepassDate: String(row.gatepass_date ?? ""),
          status: this.mapGatepassStatus(row.status),
          totalQuantity,
          dispatchedFromStoreQuantity,
          outstandingQuantity: outstandingQuantity(totalQuantity, dispatchedFromStoreQuantity),
          lineCount: Number(row.line_count ?? 0),
          articles: row.articles ? String(row.articles).split("|").filter(Boolean) : [],
          createdBy: row.created_by ? String(row.created_by) : null,
          createdAt: String(row.created_at ?? ""),
        };
      }),
      total,
      page,
      pageSize,
    };
  },
};

export type GatepassMethods = typeof gatepassMethods;
