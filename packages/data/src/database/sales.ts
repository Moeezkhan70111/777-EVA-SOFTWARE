// Discount policy, sale vouchers, customer ledger and balances.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").
// `this` is the database instance; bodies are unchanged from the original class.

import type { SqliteDatabase } from "../sqliteDatabase.js";
import { refuseTestFinancialDocument } from "./stockProtection.js";
import { addMoney, businessToday, cartonsToDozens, DISCOUNT_SOURCE, dozensToPairs, fromPaisa, multiplyMoney, PRICE_TYPE, saleLineTotal, subtractMoney, toPaisa, toPaisaOrNull } from "@erp/domain";
import type { DiscountSource, PriceType } from "@erp/domain";
import { formatGatepassCode } from "@erp/application";
import { BillDoesNotMatchGatepassError, DiscountExceedsAllowedError, GatepassBillingError, PartyBalanceLimitExceededError } from "./types.js";
import type { DeleteSaleVoucherResult, PagedResult, SaleVoucherListRow, SaleVoucherRecord } from "./types.js";
import { allocateNumberInRange } from "./numberRange.js";
import { RequestConflictError, fingerprintText, isRequestId, requestFingerprint } from "./requestFingerprint.js";

/** One line of a bill as the desk typed it. `lineId` is the screen's id for that line, so a repeated add is one line. */
export interface SaleLineInput {
  productVariantId: string;
  quantity: number;
  unitPrice: number;
  discount?: number;
  priceType?: "NORMAL" | "B_TYPE";
  lineId?: string;
}

/** A sale voucher typed by hand, not made from a gatepass: its header and every line, saved together. */
export interface ManualSaleVoucherInput {
  /** The screen's id for one press of Save (migration 105). Required. */
  requestId: string;
  partyId: string;
  voucherDate: string;
  bookNo: string;
  voucherNumber?: string;
  subPartyName?: string;
  subPartyNameUrdu?: string;
  subPartyNumber?: string;
  remarks?: string;
  lines: SaleLineInput[];
}

export interface ManualSaleVoucherSaved {
  id: string;
  voucherNumber: string;
  outcome: "CREATED" | "ALREADY_SAVED";
}

const priceTypeOf = (value: unknown): "NORMAL" | "B_TYPE" => (value === "B_TYPE" ? "B_TYPE" : "NORMAL");

/** What a press of Save on a hand-typed bill asked for, as a hash. Money in paisa. */
const manualVoucherFingerprint = (input: ManualSaleVoucherInput): string =>
  requestFingerprint({
    partyId: input.partyId,
    voucherDate: input.voucherDate,
    bookNo: fingerprintText(input.bookNo),
    voucherNumber: fingerprintText(input.voucherNumber),
    subPartyName: fingerprintText(input.subPartyName),
    subPartyNameUrdu: fingerprintText(input.subPartyNameUrdu),
    subPartyNumber: fingerprintText(input.subPartyNumber),
    remarks: fingerprintText(input.remarks),
    lines: input.lines.map((line) => ({
      productVariantId: line.productVariantId,
      dozens: line.quantity,
      ratePaisa: toPaisa(line.unitPrice),
      discountPaisa: toPaisa(line.discount ?? 0),
      priceType: priceTypeOf(line.priceType),
    })),
  });

const DISCOUNT_SOURCES = new Set<string>(Object.values(DISCOUNT_SOURCE));

/** One key for an article + size, however the two were typed. */
const articleSizeKey = (article: string, size: string): string =>
  `${String(article ?? "").trim().toUpperCase()}|||${String(size ?? "").trim().toUpperCase()}`;

/** A stored discount_source, or NONE for anything the column should never hold. */
const parseDiscountSource = (value: unknown): DiscountSource =>
  typeof value === "string" && DISCOUNT_SOURCES.has(value) ? (value as DiscountSource) : DISCOUNT_SOURCE.NONE;

// A party's totals as of a date (?1), for the balance list. Exact integer arithmetic over *_paisa columns.
const SALES_PAISA_SQL = `(SELECT COALESCE(SUM(sv.total_amount_paisa), 0) FROM live_sale_vouchers sv
  WHERE sv.party_id = p.id AND sv.deleted_at IS NULL AND sv.voucher_date <= ?1)`;
const RETURNS_PAISA_SQL = `(SELECT COALESCE(SUM(sr.total_amount_paisa), 0) FROM live_sale_returns sr
  WHERE sr.party_id = p.id AND sr.deleted_at IS NULL AND sr.status = 'ACTIVE' AND sr.return_date <= ?1)`;
/**
 * What cash vouchers paid or received for this party: its own lines when a voucher has lines, else the header. The
 * same rule as the ledger and the limit check. A voucher's header names only its first party, so reading headers
 * alone left every other party on the voucher out of the balance list.
 */
const cashPaisaSql = (column: "receipt_amount_paisa" | "payment_amount_paisa"): string => `(
  (SELECT COALESCE(SUM(cv.${column}), 0) FROM live_cash_vouchers cv
    WHERE cv.party_id = p.id AND cv.deleted_at IS NULL AND cv.status = 'ACTIVE' AND cv.voucher_date <= ?1
      AND NOT EXISTS (SELECT 1 FROM cash_voucher_lines l WHERE l.voucher_id = cv.id))
  + (SELECT COALESCE(SUM(l.${column}), 0) FROM cash_voucher_lines l JOIN live_cash_vouchers cv ON cv.id = l.voucher_id
    WHERE l.party_id = p.id AND cv.deleted_at IS NULL AND cv.status = 'ACTIVE' AND cv.voucher_date <= ?1)
)`;

export const salesMethods = {
  // One rule per party × product group: saving again updates the figure (and revives a
  // deleted rule), exactly as the article and price-range rules behave.
  createPartyProductGroupDiscount(this: SqliteDatabase, input: { partyId: string; productGroupId: string; discountPerPair: number }): string {
    if (input.discountPerPair < 0) throw new Error("Discount per pair must be >= 0");
    const now = new Date().toISOString();
    const existing = this.db.prepare(`SELECT id FROM party_product_group_discounts WHERE party_id = ? AND product_group_id = ? ORDER BY (deleted_at IS NULL) DESC, updated_at DESC LIMIT 1`).get(input.partyId, input.productGroupId) as { id: string } | undefined;
    if (existing) {
      this.db.prepare(`UPDATE party_product_group_discounts SET discount_per_pair_paisa = ?, deleted_at = NULL, updated_at = ? WHERE id = ?`).run(toPaisa(input.discountPerPair), now, existing.id);
      return existing.id;
    }
    const id = crypto.randomUUID();
    this.db.prepare(`INSERT INTO party_product_group_discounts (id, party_id, product_group_id, discount_per_pair_paisa, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, NULL)`).run(id, input.partyId, input.productGroupId, toPaisa(input.discountPerPair), now, now);
    return id;
  },

  // One rule per party × article series; same upsert as above.
  createPartyArticleSeriesDiscount(this: SqliteDatabase, input: { partyId: string; articleSeriesId: string; discountPerPair: number }): string {
    if (input.discountPerPair < 0) throw new Error("Discount per pair must be >= 0");
    const now = new Date().toISOString();
    const existing = this.db.prepare(`SELECT id FROM party_article_series_discounts WHERE party_id = ? AND article_series_id = ? ORDER BY (deleted_at IS NULL) DESC, updated_at DESC LIMIT 1`).get(input.partyId, input.articleSeriesId) as { id: string } | undefined;
    if (existing) {
      this.db.prepare(`UPDATE party_article_series_discounts SET discount_per_pair_paisa = ?, deleted_at = NULL, updated_at = ? WHERE id = ?`).run(toPaisa(input.discountPerPair), now, existing.id);
      return existing.id;
    }
    const id = crypto.randomUUID();
    this.db.prepare(`INSERT INTO party_article_series_discounts (id, party_id, article_series_id, discount_per_pair_paisa, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, NULL)`).run(id, input.partyId, input.articleSeriesId, toPaisa(input.discountPerPair), now, now);
    return id;
  },

  /**
   * An article rule is keyed by the article name (all sizes, or one size) — never by a colour.
   * `article` is the name as the Discount Policy screen holds it; an article_sizes or
   * product_variants id is also accepted and resolved to its article. One rule per
   * (party, article, scope, size): saving again updates it and revives a deleted one.
   */
  createPartyArticleDiscount(this: SqliteDatabase, input: { partyId: string; article: string; sizeScope?: "ALL_SIZES" | "SEPARATE_SIZES"; size?: string | null; discountPerPair: number }): string {
    if (input.discountPerPair < 0) throw new Error("Discount per pair must be >= 0");
    const sizeScope = input.sizeScope ?? "ALL_SIZES";
    const size = sizeScope === "SEPARATE_SIZES" && input.size ? input.size.trim() : null;
    if (sizeScope === "SEPARATE_SIZES" && !size) throw new Error("A separate-sizes rule needs a size");
    const article = this.resolveArticleName(input.article);
    const now = new Date().toISOString();

    const existing = this.db.prepare(
      `SELECT id FROM party_article_discounts
       WHERE party_id = ? AND article = ? AND size_scope = ?
         AND (size = ? OR (size IS NULL AND ? IS NULL))
       LIMIT 1`
    ).get(input.partyId, article, sizeScope, size, size) as { id: string } | undefined;
    if (existing) {
      this.db.prepare(
        `UPDATE party_article_discounts
         SET discount_per_pair_paisa = ?, deleted_at = NULL, updated_at = ?
         WHERE id = ?`
      ).run(toPaisa(input.discountPerPair), now, existing.id);
      return existing.id;
    }
    const id = crypto.randomUUID();
    this.db.prepare(
      `INSERT INTO party_article_discounts
         (id, party_id, article, size_scope, size, discount_per_pair_paisa, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    ).run(id, input.partyId, article, sizeScope, size, toPaisa(input.discountPerPair), now, now);
    return id;
  },

  /** The article name behind what a caller handed in: a name, an article_sizes id or a product_variants id. */
  resolveArticleName(this: SqliteDatabase, articleOrId: string): string {
    const byVariantId = this.db.prepare("SELECT article FROM product_variants WHERE id = ? LIMIT 1").get(articleOrId) as { article: string } | undefined;
    if (byVariantId) return byVariantId.article;
    const byArticleSizeId = this.db.prepare("SELECT article FROM article_sizes WHERE id = ? LIMIT 1").get(articleOrId) as { article: string } | undefined;
    if (byArticleSizeId) return byArticleSizeId.article;
    const name = articleOrId.trim().toUpperCase();
    const known = this.db.prepare("SELECT 1 FROM article_sizes WHERE article = ? AND deleted_at IS NULL LIMIT 1").get(name);
    if (!known) throw new Error(`Unknown article "${articleOrId}"`);
    return name;
  },

  createPartyPriceRangeDiscount(this: SqliteDatabase, input: { partyId: string; startPrice: number; endPrice: number; discountPerPair: number }): string {
    if (!Number.isFinite(input.startPrice) || !Number.isFinite(input.endPrice) || input.startPrice < 0 || input.endPrice < 0) {
      throw new Error("Price range values must be valid non-negative numbers");
    }
    if (input.startPrice > input.endPrice) throw new Error("Start price must be less than or equal to end price");
    if (input.discountPerPair < 0) throw new Error("Discount per pair must be >= 0");

    const now = new Date().toISOString();
    // Integer paisa is the sole authoritative representation — every comparison and write
    // below happens in paisa, converted once at the boundary via the canonical toPaisa().
    const startPricePaisa = toPaisa(input.startPrice);
    const endPricePaisa = toPaisa(input.endPrice);
    const discountPerPairPaisa = toPaisa(input.discountPerPair);

    // Upsert: if this exact range already exists, just update the discount (handles re-saves of same batch)
    const duplicate = this.db.prepare(
      `SELECT id FROM party_price_range_discounts
       WHERE party_id = ? AND start_price_paisa = ? AND end_price_paisa = ?
       LIMIT 1`
    ).get(input.partyId, startPricePaisa, endPricePaisa) as { id: string } | undefined;
    if (duplicate) {
      this.db.prepare(
        `UPDATE party_price_range_discounts
         SET discount_per_pair_paisa = ?, deleted_at = NULL, updated_at = ?
         WHERE id = ?`
      ).run(discountPerPairPaisa, now, duplicate.id);
      return duplicate.id;
    }

    // Check for genuine overlap with a different, non-identical range
    const overlapping = this.db.prepare(
      `SELECT id FROM party_price_range_discounts
       WHERE party_id = ? AND deleted_at IS NULL
         AND start_price_paisa <= ? AND end_price_paisa >= ?
       LIMIT 1`
    ).get(
      input.partyId,
      endPricePaisa,   // existing.start <= new.end
      startPricePaisa, // existing.end   >= new.start
    ) as { id: string } | undefined;
    if (overlapping) throw new Error("Overlapping price ranges are not allowed for the same party");

    const id = crypto.randomUUID();
    this.db.prepare(
      `INSERT INTO party_price_range_discounts
         (id, party_id, start_price_paisa, end_price_paisa, discount_per_pair_paisa, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
    ).run(id, input.partyId, startPricePaisa, endPricePaisa, discountPerPairPaisa, now, now);
    return id;
  },

  deletePartyArticleDiscount(this: SqliteDatabase, id: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE party_article_discounts SET deleted_at = ? WHERE id = ?`).run(now, id);
  },

  deletePartyArticleSeriesDiscount(this: SqliteDatabase, id: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE party_article_series_discounts SET deleted_at = ? WHERE id = ?`).run(now, id);
  },

  deletePartyPriceRangeDiscount(this: SqliteDatabase, id: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE party_price_range_discounts SET deleted_at = ? WHERE id = ?`).run(now, id);
  },

  deletePartyProductGroupDiscount(this: SqliteDatabase, id: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE party_product_group_discounts SET deleted_at = ? WHERE id = ?`).run(now, id);
  },

  /**
   * Party discount hierarchy — the single source of truth for which discount applies.
   * Priority: ARTICLE → ARTICLE_SERIES → PRICE_RANGE → PRODUCT_GROUP → NONE. Rules never
   * stack; the first match wins. (Do not log inputs here: party pricing is business data.)
   */
  resolveDiscount(this: SqliteDatabase, input: { partyId: string; article?: string; size?: string; productGroupId?: string; articleSeriesId?: string; applicablePrice?: number }): { discountPerPair: number; source: DiscountSource; ruleId?: string } {
    const partyId = input.partyId;
    if (!partyId) return { discountPerPair: 0, source: DISCOUNT_SOURCE.NONE };

    const articleSeriesId = input.articleSeriesId;
    const productGroupId = input.productGroupId;

    // ARTICLE: a rule for the whole article first, then one for this exact size.
    if (input.article) {
      const allSizesRow = this.db
        .prepare(
          `SELECT id, discount_per_pair_paisa FROM party_article_discounts
           WHERE party_id = ? AND article = ? AND size_scope = 'ALL_SIZES' AND deleted_at IS NULL
           LIMIT 1`
        )
        .get(partyId, input.article) as { id: string; discount_per_pair_paisa: number } | undefined;
      if (allSizesRow) {
        return { discountPerPair: fromPaisa(Number(allSizesRow.discount_per_pair_paisa ?? 0)), source: DISCOUNT_SOURCE.ARTICLE, ruleId: allSizesRow.id };
      }

      if (input.size) {
        const exactSizeRow = this.db
          .prepare(
            `SELECT id, discount_per_pair_paisa FROM party_article_discounts
             WHERE party_id = ? AND article = ? AND size_scope = 'SEPARATE_SIZES' AND size = ? AND deleted_at IS NULL
             LIMIT 1`
          )
          .get(partyId, input.article, input.size) as { id: string; discount_per_pair_paisa: number } | undefined;
        if (exactSizeRow) {
          return { discountPerPair: fromPaisa(Number(exactSizeRow.discount_per_pair_paisa ?? 0)), source: DISCOUNT_SOURCE.ARTICLE, ruleId: exactSizeRow.id };
        }
      }
    }

    if (articleSeriesId) {
      const seriesDiscount = this.db.prepare(`SELECT id, discount_per_pair_paisa FROM party_article_series_discounts WHERE party_id = ? AND article_series_id = ? AND deleted_at IS NULL LIMIT 1`).get(partyId, articleSeriesId) as { id: string; discount_per_pair_paisa: number } | undefined;
      if (seriesDiscount) {
        return { discountPerPair: fromPaisa(Number(seriesDiscount.discount_per_pair_paisa ?? 0)), source: DISCOUNT_SOURCE.ARTICLE_SERIES, ruleId: seriesDiscount.id };
      }
    }

    const applicablePrice = typeof input.applicablePrice === "number" ? Number(input.applicablePrice) : Number.NaN;
    if (Number.isFinite(applicablePrice)) {
      const applicablePricePaisa = toPaisa(applicablePrice);
      const priceMatch = this.db.prepare(`SELECT id, discount_per_pair_paisa, start_price_paisa, end_price_paisa FROM party_price_range_discounts WHERE party_id = ? AND deleted_at IS NULL AND start_price_paisa <= ? AND end_price_paisa >= ? LIMIT 1`).get(partyId, applicablePricePaisa, applicablePricePaisa) as { id: string; discount_per_pair_paisa: number; start_price_paisa: number; end_price_paisa: number } | undefined;
      if (priceMatch) {
        return { discountPerPair: fromPaisa(Number(priceMatch.discount_per_pair_paisa ?? 0)), source: DISCOUNT_SOURCE.PRICE_RANGE, ruleId: priceMatch.id };
      }
    }

    if (productGroupId) {
      const groupDiscount = this.db.prepare(`SELECT id, discount_per_pair_paisa FROM party_product_group_discounts WHERE party_id = ? AND product_group_id = ? AND deleted_at IS NULL LIMIT 1`).get(partyId, productGroupId) as { id: string; discount_per_pair_paisa: number } | undefined;
      if (groupDiscount) {
        return { discountPerPair: fromPaisa(Number(groupDiscount.discount_per_pair_paisa ?? 0)), source: DISCOUNT_SOURCE.PRODUCT_GROUP, ruleId: groupDiscount.id };
      }
    }

    return { discountPerPair: 0, source: DISCOUNT_SOURCE.NONE };
  },

  resolveProductDiscount(this: SqliteDatabase, partyId: string, productVariantId: string): { discountPerPair: number; source: DiscountSource; ruleId?: string } {
    const product = this.getSaleableVariant(productVariantId);
    if (!product) return { discountPerPair: 0, source: DISCOUNT_SOURCE.NONE };

    return this.resolveDiscount({
      partyId,
      article: product.article,
      size: product.size,
      productGroupId: product.productGroupId ?? undefined,
      articleSeriesId: product.articleSeriesId ?? undefined,
      applicablePrice: product.sellingPrice ?? undefined,
    });
  },

  resolveProductDiscountWithPrice(this: SqliteDatabase, partyId: string, productVariantId: string, actualSellingPrice: number): { discountPerPair: number; source: "ARTICLE" | "ARTICLE_SERIES" | "PRICE_RANGE" | "PRODUCT_GROUP" | "NONE"; ruleId?: string } {
    const product = this.getSaleableVariant(productVariantId);
    if (!product) return { discountPerPair: 0, source: "NONE" };

    return this.resolveDiscount({
      partyId,
      article: product.article,
      size: product.size,
      productGroupId: product.productGroupId ?? undefined,
      articleSeriesId: product.articleSeriesId ?? undefined,
      applicablePrice: actualSellingPrice, // Use the actual selling price from the sale voucher
    });
  },

  getPartyDiscountReport(this: SqliteDatabase, partyId: string): Array<{
    partyId: string;
    partyName: string;
    type: "ARTICLE" | "ARTICLE_SERIES" | "PRICE_RANGE" | "PRODUCT_GROUP";
    label: string;
    discountPerPair: number;
  }> {
    const party = this.getParty(partyId);
    if (!party) return [];

    const rows: Array<{ partyId: string; partyName: string; type: "ARTICLE" | "ARTICLE_SERIES" | "PRICE_RANGE" | "PRODUCT_GROUP"; label: string; discountPerPair: number }> = [];

    const articleRows = this.db.prepare(`
      SELECT pad.id, pad.discount_per_pair_paisa, pad.size_scope, pad.size, pad.article
      FROM party_article_discounts pad
      WHERE pad.party_id = ? AND pad.deleted_at IS NULL
      ORDER BY pad.article ASC, pad.size ASC
    `).all(partyId) as Array<{ discount_per_pair_paisa: number; size_scope: string; size: string | null; article: string }>;
    for (const row of articleRows) {
      const scopeLabel = row.size_scope === "SEPARATE_SIZES" && row.size ? ` / Size ${row.size}` : "";
      rows.push({ partyId, partyName: party.partyName, type: "ARTICLE", label: `${row.article}${scopeLabel}`, discountPerPair: fromPaisa(Number(row.discount_per_pair_paisa ?? 0)) });
    }

    const seriesRows = this.db.prepare(`
      SELECT pad.id, pad.discount_per_pair_paisa, aseries.name
      FROM party_article_series_discounts pad
      JOIN article_series aseries ON aseries.id = pad.article_series_id
      WHERE pad.party_id = ? AND pad.deleted_at IS NULL
      ORDER BY aseries.name ASC
    `).all(partyId) as Array<{ discount_per_pair_paisa: number; name: string }>;
    for (const row of seriesRows) {
      rows.push({ partyId, partyName: party.partyName, type: "ARTICLE_SERIES", label: row.name, discountPerPair: fromPaisa(Number(row.discount_per_pair_paisa ?? 0)) });
    }

    const rangeRows = this.db.prepare(`
      SELECT id, start_price_paisa, end_price_paisa, discount_per_pair_paisa
      FROM party_price_range_discounts
      WHERE party_id = ? AND deleted_at IS NULL
      ORDER BY start_price_paisa ASC
    `).all(partyId) as Array<{ start_price_paisa: number; end_price_paisa: number; discount_per_pair_paisa: number }>;
    for (const row of rangeRows) {
      const startPrice = fromPaisa(Number(row.start_price_paisa ?? 0));
      const endPrice = fromPaisa(Number(row.end_price_paisa ?? 0));
      rows.push({ partyId, partyName: party.partyName, type: "PRICE_RANGE", label: `${startPrice} - ${endPrice}`, discountPerPair: fromPaisa(Number(row.discount_per_pair_paisa ?? 0)) });
    }

    const groupRows = this.db.prepare(`
      SELECT pad.id, pad.discount_per_pair_paisa, pg.group_name
      FROM party_product_group_discounts pad
      JOIN product_groups pg ON pg.id = pad.product_group_id
      WHERE pad.party_id = ? AND pad.deleted_at IS NULL
      ORDER BY pg.group_name ASC
    `).all(partyId) as Array<{ discount_per_pair_paisa: number; group_name: string }>;
    for (const row of groupRows) {
      rows.push({ partyId, partyName: party.partyName, type: "PRODUCT_GROUP", label: row.group_name, discountPerPair: fromPaisa(Number(row.discount_per_pair_paisa ?? 0)) });
    }

    return rows;
  },

  /**
   * Returns the current outstanding balance for a party (sales + cash payments − cash
   * receipts − sale returns). Computed entirely in integer paisa (every operand below is a
   * `*_paisa` column, so SQLite does exact integer arithmetic, not floating point) and
   * converted back to rupees once, at the end — this is the balance-limit check's own safety
   * net (createSaleVoucher), so it must never drift from the ledger screens.
   */
  getCurrentPartyBalance(this: SqliteDatabase, partyId: string): number {
    const row = this.db
      .prepare(
        `SELECT
           COALESCE((SELECT SUM(sv.total_amount_paisa)   FROM live_sale_vouchers sv  WHERE sv.party_id = ? AND sv.deleted_at IS NULL), 0)
           + COALESCE((SELECT SUM(cv.payment_amount_paisa) FROM live_cash_vouchers cv WHERE cv.party_id = ? AND cv.deleted_at IS NULL AND cv.status = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM cash_voucher_lines cvl WHERE cvl.voucher_id = cv.id)), 0)
           + COALESCE((SELECT SUM(cvl.payment_amount_paisa) FROM cash_voucher_lines cvl JOIN live_cash_vouchers cv ON cv.id = cvl.voucher_id WHERE cvl.party_id = ? AND cv.deleted_at IS NULL AND cv.status = 'ACTIVE'), 0)
           - COALESCE((SELECT SUM(cv.receipt_amount_paisa) FROM live_cash_vouchers cv WHERE cv.party_id = ? AND cv.deleted_at IS NULL AND cv.status = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM cash_voucher_lines cvl WHERE cvl.voucher_id = cv.id)), 0)
           - COALESCE((SELECT SUM(cvl.receipt_amount_paisa) FROM cash_voucher_lines cvl JOIN live_cash_vouchers cv ON cv.id = cvl.voucher_id WHERE cvl.party_id = ? AND cv.deleted_at IS NULL AND cv.status = 'ACTIVE'), 0)
           - COALESCE((SELECT SUM(sr.total_amount_paisa) FROM live_sale_returns sr WHERE sr.party_id = ? AND sr.deleted_at IS NULL AND sr.status = 'ACTIVE'), 0)
           AS balance_paisa`
      )
         .get(partyId, partyId, partyId, partyId, partyId, partyId) as { balance_paisa: number };
    return fromPaisa(Number(row?.balance_paisa ?? 0));
  },

  createSaleVoucher(this: SqliteDatabase, input: {
    partyId: string;
    voucherDate: string;
    bookNo: string;
    voucherNumber?: string;
    subPartyName?: string;
    subPartyNameUrdu?: string;
    subPartyNumber?: string;
    remarks?: string;
    /** Final voucher total for balance-limit pre-check (optional; checked again on line-item save). */
    projectedTotal?: number;
    /** The gatepass this bill is made from. Must exist, be CREATED, and not be billed already. */
    gatepassId?: string | null;
  }): { id: string; voucherNumber: string } {
    let id: string = crypto.randomUUID();
    const now = new Date().toISOString();
    let generatedBill: { id: string; voucherNumber: string } | null = null;

    // ── GATEPASS LINK ─────────────────────────────────────────────────────────
    const gatepassId = typeof input.gatepassId === "string" && input.gatepassId.trim() ? input.gatepassId.trim() : null;
    if (gatepassId) {
      const gatepass = this.db.prepare("SELECT id, gatepass_number, status FROM gatepasses WHERE id = ? LIMIT 1").get(gatepassId) as { id: string; gatepass_number: number; status: string } | undefined;
      if (!gatepass) throw new GatepassBillingError("GATEPASS_NOT_FOUND", "This Gatepass could not be found.");
      const code = formatGatepassCode(Number(gatepass.gatepass_number));
      if (gatepass.status === "CANCELLED") throw new GatepassBillingError("GATEPASS_CANCELLED", `${code} was cancelled. It cannot be billed.`);
      const existing = this.db.prepare("SELECT id, voucher_number FROM sale_vouchers WHERE gatepass_id = ? AND deleted_at IS NULL LIMIT 1").get(gatepassId) as { id: string; voucher_number: string } | undefined;
      if (existing) {
        // The gatepass's generated bill, not entered yet, IS this bill: there is still only one (docs/43).
        const entered = gatepass.status !== "CREATED" || this.billHasLines(String(existing.id));
        if (entered) throw new GatepassBillingError("GATEPASS_ALREADY_BILLED", `${code} already has Sale Voucher #${existing.voucher_number}.`, { id: String(existing.id), voucherNumber: String(existing.voucher_number) });
        generatedBill = { id: String(existing.id), voucherNumber: String(existing.voucher_number) };
        id = generatedBill.id;
      }
    }
    
    // ── BALANCE LIMIT CHECK ───────────────────────────────────────────────────
    // Read the party's balance_limit. NULL = no limit configured → always allow.
    const partyRow = this.db
      .prepare("SELECT balance_limit_paisa FROM parties WHERE id = ? AND deleted_at IS NULL LIMIT 1")
      .get(input.partyId) as { balance_limit_paisa: number | null } | undefined;

    if (partyRow && partyRow.balance_limit_paisa != null) {
      const limit = fromPaisa(Number(partyRow.balance_limit_paisa));
      const currentBalance = this.getCurrentPartyBalance(input.partyId);
      const voucherAmount = typeof input.projectedTotal === "number" ? input.projectedTotal : 0;
      const projectedBalance = addMoney(currentBalance, voucherAmount);

      if (projectedBalance > limit) {
        throw new PartyBalanceLimitExceededError({
          currentBalance,
          voucherAmount,
          projectedBalance,
          limit,
          available: Math.max(0, subtractMoney(limit, currentBalance)),
          exceeded: subtractMoney(projectedBalance, limit),
        });
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // The bill, its dispatch session and — when it was made from a Gatepass — that
    // Gatepass becoming BILLED are one transaction. A Gatepass must never be left saying it
    // is billed by a bill that failed to save, nor the reverse.
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
    // The number is read inside the write lock, so the value that is checked is the value that
    // is inserted. A bill typed from the paper book (input.voucherNumber) always wins — the
    // office numbers its own bills and the ERP must never silently renumber one.
    let voucherNumber = input.voucherNumber;
    if (!voucherNumber || !voucherNumber.trim()) {
      // Only the FALLBACK is ranged: a number typed from the paper book above always wins.
      voucherNumber = generatedBill ? generatedBill.voucherNumber : String(allocateNumberInRange(this, "saleVoucher"));
    }

    if (generatedBill) {
      this.db
        .prepare(
          `UPDATE sale_vouchers SET voucher_number = ?, voucher_date = ?, book_no = ?, sub_party_name = ?, sub_party_name_urdu = ?,
             sub_party_number = ?, remarks = ?, updated_at = ? WHERE id = ?`
        )
        .run(voucherNumber, input.voucherDate, input.bookNo, input.subPartyName || null, input.subPartyNameUrdu || null, input.subPartyNumber || null, input.remarks || null, now, id);
    } else {
    this.db
      .prepare(
        `INSERT INTO sale_vouchers (
          id, voucher_number, party_id, voucher_date, book_no, sub_party_name, sub_party_name_urdu, sub_party_number,
          remarks, total_quantity, total_amount_paisa, status, created_at, updated_at,
          deleted_at, deleted_by, delete_reason, gatepass_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'DRAFT', ?, ?, NULL, NULL, NULL, ?)`
      )
      .run(
        id,
        voucherNumber,
        input.partyId,
        input.voucherDate,
        input.bookNo,
        input.subPartyName || null,
        input.subPartyNameUrdu || null,
        input.subPartyNumber || null,
        input.remarks || null,
        now,
        now,
        gatepassId
      );

    this.createDispatchSession(id);
    }

    // Billing is what moves a Gatepass out of its issued state. Guarded: if it is not CREATED
    // any more (cancelled, or billed by someone else a moment ago) nothing moves, and the
    // checks above have already refused the obvious cases.
    //
    // WHAT HAPPENS NEXT IS READ FROM THE DESKS' OWN QUEUE RULES (gatepassDeskWork: STORE_OWES_SQL,
    // GATE_OWES_SQL in gatepassLineSql.ts), never from the status:
    //
    //   store owes a scan                    rests at BILLED, in the store's queue; the store is told
    //   store owes nothing, a QR part        on to AT_GATE in this transaction, and the gate is told:
    //                                        its QR cartons were scanned out before the bill caught
    //                                        up and stand at the gate, which only AT_GATE can dispatch
    //   store owes nothing, no QR part       rests at BILLED in no queue, nobody told: every carton was
    //                                        issued directly (docs/42 section 10.2), the gate has
    //                                        nothing to do with it, and deleting the bill must still
    //                                        take it back to CREATED, where a cancel puts them back
    //
    // Only the status moves: no scan, stock movement or attribution is written or changed.
    if (gatepassId) this.moveGatepassOnBilling(gatepassId);

      this.db.exec("COMMIT");
      return { id, voucherNumber };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }
  },

  /**
   * A bill typed by hand -- not made from a gatepass -- saved whole: header, every line and the party's limit, in
   * one transaction, so a failure leaves nothing half-saved. One press of Save is one bill, so one debit: the
   * same request id asking for the same bill gets it back (ALREADY_SAVED); asking for a different one is a
   * RequestConflictError. Nothing is written in either case, and no number is taken.
   */
  createManualSaleVoucher(this: SqliteDatabase, input: ManualSaleVoucherInput): ManualSaleVoucherSaved {
    if (!isRequestId(input.requestId)) throw new Error("This bill could not be identified. Nothing was saved. Press Save again.");
    if (!input.lines.length) throw new Error("A bill needs at least one line.");
    const requestId = input.requestId.trim();
    const fingerprint = manualVoucherFingerprint(input);

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const existing = this.db.prepare("SELECT id, voucher_number, request_fingerprint FROM sale_vouchers WHERE request_id = ? LIMIT 1").get(requestId) as
        | { id: string; voucher_number: string | number; request_fingerprint: string | null }
        | undefined;
      if (existing) {
        this.db.exec("COMMIT");
        return this.answerRepeatedBill(existing, fingerprint);
      }
      const saved = this.insertManualSaleVoucher(input, requestId, fingerprint);
      this.db.exec("COMMIT");
      return saved;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }
  },

  /** @internal The bill an earlier press of Save made, or a conflict when this press asked for another. */
  answerRepeatedBill(this: SqliteDatabase, existing: { id: string; voucher_number: string | number; request_fingerprint: string | null }, fingerprint: string): ManualSaleVoucherSaved {
    const voucherNumber = String(existing.voucher_number);
    if (existing.request_fingerprint !== fingerprint) {
      throw new RequestConflictError(`This Save was already recorded as Sale Voucher #${voucherNumber}, with different details. Nothing new was saved. Open #${voucherNumber} to check it, or start a new bill.`, { id: String(existing.id), number: voucherNumber });
    }
    return { id: String(existing.id), voucherNumber, outcome: "ALREADY_SAVED" };
  },

  /** @internal Header, dispatch session, lines and the limit check, inside the caller's transaction. */
  insertManualSaleVoucher(this: SqliteDatabase, input: ManualSaleVoucherInput, requestId: string, fingerprint: string): ManualSaleVoucherSaved {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    // A number typed from the paper book always wins; only the fallback is ranged (as createSaleVoucher).
    const voucherNumber = input.voucherNumber?.trim() || String(allocateNumberInRange(this, "saleVoucher"));
    this.db
      .prepare(
        `INSERT INTO sale_vouchers (
          id, voucher_number, party_id, voucher_date, book_no, sub_party_name, sub_party_name_urdu, sub_party_number,
          remarks, total_quantity, total_amount_paisa, status, created_at, updated_at,
          deleted_at, deleted_by, delete_reason, gatepass_id, request_id, request_fingerprint
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'DRAFT', ?, ?, NULL, NULL, NULL, NULL, ?, ?)`
      )
      .run(id, voucherNumber, input.partyId, input.voucherDate, input.bookNo, input.subPartyName || null, input.subPartyNameUrdu || null, input.subPartyNumber || null, input.remarks || null, now, now, requestId, fingerprint);
    this.createDispatchSession(id);
    for (const line of input.lines) this.addVoucherLineItem(id, line);
    // The whole bill is in: refused here if it takes the party over its limit, and rolled back by the caller.
    this.assertWithinBalanceLimit(input.partyId, id);
    return { id, voucherNumber, outcome: "CREATED" };
  },

  /** @internal The gatepass leaves CREATED because its bill is entered. See the note in createSaleVoucher. */
  moveGatepassOnBilling(this: SqliteDatabase, gatepassId: string): void {
    const work = this.gatepassDeskWork(gatepassId);
    const billed = this.advanceGatepassStatus({ gatepassId, from: "CREATED", to: "BILLED", actor: null, notify: work.storeOwes });
    if (billed && work.gateOwes && !work.storeOwes) {
      this.advanceGatepassStatus({ gatepassId, from: "BILLED", to: "AT_GATE", actor: null, reason: "Scanned out of the store before billing" });
    }
  },

  /** @internal Whether a bill has been entered: it has lines. Until then it carries no money. */
  billHasLines(this: SqliteDatabase, voucherId: string): boolean {
    return this.db.prepare("SELECT 1 AS found FROM sale_voucher_line_items WHERE voucher_id = ? AND deleted_at IS NULL LIMIT 1").get(voucherId) !== undefined;
  },

  /**
   * @internal A gatepass's bill, generated in the gatepass's own transaction (docs/43): a number and the link,
   * no lines and so no money. The balance limit is checked when the bill is entered and has an amount. The
   * unique index on a live bill per gatepass is what makes a second one impossible.
   */
  createBillForGatepassInTransaction(this: SqliteDatabase, input: { gatepassId: string; partyId: string; voucherDate: string; nowIso: string }): { id: string; voucherNumber: string } {
    const id = crypto.randomUUID();
    const voucherNumber = String(allocateNumberInRange(this, "saleVoucher"));
    this.db
      .prepare(
        `INSERT INTO sale_vouchers (id, voucher_number, party_id, voucher_date, book_no, total_quantity, total_amount_paisa, status, created_at, updated_at, gatepass_id)
         VALUES (?, ?, ?, ?, '', 0, 0, 'DRAFT', ?, ?, ?)`
      )
      .run(id, voucherNumber, input.partyId, input.voucherDate, input.nowIso, input.nowIso, input.gatepassId);
    this.createDispatchSession(id);
    return { id, voucherNumber };
  },

  /** @internal A cancelled gatepass takes its unentered bill with it. A bill with lines stays, by this WHERE. */
  cancelUnenteredBillInTransaction(this: SqliteDatabase, input: { gatepassId: string; reason: string; cancelledAt: string }): void {
    const bill = this.db
      .prepare("SELECT id FROM sale_vouchers WHERE gatepass_id = ? AND deleted_at IS NULL LIMIT 1")
      .get(input.gatepassId) as { id: string } | undefined;
    if (!bill || this.billHasLines(bill.id)) return;
    this.db
      .prepare("UPDATE sale_vouchers SET status = 'CANCELLED', deleted_at = ?, delete_reason = ?, updated_at = ? WHERE id = ?")
      .run(input.cancelledAt, input.reason, input.cancelledAt, bill.id);
    const session = this.db.prepare("SELECT id FROM dispatch_sessions WHERE voucher_id = ? LIMIT 1").get(bill.id) as { id: string } | undefined;
    if (session) this.cancelDispatchSession(session.id);
  },

  /**
   * BILL ENTRY (docs/43): the desk's rates go onto the gatepass's generated bill, all of it or none of it, in one
   * transaction. This is the moment the customer owes: the debit is the bill's total, and nothing else
   * writes it. Stock is not touched, because the gatepass already took the cartons.
   *
   * Entering a bill already entered changes nothing and reports `duplicate`: a Save pressed twice, or retried after an
   * answer that never arrived, cannot debit the customer twice.
   */
  enterGatepassBill(this: SqliteDatabase, voucherId: string, input: {
    bookNo: string;
    subPartyNameUrdu?: string;
    remarks?: string;
    lines: Array<{ productVariantId: string; quantity: number; unitPrice: number; discount?: number; priceType?: "NORMAL" | "B_TYPE" }>;
  }): { id: string; voucherNumber: string; duplicate: boolean } {
    refuseTestFinancialDocument(this.db, "sale_vouchers", voucherId, "This bill");
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const bill = this.db
        .prepare(
          `SELECT sv.id, sv.voucher_number, sv.party_id, sv.gatepass_id, sv.deleted_at, g.status AS gatepass_status, g.gatepass_number
           FROM sale_vouchers sv LEFT JOIN gatepasses g ON g.id = sv.gatepass_id WHERE sv.id = ?`
        )
        .get(voucherId) as { id: string; voucher_number: string; party_id: string; gatepass_id: string | null; deleted_at: string | null; gatepass_status: string | null; gatepass_number: number | null } | undefined;
      if (!bill || bill.deleted_at || !bill.gatepass_id) throw new GatepassBillingError("GATEPASS_NOT_FOUND", "This bill was not made from a gatepass, or has been deleted.");
      if (bill.gatepass_status === "CANCELLED") throw new GatepassBillingError("GATEPASS_CANCELLED", `${formatGatepassCode(Number(bill.gatepass_number))} was cancelled. It cannot be billed.`);
      if (this.billHasLines(bill.id)) {
        this.db.exec("COMMIT");
        return { id: bill.id, voucherNumber: String(bill.voucher_number), duplicate: true };
      }
      this.db
        .prepare("UPDATE sale_vouchers SET book_no = ?, sub_party_name_urdu = ?, remarks = ?, updated_at = ? WHERE id = ?")
        .run(input.bookNo, input.subPartyNameUrdu || null, input.remarks || null, new Date().toISOString(), bill.id);
      this.moveGatepassOnBilling(bill.gatepass_id);
      for (const line of input.lines) this.addVoucherLineItem(bill.id, line);
      this.assertBillCoversGatepass(bill.id, bill.gatepass_id, input.lines.length);
      this.assertWithinBalanceLimit(bill.party_id, bill.id);
      this.db.exec("COMMIT");
      return { id: bill.id, voucherNumber: String(bill.voucher_number), duplicate: false };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }
  },

  /** @internal Every article + size the gatepass sent is on the bill. A line refused here is a part-billed dispatch. */
  assertBillCoversGatepass(this: SqliteDatabase, voucherId: string, gatepassId: string, lineCount: number): void {
    const rule = this.voucherGatepassRule(voucherId);
    const expected = this.gatepassBillQuantities(gatepassId);
    if (!rule || lineCount === expected.size) return;
    throw new BillDoesNotMatchGatepassError({
      mismatch: "LINE_MISSING",
      gatepassCode: rule.code,
      line: "",
      message: `${rule.code} carries ${expected.size} line(s), and this bill has ${lineCount}. A bill must carry everything its gatepass sent.`,
    });
  },

  /** @internal Refuses a just-entered bill that takes the party over its limit. Rolled back by the caller. */
  assertWithinBalanceLimit(this: SqliteDatabase, partyId: string, voucherId: string): void {
    const party = this.db.prepare("SELECT balance_limit_paisa FROM parties WHERE id = ? AND deleted_at IS NULL LIMIT 1").get(partyId) as { balance_limit_paisa: number | null } | undefined;
    if (party?.balance_limit_paisa == null) return;
    const limit = fromPaisa(Number(party.balance_limit_paisa));
    const projectedBalance = this.getCurrentPartyBalance(partyId);
    if (projectedBalance <= limit) return;
    const total = this.db.prepare("SELECT total_amount_paisa FROM sale_vouchers WHERE id = ?").get(voucherId) as { total_amount_paisa: number };
    const voucherAmount = fromPaisa(Number(total.total_amount_paisa));
    const currentBalance = subtractMoney(projectedBalance, voucherAmount);
    throw new PartyBalanceLimitExceededError({
      currentBalance,
      voucherAmount,
      projectedBalance,
      limit,
      available: Math.max(0, subtractMoney(limit, currentBalance)),
      exceeded: subtractMoney(projectedBalance, limit),
    });
  },

  getSaleVoucher(this: SqliteDatabase, voucherId: string): SaleVoucherRecord | null {
    const row = this.db
      .prepare(
        `SELECT
           sv.id, sv.voucher_number, sv.party_id, sv.voucher_date, sv.book_no,
           sv.sub_party_name, sv.sub_party_name_urdu, sv.sub_party_number, sv.remarks,
           sv.total_quantity, sv.total_amount_paisa, sv.status,
           sv.created_at, sv.updated_at, sv.gatepass_id,
           p.party_name, p.party_name_urdu, p.mobile_number, p.email,
           g.gatepass_number, g.status AS gatepass_status
         FROM sale_vouchers sv
         JOIN parties p ON p.id = sv.party_id
         LEFT JOIN gatepasses g ON g.id = sv.gatepass_id
         WHERE sv.id = ? AND sv.deleted_at IS NULL`
      )
      .get(voucherId) as Record<string, unknown> | undefined;

    if (!row) return null;

    const items = this.db
      .prepare(
        `SELECT
           svli.id, svli.product_variant_id, svli.quantity, svli.price_type, svli.unit_price_paisa,
           svli.discount_paisa, svli.discount_per_pair_paisa, svli.discount_source, svli.total_price_paisa,
           pv.article, pv.color, pv.size,
           pg.group_name
         FROM sale_voucher_line_items svli
         JOIN product_variants pv ON pv.id = svli.product_variant_id
         LEFT JOIN product_groups pg ON pg.id = pv.product_group_id
         WHERE svli.voucher_id = ? AND svli.deleted_at IS NULL
         ORDER BY svli.created_at ASC`
      )
      .all(voucherId) as Array<Record<string, unknown>>;

    return {
      id: String(row.id ?? ""),
      voucherNumber: String(row.voucher_number ?? ""),
      partyId: String(row.party_id ?? ""),
      partyName: String(row.party_name ?? ""),
      partyNameUrdu: row.party_name_urdu ? String(row.party_name_urdu) : null,
      partyMobile: String(row.mobile_number ?? ""),
      partyEmail: String(row.email ?? ""),
      voucherDate: String(row.voucher_date ?? ""),
      bookNo: String(row.book_no ?? ""),
      subPartyName: row.sub_party_name ? String(row.sub_party_name) : null,
      subPartyNameUrdu: row.sub_party_name_urdu ? String(row.sub_party_name_urdu) : null,
      subPartyNumber: row.sub_party_number ? String(row.sub_party_number) : null,
      remarks: row.remarks ? String(row.remarks) : null,
      totalQuantity: Number(row.total_quantity ?? 0),
      totalAmount: fromPaisa(Number(row.total_amount_paisa ?? 0)),
      status: String(row.status ?? "DRAFT"),
      gatepassId: row.gatepass_id ? String(row.gatepass_id) : null,
      gatepassCode: row.gatepass_id && row.gatepass_number != null ? formatGatepassCode(Number(row.gatepass_number)) : null,
      gatepassStatus: row.gatepass_id ? this.mapGatepassStatus(row.gatepass_status) : null,
      lineItems: items.map((item) => ({
        id: String(item.id ?? ""),
        productVariantId: String(item.product_variant_id ?? ""),
        quantity: Number(item.quantity ?? 0),
        priceType: item.price_type === PRICE_TYPE.B_TYPE ? PRICE_TYPE.B_TYPE : PRICE_TYPE.NORMAL,
        unitPrice: fromPaisa(Number(item.unit_price_paisa ?? 0)),
        discount: fromPaisa(Number(item.discount_paisa ?? 0)),
        discountPerPair: fromPaisa(Number(item.discount_per_pair_paisa ?? 0)),
        discountSource: parseDiscountSource(item.discount_source),
        totalPrice: fromPaisa(Number(item.total_price_paisa ?? 0)),
        article: String(item.article ?? ""),
        color: String(item.color ?? ""),
        size: String(item.size ?? ""),
        groupName: item.group_name ? String(item.group_name) : null,
      })),
      createdAt: String(row.created_at ?? ""),
      updatedAt: String(row.updated_at ?? ""),
    };
  },

  /** The live (not deleted) sale voucher made from a gatepass, if any — one at most. */
  findSaleVoucherByGatepass(this: SqliteDatabase, gatepassId: string): { id: string; voucherNumber: string } | null {
    const row = this.db
      .prepare("SELECT id, voucher_number FROM sale_vouchers WHERE gatepass_id = ? AND deleted_at IS NULL LIMIT 1")
      .get(String(gatepassId ?? "").trim()) as { id: string; voucher_number: string } | undefined;
    return row ? { id: String(row.id), voucherNumber: String(row.voucher_number) } : null;
  },

  listSaleVouchers(this: SqliteDatabase, query: { search?: string; page?: number; pageSize?: number; status?: string } = {}): PagedResult<SaleVoucherListRow> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const offset = (page - 1) * pageSize;

    const where: string[] = ["sv.deleted_at IS NULL"];
    const values: Array<string | number> = [];

    if (query.status && query.status !== "ALL") {
      where.push("sv.status = ?");
      values.push(query.status);
    }

    if (query.search?.trim()) {
      const needle = `%${query.search.trim()}%`;
      where.push("(sv.voucher_number LIKE ? OR p.party_name LIKE ? OR sv.sub_party_name LIKE ?)");
      values.push(needle, needle, needle);
    }

    const whereClause = where.join(" AND ");

    const totalRow = this.db
      .prepare(`SELECT COUNT(1) as c FROM sale_vouchers sv JOIN parties p ON p.id = sv.party_id WHERE ${whereClause}`)
      .get(...values) as { c: number };

    const rows = this.db
      .prepare(
        `SELECT
           sv.id, sv.voucher_number, sv.party_id, sv.voucher_date, sv.book_no,
           sv.sub_party_name, sv.total_quantity, sv.total_amount_paisa, sv.status,
           sv.created_at, sv.updated_at,
           p.party_name
         FROM sale_vouchers sv
         JOIN parties p ON p.id = sv.party_id
         WHERE ${whereClause}
         ORDER BY sv.voucher_date DESC, sv.created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...values, pageSize, offset) as Array<Record<string, unknown>>;

    return {
      rows: rows.map((row) => ({
        id: String(row.id ?? ""),
        voucherNumber: String(row.voucher_number ?? ""),
        partyName: String(row.party_name ?? ""),
        voucherDate: String(row.voucher_date ?? ""),
        bookNo: String(row.book_no ?? ""),
        subPartyName: row.sub_party_name ? String(row.sub_party_name) : null,
        totalQuantity: Number(row.total_quantity ?? 0),
        totalAmount: fromPaisa(Number(row.total_amount_paisa ?? 0)),
        status: String(row.status ?? "DRAFT"),
        createdAt: String(row.created_at ?? ""),
      })),
      total: totalRow.c,
      page,
      pageSize,
    };
  },

  updateSaleVoucher(this: SqliteDatabase, voucherId: string, input: { subPartyName?: string; subPartyNameUrdu?: string; subPartyNumber?: string; remarks?: string; bookNo?: string }): void {
    refuseTestFinancialDocument(this.db, "sale_vouchers", voucherId, "This bill");
    const now = new Date().toISOString();
    const updates: string[] = ["updated_at = ?"];
    const values: (string | null)[] = [now];

    if (input.bookNo !== undefined) {
      updates.push("book_no = ?");
      values.push(input.bookNo);
    }
    if (input.subPartyName !== undefined) {
      updates.push("sub_party_name = ?");
      values.push(input.subPartyName || null);
    }
    if (input.subPartyNameUrdu !== undefined) {
      updates.push("sub_party_name_urdu = ?");
      values.push(input.subPartyNameUrdu || null);
    }
    if (input.subPartyNumber !== undefined) {
      updates.push("sub_party_number = ?");
      values.push(input.subPartyNumber || null);
    }
    if (input.remarks !== undefined) {
      updates.push("remarks = ?");
      values.push(input.remarks || null);
    }

    values.push(voucherId);

    this.db.prepare(`UPDATE sale_vouchers SET ${updates.join(", ")} WHERE id = ?`).run(...values);
  },

  /**
   * What the gatepass says the bill must carry: dozens per article + size.
   *
   * The gatepass is written in cartons per colour; a bill has one line per article + size in
   * dozens, because price and discount live on the article + size and colour is a store
   * concern that never reaches a bill. This is the same fold the billing screen does when it
   * drafts the bill (features/billing/gatepassToVoucher) — here it is the AUTHORITY, so a
   * caller that skips the screen cannot bill something the gatepass never sent.
   */
  gatepassBillQuantities(this: SqliteDatabase, gatepassId: string): Map<string, { article: string; size: string; dozens: number }> {
    const rows = this.db
      .prepare(
        `SELECT article_snapshot, size_snapshot, quantity
         FROM gatepass_lines WHERE gatepass_id = ? ORDER BY line_no`
      )
      .all(String(gatepassId ?? "").trim()) as Array<{ article_snapshot: string; size_snapshot: string; quantity: number }>;

    const byArticleSize = new Map<string, { article: string; size: string; dozens: number }>();
    for (const row of rows) {
      const article = String(row.article_snapshot ?? "").trim();
      const size = String(row.size_snapshot ?? "").trim();
      const key = articleSizeKey(article, size);
      const existing = byArticleSize.get(key);
      // Cartons are summed across colours FIRST, then converted once — converting each
      // colour separately and adding would round an odd carton count differently.
      if (existing) existing.dozens += Number(row.quantity ?? 0);
      else byArticleSize.set(key, { article, size, dozens: Number(row.quantity ?? 0) });
    }
    for (const entry of byArticleSize.values()) entry.dozens = cartonsToDozens(entry.dozens);
    return byArticleSize;
  },

  /** The gatepass a voucher must keep saying, or null when the bill was not made from one. */
  voucherGatepassRule(this: SqliteDatabase, voucherId: string): { code: string; quantities: Map<string, { article: string; size: string; dozens: number }> } | null {
    const row = this.db
      .prepare(
        `SELECT g.id, g.gatepass_number FROM sale_vouchers sv
         JOIN gatepasses g ON g.id = sv.gatepass_id
         WHERE sv.id = ? LIMIT 1`
      )
      .get(String(voucherId ?? "").trim()) as { id: string; gatepass_number: number } | undefined;
    if (!row) return null;
    return { code: formatGatepassCode(Number(row.gatepass_number ?? 0)), quantities: this.gatepassBillQuantities(String(row.id)) };
  },

  /**
   * Refuses a line that would make the bill disagree with its gatepass.
   *
   * Called before every line write, so the rule holds however the write arrives — the
   * billing screen locks the quantity, but locking a field is not enforcement.
   */
  assertBillLineMatchesGatepass(
    this: SqliteDatabase,
    input: { voucherId: string; productVariantId: string; dozens: number; lineItemId?: string }
  ): void {
    const rule = this.voucherGatepassRule(input.voucherId);
    if (!rule) return; // Not made from a gatepass: nothing to disagree with.

    const variant = this.getSaleableVariant(input.productVariantId);
    const article = String(variant?.article ?? "").trim();
    const size = String(variant?.size ?? "").trim();
    const line = `${article} ${size}`.trim() || input.productVariantId;
    const expected = rule.quantities.get(articleSizeKey(article, size));

    if (!expected) {
      throw new BillDoesNotMatchGatepassError({
        mismatch: "LINE_NOT_ON_GATEPASS",
        gatepassCode: rule.code,
        line,
        billedDozens: input.dozens,
        message: `${rule.code} does not carry ${line}. A bill may only carry what its gatepass sent.`,
      });
    }

    // The same article + size cannot appear twice: the gatepass already folded its colours
    // into one line, so a second row would bill part of the dispatch again.
    const twin = this.db
      .prepare(
        `SELECT li.id FROM sale_voucher_line_items li
         JOIN product_variants pv ON pv.id = li.product_variant_id
         WHERE li.voucher_id = ? AND li.deleted_at IS NULL
           AND UPPER(TRIM(pv.article)) = UPPER(?) AND UPPER(TRIM(pv.size)) = UPPER(?)
           AND li.id <> ?
         LIMIT 1`
      )
      .get(input.voucherId, article, size, input.lineItemId ?? "") as { id: string } | undefined;
    if (twin) {
      throw new BillDoesNotMatchGatepassError({
        mismatch: "LINE_ALREADY_ON_BILL",
        gatepassCode: rule.code,
        line,
        expectedDozens: expected.dozens,
        message: `${line} is already on this bill. ${rule.code} carries it once.`,
      });
    }

    // Quantities are dozens held as REAL, so they are compared at the precision they are
    // written in rather than by exact float equality.
    if (Math.abs(Number(input.dozens) - expected.dozens) > 1e-6) {
      throw new BillDoesNotMatchGatepassError({
        mismatch: "QUANTITY_DIFFERS",
        gatepassCode: rule.code,
        line,
        expectedDozens: expected.dozens,
        billedDozens: Number(input.dozens),
        message:
          `${rule.code} sent ${expected.dozens} dozen of ${line}, so the bill must say ${expected.dozens}, not ${input.dozens}. ` +
          `If the quantity is wrong, cancel ${rule.code} and make the right gatepass.`,
      });
    }
  },

  /**
   * The one backend authority for what discount a sale line may carry — used by BOTH
   * addVoucherLineItem and updateVoucherLineItem so the two paths can never diverge.
   *
   * B-TYPE ALWAYS has zero discount — never resolved, never overridden by a caller-supplied
   * value. For a NORMAL line, resolveDiscount()'s result is the ceiling: a caller-supplied
   * discount within that ceiling (including exactly at it) is accepted as-is; omitting a
   * discount falls back to the full resolved ceiling (the existing behavior); a caller-supplied
   * discount that exceeds the ceiling is REJECTED outright — never clamped — by throwing
   * DiscountExceedsAllowedError, before any row is touched.
   */
  resolveLineDiscount(this: SqliteDatabase, input: {
    partyId: string;
    productVariantId: string;
    unitPrice: number;
    quantityInPairs: number;
    priceType: "NORMAL" | "B_TYPE";
    requestedDiscount?: number;
  }): { discount: number; discountPerPair: number; discountSource: DiscountSource } {
    if (input.priceType === "B_TYPE") {
      return { discount: 0, discountPerPair: 0, discountSource: DISCOUNT_SOURCE.NONE };
    }

    const product = this.getSaleableVariant(input.productVariantId);
    const resolved = input.partyId && product ? this.resolveDiscount({
      partyId: input.partyId,
      article: product.article,
      size: product.size,
      productGroupId: product.productGroupId ?? undefined,
      articleSeriesId: product.articleSeriesId ?? undefined,
      applicablePrice: input.unitPrice,
    }) : { discountPerPair: 0, source: DISCOUNT_SOURCE.NONE };

    const allowedMaximum = multiplyMoney(resolved.discountPerPair, input.quantityInPairs);

    if (input.requestedDiscount === undefined || !Number.isFinite(input.requestedDiscount)) {
      return { discount: allowedMaximum, discountPerPair: resolved.discountPerPair, discountSource: resolved.source };
    }

    const requestedDiscount = Number(input.requestedDiscount);
    if (toPaisa(requestedDiscount) > toPaisa(allowedMaximum)) {
      throw new DiscountExceedsAllowedError({
        requestedDiscount,
        allowedMaximum,
        exceededBy: subtractMoney(requestedDiscount, allowedMaximum),
      });
    }

    return { discount: requestedDiscount, discountPerPair: resolved.discountPerPair, discountSource: resolved.source };
  },

  /**
   * Adds one line. With `lineId` -- the screen's id for the line -- a repeated add (a double click, a retry after
   * a lost answer) is that same line, reported as `duplicate`, and never a second debit; the same id carrying
   * different content, or on another bill, is a RequestConflictError. Without one, a new id is made.
   */
  addVoucherLineItem(this: SqliteDatabase, voucherId: string, input: SaleLineInput): { id: string; duplicate?: boolean } {
    refuseTestFinancialDocument(this.db, "sale_vouchers", voucherId, "This bill");
    const repeated = input.lineId === undefined ? null : this.repeatedVoucherLine(voucherId, input);
    if (repeated) return repeated;

    // What went out is the gatepass's to say; refused before anything is written.
    this.assertBillLineMatchesGatepass({ voucherId, productVariantId: input.productVariantId, dozens: input.quantity });
    this.assertBillIsBeingEntered(voucherId);

    const id = input.lineId?.trim() || crypto.randomUUID();
    const now = new Date().toISOString();
    // `quantity` is dozens; pricing is per pair.
    const quantityInPairs = dozensToPairs(input.quantity);

    const voucherPartyId =
      this.getSaleVoucher(voucherId)?.partyId ??
      (this.db.prepare(`SELECT party_id FROM sale_vouchers WHERE id = ? LIMIT 1`).get(voucherId) as { party_id: string } | undefined)?.party_id ??
      "";

    const priceType: PriceType = input.priceType === PRICE_TYPE.B_TYPE ? PRICE_TYPE.B_TYPE : PRICE_TYPE.NORMAL;
    const { discount, discountPerPair, discountSource } = this.resolveLineDiscount({
      partyId: voucherPartyId,
      productVariantId: input.productVariantId,
      unitPrice: input.unitPrice,
      quantityInPairs,
      priceType,
      requestedDiscount: input.discount,
    });

    const totalPrice = saleLineTotal({ dozens: input.quantity, pairRate: input.unitPrice, totalDiscount: discount });

    this.db
      .prepare(
        `INSERT INTO sale_voucher_line_items (
          id, voucher_id, product_variant_id, quantity, price_type, discount_source,
          unit_price_paisa, discount_paisa, discount_per_pair_paisa, total_price_paisa,
          created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        id, voucherId, input.productVariantId, input.quantity, priceType, discountSource,
        toPaisa(input.unitPrice), toPaisa(discount), toPaisa(discountPerPair), toPaisa(totalPrice),
        now, now
      );

    this.recalculateVoucherTotals(voucherId);

    return { id };
  },

  /** @internal The line a screen's line id already made: the same line back, or a conflict. Null when there is none. */
  repeatedVoucherLine(this: SqliteDatabase, voucherId: string, input: SaleLineInput): { id: string; duplicate: true } | null {
    const lineId = String(input.lineId ?? "").trim();
    if (!isRequestId(lineId)) throw new Error("This line could not be identified. Nothing was saved. Press Save again.");
    const row = this.db
      .prepare("SELECT voucher_id, product_variant_id, quantity, unit_price_paisa, price_type, deleted_at FROM sale_voucher_line_items WHERE id = ?")
      .get(lineId) as { voucher_id: string; product_variant_id: string; quantity: number; unit_price_paisa: number; price_type: string; deleted_at: string | null } | undefined;
    if (!row) return null;
    const same =
      row.voucher_id === voucherId && row.deleted_at === null && row.product_variant_id === input.productVariantId &&
      Number(row.quantity) === Number(input.quantity) && Number(row.unit_price_paisa) === toPaisa(input.unitPrice) && row.price_type === priceTypeOf(input.priceType);
    if (!same) throw new RequestConflictError("This line was already saved with different details. Nothing new was saved. Reopen the bill to check it.", { id: lineId, number: "" });
    return { id: lineId, duplicate: true };
  },

  /**
   * @internal A gatepass's generated bill takes its lines all together, through enterGatepassBill, which moves
   * the gatepass first. One line slipped in here would debit the customer on a gatepass still open to cancelling.
   */
  assertBillIsBeingEntered(this: SqliteDatabase, voucherId: string): void {
    const open = this.db
      .prepare(
        `SELECT 1 AS found FROM sale_vouchers sv JOIN gatepasses g ON g.id = sv.gatepass_id
         WHERE sv.id = ? AND sv.deleted_at IS NULL AND g.status = 'CREATED' LIMIT 1`
      )
      .get(voucherId);
    if (open) throw new GatepassBillingError("GATEPASS_NOT_FOUND", "Enter the whole bill and save it. Its lines are saved together.");
  },

  deleteVoucherLineItem(this: SqliteDatabase, itemId: string): void {
    const item = this.db
      .prepare(`SELECT voucher_id, product_variant_id FROM sale_voucher_line_items WHERE id = ?`)
      .get(itemId) as { voucher_id: string; product_variant_id: string } | undefined;

    if (!item) return;
    refuseTestFinancialDocument(this.db, "sale_vouchers", item.voucher_id, "This bill");

    // Removing a gatepass line would leave that dispatch part-billed, so it is refused. A
    // bill that should not exist is deleted whole, which releases its gatepass.
    const rule = this.voucherGatepassRule(item.voucher_id);
    if (rule) {
      const variant = this.getSaleableVariant(item.product_variant_id);
      const line = `${String(variant?.article ?? "").trim()} ${String(variant?.size ?? "").trim()}`.trim();
      throw new BillDoesNotMatchGatepassError({
        mismatch: "LINE_MAY_NOT_BE_REMOVED",
        gatepassCode: rule.code,
        line: line || item.product_variant_id,
        message: `${line || "This line"} is on ${rule.code}, so the bill has to carry it. Delete the whole bill if it should not exist.`,
      });
    }

    const now = new Date().toISOString();
    this.db.prepare(`UPDATE sale_voucher_line_items SET deleted_at = ? WHERE id = ?`).run(now, itemId);

    this.recalculateVoucherTotals(item.voucher_id);
  },

  updateVoucherLineItem(this: SqliteDatabase, itemId: string, input: { quantity: number; unitPrice: number; discount: number; priceType?: "NORMAL" | "B_TYPE" }): void {
    const item = this.db
      .prepare(`SELECT voucher_id, product_variant_id FROM sale_voucher_line_items WHERE id = ? AND deleted_at IS NULL`)
      .get(itemId) as { voucher_id: string; product_variant_id: string } | undefined;

    if (!item) return;
    refuseTestFinancialDocument(this.db, "sale_vouchers", item.voucher_id, "This bill");

    // The rate, the price type and the discount are the desk's; the quantity is not.
    this.assertBillLineMatchesGatepass({
      voucherId: item.voucher_id,
      productVariantId: item.product_variant_id,
      dozens: input.quantity,
      lineItemId: itemId,
    });

    const quantityInPairs = dozensToPairs(input.quantity);
    const voucherPartyId =
      (this.db.prepare(`SELECT party_id FROM sale_vouchers WHERE id = ? LIMIT 1`).get(item.voucher_id) as { party_id: string } | undefined)?.party_id ?? "";

    // Same authority as addVoucherLineItem — an update may never carry a bigger discount than
    // the line would be allowed if it were being added fresh right now.
    const priceType: PriceType = input.priceType === PRICE_TYPE.B_TYPE ? PRICE_TYPE.B_TYPE : PRICE_TYPE.NORMAL;
    const { discount, discountPerPair, discountSource } = this.resolveLineDiscount({
      partyId: voucherPartyId,
      productVariantId: item.product_variant_id,
      unitPrice: input.unitPrice,
      quantityInPairs,
      priceType,
      requestedDiscount: input.discount,
    });

    const totalPrice = saleLineTotal({ dozens: input.quantity, pairRate: input.unitPrice, totalDiscount: discount });
    const now = new Date().toISOString();

    this.db
      .prepare(
        `UPDATE sale_voucher_line_items
         SET quantity = ?, price_type = ?, discount_source = ?,
             unit_price_paisa = ?, discount_paisa = ?, discount_per_pair_paisa = ?, total_price_paisa = ?,
             updated_at = ?
         WHERE id = ? AND deleted_at IS NULL`
      )
      .run(
        input.quantity, priceType, discountSource,
        toPaisa(input.unitPrice), toPaisa(discount), toPaisa(discountPerPair), toPaisa(totalPrice),
        now, itemId
      );

    this.recalculateVoucherTotals(item.voucher_id);
  },

  /**
   * Cancels a sale voucher. Any DISPATCHED cartons that were exactly attributed to this
   * voucher's own dispatch session (dispatch_session_id — see packages/data/src/database/
   * dispatch.ts) are reversed: the original event is kept forever, a new ADJUSTMENT event
   * records the correction, and qr_master/stock are restored to the exact state the original
   * event recorded as "previous" — never to a hardcoded PRODUCED/FACTORY, and never by
   * guessing from article + size + a timestamp.
   *
   * Idempotent: cancelling an already-cancelled voucher is a no-op success. DISPATCHED events
   * that predate exact attribution (dispatch_session_id IS NULL) are never auto-reversed even
   * if they look, by the old article+size heuristic, like they might belong to this voucher —
   * they are reported back as `ambiguousDispatchEventIds` for manual reconciliation.
   */
  deleteSaleVoucher(this: SqliteDatabase, voucherId: string, reason = "Deleted from voucher management"): DeleteSaleVoucherResult {
    refuseTestFinancialDocument(this.db, "sale_vouchers", voucherId, "This bill");
    const now = new Date().toISOString();
    const voucher = this.db
      .prepare("SELECT created_at, deleted_at FROM sale_vouchers WHERE id = ? LIMIT 1")
      .get(voucherId) as { created_at: string; deleted_at: string | null } | undefined;
    if (!voucher) {
      return { cancelled: false, reversedEventCount: 0, ambiguousDispatchEventIds: [], cancelledReturnCount: 0 };
    }
    if (voucher.deleted_at) {
      // Already cancelled — repeating the operation must be safe, not re-reverse anything.
      return { cancelled: true, reversedEventCount: 0, ambiguousDispatchEventIds: [], cancelledReturnCount: 0 };
    }

    const session = this.db
      .prepare("SELECT id FROM dispatch_sessions WHERE voucher_id = ? LIMIT 1")
      .get(voucherId) as { id: string } | undefined;

    const dispatchedEvents = session ? this.listDispatchedEventsForSession(session.id) : [];
    // Reversing a QR dispatch moves this computer's carton figure with no movement (docs/42 section 9), so while
    // carton QR is on hold a bill with QR cartons out on it is refused, and nothing changes.
    if (this.cartonQrOnHold && dispatchedEvents.length > 0) {
      throw new Error(`This bill has ${dispatchedEvents.length} carton QR dispatch(es) on it, and carton QR is on hold, so it cannot be deleted now. Nothing was changed.`);
    }
    const ambiguousEvents = this.findAmbiguousLegacyDispatchEvents(voucherId, voucher.created_at);

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      let reversedEventCount = 0;
      for (const event of dispatchedEvents) {
        const reversed = this.reverseDispatchedEvent(event, { voucherId, dispatchSessionId: session!.id, nowIso: now });
        if (reversed) reversedEventCount += 1;
      }
      if (session) {
        this.cancelDispatchSession(session.id);
      }

      // Carton-return credits are cancelled with the bill they credit. Without this the sale
      // debit would vanish while its credit stayed, leaving the customer permanently in
      // pocket for a sale the system no longer says happened. The rows are kept (soft
      // cancel), so the history of what was recorded and when survives.
      //
      // The cartons themselves are deliberately left alone: a returned carton is physically
      // standing at the gate whatever happened to the paperwork, and Store Move In is still
      // the right way to receive it. Its dispatch is likewise not reversed here — an ON_GATE
      // carton is already excluded from listDispatchedEventsForSession, because it left the
      // variant pool at dispatch and rejoins it when the store receives it.
      const cancelledReturns = this.db
        .prepare("UPDATE sale_returns SET status = 'CANCELLED', deleted_at = ?, delete_reason = ?, updated_at = ? WHERE sale_voucher_id = ? AND deleted_at IS NULL")
        .run(now, reason, now, voucherId);

      this.db.prepare("UPDATE sale_vouchers SET deleted_at = ?, delete_reason = ?, status = 'CANCELLED', updated_at = ? WHERE id = ?").run(now, reason, now, voucherId);

      // Deleting the bill is how a BILLED Gatepass is unwound, so it goes back to waiting for
      // one. Only from BILLED: once its cartons have left the store the document is AT_GATE or
      // beyond, and deleting the paperwork must not pretend the goods are still inside.
      const billed = this.db
        .prepare("SELECT gatepass_id FROM sale_vouchers WHERE id = ?")
        .get(voucherId) as { gatepass_id: string | null } | undefined;
      if (billed?.gatepass_id) {
        this.advanceGatepassStatus({ gatepassId: billed.gatepass_id, from: "BILLED", to: "CREATED", actor: null });
      }
      this.db.exec("COMMIT");
      return {
        cancelled: true,
        reversedEventCount,
        ambiguousDispatchEventIds: ambiguousEvents.map((event) => event.id),
        cancelledReturnCount: Number(cancelledReturns.changes ?? 0),
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  },

  getCustomerLedger(this: SqliteDatabase, partyId: string, query: { fromDate?: string; toDate?: string } = {}): {
    partyId: string;
    partyName: string;
    entries: Array<{
      voucherId: string;
      voucherNumber: string;
      voucherDate: string;
      bookNo: string;
      subPartyName: string | null;
      remarks: string | null;
      totalQuantity: number;
      amount: number;
      balance: number;
      lineItems: Array<{
        id: string;
        article: string;
        color: string;
        size: string;
        groupName: string | null;
        quantity: number;      // dozens
        unitPrice: number;     // pair rate
        discount: number;      // total discount
        totalPrice: number;
      }>;
    }>;
  } {
    const party = this.getParty(partyId);
    if (!party) {
      return { partyId, partyName: "", entries: [] };
    }

    // Karachi, not UTC: a UTC default hid today's entries for the five hours after
    // local midnight, so the newest rows simply were not in the ledger.
    const toDate = query.toDate || businessToday();
    const fromDate = query.fromDate || "0000-01-01";

    const saleRows = this.db
      .prepare(
        `SELECT id, voucher_number, voucher_date, book_no, sub_party_name, remarks, total_amount_paisa, total_quantity
         FROM live_sale_vouchers
         WHERE party_id = ? AND deleted_at IS NULL AND total_amount_paisa <> 0 AND voucher_date >= ? AND voucher_date <= ?
         ORDER BY voucher_date ASC, created_at ASC`
      )
      .all(partyId, fromDate, toDate) as Array<Record<string, unknown>>;

    const cashRows = this.db
      .prepare(
        `SELECT id, voucher_number, voucher_date, description, receipt_amount_paisa, payment_amount_paisa
         FROM live_cash_vouchers
         WHERE party_id = ? AND deleted_at IS NULL AND status = 'ACTIVE' AND voucher_date >= ? AND voucher_date <= ?
         ORDER BY voucher_date ASC, created_at ASC`
      )
      .all(partyId, fromDate, toDate) as Array<Record<string, unknown>>;

    const returnRows = this.db
      .prepare(
        `SELECT sr.id, sr.return_number, sr.return_date, sr.total_amount_paisa, pv.article, pv.size
         FROM live_sale_returns sr
         JOIN product_variants pv ON pv.id = sr.product_variant_id
         WHERE sr.party_id = ? AND sr.deleted_at IS NULL AND sr.status = 'ACTIVE' AND sr.return_date >= ? AND sr.return_date <= ?
         ORDER BY sr.return_date ASC, sr.created_at ASC`
      )
      .all(partyId, fromDate, toDate) as Array<Record<string, unknown>>;

    const transactions: Array<{
      voucherId: string;
      voucherNumber: string;
      voucherDate: string;
      bookNo: string;
      subPartyName: string | null;
      remarks: string | null;
      totalQuantity: number;
      amount: number;
      type: "SALE" | "CASH_RECEIPT" | "CASH_PAYMENT" | "SALE_RETURN";
      lineItems: Array<Record<string, unknown>>;
    }> = [];

    for (const row of saleRows) {
      transactions.push({
        voucherId: String(row.id ?? ""),
        voucherNumber: String(row.voucher_number ?? ""),
        voucherDate: String(row.voucher_date ?? ""),
        bookNo: String(row.book_no ?? ""),
        subPartyName: row.sub_party_name ? String(row.sub_party_name) : null,
        remarks: row.remarks ? String(row.remarks) : null,
        totalQuantity: Number(row.total_quantity ?? 0),
        amount: fromPaisa(Number(row.total_amount_paisa ?? 0)),
        type: "SALE",
        lineItems: this.db
          .prepare(
            `SELECT svli.id, svli.quantity, svli.unit_price_paisa, svli.discount_paisa, svli.total_price_paisa,
                    pv.article, pv.color, pv.size,
                    pg.group_name
             FROM sale_voucher_line_items svli
             JOIN product_variants pv ON pv.id = svli.product_variant_id
             LEFT JOIN product_groups pg ON pg.id = pv.product_group_id
             WHERE svli.voucher_id = ? AND svli.deleted_at IS NULL
             ORDER BY svli.created_at ASC`
          )
          .all(String(row.id ?? "")) as Array<Record<string, unknown>>,
      });
    }

    for (const row of cashRows) {
      const receiptAmount = fromPaisa(Number(row.receipt_amount_paisa ?? 0));
      const paymentAmount = fromPaisa(Number(row.payment_amount_paisa ?? 0));
      if (receiptAmount > 0) {
        transactions.push({
          voucherId: String(row.id ?? ""),
          voucherNumber: String(row.voucher_number ?? ""),
          voucherDate: String(row.voucher_date ?? ""),
          bookNo: "",
          subPartyName: null,
          remarks: row.description ? String(row.description) : null,
          totalQuantity: 0,
          amount: -receiptAmount,
          type: "CASH_RECEIPT",
          lineItems: [],
        });
      }

      if (paymentAmount > 0) {
        transactions.push({
          voucherId: String(row.id ?? ""),
          voucherNumber: String(row.voucher_number ?? ""),
          voucherDate: String(row.voucher_date ?? ""),
          bookNo: "",
          subPartyName: null,
          remarks: row.description ? String(row.description) : null,
          totalQuantity: 0,
          amount: paymentAmount,
          type: "CASH_PAYMENT",
          lineItems: [],
        });
      }
    }

    // A returned carton is a credit, so it carries a negative amount into the running
    // balance — the same sign convention a cash receipt uses two blocks above.
    for (const row of returnRows) {
      transactions.push({
        voucherId: String(row.id ?? ""),
        voucherNumber: String(row.return_number ?? ""),
        voucherDate: String(row.return_date ?? ""),
        bookNo: "",
        subPartyName: null,
        remarks: `Return ${String(row.article ?? "")} ${String(row.size ?? "")} (1 carton)`,
        totalQuantity: 0,
        amount: -fromPaisa(Number(row.total_amount_paisa ?? 0)),
        type: "SALE_RETURN",
        lineItems: [],
      });
    }

    transactions.sort((a, b) => {
      if (a.voucherDate !== b.voucherDate) return a.voucherDate.localeCompare(b.voucherDate);
      const typeOrder = { SALE: 1, SALE_RETURN: 2, CASH_RECEIPT: 3, CASH_PAYMENT: 4 };
      return typeOrder[a.type] - typeOrder[b.type];
    });

    let runningBalance = 0;
    const entries = transactions.map((tx) => {
      runningBalance = addMoney(runningBalance, tx.amount);

      return {
        voucherId: tx.voucherId,
        voucherNumber: tx.voucherNumber,
        voucherDate: tx.voucherDate,
        bookNo: tx.bookNo,
        subPartyName: tx.subPartyName,
        remarks: tx.remarks,
        totalQuantity: tx.totalQuantity,
        amount: tx.amount,
        balance: runningBalance,
        lineItems: tx.lineItems.map((it) => ({
          id: String(it.id ?? ""),
          article: String(it.article ?? ""),
          color: String(it.color ?? ""),
          size: String(it.size ?? ""),
          groupName: it.group_name ? String(it.group_name) : null,
          quantity: Number(it.quantity ?? 0),
          unitPrice: fromPaisa(Number(it.unit_price_paisa ?? 0)),
          discount: fromPaisa(Number(it.discount_paisa ?? 0)),
          totalPrice: fromPaisa(Number(it.total_price_paisa ?? 0)),
        })),
      };
    });

    return {
      partyId,
      partyName: party.partyName,
      entries,
    };
  },

  listCustomerBalances(this: SqliteDatabase, query: { asOfDate?: string } = {}): {
    rows: Array<{
      partyId: string;
      partyName: string;
      city: string | null;
      balance: number;
      lastVoucherDate: string | null;
      totalSales: number;
      totalReceipts: number;
      totalPayments: number;
      /** Credits for cartons this customer sent back. */
      totalReturns: number;
    }>;
    total: number;
  } {
    // Karachi, not UTC -- see the note in listSupplierBalances. A receivable dated
    // today was excluded from the balance while sitting in the ledger.
    const asOfDate = query.asOfDate || businessToday();
    // Every SUM below is over a *_paisa column so SQLite does exact integer arithmetic; each
    // total is converted back to rupees once, in the row mapping below — never summed as REAL.
    const rows = this.db
      .prepare(
        `SELECT
           p.id AS party_id,
           p.party_name,
           p.city,
           ${SALES_PAISA_SQL} AS total_sales_paisa,
           ${cashPaisaSql("receipt_amount_paisa")} AS total_receipts_paisa,
           ${cashPaisaSql("payment_amount_paisa")} AS total_payments_paisa,
           ${RETURNS_PAISA_SQL} AS total_returns_paisa,
           ${SALES_PAISA_SQL} + ${cashPaisaSql("payment_amount_paisa")} - ${cashPaisaSql("receipt_amount_paisa")} - ${RETURNS_PAISA_SQL} AS balance_paisa,
           (
             SELECT MAX(dt)
             FROM (
               SELECT sv.voucher_date AS dt
               FROM live_sale_vouchers sv
               WHERE sv.party_id = p.id AND sv.deleted_at IS NULL AND sv.total_amount_paisa <> 0 AND sv.voucher_date <= ?1
               UNION ALL
               SELECT cv.voucher_date AS dt
               FROM live_cash_vouchers cv
               WHERE cv.deleted_at IS NULL AND cv.status = 'ACTIVE' AND cv.voucher_date <= ?1
                 AND (cv.party_id = p.id OR EXISTS (SELECT 1 FROM cash_voucher_lines l WHERE l.voucher_id = cv.id AND l.party_id = p.id))
               UNION ALL
               SELECT sr.return_date AS dt
               FROM live_sale_returns sr
               WHERE sr.party_id = p.id AND sr.deleted_at IS NULL AND sr.status = 'ACTIVE' AND sr.return_date <= ?1
             )
           ) AS last_voucher_date
         FROM parties p
         WHERE p.deleted_at IS NULL AND p.party_type = 'CUSTOMER' AND p.status = 'ACTIVE'
         ORDER BY balance_paisa DESC, p.party_name ASC`
      )
      .all(asOfDate) as Array<Record<string, unknown>>;

    return {
      rows: rows.map((row) => ({
        partyId:        String(row.party_id   ?? ""),
        partyName:      String(row.party_name ?? ""),
        city:           row.city ? String(row.city) : null,
        balance:        fromPaisa(Number(row.balance_paisa ?? 0)),
        lastVoucherDate: row.last_voucher_date ? String(row.last_voucher_date) : null,
        totalSales:     fromPaisa(Number(row.total_sales_paisa    ?? 0)),
        totalReceipts:  fromPaisa(Number(row.total_receipts_paisa ?? 0)),
        totalPayments:  fromPaisa(Number(row.total_payments_paisa ?? 0)),
        totalReturns:   fromPaisa(Number(row.total_returns_paisa  ?? 0)),
      })),
      total: rows.length,
    };
  },

  recalculateVoucherTotals(this: SqliteDatabase, voucherId: string): void {
    // total_amount_paisa is the exact integer sum, computed from the *_paisa line items —
    // summing REAL would reintroduce float error once a voucher has many lines.
    const totals = this.db
      .prepare(
        `SELECT COALESCE(SUM(quantity), 0) as total_qty, COALESCE(SUM(total_price_paisa), 0) as total_amt_paisa
         FROM sale_voucher_line_items
         WHERE voucher_id = ? AND deleted_at IS NULL`
      )
      .get(voucherId) as { total_qty: number; total_amt_paisa: number };

    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE sale_vouchers SET total_quantity = ?, total_amount_paisa = ?, updated_at = ? WHERE id = ?")
      .run(totals.total_qty, totals.total_amt_paisa, now, voucherId);
  },
};

export type SalesMethods = typeof salesMethods;
