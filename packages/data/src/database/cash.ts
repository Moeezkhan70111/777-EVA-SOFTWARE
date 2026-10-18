// Cash vouchers (receipts / payments) and the customer ledger with cash.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").
// `this` is the database instance; bodies are unchanged from the original class.

import type { SqliteDatabase } from "../sqliteDatabase.js";
import type { PagedResult, SaleVoucherLineRecord } from "./types.js";
import { addMoney, fromPaisa, subtractMoney, toPaisa } from "@erp/domain";
import { allocateNumberInRange } from "./numberRange.js";

export const cashMethods = {
  getNextCashVoucherNumber(this: SqliteDatabase): number {
    return allocateNumberInRange(this, "cashVoucher");
  },

  createCashVoucher(this: SqliteDatabase, input: {
    partyId: string;
    voucherDate: string;
    modeOfTransfer?: string;
    description: string;
    receiptAmount?: number;
    paymentAmount?: number;
    lines?: Array<{ partyId: string; description: string; modeOfTransfer: string; bankAccountTitle?: string; chequeNumber?: string; chequeDate?: string; onlineFrom?: string; onlineTo?: string; referenceNo?: string; receiptAmount: number; paymentAmount: number }>;
  }): string {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    // The header and its lines are one transaction. The customer ledger sums
    // cash_voucher_lines, so a voucher that kept its header but lost its lines would quietly
    // produce a wrong party balance. The voucher number is taken inside the transaction too,
    // so it is read under the same write lock that inserts it.
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const voucherNumber = this.getNextCashVoucherNumber();

      this.db
        .prepare(
          `INSERT INTO cash_vouchers (
            id, voucher_number, party_id, voucher_date, mode_of_transfer, description,
            receipt_amount_paisa, payment_amount_paisa, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`
        )
        .run(
          id,
          voucherNumber,
          input.partyId,
          input.voucherDate,
          input.modeOfTransfer ?? "Cash",
          input.description,
          toPaisa(input.receiptAmount ?? 0),
          toPaisa(input.paymentAmount ?? 0),
          now,
          now
        );

      const lines = input.lines?.length ? input.lines : [{ partyId: input.partyId, description: input.description, modeOfTransfer: input.modeOfTransfer ?? "Cash", receiptAmount: input.receiptAmount ?? 0, paymentAmount: input.paymentAmount ?? 0 }];
      const insertLine = this.db.prepare("INSERT INTO cash_voucher_lines (id, voucher_id, party_id, description, mode_of_transfer, bank_account_title, cheque_number, cheque_date, online_from, online_to, reference_no, receipt_amount_paisa, payment_amount_paisa, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const line of lines) insertLine.run(crypto.randomUUID(), id, line.partyId, line.description, line.modeOfTransfer, line.bankAccountTitle ?? "", line.chequeNumber ?? "", line.chequeDate ?? "", line.onlineFrom ?? "", line.onlineTo ?? "", line.referenceNo ?? "", toPaisa(line.receiptAmount), toPaisa(line.paymentAmount), now);

      this.db.exec("COMMIT");
      return id;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }
  },

  updateCashVoucher(this: SqliteDatabase, 
    voucherId: string,
    input: {
      partyId?: string;
      voucherDate?: string;
      modeOfTransfer?: string;
      description?: string;
      receiptAmount?: number;
      paymentAmount?: number;
      lines?: Array<{ partyId: string; description: string; modeOfTransfer: string; bankAccountTitle?: string; chequeNumber?: string; chequeDate?: string; onlineFrom?: string; onlineTo?: string; referenceNo?: string; receiptAmount: number; paymentAmount: number }>;
    }
  ): void {
    const now = new Date().toISOString();
    const updates: string[] = ["updated_at = ?"];
    const values: Array<string | number> = [now];

    if (input.partyId) {
      updates.push("party_id = ?");
      values.push(input.partyId);
    }

    if (input.voucherDate) {
      updates.push("voucher_date = ?");
      values.push(input.voucherDate);
    }

    if (input.modeOfTransfer) {
      updates.push("mode_of_transfer = ?");
      values.push(input.modeOfTransfer);
    }

    if (input.description) {
      updates.push("description = ?");
      values.push(input.description);
    }

    if (input.receiptAmount !== undefined) {
      updates.push("receipt_amount_paisa = ?");
      values.push(toPaisa(input.receiptAmount));
    }

    if (input.paymentAmount !== undefined) {
      updates.push("payment_amount_paisa = ?");
      values.push(toPaisa(input.paymentAmount));
    }

    values.push(voucherId);

    // Replacing the lines is a delete followed by inserts. Outside a transaction a failure
    // part way through leaves the voucher with fewer lines than it started with — existing
    // financial detail destroyed by a failed edit, not merely an edit that did not apply.
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.db
        .prepare(`UPDATE cash_vouchers SET ${updates.join(", ")} WHERE id = ?`)
        .run(...values);

      if (input.lines?.length) {
        this.db.prepare("DELETE FROM cash_voucher_lines WHERE voucher_id = ?").run(voucherId);
        const insertLine = this.db.prepare("INSERT INTO cash_voucher_lines (id, voucher_id, party_id, description, mode_of_transfer, bank_account_title, cheque_number, cheque_date, online_from, online_to, reference_no, receipt_amount_paisa, payment_amount_paisa, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        const nowLine = new Date().toISOString();
        for (const line of input.lines) insertLine.run(crypto.randomUUID(), voucherId, line.partyId, line.description, line.modeOfTransfer, line.bankAccountTitle ?? "", line.chequeNumber ?? "", line.chequeDate ?? "", line.onlineFrom ?? "", line.onlineTo ?? "", line.referenceNo ?? "", toPaisa(line.receiptAmount), toPaisa(line.paymentAmount), nowLine);
      }

      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }
  },

  getCashVoucher(this: SqliteDatabase, id: string): {
    id: string;
    voucherNumber: number;
    partyId: string;
    partyName: string;
    voucherDate: string;
    modeOfTransfer: string;
    description: string;
    receiptAmount: number;
    paymentAmount: number;
    status: string;
    createdAt: string;
    updatedAt: string;
    lines?: Array<{ partyId: string; partyName: string; description: string; modeOfTransfer: string; bankAccountTitle: string; chequeNumber: string; chequeDate: string; onlineFrom: string; onlineTo: string; referenceNo: string; receiptAmount: number; paymentAmount: number }>;
  } | null {
    const row = this.db
      .prepare(
        `SELECT cv.*, p.party_name
         FROM cash_vouchers cv
         JOIN parties p ON p.id = cv.party_id
         WHERE cv.id = ? AND cv.deleted_at IS NULL`
      )
      .get(id) as Record<string, unknown> | undefined;

    if (!row) return null;

    const lines = this.db.prepare("SELECT cvl.party_id, p.party_name, cvl.description, cvl.mode_of_transfer, cvl.bank_account_title, cvl.cheque_number, cvl.cheque_date, cvl.online_from, cvl.online_to, cvl.reference_no, cvl.receipt_amount_paisa, cvl.payment_amount_paisa FROM cash_voucher_lines cvl JOIN parties p ON p.id = cvl.party_id WHERE cvl.voucher_id = ? ORDER BY cvl.created_at ASC").all(id) as Array<Record<string, unknown>>;
    return {
      id: String(row.id ?? ""),
      voucherNumber: Number(row.voucher_number ?? 0),
      partyId: String(row.party_id ?? ""),
      partyName: String(row.party_name ?? ""),
      voucherDate: String(row.voucher_date ?? ""),
      modeOfTransfer: String(row.mode_of_transfer ?? "Cash"),
      description: String(row.description ?? ""),
      receiptAmount: fromPaisa(Number(row.receipt_amount_paisa ?? 0)),
      paymentAmount: fromPaisa(Number(row.payment_amount_paisa ?? 0)),
      status: String(row.status ?? "ACTIVE"),
      createdAt: String(row.created_at ?? ""),
      updatedAt: String(row.updated_at ?? ""),
      lines: lines.map((line) => ({ partyId: String(line.party_id ?? ""), partyName: String(line.party_name ?? ""), description: String(line.description ?? ""), modeOfTransfer: String(line.mode_of_transfer ?? ""), bankAccountTitle: String(line.bank_account_title ?? ""), chequeNumber: String(line.cheque_number ?? ""), chequeDate: String(line.cheque_date ?? ""), onlineFrom: String(line.online_from ?? ""), onlineTo: String(line.online_to ?? ""), referenceNo: String(line.reference_no ?? ""), receiptAmount: fromPaisa(Number(line.receipt_amount_paisa ?? 0)), paymentAmount: fromPaisa(Number(line.payment_amount_paisa ?? 0)) })),
    };
  },

  getCashVoucherByNumber(this: SqliteDatabase, voucherNumber: number): {
    id: string;
    voucherNumber: number;
    partyId: string;
    partyName: string;
    voucherDate: string;
    modeOfTransfer: string;
    description: string;
    receiptAmount: number;
    paymentAmount: number;
    status: string;
    createdAt: string;
    updatedAt: string;
    lines?: Array<{ partyId: string; partyName: string; description: string; modeOfTransfer: string; bankAccountTitle: string; chequeNumber: string; chequeDate: string; onlineFrom: string; onlineTo: string; referenceNo: string; receiptAmount: number; paymentAmount: number }>;
  } | null {
    const row = this.db
      .prepare(
        `SELECT cv.*, p.party_name
         FROM cash_vouchers cv
         JOIN parties p ON p.id = cv.party_id
         WHERE cv.voucher_number = ? AND cv.deleted_at IS NULL`
      )
      .get(voucherNumber) as Record<string, unknown> | undefined;

    if (!row) return null;

    const lines = this.db.prepare("SELECT cvl.party_id, p.party_name, cvl.description, cvl.mode_of_transfer, cvl.bank_account_title, cvl.cheque_number, cvl.cheque_date, cvl.online_from, cvl.online_to, cvl.reference_no, cvl.receipt_amount_paisa, cvl.payment_amount_paisa FROM cash_voucher_lines cvl JOIN parties p ON p.id = cvl.party_id WHERE cvl.voucher_id = ? ORDER BY cvl.created_at ASC").all(String(row.id ?? "")) as Array<Record<string, unknown>>;
    return {
      id: String(row.id ?? ""),
      voucherNumber: Number(row.voucher_number ?? 0),
      partyId: String(row.party_id ?? ""),
      partyName: String(row.party_name ?? ""),
      voucherDate: String(row.voucher_date ?? ""),
      modeOfTransfer: String(row.mode_of_transfer ?? "Cash"),
      description: String(row.description ?? ""),
      receiptAmount: fromPaisa(Number(row.receipt_amount_paisa ?? 0)),
      paymentAmount: fromPaisa(Number(row.payment_amount_paisa ?? 0)),
      status: String(row.status ?? "ACTIVE"),
      createdAt: String(row.created_at ?? ""),
      updatedAt: String(row.updated_at ?? ""),
      lines: lines.map((line) => ({ partyId: String(line.party_id ?? ""), partyName: String(line.party_name ?? ""), description: String(line.description ?? ""), modeOfTransfer: String(line.mode_of_transfer ?? ""), bankAccountTitle: String(line.bank_account_title ?? ""), chequeNumber: String(line.cheque_number ?? ""), chequeDate: String(line.cheque_date ?? ""), onlineFrom: String(line.online_from ?? ""), onlineTo: String(line.online_to ?? ""), referenceNo: String(line.reference_no ?? ""), receiptAmount: fromPaisa(Number(line.receipt_amount_paisa ?? 0)), paymentAmount: fromPaisa(Number(line.payment_amount_paisa ?? 0)) })),
    };
  },

  listCashVouchers(this: SqliteDatabase, query: {
    search?: string;
    fromDate?: string;
    toDate?: string;
    partyId?: string;
    page?: number;
    pageSize?: number;
  } = {}): PagedResult<{
    id: string;
    voucherNumber: number;
    partyId: string;
    partyName: string;
    voucherDate: string;
    description: string;
    receiptAmount: number;
    paymentAmount: number;
    status: string;
  }> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const offset = (page - 1) * pageSize;

    const where: string[] = ["cv.deleted_at IS NULL"];
    const values: Array<string | number> = [];

    if (query.search?.trim()) {
      const needle = `%${query.search.trim()}%`;
      where.push("(p.party_name LIKE ? OR cv.description LIKE ?)");
      values.push(needle, needle);
    }

    if (query.fromDate) {
      where.push("cv.voucher_date >= ?");
      values.push(query.fromDate);
    }

    if (query.toDate) {
      where.push("cv.voucher_date <= ?");
      values.push(query.toDate);
    }

    if (query.partyId) {
      where.push("cv.party_id = ?");
      values.push(query.partyId);
    }

    const whereClause = where.join(" AND ");
    
    const totalRow = this.db
      .prepare(
        `SELECT COUNT(1) AS c
         FROM cash_vouchers cv
         JOIN parties p ON p.id = cv.party_id
         WHERE ${whereClause}`
      )
      .get(...values) as { c: number };

    const rows = this.db
      .prepare(
        `SELECT cv.id, cv.voucher_number, cv.party_id, cv.voucher_date,
                cv.description, cv.receipt_amount_paisa, cv.payment_amount_paisa, cv.status,
                p.party_name
         FROM cash_vouchers cv
         JOIN parties p ON p.id = cv.party_id
         WHERE ${whereClause}
         ORDER BY cv.voucher_number DESC
         LIMIT ? OFFSET ?`
      )
      .all(...values, pageSize, offset) as Array<Record<string, unknown>>;

    return {
      rows: rows.map((row) => ({
        id: String(row.id ?? ""),
        voucherNumber: Number(row.voucher_number ?? 0),
        partyId: String(row.party_id ?? ""),
        partyName: String(row.party_name ?? ""),
        voucherDate: String(row.voucher_date ?? ""),
        description: String(row.description ?? ""),
        receiptAmount: fromPaisa(Number(row.receipt_amount_paisa ?? 0)),
        paymentAmount: fromPaisa(Number(row.payment_amount_paisa ?? 0)),
        status: String(row.status ?? "ACTIVE"),
      })),
      total: totalRow.c,
      page,
      pageSize,
    };
  },

  deleteCashVoucher(this: SqliteDatabase, id: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE cash_vouchers SET deleted_at = ?, status = 'CANCELLED' WHERE id = ?")
      .run(now, id);
  },

  // Enhanced customer ledger to include cash voucher transactions
  getCustomerLedgerWithCash(this: SqliteDatabase, partyId: string, query: { fromDate?: string; toDate?: string } = {}): {
    partyId: string;
    partyName: string;
    balanceLimit: number | null;
    openingBalance: number;
    closingBalance: number;
    entries: Array<{
      voucherId: string;
      voucherNumber: string;
      voucherDate: string;
      voucherType: "SALE" | "CASH_RECEIPT" | "CASH_PAYMENT" | "SALE_RETURN";
      description: string;
      modeOfTransfer?: string;
      onlineFrom?: string;
      onlineTo?: string;
      bankAccountTitle?: string;
      chequeNumber?: string;
      chequeDate?: string;
      referenceNo?: string;
      debitAmount: number;  // Sales and Cash Payments
      creditAmount: number; // Cash Receipts and Sale Returns
      balance: number;
      lineItems?: Array<{
        id: string;
        article: string;
        color: string;
        size: string;
        groupName: string | null;
        quantity: number;
        unitPrice: number;
        discount: number;
        totalPrice: number;
      }>;
    }>;
  } {
    const party = this.getParty(partyId);
    if (!party) return { partyId, partyName: "", balanceLimit: null, openingBalance: 0, closingBalance: 0, entries: [] };

    const fromDate = query.fromDate ?? "1900-01-01";
    const toDate = query.toDate ?? "2999-12-31";

    // Calculate opening balance (before fromDate) — every SUM below is over a *_paisa column
    // so SQLite does exact integer arithmetic; converted back to rupees once, at the end.
    const openingSales = this.db
      .prepare("SELECT COALESCE(SUM(total_amount_paisa), 0) as total FROM sale_vouchers WHERE party_id = ? AND voucher_date < ? AND status != 'CANCELLED' AND deleted_at IS NULL")
      .get(partyId, fromDate) as { total: number };

    // Opening receipts/payments: use line amounts when the voucher has lines, else header amount.
    // Only lines belonging to THIS party affect this party's balance.
    const openingReceipts = this.db
      .prepare(`SELECT
          COALESCE((SELECT SUM(cv.receipt_amount_paisa) FROM cash_vouchers cv WHERE cv.party_id = ? AND cv.voucher_date < ? AND cv.status = 'ACTIVE' AND cv.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM cash_voucher_lines cvl WHERE cvl.voucher_id = cv.id)), 0)
        + COALESCE((SELECT SUM(cvl.receipt_amount_paisa) FROM cash_voucher_lines cvl JOIN cash_vouchers cv ON cv.id = cvl.voucher_id WHERE cvl.party_id = ? AND cv.voucher_date < ? AND cv.status = 'ACTIVE' AND cv.deleted_at IS NULL), 0) as total`)
      .get(partyId, fromDate, partyId, fromDate) as { total: number };

    const openingPayments = this.db
      .prepare(`SELECT
          COALESCE((SELECT SUM(cv.payment_amount_paisa) FROM cash_vouchers cv WHERE cv.party_id = ? AND cv.voucher_date < ? AND cv.status = 'ACTIVE' AND cv.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM cash_voucher_lines cvl WHERE cvl.voucher_id = cv.id)), 0)
        + COALESCE((SELECT SUM(cvl.payment_amount_paisa) FROM cash_voucher_lines cvl JOIN cash_vouchers cv ON cv.id = cvl.voucher_id WHERE cvl.party_id = ? AND cv.voucher_date < ? AND cv.status = 'ACTIVE' AND cv.deleted_at IS NULL), 0) as total`)
      .get(partyId, fromDate, partyId, fromDate) as { total: number };

    // Credits for cartons sent back, on the same exact-integer footing as everything above.
    const openingReturns = this.db
      .prepare("SELECT COALESCE(SUM(total_amount_paisa), 0) as total FROM sale_returns WHERE party_id = ? AND return_date < ? AND status = 'ACTIVE' AND deleted_at IS NULL")
      .get(partyId, fromDate) as { total: number };

    const openingBalance = fromPaisa(openingSales.total - openingReceipts.total + openingPayments.total - openingReturns.total);

    // Get all transactions in date range
    const transactions: Array<{
      id: string;
      number: string;
      date: string;
      type: "SALE" | "CASH_RECEIPT" | "CASH_PAYMENT" | "SALE_RETURN";
      description: string;
      modeOfTransfer?: string;
      subPartyUrdu?: string;
      amount: number;
    }> = [];

    // Add sale vouchers
    const sales = this.db
      .prepare(`
        SELECT id, voucher_number, voucher_date, total_amount_paisa, COALESCE(remarks, '') as remarks,
               COALESCE(sub_party_name_urdu, '') as sub_party_urdu
        FROM sale_vouchers 
        WHERE party_id = ? AND voucher_date BETWEEN ? AND ? AND status != 'CANCELLED' AND deleted_at IS NULL
        ORDER BY voucher_date ASC, created_at ASC
      `)
      .all(partyId, fromDate, toDate) as Array<Record<string, unknown>>;

    for (const sale of sales) {
      transactions.push({
        id: String(sale.id),
        number: String(sale.voucher_number),
        date: String(sale.voucher_date),
        type: "SALE",
        description: `Sale voucher ${sale.voucher_number}${sale.remarks ? ` - ${sale.remarks}` : ''}`,
        subPartyUrdu: String(sale.sub_party_urdu || ""),
        amount: fromPaisa(Number(sale.total_amount_paisa)),
      });
    }

    // Add cash vouchers
    const cashVouchers = this.db
      .prepare(`
        SELECT id, voucher_number, voucher_date, receipt_amount_paisa, payment_amount_paisa, description, mode_of_transfer
        FROM cash_vouchers 
        WHERE party_id = ? AND voucher_date BETWEEN ? AND ? AND status = 'ACTIVE' AND deleted_at IS NULL
        ORDER BY voucher_date ASC, created_at ASC
      `)
      .all(partyId, fromDate, toDate) as Array<Record<string, unknown>>;

    for (const cv of cashVouchers) {
      // When the voucher has lines, this party's amount is the sum of ITS lines; otherwise the
      // header amount. Summed in paisa (exact integer arithmetic), converted back once.
      const lineSums = this.db
        .prepare("SELECT COALESCE(SUM(receipt_amount_paisa), 0) as receipt, COALESCE(SUM(payment_amount_paisa), 0) as payment, COUNT(*) as n FROM cash_voucher_lines WHERE voucher_id = ? AND party_id = ?")
        .get(String(cv.id), partyId) as { receipt: number; payment: number; n: number };
      const hasLines = Number(lineSums.n) > 0;
      const receiptAmount = hasLines ? fromPaisa(Number(lineSums.receipt)) : fromPaisa(Number(cv.receipt_amount_paisa));
      const paymentAmount = hasLines ? fromPaisa(Number(lineSums.payment)) : fromPaisa(Number(cv.payment_amount_paisa));

      // Resolve description: prefer the line-level description for this party, fall back to header, then mode of transfer
      let cvDescription = String(cv.description || "");
      let cvOnlineFrom = ""; let cvOnlineTo = ""; let cvBankTitle = ""; let cvChequeNumber = ""; let cvChequeDate = ""; let cvReferenceNo = "";
      if (hasLines) {
        const lineDesc = this.db
          .prepare("SELECT description, mode_of_transfer, online_from, online_to, bank_account_title, cheque_number, cheque_date, reference_no FROM cash_voucher_lines WHERE voucher_id = ? AND party_id = ? ORDER BY created_at ASC LIMIT 1")
          .get(String(cv.id), partyId) as { description: string; mode_of_transfer: string; online_from: string; online_to: string; bank_account_title: string; cheque_number: string; cheque_date: string; reference_no: string } | undefined;
        if (lineDesc?.description?.trim()) cvDescription = lineDesc.description.trim();
        else if (!cvDescription && lineDesc?.mode_of_transfer?.trim()) cvDescription = lineDesc.mode_of_transfer.trim();
        cvOnlineFrom   = lineDesc?.online_from?.trim()       ?? "";
        cvOnlineTo     = lineDesc?.online_to?.trim()         ?? "";
        cvBankTitle    = lineDesc?.bank_account_title?.trim() ?? "";
        cvChequeNumber = lineDesc?.cheque_number?.trim()     ?? "";
        cvChequeDate   = lineDesc?.cheque_date?.trim()       ?? "";
        cvReferenceNo  = lineDesc?.reference_no?.trim()      ?? "";
      }
      if (!cvDescription && cv.mode_of_transfer) cvDescription = String(cv.mode_of_transfer);

      const cvExtra = {
        onlineFrom:        cvOnlineFrom   || undefined,
        onlineTo:          cvOnlineTo     || undefined,
        bankAccountTitle:  cvBankTitle    || undefined,
        chequeNumber:      cvChequeNumber || undefined,
        chequeDate:        cvChequeDate   || undefined,
        referenceNo:       cvReferenceNo  || undefined,
      };

      if (receiptAmount > 0) {
        transactions.push({
          id: String(cv.id),
          number: String(cv.voucher_number),
          date: String(cv.voucher_date),
          type: "CASH_RECEIPT",
          description: cvDescription,
          modeOfTransfer: cv.mode_of_transfer == null ? undefined : String(cv.mode_of_transfer),
          ...cvExtra,
          amount: receiptAmount,
        });
      }
      if (paymentAmount > 0) {
        transactions.push({
          id: String(cv.id),
          number: String(cv.voucher_number),
          date: String(cv.voucher_date),
          type: "CASH_PAYMENT",
          description: cvDescription,
          modeOfTransfer: cv.mode_of_transfer == null ? undefined : String(cv.mode_of_transfer),
          ...cvExtra,
          amount: paymentAmount,
        });
      }
    }

    // Add sale returns — one credit per carton the customer sent back, at the rate its own
    // voucher line was billed at (snapshotted on the return, so an edited bill cannot change
    // what an already-issued credit was worth).
    const saleReturns = this.db
      .prepare(`
        SELECT sr.id, sr.return_number, sr.return_date, sr.total_amount_paisa, sr.qr_id,
               pv.article, pv.size, sv.voucher_number
        FROM sale_returns sr
        JOIN product_variants pv ON pv.id = sr.product_variant_id
        LEFT JOIN sale_vouchers sv ON sv.id = sr.sale_voucher_id
        WHERE sr.party_id = ? AND sr.return_date BETWEEN ? AND ? AND sr.status = 'ACTIVE' AND sr.deleted_at IS NULL
        ORDER BY sr.return_date ASC, sr.created_at ASC
      `)
      .all(partyId, fromDate, toDate) as Array<Record<string, unknown>>;

    for (const sr of saleReturns) {
      const against = sr.voucher_number ? ` against Sale voucher ${sr.voucher_number}` : "";
      transactions.push({
        id: String(sr.id),
        number: String(sr.return_number),
        date: String(sr.return_date),
        type: "SALE_RETURN",
        description: `Return ${sr.article} ${sr.size} (1 carton)${against}`,
        amount: fromPaisa(Number(sr.total_amount_paisa)),
      });
    }

    // Sort by date then by type (sales first, then returns, then cash)
    transactions.sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      // Sales before returns before cash transactions on same date
      const typeOrder = { SALE: 1, SALE_RETURN: 2, CASH_RECEIPT: 3, CASH_PAYMENT: 4 };
      return typeOrder[a.type] - typeOrder[b.type];
    });

    // Build ledger entries with running balance
    let runningBalance = openingBalance;
    const entries = transactions.map((tx) => {
      let debitAmount = 0;
      let creditAmount = 0;

      if (tx.type === "SALE" || tx.type === "CASH_PAYMENT") {
        debitAmount = tx.amount;
        runningBalance = addMoney(runningBalance, tx.amount);
      } else if (tx.type === "CASH_RECEIPT" || tx.type === "SALE_RETURN") {
        // A returned carton reduces what the customer owes, exactly as a receipt does.
        creditAmount = tx.amount;
        runningBalance = subtractMoney(runningBalance, tx.amount);
      }

      // Get line items for sale vouchers
      // The ledger shows a line's figures only, not how its discount was arrived at.
      let lineItems: Array<Omit<SaleVoucherLineRecord, "productVariantId" | "priceType" | "discountPerPair" | "discountSource">> = [];
      let saleDescription = tx.description;
      if (tx.type === "SALE") {
        const items = this.db
          .prepare(`
            SELECT sli.id, pv.article, pv.color, pv.size, pg.group_name,
                   sli.quantity, sli.unit_price_paisa, sli.discount_paisa, sli.total_price_paisa
            FROM sale_voucher_line_items sli
            JOIN product_variants pv ON pv.id = sli.product_variant_id
            LEFT JOIN product_groups pg ON pg.id = pv.product_group_id
            WHERE sli.voucher_id = ? AND sli.deleted_at IS NULL
          `)
          .all(tx.id) as Array<Record<string, unknown>>;

        lineItems = items.map((it) => ({
          id: String(it.id),
          article: String(it.article),
          color: String(it.color),
          size: String(it.size),
          groupName: it.group_name ? String(it.group_name) : null,
          quantity: Number(it.quantity),
          unitPrice: fromPaisa(Number(it.unit_price_paisa)),
          discount: fromPaisa(Number(it.discount_paisa)),
          totalPrice: fromPaisa(Number(it.total_price_paisa)),
        }));

        // Build description as QTY@DISCOUNT per unique discount group, e.g. "0.5@240 , 0.5@300"
        const qtyByDiscount = new Map<number, number>();
        for (const li of lineItems) {
          qtyByDiscount.set(li.discount, (qtyByDiscount.get(li.discount) ?? 0) + li.quantity);
        }
        const discountParts = Array.from(qtyByDiscount.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([discount, qty]) => {
            const qtyStr = Number.isInteger(qty) ? String(qty) : String(parseFloat(qty.toFixed(4)));
            return `${qtyStr}@${discount}`;
          });
        const subPart = tx.subPartyUrdu && tx.subPartyUrdu.trim() ? `-${tx.subPartyUrdu.trim()}` : "";
        saleDescription = discountParts.join(" , ") + subPart;
      }

      return {
        voucherId: tx.id,
        voucherNumber: tx.number,
        voucherDate: tx.date,
        voucherType: tx.type,
        description: saleDescription,
        modeOfTransfer: tx.modeOfTransfer,
        debitAmount,
        creditAmount,
        balance: runningBalance,
        lineItems: lineItems.length > 0 ? lineItems : undefined,
      };
    });

    return {
      partyId,
      partyName: party.partyName,
      balanceLimit: party.balanceLimit ?? null,
      openingBalance,
      closingBalance: runningBalance,
      entries,
    };
  },
};

export type CashMethods = typeof cashMethods;
