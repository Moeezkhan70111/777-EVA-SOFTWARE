import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase, buildLeasedRecordRevisions } from "@erp/data";
import { applyEnvelope } from "./applyEnvelope.js";
import type { SyncEnvelope } from "./contract.js";

// MASTER DATA ARRIVES WHOLE, BY REVISION (leasedRecordContracts.ts), end to end: the store PC writes
// master data the ordinary way, its own capture triggers mark it, the real builder queues it, and the
// queued revisions are applied to another computer's database by the real applier.

const SCHEMA = path.resolve(import.meta.dirname, "../../data/src/local-schema.sql");
const NOW = "2026-10-25T10:00:00.000Z";

interface Pc {
  readonly db: SqliteDatabase;
  readonly close: () => void;
}

function openPc(name: string): Pc {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `erp-records-${name}-`));
  const db = new SqliteDatabase({ dbPath: path.join(dir, "erp.db"), schemaPath: SCHEMA });
  return { db, close: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

/** The store PC, holding the master-data lease. */
function openHolder(): Pc {
  const pc = openPc("holder");
  pc.db.db.prepare(
    `INSERT INTO sync_domain_leases (domain, holder_device_id, holder_label, epoch, barrier_seq, granted_at, project_key, fetched_at)
     VALUES ('MASTER_DATA', 'dev-holder', 'Store PC', 1, 0, ?, 'https://test.supabase.co', ?)`
  ).run(NOW, NOW);
  return pc;
}

const run = (pc: Pc, sql: string, ...params: Array<string | number | null>) => pc.db.db.prepare(sql).run(...params);

/** Builds what the holder has marked and returns the queued revisions as envelopes, keyed by dedupe key. */
function sent(holder: Pc): Map<string, SyncEnvelope> {
  buildLeasedRecordRevisions(holder.db.db, NOW);
  const rows = holder.db.db.prepare("SELECT aggregate_type, aggregate_id, dedupe_key, payload_json FROM sync_outbox WHERE status = 'PENDING' ORDER BY rowid").all() as Array<Record<string, unknown>>;
  holder.db.db.prepare("UPDATE sync_outbox SET status = 'SYNCED' WHERE status = 'PENDING'").run();
  return new Map(
    rows.map((row) => [
      String(row.dedupe_key),
      {
        dedupeKey: String(row.dedupe_key),
        aggregateType: String(row.aggregate_type),
        aggregateId: String(row.aggregate_id),
        operation: "INSERT" as const,
        payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
        originDeviceId: "dev-holder",
        createdAt: NOW,
      },
    ])
  );
}

const apply = (reader: Pc, envelope: SyncEnvelope | undefined) => {
  assert.ok(envelope, "the revision was queued");
  return applyEnvelope(reader.db.db, envelope, NOW);
};

function seedMaterial(holder: Pc): void {
  run(holder, "INSERT INTO inventory_units (id, code, name, created_at, updated_at) VALUES ('u-kg', 'KG', 'Kilogram', ?, ?)", NOW, NOW);
  run(holder, "INSERT INTO inventory_categories (id, category_code, name, created_at, updated_at) VALUES ('c-1', 'C1', 'Leather', ?, ?)", NOW, NOW);
  run(holder, "INSERT INTO inventory_category_fields (id, category_id, field_key, label, field_type, created_at, updated_at) VALUES ('f-1', 'c-1', 'colour', 'Colour', 'TEXT', ?, ?)", NOW, NOW);
  run(holder, "INSERT INTO inventory_category_fields (id, category_id, field_key, label, field_type, created_at, updated_at) VALUES ('f-2', 'c-1', 'grade', 'Grade', 'TEXT', ?, ?)", NOW, NOW);
  run(
    holder,
    "INSERT INTO inventory_items (id, item_code, category_id, display_name, signature_hash, default_unit_id, cost_price_paisa, created_at, updated_at) VALUES ('i-1', 'RM-1', 'c-1', 'Leather Black A', 'sig', 'u-kg', 125000, ?, ?)",
    NOW, NOW
  );
  run(holder, "INSERT INTO inventory_item_values (id, item_id, field_id, text_value) VALUES ('v-1', 'i-1', 'f-1', 'BLACK')");
  run(holder, "INSERT INTO inventory_item_values (id, item_id, field_id, text_value) VALUES ('v-2', 'i-1', 'f-2', 'A')");
}

const marks = (pc: Pc): number => Number((pc.db.db.prepare("SELECT COUNT(*) AS n FROM sync_dirty_records").get() as { n: number }).n);

test("a material waits for its category, then arrives whole -- and the reader does not mark it as its own", () => {
  const holder = openHolder();
  const reader = openPc("reader");
  try {
    seedMaterial(holder);
    const revisions = sent(holder);

    // Out of order: the material before what it needs.
    assert.deepEqual(apply(reader, revisions.get("INVENTORY_ITEM:i-1:1")), {
      dedupeKey: "INVENTORY_ITEM:i-1:1", status: "REJECTED", reason: "WAITING_FOR:INVENTORY_CATEGORY:c-1", permanent: false,
    });
    assert.equal(apply(reader, revisions.get("INVENTORY_UNIT:u-kg:1")).status, "APPLIED");
    assert.equal(apply(reader, revisions.get("INVENTORY_CATEGORY:c-1:1")).status, "APPLIED");
    assert.equal(apply(reader, revisions.get("INVENTORY_ITEM:i-1:1")).status, "APPLIED");

    const item = reader.db.db.prepare("SELECT display_name, cost_price_paisa FROM inventory_items WHERE id = 'i-1'").get() as Record<string, unknown>;
    assert.deepEqual({ ...item }, { display_name: "Leather Black A", cost_price_paisa: 125000 });
    const values = reader.db.db.prepare("SELECT id, text_value FROM inventory_item_values WHERE item_id = 'i-1' ORDER BY id").all() as Array<Record<string, unknown>>;
    assert.deepEqual(values.map((row) => `${String(row.id)}=${String(row.text_value)}`), ["v-1=BLACK", "v-2=A"]);
    assert.equal(marks(reader), 0, "applying another computer's change marks nothing here");
    assert.equal((reader.db.db.prepare("SELECT suppressed FROM sync_capture WHERE id = 1").get() as { suppressed: number }).suppressed, 0);
  } finally {
    holder.close();
    reader.close();
  }
});

test("a newer revision replaces the record and its children; an older one, arriving late, changes nothing", () => {
  const holder = openHolder();
  const reader = openPc("reader");
  try {
    seedMaterial(holder);
    for (const envelope of sent(holder).values()) apply(reader, envelope);

    // The store PC renames the material, drops one value and changes the other.
    run(holder, "UPDATE inventory_items SET display_name = 'Leather Jet Black' WHERE id = 'i-1'");
    run(holder, "DELETE FROM inventory_item_values WHERE id = 'v-2'");
    run(holder, "UPDATE inventory_item_values SET text_value = 'JET BLACK' WHERE id = 'v-1'");
    const second = sent(holder);
    assert.equal(apply(reader, second.get("INVENTORY_ITEM:i-1:2")).status, "APPLIED");
    const values = reader.db.db.prepare("SELECT id, text_value FROM inventory_item_values WHERE item_id = 'i-1' ORDER BY id").all() as Array<Record<string, unknown>>;
    assert.deepEqual(values.map((row) => `${String(row.id)}=${String(row.text_value)}`), ["v-1=JET BLACK"]);

    // Revision 1 again, as a retry from the park would offer it: superseded, so nothing moves back.
    const stale: SyncEnvelope = { ...second.get("INVENTORY_ITEM:i-1:2")!, dedupeKey: "INVENTORY_ITEM:i-1:1", payload: { ...second.get("INVENTORY_ITEM:i-1:2")!.payload, revision: 1 } };
    assert.equal(apply(reader, stale).status, "DUPLICATE");
    assert.equal((reader.db.db.prepare("SELECT display_name FROM inventory_items WHERE id = 'i-1'").get() as { display_name: string }).display_name, "Leather Jet Black");
  } finally {
    holder.close();
    reader.close();
  }
});

test("a deletion waits while the record is still in use here, and applies once it is not", () => {
  const holder = openHolder();
  const reader = openPc("reader");
  try {
    seedMaterial(holder);
    for (const envelope of sent(holder).values()) apply(reader, envelope);

    // The store PC removes the material and then its category.
    run(holder, "DELETE FROM inventory_item_values WHERE item_id = 'i-1'");
    run(holder, "DELETE FROM inventory_items WHERE id = 'i-1'");
    run(holder, "DELETE FROM inventory_category_fields WHERE category_id = 'c-1'");
    run(holder, "DELETE FROM inventory_categories WHERE id = 'c-1'");
    const revisions = sent(holder);

    // The category's deletion arrives first: the material here still uses it.
    assert.deepEqual(apply(reader, revisions.get("INVENTORY_CATEGORY:c-1:2")), {
      dedupeKey: "INVENTORY_CATEGORY:c-1:2", status: "REJECTED", reason: "STILL_IN_USE:INVENTORY_CATEGORY:c-1", permanent: false,
    });
    assert.ok(reader.db.db.prepare("SELECT 1 FROM inventory_categories WHERE id = 'c-1'").get(), "rolled back whole, nothing half-deleted");
    assert.equal(apply(reader, revisions.get("INVENTORY_ITEM:i-1:2")).status, "APPLIED");
    assert.equal(apply(reader, revisions.get("INVENTORY_CATEGORY:c-1:2")).status, "APPLIED");
    assert.equal(reader.db.db.prepare("SELECT 1 FROM inventory_categories WHERE id = 'c-1'").get(), undefined);
  } finally {
    holder.close();
    reader.close();
  }
});

test("two parties swapping names: the out-of-date holder is moved aside, shown, and put right by its own revision", () => {
  const holder = openHolder();
  const reader = openPc("reader");
  try {
    run(holder, "INSERT INTO parties (id, party_code, party_name, party_type, created_at, updated_at) VALUES ('p-a', 'P-A', 'ALPHA', 'SUPPLIER', ?, ?)", NOW, NOW);
    run(holder, "INSERT INTO parties (id, party_code, party_name, party_type, created_at, updated_at) VALUES ('p-b', 'P-B', 'BETA', 'SUPPLIER', ?, ?)", NOW, NOW);
    for (const envelope of sent(holder).values()) apply(reader, envelope);

    run(holder, "UPDATE parties SET party_name = 'TEMP' WHERE id = 'p-a'");
    run(holder, "UPDATE parties SET party_name = 'ALPHA' WHERE id = 'p-b'");
    run(holder, "UPDATE parties SET party_name = 'BETA' WHERE id = 'p-a'");
    const revisions = sent(holder);
    const names = () =>
      (reader.db.db.prepare("SELECT id, party_name FROM parties WHERE id IN ('p-a', 'p-b') ORDER BY id").all() as Array<Record<string, unknown>>)
        .map((row) => `${String(row.id)}=${String(row.party_name)}`);
    const displaced = () =>
      (reader.db.db.prepare("SELECT record_id, original_json FROM sync_displaced_records ORDER BY record_id").all() as Array<Record<string, unknown>>)
        .map((row) => `${String(row.record_id)}:${String(row.original_json)}`);

    // p-b wants ALPHA, which this computer's out-of-date copy of p-a still holds: p-a is moved aside.
    assert.equal(apply(reader, revisions.get("PARTY:p-b:2")).status, "APPLIED");
    assert.deepEqual(names(), ["p-a=~moved:p-a", "p-b=ALPHA"]);
    assert.deepEqual(displaced(), ['p-a:{"party_name":"ALPHA"}'], "shown as incomplete, with the name it had");
    assert.equal(marks(reader), 0, "moving it aside is not this computer's own change");

    // p-a's own revision puts it right, and it is no longer incomplete.
    assert.equal(apply(reader, revisions.get("PARTY:p-a:2")).status, "APPLIED");
    assert.deepEqual(names(), ["p-a=BETA", "p-b=ALPHA"]);
    assert.deepEqual(displaced(), []);
  } finally {
    holder.close();
    reader.close();
  }
});
