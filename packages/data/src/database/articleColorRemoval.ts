// REMOVING A COLOUR FROM AN ARTICLE (owner, 27 Nov 2026: "there is no way to delete colors of articles"). The
// counterpart of addColorToArticle (cartonStockDocuments.ts): the colour leaves every size of the article.
//
// Nothing is deleted. Each of the colour's products is DISABLED, with when, by whom and why, exactly as Product List's
// Disable does: its production, gatepasses, bills, QR labels and orders keep pointing at it and keep reading right.
// Adding the colour again brings the same products back (upsertProductVariant), with the ids their records name.
// The change marks the article's sizes for sync (masterCapture.ts), so it reaches every computer as master data.
//
// Refused, with the reason in words, while removing it would hide something still real (itemRemoval.ts's rule for
// materials, the same idea):
//   * any size of the colour holds carton stock, above or below zero: take it to zero with a Stock Adjustment first
//   * any size holds stock anywhere else either: at any location, reserved or damaged (owner, 27 Nov 2026: "MAKE SURE
//     NOT TO DELETE AN ITEM IF IT HAS STOCK")
//   * an open order still waits for it: it could never be dispatched
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import { cartonsToDozens } from "@erp/domain";
import type { SqliteDatabase } from "../sqliteDatabase.js";
import { CartonAdjustmentRefused } from "./cartonStockDocuments.js";
import { ORDER_LINE_COUNTS_SQL, ORDER_LINE_DISPATCHED_SQL, ORDER_LINE_EFFECTIVE_SQL } from "./orderAllocation.js";
import { IN_STORE_STOCK_SQL } from "./shared.js";

type Row = Record<string, unknown>;

/** What removing a colour from an article did. */
export interface ArticleColorRemoval {
  readonly color: string;
  /** Sizes the colour was taken off. */
  readonly removed: number;
}

const LIVE = "pv.deleted_at IS NULL AND COALESCE(pv.status, 'ACTIVE') <> 'DISABLED'";
const SAME_ARTICLE_AND_COLOUR = "UPPER(TRIM(pv.article)) = UPPER(TRIM(?)) AND UPPER(TRIM(pv.color)) = ?";

/** Stock a product holds anywhere but the store: other locations, and reserved or damaged. */
const OTHER_STOCK_SQL = `(COALESCE((SELECT SUM(ABS(spl.quantity_on_hand)) FROM stock_projection_by_location spl WHERE spl.product_variant_id = pv.id), 0)
  + COALESCE((SELECT ABS(spv.quantity_on_hand) + ABS(spv.quantity_reserved) + ABS(spv.quantity_damaged) FROM stock_projection_by_variant spv WHERE spv.product_variant_id = pv.id), 0))`;

/** The colour's live products on the article, with the cartons each holds in store, and whether it holds any elsewhere. */
function liveProducts(database: SqliteDatabase, article: string, color: string): Array<{ id: string; article: string; size: string; inStore: number; otherStock: number }> {
  const rows = database.db
    .prepare(`SELECT pv.id, pv.article, pv.size, ${IN_STORE_STOCK_SQL} AS in_store, ${OTHER_STOCK_SQL} AS other_stock FROM product_variants pv WHERE ${SAME_ARTICLE_AND_COLOUR} AND ${LIVE}`)
    .all(article, color) as Row[];
  return rows.map((row) => ({ id: String(row.id), article: String(row.article), size: String(row.size), inStore: Number(row.in_store ?? 0), otherStock: Number(row.other_stock ?? 0) }));
}

/** Open order lines still owed something for these products. */
function linesStillOwed(database: SqliteDatabase, productIds: readonly string[]): number {
  const marks = productIds.map(() => "?").join(", ");
  const row = database.db
    .prepare(
      `SELECT COUNT(*) AS lines FROM customer_order_lines ol JOIN customer_orders o ON o.id = ol.order_id
        WHERE o.status = 'OPEN' AND ${ORDER_LINE_COUNTS_SQL} AND ol.product_variant_id IN (${marks})
          AND ${ORDER_LINE_EFFECTIVE_SQL} > ${ORDER_LINE_DISPATCHED_SQL}`
    )
    .get(...productIds) as Row | undefined;
  return Number(row?.lines ?? 0);
}

/** Why the colour cannot be removed yet, or null. */
function removalProblem(database: SqliteDatabase, article: string, color: string, products: ReturnType<typeof liveProducts>): string | null {
  const holding = products.filter((product) => product.inStore !== 0);
  if (holding.length > 0) {
    const sizes = holding.map((product) => `${product.size} (${cartonsToDozens(product.inStore)} dozen)`).join(", ");
    return `${article} ${color} still has carton stock: ${sizes}. Take it to zero with a Stock Adjustment first.`;
  }
  const elsewhere = products.filter((product) => product.otherStock !== 0);
  if (elsewhere.length > 0) {
    return `${article} ${color} still has stock in size ${elsewhere.map((product) => product.size).join(", ")}. Bring it to zero first. Nothing was changed.`;
  }
  const owed = linesStillOwed(database, products.map((product) => product.id));
  if (owed > 0) return `${article} ${color} is still waiting on ${owed} open order ${owed === 1 ? "line" : "lines"}. Dispatch or take them off the order first.`;
  return null;
}

export const articleColorRemovalMethods = {
  /** Takes a colour off every size of an article, if nothing real still depends on it. All sizes or none. */
  removeColorFromArticle(this: SqliteDatabase, input: { article: string; color: string; actor?: string | null }): ArticleColorRemoval {
    const article = String(input.article ?? "").trim();
    const color = String(input.color ?? "").trim().toUpperCase().replace(/\s+/g, " ");
    if (!article) throw new CartonAdjustmentRefused("Choose the article first.");
    if (!color) throw new CartonAdjustmentRefused("Choose the colour to remove.");
    const actor = String(input.actor ?? "").trim() || null;
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const products = liveProducts(this, article, color);
      if (products.length === 0) throw new CartonAdjustmentRefused(`${article} has no colour ${color}. Nothing was changed.`);
      const named = products[0]?.article ?? article;
      const problem = removalProblem(this, named, color, products);
      if (problem) throw new CartonAdjustmentRefused(problem);
      const now = new Date().toISOString();
      const reason = `Colour removed from ${named}${actor ? ` by ${actor}` : ""}`;
      const disable = this.db.prepare(
        "UPDATE product_variants SET status = 'DISABLED', deleted_at = ?, deleted_by = ?, delete_reason = ?, updated_at = ? WHERE id = ?"
      );
      for (const product of products) disable.run(now, actor, reason, now, product.id);
      this.db.exec("COMMIT");
      return { color, removed: products.length };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }
  },
};

export type ArticleColorRemovalMethods = typeof articleColorRemovalMethods;
