// Sale returns — the credit side of a carton coming back from a customer.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").
// `this` is the database instance.
//
// One row is one returned carton, because one QR is one carton: there is no quantity to get
// wrong and no header/lines split to keep consistent. Each row names the exact DISPATCHED
// event it answers, and the party it credits is the party that dispatch was made for —
// never a party the operator picked (see ReturnScanUseCase).
//
// A return credits the customer at the rate that carton's OWN voucher line was billed at,
// snapshotted here in paisa. Reading the rate back through the voucher later would let an
// edited bill silently change what an already-issued credit was worth.

import type { SqliteDatabase } from "../sqliteDatabase.js";
import type { DispatchAttribution, ExistingReturn, RecordedReturn, TransactionContext } from "@erp/application";
import { fromPaisa, toPaisa } from "@erp/domain";
import type { MutableTransactionContext } from "./shared.js";
import type { SaleReturnRecord } from "./types.js";

/** `SR-000012` — the number the ledger and the Return screen show. */
export const formatSaleReturnCode = (value: number): string => `SR-${String(value).padStart(6, "0")}`;

export const saleReturnsMethods = {
  /**
   * Writes the party credit for one returned carton, inside the return transaction.
   *
   * Idempotency is the database's job, not this function's: the partial unique index
   * idx_sale_returns_dispatch_event_live refuses a second live return for the same dispatch
   * event, so two terminals confirming the same carton at the same moment cannot both
   * credit the customer. The loser's whole transaction rolls back, including its status move.
   */
  async recordSaleReturn(this: SqliteDatabase,
    payload: {
      saleReturnId: string;
      qrId: string;
      productVariantId: string;
      returnDate: string;
      attribution: DispatchAttribution;
      recordedBy?: string | null;
      occurredAt: string;
    },
    tx: TransactionContext
  ): Promise<RecordedReturn> {
    const context = tx as MutableTransactionContext;
    const { attribution } = payload;

    // Sequential, gap-tolerant, and read inside the same transaction as the insert, so two
    // concurrent returns cannot be handed the same number.
    const last = context.db
      .prepare("SELECT COALESCE(MAX(CAST(SUBSTR(return_number, 4) AS INTEGER)), 0) AS n FROM sale_returns")
      .get() as { n: number };
    const returnNumber = formatSaleReturnCode(Number(last?.n ?? 0) + 1);

    context.db
      .prepare(
        `INSERT INTO sale_returns (
          id, return_number, party_id, return_date, qr_id, product_variant_id,
          dispatch_event_id, dispatch_session_id, sale_voucher_id, sale_voucher_line_item_id,
          quantity_cartons, unit_price_paisa, discount_per_pair_paisa, total_amount_paisa,
          remarks, recorded_by, status, created_at, updated_at, deleted_at, deleted_by, delete_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, ?, 'ACTIVE', ?, ?, NULL, NULL, NULL)`
      )
      .run(
        payload.saleReturnId,
        returnNumber,
        attribution.partyId,
        payload.returnDate,
        payload.qrId,
        payload.productVariantId,
        attribution.dispatchEventId,
        attribution.dispatchSessionId,
        attribution.saleVoucherId,
        attribution.saleVoucherLineItemId,
        toPaisa(attribution.unitPrice),
        toPaisa(attribution.discountPerPair),
        toPaisa(attribution.creditAmount),
        payload.recordedBy ?? null,
        context.nowIso,
        context.nowIso
      );

    return { saleReturnId: payload.saleReturnId, returnNumber };
  },

  /** The live return already recorded against a dispatch, for the idempotent second scan. */
  async findReturnForDispatchEvent(this: SqliteDatabase, dispatchEventId: string, tx: TransactionContext): Promise<ExistingReturn | null> {
    const context = tx as MutableTransactionContext;
    const row = context.db
      .prepare(
        `SELECT sr.id, sr.return_number, sr.created_at, sr.total_amount_paisa,
                sr.party_id, p.party_name, sv.voucher_number
         FROM sale_returns sr
         JOIN parties p ON p.id = sr.party_id
         LEFT JOIN sale_vouchers sv ON sv.id = sr.sale_voucher_id
         WHERE sr.dispatch_event_id = ? AND sr.deleted_at IS NULL
         LIMIT 1`
      )
      .get(dispatchEventId) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      saleReturnId: String(row.id ?? ""),
      returnNumber: String(row.return_number ?? ""),
      returnedAt: String(row.created_at ?? ""),
      partyId: String(row.party_id ?? ""),
      partyName: String(row.party_name ?? ""),
      saleVoucherNumber: row.voucher_number ? String(row.voucher_number) : null,
      creditAmount: fromPaisa(Number(row.total_amount_paisa ?? 0)),
    };
  },

  /**
   * Recorded returns, newest first — what the Return History screen lists. `awaitingStoreIn`
   * is derived from the carton's own live status rather than stored, so it can never drift
   * from what Store Move In has actually received.
   */
  listSaleReturns(this: SqliteDatabase, query: { partyId?: string; fromDate?: string; toDate?: string; limit?: number } = {}): SaleReturnRecord[] {
    const where: string[] = ["sr.deleted_at IS NULL", "sr.status = 'ACTIVE'"];
    const values: string[] = [];

    if (query.partyId) {
      where.push("sr.party_id = ?");
      values.push(query.partyId);
    }
    if (query.fromDate) {
      where.push("sr.return_date >= ?");
      values.push(query.fromDate);
    }
    if (query.toDate) {
      where.push("sr.return_date <= ?");
      values.push(query.toDate);
    }

    const limit = Number.isFinite(query.limit) && Number(query.limit) > 0 ? Math.min(Number(query.limit), 5000) : 500;

    const rows = this.db
      .prepare(
        `SELECT sr.id, sr.return_number, sr.return_date, sr.qr_id, sr.total_amount_paisa,
                sr.unit_price_paisa, sr.discount_per_pair_paisa, sr.created_at, sr.recorded_by,
                sr.party_id, p.party_name,
                sr.sale_voucher_id, sv.voucher_number,
                pv.article, pv.color, pv.size,
                qm.current_status
         FROM sale_returns sr
         JOIN parties p ON p.id = sr.party_id
         JOIN product_variants pv ON pv.id = sr.product_variant_id
         LEFT JOIN sale_vouchers sv ON sv.id = sr.sale_voucher_id
         LEFT JOIN qr_master qm ON qm.qr_id = sr.qr_id
         WHERE ${where.join(" AND ")}
         ORDER BY sr.created_at DESC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id ?? ""),
      returnNumber: String(row.return_number ?? ""),
      returnDate: String(row.return_date ?? ""),
      recordedAt: String(row.created_at ?? ""),
      recordedBy: row.recorded_by ? String(row.recorded_by) : null,
      qrId: String(row.qr_id ?? ""),
      article: String(row.article ?? ""),
      color: String(row.color ?? ""),
      size: String(row.size ?? ""),
      partyId: String(row.party_id ?? ""),
      partyName: String(row.party_name ?? ""),
      saleVoucherId: row.sale_voucher_id ? String(row.sale_voucher_id) : null,
      saleVoucherNumber: row.voucher_number ? String(row.voucher_number) : null,
      unitPrice: fromPaisa(Number(row.unit_price_paisa ?? 0)),
      discountPerPair: fromPaisa(Number(row.discount_per_pair_paisa ?? 0)),
      creditAmount: fromPaisa(Number(row.total_amount_paisa ?? 0)),
      currentStatus: row.current_status ? String(row.current_status) : null,
      awaitingStoreIn: String(row.current_status ?? "") === "ON_GATE",
    }));
  },
};

export type SaleReturnsMethods = typeof saleReturnsMethods;
