// CLEARING LOCAL CARTON QR TEST DATA, FROM ONE DISPOSABLE DATABASE (docs/42 section 15).
//
// The owner's decision (2026-11-07): local carton QR activity was test activity, and goes as though it
// never happened. Production's log holds no QR_MASTER or PRODUCTION_PRODUCED row, so nothing replays it.
//
// WHAT GOES. Carton QR identities, codes and journeys, their dispatch and store sessions, the carton
// figures they moved, the QR-derived earnings they gave contractors, and their queued sync rows. And four
// named test documents: gatepasses 1 and 2, sale vouchers 1 and 2, checked by identity, never by id alone.
//
// WHAT STAYS. Raw material, machine programs and their closures, the labels tied to raw material exits,
// Manual Production, contractors, cash vouchers, claims, qr_sequences (reset, a new label could reuse a
// code), and everything else. The check step proves it by hashing every other table, input against output.
//
// A LABEL KEEPS ITS RUN. machine_program_carton_labels has a foreign key to qr_batches and the labels stay,
// so the runs they name stay too, with no codes under them. A run with no codes earns nobody anything.
//
// IT STOPS, CHANGING NOTHING, at a payment or claim on a contractor whose earnings would go, at a record
// that is not the one the owner named, at carton movements (those are shared), and at anything else tied to
// this QR data. It only ever applies to the rehearsal databases below. No network: this reads and writes
// the one file it is given, on a copy.

import { createHash } from "node:crypto";

/** The only databases this may change. PC2, PC3 and any other computer can be planned against, never cleared. */
export const DISPOSABLE_DEVICE_IDS: ReadonlySet<string> = new Set([
  "dev-gate-holder",
  "9f4c61aa-f8b3-49ae-bf2e-ad441aaffecb",
  // The development computer's own database, C:\erp-devtest (owner, 2026-11-07). Never PC2 or PC3.
  "3bf91a55-8e86-4d82-86e7-21ef1df794c5",
]);

const TEST_PARTY = "MAMA CHAPPAL KARACHI";
const TEST_DATE = "2026-10-06";
const TEST_GATEPASSES: ReadonlyArray<{ number: number; status: string }> = [
  { number: 1, status: "BILLED" },
  { number: 2, status: "AT_GATE" },
];
const TEST_VOUCHERS: ReadonlyArray<{ number: string; status: string }> = [
  { number: "1", status: "DRAFT" },
  { number: "2", status: "DRAFT" },
];

const QR_OUTBOX_TYPES = ["QR_MASTER", "PRODUCTION_PRODUCED", "PRODUCTION_EVENT", "DISPATCH_EVENT"];
const QR_OUTBOX_SQL = QR_OUTBOX_TYPES.map((type) => `'${type}'`).join(", ");
const QR_PARKED_SQL = "dedupe_key LIKE 'QR_MASTER:%' OR dedupe_key LIKE 'PRODUCTION_PRODUCED:%'";
/** Runs the kept labels name: their row must stay, for the labels' foreign key. */
const KEPT_RUN_SQL = "id IN (SELECT qr_batch_id FROM machine_program_carton_labels)";

/** Whole tables cleared, children before parents. Absent tables are skipped: older databases lack some. */
const CLEARED_TABLES = [
  "machine_program_b_conversions",
  "machine_program_upper_b_labels",
  "machine_program_fix_carton_labels",
  "machine_program_line_carton_labels",
  "production_events",
  "qr_master",
  "qr_codes",
  "store_receiving_sessions",
  "store_move_out_sessions",
  "stock_projection_by_location",
  "stock_projection_by_variant",
];

/** Tables where only named rows go. `kept` is what must stay, identical, in the output. */
const PARTLY_CLEARED: ReadonlyArray<{ table: string; kept: string }> = [
  { table: "qr_batches", kept: KEPT_RUN_SQL },
  { table: "sync_outbox", kept: `aggregate_type NOT IN (${QR_OUTBOX_SQL})` },
  { table: "sync_inbox_parked", kept: `NOT (${QR_PARKED_SQL})` },
];

type Row = Record<string, unknown>;

export interface CleanupHandle {
  prepare(sql: string): {
    all(...params: Array<string | number>): unknown[];
    get(...params: Array<string | number>): unknown;
    run(...params: Array<string | number>): unknown;
  };
  exec(sql: string): void;
}

export interface TestRecords {
  readonly gatepassIds: readonly string[];
  readonly voucherIds: readonly string[];
  readonly sessionIds: readonly string[];
  readonly notificationIds: readonly string[];
}

export interface PaymentDependency {
  readonly kind: "CASH_VOUCHER" | "CLAIM";
  readonly id: string;
  readonly number: string;
  readonly contractor: string;
  readonly amountPaisa: number;
}

export interface CleanupPlan {
  readonly deviceId: string | null;
  readonly refusals: readonly string[];
  /** Rows that would go, per table. */
  readonly removes: Readonly<Record<string, number>>;
  readonly records: TestRecords;
  readonly earnings: { readonly cartons: number; readonly programs: number; readonly contractors: readonly string[] };
  readonly payments: readonly PaymentDependency[];
  readonly kept: Readonly<Record<string, number>>;
}

export interface CleanupCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const tableExists = (db: CleanupHandle, table: string): boolean =>
  db.prepare("SELECT 1 AS here FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;

const count = (db: CleanupHandle, table: string, where = "1 = 1"): number =>
  tableExists(db, table) ? Number((db.prepare(`SELECT COUNT(1) AS n FROM "${table}" WHERE ${where}`).get() as Row).n) : 0;

const placeholders = (values: readonly unknown[]): string => values.map(() => "?").join(", ");
const ids = (rows: unknown[]): string[] => (rows as Row[]).map((row) => String(row.id));

const EARNED_SQL = `
  FROM (SELECT program_id, qr_batch_id FROM machine_program_carton_labels
        UNION SELECT program_id, qr_batch_id FROM machine_program_fix_carton_labels
        UNION SELECT machine_program_id, id FROM qr_batches WHERE machine_program_id IS NOT NULL) pb
  JOIN machine_programs mp ON mp.id = pb.program_id
  JOIN qr_batches qb ON qb.id = pb.qr_batch_id
  JOIN qr_codes qc ON qc.batch_id = qb.id
  WHERE qb.grade IS NULL AND EXISTS (
    SELECT 1 FROM production_events pe WHERE pe.qr_id = qc.id AND pe.event_type = 'MOVED'
      AND json_extract(pe.metadata_json, '$.eventType') = 'STORE_ENTRY')`;

function readEarnings(db: CleanupHandle): CleanupPlan["earnings"] & { contractorIds: string[] } {
  if (!tableExists(db, "machine_programs") || !tableExists(db, "machine_program_fix_carton_labels")) {
    return { cartons: 0, programs: 0, contractors: [], contractorIds: [] };
  }
  const totals = db.prepare(`SELECT COUNT(1) AS cartons, COUNT(DISTINCT pb.program_id) AS programs ${EARNED_SQL}`).get() as Row;
  const contractors = db.prepare(
    `SELECT p.id, p.party_name FROM parties p WHERE p.id IN (
       SELECT mp.contractor_party_id ${EARNED_SQL} UNION SELECT mp.packing_contractor_party_id ${EARNED_SQL})
     ORDER BY p.party_name`
  ).all() as Row[];
  return {
    cartons: Number(totals.cartons),
    programs: Number(totals.programs),
    contractors: contractors.map((row) => String(row.party_name)),
    contractorIds: contractors.map((row) => String(row.id)),
  };
}

/** Any payment or claim on a contractor whose QR earnings would go. Never touched: its presence stops the run. */
function readPayments(db: CleanupHandle, contractorIds: readonly string[]): PaymentDependency[] {
  if (contractorIds.length === 0) return [];
  const list = placeholders(contractorIds);
  const vouchers = db.prepare(
    `SELECT cv.id, cv.voucher_number, p.party_name, COALESCE(l.payment_amount_paisa, cv.payment_amount_paisa, 0) AS amount
       FROM cash_vouchers cv
       LEFT JOIN cash_voucher_lines l ON l.voucher_id = cv.id
       JOIN parties p ON p.id = COALESCE(l.party_id, cv.party_id)
      WHERE cv.deleted_at IS NULL AND p.id IN (${list})
      ORDER BY cv.voucher_number`
  ).all(...contractorIds) as Row[];
  const claims = db.prepare(
    `SELECT c.id, c.claim_number, p.party_name, c.amount_paisa AS amount
       FROM party_claims c JOIN parties p ON p.id = c.party_id WHERE p.id IN (${list})`
  ).all(...contractorIds) as Row[];
  return [
    ...vouchers.map((row): PaymentDependency => ({ kind: "CASH_VOUCHER", id: String(row.id), number: String(row.voucher_number), contractor: String(row.party_name), amountPaisa: Number(row.amount) })),
    ...claims.map((row): PaymentDependency => ({ kind: "CLAIM", id: String(row.id), number: String(row.claim_number), contractor: String(row.party_name), amountPaisa: Number(row.amount) })),
  ];
}

/** The named gatepasses, found by number and proved by identity. Anything else under that number stops the run. */
function readGatepasses(db: CleanupHandle, refusals: string[]): string[] {
  if (!tableExists(db, "gatepasses")) return [];
  const found: string[] = [];
  for (const expected of TEST_GATEPASSES) {
    const row = db.prepare(
      `SELECT g.id, g.status, g.created_at, p.party_name FROM gatepasses g LEFT JOIN parties p ON p.id = g.party_id WHERE g.gatepass_number = ?`
    ).get(expected.number) as Row | undefined;
    if (!row) continue;
    const same = row.status === expected.status && row.party_name === TEST_PARTY && String(row.created_at).startsWith(TEST_DATE);
    if (same) found.push(String(row.id));
    else refusals.push(`Gatepass ${expected.number} here is ${String(row.status)}, ${String(row.created_at).slice(0, 10)}, ${String(row.party_name)}: not the test record named. It was not touched.`);
  }
  return found;
}

function readVouchers(db: CleanupHandle, refusals: string[]): string[] {
  if (!tableExists(db, "sale_vouchers")) return [];
  const found: string[] = [];
  for (const expected of TEST_VOUCHERS) {
    const row = db.prepare(
      `SELECT v.id, v.status, v.created_at, p.party_name FROM sale_vouchers v LEFT JOIN parties p ON p.id = v.party_id WHERE v.voucher_number = ?`
    ).get(expected.number) as Row | undefined;
    if (!row) continue;
    const same = row.status === expected.status && row.party_name === TEST_PARTY && String(row.created_at).startsWith(TEST_DATE);
    if (same) found.push(String(row.id));
    else refusals.push(`Sale voucher ${expected.number} here is ${String(row.status)}, ${String(row.created_at).slice(0, 10)}, ${String(row.party_name)}: not the test record named. It was not touched.`);
  }
  return found;
}

function readRecords(db: CleanupHandle, refusals: string[]): TestRecords {
  const gatepassIds = readGatepasses(db, refusals);
  const voucherIds = readVouchers(db, refusals);
  const sessionIds = voucherIds.length === 0 ? [] : ids(db.prepare(`SELECT id FROM dispatch_sessions WHERE voucher_id IN (${placeholders(voucherIds)})`).all(...voucherIds));
  const named = [...gatepassIds, ...voucherIds];
  const notificationIds = named.length === 0 ? [] : ids(db.prepare(`SELECT id FROM user_notifications WHERE entity_id IN (${placeholders(named)})`).all(...named));
  return { gatepassIds, voucherIds, sessionIds, notificationIds };
}

/** Anything still tied to the QR data that the owner did not name stops the run. */
function dependencyRefusals(db: CleanupHandle, records: TestRecords, refusals: string[]): void {
  const movements = count(db, "carton_stock_events");
  if (movements > 0) refusals.push(`${movements} carton movement(s) are recorded here. They are shared with other computers and are not test data.`);
  const notIn = (column: string, values: readonly string[]) => (values.length === 0 ? "1 = 1" : `${column} NOT IN (${values.map((value) => `'${value}'`).join(", ")})`);
  const otherGatepasses = count(db, "gatepasses", notIn("id", records.gatepassIds));
  if (otherGatepasses > 0) refusals.push(`${otherGatepasses} other gatepass(es) are here. The owner named only two. Nothing was touched.`);
  const otherVouchers = count(db, "sale_vouchers", notIn("id", records.voucherIds));
  if (otherVouchers > 0) refusals.push(`${otherVouchers} other sale voucher(s) are here. The owner named only two. Nothing was touched.`);
  const otherSessions = count(db, "dispatch_sessions", notIn("id", records.sessionIds));
  if (otherSessions > 0) refusals.push(`${otherSessions} other dispatch session(s) are here.`);
  const returns = count(db, "sale_returns");
  if (returns > 0) refusals.push(`${returns} sale return(s) are here, and a return credits a customer. Look at them first.`);
  const proofs = count(db, "gatepass_delivery_proofs");
  if (proofs > 0) refusals.push(`${proofs} delivery proof(s) are here, with photos on disk. Look at them first.`);
}

function plannedRemovals(db: CleanupHandle, records: TestRecords): Record<string, number> {
  const removes: Record<string, number> = {};
  for (const table of CLEARED_TABLES) removes[table] = count(db, table);
  for (const { table, kept } of PARTLY_CLEARED) removes[table] = count(db, table) - count(db, table, kept);
  removes.dispatch_sessions = records.sessionIds.length;
  removes.gatepasses = records.gatepassIds.length;
  removes.gatepass_lines = records.gatepassIds.length === 0 ? 0 : count(db, "gatepass_lines", `gatepass_id IN (${records.gatepassIds.map((id) => `'${id}'`).join(", ")})`);
  removes.sale_vouchers = records.voucherIds.length;
  removes.sale_voucher_line_items = records.voucherIds.length === 0 ? 0 : count(db, "sale_voucher_line_items", `voucher_id IN (${records.voucherIds.map((id) => `'${id}'`).join(", ")})`);
  removes.user_notifications = records.notificationIds.length;
  return removes;
}

const deviceOf = (db: CleanupHandle): string | null => {
  const row = db.prepare("SELECT setting_value AS v FROM app_settings WHERE setting_key = 'device.id'").get() as Row | undefined;
  return row ? String(row.v) : null;
};

/** What the cleanup would do, and everything that stops it. Reads only. */
export function planCartonQrCleanup(db: CleanupHandle): CleanupPlan {
  const refusals: string[] = [];
  const records = readRecords(db, refusals);
  dependencyRefusals(db, records, refusals);
  const { contractorIds, ...earnings } = readEarnings(db);
  const payments = readPayments(db, contractorIds);
  for (const payment of payments) {
    refusals.push(`${payment.kind} ${payment.number} (${payment.id}) on ${payment.contractor}, ${payment.amountPaisa} paisa, is tied to contractor earnings that would go. Nothing was touched.`);
  }
  return {
    deviceId: deviceOf(db),
    refusals,
    removes: plannedRemovals(db, records),
    records,
    earnings,
    payments,
    kept: {
      machine_program_carton_labels: count(db, "machine_program_carton_labels"),
      qr_batches_named_by_labels: count(db, "qr_batches", KEPT_RUN_SQL),
      machine_program_closures: count(db, "machine_program_closures"),
      machine_programs: count(db, "machine_programs"),
      qr_sequences: count(db, "qr_sequences"),
      manual_production_entries: count(db, "manual_production_entries"),
      inventory_stock_balances: count(db, "inventory_stock_balances"),
      inventory_stock_events: count(db, "inventory_stock_events"),
      raw_material_qrs: count(db, "raw_material_qrs"),
      raw_material_qr_events: count(db, "raw_material_qr_events"),
      cash_vouchers: count(db, "cash_vouchers"),
      party_claims: count(db, "party_claims"),
    },
  };
}

function deleteRows(db: CleanupHandle, table: string, column: string, values: readonly string[]): void {
  if (values.length === 0 || !tableExists(db, table)) return;
  db.prepare(`DELETE FROM "${table}" WHERE "${column}" IN (${placeholders(values)})`).run(...values);
}

function clearTestRecords(db: CleanupHandle, records: TestRecords): void {
  deleteRows(db, "user_notifications", "id", records.notificationIds);
  deleteRows(db, "dispatch_sessions", "id", records.sessionIds);
  deleteRows(db, "sale_voucher_line_items", "voucher_id", records.voucherIds);
  deleteRows(db, "sale_vouchers", "id", records.voucherIds);
  deleteRows(db, "gatepass_lines", "gatepass_id", records.gatepassIds);
  deleteRows(db, "gatepasses", "id", records.gatepassIds);
}

/**
 * Clears the data, in one transaction, children before parents, under foreign keys. Refuses, changing
 * nothing, unless this is a disposable database and nothing stops it. A second run clears nothing.
 */
export function applyCartonQrCleanup(db: CleanupHandle): CleanupPlan {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("BEGIN IMMEDIATE");
  try {
    const plan = planCartonQrCleanup(db);
    if (plan.deviceId === null || !DISPOSABLE_DEVICE_IDS.has(plan.deviceId)) {
      throw new Error(`REFUSED, nothing changed:\n  - This database belongs to device ${String(plan.deviceId)}, which is not a disposable rehearsal database.`);
    }
    if (plan.refusals.length > 0) throw new Error(`REFUSED, nothing changed:\n  - ${plan.refusals.join("\n  - ")}`);
    // Capture off, in this transaction: clearing this computer's test data is not a change for any other computer.
    const capture = tableExists(db, "sync_capture");
    if (capture) db.exec("UPDATE sync_capture SET suppressed = 1 WHERE id = 1");
    // Events first: they name the sessions, gatepasses and cartons below them.
    for (const table of CLEARED_TABLES.slice(0, 5)) if (tableExists(db, table)) db.exec(`DELETE FROM "${table}"`);
    clearTestRecords(db, plan.records);
    for (const table of CLEARED_TABLES.slice(5)) if (tableExists(db, table)) db.exec(`DELETE FROM "${table}"`);
    for (const { table, kept } of PARTLY_CLEARED) if (tableExists(db, table)) db.exec(`DELETE FROM "${table}" WHERE NOT (${kept})`);
    if (capture) db.exec("UPDATE sync_capture SET suppressed = 0 WHERE id = 1");
    db.exec("COMMIT");
    return plan;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const tableNames = (db: CleanupHandle): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Row[]).map((row) => String(row.name));

function tableHash(db: CleanupHandle, table: string, where = "1 = 1"): string {
  const hash = createHash("sha256");
  for (const row of db.prepare(`SELECT * FROM "${table}" WHERE ${where} ORDER BY rowid`).all() as Row[]) {
    hash.update(JSON.stringify(row, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value)));
  }
  return hash.digest("hex");
}

function preservationChecks(input: CleanupHandle, output: CleanupHandle, plan: CleanupPlan): CleanupCheck[] {
  const changing = new Set([...CLEARED_TABLES, ...PARTLY_CLEARED.map((entry) => entry.table), "dispatch_sessions", "gatepasses", "gatepass_lines", "sale_vouchers", "sale_voucher_line_items", "user_notifications"]);
  const others = tableNames(input).filter((table) => !changing.has(table));
  const changed = others.filter((table) => tableHash(input, table) !== tableHash(output, table));
  const partly = PARTLY_CLEARED.filter(({ table, kept }) => tableExists(input, table) && tableHash(input, table, kept) !== tableHash(output, table, kept));
  const named = [...plan.records.gatepassIds, ...plan.records.voucherIds];
  const keptNotices = named.length === 0 ? "1 = 1" : `entity_id IS NULL OR entity_id NOT IN (${named.map((id) => `'${id}'`).join(", ")})`;
  const noticesSame = tableHash(input, "user_notifications", keptNotices) === tableHash(output, "user_notifications", keptNotices);
  return [
    { name: "Every other table", ok: changed.length === 0, detail: changed.join(", ") || `${others.length} tables identical, row for row, raw material, closures, labels, sequences and vouchers among them` },
    { name: "Rows kept in partly cleared tables", ok: partly.length === 0 && noticesSame, detail: partly.map((entry) => entry.table).join(", ") || "identical" },
  ];
}

function emptinessChecks(output: CleanupHandle): CleanupCheck[] {
  const left = CLEARED_TABLES.filter((table) => count(output, table) > 0);
  const outbox = count(output, "sync_outbox", `aggregate_type IN (${QR_OUTBOX_SQL})`);
  const parked = count(output, "sync_inbox_parked", QR_PARKED_SQL);
  const earned = readEarnings(output).cartons;
  const owed = count(output, "gatepasses") + count(output, "gatepass_lines") + count(output, "dispatch_sessions") + count(output, "sale_vouchers") + count(output, "sale_voucher_line_items");
  return [
    { name: "QR data and carton figures", ok: left.length === 0, detail: left.join(", ") || "all empty" },
    { name: "Queued and waiting QR events", ok: outbox + parked === 0, detail: `${outbox} queued, ${parked} waiting` },
    { name: "QR contractor earnings", ok: earned === 0, detail: `${earned} cartons earned` },
    { name: "Named documents and their lines", ok: owed === 0, detail: `${owed} rows left` },
  ];
}

/** Judged against the input: this answers for what the cleanup did, not for what was already wrong. */
function integrityChecks(input: CleanupHandle, output: CleanupHandle): CleanupCheck[] {
  const violations = (db: CleanupHandle) => db.prepare("PRAGMA foreign_key_check").all().length;
  const integrity = (db: CleanupHandle) => String((db.prepare("PRAGMA integrity_check").get() as Row).integrity_check);
  const before = violations(input);
  const after = violations(output);
  const inputWasSound = integrity(input) === "ok";
  return [
    { name: "Foreign keys", ok: after <= before, detail: `${after} violation(s), ${before} before` },
    { name: "Database integrity", ok: integrity(output) === "ok" || !inputWasSound, detail: inputWasSound ? integrity(output) : "the input was already not sound" },
  ];
}

/** The output against the input. Reads only. */
export function verifyCartonQrCleanup(input: CleanupHandle, output: CleanupHandle, plan: CleanupPlan): CleanupCheck[] {
  return [...emptinessChecks(output), ...preservationChecks(input, output, plan), ...integrityChecks(input, output)];
}
