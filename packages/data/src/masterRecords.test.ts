import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MASTER_CAPTURE,
  MASTER_RECORDS,
  MASTER_RECORD_TYPES,
  SqliteDatabase,
  buildLeasedRecordRevisions,
  markRecordToSendAgain,
  readLeasedRecordPayload,
  specTables,
} from "./sqliteDatabase.js";

// MASTER RECORDS ARE BUILT WHOLE FROM THE MARKS (masterRecords.ts, stage 4b).

const SCHEMA = path.resolve(import.meta.dirname, "../src/local-schema.sql");
const NOW = "2026-10-25T10:00:00.000Z";

function withDatabase(work: (db: SqliteDatabase) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-records-"));
  const db = new SqliteDatabase({ dbPath: path.join(dir, "erp.db"), schemaPath: SCHEMA });
  try {
    db.db.exec("PRAGMA foreign_keys = OFF");
    work(db);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const holdMasterData = (db: SqliteDatabase, epoch: number) =>
  db.db.prepare(
    `INSERT OR REPLACE INTO sync_domain_leases (domain, holder_device_id, holder_label, epoch, barrier_seq, granted_at, project_key, fetched_at)
     VALUES ('MASTER_DATA', 'dev-1', 'Store PC', ?, 0, ?, 'https://test.supabase.co', ?)`
  ).run(epoch, NOW, NOW);

function seedMaterial(db: SqliteDatabase): void {
  const run = (sql: string, ...params: Array<string | number>) => db.db.prepare(sql).run(...params);
  run("INSERT INTO inventory_units (id, code, name, created_at, updated_at) VALUES ('u-kg', 'KG', 'Kilogram', ?, ?)", NOW, NOW);
  run("INSERT INTO inventory_categories (id, category_code, name, created_at, updated_at) VALUES ('c-1', 'C1', 'Leather', ?, ?)", NOW, NOW);
  run("INSERT INTO inventory_category_fields (id, category_id, field_key, label, field_type, created_at, updated_at) VALUES ('f-1', 'c-1', 'colour', 'Colour', 'DROPDOWN', ?, ?)", NOW, NOW);
  run("INSERT INTO inventory_category_field_options (id, field_id, option_value, display_label) VALUES ('o-1', 'f-1', 'BLACK', 'Black')");
  run(
    "INSERT INTO inventory_items (id, item_code, category_id, display_name, signature_hash, default_unit_id, cost_price_paisa, created_at, updated_at) VALUES ('i-1', 'RM-1', 'c-1', 'Leather Black', 'sig', 'u-kg', 125000, ?, ?)",
    NOW, NOW
  );
  run("INSERT INTO inventory_item_values (id, item_id, field_id, text_value) VALUES ('v-1', 'i-1', 'f-1', 'BLACK')");
}

const queued = (db: SqliteDatabase) =>
  (db.db.prepare("SELECT aggregate_type, aggregate_id, dedupe_key, lease_epoch, payload_json FROM sync_outbox ORDER BY rowid").all() as Array<Record<string, unknown>>)
    .map((row) => ({
      type: String(row.aggregate_type),
      id: String(row.aggregate_id),
      key: String(row.dedupe_key),
      epoch: row.lease_epoch === null ? null : Number(row.lease_epoch),
      payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    }));

test("the record specs cover exactly the captured tables, each under the record that captures it", () => {
  const fromSpecs = MASTER_RECORD_TYPES.flatMap((type) => specTables(MASTER_RECORDS[type]).map((spec) => `${spec.table}=${type}`)).sort();
  const fromCapture = MASTER_CAPTURE.map((capture) => `${capture.table}=${capture.record}`).sort();
  assert.deepEqual(fromSpecs, fromCapture);
});

test("marked records are queued whole, prerequisites first, under the epoch held when they were written", () => {
  withDatabase((db) => {
    holdMasterData(db, 3);
    seedMaterial(db);
    holdMasterData(db, 4); // the lease moved on after the writes: the marks keep epoch 3
    const result = buildLeasedRecordRevisions(db.db, NOW);
    assert.deepEqual(result, { queued: 3, unqueued: 0 });

    const rows = queued(db);
    assert.deepEqual(rows.map((row) => row.type), ["INVENTORY_UNIT", "INVENTORY_CATEGORY", "INVENTORY_ITEM"]);
    assert.deepEqual(rows.map((row) => row.epoch), [3, 3, 3]);
    assert.deepEqual(rows.map((row) => row.key), ["INVENTORY_UNIT:u-kg:1", "INVENTORY_CATEGORY:c-1:1", "INVENTORY_ITEM:i-1:1"]);

    // The category carries its field and the field its option; the material its value, and its money.
    const category = readLeasedRecordPayload("INVENTORY_CATEGORY", rows[1]!.payload);
    assert.equal(category?.body?.children.inventory_category_fields?.[0]?.children.inventory_category_field_options?.[0]?.row.option_value, "BLACK");
    const item = readLeasedRecordPayload("INVENTORY_ITEM", rows[2]!.payload);
    assert.equal(item?.body?.row.cost_price_paisa, 125000, "money travels inside the record (owner, 2026-10-25)");
    assert.equal(item?.body?.children.inventory_item_values?.[0]?.row.text_value, "BLACK");

    assert.equal((db.db.prepare("SELECT COUNT(*) AS n FROM sync_dirty_records").get() as { n: number }).n, 0, "marks cleared once queued");
  });
});

test("a later change is the next revision, and a removed record is queued as a deletion", () => {
  withDatabase((db) => {
    holdMasterData(db, 3);
    seedMaterial(db);
    buildLeasedRecordRevisions(db.db, NOW);
    db.db.prepare("UPDATE inventory_items SET display_name = 'Leather Jet Black' WHERE id = 'i-1'").run();
    db.db.prepare("DELETE FROM inventory_item_values WHERE item_id = 'i-1'").run();
    db.db.prepare("DELETE FROM inventory_items WHERE id = 'i-1'").run();
    buildLeasedRecordRevisions(db.db, NOW);
    const last = queued(db).at(-1)!;
    assert.equal(last.key, "INVENTORY_ITEM:i-1:2");
    assert.deepEqual(readLeasedRecordPayload("INVENTORY_ITEM", last.payload), { recordId: "i-1", revision: 2, deleted: true, body: null });
  });
});

test("a change made without a lease epoch is not built: it waits, marked, for the backfill", () => {
  withDatabase((db) => {
    seedMaterial(db); // no lease cached: standalone
    assert.deepEqual(buildLeasedRecordRevisions(db.db, NOW), { queued: 0, unqueued: 0 });
    assert.equal(queued(db).length, 0);
    assert.equal((db.db.prepare("SELECT COUNT(*) AS n FROM sync_dirty_records").get() as { n: number }).n, 3);
  });
});

test("a revision is read whole or refused whole", () => {
  const good = {
    recordId: "c-1", revision: 2, deleted: false,
    body: { row: { id: "c-1", name: "Leather" }, children: { inventory_category_fields: [{ row: { id: "f-1", category_id: "c-1" }, children: { inventory_category_field_options: [] } }] } },
  };
  assert.notEqual(readLeasedRecordPayload("INVENTORY_CATEGORY", good), null);
  const bad: Array<[string, Record<string, unknown>]> = [
    ["a type that is not a master record", { ...good }],
    ["a table the record does not have", { ...good, body: { row: { id: "c-1" }, children: { parties: [] } } }],
    ["a child naming another parent", { ...good, body: { row: { id: "c-1" }, children: { inventory_category_fields: [{ row: { id: "f-1", category_id: "c-9" }, children: {} }] } } }],
    ["a value that is not a plain cell", { ...good, body: { row: { id: "c-1", name: { nested: true } }, children: {} } }],
    ["a body for another record", { ...good, body: { row: { id: "c-2" }, children: {} } }],
    ["a deletion that still carries a body", { ...good, deleted: true }],
    ["a revision that is not a positive whole number", { ...good, revision: 0 }],
  ];
  for (const [why, payload] of bad) {
    const type = why === "a type that is not a master record" ? "GATEPASS" : "INVENTORY_CATEGORY";
    assert.equal(readLeasedRecordPayload(type, payload), null, why);
  }
});

test("a record is sent again as a new revision, only when this computer has it and knows its lease", () => {
  withDatabase((db) => {
    seedMaterial(db);
    db.db.exec("DELETE FROM sync_dirty_records");
    assert.equal(markRecordToSendAgain(db.db, "INVENTORY_CATEGORY", "c-1", NOW), "NO_LEASE", "no epoch: it could never be sent");
    holdMasterData(db, 3);
    assert.equal(markRecordToSendAgain(db.db, "INVENTORY_CATEGORY", "c-404", NOW), "NOT_HERE");
    assert.equal(markRecordToSendAgain(db.db, "PRODUCT_VARIANT", "v-1", NOW), "UNKNOWN_TYPE");
    db.db.prepare("INSERT INTO sync_record_revisions (aggregate_type, record_id, revision) VALUES ('INVENTORY_CATEGORY', 'c-1', 4)").run();

    assert.equal(markRecordToSendAgain(db.db, "INVENTORY_CATEGORY", "c-1", NOW), "MARKED");
    buildLeasedRecordRevisions(db.db, NOW);
    const sent = queued(db);
    assert.deepEqual(sent.map((row) => [row.key, row.epoch]), [["INVENTORY_CATEGORY:c-1:5", 3]], "the next revision, under the lease held now");
    assert.equal((sent[0]?.payload.body as { row: { name: string } }).row.name, "Leather", "the record as it is, unchanged");
  });
});
