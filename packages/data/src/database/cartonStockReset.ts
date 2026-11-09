// THE CARTON STOCK FRESH START: the figures go to zero on one computer, and nothing else changes
// (docs/42 section 13, scripts/reset-carton-stock.mjs).
//
// WHAT IT CLEARS. Derived figures only: the WAREHOUSE rows of stock_projection_by_location go to zero,
// and stock_projection_by_variant falls by what they held. They have no movement behind them, so they
// could never agree with another computer.
//
// WHAT IT NEVER TOUCHES. Manual Production entries (the contractor ledger and pay read them), QR
// identities and scan history, gatepasses, every other figure and table. The verify step proves it, by
// hashing every other table in the input and the output.
//
// IT STOPS, CHANGING NOTHING, when clearing could disagree with a record: QR cartons in the store (their
// figure is real and on hold), a gatepass still owed QR cartons, a figure below what its rows hold, or
// movements that came from the cloud. A figure the cloud has contributed to is no longer disposable.
//
// CARTON CLOUD (stockProtection.ts). Once Carton Cloud has been activated here the figure is shared, and a reset is
// refused outright. Before activation, movements made on this computer were never sent and never can be: they are
// test data, so they do not stop the fresh start. They stay as history rows, excluded for ever.

import { createHash } from "node:crypto";
import { IN_STORE_LOCATION_TYPE, IN_STORE_STATUS } from "@erp/application";
import { LINE_SETTLED_SQL } from "./gatepassLineSql.js";
import { CARTON_CLOUD_ACTIVATION_KEY } from "./stockProtection.js";

export const CARTON_RESET_MIN_SCHEMA = 103;

const PROJECTION_TABLES: ReadonlySet<string> = new Set(["stock_projection_by_location", "stock_projection_by_variant"]);

type Row = Record<string, unknown>;

export interface ResetHandle {
  prepare(sql: string): {
    all(...params: Array<string | number>): unknown[];
    get(...params: Array<string | number>): unknown;
    run(...params: Array<string | number>): unknown;
  };
  exec(sql: string): void;
}

export interface CartonResetVariant {
  readonly variantId: string;
  readonly label: string;
  readonly inStore: number;
  readonly variantBefore: number;
  readonly variantAfter: number;
}

export interface CartonResetPlan {
  readonly refusals: readonly string[];
  readonly variants: readonly CartonResetVariant[];
  readonly cartonsCleared: number;
  /** Counted so the report can say what stayed: none of these change. */
  readonly kept: {
    readonly manualEntries: number;
    readonly qrCartons: number;
    readonly productionEvents: number;
    readonly gatepasses: number;
    /** Carton movements made here before Carton Cloud was activated: test history, kept, never sent. */
    readonly localTestMovements: number;
  };
}

export interface CartonResetCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const count = (db: ResetHandle, sql: string, ...params: Array<string | number>): number =>
  Number((db.prepare(sql).get(...params) as Row | undefined)?.n ?? 0);

function schemaNumber(db: ResetHandle): number {
  const hasTable = db.prepare("SELECT 1 AS here FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (hasTable === undefined) return 0;
  const rows = db.prepare("SELECT version FROM schema_migrations").all() as Row[];
  return rows.reduce((highest, row) => Math.max(highest, Number.parseInt(String(row.version), 10) || 0), 0);
}

function planVariants(db: ResetHandle): CartonResetVariant[] {
  const rows = db
    .prepare(
      `SELECT l.product_variant_id AS variant_id, SUM(l.quantity_on_hand) AS in_store,
              COALESCE(v.quantity_on_hand, 0) AS variant_before,
              COALESCE(pv.article || ' ' || pv.size || ' ' || pv.color, l.product_variant_id) AS label
         FROM stock_projection_by_location l
         LEFT JOIN stock_projection_by_variant v ON v.product_variant_id = l.product_variant_id
         LEFT JOIN product_variants pv ON pv.id = l.product_variant_id
        WHERE l.location_type = ?
        GROUP BY l.product_variant_id HAVING SUM(l.quantity_on_hand) <> 0
        ORDER BY label`
    )
    .all(IN_STORE_LOCATION_TYPE) as Row[];
  return rows.map((row) => ({
    variantId: String(row.variant_id),
    label: String(row.label),
    inStore: Number(row.in_store),
    variantBefore: Number(row.variant_before),
    variantAfter: Number(row.variant_before) - Number(row.in_store),
  }));
}

function refusalsFor(db: ResetHandle, variants: readonly CartonResetVariant[]): string[] {
  const reasons: string[] = [];
  const schema = schemaNumber(db);
  if (schema < CARTON_RESET_MIN_SCHEMA) return [`The database is at migration ${schema}, and this needs ${CARTON_RESET_MIN_SCHEMA}. Start the release once first.`];
  if (count(db, "SELECT COUNT(1) AS n FROM app_settings WHERE setting_key = ?", CARTON_CLOUD_ACTIVATION_KEY) > 0) {
    return ["Carton Cloud has been activated on this computer: its carton figure is shared with the cloud and is never reset."];
  }
  const received = count(db, "SELECT COUNT(1) AS n FROM carton_stock_events WHERE replicated_at IS NOT NULL");
  if (received > 0) reasons.push(`${received} carton movement(s) came from the cloud. That figure is shared with other computers and is not disposable.`);
  const qrInStore = count(db, "SELECT COUNT(1) AS n FROM qr_master WHERE current_status = ?", IN_STORE_STATUS);
  if (qrInStore > 0) reasons.push(`${qrInStore} QR carton(s) are in the store. Clearing would make the figure disagree with their scan history. Decide what they are first.`);
  const owed = count(
    db,
    `SELECT COALESCE(SUM(gl.quantity - ${LINE_SETTLED_SQL}), 0) AS n
       FROM gatepass_lines gl JOIN gatepasses g ON g.id = gl.gatepass_id WHERE g.status <> 'CANCELLED'`
  );
  if (owed > 0) reasons.push(`Live gatepasses still owe ${owed} carton(s) to the store. Settle or cancel them first.`);
  for (const variant of variants) {
    if (variant.variantAfter < 0) reasons.push(`${variant.label}: the store rows hold ${variant.inStore} but its total is ${variant.variantBefore}. The figures already disagree. Look at this first.`);
  }
  return reasons;
}

/** What a reset would do, and everything that stops it. Reads only. */
export function planCartonStockReset(db: ResetHandle): CartonResetPlan {
  if (schemaNumber(db) < CARTON_RESET_MIN_SCHEMA) {
    return { refusals: refusalsFor(db, []), variants: [], cartonsCleared: 0, kept: { manualEntries: 0, qrCartons: 0, productionEvents: 0, gatepasses: 0, localTestMovements: 0 } };
  }
  const variants = planVariants(db);
  return {
    refusals: refusalsFor(db, variants),
    variants,
    cartonsCleared: variants.reduce((sum, variant) => sum + variant.inStore, 0),
    kept: {
      manualEntries: count(db, "SELECT COUNT(1) AS n FROM manual_production_entries"),
      qrCartons: count(db, "SELECT COUNT(1) AS n FROM qr_master"),
      productionEvents: count(db, "SELECT COUNT(1) AS n FROM production_events"),
      gatepasses: count(db, "SELECT COUNT(1) AS n FROM gatepasses"),
      localTestMovements: count(db, "SELECT COUNT(1) AS n FROM carton_stock_events WHERE replicated_at IS NULL"),
    },
  };
}

/** Makes the plan's changes in one transaction. Refuses, changing nothing, if anything stops it now. */
export function applyCartonStockReset(db: ResetHandle, nowIso: string): CartonResetPlan {
  db.exec("BEGIN IMMEDIATE");
  try {
    const plan = planCartonStockReset(db);
    if (plan.refusals.length > 0) throw new Error(`REFUSED, nothing changed:\n  - ${plan.refusals.join("\n  - ")}`);
    for (const variant of plan.variants) {
      db.prepare("UPDATE stock_projection_by_variant SET quantity_on_hand = quantity_on_hand - ?, updated_at = ? WHERE product_variant_id = ?")
        .run(variant.inStore, nowIso, variant.variantId);
      db.prepare("UPDATE stock_projection_by_location SET quantity_on_hand = 0, updated_at = ? WHERE product_variant_id = ? AND location_type = ?")
        .run(nowIso, variant.variantId, IN_STORE_LOCATION_TYPE);
    }
    db.exec("COMMIT");
    return plan;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const tableNames = (db: ResetHandle): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Row[]).map((row) => String(row.name));

/** A hash of a table's whole content, row by row in a fixed order. */
function tableHash(db: ResetHandle, table: string): string {
  const hash = createHash("sha256");
  const rows = db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() as Row[];
  for (const row of rows) hash.update(JSON.stringify(row, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value)));
  return hash.digest("hex");
}

function otherFigureRows(db: ResetHandle): string {
  const rows = db.prepare("SELECT product_variant_id, location_type, location_id, quantity_on_hand FROM stock_projection_by_location WHERE location_type <> ? ORDER BY 1, 2, 3").all(IN_STORE_LOCATION_TYPE);
  return JSON.stringify(rows);
}

/** The output against the input: only the figures changed, and only by what the plan said. */
export function verifyCartonStockReset(input: ResetHandle, output: ResetHandle, plan: CartonResetPlan): CartonResetCheck[] {
  const others = tableNames(input).filter((table) => !PROJECTION_TABLES.has(table));
  const changed = others.filter((table) => tableHash(input, table) !== tableHash(output, table));
  const inStoreLeft = count(output, "SELECT COUNT(1) AS n FROM stock_projection_by_location WHERE location_type = ? AND quantity_on_hand <> 0", IN_STORE_LOCATION_TYPE);
  const after = new Map(plan.variants.map((variant) => [variant.variantId, variant.variantAfter]));
  const totalsOf = (db: ResetHandle) => db.prepare("SELECT product_variant_id AS id, quantity_on_hand AS n FROM stock_projection_by_variant ORDER BY 1").all() as Row[];
  const expected = totalsOf(input).map((row) => ({ id: row.id, n: after.get(String(row.id)) ?? row.n }));
  const totalsRight = JSON.stringify(expected) === JSON.stringify(totalsOf(output));
  return [
    { name: "Every other table", ok: changed.length === 0, detail: changed.join(", ") || `${others.length} tables identical, row for row` },
    { name: "Store figures", ok: inStoreLeft === 0, detail: inStoreLeft === 0 ? "all at zero" : `${inStoreLeft} row(s) not at zero` },
    { name: "Other locations", ok: otherFigureRows(input) === otherFigureRows(output), detail: "factory and gate figures unchanged" },
    { name: "Product totals", ok: totalsRight, detail: totalsRight ? `${plan.variants.length} fell by exactly what the store held, the rest unchanged` : "a product total is not what the plan said" },
  ];
}
