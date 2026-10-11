// Stock corrections: a claim that a raw material's shelf count disagrees with the system,
// reviewed by an administrator before it touches stock.
//
// Raw material stock moves by itself — a Raw Material Input scan adds one packet, an Output
// scan takes one away. So a manual correction is never a movement; it is somebody saying the
// system is wrong. That is worth a reason and a second pair of eyes, which is what this is.
//
// The approval is what applies it: `reviewStockCorrectionRequest` records the decision and
// calls `applyInventoryStockChange` inside ONE transaction, so an approved request and its
// stock event can never disagree about whether the correction happened. There is still
// exactly one implementation of what a correction does to stock — this module does not
// calculate a balance of its own.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import { NOTIFICATION_KIND, STOCK_CORRECTION_MIN_REASON, STOCK_CORRECTION_STATUS } from "@erp/domain";
import type { SqliteDatabase } from "../sqliteDatabase.js";
import type { StockCorrectionRequestRow } from "./types.js";

const SELECT_REQUEST = `
  SELECT r.id, r.request_code, r.item_id, r.item_display_name, r.item_code, r.quantity,
         r.unit_id, u.code AS unit_code, r.reason, r.status,
         r.requested_by, requester.username AS requested_by_name, r.requested_at,
         r.reviewed_by, reviewer.username AS reviewed_by_name, r.reviewed_at, r.review_notes
  FROM stock_correction_requests r
  LEFT JOIN inventory_units u ON u.id = r.unit_id
  LEFT JOIN app_users requester ON requester.id = r.requested_by
  LEFT JOIN app_users reviewer ON reviewer.id = r.reviewed_by`;

const toRow = (row: Record<string, unknown>): StockCorrectionRequestRow => ({
  id: String(row.id),
  requestCode: String(row.request_code),
  itemId: String(row.item_id),
  itemDisplayName: String(row.item_display_name),
  itemCode: String(row.item_code),
  quantity: Number(row.quantity),
  unitId: row.unit_id ? String(row.unit_id) : null,
  unitCode: row.unit_code ? String(row.unit_code) : null,
  reason: String(row.reason),
  status: String(row.status) as StockCorrectionRequestRow["status"],
  requestedBy: String(row.requested_by),
  requestedByName: row.requested_by_name ? String(row.requested_by_name) : null,
  requestedAt: String(row.requested_at),
  reviewedBy: row.reviewed_by ? String(row.reviewed_by) : null,
  reviewedByName: row.reviewed_by_name ? String(row.reviewed_by_name) : null,
  reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
  reviewNotes: row.review_notes ? String(row.review_notes) : null,
});

/** "+3 DOZ" / "-2 DOZ" — how a correction reads in a notification and in the ledger. */
const describeChange = (quantity: number, unitCode: string | null): string =>
  `${quantity > 0 ? "+" : ""}${Number(quantity.toFixed(3))}${unitCode ? ` ${unitCode}` : ""}`;

export const stockCorrectionsMethods = {
  /**
   * Records a correction awaiting approval, and tells the administrator about it.
   *
   * Nothing is applied here. The material, the quantity and the unit are snapshotted so the
   * request stays readable and reviewable even if the material is renamed afterwards.
   */
  createStockCorrectionRequest(
    this: SqliteDatabase,
    input: { itemId: string; quantity: number; reason: string; requestedBy: string }
  ): StockCorrectionRequestRow {
    const quantity = Number(input.quantity);
    if (!Number.isFinite(quantity) || quantity === 0) {
      throw new Error("Enter how much the count is out by — a positive or negative number.");
    }

    const reason = String(input.reason ?? "").trim();
    if (reason.length < STOCK_CORRECTION_MIN_REASON) {
      throw new Error("Say why the count is wrong — the administrator has to judge it.");
    }

    const item = this.db
      .prepare(
        `SELECT ii.id, ii.item_code, ii.display_name,
                COALESCE(isb.unit_id, ii.default_unit_id) AS unit_id
         FROM inventory_items ii
         LEFT JOIN inventory_stock_balances isb ON isb.item_id = ii.id
         WHERE ii.id = ? AND ii.status = 'ACTIVE' LIMIT 1`
      )
      .get(input.itemId) as { id: string; item_code: string; display_name: string; unit_id: string | null } | undefined;
    if (!item) throw new Error("Raw material not found");

    const open = this.db
      .prepare(
        `SELECT r.request_code, u.username FROM stock_correction_requests r
         LEFT JOIN app_users u ON u.id = r.requested_by
         WHERE r.item_id = ? AND r.status = 'PENDING' LIMIT 1`
      )
      .get(input.itemId) as { request_code: string; username: string | null } | undefined;
    if (open) {
      throw new Error(
        `${open.username ?? "Someone"} already has a correction waiting for approval on this material (${open.request_code}).`
      );
    }

    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      // Allocated inside the write lock, so the code that is read is the code that is inserted.
      const next = this.db
        .prepare("SELECT COALESCE(MAX(CAST(SUBSTR(request_code, 5) AS INTEGER)), 0) + 1 AS n FROM stock_correction_requests WHERE request_code LIKE 'SCR-%'")
        .get() as { n: number };
      const requestCode = `SCR-${String(next.n).padStart(6, "0")}`;

      this.db
        .prepare(
          `INSERT INTO stock_correction_requests
             (id, request_code, item_id, item_display_name, item_code, quantity, unit_id, reason, status, requested_by, requested_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`
        )
        .run(id, requestCode, item.id, item.display_name, item.item_code, quantity, item.unit_id, reason, input.requestedBy, now);

      const unitCode = item.unit_id
        ? ((this.db.prepare("SELECT code FROM inventory_units WHERE id = ?").get(item.unit_id) as { code?: string } | undefined)?.code ?? null)
        : null;
      const requester = this.db.prepare("SELECT username FROM app_users WHERE id = ?").get(input.requestedBy) as { username?: string } | undefined;

      // The administrator is told about it; the material is the useful destination, so the
      // notice carries the item id rather than the request id.
      const adminId = this.getAdministratorId();
      if (adminId && adminId !== input.requestedBy) {
        this.db
          .prepare("INSERT INTO user_notifications (id, user_id, title, message, created_at, kind, entity_id, severity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(
            crypto.randomUUID(),
            adminId,
            "Stock correction to approve",
            `${requester?.username ?? "A user"} asked to change ${item.display_name} by ${describeChange(quantity, unitCode)} — "${reason}" (${requestCode})`,
            now,
            NOTIFICATION_KIND.STOCK_CORRECTION_REQUESTED,
            item.id,
            "WARNING"
          );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return this.getStockCorrectionRequest(id)!;
  },

  getStockCorrectionRequest(this: SqliteDatabase, requestId: string): StockCorrectionRequestRow | null {
    const row = this.db.prepare(`${SELECT_REQUEST} WHERE r.id = ? LIMIT 1`).get(requestId) as Record<string, unknown> | undefined;
    return row ? toRow(row) : null;
  },

  /** Every correction, newest first, pending ones first. `status` narrows it. */
  listStockCorrectionRequests(this: SqliteDatabase, filters: { status?: string; limit?: number } = {}): StockCorrectionRequestRow[] {
    const limit = Math.min(Math.max(Math.trunc(filters.limit ?? 100), 1), 500);
    const where = filters.status ? "WHERE r.status = ?" : "";
    const args: Array<string | number> = filters.status ? [filters.status, limit] : [limit];
    const rows = this.db
      .prepare(`${SELECT_REQUEST} ${where} ORDER BY r.status = 'PENDING' DESC, r.requested_at DESC LIMIT ?`)
      .all(...args) as Array<Record<string, unknown>>;
    return rows.map(toRow);
  },

  /** One material's corrections — what the operator sees beside its stock. */
  listStockCorrectionRequestsForItem(this: SqliteDatabase, itemId: string, limit = 20): StockCorrectionRequestRow[] {
    const capped = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const rows = this.db
      .prepare(`${SELECT_REQUEST} WHERE r.item_id = ? ORDER BY r.status = 'PENDING' DESC, r.requested_at DESC LIMIT ?`)
      .all(itemId, capped) as Array<Record<string, unknown>>;
    return rows.map(toRow);
  },

  /**
   * An administrator's decision. Approving is what applies the correction: the status
   * change, the stock event and the balance all move in one transaction, so a request can
   * never be marked approved without the stock having actually changed — or the reverse.
   *
   * The requester is told either way.
   */
  reviewStockCorrectionRequest(
    this: SqliteDatabase,
    input: { requestId: string; reviewerId: string; decision: "APPROVED" | "REJECTED"; reviewNotes?: string }
  ): StockCorrectionRequestRow {
    const reviewer = this.db.prepare("SELECT id, role, username FROM app_users WHERE id = ?").get(input.reviewerId) as
      | { id: string; role?: string; username?: string }
      | undefined;
    if (reviewer?.role !== "ADMIN") throw new Error("Administrator access required");

    const request = this.db
      .prepare("SELECT id, item_id, item_display_name, quantity, unit_id, reason, status, requested_by, request_code FROM stock_correction_requests WHERE id = ?")
      .get(input.requestId) as
      | { id: string; item_id: string; item_display_name: string; quantity: number; unit_id: string | null; reason: string; status: string; requested_by: string; request_code: string }
      | undefined;
    if (!request || request.status !== STOCK_CORRECTION_STATUS.PENDING) {
      throw new Error("This correction has already been decided.");
    }

    const now = new Date().toISOString();
    const notes = typeof input.reviewNotes === "string" ? input.reviewNotes.trim() || null : null;

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      // Guarded: only a still-pending request moves, so two administrators deciding at the
      // same moment cannot both apply the change.
      const moved = this.db
        .prepare("UPDATE stock_correction_requests SET status = ?, reviewed_by = ?, reviewed_at = ?, review_notes = ? WHERE id = ? AND status = 'PENDING'")
        .run(input.decision, input.reviewerId, now, notes, request.id);
      if (Number(moved.changes) === 0) throw new Error("This correction has already been decided.");

      if (input.decision === STOCK_CORRECTION_STATUS.APPROVED) {
        this.applyInventoryStockChange({
          itemId: request.item_id,
          quantity: request.quantity,
          eventType: "ADJUST",
          unitId: request.unit_id ?? undefined,
          note: `${request.reason} (${request.request_code}, approved by ${reviewer.username ?? "admin"})`,
          createdBy: reviewer.username ?? undefined,
        });
      }

      const unitCode = request.unit_id
        ? ((this.db.prepare("SELECT code FROM inventory_units WHERE id = ?").get(request.unit_id) as { code?: string } | undefined)?.code ?? null)
        : null;
      const approved = input.decision === STOCK_CORRECTION_STATUS.APPROVED;
      this.db
        .prepare("INSERT INTO user_notifications (id, user_id, title, message, created_at, kind, entity_id, severity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          crypto.randomUUID(),
          request.requested_by,
          approved ? "Stock correction approved" : "Stock correction declined",
          approved
            ? `${request.item_display_name} has been changed by ${describeChange(request.quantity, unitCode)}. (${request.request_code})`
            : `Your correction of ${describeChange(request.quantity, unitCode)} on ${request.item_display_name} was declined${notes ? ` — "${notes}"` : ""}. Nothing changed. (${request.request_code})`,
          now,
          approved ? NOTIFICATION_KIND.STOCK_CORRECTION_APPROVED : NOTIFICATION_KIND.STOCK_CORRECTION_REJECTED,
          request.item_id,
          approved ? "INFO" : "WARNING"
        );

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return this.getStockCorrectionRequest(request.id)!;
  },

  /**
   * An administrator correcting a count themselves. They are the approver, so there is
   * nobody to wait for — but it goes through the same record and the same stock path, so
   * every correction has one audit trail and one implementation.
   */
  applyAdminStockCorrection(
    this: SqliteDatabase,
    input: { itemId: string; quantity: number; reason: string; adminId: string }
  ): StockCorrectionRequestRow {
    const request = this.createStockCorrectionRequest({
      itemId: input.itemId,
      quantity: input.quantity,
      reason: input.reason,
      requestedBy: input.adminId,
    });
    return this.reviewStockCorrectionRequest({
      requestId: request.id,
      reviewerId: input.adminId,
      decision: STOCK_CORRECTION_STATUS.APPROVED,
    });
  },
};

export type StockCorrectionsMethods = typeof stockCorrectionsMethods;
