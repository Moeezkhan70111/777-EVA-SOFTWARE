// Purchase vouchers (supplier bills), supplier ledger and balances.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").
// `this` is the database instance; bodies are unchanged from the original class.

import type { SqliteDatabase } from "../sqliteDatabase.js";
import type { PagedResult } from "./types.js";
import { addMoney, fromPaisa, fromPaisaOrNull, multiplyMoney, subtractMoney, toPaisa } from "@erp/domain";

export const purchasesMethods = {
  getNextPurchaseVoucherNumber(this: SqliteDatabase): string {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(CAST(COALESCE(NULLIF(TRIM(voucher_number), ''), '0') AS INTEGER)), 0) + 1 AS n
         FROM purchase_vouchers`
      )
      .get() as { n: number };
    return String(row.n);
  },

  createPurchaseVoucher(this: SqliteDatabase, input: {
    partyId: string;
    voucherDate: string;
    bookNo?: string;
    referenceNo?: string;
    remarks?: string;
    voucherNumber?: string;
    lines?: Array<{ itemId: string; quantity: number; unitPrice: number }>;
  }): { id: string; voucherNumber: string } {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const voucherNumber = input.voucherNumber && input.voucherNumber.trim() ? input.voucherNumber.trim() : this.getNextPurchaseVoucherNumber();
    const lines = input.lines ?? [];
    let totalQuantity = 0;
    let totalAmount = 0;
    for (const line of lines) {
      const qty = Number(line.quantity) || 0;
      const price = Number(line.unitPrice) || 0;
      totalQuantity += qty;
      totalAmount = addMoney(totalAmount, multiplyMoney(price, qty));
    }

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.db
        .prepare(
          `INSERT INTO purchase_vouchers (
            id, voucher_number, party_id, voucher_date, book_no, reference_no, remarks,
            total_quantity, total_amount_paisa, status, created_at, updated_at, deleted_at, deleted_by, delete_reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'FINALIZED', ?, ?, NULL, NULL, NULL)`
        )
        .run(id, voucherNumber, input.partyId, input.voucherDate, input.bookNo ?? null, input.referenceNo ?? null, input.remarks ?? null, totalQuantity, toPaisa(totalAmount), now, now);

      const insertLine = this.db.prepare(
        `INSERT INTO purchase_voucher_line_items (id, voucher_id, item_id, quantity, unit_price_paisa, total_price_paisa, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      );
      for (const line of lines) {
        const qty = Number(line.quantity) || 0;
        const price = Number(line.unitPrice) || 0;
        const lineTotal = multiplyMoney(price, qty);
        insertLine.run(crypto.randomUUID(), id, line.itemId, qty, toPaisa(price), toPaisa(lineTotal), now, now);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { id, voucherNumber };
  },

  getPurchaseVoucher(this: SqliteDatabase, voucherId: string): Record<string, unknown> | null {
    const row = this.db
      .prepare(
        `SELECT pv.*, p.party_name
         FROM purchase_vouchers pv
         JOIN parties p ON p.id = pv.party_id
         WHERE pv.id = ? AND pv.deleted_at IS NULL`
      )
      .get(voucherId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const items = this.db
      .prepare(
        `SELECT pvli.id, pvli.item_id, pvli.quantity, pvli.unit_price_paisa, pvli.total_price_paisa,
                ii.item_code, ii.display_name, ii.cost_price_paisa, iu.code as unit_code
         FROM purchase_voucher_line_items pvli
         JOIN inventory_items ii ON ii.id = pvli.item_id
         LEFT JOIN inventory_units iu ON iu.id = ii.default_unit_id
         WHERE pvli.voucher_id = ? AND pvli.deleted_at IS NULL
         ORDER BY pvli.created_at ASC`
      )
      .all(voucherId) as Array<Record<string, unknown>>;
    return {
      id: String(row.id ?? ""),
      voucherNumber: String(row.voucher_number ?? ""),
      partyId: String(row.party_id ?? ""),
      partyName: String(row.party_name ?? ""),
      voucherDate: String(row.voucher_date ?? ""),
      bookNo: row.book_no ? String(row.book_no) : null,
      referenceNo: row.reference_no ? String(row.reference_no) : null,
      remarks: row.remarks ? String(row.remarks) : null,
      totalQuantity: Number(row.total_quantity ?? 0),
      totalAmount: fromPaisa(Number(row.total_amount_paisa ?? 0)),
      status: String(row.status ?? "FINALIZED"),
      lineItems: items.map((item) => ({
        id: String(item.id ?? ""),
        itemId: String(item.item_id ?? ""),
        itemCode: String(item.item_code ?? ""),
        displayName: String(item.display_name ?? ""),
        unitCode: item.unit_code ? String(item.unit_code) : null,
        costPrice: fromPaisaOrNull(item.cost_price_paisa == null ? null : Number(item.cost_price_paisa)),
        quantity: Number(item.quantity ?? 0),
        unitPrice: fromPaisa(Number(item.unit_price_paisa ?? 0)),
        totalPrice: fromPaisa(Number(item.total_price_paisa ?? 0)),
      })),
      createdAt: String(row.created_at ?? ""),
      updatedAt: String(row.updated_at ?? ""),
    };
  },

  listPurchaseVouchers(this: SqliteDatabase, query: {
    search?: string;
    page?: number;
    pageSize?: number;
    status?: string;
    partyId?: string;
    dateFrom?: string;
    dateTo?: string;
  } = {}): PagedResult<Record<string, unknown>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const offset = (page - 1) * pageSize;
    const where: string[] = ["pv.deleted_at IS NULL"];
    const values: Array<string | number> = [];
    if (query.status && query.status !== "ALL") { where.push("pv.status = ?"); values.push(query.status); }
    if (query.partyId) { where.push("pv.party_id = ?"); values.push(query.partyId); }
    if (query.dateFrom) { where.push("pv.voucher_date >= ?"); values.push(query.dateFrom); }
    if (query.dateTo)   { where.push("pv.voucher_date <= ?"); values.push(query.dateTo); }
    if (query.search?.trim()) {
      const needle = `%${query.search.trim()}%`;
      where.push("(pv.voucher_number LIKE ? OR p.party_name LIKE ? OR pv.reference_no LIKE ?)");
      values.push(needle, needle, needle);
    }
    const whereClause = where.join(" AND ");
    const totalRow = this.db.prepare(`SELECT COUNT(1) as c FROM purchase_vouchers pv JOIN parties p ON p.id = pv.party_id WHERE ${whereClause}`).get(...values) as { c: number };
    const rows = this.db
      .prepare(
        `SELECT pv.id, pv.voucher_number, pv.voucher_date, pv.reference_no, pv.total_quantity, pv.total_amount_paisa, pv.status, pv.created_at, p.party_name
         FROM purchase_vouchers pv JOIN parties p ON p.id = pv.party_id
         WHERE ${whereClause} ORDER BY pv.voucher_date DESC, pv.created_at DESC LIMIT ? OFFSET ?`
      )
      .all(...values, pageSize, offset) as Array<Record<string, unknown>>;
    return {
      rows: rows.map((row) => ({
        id: String(row.id ?? ""),
        voucherNumber: String(row.voucher_number ?? ""),
        partyName: String(row.party_name ?? ""),
        voucherDate: String(row.voucher_date ?? ""),
        referenceNo: row.reference_no ? String(row.reference_no) : null,
        totalQuantity: Number(row.total_quantity ?? 0),
        totalAmount: fromPaisa(Number(row.total_amount_paisa ?? 0)),
        status: String(row.status ?? "FINALIZED"),
        createdAt: String(row.created_at ?? ""),
      })),
      total: totalRow.c,
      page,
      pageSize,
    };
  },

  updatePurchaseVoucher(this: SqliteDatabase, voucherId: string, input: { partyId?: string; voucherDate?: string; bookNo?: string; referenceNo?: string; remarks?: string; lines?: Array<{ itemId: string; quantity: number; unitPrice: number }> }): void {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      if (input.lines) {
        this.db.prepare("UPDATE purchase_voucher_line_items SET deleted_at = ? WHERE voucher_id = ?").run(now, voucherId);
        const insertLine = this.db.prepare(
          `INSERT INTO purchase_voucher_line_items (id, voucher_id, item_id, quantity, unit_price_paisa, total_price_paisa, created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
        );
        let totalQuantity = 0;
        let totalAmount = 0;
        for (const line of input.lines) {
          const qty = Number(line.quantity) || 0;
          const price = Number(line.unitPrice) || 0;
          const lineTotal = multiplyMoney(price, qty);
          totalQuantity += qty;
          totalAmount = addMoney(totalAmount, lineTotal);
          insertLine.run(crypto.randomUUID(), voucherId, line.itemId, qty, toPaisa(price), toPaisa(lineTotal), now, now);
        }
        this.db.prepare("UPDATE purchase_voucher_line_items SET deleted_at = NULL WHERE voucher_id = ? AND deleted_at = ?").run(voucherId, now);
        this.db.prepare("DELETE FROM purchase_voucher_line_items WHERE voucher_id = ? AND deleted_at IS NOT NULL").run(voucherId);
        this.db.prepare("UPDATE purchase_vouchers SET total_quantity = ?, total_amount_paisa = ?, updated_at = ? WHERE id = ?").run(totalQuantity, toPaisa(totalAmount), now, voucherId);
      }
      const updates: string[] = ["updated_at = ?"];
      const values: Array<string | null> = [now];
      if (input.partyId !== undefined) { updates.push("party_id = ?"); values.push(input.partyId); }
      if (input.voucherDate !== undefined) { updates.push("voucher_date = ?"); values.push(input.voucherDate); }
      if (input.bookNo !== undefined) { updates.push("book_no = ?"); values.push(input.bookNo || null); }
      if (input.referenceNo !== undefined) { updates.push("reference_no = ?"); values.push(input.referenceNo || null); }
      if (input.remarks !== undefined) { updates.push("remarks = ?"); values.push(input.remarks || null); }
      values.push(voucherId);
      this.db.prepare(`UPDATE purchase_vouchers SET ${updates.join(", ")} WHERE id = ?`).run(...values);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  },

  deletePurchaseVoucher(this: SqliteDatabase, voucherId: string, deletedBy?: string): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE purchase_vouchers SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ?").run(now, deletedBy ?? null, now, voucherId);
    this.db.prepare("UPDATE purchase_voucher_line_items SET deleted_at = ?, updated_at = ? WHERE voucher_id = ?").run(now, now, voucherId);
  },

  // ─── SUPPLIER LEDGER + BALANCE ────────────────────────────────────────────
  // Direction (standard payable): purchase = CREDIT (we owe supplier), cash payment to
  // supplier = DEBIT (reduces what we owe). Cash receipts from a supplier are rare; treat as debit.

  getSupplierLedger(this: SqliteDatabase, partyId: string, query: { fromDate?: string; toDate?: string } = {}): {
    partyId: string; partyName: string; openingBalance: number; closingBalance: number;
    entries: Array<{ voucherId: string; voucherNumber: string; voucherDate: string; voucherType: "PURCHASE" | "CASH_PAYMENT" | "CASH_RECEIPT"; description: string; modeOfTransfer?: string; debitAmount: number; creditAmount: number; balance: number }>;
  } {
    const party = this.getParty(partyId);
    if (!party) return { partyId, partyName: "", openingBalance: 0, closingBalance: 0, entries: [] };
    const fromDate = query.fromDate ?? "1900-01-01";
    const toDate = query.toDate ?? "2999-12-31";

    // Summed in paisa (exact integer arithmetic); converted back to rupees once, below.
    const openingPurchases = this.db.prepare("SELECT COALESCE(SUM(total_amount_paisa),0) as t FROM purchase_vouchers WHERE party_id = ? AND voucher_date < ? AND status != 'CANCELLED' AND deleted_at IS NULL").get(partyId, fromDate) as { t: number };
    const openingPayments = this.db.prepare("SELECT COALESCE(SUM(payment_amount_paisa),0) as t FROM cash_vouchers WHERE party_id = ? AND voucher_date < ? AND status = 'ACTIVE' AND deleted_at IS NULL").get(partyId, fromDate) as { t: number };
    const openingBalance = fromPaisa(openingPurchases.t - openingPayments.t); // positive = we owe supplier

    const transactions: Array<{ id: string; number: string; date: string; type: "PURCHASE" | "CASH_PAYMENT" | "CASH_RECEIPT"; description: string; modeOfTransfer?: string; amount: number }> = [];

    const purchases = this.db.prepare("SELECT id, voucher_number, voucher_date, total_amount_paisa, COALESCE(remarks,'') as remarks, COALESCE(reference_no,'') as ref FROM purchase_vouchers WHERE party_id = ? AND voucher_date BETWEEN ? AND ? AND status != 'CANCELLED' AND deleted_at IS NULL ORDER BY voucher_date ASC, created_at ASC").all(partyId, fromDate, toDate) as Array<Record<string, unknown>>;
    for (const p of purchases) {
      transactions.push({ id: String(p.id), number: String(p.voucher_number), date: String(p.voucher_date), type: "PURCHASE", description: `Purchase ${p.voucher_number}${p.ref ? ` (${p.ref})` : ""}${p.remarks ? ` - ${p.remarks}` : ""}`, amount: fromPaisa(Number(p.total_amount_paisa)) });
    }

    const cashVouchers = this.db.prepare("SELECT id, voucher_number, voucher_date, receipt_amount_paisa, payment_amount_paisa, description, mode_of_transfer FROM cash_vouchers WHERE party_id = ? AND voucher_date BETWEEN ? AND ? AND status = 'ACTIVE' AND deleted_at IS NULL ORDER BY voucher_date ASC, created_at ASC").all(partyId, fromDate, toDate) as Array<Record<string, unknown>>;
    for (const cv of cashVouchers) {
      const lineSums = this.db.prepare("SELECT COALESCE(SUM(receipt_amount_paisa),0) as r, COALESCE(SUM(payment_amount_paisa),0) as p, COUNT(*) as n FROM cash_voucher_lines WHERE voucher_id = ? AND party_id = ?").get(String(cv.id), partyId) as { r: number; p: number; n: number };
      const hasLines = Number(lineSums.n) > 0;
      const paymentAmount = hasLines ? fromPaisa(Number(lineSums.p)) : fromPaisa(Number(cv.payment_amount_paisa));
      const receiptAmount = hasLines ? fromPaisa(Number(lineSums.r)) : fromPaisa(Number(cv.receipt_amount_paisa));
      if (paymentAmount > 0) transactions.push({ id: String(cv.id), number: String(cv.voucher_number), date: String(cv.voucher_date), type: "CASH_PAYMENT", description: String(cv.description), modeOfTransfer: cv.mode_of_transfer == null ? undefined : String(cv.mode_of_transfer), amount: paymentAmount });
      if (receiptAmount > 0) transactions.push({ id: String(cv.id), number: String(cv.voucher_number), date: String(cv.voucher_date), type: "CASH_RECEIPT", description: String(cv.description), modeOfTransfer: cv.mode_of_transfer == null ? undefined : String(cv.mode_of_transfer), amount: receiptAmount });
    }

    transactions.sort((a, b) => (a.date !== b.date ? a.date.localeCompare(b.date) : ({ PURCHASE: 1, CASH_PAYMENT: 2, CASH_RECEIPT: 3 } as Record<string, number>)[a.type] - ({ PURCHASE: 1, CASH_PAYMENT: 2, CASH_RECEIPT: 3 } as Record<string, number>)[b.type]));

    let running = openingBalance;
    const entries = transactions.map((tx) => {
      let debit = 0;
      let credit = 0;
      if (tx.type === "PURCHASE") { credit = tx.amount; running = addMoney(running, tx.amount); }
      else { debit = tx.amount; running = subtractMoney(running, tx.amount); }
      return { voucherId: tx.id, voucherNumber: tx.number, voucherDate: tx.date, voucherType: tx.type, description: tx.description, modeOfTransfer: tx.modeOfTransfer, debitAmount: debit, creditAmount: credit, balance: running };
    });

    return { partyId, partyName: party.partyName, openingBalance, closingBalance: running, entries };
  },

  listSupplierBalances(this: SqliteDatabase, query: { asOfDate?: string } = {}): { rows: Array<{ partyId: string; partyName: string; city: string | null; balance: number; lastVoucherDate: string | null; totalPurchases: number; totalPayments: number }>; total: number } {
    const asOfDate = query.asOfDate || new Date().toISOString().split("T")[0];
    // Every SUM below is over a *_paisa column (exact integer arithmetic); converted back to
    // rupees once, in the row mapping below.
    const rows = this.db
      .prepare(
        `SELECT
           p.id AS party_id, p.party_name, p.city,
           (SELECT COALESCE(SUM(pv.total_amount_paisa),0) FROM purchase_vouchers pv WHERE pv.party_id = p.id AND pv.deleted_at IS NULL AND pv.status != 'CANCELLED' AND pv.voucher_date <= ?) AS total_purchases_paisa,
           (SELECT COALESCE(SUM(cv.payment_amount_paisa),0) FROM cash_vouchers cv WHERE cv.party_id = p.id AND cv.deleted_at IS NULL AND cv.status = 'ACTIVE' AND cv.voucher_date <= ?) AS total_payments_paisa,
           (SELECT COALESCE(SUM(pv.total_amount_paisa),0) FROM purchase_vouchers pv WHERE pv.party_id = p.id AND pv.deleted_at IS NULL AND pv.status != 'CANCELLED' AND pv.voucher_date <= ?)
           - (SELECT COALESCE(SUM(cv.payment_amount_paisa),0) FROM cash_vouchers cv WHERE cv.party_id = p.id AND cv.deleted_at IS NULL AND cv.status = 'ACTIVE' AND cv.voucher_date <= ?) AS balance_paisa,
           (SELECT MAX(dt) FROM (
              SELECT pv.voucher_date AS dt FROM purchase_vouchers pv WHERE pv.party_id = p.id AND pv.deleted_at IS NULL AND pv.status != 'CANCELLED' AND pv.voucher_date <= ?
              UNION ALL
              SELECT cv.voucher_date AS dt FROM cash_vouchers cv WHERE cv.party_id = p.id AND cv.deleted_at IS NULL AND cv.status = 'ACTIVE' AND cv.voucher_date <= ?
           )) AS last_voucher_date
         FROM parties p
         WHERE p.deleted_at IS NULL AND p.party_type = 'SUPPLIER' AND p.status = 'ACTIVE'
         ORDER BY balance_paisa DESC, p.party_name ASC`
      )
      .all(asOfDate, asOfDate, asOfDate, asOfDate, asOfDate, asOfDate) as Array<Record<string, unknown>>;
    return {
      rows: rows.map((row) => ({
        partyId: String(row.party_id ?? ""),
        partyName: String(row.party_name ?? ""),
        city: row.city ? String(row.city) : null,
        balance: fromPaisa(Number(row.balance_paisa ?? 0)),
        lastVoucherDate: row.last_voucher_date ? String(row.last_voucher_date) : null,
        totalPurchases: fromPaisa(Number(row.total_purchases_paisa ?? 0)),
        totalPayments: fromPaisa(Number(row.total_payments_paisa ?? 0)),
      })),
      total: rows.length,
    };
  },
};

export type PurchasesMethods = typeof purchasesMethods;
