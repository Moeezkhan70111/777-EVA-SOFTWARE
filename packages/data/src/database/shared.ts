import type { DatabaseSync } from "node:sqlite";
import type { TransactionContext } from "@erp/application";
import { IN_STORE_LOCATION_TYPE } from "@erp/application";

// Helpers shared by the feature modules under ./database and by SqliteDatabase itself.

/** The transaction context handed to repository methods carries the live connection. */
export interface MutableTransactionContext extends TransactionContext {
  db: DatabaseSync;
}

/**
 * ORDER BY fragments cannot be bound as parameters, so every caller-supplied sort column
 * must be checked against the columns the query actually exposes before interpolation.
 */
export function orderBy(sortBy: string | undefined, allowed: readonly string[], fallback: string, sortOrder: string | undefined): string {
  const column = sortBy && allowed.includes(sortBy) ? sortBy : fallback;
  const direction = sortOrder === "ASC" ? "ASC" : "DESC";
  return `${column} ${direction}`;
}

/** Normalizes raw-material text (category names, attribute values, options) so entries and duplicate checks are case/whitespace-insensitive. */
export const normalizeInventoryText = (value: unknown) =>
  String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");

export type StoreSessionKind = "receiving" | "move-out";

export const STORE_SESSION_TABLES: Record<StoreSessionKind, { table: string; prefix: string; noun: string }> = {
  receiving: { table: "store_receiving_sessions", prefix: "SR", noun: "receiving" },
  "move-out": { table: "store_move_out_sessions", prefix: "SO", noun: "move-out" },
};

// ─── The one derivation of "Current Stock" ───────────────────────────────────────
// Current Stock is what is physically In Store right now. The WAREHOUSE rows of
// stock_projection_by_location are the only figure the store scans move: Store Move In
// adds one, Store Move Out takes one away. Production (which only fills FACTORY) and
// Dispatch (which takes the unit from wherever it already sits) never move it on their
// own, so a produced carton counts as stock the moment the store receives it — not
// before — and stops counting the moment it leaves.
//
// `pv` must be the product_variants alias in the enclosing query. Nothing is cached;
// every read derives the figure from the location projection.
export const IN_STORE_STOCK_SQL = `COALESCE((SELECT SUM(spl.quantity_on_hand) FROM stock_projection_by_location spl
                                             WHERE spl.product_variant_id = pv.id
                                               AND spl.location_type = '${IN_STORE_LOCATION_TYPE}'), 0)`;

/** The same figure summed over every variant, for dashboard/report totals (no `pv` in scope). */
export const IN_STORE_STOCK_TOTAL_SQL = `SELECT spl.product_variant_id, SUM(spl.quantity_on_hand) AS quantity_on_hand
                                         FROM stock_projection_by_location spl
                                         WHERE spl.location_type = '${IN_STORE_LOCATION_TYPE}'
                                         GROUP BY spl.product_variant_id`;

/**
 * What a raw material comes in (PACKET, BAG, BOTTLE…), for a query whose inventory_items alias
 * is `ii`. The material's own sub-category first, then its parent category, then the legacy
 * per-material inventory_items.pack_name. NULL when none is set — screens then say PACKET.
 * Correlated subqueries rather than joins, so it drops into any query without alias clashes.
 */
export const EFFECTIVE_PACK_NAME_SQL = `COALESCE(
  (SELECT NULLIF(TRIM(pkc.pack_name), '') FROM inventory_categories pkc WHERE pkc.id = ii.category_id),
  (SELECT NULLIF(TRIM(pkp.pack_name), '') FROM inventory_categories pkc
     JOIN inventory_categories pkp ON pkp.id = pkc.parent_id WHERE pkc.id = ii.category_id),
  NULLIF(TRIM(ii.pack_name), '')
)`;

/** The container word as stored: trimmed and upper-case, or null when left blank. */
export const normalizePackName = (value: unknown): string | null => {
  const text = String(value ?? "").trim().toUpperCase();
  return text || null;
};
