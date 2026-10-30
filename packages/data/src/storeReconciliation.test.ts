// THE ONE-TIME PC2 -> PC3 STORE RECONCILIATION (docs/39), on a small copy of the incident.
//
// Two computers start from one database at migration 087 -- the schema both store PCs run -- and
// diverge the way PC2 and PC3 did: the source prints and receives on a new material whose code the
// target gives to another material, prints on from a shared material's counter, scans out packets the
// target already issued, records the wrong contractor, and closes sessions the target left open. The
// reconciliation must bring across exactly what the reviewed plan says, refuse anything else, and
// leave every other row of the target untouched.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { buildRawMaterialQrId } from "@erp/domain";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { allocateNumberInRange, reserveSerialRange, serialRangeForBlock } from "./database/numberRange.js";
import { applyReconciliation } from "./database/storeReconciliation/apply.js";
import { planReconciliation, type RunInfo } from "./database/storeReconciliation/plan.js";
import { ReconciliationRefused, type ReconciliationDecisions } from "./database/storeReconciliation/shared.js";
import { verifyReconciliation } from "./database/storeReconciliation/verify.js";

const SCHEMA = path.resolve(import.meta.dirname, "../src/local-schema.sql");
const MIGRATIONS = path.resolve(import.meta.dirname, "../../../migrations/sqlite");
const SOURCE_DEVICE = "device-pc2";
const TARGET_DEVICE = "device-pc3";
const T0 = "2026-10-20T08:00:00.000Z";
const RUN: RunInfo = { reconciliationId: "reconciliation-1", nowIso: "2026-10-28T10:00:00.000Z", actor: "test" };

const SUPPLIER = "p-supplier"; // PTY-000006
const WRONG = "p-wrong"; // PTY-000019, recorded by mistake
const RIGHT = "p-right"; // PTY-000008, who actually received
const DOZEN = "u-dozen";
const SHARED = "i-shared"; // RM-000010, on both
const NEW_ON_SOURCE = "i-source-new"; // RM-000011 on the source only
const NEW_ON_TARGET = "i-target-new"; // RM-000011 on the target only: another material

const DECISIONS: ReconciliationDecisions = {
  schemaVersion: "087_numbered_tables_origin_device",
  sourceDeviceId: SOURCE_DEVICE,
  targetDeviceId: TARGET_DEVICE,
  receivingSessions: [3],
  issueSessions: [3],
  emptyIssueSessions: [2],
  staleReceivingSessions: [2],
  staleIssueSessions: [1],
  recipient: { recorded: WRONG, actual: RIGHT },
  ignoredTables: ["user_sessions"],
  expected: {
    materials: 1, materialValues: 1, materialAudits: 1, runs: 2, packets: 4, storeIns: 4, storeOuts: 2,
    duplicateStoreOuts: 1, receives: 4, transfersOut: 2, staleSessions: 2,
  },
};

// ─── Writing fixture rows in the shapes the app writes ───────────────────────

type Values = Record<string, SQLInputValue>;

function put(db: DatabaseSync, table: string, row: Values): void {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...columns.map((c) => row[c]));
}

function material(db: DatabaseSync, id: string, code: string, colour: string): void {
  put(db, "inventory_items", { id, item_code: code, category_id: "c-upper", display_name: `UPPER — ${colour}`, signature_hash: `sig-${colour}`, default_unit_id: DOZEN, created_by: "op", created_at: T0, updated_at: T0 });
}

function labelRun(db: DatabaseSync, runId: string, item: string, token: string, from: number, to: number): void {
  put(db, "raw_material_qr_batches", { id: runId, party_id: SUPPLIER, item_id: item, start_sequence: from, end_sequence: to, quantity: to - from + 1, created_at: T0, created_by: "op" });
  for (let serial = from; serial <= to; serial += 1) {
    put(db, "raw_material_qrs", { id: `RM_6_${token}_${serial}`, batch_id: runId, party_id: SUPPLIER, item_id: item, sequence: serial, created_at: T0, updated_at: T0, packing_quantity: 2, packing_unit_id: DOZEN });
  }
  db.prepare(`INSERT INTO raw_material_qr_sequences (id, party_id, item_id, last_sequence, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(party_id, item_id) DO UPDATE SET last_sequence = excluded.last_sequence`).run(`seq-${runId}`, SUPPLIER, item, to, T0);
}

function session(db: DatabaseSync, kind: "in" | "out", id: string, number: number, device: string, closedAt: string | null): void {
  const row: Values = { id, session_number: number, device_id: device, started_by: "op", status: closedAt ? "CLOSED" : "OPEN", started_at: T0, closed_at: closedAt, created_at: T0, updated_at: closedAt ?? T0 };
  put(db, kind === "in" ? "raw_material_receiving_sessions" : "raw_material_issue_sessions", kind === "in" ? { ...row, party_id: SUPPLIER } : row);
}

/** One scan, its stock movement, the packet's new state and the balance -- as the scan use cases write them. */
function scan(db: DatabaseSync, kind: "in" | "out", qrId: string, sessionId: string, at: string, device: string, recipient: string | null = null): void {
  const packet = db.prepare("SELECT item_id, current_status FROM raw_material_qrs WHERE id = ?").get(qrId);
  const item = String(packet?.item_id);
  const next = kind === "in" ? "IN_STORE" : "ISSUED";
  put(db, "raw_material_qr_events", {
    id: `scan-${kind}-${qrId}-${device}`, qr_id: qrId, item_id: item, party_id: SUPPLIER, event_type: kind === "in" ? "STORE_ENTRY" : "STORE_EXIT",
    event_ts_local: at, event_date: at.slice(0, 10), factory_id: "factory-777", workstation_id: `ws-${device}`, device_id: device, actor: "op",
    session_id: sessionId, quantity: 2, unit_id: DOZEN, previous_status: String(packet?.current_status), new_status: next,
    item_display_name: "UPPER", metadata_json: JSON.stringify({ eventType: kind, actor: "op", sessionId, ...(recipient ? { issuedToPartyId: recipient } : {}) }), created_at: at,
  });
  put(db, "inventory_stock_events", {
    id: `move-${kind}-${qrId}-${device}`, item_id: item, event_type: kind === "in" ? "RECEIVE" : "TRANSFER_OUT", quantity: 2, unit_id: DOZEN,
    note: `${kind === "in" ? "Raw Material Input" : "Raw Material Output"} ${qrId}`, created_by: "op", created_at: at,
  });
  db.prepare("UPDATE raw_material_qrs SET current_status = ?, updated_at = ? WHERE id = ?").run(next, at, qrId);
  db.prepare(`INSERT INTO inventory_stock_balances (item_id, quantity_on_hand, unit_id, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(item_id) DO UPDATE SET quantity_on_hand = quantity_on_hand + excluded.quantity_on_hand, updated_at = excluded.updated_at`)
    .run(item, kind === "in" ? 2 : -2, DOZEN, at);
}

function setDevice(db: DatabaseSync, device: string): void {
  db.prepare("INSERT OR REPLACE INTO app_settings (setting_key, setting_value, value_type, is_encrypted, updated_by, updated_at) VALUES ('device.id', ?, 'string', 0, 'test', ?)").run(device, T0);
  db.prepare("INSERT OR REPLACE INTO app_settings (setting_key, setting_value, value_type, is_encrypted, updated_by, updated_at) VALUES ('numbering.block', '1', 'string', 0, 'test', ?)").run(T0);
}

// ─── The two computers ─────────────────────────────────────────────────────

/** What both held when the copy was made: a supplier's packets 1-4 received, packet 1 out in session 1 (left open). */
function shared(db: DatabaseSync): void {
  put(db, "parties", { id: SUPPLIER, party_code: "PTY-000006", party_name: "shehzad", party_type: "SUPPLIER", created_at: T0, updated_at: T0 });
  put(db, "parties", { id: WRONG, party_code: "PTY-000019", party_name: "asim", party_type: "CONTRACTOR", created_at: T0, updated_at: T0 });
  put(db, "parties", { id: RIGHT, party_code: "PTY-000008", party_name: "daniyal", party_type: "CONTRACTOR", created_at: T0, updated_at: T0 });
  put(db, "inventory_units", { id: DOZEN, code: "DOZEN", name: "Dozen", created_at: T0, updated_at: T0 });
  put(db, "inventory_categories", { id: "c-upper", category_code: "UPPER", name: "UPPER", created_at: T0, updated_at: T0 });
  put(db, "inventory_category_fields", { id: "f-colour", category_id: "c-upper", field_key: "color", label: "Colour", field_type: "TEXT", created_at: T0, updated_at: T0 });
  material(db, SHARED, "RM-000010", "BLACK GREY");
  labelRun(db, "run-shared-1", SHARED, "10", 1, 4);
  session(db, "in", "in-1", 1, SOURCE_DEVICE, T0);
  for (let serial = 1; serial <= 4; serial += 1) scan(db, "in", `RM_6_10_${serial}`, "in-1", T0, SOURCE_DEVICE);
  session(db, "in", "in-2", 2, SOURCE_DEVICE, null);
  session(db, "out", "out-1", 1, SOURCE_DEVICE, null);
  scan(db, "out", "RM_6_10_1", "out-1", "2026-10-20T09:00:00.000Z", SOURCE_DEVICE, RIGHT);
}

/** The source after the split: a new material, two runs, store-in 3, an empty store-out 2, store-out 3 to the wrong party. */
function sourceAfterSplit(db: DatabaseSync): void {
  db.prepare("UPDATE raw_material_receiving_sessions SET status = 'CLOSED', closed_at = ?, updated_at = ? WHERE id = 'in-2'").run("2026-10-21T05:00:00.000Z", "2026-10-21T05:00:00.000Z");
  db.prepare("UPDATE raw_material_issue_sessions SET status = 'CLOSED', closed_at = ?, updated_at = ? WHERE id = 'out-1'").run("2026-10-21T14:00:00.000Z", "2026-10-21T14:00:00.000Z");
  material(db, NEW_ON_SOURCE, "RM-000011", "BROWN ORANGE");
  put(db, "inventory_item_values", { id: "v-source-new", item_id: NEW_ON_SOURCE, field_id: "f-colour", text_value: "BROWN ORANGE" });
  put(db, "inventory_item_audit", { id: "a-source-new", item_id: NEW_ON_SOURCE, entity_type: "ITEM", entity_id: NEW_ON_SOURCE, action: "CREATE", changed_by: "op", created_at: T0 });
  labelRun(db, "run-shared-2", SHARED, "10", 5, 6);
  labelRun(db, "run-new", NEW_ON_SOURCE, "11", 1, 2);
  session(db, "in", "in-3", 3, SOURCE_DEVICE, "2026-10-21T07:00:00.000Z");
  for (const qr of ["RM_6_10_5", "RM_6_10_6", "RM_6_11_1", "RM_6_11_2"]) scan(db, "in", qr, "in-3", "2026-10-21T06:00:00.000Z", SOURCE_DEVICE);
  session(db, "out", "out-2", 2, SOURCE_DEVICE, "2026-10-21T14:29:00.000Z");
  session(db, "out", "out-3", 3, SOURCE_DEVICE, null);
  scan(db, "out", "RM_6_10_2", "out-3", "2026-10-21T14:30:00.000Z", SOURCE_DEVICE, WRONG); // the target issued it already
  scan(db, "out", "RM_6_10_5", "out-3", "2026-10-21T14:31:00.000Z", SOURCE_DEVICE, WRONG);
  scan(db, "out", "RM_6_11_1", "out-3", "2026-10-21T14:32:00.000Z", SOURCE_DEVICE, WRONG);
}

/** The target after the split: its own RM-000011, store-in 3, and store-outs 2 and 3 (packet 2 to the right party). */
function targetAfterSplit(db: DatabaseSync): void {
  material(db, NEW_ON_TARGET, "RM-000011", "PACKING THELLI");
  session(db, "in", "t-in-3", 3, TARGET_DEVICE, "2026-10-21T08:00:00.000Z");
  session(db, "out", "t-out-2", 2, TARGET_DEVICE, "2026-10-21T14:10:00.000Z");
  scan(db, "out", "RM_6_10_2", "t-out-2", "2026-10-21T14:05:00.000Z", TARGET_DEVICE, RIGHT);
  session(db, "out", "t-out-3", 3, TARGET_DEVICE, null);
}

interface Pair {
  readonly dir: string;
  readonly source: DatabaseSync;
  readonly target: DatabaseSync;
  readonly targetPath: string;
}

/** Builds the two diverged files at migration 087. `adjust` changes either before the test runs. */
function diverged(adjust: (source: DatabaseSync, target: DatabaseSync) => void = () => {}): Pair {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-reconcile-"));
  const released = path.join(dir, "migrations-087");
  fs.mkdirSync(released);
  for (const file of fs.readdirSync(MIGRATIONS)) {
    if (file.endsWith(".up.sql") && Number(file.slice(0, 3)) <= 87) fs.copyFileSync(path.join(MIGRATIONS, file), path.join(released, file));
  }
  const sourcePath = path.join(dir, "pc2.sqlite");
  const targetPath = path.join(dir, "pc3.sqlite");
  new SqliteDatabase({ dbPath: sourcePath, schemaPath: SCHEMA, migrationsDir: released, migrationDeviceId: SOURCE_DEVICE }).close();
  const base = new DatabaseSync(sourcePath);
  setDevice(base, SOURCE_DEVICE);
  shared(base);
  base.close();
  fs.copyFileSync(sourcePath, targetPath);
  const source = new DatabaseSync(sourcePath);
  const target = new DatabaseSync(targetPath);
  setDevice(target, TARGET_DEVICE);
  sourceAfterSplit(source);
  targetAfterSplit(target);
  adjust(source, target);
  return { dir, source, target, targetPath };
}

function close(pair: Pair): void {
  if (pair.source.isOpen) pair.source.close();
  if (pair.target.isOpen) pair.target.close();
  fs.rmSync(pair.dir, { recursive: true, force: true });
}

const value = (db: DatabaseSync, sql: string, ...params: SQLInputValue[]): unknown => Object.values(db.prepare(sql).get(...params) ?? {})[0];

function reconciled(pair: Pair): ReturnType<typeof verifyReconciliation> {
  const plan = planReconciliation(pair.source, pair.target, DECISIONS, RUN);
  applyReconciliation(pair.target, plan);
  return verifyReconciliation(pair.source, pair.target, plan);
}

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof ReconciliationRefused) return error.reasons.join("\n");
    throw error;
  }
  assert.fail("expected the reconciliation to be refused");
}

// ─── The tests ─────────────────────────────────────────────────────────────

test("brings across exactly the planned records, and every check passes", () => {
  const pair = diverged();
  try {
    const checks = reconciled(pair);
    assert.deepEqual(checks.filter((c) => !c.ok), [], JSON.stringify(checks, null, 2));
    assert.equal(checks.length, 10);
  } finally {
    close(pair);
  }
});

test("a renumbered material keeps its id and its printed labels; colliding sessions take the next numbers", () => {
  const pair = diverged();
  try {
    reconciled(pair);
    const t = pair.target;
    assert.equal(value(t, "SELECT item_code FROM inventory_items WHERE id = ?", NEW_ON_SOURCE), "RM-000012");
    assert.equal(value(t, "SELECT item_code FROM inventory_items WHERE id = ?", NEW_ON_TARGET), "RM-000011");
    assert.equal(value(t, "SELECT item_id FROM raw_material_qrs WHERE id = 'RM_6_11_1'"), NEW_ON_SOURCE);
    assert.equal(value(t, "SELECT session_number FROM raw_material_receiving_sessions WHERE id = 'in-3'"), 4);
    assert.equal(value(t, "SELECT session_number FROM raw_material_issue_sessions WHERE id = 'out-3'"), 4);
    assert.equal(value(t, "SELECT status FROM raw_material_issue_sessions WHERE id = 'out-3'"), "CLOSED");
    assert.equal(value(t, "SELECT closed_at FROM raw_material_issue_sessions WHERE id = 'out-3'"), "2026-10-21T14:32:00.000Z");
    assert.equal(value(t, "SELECT COUNT(*) FROM raw_material_issue_sessions WHERE id = 'out-2'"), 0, "the empty store-out is left behind");
    assert.equal(value(t, "SELECT event_ts_local FROM raw_material_qr_events WHERE id = 'scan-in-RM_6_11_1-device-pc2'"), "2026-10-21T06:00:00.000Z");
  } finally {
    close(pair);
  }
});

test("store-outs go to the actual recipient, and the duplicate store-out stays behind", () => {
  const pair = diverged();
  try {
    reconciled(pair);
    const t = pair.target;
    const recipient = (id: string): unknown => JSON.parse(String(value(t, "SELECT metadata_json FROM raw_material_qr_events WHERE id = ?", id))).issuedToPartyId;
    assert.equal(recipient("scan-out-RM_6_10_5-device-pc2"), RIGHT);
    assert.equal(recipient("scan-out-RM_6_11_1-device-pc2"), RIGHT);
    assert.equal(value(t, "SELECT COUNT(*) FROM raw_material_qr_events WHERE id = 'scan-out-RM_6_10_2-device-pc2'"), 0);
    assert.equal(value(t, "SELECT COUNT(*) FROM inventory_stock_events WHERE id = 'move-out-RM_6_10_2-device-pc2'"), 0);
    assert.equal(value(t, "SELECT current_status FROM raw_material_qrs WHERE id = 'RM_6_10_5'"), "ISSUED");
    assert.equal(value(t, "SELECT current_status FROM raw_material_qrs WHERE id = 'RM_6_10_6'"), "IN_STORE");
  } finally {
    close(pair);
  }
});

test("stock: the shared material and the new one end where their movements put them", () => {
  const pair = diverged();
  try {
    reconciled(pair);
    // Shared: 8 in, 2 out (both), 2 out (target) = 4; then +4 in, -2 out from the source = 6.
    assert.equal(value(pair.target, "SELECT quantity_on_hand FROM inventory_stock_balances WHERE item_id = ?", SHARED), 6);
    assert.equal(value(pair.target, "SELECT quantity_on_hand FROM inventory_stock_balances WHERE item_id = ?", NEW_ON_SOURCE), 2);
  } finally {
    close(pair);
  }
});

test("no label can be printed twice: the run counter, the new material's, and a guard on the target's own RM-000011", () => {
  const pair = diverged();
  try {
    reconciled(pair);
    const nextLabel = (item: string, code: string): string => {
      const last = Number(value(pair.target, "SELECT last_sequence FROM raw_material_qr_sequences WHERE party_id = ? AND item_id = ?", SUPPLIER, item) ?? 0);
      const { startSequence } = reserveSerialRange(serialRangeForBlock(1), last === 0 ? null : last, 1, "test");
      return buildRawMaterialQrId({ partyCode: "PTY-000006", itemCode: code, sequence: startSequence });
    };
    assert.equal(nextLabel(SHARED, "RM-000010"), "RM_6_10_7");
    assert.equal(nextLabel(NEW_ON_SOURCE, "RM-000012"), "RM_6_12_3");
    assert.equal(nextLabel(NEW_ON_TARGET, "RM-000011"), "RM_6_11_3", "without the guard this would print RM_6_11_1, a label already on a packet");
  } finally {
    close(pair);
  }
});

test("the app's own number allocator, run on the result, hands out numbers past everything brought across", () => {
  const pair = diverged();
  let app: SqliteDatabase | null = null;
  try {
    reconciled(pair);
    pair.target.close();
    app = new SqliteDatabase({ dbPath: pair.targetPath, schemaPath: SCHEMA, migrationsDir: path.join(pair.dir, "migrations-087"), migrationDeviceId: TARGET_DEVICE });
    assert.equal(allocateNumberInRange(app, "rmReceivingSession"), 5);
    assert.equal(allocateNumberInRange(app, "rmIssueSession"), 5);
    assert.equal(allocateNumberInRange(app, "inventoryItemCode"), 13);
  } finally {
    app?.close();
    close(pair);
  }
});

test("the stale sessions are closed when the source closed them, and nothing else on the target moves", () => {
  const pair = diverged();
  try {
    const before = value(pair.target, "SELECT COUNT(*) FROM raw_material_qr_events");
    reconciled(pair);
    assert.equal(value(pair.target, "SELECT closed_at FROM raw_material_receiving_sessions WHERE id = 'in-2'"), "2026-10-21T05:00:00.000Z");
    assert.equal(value(pair.target, "SELECT closed_at FROM raw_material_issue_sessions WHERE id = 'out-1'"), "2026-10-21T14:00:00.000Z");
    assert.equal(value(pair.target, "SELECT status FROM raw_material_issue_sessions WHERE id = 't-out-3'"), "OPEN", "the target's own open session is its own business");
    assert.equal(Number(value(pair.target, "SELECT COUNT(*) FROM raw_material_qr_events")), Number(before) + 6);
  } finally {
    close(pair);
  }
});

test("the checks catch what the plan did not do: an unrelated row changed, a brought packet altered", () => {
  const pair = diverged();
  try {
    const plan = planReconciliation(pair.source, pair.target, DECISIONS, RUN);
    applyReconciliation(pair.target, plan);
    pair.target.prepare("UPDATE parties SET party_name = 'changed' WHERE id = ?").run(WRONG);
    pair.target.prepare("UPDATE raw_material_qrs SET current_status = 'IN_STORE' WHERE id = 'RM_6_10_5'").run();
    const failed = verifyReconciliation(pair.source, pair.target, plan).filter((c) => !c.ok).map((c) => c.name);
    assert.deepEqual(failed, ["Every planned row written as planned", "Nothing else changed", "Packet states match their last scan"]);
  } finally {
    close(pair);
  }
});

test("refuses, writing nothing, when the target has printed for a shared material since the copy", () => {
  const pair = diverged((_source, target) => {
    target.prepare("UPDATE raw_material_qr_sequences SET last_sequence = 5 WHERE item_id = ?").run(SHARED);
  });
  try {
    assert.match(refusal(() => planReconciliation(pair.source, pair.target, DECISIONS, RUN)), /counter for .* has moved/);
    assert.equal(value(pair.target, "SELECT COUNT(*) FROM inventory_items WHERE id = ?", NEW_ON_SOURCE), 0);
  } finally {
    close(pair);
  }
});

test("refuses when the files are given the wrong way round", () => {
  const pair = diverged();
  try {
    assert.match(refusal(() => planReconciliation(pair.target, pair.source, DECISIONS, RUN)), /not the source computer's database/);
  } finally {
    close(pair);
  }
});

test("refuses a source-only record the plan does not account for", () => {
  const pair = diverged((source) => {
    put(source, "inventory_stock_events", { id: "move-typed", item_id: SHARED, event_type: "ADJUST", quantity: 1, unit_id: DOZEN, note: "typed", created_at: T0 });
  });
  try {
    assert.match(refusal(() => planReconciliation(pair.source, pair.target, DECISIONS, RUN)), /move-typed .* belongs to no scan/);
  } finally {
    close(pair);
  }
});

test("refuses to leave a duplicate store-out behind unless the target shows it issued to the actual recipient", () => {
  const pair = diverged((_source, target) => {
    target.prepare("UPDATE raw_material_qr_events SET metadata_json = ? WHERE id = 'scan-out-RM_6_10_2-device-pc3'").run(JSON.stringify({ issuedToPartyId: WRONG }));
  });
  try {
    assert.match(refusal(() => planReconciliation(pair.source, pair.target, DECISIONS, RUN)), /RM_6_10_2: the target shows it issued to another party/);
  } finally {
    close(pair);
  }
});

test("refuses when the counts differ from the reviewed plan", () => {
  const pair = diverged();
  try {
    const decisions = { ...DECISIONS, expected: { ...DECISIONS.expected, storeOuts: 3 } };
    assert.match(refusal(() => planReconciliation(pair.source, pair.target, decisions, RUN)), /expects 3 storeOuts, the files hold 2/);
  } finally {
    close(pair);
  }
});

test("a write that finds the target changed since planning rolls everything back", () => {
  const pair = diverged();
  try {
    const plan = planReconciliation(pair.source, pair.target, DECISIONS, RUN);
    pair.target.prepare("UPDATE inventory_stock_balances SET quantity_on_hand = 99 WHERE item_id = ?").run(SHARED);
    assert.throws(() => applyReconciliation(pair.target, plan), /no longer holds what the plan read/);
    assert.equal(value(pair.target, "SELECT COUNT(*) FROM inventory_items WHERE id = ?", NEW_ON_SOURCE), 0);
    assert.equal(value(pair.target, "SELECT COUNT(*) FROM audit_log WHERE id = ?", RUN.reconciliationId), 0);
  } finally {
    close(pair);
  }
});

test("running it a second time on the result finds nothing to bring and refuses", () => {
  const pair = diverged();
  try {
    reconciled(pair);
    assert.match(refusal(() => planReconciliation(pair.source, pair.target, DECISIONS, RUN)), /expects 1 materials, the files hold 0/);
  } finally {
    close(pair);
  }
});
