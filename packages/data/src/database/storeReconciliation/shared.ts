// ONE-TIME STORE RECONCILIATION — shared types and readers (docs/39).
//
// Two copies of one database ran apart: PC2 and PC3 both kept working on the raw-material store after
// PC3 was made by copying PC2's file. PC3 continues. This brings what only PC2 holds into a COPY of
// PC3's database, keeping every ID, time and user as recorded, and changes only what the reviewed
// plan says must change: numbers that collide, and a recipient recorded by mistake.
//
// It is not part of the app. scripts/reconcile-pc2-pc3.mjs runs it on copies, and the owner swaps the
// result in. It writes tables directly rather than through the scan use cases, because those always
// stamp "now" and the history must keep its real dates. verify.ts stands in for their validation.

import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
import { NUMBER_BLOCK_SETTING_KEY, NUMBER_SITES, numberExpression, rangeForBlock, type NumberSiteKey } from "../numberRange.js";

export type Row = Record<string, SQLOutputValue>;

/** Refused before anything was written. Every reason found is listed, not just the first. */
export class ReconciliationRefused extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(`Reconciliation refused, nothing written:\n  - ${reasons.join("\n  - ")}`);
    this.name = "ReconciliationRefused";
  }
}

/** What the reviewed plan says the source holds. Any other figure stops the run. */
export interface ExpectedCounts {
  readonly materials: number;
  readonly materialValues: number;
  readonly materialAudits: number;
  readonly runs: number;
  readonly packets: number;
  readonly storeIns: number;
  readonly storeOuts: number;
  readonly duplicateStoreOuts: number;
  readonly receives: number;
  readonly transfersOut: number;
  readonly staleSessions: number;
}

/** The owner's decisions, as reviewed. The script supplies the real ones; tests supply their own. */
export interface ReconciliationDecisions {
  /** Both files must be at exactly this migration: the script writes that schema and no other. */
  readonly schemaVersion: string;
  /** The computer whose records are brought across, and the one that continues. */
  readonly sourceDeviceId: string;
  readonly targetDeviceId: string;
  /** Source store-in sessions brought across whole, by number. */
  readonly receivingSessions: readonly number[];
  /** Source store-out sessions whose scans of packets only the source knows are brought across. */
  readonly issueSessions: readonly number[];
  /** Source store-out sessions left behind. Each must hold no scans. */
  readonly emptyIssueSessions: readonly number[];
  /** Open on the target, closed on the source: closed on the target as the source closed them. */
  readonly staleReceivingSessions: readonly number[];
  readonly staleIssueSessions: readonly number[];
  /**
   * Who the store-outs went to. `recorded` is the party the source named by mistake (null when it
   * named the right one). Every brought store-out must name one of the two, and is written to `actual`.
   */
  readonly recipient: { readonly recorded: string | null; readonly actual: string };
  /** Tables whose source-only rows are not business records (login sessions) and stay behind. */
  readonly ignoredTables: readonly string[];
  readonly expected: ExpectedCounts;
}

export const TABLE = {
  ITEMS: "inventory_items",
  ITEM_VALUES: "inventory_item_values",
  ITEM_AUDIT: "inventory_item_audit",
  RUNS: "raw_material_qr_batches",
  PACKETS: "raw_material_qrs",
  PACKET_EVENTS: "raw_material_qr_events",
  COUNTERS: "raw_material_qr_sequences",
  STOCK_EVENTS: "inventory_stock_events",
  BALANCES: "inventory_stock_balances",
  RECEIVING: "raw_material_receiving_sessions",
  ISSUE: "raw_material_issue_sessions",
  AUDIT_LOG: "audit_log",
} as const;

/** A packet's scans and the stock movements they write, as the scan use cases record them. */
export const SCAN = { IN: "STORE_ENTRY", OUT: "STORE_EXIT" } as const;
export const MOVEMENT = { IN: "RECEIVE", OUT: "TRANSFER_OUT" } as const;
export const PACKET_ISSUED = "ISSUED";

/** The column that names a row in each table; `id` everywhere except the balance, keyed by material. */
export const keyColumn = (table: string): string => (table === TABLE.BALANCES ? "item_id" : "id");

export const all = (db: DatabaseSync, sql: string, ...params: SQLInputValue[]): Row[] => db.prepare(sql).all(...params);
export const one = (db: DatabaseSync, sql: string, ...params: SQLInputValue[]): Row | undefined => db.prepare(sql).get(...params);

export function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw new Error(`${column} is ${value === null ? "empty" : "not text"} where text was required.`);
  return value;
}

export function textOrNull(row: Row, column: string): string | null {
  const value = row[column];
  return typeof value === "string" ? value : null;
}

export function num(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error(`${column} is not a number.`);
}

/** Source rows whose key the target does not hold. */
export function sourceOnly(source: DatabaseSync, target: DatabaseSync, table: string): Row[] {
  const key = keyColumn(table);
  const held = new Set(all(target, `SELECT ${key} AS k FROM ${table}`).map((row) => String(row.k)));
  return all(source, `SELECT * FROM ${table}`).filter((row) => !held.has(String(row[key])));
}

export function tableNames(db: DatabaseSync): string[] {
  return all(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((row) => text(row, "name"));
}

export function columnNames(db: DatabaseSync, table: string): string[] {
  return all(db, `SELECT name FROM pragma_table_info('${table}')`).map((row) => text(row, "name"));
}

export function latestMigration(db: DatabaseSync): string | null {
  const row = one(db, "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1");
  return row ? text(row, "version") : null;
}

export function setting(db: DatabaseSync, key: string): string | null {
  const row = one(db, "SELECT setting_value FROM app_settings WHERE setting_key = ?", key);
  return row ? textOrNull(row, "setting_value") : null;
}

/** Inserts a row exactly as given, column for column. */
export function insertRow(db: DatabaseSync, table: string, row: Row): void {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .run(...columns.map((column) => row[column]));
}

// ─── Snapshot: what the target looked like before, so verify can prove nothing else moved ───

/** Every row of every table, by rowid, as JSON. Large but simple, and taken once. */
export type Snapshot = ReadonlyMap<string, ReadonlyMap<number, string>>;

export function takeSnapshot(db: DatabaseSync): Snapshot {
  const snapshot = new Map<string, Map<number, string>>();
  for (const table of tableNames(db)) {
    const rows = new Map<number, string>();
    for (const row of all(db, `SELECT rowid AS __rowid, * FROM ${table}`)) {
      const { __rowid: rowid, ...rest } = row;
      rows.set(Number(rowid), stableJson(rest));
    }
    snapshot.set(table, rows);
  }
  return snapshot;
}

export function stableJson(row: Row): string {
  return JSON.stringify(row, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
}

/**
 * The number the app would hand out next at one site: the same query as allocateNumberInRange
 * (numberRange.ts) — the highest number in this computer's block, plus one, whichever computer
 * wrote it. Read from the target, so a renumbered record takes the next number the target owns.
 */
export function nextFreeNumber(db: DatabaseSync, key: NumberSiteKey): number {
  const block = Number(setting(db, NUMBER_BLOCK_SETTING_KEY));
  if (!Number.isInteger(block) || block < 1) throw new Error("The target has no valid number block.");
  const range = rangeForBlock(block);
  const site = NUMBER_SITES[key];
  const expression = numberExpression(site);
  const filter = "where" in site ? ` AND ${site.where}` : "";
  const row = one(db, `SELECT COALESCE(MAX(${expression}), ?) + 1 AS n FROM ${site.table} WHERE ${expression} BETWEEN ? AND ?${filter}`, range.lo - 1, range.lo, range.hi);
  const next = row ? num(row, "n") : range.lo;
  if (next > range.hi) throw new Error(`The target's ${site.noun} are used up.`);
  return next;
}

/** Reads a scan's recipient out of its metadata, or null when it names none. */
export function recipientOf(metadataJson: string | null): string | null {
  if (metadataJson === null) return null;
  const parsed: unknown = JSON.parse(metadataJson);
  if (typeof parsed !== "object" || parsed === null) return null;
  const value: unknown = (parsed as { issuedToPartyId?: unknown }).issuedToPartyId;
  return typeof value === "string" ? value : null;
}

/** The same metadata naming another recipient. Every other key, and their order, is kept. */
export function withRecipient(metadataJson: string, partyId: string): string {
  const parsed: unknown = JSON.parse(metadataJson);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Scan metadata is not an object.");
  return JSON.stringify({ ...parsed, issuedToPartyId: partyId });
}
