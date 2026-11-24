// THE PENDING ORDERS SCREEN AND THE ORDER ENTRY GRID (docs/52). Read only.
//
//   READ   pendingOrderParties     one row per party: ordered, dispatched, pending, paged, searched, filtered
//   READ   pendingOrderPartyLines  one party's products: ordered, dispatched, pending, and the orders they are on
//   READ   customerOrderArticle    one article's live colours and sizes, the only cells an order may be typed in
//
// Every figure comes from the records: an open order's active lines, less what gatepasses were allocated against them
// (ORDER_LINE_DISPATCHED_SQL), each ordering never below what was dispatched (ORDER_LINE_EFFECTIVE_SQL, 24 Nov 2026). Nothing is cached. A cancelled order owes nothing and is not listed.
//
// FILTERED BY LINE. OUTSTANDING lists the lines still owed something, DISPATCHED the lines fully dispatched, ALL both;
// a party's figures are the sum of its listed lines. SEARCH matches the party's name (all its lines) or the article.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import { PENDING_ORDER_FILTER, formatCustomerOrderCode, orderProgressOf, type OrderProgress, type PendingOrderFilter } from "@erp/domain";
import type { SqliteDatabase } from "../sqliteDatabase.js";
import { ORDER_LINE_COUNTS_SQL, ORDER_LINE_DISPATCHED_SQL, ORDER_LINE_EFFECTIVE_SQL } from "./orderAllocation.js";

type Row = Record<string, unknown>;
const text = (value: unknown): string => (value == null ? "" : String(value));

export interface PendingOrderQuery {
  readonly search?: string;
  readonly filter?: PendingOrderFilter;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface PendingOrderParty {
  readonly partyId: string;
  readonly partyName: string;
  readonly ordered: number;
  readonly dispatched: number;
  readonly pending: number;
  readonly lineCount: number;
  readonly orderCount: number;
  readonly progress: OrderProgress;
}

export interface PendingOrderPartyPage {
  readonly rows: readonly PendingOrderParty[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  /** Pending cartons across every party the query matched, not only this page. */
  readonly totalPending: number;
}

export interface PendingOrderLine {
  readonly productVariantId: string;
  readonly article: string;
  readonly color: string;
  readonly size: string;
  readonly ordered: number;
  readonly dispatched: number;
  readonly pending: number;
  readonly progress: OrderProgress;
  /** The orders this product is on for the party, oldest first, e.g. ["ORD-000012", "ORD-000014"]. */
  readonly orderCodes: readonly string[];
}

/** One article's live product, a cell an order may be typed in. */
export interface CustomerOrderArticleProduct {
  readonly productVariantId: string;
  readonly size: string;
  readonly color: string;
}

const MAX_PAGE_SIZE = 100;

/**
 * Every open order's active line, with what it owes, as `lines`, kept to the query's search and filter. `?1` is the
 * search pattern (or NULL for none).
 */
const LINES_CTE = (filter: PendingOrderFilter) => `WITH lines AS (
    SELECT o.party_id, p.party_name, o.id AS order_id, o.order_number, o.created_at, ol.product_variant_id,
           ol.article_snapshot AS article, ol.color_snapshot AS color, ol.size_snapshot AS size,
           ${ORDER_LINE_EFFECTIVE_SQL} AS ordered, ${ORDER_LINE_DISPATCHED_SQL} AS dispatched
      FROM customer_order_lines ol
      JOIN customer_orders o ON o.id = ol.order_id
      JOIN parties p ON p.id = o.party_id
     WHERE o.status = 'OPEN' AND ${ORDER_LINE_COUNTS_SQL}
       AND (?1 IS NULL OR p.party_name LIKE ?1 ESCAPE '\\' OR ol.article_snapshot LIKE ?1 ESCAPE '\\')
  ), listed AS (
    SELECT *, ordered - dispatched AS pending FROM lines
     WHERE ${filter === PENDING_ORDER_FILTER.OUTSTANDING ? "ordered > dispatched" : filter === PENDING_ORDER_FILTER.DISPATCHED ? "ordered = dispatched" : "1 = 1"}
  )`;

/** "%sk6%" for LIKE, with % and _ typed by the operator matched as themselves. Null when nothing is searched. */
function searchPattern(search: unknown): string | null {
  const needle = text(search).trim();
  return needle ? `%${needle.replace(/[\\%_]/g, (match) => `\\${match}`)}%` : null;
}

const filterOf = (value: unknown): PendingOrderFilter =>
  value === PENDING_ORDER_FILTER.DISPATCHED || value === PENDING_ORDER_FILTER.ALL ? value : PENDING_ORDER_FILTER.OUTSTANDING;

export const pendingOrderMethods = {
  /** One row per party with listed lines, by name, a page at a time. */
  pendingOrderParties(this: SqliteDatabase, query: PendingOrderQuery = {}): PendingOrderPartyPage {
    const pageSize = Math.min(Math.max(Math.trunc(Number(query.pageSize) || 25), 1), MAX_PAGE_SIZE);
    const page = Math.max(Math.trunc(Number(query.page) || 1), 1);
    const cte = LINES_CTE(filterOf(query.filter));
    const pattern = searchPattern(query.search);
    const summary = this.db
      .prepare(`${cte} SELECT COUNT(DISTINCT party_id) AS parties, COALESCE(SUM(pending), 0) AS pending FROM listed`)
      .get(pattern) as Row;
    const rows = this.db
      .prepare(
        `${cte} SELECT party_id, party_name, SUM(ordered) AS ordered, SUM(dispatched) AS dispatched, SUM(pending) AS pending,
                       COUNT(*) AS line_count, COUNT(DISTINCT order_id) AS order_count
                  FROM listed GROUP BY party_id, party_name ORDER BY party_name COLLATE NOCASE ASC LIMIT ?2 OFFSET ?3`
      )
      .all(pattern, pageSize, (page - 1) * pageSize) as Row[];
    return {
      rows: rows.map((row) => {
        const ordered = Number(row.ordered);
        const dispatched = Number(row.dispatched);
        return {
          partyId: text(row.party_id), partyName: text(row.party_name), ordered, dispatched, pending: Number(row.pending),
          lineCount: Number(row.line_count), orderCount: Number(row.order_count), progress: orderProgressOf(ordered, dispatched),
        };
      }),
      total: Number(summary.parties ?? 0),
      page,
      pageSize,
      totalPending: Number(summary.pending ?? 0),
    };
  },

  /** One party's listed lines, one row per product summed over its open orders, by article, colour and size. */
  pendingOrderPartyLines(this: SqliteDatabase, partyId: string, query: Pick<PendingOrderQuery, "search" | "filter"> = {}): PendingOrderLine[] {
    const rows = this.db
      .prepare(
        `${LINES_CTE(filterOf(query.filter))}
         SELECT product_variant_id, article, color, size, SUM(ordered) AS ordered, SUM(dispatched) AS dispatched, SUM(pending) AS pending,
                GROUP_CONCAT(order_number, ',') AS order_numbers
           FROM (SELECT * FROM listed WHERE party_id = ?2 ORDER BY created_at, order_number)
          GROUP BY product_variant_id, article, color, size
          ORDER BY article COLLATE NOCASE, color COLLATE NOCASE, size COLLATE NOCASE`
      )
      .all(searchPattern(query.search), text(partyId)) as Row[];
    return rows.map((row) => {
      const ordered = Number(row.ordered);
      const dispatched = Number(row.dispatched);
      const numbers = text(row.order_numbers).split(",").filter(Boolean).map(Number);
      return {
        productVariantId: text(row.product_variant_id), article: text(row.article), color: text(row.color), size: text(row.size),
        ordered, dispatched, pending: Number(row.pending), progress: orderProgressOf(ordered, dispatched),
        orderCodes: [...new Set(numbers)].map(formatCustomerOrderCode),
      };
    });
  },

  /** One article's live colours and sizes: exactly the products an order line may name. */
  customerOrderArticle(this: SqliteDatabase, article: string): CustomerOrderArticleProduct[] {
    const name = text(article).trim();
    if (!name) return [];
    const rows = this.db
      .prepare(
        `SELECT pv.id, pv.size, pv.color FROM product_variants pv JOIN article_sizes ass ON ass.id = pv.article_size_id
          WHERE pv.article = ? COLLATE NOCASE AND pv.status = 'ACTIVE' AND pv.deleted_at IS NULL AND ass.status = 'ACTIVE' AND ass.deleted_at IS NULL
          ORDER BY pv.color, pv.size`
      )
      .all(name) as Row[];
    return rows.map((row) => ({ productVariantId: text(row.id), size: text(row.size), color: text(row.color) }));
  },
};

export type PendingOrderMethods = typeof pendingOrderMethods;
