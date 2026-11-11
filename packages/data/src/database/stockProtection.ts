// ABSOLUTE LOCAL STOCK DATA PROTECTION, AND THE CARTON CLOUD ACTIVATION (Carton Stock Cloud release; owner, 9 Nov 2026).
//
// Every stock record in a computer's local database is TEST DATA -- including what is made after this release is
// installed but before the factory goes live. None of it may ever reach the production cloud: not by a sync pass, a
// backfill, "send again", a retry, a lease-return resend, or a parked event put back in the queue.
//
// CARTON CLOUD IS OFF UNTIL IT IS ACTIVATED. Activation is a deliberate administrator's act (ipc/cartonCloud.ts), never
// automatic. Until then no stock record is queued, and any already in the queue is parked by the drain. At activation,
// in one transaction, this computer records its CUTOFF: the highest row number in each stock table. Every record at
// or below it -- everything made before activation -- is excluded for ever. Only records made after it may be sent.
// Row numbers, not clocks: a wrong clock cannot move a record across the line, and no timestamp is trusted for it.
//
// FAIL CLOSED. The activation is sealed (a hash of its fields) and names the device and the cloud project it was made
// for. Missing, unreadable, unsealed, for another device, or for another project (a computer moved from TEST to
// production): NOT ACTIVE, and every stock record is held back. Re-activating is refused; there is no way to move the
// cutoff, so nothing made before it can ever become sendable.
//
// WHAT IS STOCK HERE.
//   STOCK_RECORD_TYPES     carton movements and the documents that move or follow from cartons: Manual Production
//                          entries, gatepasses, bills, cash vouchers.
//   NEVER_SENT_TYPES       carton QR identities and production scans: never sent by this release at all.
//   NEVER_BACKFILLED_TYPES the above: no bulk path marks them. Raw material is not among them: its movements and
//                          labels travel exactly as in v0.4.6, live and by the backfill (owner: Raw Material is complete).
//
// What the cloud sends down is applied exactly as before: none of this is on the receiving path.

import crypto from "node:crypto";
import { IN_STORE_LOCATION_TYPE } from "@erp/application";
import { SYNC_AGGREGATE } from "./syncEvents.js";
import type { BuildHandle } from "./masterRecords.js";

export const CARTON_CLOUD_ACTIVATION_KEY = "cloud.cartonActivation";
const DEVICE_ID_KEY = "device.id";
/** Where @erp/sync records the cloud project this computer reads from (pullCursor.ts). */
const PULL_PROJECT_KEY = "sync.pull.project";

/** The lease domains that must each have a holder before carton work can be real (cloud migrations 011, 026, 028). */
export const CARTON_CLOUD_REQUIRED_DOMAINS = ["CARTON_STOCK", "SALES_DISPATCH", "ACCOUNTS"] as const;
/** How fresh the lease cache must be at activation: the pass refreshes it every minute or so. */
export const ACTIVATION_LEASE_MAX_AGE_MS = 15 * 60 * 1000;

/** The tables whose rows are stock records, by the aggregate type that sends them. */
const STOCK_TABLES = {
  [SYNC_AGGREGATE.MANUAL_PRODUCTION_ENTRY]: "manual_production_entries",
  [SYNC_AGGREGATE.GATEPASS]: "gatepasses",
  [SYNC_AGGREGATE.SALE_VOUCHER]: "sale_vouchers",
  [SYNC_AGGREGATE.CASH_VOUCHER]: "cash_vouchers",
  [SYNC_AGGREGATE.CARTON_STOCK_EVENT]: "carton_stock_events",
} as const satisfies Record<string, string>;
/**
 * Every table the cutoff covers: the stock tables, and sale returns -- a financial document that is not sent by this
 * release but must still be told apart from test data in customer balances (see "Test financial documents" below).
 */
const TABLE_NAMES: readonly string[] = [...Object.values(STOCK_TABLES), "sale_returns"];

/**
 * A Stock Adjustment document (docs/46) is stock too, but it is NOT a cutoff table: adding a table to TABLE_NAMES would
 * make every activation already made invalid (its cutoff has no entry for it, and its seal covers the list). Its table
 * only exists from local 107, after go-live, so it is judged by its movements instead: a document is local exactly
 * when one of the movements it made is (isLocalAdjustmentDocument).
 */
const DERIVED_STOCK_TYPES = [SYNC_AGGREGATE.CARTON_STOCK_ADJUSTMENT] as const;

export const STOCK_RECORD_TYPES: ReadonlySet<string> = new Set([...Object.keys(STOCK_TABLES), ...DERIVED_STOCK_TYPES]);
export const NEVER_SENT_TYPES: ReadonlySet<string> = new Set([SYNC_AGGREGATE.QR_MASTER, SYNC_AGGREGATE.PRODUCTION_PRODUCED]);
export const NEVER_BACKFILLED_TYPES: ReadonlySet<string> = new Set([...STOCK_RECORD_TYPES, ...NEVER_SENT_TYPES]);

export interface CartonCloudActivation {
  readonly version: 1;
  readonly activatedAt: string;
  readonly activatedBy: string;
  readonly deviceId: string;
  readonly projectKey: string;
  /** The highest row number in each stock table at activation. At or below it: excluded for ever. */
  readonly cutoff: Readonly<Record<string, number>>;
  readonly seal: string;
}

export type CartonCloudState =
  | { readonly state: "NOT_ACTIVATED" }
  | { readonly state: "ACTIVE"; readonly activation: CartonCloudActivation }
  | { readonly state: "INVALID"; readonly reason: string };

type Row = Record<string, unknown>;
const first = (db: BuildHandle, sql: string, ...args: Array<string | number>): Row | undefined => db.prepare(sql).all(...args)[0] as Row | undefined;
const setting = (db: BuildHandle, key: string): string | null => {
  const row = first(db, "SELECT setting_value FROM app_settings WHERE setting_key = ?", key);
  return row === undefined || row.setting_value === null ? null : String(row.setting_value);
};
const tableExists = (db: BuildHandle, table: string): boolean => first(db, "SELECT 1 AS here FROM sqlite_master WHERE type = 'table' AND name = ?", table) !== undefined;

/** The seal: a hash of every field, in a fixed order. Not a secret -- it proves the record was written whole by this code. */
function sealOf(fields: Omit<CartonCloudActivation, "seal">): string {
  const cutoff = TABLE_NAMES.map((table) => `${table}=${String(fields.cutoff[table])}`).join(",");
  const text = [fields.version, fields.activatedAt, fields.activatedBy, fields.deviceId, fields.projectKey, cutoff].join("|");
  return crypto.createHash("sha256").update(text).digest("hex");
}

const isWhole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Reads the activation record without trusting it. Anything short of whole, sealed and for this device and project is not active. */
function parseActivation(raw: string): CartonCloudActivation | string {
  let parsed: Partial<CartonCloudActivation>;
  try {
    parsed = JSON.parse(raw) as Partial<CartonCloudActivation>;
  } catch {
    return "the activation record is not readable";
  }
  if (parsed.version !== 1) return "the activation record has an unknown version";
  for (const key of ["activatedAt", "activatedBy", "deviceId", "projectKey", "seal"] as const) {
    if (typeof parsed[key] !== "string" || parsed[key] === "") return `the activation record has no ${key}`;
  }
  const cutoff = parsed.cutoff;
  if (typeof cutoff !== "object" || cutoff === null) return "the activation record has no cutoff";
  for (const table of TABLE_NAMES) {
    if (!isWhole((cutoff as Record<string, unknown>)[table])) return `the activation record has no cutoff for ${table}`;
  }
  const activation = parsed as CartonCloudActivation;
  if (sealOf(activation) !== activation.seal) return "the activation record's seal does not match: it was changed outside the application";
  return activation;
}

/** Whether Carton Cloud is active on this database. Fails closed: see the header. */
export function readCartonCloudState(db: BuildHandle): CartonCloudState {
  const raw = setting(db, CARTON_CLOUD_ACTIVATION_KEY);
  if (raw === null) return { state: "NOT_ACTIVATED" };
  const activation = parseActivation(raw);
  if (typeof activation === "string") return { state: "INVALID", reason: activation };
  if (activation.deviceId !== setting(db, DEVICE_ID_KEY)) return { state: "INVALID", reason: "the activation was made for another computer" };
  if (activation.projectKey !== setting(db, PULL_PROJECT_KEY)) {
    return { state: "INVALID", reason: "the activation was made for another cloud project than the one this computer syncs with" };
  }
  return { state: "ACTIVE", activation };
}

const activeCutoff = (db: BuildHandle): Readonly<Record<string, number>> | null => {
  const state = readCartonCloudState(db);
  return state.state === "ACTIVE" ? state.activation.cutoff : null;
};

/** True when stock records may be built at all: Carton Cloud is active. */
export const cartonCloudIsActive = (db: BuildHandle): boolean => activeCutoff(db) !== null;

/**
 * True when a stock record may never be sent: Carton Cloud is not active, or the record was here at activation. A
 * record no longer here counts as local unless the cloud has a revision of it (a deletion of something the cloud never
 * had is not news to send). A type that is not stock is never held back here.
 */
export function isLocalStockRecord(db: BuildHandle, type: string, recordId: string): boolean {
  if (type === SYNC_AGGREGATE.CARTON_STOCK_ADJUSTMENT) return isLocalAdjustmentDocument(db, recordId);
  const table = (STOCK_TABLES as Record<string, string>)[type];
  if (table === undefined) return false;
  const cutoff = activeCutoff(db);
  if (cutoff === null) return true;
  const inCloud = hasCloudPresence(db, type, recordId);
  const row = first(db, `SELECT rowid AS r FROM ${table} WHERE id = ?`, recordId);
  if (row === undefined) return !inCloud;
  // At or below the cutoff, a record is test data -- unless it came from the cloud: one received before this
  // computer was activated (another computer went live first) is real.
  return Number(row.r) <= Number(cutoff[table]) && !inCloud;
}

/**
 * True when the cloud has this record: a document with a revision here (received, or sent after activation -- a
 * record from before activation is never sent), or a carton movement received from the cloud.
 */
function hasCloudPresence(db: BuildHandle, type: string, recordId: string): boolean {
  if (type === SYNC_AGGREGATE.CARTON_STOCK_EVENT) {
    return first(db, "SELECT 1 AS here FROM carton_stock_events WHERE id = ? AND replicated_at IS NOT NULL", recordId) !== undefined;
  }
  return first(db, "SELECT 1 AS here FROM sync_record_revisions WHERE aggregate_type = ? AND record_id = ?", type, recordId) !== undefined;
}

/**
 * True when a Stock Adjustment document may never be sent: Carton Cloud is not active here, or a movement it made is
 * local. A document no longer here (never deleted, but read defensively) is local unless the cloud has it.
 */
function isLocalAdjustmentDocument(db: BuildHandle, documentId: string): boolean {
  if (activeCutoff(db) === null) return true;
  if (!tableExists(db, "carton_stock_adjustment_lines")) return true;
  const lines = db.prepare("SELECT carton_stock_event_id AS event FROM carton_stock_adjustment_lines WHERE adjustment_id = ?").all(documentId) as Row[];
  if (lines.length === 0) return !hasCloudPresence(db, SYNC_AGGREGATE.CARTON_STOCK_ADJUSTMENT, documentId);
  return lines.some((line) => isLocalStockRecord(db, SYNC_AGGREGATE.CARTON_STOCK_EVENT, String(line.event)));
}

/**
 * True when a carton movement may never be sent: it is local itself, or it belongs to a Manual Production entry or a
 * gatepass that is (a cancel made after activation of a test gatepass moves test stock).
 */
export function isLocalCartonMovement(db: BuildHandle, eventId: string): boolean {
  if (isLocalStockRecord(db, SYNC_AGGREGATE.CARTON_STOCK_EVENT, eventId)) return true;
  const row = first(db, "SELECT manual_production_entry_id AS entry, gatepass_id AS gatepass FROM carton_stock_events WHERE id = ?", eventId);
  if (row === undefined) return true;
  if (row.entry && isLocalStockRecord(db, SYNC_AGGREGATE.MANUAL_PRODUCTION_ENTRY, String(row.entry))) return true;
  if (row.gatepass && isLocalStockRecord(db, SYNC_AGGREGATE.GATEPASS, String(row.gatepass))) return true;
  return false;
}

export const LOCAL_STOCK_MESSAGE =
  "This is local test stock data from before Carton Cloud was activated on this computer. It is never sent to the cloud.";
/** The last_error a parked local stock event carries, so the Health page says why it is parked. */
export const LOCAL_STOCK_PARKED_ERROR = `LOCAL_STOCK_DATA: ${LOCAL_STOCK_MESSAGE}`;

/** Why one queued event may not be sent, or null when it may. For a parked event put back by hand. */
export function stockRefusalForOutboxRow(db: BuildHandle, outboxId: string): string | null {
  const row = first(db, "SELECT aggregate_type, aggregate_id FROM sync_outbox WHERE id = ?", outboxId);
  if (row === undefined) return null; // not here: the requeue itself says so
  const type = String(row.aggregate_type);
  const id = String(row.aggregate_id);
  if (NEVER_SENT_TYPES.has(type)) return LOCAL_STOCK_MESSAGE;
  if (type === SYNC_AGGREGATE.CARTON_STOCK_EVENT) return isLocalCartonMovement(db, id) ? LOCAL_STOCK_MESSAGE : null;
  return isLocalStockRecord(db, type, id) ? LOCAL_STOCK_MESSAGE : null;
}

/**
 * THE LAST GATE, run by the drain before every claim. A stock event waiting in the queue -- queued by an earlier
 * release, or put back by the lease-return resend -- is checked again, and one that may not be sent is parked
 * (DEAD_LETTER, LOCAL_STOCK_PARKED_ERROR) instead of being claimed. Parked, not deleted: visible on the Health page,
 * and the requeue refuses it. Returns how many were parked.
 */
export function parkLocalStockOutboxRows(db: BuildHandle, nowIso: string): number {
  const types = [...STOCK_RECORD_TYPES];
  const waiting = db
    .prepare(`SELECT id FROM sync_outbox WHERE status IN ('PENDING', 'FAILED') AND aggregate_type IN (${types.map(() => "?").join(", ")})`)
    .all(...types) as Array<{ id: string }>;
  if (waiting.length === 0) return 0;
  const park = db.prepare(
    `UPDATE sync_outbox SET status = 'DEAD_LETTER', last_error = ?, lock_token = NULL, updated_at = ?
      WHERE id = ? AND status IN ('PENDING', 'FAILED')`
  );
  let parked = 0;
  for (const { id } of waiting) {
    if (stockRefusalForOutboxRow(db, String(id)) === null) continue;
    parked += Number(park.run(LOCAL_STOCK_PARKED_ERROR, nowIso, String(id)).changes);
  }
  return parked;
}

// ─── Readiness and activation ───────────────────────────────────────────────

export interface CartonCloudLeaseView {
  readonly domain: string;
  readonly holderLabel: string | null;
  readonly heldHere: boolean;
}

export interface CartonCloudStatus {
  readonly state: CartonCloudState["state"];
  readonly invalidReason: string | null;
  readonly activation: Omit<CartonCloudActivation, "seal"> | null;
  /** Why activation would be refused now; empty when it may go ahead. */
  readonly problems: readonly string[];
  readonly projectKey: string | null;
  readonly leases: readonly CartonCloudLeaseView[];
  /** Stock records marked for the cloud that are held back: before activation, every one. */
  readonly localOnlyMarks: number;
  /** Queued stock events parked as local test data. */
  readonly parkedLocalStock: number;
}

function leaseViews(db: BuildHandle, projectKey: string | null, deviceId: string | null, nowMs: number): { leases: CartonCloudLeaseView[]; problems: string[] } {
  const problems: string[] = [];
  const leases: CartonCloudLeaseView[] = [];
  // Never read from the cloud: cartonCloudStatus gives that one reason, and activation is still refused. Adding "apply
  // cloud migrations 026-028" for each lease blamed the cloud for what is only this computer not having synced yet.
  if (projectKey === null) return { leases, problems };
  for (const domain of CARTON_CLOUD_REQUIRED_DOMAINS) {
    const row = first(db, "SELECT holder_device_id, holder_label, epoch, fetched_at FROM sync_domain_leases WHERE domain = ? AND project_key = ?", domain, projectKey);
    if (row === undefined) {
      problems.push(`The cloud has not reported the ${domain} lease. Apply cloud migrations 026-028, then sync.`);
      continue;
    }
    const held = row.holder_device_id !== null && Number(row.epoch) > 0;
    if (!held) problems.push(`Nobody holds the ${domain} lease yet. Assign it to the computer that does that work, then sync.`);
    const age = nowMs - Date.parse(String(row.fetched_at));
    if (!Number.isFinite(age) || age > ACTIVATION_LEASE_MAX_AGE_MS) problems.push(`The ${domain} lease was last read too long ago. Sync now, then activate.`);
    leases.push({ domain, holderLabel: held ? String(row.holder_label ?? row.holder_device_id) : null, heldHere: held && String(row.holder_device_id) === deviceId });
  }
  return { leases, problems };
}

const withoutSeal = (a: CartonCloudActivation): Omit<CartonCloudActivation, "seal"> => ({
  version: a.version, activatedAt: a.activatedAt, activatedBy: a.activatedBy, deviceId: a.deviceId, projectKey: a.projectKey, cutoff: a.cutoff,
});

const countOf = (db: BuildHandle, sql: string, ...args: Array<string | number>): number => Number(first(db, sql, ...args)?.n ?? 0);
const stockTypeList = (): string[] => [...STOCK_RECORD_TYPES];

/**
 * Cartons in this computer's store figure that no movement received from the cloud explains: test stock. Zero after
 * the carton fresh start (cartonStockReset.ts), and zero on a computer whose figure came only from the cloud.
 */
export function testCartonsInStoreFigure(db: BuildHandle): number {
  if (!tableExists(db, "stock_projection_by_location") || !tableExists(db, "carton_stock_events")) return 0;
  return countOf(
    db,
    `SELECT COALESCE(SUM(ABS(d)), 0) AS n FROM (
       SELECT product_variant_id, location_id, SUM(q) AS d FROM (
         SELECT product_variant_id, location_id, quantity_on_hand AS q FROM stock_projection_by_location WHERE location_type = ?
         UNION ALL
         SELECT product_variant_id, location_id, -balance_delta FROM carton_stock_events WHERE replicated_at IS NOT NULL AND location_type = ?
       ) GROUP BY product_variant_id, location_id)`,
    IN_STORE_LOCATION_TYPE,
    IN_STORE_LOCATION_TYPE
  );
}

/** Everything the activation screen shows. Reads only. */
export function cartonCloudStatus(db: BuildHandle, nowIso: string): CartonCloudStatus {
  const state = readCartonCloudState(db);
  const deviceId = setting(db, DEVICE_ID_KEY);
  const projectKey = setting(db, PULL_PROJECT_KEY);
  const { leases, problems } = leaseViews(db, projectKey, deviceId, Date.parse(nowIso));
  if (deviceId === null) problems.unshift("This computer has no device identity yet. Set up cloud sync first.");
  if (projectKey === null) problems.unshift("This computer has never read from the cloud. Set up cloud sync and sync once.");
  const testCartons = state.state === "NOT_ACTIVATED" ? testCartonsInStoreFigure(db) : 0;
  if (testCartons > 0) {
    problems.push(`The carton figure here still holds ${testCartons} test carton(s) that no cloud movement explains. Run the carton stock fresh start on this computer first.`);
  }
  if (state.state === "ACTIVE") problems.unshift("Carton Cloud is already active on this computer.");
  if (state.state === "INVALID") problems.unshift(`The activation on this computer is not valid (${state.reason}). Nothing is sent; see the release guide.`);
  const types = stockTypeList();
  const placeholders = types.map(() => "?").join(", ");
  return {
    state: state.state,
    invalidReason: state.state === "INVALID" ? state.reason : null,
    activation: state.state === "ACTIVE" ? withoutSeal(state.activation) : null,
    problems,
    projectKey,
    leases,
    localOnlyMarks: state.state === "ACTIVE" ? 0 : countOf(db, `SELECT COUNT(*) AS n FROM sync_dirty_records WHERE aggregate_type IN (${placeholders})`, ...types),
    parkedLocalStock: countOf(db, "SELECT COUNT(*) AS n FROM sync_outbox WHERE status = 'DEAD_LETTER' AND last_error = ?", LOCAL_STOCK_PARKED_ERROR),
  };
}

export type ActivationOutcome =
  | {
      readonly activated: true;
      readonly activation: CartonCloudActivation;
      /** Marks of records made before activation, retired: they can never be sent, so they no longer wait. */
      readonly retiredMarks: Readonly<Record<string, number>>;
      /** Queued stock events of records made before activation, parked. */
      readonly parked: number;
    }
  | { readonly activated: false; readonly problems: readonly string[] };

/**
 * ACTIVATES CARTON CLOUD ON THIS DATABASE, once. In one transaction: checks readiness again, records the cutoff,
 * retires every stock mark (all of them belong to records at or below it), and parks every queued stock event (the
 * drain's gate would park them anyway). Nothing is queued, and nothing made before this moment can ever be.
 */
export function activateCartonCloud(db: BuildHandle, input: { nowIso: string; activatedBy: string }): ActivationOutcome {
  db.exec("BEGIN IMMEDIATE");
  try {
    const status = cartonCloudStatus(db, input.nowIso);
    if (status.problems.length > 0) {
      db.exec("ROLLBACK");
      return { activated: false, problems: status.problems };
    }
    const cutoff: Record<string, number> = {};
    for (const table of TABLE_NAMES) {
      cutoff[table] = tableExists(db, table) ? countOf(db, `SELECT COALESCE(MAX(rowid), 0) AS n FROM ${table}`) : 0;
    }
    const fields = {
      version: 1 as const,
      activatedAt: input.nowIso,
      activatedBy: input.activatedBy,
      deviceId: String(setting(db, DEVICE_ID_KEY)),
      projectKey: String(status.projectKey),
      cutoff,
    };
    const activation: CartonCloudActivation = { ...fields, seal: sealOf(fields) };
    const written = db
      .prepare(
        `INSERT INTO app_settings (setting_key, setting_value, value_type, is_encrypted, updated_by, updated_at)
         VALUES (?, ?, 'json', 0, ?, ?) ON CONFLICT(setting_key) DO NOTHING`
      )
      .run(CARTON_CLOUD_ACTIVATION_KEY, JSON.stringify(activation), input.activatedBy, input.nowIso);
    if (Number(written.changes) !== 1) throw new Error("An activation record already exists; it is never replaced.");
    const retiredMarks: Record<string, number> = {};
    for (const type of stockTypeList()) {
      retiredMarks[type] = Number(db.prepare("DELETE FROM sync_dirty_records WHERE aggregate_type = ?").run(type).changes);
    }
    const parked = parkLocalStockOutboxRows(db, input.nowIso);
    db.exec("COMMIT");
    // From now on, balances leave out the documents made before this moment.
    installLiveDocumentViews(db);
    return { activated: true, activation, retiredMarks, parked };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// ─── Test financial documents (customer and contractor balances) ─────────────────
//
// Bills, cash vouchers, sale returns and Manual Production entries made before activation are test data: they are
// never sent, so after go-live they must not count in any balance either -- here or anywhere. Nothing is deleted: the
// rows stay, with their audit history, and the document lists still show them. Balances read them through LIVE
// VIEWS, temporary views on this connection holding only the documents made after the cutoff:
//
//   live_sale_vouchers, live_cash_vouchers, live_sale_returns, live_manual_production_entries
//
// Before activation the views hold everything, so nothing changes until go-live. The cutoff is read from the sealed
// record alone: a record that is sealed but for another device or project still says which rows here are test data.
// And a test document cannot be changed after activation (refuseTestFinancialDocument), so nobody records real money
// on a document that can never travel.

/** Each live view: its table, and the aggregate type under which the cloud has its records (null: never sent). */
const LIVE_VIEWS = {
  live_sale_vouchers: { table: "sale_vouchers", type: SYNC_AGGREGATE.SALE_VOUCHER },
  live_cash_vouchers: { table: "cash_vouchers", type: SYNC_AGGREGATE.CASH_VOUCHER },
  live_sale_returns: { table: "sale_returns", type: null },
  live_manual_production_entries: { table: "manual_production_entries", type: SYNC_AGGREGATE.MANUAL_PRODUCTION_ENTRY },
} as const;

/** The cutoff of a sealed activation record, whatever device or project it names; null when there is none. */
function sealedCutoff(db: BuildHandle): Readonly<Record<string, number>> | null {
  const raw = setting(db, CARTON_CLOUD_ACTIVATION_KEY);
  if (raw === null) return null;
  const activation = parseActivation(raw);
  return typeof activation === "string" ? null : activation.cutoff;
}

/**
 * Removes the live views from this connection. SQLite checks every view when a table is renamed, so code that changes
 * the schema of these tables on an open connection (only the migration runner does) drops them first; they are
 * installed again when the database opens.
 */
export function dropLiveDocumentViews(db: BuildHandle): void {
  for (const view of Object.keys(LIVE_VIEWS)) db.exec(`DROP VIEW IF EXISTS temp.${view}`);
}

/** (Re)creates the live views on this connection. Called on opening, and by activation. */
export function installLiveDocumentViews(db: BuildHandle): void {
  const cutoff = sealedCutoff(db);
  dropLiveDocumentViews(db);
  for (const [view, { table, type }] of Object.entries(LIVE_VIEWS)) {
    if (!tableExists(db, table)) continue;
    const line = Number(cutoff?.[table] ?? 0);
    // A whole number from the sealed record (parseActivation checked it), and constant type names: never other text.
    const after = `rowid > ${String(Number.isSafeInteger(line) ? line : 0)}`;
    // A document the cloud has is real however early it arrived (another computer went live first).
    const received = type === null ? "" : ` OR id IN (SELECT record_id FROM main.sync_record_revisions WHERE aggregate_type = '${type}')`;
    db.exec(`CREATE TEMP VIEW ${view} AS SELECT * FROM main.${table} WHERE ${after}${received}`);
  }
}

export type TestFinancialTable = "sale_vouchers" | "cash_vouchers" | "sale_returns";

/** The aggregate type a financial document travels as; null for one this release never sends. */
const SENT_AS: Readonly<Record<TestFinancialTable, string | null>> = {
  sale_vouchers: SYNC_AGGREGATE.SALE_VOUCHER,
  cash_vouchers: SYNC_AGGREGATE.CASH_VOUCHER,
  sale_returns: null,
};

/** Throws when a financial document was made before activation: test data, which may no longer be changed. */
export function refuseTestFinancialDocument(db: BuildHandle, table: TestFinancialTable, id: string, label: string): void {
  const cutoff = sealedCutoff(db);
  if (cutoff === null) return;
  const row = first(db, `SELECT rowid AS r FROM ${table} WHERE id = ?`, id);
  if (row === undefined) return;
  const type = SENT_AS[table];
  if (type !== null && hasCloudPresence(db, type, id)) return; // received from the cloud: real
  if (Number(row.r) <= Number(cutoff[table] ?? 0)) {
    throw new Error(`${label} was made before Carton Cloud went live on this computer. It is test data: it is kept for the record, counts in no balance, and cannot be changed. Nothing was changed.`);
  }
}
