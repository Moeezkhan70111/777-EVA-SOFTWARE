import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase, buildLeasedRecordRevisions, buildStockEvents } from "@erp/data";
import type { SyncEnvelope } from "./contract.js";
import { writeOwnRecord } from "./leasedRecordContracts.js";
import { parkedSummary } from "./parking.js";
import { SyncPull } from "./pull.js";
import {
  RestoreRefused,
  applyRestore,
  readRestoreRecords,
  rehearseSending,
  restoreRefusals,
  tableCounts,
  verifyRestore,
  type MaterialToRestore,
  type RestoreRecords,
} from "./restoreRemovedMaterials.js";
import type { SyncChange, SyncPullTransport } from "./transport.js";

// REPAIR A, ON THE REAL SIX RECORDS (production, 4 and 5 Nov 2026).
//
// PC2 is built the way it happened: real capture and builders send the materials and movements, the
// old erase deletes them with their ledger, and the deletion goes out as revision 2. Then the repair,
// and everything after it through the real pull: a computer holding the deletions in its park, a
// new computer replaying the whole log, and the stock accounted for and removed the normal way.

const SCHEMA = path.resolve(import.meta.dirname, "../../data/src/local-schema.sql");
const RECORDS_FILE = path.resolve(import.meta.dirname, "../../../scripts/repair-a-records.json");
const NOW = "2026-11-06T09:00:00.000Z";
const NOW_MS = Date.parse(NOW);

const rawRecords = (): Record<string, unknown> => JSON.parse(fs.readFileSync(RECORDS_FILE, "utf8")) as Record<string, unknown>;
const RECORDS = readRestoreRecords(rawRecords());
const DEVICE = RECORDS.deviceId;

interface Pc {
  readonly db: SqliteDatabase;
  readonly close: () => void;
}

const run = (pc: Pc, sql: string, ...params: Array<string | number | null>) => pc.db.db.prepare(sql).run(...params);
const one = (pc: Pc, sql: string, ...params: string[]) => pc.db.db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
const number = (pc: Pc, sql: string, ...params: string[]) => Number(one(pc, sql, ...params)?.n);

/** What a material needs on any computer: its unit, category and fields travel as master data. */
function seedMasters(pc: Pc): void {
  const unit = String(RECORDS.materials[0]?.revision.body.row.default_unit_id);
  run(pc, "INSERT INTO inventory_units (id, code, name, created_at, updated_at) VALUES (?, 'KG', 'Kilogram', ?, ?)", unit, NOW, NOW);
  for (const material of RECORDS.materials) {
    const category = String(material.revision.body.row.category_id);
    run(pc, "INSERT OR IGNORE INTO inventory_categories (id, category_code, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", category, category, category, NOW, NOW);
    for (const value of material.revision.body.children.inventory_item_values ?? []) {
      const field = String(value.row.field_id);
      run(pc, "INSERT OR IGNORE INTO inventory_category_fields (id, category_id, field_key, label, field_type, created_at, updated_at) VALUES (?, ?, ?, ?, 'TEXT', ?, ?)", field, category, field, field, NOW, NOW);
    }
  }
}

function openPc(name: string): Pc {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `erp-repair-${name}-`));
  const db = new SqliteDatabase({ dbPath: path.join(dir, "erp.db"), schemaPath: SCHEMA });
  const pc = { db, close: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
  seedMasters(pc);
  return pc;
}

const grantLease = (pc: Pc, domain: string) =>
  run(pc, `INSERT INTO sync_domain_leases (domain, holder_device_id, holder_label, epoch, barrier_seq, granted_at, project_key, fetched_at)
           VALUES (?, ?, 'Store PC', 1, 0, ?, 'https://test.supabase.co', ?)
           ON CONFLICT (domain) DO UPDATE SET holder_device_id = excluded.holder_device_id, epoch = 1`, domain, DEVICE, NOW, NOW);

/** The cloud's log, as a pull reads it: in order, by position. */
class Log implements SyncPullTransport {
  private readonly changes: SyncChange[] = [];

  add(...envelopes: SyncEnvelope[]): void {
    for (const envelope of envelopes) this.changes.push({ seq: this.changes.length + 1, envelope });
  }

  async fetchChanges(afterSeq: number, limit: number): Promise<SyncChange[]> {
    return this.changes.filter((change) => change.seq > afterSeq).slice(0, limit);
  }
}

/** Everything marked on PC2, built by the real builders and taken off its queue as envelopes. */
function sent(pc2: Pc): SyncEnvelope[] {
  buildLeasedRecordRevisions(pc2.db.db, NOW);
  buildStockEvents(pc2.db.db, NOW);
  const rows = pc2.db.db
    .prepare("SELECT aggregate_type, aggregate_id, dedupe_key, payload_json FROM sync_outbox WHERE status = 'PENDING' ORDER BY rowid")
    .all() as Array<Record<string, unknown>>;
  run(pc2, "UPDATE sync_outbox SET status = 'SYNCED' WHERE status = 'PENDING'");
  return rows.map((row) => ({
    dedupeKey: String(row.dedupe_key),
    aggregateType: String(row.aggregate_type),
    aggregateId: String(row.aggregate_id),
    operation: "INSERT" as const,
    payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    originDeviceId: DEVICE,
    createdAt: NOW,
  }));
}

function recordMovement(pc2: Pc, material: MaterialToRestore): void {
  for (const move of material.movements) {
    run(pc2, "INSERT INTO inventory_stock_events (id, item_id, event_type, quantity, unit_id, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      move.eventId, move.itemId, move.eventType, move.quantity, move.unitId, move.note, move.createdBy, move.createdAt);
    run(pc2, `INSERT INTO inventory_stock_balances (item_id, quantity_on_hand, unit_id, updated_at) VALUES (?, ?, ?, ?)
              ON CONFLICT (item_id) DO UPDATE SET quantity_on_hand = quantity_on_hand + excluded.quantity_on_hand`, move.itemId, move.balanceDelta, move.unitId, NOW);
  }
}

/** The erase as 0.4.5 did it (eraseInventoryItemWithLedger), row by row. */
function oldErase(pc2: Pc, material: MaterialToRestore): void {
  const id = material.revision.recordId;
  for (const table of ["inventory_item_unit_steps", "inventory_stock_events", "inventory_stock_balances", "inventory_item_values"]) {
    run(pc2, `DELETE FROM ${table} WHERE item_id = ?`, id);
  }
  run(pc2, "DELETE FROM inventory_items WHERE id = ?", id);
}

/** PC2 as it stands now: the materials sent, erased, and the deletions sent. */
function openPc2(log: Log): Pc {
  const pc2 = openPc("pc2");
  run(pc2, "INSERT OR REPLACE INTO app_settings (setting_key, setting_value, updated_at) VALUES ('device.id', ?, ?)", DEVICE, NOW);
  run(pc2, "DELETE FROM sync_dirty_records");
  grantLease(pc2, "MASTER_DATA");
  grantLease(pc2, "RAW_MATERIAL_STORE");
  for (const material of RECORDS.materials) {
    writeOwnRecord(pc2.db.db, "INVENTORY_ITEM", material.revision.body);
    recordMovement(pc2, material);
  }
  log.add(...sent(pc2));
  for (const material of RECORDS.materials) oldErase(pc2, material);
  log.add(...sent(pc2));
  return pc2;
}

const pullOn = (pc: Pc, log: Log) => new SyncPull(pc.db.db, log, { now: () => NOW_MS }).runOnce();
const balanceOf = (pc: Pc, material: MaterialToRestore) =>
  Number(one(pc, "SELECT quantity_on_hand AS q FROM inventory_stock_balances WHERE item_id = ?", material.revision.recordId)?.q);
const totalStock = (pc: Pc) => RECORDS.materials.reduce((total, material) => total + balanceOf(pc, material), 0);
const movementCount = (pc: Pc) => number(pc, "SELECT COUNT(*) AS n FROM inventory_stock_events");
const restore = (pc2: Pc) => applyRestore(pc2.db.db, RECORDS, DEVICE, NOW);

function withLog(work: (pc2: Pc, log: Log, open: (name: string) => Pc) => Promise<void> | void): Promise<void> {
  const opened: Pc[] = [];
  const log = new Log();
  const open = (name: string) => {
    const pc = openPc(name);
    opened.push(pc);
    return pc;
  };
  const pc2 = openPc2(log);
  opened.push(pc2);
  return Promise.resolve()
    .then(() => work(pc2, log, open))
    .finally(() => {
      for (const pc of opened) pc.close();
    });
}

test("the records are the six materials production's log holds: 237 units, ten movements", () => {
  const balances = Object.fromEntries(RECORDS.materials.map((material) => [material.itemCode, material.expectedBalance]));
  assert.deepEqual(balances, { "RM-001017": 42, "RM-001035": 98, "RM-001036": 7, "RM-001040": 81, "RM-001133": 8, "RM-001135": 1 });
  assert.equal(RECORDS.materials.flatMap((material) => material.movements).length, 10);
  assert.equal(DEVICE, "47c0dace-fe68-42cb-989c-e94f69c62c0f");
});

test("restored, PC2 holds the six with their stock and every check passes", async () => {
  await withLog((pc2) => {
    const before = tableCounts(pc2.db.db);
    restore(pc2);

    const checks = verifyRestore(pc2.db.db, before, RECORDS);
    assert.deepEqual(checks.filter((check) => !check.ok), []);
    assert.equal(totalStock(pc2), 237);
    assert.equal(number(pc2, "SELECT COUNT(*) AS n FROM inventory_item_audit WHERE action = 'RESTORE'"), 6);
    assert.deepEqual(rehearseSending(pc2.db.db, RECORDS, NOW).ok, true);
  });
});

test("it sends revision 3 with its body for each material, and no movement a second time", async () => {
  await withLog((pc2) => {
    restore(pc2);
    const envelopes = sent(pc2);

    assert.equal(envelopes.length, 6);
    for (const envelope of envelopes) {
      assert.equal(envelope.aggregateType, "INVENTORY_ITEM");
      assert.equal(envelope.payload.revision, 3);
      assert.equal(envelope.payload.deleted, false);
      assert.ok(envelope.payload.body);
    }
  });
});

test("a computer holding the waiting deletions takes revision 3: nothing waits, and its stock never moved", async () => {
  await withLog(async (pc2, log, open) => {
    const pc3 = open("pc3");
    await pullOn(pc3, log);
    assert.equal(parkedSummary(pc3.db.db).count, 6, "the six deletions wait, as they do in production");
    assert.equal(totalStock(pc3), 237);

    restore(pc2);
    log.add(...sent(pc2));
    await pullOn(pc3, log);

    assert.equal(parkedSummary(pc3.db.db).count, 0);
    assert.equal(totalStock(pc3), 237);
    assert.equal(movementCount(pc3), 10);
    assert.equal(number(pc3, "SELECT COUNT(*) AS n FROM inventory_items WHERE status = 'ACTIVE' AND removed_at IS NULL"), 6);
  });
});

test("a new computer replaying the whole log ends the same, with nothing parked", async () => {
  await withLog(async (pc2, log, open) => {
    restore(pc2);
    log.add(...sent(pc2));

    const fresh = open("fresh");
    await pullOn(fresh, log);

    assert.equal(parkedSummary(fresh.db.db).count, 0);
    assert.equal(totalStock(fresh), 237);
    assert.equal(movementCount(fresh), 10);
  });
});

test("PC2 reading its own movements back moves nothing", async () => {
  await withLog(async (pc2, log) => {
    restore(pc2);
    log.add(...sent(pc2));

    await pullOn(pc2, log);

    assert.equal(totalStock(pc2), 237);
    assert.equal(movementCount(pc2), 10);
    assert.equal(parkedSummary(pc2.db.db).count, 0);
  });
});

test("accounted to zero and removed the normal way, it reaches every computer with its ledger kept", async () => {
  await withLog(async (pc2, log, open) => {
    const pc3 = open("pc3");
    await pullOn(pc3, log);
    restore(pc2);
    log.add(...sent(pc2));
    await pullOn(pc3, log);

    pc2.db.setNumberBlock(1, "test");
    const admin = pc2.db.bootstrapFirstAdmin("owner", "password1");
    for (const material of RECORDS.materials) {
      const itemId = material.revision.recordId;
      pc2.db.adjustInventoryStock({ itemId, quantity: -material.expectedBalance, note: "never physically here" });
      pc2.db.applyAdminItemRemoval({ itemId, adminId: admin.id });
    }
    log.add(...sent(pc2));

    const fresh = open("fresh");
    for (const pc of [pc2, pc3, fresh]) {
      await pullOn(pc, log);
      assert.equal(totalStock(pc), 0);
      assert.equal(movementCount(pc), 16, "ten restored and one each to zero: nothing is erased");
      assert.equal(number(pc, "SELECT COUNT(*) AS n FROM inventory_items WHERE removed_at IS NOT NULL"), 6);
      assert.equal(parkedSummary(pc.db.db).count, 0);
    }
  });
});

const refusalsFor = (pc2: Pc, device = DEVICE) => restoreRefusals(pc2.db.db, RECORDS, device).join("\n");
const firstItem = (): MaterialToRestore => {
  const material = RECORDS.materials[0];
  assert.ok(material);
  return material;
};

test("a clean PC2 has nothing to refuse", async () => {
  await withLog((pc2) => assert.deepEqual(restoreRefusals(pc2.db.db, RECORDS, DEVICE), []));
});

test("refuses a database that is not PC2, and a device that is not the records'", async () => {
  await withLog((pc2) => {
    assert.match(refusalsFor(pc2, "another-device"), /records are for device/);
    run(pc2, "UPDATE app_settings SET setting_value = 'pc3' WHERE setting_key = 'device.id'");
    assert.match(refusalsFor(pc2), /device\.id is pc3/);
  });
});

test("refuses a database from before the release", async () => {
  await withLog((pc2) => {
    run(pc2, "ALTER TABLE inventory_items DROP COLUMN removed_at");
    assert.match(refusalsFor(pc2), /install the release with migration 102/);
  });
});

test("refuses when PC2 holds neither lease: nothing it restored could be sent", async () => {
  await withLog((pc2) => {
    run(pc2, "UPDATE sync_domain_leases SET holder_device_id = 'elsewhere'");
    assert.match(refusalsFor(pc2), /master-data lease/);
    assert.match(refusalsFor(pc2), /raw-material store lease/);
  });
});

test("refuses without the capture triggers: a restored material would never leave", async () => {
  await withLog((pc2) => {
    run(pc2, "DROP TRIGGER trg_capture_inventory_items_ins");
    assert.match(refusalsFor(pc2), /capture triggers/);
  });
});

test("a second run is refused and changes nothing, before and after the app has sent it", async () => {
  await withLog((pc2) => {
    restore(pc2);
    const counts = tableCounts(pc2.db.db);
    assert.throws(() => restore(pc2), RestoreRefused);
    sent(pc2);
    assert.throws(() => restore(pc2), /already here/);
    assert.equal(totalStock(pc2), 237);
    assert.equal(tableCounts(pc2.db.db).get("inventory_stock_events"), counts.get("inventory_stock_events"));
  });
});

test("refuses when a material's revision here is not the deletion's", async () => {
  await withLog((pc2) => {
    run(pc2, "UPDATE sync_record_revisions SET revision = 5 WHERE record_id = ?", firstItem().revision.recordId);
    assert.match(refusalsFor(pc2), /revision here is 5, not 2/);
  });
});

test("refuses, by name, when the same material has been created again since", async () => {
  await withLog((pc2) => {
    const row = firstItem().revision.body.row;
    run(pc2, `INSERT INTO inventory_items (id, item_code, category_id, display_name, signature_hash, default_unit_id, created_at, updated_at)
              VALUES ('new', 'RM-009999', ?, 'SAME', ?, ?, ?, ?)`, String(row.category_id), String(row.signature_hash), String(row.default_unit_id), NOW, NOW);
    assert.match(refusalsFor(pc2), /RM-009999 was created since/);
  });
});

test("refuses when another material has taken the code", async () => {
  await withLog((pc2) => {
    const row = firstItem().revision.body.row;
    run(pc2, `INSERT INTO inventory_items (id, item_code, category_id, display_name, signature_hash, default_unit_id, created_at, updated_at)
              VALUES ('new', ?, ?, 'OTHER', 'other', ?, ?, ?)`, String(row.item_code), String(row.category_id), String(row.default_unit_id), NOW, NOW);
    assert.match(refusalsFor(pc2), /another material now has this code/);
  });
});

test("refuses while the deletion is still on its way out", async () => {
  await withLog((pc2) => {
    run(pc2, "UPDATE sync_outbox SET status = 'PENDING' WHERE aggregate_id = ? AND dedupe_key LIKE '%:2'", firstItem().revision.recordId);
    assert.match(refusalsFor(pc2), /has not finished sending/);
  });
});

test("refuses when what the material needs is not here", async () => {
  await withLog((pc2) => {
    run(pc2, "PRAGMA foreign_keys = OFF");
    run(pc2, "DELETE FROM inventory_categories WHERE id = ?", String(firstItem().revision.body.row.category_id));
    assert.match(refusalsFor(pc2), /lacks what it needs/);
  });
});

test("refuses when a movement or a balance is somehow already here", async () => {
  await withLog((pc2) => {
    const item = firstItem();
    writeOwnRecord(pc2.db.db, "INVENTORY_ITEM", item.revision.body);
    recordMovement(pc2, item);
    const reasons = refusalsFor(pc2);
    assert.match(reasons, /already here\. Already restored/);
    assert.match(reasons, /movements for it are already here/);
    assert.match(reasons, /a balance for it is already here/);
  });
});

test("refuses a records file whose movements do not add up, name another material, or carry no body", () => {
  const tamper = (edit: (material: Record<string, unknown>) => void): Record<string, unknown> => {
    const file = rawRecords();
    edit((file.materials as Array<Record<string, unknown>>)[0] as Record<string, unknown>);
    return file;
  };
  const payloadOf = (material: Record<string, unknown>) => ((material.movements as Array<Record<string, unknown>>)[0] as Record<string, unknown>).payload as Record<string, unknown>;

  assert.throws(() => readRestoreRecords(tamper((material) => { material.expectedBalance = 43; })), /add up to 42, not 43/);
  assert.throws(() => readRestoreRecords(tamper((material) => { payloadOf(material).itemId = "other"; })), /names another material/);
  assert.throws(() => readRestoreRecords(tamper((material) => { (material.revision as Record<string, unknown>).body = null; })), /not a whole record/);
  assert.throws(() => readRestoreRecords(tamper((material) => { material.movements = []; })), /no movements/);
  assert.throws(() => readRestoreRecords({ deviceId: DEVICE, materials: [] }), /no materials/);
  assert.throws(() => readRestoreRecords({ materials: [{}] }), /no device/);
});

/** Restores, breaks something, and reports which checks noticed. */
async function failedChecks(breakIt: (pc2: Pc) => void): Promise<string[]> {
  let failed: string[] = [];
  await withLog((pc2) => {
    const before = tableCounts(pc2.db.db);
    restore(pc2);
    breakIt(pc2);
    failed = verifyRestore(pc2.db.db, before, RECORDS).filter((check) => !check.ok).map((check) => check.name);
  });
  return failed;
}

test("the checks notice a balance, a body, a movement, a mark and a stray row", async () => {
  const item = firstItem();
  const id = item.revision.recordId;
  const move = item.movements[0]?.eventId ?? "";

  assert.deepEqual(await failedChecks((pc2) => run(pc2, "UPDATE inventory_stock_balances SET quantity_on_hand = 41 WHERE item_id = ?", id)), ["Balances"]);
  assert.deepEqual(await failedChecks((pc2) => run(pc2, "UPDATE inventory_item_values SET text_value = 'X' WHERE item_id = ?", id)), ["Materials"]);
  assert.deepEqual(await failedChecks((pc2) => run(pc2, "UPDATE inventory_stock_events SET note = 'X' WHERE id = ?", move)), ["Movements"]);
  assert.deepEqual(await failedChecks((pc2) => run(pc2, "UPDATE inventory_stock_events SET replicated_at = NULL WHERE id = ?", move)), ["Movements"]);
  assert.deepEqual(await failedChecks((pc2) => run(pc2, "UPDATE sync_dirty_records SET lease_epoch = NULL WHERE record_id = ?", id)), ["Marks"]);
  assert.deepEqual(await failedChecks((pc2) => run(pc2, "INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES ('stray', 'x', ?)", NOW)), ["Row counts"]);
});

test("the sending rehearsal notices a material that would go out empty, or a movement sent twice", async () => {
  const records: RestoreRecords = RECORDS;
  await withLog((pc2) => {
    restore(pc2);
    run(pc2, "DELETE FROM sync_dirty_records WHERE record_id = ?", firstItem().revision.recordId);
    assert.equal(rehearseSending(pc2.db.db, records, NOW).ok, false);
  });
  await withLog((pc2) => {
    restore(pc2);
    const move = firstItem().movements[0]?.eventId ?? "";
    run(pc2, "DELETE FROM sync_outbox WHERE dedupe_key = ?", `STOCK_EVENT:${move}`);
    run(pc2, "INSERT INTO sync_dirty_records (aggregate_type, record_id, lease_epoch, marked_at) VALUES ('STOCK_EVENT', ?, 1, ?)", move, NOW);
    assert.equal(rehearseSending(pc2.db.db, records, NOW).ok, false);
  });
});
