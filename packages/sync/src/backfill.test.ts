import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase, buildLeasedRecordRevisions, buildStockEvents } from "@erp/data";
import { applyEnvelope } from "./applyEnvelope.js";
import type { SyncEnvelope } from "./contract.js";

// AN EMPTY COMPUTER REACHES THE STORE'S STOCK FROM THE BACKFILL ALONE (docs/37, the stock-screen
// slice, items 3 and 6). The store PC holds history written before it synced; the backfill marks it,
// the real builders queue it pass by pass, and an empty reader applies whatever arrives, retrying
// what had to wait -- as the park does. At the end the reader holds the same materials, the same
// labels and the same balance as the store.

const SCHEMA = path.resolve(import.meta.dirname, "../../data/src/local-schema.sql");
const NOW = "2026-10-26T10:00:00.000Z";

interface Pc {
  readonly db: SqliteDatabase;
  readonly close: () => void;
}

function openPc(name: string): Pc {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `erp-backfill-${name}-`));
  const db = new SqliteDatabase({ dbPath: path.join(dir, "erp.db"), schemaPath: SCHEMA });
  return { db, close: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const run = (pc: Pc, sql: string, ...params: Array<string | number | null>) => pc.db.db.prepare(sql).run(...params);

/** The store's history, written before any lease was known here. */
function seedHistory(store: Pc): void {
  run(store, "INSERT INTO inventory_units (id, code, name, created_at, updated_at) VALUES ('u-kg', 'KG', 'Kilogram', ?, ?)", NOW, NOW);
  run(store, "INSERT INTO inventory_categories (id, category_code, name, created_at, updated_at) VALUES ('c-1', 'C1', 'Dana', ?, ?)", NOW, NOW);
  run(store, "INSERT INTO party_groups (id, group_name, created_at, updated_at) VALUES ('g-1', 'Suppliers', ?, ?)", NOW, NOW);
  run(store, "INSERT INTO parties (id, party_code, party_name, party_type, party_group_id, created_at, updated_at) VALUES ('p-1', 'P-1', 'SHAN', 'SUPPLIER', 'g-1', ?, ?)", NOW, NOW);
  // Enough materials that the master builder (200 a pass) needs more than one pass.
  for (let index = 1; index <= 230; index += 1) {
    const id = `i-${String(index)}`;
    run(
      store,
      "INSERT INTO inventory_items (id, item_code, category_id, display_name, signature_hash, default_unit_id, created_at, updated_at) VALUES (?, ?, 'c-1', ?, ?, 'u-kg', ?, ?)",
      id, `RM-${String(index)}`, `Dana ${String(index)}`, `sig-${id}`, NOW, NOW
    );
    run(store, "INSERT INTO inventory_stock_events (id, item_id, event_type, quantity, unit_id, party_id, created_at) VALUES (?, ?, 'RECEIVE', ?, 'u-kg', 'p-1', ?)", `in-${id}`, id, index, NOW);
    run(store, "INSERT INTO inventory_stock_events (id, item_id, event_type, quantity, unit_id, created_at) VALUES (?, ?, 'TRANSFER_OUT', 1, 'u-kg', ?)", `out-${id}`, id, NOW);
    run(store, "INSERT INTO inventory_stock_balances (item_id, quantity_on_hand, unit_id, updated_at) VALUES (?, ?, 'u-kg', ?)", id, index - 1, NOW);
  }
  run(store, "INSERT INTO raw_material_qr_batches (id, party_id, item_id, start_sequence, end_sequence, quantity, created_at) VALUES ('b-1', 'p-1', 'i-230', 1, 1, 1, ?)", NOW);
  run(
    store,
    `INSERT INTO raw_material_qrs (id, batch_id, party_id, item_id, sequence, status, current_status, current_section_id, current_hop_index, created_at, updated_at)
     VALUES ('q-1', 'b-1', 'p-1', 'i-230', 1, 'GENERATED', 'GENERATED', NULL, 0, ?, ?)`,
    NOW, NOW
  );
}

function grantBoth(store: Pc): void {
  for (const domain of ["MASTER_DATA", "RAW_MATERIAL_STORE"]) {
    run(
      store,
      `INSERT INTO sync_domain_leases (domain, holder_device_id, holder_label, epoch, barrier_seq, granted_at, project_key, fetched_at)
       VALUES (?, 'dev-store', 'Store PC', 1, 0, ?, 'https://test.supabase.co', ?)`,
      domain, NOW, NOW
    );
  }
}

/** One pass on the store: build, then hand over everything queued, in outbox order. */
function pass(store: Pc): SyncEnvelope[] {
  buildLeasedRecordRevisions(store.db.db, NOW);
  buildStockEvents(store.db.db, NOW);
  const rows = store.db.db
    .prepare("SELECT aggregate_type, aggregate_id, dedupe_key, payload_json FROM sync_outbox WHERE status = 'PENDING' AND lease_epoch IS NOT NULL ORDER BY rowid")
    .all() as Array<Record<string, unknown>>;
  store.db.db.prepare("UPDATE sync_outbox SET status = 'SYNCED' WHERE status = 'PENDING' AND lease_epoch IS NOT NULL").run();
  return rows.map((row) => ({
    dedupeKey: String(row.dedupe_key),
    aggregateType: String(row.aggregate_type),
    aggregateId: String(row.aggregate_id),
    operation: "INSERT" as const,
    payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    originDeviceId: "dev-store",
    createdAt: NOW,
  }));
}

const balances = (pc: Pc): string =>
  (pc.db.db.prepare("SELECT item_id, quantity_on_hand FROM inventory_stock_balances ORDER BY item_id").all() as Array<Record<string, unknown>>)
    .map((row) => `${String(row.item_id)}=${String(row.quantity_on_hand)}`)
    .join(",");

const count = (pc: Pc, table: string): number => Number((pc.db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

test("an empty computer reaches the store's stock, materials and labels from the backfill alone", () => {
  const store = openPc("store");
  const reader = openPc("reader");
  try {
    seedHistory(store);
    grantBoth(store);
    const outcome = store.db.runBackfill(NOW);
    assert.equal(outcome.done, true, outcome.done ? "" : outcome.reason);

    let waiting: SyncEnvelope[] = [];
    let passes = 0;
    for (; passes < 10; passes += 1) {
      const arrived = [...waiting, ...pass(store)];
      if (arrived.length === 0) break;
      waiting = arrived.filter((envelope) => {
        const applied = applyEnvelope(reader.db.db, envelope, NOW);
        assert.notEqual(applied.permanent, true, `${envelope.dedupeKey} was refused: ${String(applied.reason)}`);
        return applied.status === "REJECTED";
      });
    }

    assert.ok(passes > 1, "the materials took more than one pass");
    assert.deepEqual(waiting, [], "nothing left waiting");
    assert.equal(balances(reader), balances(store), "every balance, exactly");
    for (const table of ["inventory_items", "parties", "party_groups", "inventory_categories", "inventory_units", "inventory_stock_events", "raw_material_qr_batches", "raw_material_qrs"]) {
      assert.equal(count(reader, table), count(store, table), table);
    }
    assert.equal(count(reader, "sync_dirty_records"), 0, "nothing received is marked as the reader's own");
  } finally {
    store.close();
    reader.close();
  }
});
