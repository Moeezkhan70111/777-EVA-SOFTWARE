// Removing master data, with an administrator's approval.
//
// A category is the shape every material of that kind is described by, not a record of
// something that happened. Deleting one is irreversible — its attributes go with it — so it
// takes the same path a stock correction takes: a REQUEST, which an administrator decides,
// and the approval is what performs the deletion, in the same transaction that records the
// decision. A request can never be marked approved without the thing actually being gone, or
// the reverse. An administrator removing a category is the approver, so theirs is carried out
// at once; it is recorded the same way, so every removal has one audit trail.
//
// Only an EMPTY category can go: no sub-categories and no materials, active or inactive.
// Emptiness is checked when the request is raised AND again inside the approving transaction,
// because a material can be filed under the category while the request waits.
//
// A MATERIAL follows the same path, with one difference worth being clear about. Its own stock
// ledger -- its movements and its balance -- goes WITH it, because that ledger describes nothing
// else and would otherwise be left pointing at a material that no longer exists. What can never
// go is anything OUTSIDE the material that names it: a printed QR label, a scan of one, a
// purchase line, a machine program line. Those are stickers and documents out in the world, and
// the answer there is still to disable the material rather than erase it.
//
// A stock correction sits on the ledger side of that line: it is a claim about THIS material
// count, snapshotted with its own name and code, and it means nothing once the material it
// counts is gone.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import { NOTIFICATION_KIND, REMOVAL_STATUS, REMOVAL_TARGET } from "@erp/domain";
import type { SqliteDatabase } from "../sqliteDatabase.js";
import type { RemovalRequestRow } from "./types.js";

const SELECT_REQUEST = `
  SELECT r.id, r.request_code, r.target_type, r.target_id, r.target_name, r.reason, r.status,
         r.requested_by, requester.username AS requested_by_name, r.requested_at,
         r.reviewed_by, reviewer.username AS reviewed_by_name, r.reviewed_at, r.review_notes
  FROM removal_requests r
  LEFT JOIN app_users requester ON requester.id = r.requested_by
  LEFT JOIN app_users reviewer ON reviewer.id = r.reviewed_by`;

const toRow = (row: Record<string, unknown>): RemovalRequestRow => ({
  id: String(row.id),
  requestCode: String(row.request_code),
  targetType: String(row.target_type) as RemovalRequestRow["targetType"],
  targetId: String(row.target_id),
  targetName: String(row.target_name),
  reason: row.reason ? String(row.reason) : null,
  status: String(row.status) as RemovalRequestRow["status"],
  requestedBy: String(row.requested_by),
  requestedByName: row.requested_by_name ? String(row.requested_by_name) : null,
  requestedAt: String(row.requested_at),
  reviewedBy: row.reviewed_by ? String(row.reviewed_by) : null,
  reviewedByName: row.reviewed_by_name ? String(row.reviewed_by_name) : null,
  reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
  reviewNotes: row.review_notes ? String(row.review_notes) : null,
});

export const removalRequestsMethods = {
  /**
   * What would stop this category being deleted, in the words the operator should read.
   * An empty list means it can go. Inactive materials count: they are still filed here, and
   * deleting the category would leave them pointing at nothing.
   */
  categoryRemovalBlockers(this: SqliteDatabase, categoryId: string): string[] {
    const category = this.db.prepare("SELECT id, name FROM inventory_categories WHERE id = ?").get(categoryId) as
      | { id: string; name: string }
      | undefined;
    if (!category) return ["This category no longer exists."];

    const blockers: string[] = [];

    const subs = this.db
      .prepare("SELECT COUNT(*) AS n FROM inventory_categories WHERE parent_id = ?")
      .get(categoryId) as { n: number };
    if (Number(subs.n) > 0) {
      blockers.push(`${subs.n} sub-categor${Number(subs.n) === 1 ? "y" : "ies"}`);
    }

    const items = this.db.prepare("SELECT COUNT(*) AS n FROM inventory_items WHERE category_id = ?").get(categoryId) as {
      n: number;
    };
    if (Number(items.n) > 0) {
      blockers.push(`${items.n} raw material${Number(items.n) === 1 ? "" : "s"}`);
    }

    return blockers;
  },

  /**
   * What would stop this material being removed for good -- only the things OUTSIDE it that
   * name it. Its own stock movements and balance are not blockers: an approved removal takes
   * them with it. An empty list means it can go.
   */
  itemRemovalBlockers(this: SqliteDatabase, itemId: string): string[] {
    const item = this.db.prepare("SELECT id FROM inventory_items WHERE id = ?").get(itemId) as { id: string } | undefined;
    if (!item) return ["This material no longer exists."];

    const count = (sql: string): number => Number((this.db.prepare(sql).get(itemId) as { n: number } | undefined)?.n ?? 0);
    const blockers: string[] = [];
    const add = (n: number, one: string, many: string) => {
      if (n > 0) blockers.push(`${n} ${n === 1 ? one : many}`);
    };

    add(count("SELECT COUNT(1) AS n FROM raw_material_qrs WHERE item_id = ?"), "QR label", "QR labels");
    add(count("SELECT COUNT(1) AS n FROM raw_material_qr_events WHERE item_id = ?"), "scan", "scans");
    add(count("SELECT COUNT(1) AS n FROM purchase_voucher_line_items WHERE item_id = ?"), "purchase line", "purchase lines");
    add(count("SELECT COUNT(1) AS n FROM machine_program_lines WHERE item_id = ?"), "machine program line", "machine program lines");
    add(
      count("SELECT COUNT(1) AS n FROM machine_program_upper_lines WHERE item_id = ?"),
      "machine program line",
      "machine program lines"
    );
    return blockers;
  },

  /** What an approved removal would erase along with the material, in the operator's words. */
  itemRemovalCost(this: SqliteDatabase, itemId: string): string[] {
    const cost: string[] = [];
    const balance = this.db
      .prepare(
        `SELECT b.quantity_on_hand, u.code AS unit_code FROM inventory_stock_balances b
         LEFT JOIN inventory_units u ON u.id = b.unit_id WHERE b.item_id = ?`
      )
      .get(itemId) as { quantity_on_hand: number; unit_code: string | null } | undefined;
    if (balance && Number(balance.quantity_on_hand) !== 0) {
      cost.push(`${Number(balance.quantity_on_hand)} ${balance.unit_code ?? ""}`.trim() + " still in stock");
    }
    const movements = Number(
      (this.db.prepare("SELECT COUNT(1) AS n FROM inventory_stock_events WHERE item_id = ?").get(itemId) as
        | { n: number }
        | undefined)?.n ?? 0
    );
    if (movements > 0) cost.push(`${movements} stock movement${movements === 1 ? "" : "s"}`);
    const corrections = Number(
      (this.db.prepare("SELECT COUNT(1) AS n FROM stock_correction_requests WHERE item_id = ?").get(itemId) as
        | { n: number }
        | undefined)?.n ?? 0
    );
    if (corrections > 0) cost.push(`${corrections} stock correction${corrections === 1 ? "" : "s"}`);
    return cost;
  },

  getRemovalRequest(this: SqliteDatabase, requestId: string): RemovalRequestRow | null {
    const row = this.db.prepare(`${SELECT_REQUEST} WHERE r.id = ? LIMIT 1`).get(requestId) as
      | Record<string, unknown>
      | undefined;
    return row ? toRow(row) : null;
  },

  /** Every removal, pending first then newest. `status` narrows it. */
  listRemovalRequests(this: SqliteDatabase, filters: { status?: string; limit?: number } = {}): RemovalRequestRow[] {
    const limit = Math.min(Math.max(Math.trunc(filters.limit ?? 100), 1), 500);
    const where = filters.status ? "WHERE r.status = ?" : "";
    const args: Array<string | number> = filters.status ? [filters.status, limit] : [limit];
    const rows = this.db
      .prepare(`${SELECT_REQUEST} ${where} ORDER BY r.status = 'PENDING' DESC, r.requested_at DESC LIMIT ?`)
      .all(...args) as Array<Record<string, unknown>>;
    return rows.map(toRow);
  },

  /** One thing's removals — what the operator sees beside it. */
  listRemovalRequestsForTarget(this: SqliteDatabase, targetId: string, limit = 20): RemovalRequestRow[] {
    const capped = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const rows = this.db
      .prepare(`${SELECT_REQUEST} WHERE r.target_id = ? ORDER BY r.status = 'PENDING' DESC, r.requested_at DESC LIMIT ?`)
      .all(targetId, capped) as Array<Record<string, unknown>>;
    return rows.map(toRow);
  },

  /**
   * Records a request to remove a category, and tells the administrator about it. Nothing is
   * deleted here. The name is snapshotted so the request still reads sensibly afterwards.
   */
  createCategoryRemovalRequest(
    this: SqliteDatabase,
    input: { categoryId: string; requestedBy: string; reason?: string }
  ): RemovalRequestRow {
    const category = this.db.prepare("SELECT id, name FROM inventory_categories WHERE id = ?").get(input.categoryId) as
      | { id: string; name: string }
      | undefined;
    if (!category) throw new Error("Category not found");

    const blockers = this.categoryRemovalBlockers(input.categoryId);
    if (blockers.length > 0) {
      throw new Error(`${category.name} still holds ${blockers.join(" and ")}. Empty it first.`);
    }

    const open = this.db
      .prepare(
        `SELECT r.request_code, u.username FROM removal_requests r
         LEFT JOIN app_users u ON u.id = r.requested_by
         WHERE r.target_id = ? AND r.status = 'PENDING' LIMIT 1`
      )
      .get(input.categoryId) as { request_code: string; username: string | null } | undefined;
    if (open) {
      throw new Error(
        `${open.username ?? "Someone"} has already asked for this category to be removed (${open.request_code}).`
      );
    }

    const reason = typeof input.reason === "string" ? input.reason.trim() || null : null;
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const next = this.db
      .prepare(
        "SELECT COALESCE(MAX(CAST(SUBSTR(request_code, 5) AS INTEGER)), 0) + 1 AS n FROM removal_requests WHERE request_code LIKE 'DEL-%'"
      )
      .get() as { n: number };
    const requestCode = `DEL-${String(next.n).padStart(6, "0")}`;

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.db
        .prepare(
          `INSERT INTO removal_requests
             (id, request_code, target_type, target_id, target_name, reason, status, requested_by, requested_at)
           VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`
        )
        .run(id, requestCode, REMOVAL_TARGET.CATEGORY, category.id, category.name, reason, input.requestedBy, now);

      const requester = this.db.prepare("SELECT username FROM app_users WHERE id = ?").get(input.requestedBy) as
        | { username?: string }
        | undefined;
      const adminId = this.getAdministratorId();
      if (adminId && adminId !== input.requestedBy) {
        this.db
          .prepare(
            "INSERT INTO user_notifications (id, user_id, title, message, created_at, kind, entity_id, severity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .run(
            crypto.randomUUID(),
            adminId,
            "Category removal to approve",
            `${requester?.username ?? "A user"} asked to remove the category ${category.name}${reason ? ` — "${reason}"` : ""} (${requestCode})`,
            now,
            NOTIFICATION_KIND.REMOVAL_REQUESTED,
            category.id,
            "WARNING"
          );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return this.getRemovalRequest(id)!;
  },

  /**
   * Records a request to erase a material for good, and tells the administrator about it.
   * Nothing is deleted here.
   */
  createItemRemovalRequest(
    this: SqliteDatabase,
    input: { itemId: string; requestedBy: string; reason?: string }
  ): RemovalRequestRow {
    const item = this.db
      .prepare("SELECT id, item_code, display_name FROM inventory_items WHERE id = ?")
      .get(input.itemId) as { id: string; item_code: string; display_name: string } | undefined;
    if (!item) throw new Error("Raw material not found");

    const blockers = this.itemRemovalBlockers(input.itemId);
    if (blockers.length > 0) {
      throw new Error(
        `${item.display_name} has ${blockers.join(" and ")} recorded against it, so it cannot be erased. Disable it instead to keep its history.`
      );
    }

    const open = this.db
      .prepare(
        `SELECT r.request_code, u.username FROM removal_requests r
         LEFT JOIN app_users u ON u.id = r.requested_by
         WHERE r.target_id = ? AND r.status = 'PENDING' LIMIT 1`
      )
      .get(input.itemId) as { request_code: string; username: string | null } | undefined;
    if (open) {
      throw new Error(
        `${open.username ?? "Someone"} has already asked for this material to be removed (${open.request_code}).`
      );
    }

    const reason = typeof input.reason === "string" ? input.reason.trim() || null : null;
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const next = this.db
      .prepare(
        "SELECT COALESCE(MAX(CAST(SUBSTR(request_code, 5) AS INTEGER)), 0) + 1 AS n FROM removal_requests WHERE request_code LIKE 'DEL-%'"
      )
      .get() as { n: number };
    const requestCode = `DEL-${String(next.n).padStart(6, "0")}`;
    const cost = this.itemRemovalCost(input.itemId);

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.db
        .prepare(
          `INSERT INTO removal_requests
             (id, request_code, target_type, target_id, target_name, reason, status, requested_by, requested_at)
           VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`
        )
        .run(
          id,
          requestCode,
          REMOVAL_TARGET.ITEM,
          item.id,
          `${item.display_name} (${item.item_code})`,
          reason,
          input.requestedBy,
          now
        );

      const requester = this.db.prepare("SELECT username FROM app_users WHERE id = ?").get(input.requestedBy) as
        | { username?: string }
        | undefined;
      const adminId = this.getAdministratorId();
      if (adminId && adminId !== input.requestedBy) {
        this.db
          .prepare(
            "INSERT INTO user_notifications (id, user_id, title, message, created_at, kind, entity_id, severity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .run(
            crypto.randomUUID(),
            adminId,
            "Raw material removal to approve",
            `${requester?.username ?? "A user"} asked to erase ${item.display_name} (${item.item_code})${cost.length > 0 ? `, which also erases ${cost.join(" and ")}` : ""}${reason ? ` -- "${reason}"` : ""} (${requestCode})`,
            now,
            NOTIFICATION_KIND.REMOVAL_REQUESTED,
            item.id,
            "WARNING"
          );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return this.getRemovalRequest(id)!;
  },

  /**
   * An administrator's decision. Approving is what deletes: the status change and the
   * deletion move in one transaction, and emptiness is re-checked inside it, so a category
   * that gained a material while the request waited is refused rather than taking the
   * material's ground out from under it.
   *
   * The requester is told either way.
   */
  reviewRemovalRequest(
    this: SqliteDatabase,
    input: { requestId: string; reviewerId: string; decision: "APPROVED" | "REJECTED"; reviewNotes?: string }
  ): RemovalRequestRow {
    const reviewer = this.db.prepare("SELECT id, role, username FROM app_users WHERE id = ?").get(input.reviewerId) as
      | { id: string; role?: string; username?: string }
      | undefined;
    if (reviewer?.role !== "ADMIN") throw new Error("Administrator access required");

    const request = this.db
      .prepare(
        "SELECT id, request_code, target_type, target_id, target_name, status, requested_by FROM removal_requests WHERE id = ?"
      )
      .get(input.requestId) as
      | { id: string; request_code: string; target_type: string; target_id: string; target_name: string; status: string; requested_by: string }
      | undefined;
    if (!request || request.status !== REMOVAL_STATUS.PENDING) {
      throw new Error("This removal has already been decided.");
    }

    const now = new Date().toISOString();
    const notes = typeof input.reviewNotes === "string" ? input.reviewNotes.trim() || null : null;
    const approved = input.decision === REMOVAL_STATUS.APPROVED;

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      // Guarded: only a still-pending request moves, so two administrators deciding at the
      // same moment cannot both delete.
      const moved = this.db
        .prepare(
          "UPDATE removal_requests SET status = ?, reviewed_by = ?, reviewed_at = ?, review_notes = ? WHERE id = ? AND status = 'PENDING'"
        )
        .run(input.decision, input.reviewerId, now, notes, request.id);
      if (Number(moved.changes) === 0) throw new Error("This removal has already been decided.");

      if (approved) {
        // Re-checked inside the transaction: something may have been recorded against it while
        // the request waited.
        if (request.target_type === REMOVAL_TARGET.CATEGORY) {
          const blockers = this.categoryRemovalBlockers(request.target_id);
          if (blockers.length > 0) {
            throw new Error(
              `${request.target_name} is no longer empty — it now holds ${blockers.join(" and ")}. Nothing was deleted.`
            );
          }
          this.deleteEmptyInventoryCategory(request.target_id);
        } else {
          const blockers = this.itemRemovalBlockers(request.target_id);
          if (blockers.length > 0) {
            throw new Error(
              `${request.target_name} now has ${blockers.join(" and ")} recorded against it. Nothing was deleted.`
            );
          }
          this.eraseInventoryItemWithLedger(request.target_id, reviewer.username);
        }
      }

      this.db
        .prepare(
          "INSERT INTO user_notifications (id, user_id, title, message, created_at, kind, entity_id, severity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          crypto.randomUUID(),
          request.requested_by,
          approved ? "Category removed" : "Category removal declined",
          approved
            ? `${request.target_name} has been removed. (${request.request_code})`
            : `Your request to remove ${request.target_name} was declined${notes ? ` — "${notes}"` : ""}. Nothing was deleted. (${request.request_code})`,
          now,
          approved ? NOTIFICATION_KIND.REMOVAL_APPROVED : NOTIFICATION_KIND.REMOVAL_REJECTED,
          request.target_id,
          approved ? "INFO" : "WARNING"
        );

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return this.getRemovalRequest(request.id)!;
  },

  /**
   * An administrator erasing a material themselves. They are the approver, so it is carried
   * out at once -- through the same request record.
   */
  applyAdminItemRemoval(
    this: SqliteDatabase,
    input: { itemId: string; adminId: string; reason?: string }
  ): RemovalRequestRow {
    const request = this.createItemRemovalRequest({
      itemId: input.itemId,
      requestedBy: input.adminId,
      reason: input.reason,
    });
    return this.reviewRemovalRequest({
      requestId: request.id,
      reviewerId: input.adminId,
      decision: REMOVAL_STATUS.APPROVED,
    });
  },

  /**
   * Erases a material and the ledger that describes only it. Called only from inside an
   * approving transaction, which has already proved nothing outside the material names it.
   *
   * Its stock movements and balance go too: they are this material's own history, and leaving
   * them would leave rows pointing at a material that is not there. The audit trail keeps what
   * was done, with the id let go, exactly as deleteInventoryItem does.
   */
  eraseInventoryItemWithLedger(this: SqliteDatabase, itemId: string, erasedBy?: string): void {
    const item = this.db
      .prepare("SELECT id, item_code, display_name, category_id FROM inventory_items WHERE id = ?")
      .get(itemId) as { id: string; item_code: string; display_name: string; category_id: string } | undefined;
    if (!item) throw new Error("Raw material not found.");

    this.db.prepare("DELETE FROM inventory_item_unit_steps WHERE item_id = ?").run(itemId);
    this.db.prepare("DELETE FROM stock_correction_requests WHERE item_id = ?").run(itemId);
    this.db.prepare("DELETE FROM inventory_stock_events WHERE item_id = ?").run(itemId);
    this.db.prepare("DELETE FROM inventory_stock_balances WHERE item_id = ?").run(itemId);
    this.db.prepare("DELETE FROM inventory_item_values WHERE item_id = ?").run(itemId);
    this.db.prepare("DELETE FROM raw_material_qr_sequences WHERE item_id = ?").run(itemId);
    this.db.prepare("UPDATE inventory_item_audit SET item_id = NULL WHERE item_id = ?").run(itemId);
    this.db.prepare("DELETE FROM inventory_items WHERE id = ?").run(itemId);

    this.writeInventoryAudit(
      null,
      "ITEM",
      itemId,
      "DELETE",
      { itemCode: item.item_code, displayName: item.display_name, categoryId: item.category_id },
      null,
      erasedBy
    );
  },

  /**
   * An administrator removing a category themselves. They are the approver, so there is
   * nobody to wait for — but it goes through the same record and the same deletion, so every
   * removal has one audit trail and one implementation.
   */
  applyAdminCategoryRemoval(
    this: SqliteDatabase,
    input: { categoryId: string; adminId: string; reason?: string }
  ): RemovalRequestRow {
    const request = this.createCategoryRemovalRequest({
      categoryId: input.categoryId,
      requestedBy: input.adminId,
      reason: input.reason,
    });
    return this.reviewRemovalRequest({
      requestId: request.id,
      reviewerId: input.adminId,
      decision: REMOVAL_STATUS.APPROVED,
    });
  },

  /**
   * The deletion itself. Called only from inside an approving transaction, which has already
   * proved the category is empty. The category's own attributes and their dropdown options go
   * with it — they describe nothing else, and nothing is left pointing at them.
   */
  deleteEmptyInventoryCategory(this: SqliteDatabase, categoryId: string): void {
    const fields = this.db
      .prepare("SELECT id FROM inventory_category_fields WHERE category_id = ?")
      .all(categoryId) as Array<{ id: string }>;
    for (const field of fields) {
      this.db.prepare("DELETE FROM inventory_category_field_options WHERE field_id = ?").run(field.id);
    }
    this.db.prepare("DELETE FROM inventory_category_fields WHERE category_id = ?").run(categoryId);
    this.db.prepare("DELETE FROM inventory_categories WHERE id = ?").run(categoryId);
  },
};

export type RemovalRequestsMethods = typeof removalRequestsMethods;
