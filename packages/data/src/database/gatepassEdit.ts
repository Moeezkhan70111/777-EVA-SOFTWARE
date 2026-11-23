// Editing a gatepass and deleting a cancelled one (local migration 118): the repository side of EditGatepassUseCase and
// DeleteGatepassUseCase (@erp/application gatepassEditUseCases.ts). Every write here runs inside the use case's
// transaction; the rules -- when an edit is allowed, what a billed gatepass may change -- are the use case's.
//
//   getGatepassForEdit        the gatepass, its lines with their progress, and its bill, read under the write lock
//   saveGatepassVersion       what it was, kept as a child of the gatepass record, so it travels with it
//   removeGatepassLines       its old lines go (their issued cartons were put back first, by returnGatepassCartons)
//   updateEditedGatepass      the new header and the next revision, guarded on the revision the editor opened
//   followGatepassEditOnBill  the bill carries what the gatepass now sends (see the method)
//   readGatepassForDelete / markGatepassDeleted   a cancelled gatepass leaves the lists, and is kept
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import type { SqliteDatabase } from "../sqliteDatabase.js";
import type { EditedGatepassHeader, GatepassForEdit, GatepassVersionPayload, TransactionContext } from "@erp/application";
import { dozensToPairs, fromPaisa, PRICE_TYPE } from "@erp/domain";
import { cartonCloudIsActive, isLocalStockRecord, refuseTestFinancialDocument } from "./stockProtection.js";
import { SYNC_AGGREGATE } from "./syncEvents.js";
import { articleSizeKey } from "./sales.js";
import type { MutableTransactionContext } from "./shared.js";
import type { GatepassVersionRecord } from "./types.js";

type Row = Record<string, unknown>;
const text = (value: unknown): string | null => (value === null || value === undefined || value === "" ? null : String(value));

/** Dozens are REAL on a bill line: two figures within this are the same. */
const SAME_DOZENS = 1e-6;

/** The bill made from the gatepass, if it still stands, and whether the desk has entered it. */
function liveBillOf(db: SqliteDatabase, gatepassId: string): GatepassForEdit["bill"] {
  const bill = db.db.prepare("SELECT id, voucher_number FROM sale_vouchers WHERE gatepass_id = ? AND deleted_at IS NULL LIMIT 1").get(gatepassId) as Row | undefined;
  if (!bill) return null;
  return { id: String(bill.id), voucherNumber: String(bill.voucher_number), entered: db.billHasLines(String(bill.id)) };
}

/**
 * One bill line brought to what the gatepass now sends: the rate and price type are the desk's and stay, and the
 * discount stays what it was per pair (the ceiling is checked again for the new pairs). The same path as the desk's own
 * line update, so the gatepass rule, the discount authority and the totals are applied exactly as there.
 */
function followLine(db: SqliteDatabase, item: Row, dozens: number): void {
  const oldPairs = dozensToPairs(Number(item.quantity));
  const perPairPaisa = oldPairs > 0 ? Math.round(Number(item.discount_paisa) / oldPairs) : 0;
  db.updateVoucherLineItem(String(item.id), {
    quantity: dozens,
    unitPrice: fromPaisa(Number(item.unit_price_paisa)),
    discount: fromPaisa(perPairPaisa * dozensToPairs(dozens)),
    priceType: item.price_type === PRICE_TYPE.B_TYPE ? PRICE_TYPE.B_TYPE : PRICE_TYPE.NORMAL,
  });
}

export const gatepassEditMethods = {
  async getGatepassForEdit(this: SqliteDatabase, gatepassId: string, tx: TransactionContext): Promise<GatepassForEdit | null> {
    const { db } = tx as MutableTransactionContext;
    const row = db
      .prepare(
        `SELECT g.id, g.gatepass_number, g.status, g.revision_no, g.party_id, p.party_name, g.bilty_number, g.transport_via, g.remarks,
                g.total_quantity, g.deleted_at
         FROM gatepasses g JOIN parties p ON p.id = g.party_id WHERE g.id = ? LIMIT 1`
      )
      .get(String(gatepassId ?? "").trim()) as Row | undefined;
    if (!row) return null;
    const id = String(row.id);
    return {
      id,
      gatepassNumber: Number(row.gatepass_number),
      status: String(row.status),
      revisionNo: Number(row.revision_no ?? 1),
      partyId: String(row.party_id),
      partyName: String(row.party_name ?? ""),
      biltyNumber: text(row.bilty_number),
      transportVia: text(row.transport_via),
      remarks: text(row.remarks),
      totalQuantity: Number(row.total_quantity ?? 0),
      deletedAt: text(row.deleted_at),
      lines: this.readGatepassLineProgress(id, db),
      bill: liveBillOf(this, id),
      madeBeforeGoLive: cartonCloudIsActive(db) && isLocalStockRecord(db, SYNC_AGGREGATE.GATEPASS, id),
    };
  },

  async saveGatepassVersion(this: SqliteDatabase, payload: GatepassVersionPayload, tx: TransactionContext): Promise<void> {
    (tx as MutableTransactionContext).db
      .prepare(
        `INSERT INTO gatepass_versions (id, gatepass_id, version_no, party_id, party_name, bilty_number, transport_via, remarks, total_quantity,
                                        lines_json, replaced_at, replaced_by, edit_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        payload.id, payload.gatepassId, payload.versionNo, payload.partyId, payload.partyName, payload.biltyNumber, payload.transportVia,
        payload.remarks, payload.totalQuantity, JSON.stringify(payload.lines), payload.replacedAt, payload.replacedBy, payload.reason
      );
  },

  /** Only after returnGatepassCartons: an old line's issue and its return both stay, naming the old line. */
  async removeGatepassLines(this: SqliteDatabase, gatepassId: string, tx: TransactionContext): Promise<void> {
    (tx as MutableTransactionContext).db.prepare("DELETE FROM gatepass_lines WHERE gatepass_id = ?").run(gatepassId);
  },

  /**
   * After the allocation is made again from the new lines: its reversed shares that name the old lines go. Those lines
   * exist nowhere any more, and the allocation travels whole, so a receiver would wait for them for ever (a record waits
   * for every row it names). What they counted is in the reallocation's audit row, and the old lines in the version.
   */
  async dropSharesOfReplacedLines(this: SqliteDatabase, gatepassId: string, tx: TransactionContext): Promise<number> {
    const result = (tx as MutableTransactionContext).db
      .prepare(
        `DELETE FROM gatepass_order_allocation_lines
         WHERE reversed_at IS NOT NULL
           AND allocation_id IN (SELECT id FROM gatepass_order_allocations WHERE gatepass_id = ?)
           AND gatepass_line_id NOT IN (SELECT id FROM gatepass_lines WHERE gatepass_id = ?)`
      )
      .run(gatepassId, gatepassId);
    return Number(result.changes);
  },

  async updateEditedGatepass(this: SqliteDatabase, payload: EditedGatepassHeader, tx: TransactionContext): Promise<boolean> {
    const result = (tx as MutableTransactionContext).db
      .prepare(
        `UPDATE gatepasses
         SET party_id = ?, bilty_number = ?, transport_via = ?, remarks = ?, total_quantity = ?,
             revision_no = revision_no + 1, edited_at = ?, edited_by = ?, updated_at = ?
         WHERE id = ? AND revision_no = ? AND status IN ('CREATED', 'BILLED') AND deleted_at IS NULL`
      )
      .run(
        payload.partyId, payload.biltyNumber, payload.transportVia, payload.remarks, payload.totalQuantity,
        payload.editedAt, payload.editedBy, payload.editedAt, payload.gatepassId, payload.fromRevision
      );
    return result.changes > 0;
  },

  /**
   * The bill follows the edited gatepass (owner, 23 Nov 2026). Before it is entered it carries no lines, so only its
   * party follows. Once entered, every line's dozens become what the gatepass now sends for its article + size, and
   * a line for an article + size the gatepass no longer sends goes (the use case has refused one it never priced).
   * The party's balance limit is checked again: an edit that takes it over is refused whole.
   */
  async followGatepassEditOnBill(this: SqliteDatabase, payload: { gatepassId: string; partyId: string }, tx: TransactionContext): Promise<{ voucherNumber: string } | null> {
    const { db, nowIso } = tx as MutableTransactionContext;
    const bill = liveBillOf(this, payload.gatepassId);
    if (!bill) return null;
    if (!bill.entered) {
      db.prepare("UPDATE sale_vouchers SET party_id = ?, updated_at = ? WHERE id = ? AND party_id <> ?").run(payload.partyId, nowIso, bill.id, payload.partyId);
      return { voucherNumber: bill.voucherNumber };
    }
    refuseTestFinancialDocument(db, "sale_vouchers", bill.id, "This bill");
    const expected = this.gatepassBillQuantities(payload.gatepassId);
    const items = db
      .prepare("SELECT id, product_variant_id, quantity, unit_price_paisa, discount_paisa, price_type FROM sale_voucher_line_items WHERE voucher_id = ? AND deleted_at IS NULL")
      .all(bill.id) as Row[];
    for (const item of items) {
      const variant = this.getSaleableVariant(String(item.product_variant_id));
      const sends = expected.get(articleSizeKey(String(variant?.article ?? ""), String(variant?.size ?? "")));
      if (!sends) {
        db.prepare("UPDATE sale_voucher_line_items SET deleted_at = ?, updated_at = ? WHERE id = ?").run(nowIso, nowIso, String(item.id));
      } else if (Math.abs(sends.dozens - Number(item.quantity)) > SAME_DOZENS) {
        followLine(this, item, sends.dozens);
      }
    }
    this.recalculateVoucherTotals(bill.id);
    this.assertWithinBalanceLimit(payload.partyId, bill.id);
    return { voucherNumber: bill.voucherNumber };
  },

  async readGatepassForDelete(this: SqliteDatabase, gatepassId: string, tx: TransactionContext): Promise<{ gatepassNumber: number; status: string; deletedAt: string | null } | null> {
    const row = (tx as MutableTransactionContext).db
      .prepare("SELECT gatepass_number, status, deleted_at FROM gatepasses WHERE id = ? LIMIT 1")
      .get(String(gatepassId ?? "").trim()) as Row | undefined;
    return row ? { gatepassNumber: Number(row.gatepass_number), status: String(row.status), deletedAt: text(row.deleted_at) } : null;
  },

  async markGatepassDeleted(this: SqliteDatabase, payload: { gatepassId: string; deletedAt: string; deletedBy: string; reason: string }, tx: TransactionContext): Promise<boolean> {
    const result = (tx as MutableTransactionContext).db
      .prepare(
        `UPDATE gatepasses SET deleted_at = ?, deleted_by = ?, delete_reason = ?, updated_at = ?
         WHERE id = ? AND status = 'CANCELLED' AND deleted_at IS NULL`
      )
      .run(payload.deletedAt, payload.deletedBy, payload.reason, payload.deletedAt, payload.gatepassId);
    return result.changes > 0;
  },

  /** What an edited gatepass was before each edit, oldest first. */
  listGatepassVersions(this: SqliteDatabase, gatepassId: string): GatepassVersionRecord[] {
    const rows = this.db.prepare("SELECT * FROM gatepass_versions WHERE gatepass_id = ? ORDER BY version_no ASC").all(gatepassId) as Row[];
    return rows.map((row) => ({
      versionNo: Number(row.version_no),
      partyId: String(row.party_id),
      partyName: String(row.party_name ?? ""),
      biltyNumber: text(row.bilty_number),
      transportVia: text(row.transport_via),
      remarks: text(row.remarks),
      totalQuantity: Number(row.total_quantity ?? 0),
      lines: parseVersionLines(row.lines_json),
      replacedAt: String(row.replaced_at),
      replacedBy: String(row.replaced_by),
      reason: String(row.edit_reason ?? ""),
    }));
  },
};

/** A version's lines, as kept. A row this build cannot read shows no lines rather than failing the whole gatepass. */
function parseVersionLines(value: unknown): GatepassVersionRecord["lines"] {
  try {
    const parsed: unknown = JSON.parse(String(value ?? "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((line): line is Row => typeof line === "object" && line !== null)
      .map((line) => ({
        productVariantId: String(line.productVariantId ?? ""),
        article: String(line.article ?? ""),
        color: String(line.color ?? ""),
        size: String(line.size ?? ""),
        quantity: Number(line.quantity ?? 0),
        issuedDirectlyQuantity: Number(line.issuedDirectlyQuantity ?? 0),
      }));
  } catch {
    return [];
  }
}

export type GatepassEditMethods = typeof gatepassEditMethods;
