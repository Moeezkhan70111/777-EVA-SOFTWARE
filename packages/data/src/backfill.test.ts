// THE ONE-TIME BACKFILL (backfill.ts): what the store PC held before it synced goes up once, by
// marking, and never when its stock does not add up.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKFILL_SETTING_KEY, SqliteDatabase, buildLabelRuns, buildLeasedRecordRevisions, buildStockEvents, withCaptureSuppressed } from "./sqliteDatabase.js";

const SCHEMA = path.resolve(import.meta.dirname, "../src/local-schema.sql");
const NOW = "2026-10-26T10:00:00.000Z";

function withStore(work: (db: SqliteDatabase, run: (sql: string, ...params: Array<string | number | null>) => void) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-backfill-"));
  const db = new SqliteDatabase({ dbPath: path.join(dir, "erp.db"), schemaPath: SCHEMA });
  const run = (sql: string, ...params: Array<string | number | null>) => void db.db.prepare(sql).run(...params);
  try {
    db.db.exec("PRAGMA foreign_keys = OFF");
    work(db, run);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Years of data, written before this computer synced: no lease known, so nothing can be sent. */
function seedHistory(run: (sql: string, ...params: Array<string | number | null>) => void): void {
  run("INSERT INTO inventory_units (id, code, name, created_at, updated_at) VALUES ('u-kg', 'KG', 'Kilogram', ?, ?)", NOW, NOW);
  run("INSERT INTO inventory_categories (id, category_code, name, created_at, updated_at) VALUES ('c-1', 'C1', 'Dana', ?, ?)", NOW, NOW);
  run("INSERT INTO party_groups (id, group_name, created_at, updated_at) VALUES ('g-1', 'Suppliers', ?, ?)", NOW, NOW);
  run("INSERT INTO parties (id, party_code, party_name, party_type, party_group_id, created_at, updated_at) VALUES ('p-1', 'P-1', 'SHAN', 'SUPPLIER', 'g-1', ?, ?)", NOW, NOW);
  for (const id of ["i-1", "i-2"]) {
    run(
      "INSERT INTO inventory_items (id, item_code, category_id, display_name, signature_hash, default_unit_id, created_at, updated_at) VALUES (?, ?, 'c-1', ?, ?, 'u-kg', ?, ?)",
      id, `RM-${id}`, `Dana ${id}`, `sig-${id}`, NOW, NOW
    );
  }
  // i-1: opening 10, a scan out of 2 (stored positive), a hand move out of 3 (stored signed) = 5.
  run("INSERT INTO inventory_stock_events (id, item_id, event_type, quantity, unit_id, created_at) VALUES ('e-1', 'i-1', 'RECEIVE', 10, 'u-kg', ?)", NOW);
  run("INSERT INTO inventory_stock_events (id, item_id, event_type, quantity, unit_id, created_at) VALUES ('e-2', 'i-1', 'TRANSFER_OUT', 2, 'u-kg', ?)", NOW);
  run("INSERT INTO inventory_stock_events (id, item_id, event_type, quantity, unit_id, created_at) VALUES ('e-3', 'i-1', 'TRANSFER_OUT', -3, 'u-kg', ?)", NOW);
  run("INSERT INTO inventory_stock_balances (item_id, quantity_on_hand, unit_id, updated_at) VALUES ('i-1', 5, 'u-kg', ?)", NOW);
  run(
    "INSERT INTO raw_material_qr_batches (id, party_id, item_id, start_sequence, end_sequence, quantity, created_at) VALUES ('b-1', 'p-1', 'i-1', 1, 2, 2, ?)",
    NOW
  );
  for (const sequence of [1, 2]) {
    run(
      `INSERT INTO raw_material_qrs (id, batch_id, party_id, item_id, sequence, status, current_status, current_section_id, current_hop_index, created_at, updated_at)
       VALUES (?, 'b-1', 'p-1', 'i-1', ?, 'GENERATED', 'GENERATED', NULL, 0, ?, ?)`,
      `q-${String(sequence)}`, sequence, NOW, NOW
    );
  }
}

const grantBoth = (run: (sql: string, ...params: Array<string | number | null>) => void, masterEpoch = 2, storeEpoch = 3) => {
  run("INSERT OR REPLACE INTO app_settings (setting_key, setting_value, value_type, is_encrypted, updated_by, updated_at) VALUES ('device.id', 'dev-store', 'string', 0, 'test', '2026-10-26T00:00:00.000Z')");
  for (const [domain, epoch] of [["MASTER_DATA", masterEpoch], ["RAW_MATERIAL_STORE", storeEpoch]] as const) {
    run(
      `INSERT OR REPLACE INTO sync_domain_leases (domain, holder_device_id, holder_label, epoch, barrier_seq, granted_at, project_key, fetched_at)
       VALUES (?, 'dev-store', 'Store PC', ?, 0, ?, 'https://test.supabase.co', ?)`,
      domain, epoch, NOW, NOW
    );
  }
};

const n = (db: SqliteDatabase, sql: string): number => Number((db.db.prepare(sql).get() as { n: number }).n);
const sendable = (db: SqliteDatabase) =>
  (db.db.prepare("SELECT dedupe_key, lease_epoch FROM sync_outbox WHERE lease_epoch IS NOT NULL ORDER BY rowid").all() as Array<Record<string, unknown>>)
    .map((row) => `${String(row.dedupe_key)}@${String(row.lease_epoch)}`);

test("before the backfill, nothing written before syncing can be sent", () => {
  withStore((db, run) => {
    seedHistory(run);
    grantBoth(run);
    buildLeasedRecordRevisions(db.db, NOW);
    buildLabelRuns(db.db, NOW);
    buildStockEvents(db.db, NOW);
    assert.deepEqual(sendable(db), [], "marked without an epoch: left for the backfill");
  });
});

test("the plan says what would go, and the backfill refuses without both leases, marking nothing", () => {
  withStore((db, run) => {
    seedHistory(run);
    const plan = db.planBackfill();
    assert.deepEqual([plan.masterEpoch, plan.storeEpoch], [null, null]);
    assert.equal(plan.masterRecords.INVENTORY_ITEM, 2);
    assert.deepEqual([plan.stockMovements, plan.labelRunsToQueue, plan.packetsToQueue], [3, 1, 2]);
    assert.deepEqual(plan.mismatches, []);

    const outcome = db.runBackfill(NOW);
    assert.deepEqual([outcome.done, outcome.done ? null : outcome.reason], [false, "NO_LEASE"]);
    assert.equal(n(db, "SELECT COUNT(*) AS n FROM sync_dirty_records WHERE lease_epoch IS NOT NULL"), 0);
  });
});

test("stock that does not add up is listed, and nothing is sent until it is decided", () => {
  withStore((db, run) => {
    seedHistory(run);
    grantBoth(run);
    run("UPDATE inventory_stock_balances SET quantity_on_hand = 7 WHERE item_id = 'i-1'");
    run("INSERT INTO inventory_units (id, code, name, created_at, updated_at) VALUES ('u-g', 'G', 'Gram', ?, ?)", NOW, NOW);
    run("INSERT INTO inventory_stock_events (id, item_id, event_type, quantity, unit_id, created_at) VALUES ('e-9', 'i-2', 'RECEIVE', 1, 'u-g', ?)", NOW);
    run("INSERT INTO inventory_stock_balances (item_id, quantity_on_hand, unit_id, updated_at) VALUES ('i-2', 1, 'u-kg', ?)", NOW);

    // These setup writes come after the leases, so they are captured as new changes. The backfill
    // must add nothing to them.
    const marksBefore = n(db, "SELECT COUNT(*) AS n FROM sync_dirty_records WHERE lease_epoch IS NOT NULL");
    const outcome = db.runBackfill(NOW);
    assert.equal(outcome.done, false);
    assert.equal(outcome.done ? null : outcome.reason, "STOCK_DOES_NOT_ADD_UP");
    assert.deepEqual(
      outcome.plan.mismatches.map((m) => [m.itemId, m.balance, m.fromMovements, m.unitDiffers]),
      [["i-1", 7, 5, false], ["i-2", 1, 1, true]],
      "a wrong balance, and a movement in another unit than the balance"
    );
    assert.equal(n(db, "SELECT COUNT(*) AS n FROM sync_dirty_records WHERE lease_epoch IS NOT NULL"), marksBefore, "the backfill marked nothing");
    assert.deepEqual(sendable(db), []);
  });
});

test("the backfill marks everything under the leases held now, and a material and its supplier travel ahead of their labels and stock", () => {
  withStore((db, run) => {
    seedHistory(run);
    grantBoth(run);
    // A movement received from another computer is not this one's to send.
    // Written as the receiver writes it: capture suppressed, stamped replicated_at.
    db.db.exec("BEGIN");
    withCaptureSuppressed(db.db, () =>
      run("INSERT INTO inventory_stock_events (id, item_id, event_type, quantity, unit_id, created_at, replicated_at) VALUES ('e-in', 'i-2', 'RECEIVE', 1, 'u-kg', ?, ?)", NOW, NOW)
    );
    db.db.exec("COMMIT");
    run("INSERT INTO inventory_stock_balances (item_id, quantity_on_hand, unit_id, updated_at) VALUES ('i-2', 1, 'u-kg', ?)", NOW);

    const outcome = db.runBackfill(NOW);
    assert.equal(outcome.done, true);
    assert.equal(n(db, "SELECT COUNT(*) AS n FROM sync_dirty_records WHERE aggregate_type = 'STOCK_EVENT' AND lease_epoch = 3"), 3, "own movements only");
    assert.equal(n(db, "SELECT COUNT(*) AS n FROM sync_dirty_records WHERE aggregate_type = 'INVENTORY_ITEM' AND lease_epoch = 2"), 2);
    assert.equal(n(db, "SELECT COUNT(*) AS n FROM sync_dirty_records WHERE aggregate_type IN ('RAW_MATERIAL_QR_BATCH', 'RAW_MATERIAL_QR') AND lease_epoch = 3"), 3, "the run and its packets, marked");
    assert.deepEqual(sendable(db), [], "nothing goes before the materials it names");
    assert.ok(db.db.prepare("SELECT 1 FROM app_settings WHERE setting_key = ?").get(BACKFILL_SETTING_KEY));

    // Labels and movements wait while their material's and supplier's revisions are still to be built.
    assert.equal(buildLabelRuns(db.db, NOW).queued, 0);
    assert.equal(buildStockEvents(db.db, NOW).queued, 0);
    buildLeasedRecordRevisions(db.db, NOW);
    assert.equal(buildLabelRuns(db.db, NOW).queued, 3, "then the run and its packets");
    assert.equal(buildStockEvents(db.db, NOW).queued, 3);
    const order = sendable(db);
    assert.ok(order.indexOf("PARTY:p-1:1@2") < order.indexOf("RAW_MATERIAL_QR_BATCH:b-1@3"), "the supplier before the run");
    assert.ok(order.indexOf("INVENTORY_ITEM:i-1:1@2") < order.indexOf("RAW_MATERIAL_QR_BATCH:b-1@3"), "the material before the run");
    assert.ok(order.indexOf("RAW_MATERIAL_QR_BATCH:b-1@3") < order.indexOf("RAW_MATERIAL_QR:q-1@3"), "the run before its packets");
    assert.ok(order.indexOf("INVENTORY_ITEM:i-1:1@2") < order.indexOf("STOCK_EVENT:e-1@3"), "the material before its stock");
  });
});

test("run twice, nothing is queued twice", () => {
  withStore((db, run) => {
    seedHistory(run);
    grantBoth(run);
    db.runBackfill(NOW);
    buildLeasedRecordRevisions(db.db, NOW);
    buildLabelRuns(db.db, NOW);
    buildStockEvents(db.db, NOW);
    const first = n(db, "SELECT COUNT(*) AS n FROM sync_outbox WHERE aggregate_type IN ('STOCK_EVENT', 'RAW_MATERIAL_QR_BATCH', 'RAW_MATERIAL_QR')");
    db.runBackfill(NOW);
    buildLeasedRecordRevisions(db.db, NOW);
    buildLabelRuns(db.db, NOW);
    buildStockEvents(db.db, NOW);
    assert.equal(n(db, "SELECT COUNT(*) AS n FROM sync_outbox WHERE aggregate_type IN ('STOCK_EVENT', 'RAW_MATERIAL_QR_BATCH', 'RAW_MATERIAL_QR')"), first);
    assert.equal(n(db, "SELECT COUNT(*) AS n FROM sync_dirty_records"), 0, "every mark settled");
  });
});

test("a lease row that does not name this computer is not a lease: never granted, or held by another", () => {
  withStore((db, run) => {
    seedHistory(run);
    grantBoth(run);
    // Never granted: the cache keeps the domain at epoch 0 with no holder.
    run("UPDATE sync_domain_leases SET holder_device_id = NULL, epoch = 0 WHERE domain = 'MASTER_DATA'");
    assert.equal(db.planBackfill().masterEpoch, null);
    // Held by another computer.
    run("UPDATE sync_domain_leases SET holder_device_id = 'dev-other', epoch = 4 WHERE domain = 'MASTER_DATA'");
    assert.equal(db.planBackfill().masterEpoch, null);
    const outcome = db.runBackfill(NOW);
    assert.equal(outcome.done ? null : outcome.reason, "NO_LEASE");
  });
});

test("labels queued without an epoch before syncing are marked and queued again, in order -- never sent ahead of their material", () => {
  withStore((db, run) => {
    seedHistory(run);
    // As an older build left them: queued when printed, with no lease known, under their print date.
    run(`INSERT INTO sync_outbox (id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json, status, available_at, attempts, created_at, updated_at)
         VALUES ('old-run', 'RAW_MATERIAL_QR_BATCH', 'b-1', 'INSERT', 'RAW_MATERIAL_QR_BATCH:b-1', '{}', 'PENDING', ?, 0, '2026-01-01T00:00:00.000Z', ?)`, NOW, NOW);
    grantBoth(run);
    assert.equal(db.planBackfill().unstampedQueued, 1);

    assert.equal(db.runBackfill(NOW).done, true);
    assert.equal(n(db, "SELECT COUNT(*) AS n FROM sync_outbox WHERE dedupe_key = 'RAW_MATERIAL_QR_BATCH:b-1'"), 0, "the unsendable copy is gone");
    buildLeasedRecordRevisions(db.db, NOW);
    buildLabelRuns(db.db, NOW);
    const order = sendable(db);
    assert.ok(order.indexOf("INVENTORY_ITEM:i-1:1@2") < order.indexOf("RAW_MATERIAL_QR_BATCH:b-1@3"), "queued again, behind its material");
    const payload = JSON.parse(String((db.db.prepare("SELECT payload_json FROM sync_outbox WHERE dedupe_key = 'RAW_MATERIAL_QR_BATCH:b-1'").get() as { payload_json: string }).payload_json)) as Record<string, unknown>;
    assert.deepEqual([payload.batchId, payload.itemId, payload.quantity], ["b-1", "i-1", 2], "rebuilt whole from the run itself");
  });
});

/** Cartons made before variants travelled (017): their qr_master queued, their variant never. */
function seedCartons(run: (sql: string, ...params: Array<string | number | null>) => void): void {
  const variant = (id: string, color: string, replicatedAt: string | null) =>
    run(
      `INSERT INTO product_variants (id, article, color, size, description, status, created_at, updated_at, replicated_at)
       VALUES (?, '777', ?, '7', NULL, 'ACTIVE', '2025-01-01T00:00:00.000Z', ?, ?)`,
      id, color, NOW, replicatedAt
    );
  variant("v-black", "Black", null); // labelled here: must travel
  variant("v-brown", "Brown", null); // never labelled: need not travel
  variant("v-blue", "Blue", NOW); // received from another computer: already in the cloud
  for (const [qrId, variantId] of [["Q-1", "v-black"], ["Q-2", "v-black"], ["Q-3", "v-blue"]]) {
    run(
      `INSERT INTO qr_master (qr_id, product_variant_id, current_status, current_location_type, created_at, updated_at)
       VALUES (?, ?, 'PRODUCED', 'FACTORY', ?, ?)`,
      qrId, variantId, NOW, NOW
    );
  }
}

const variantRows = (db: SqliteDatabase) =>
  db.db.prepare("SELECT dedupe_key, lease_epoch, created_at, payload_json FROM sync_outbox WHERE aggregate_type = 'PRODUCT_VARIANT'").all() as Array<Record<string, unknown>>;

test("the products of cartons made before variants travelled are planned and queued once -- not the unlabelled, not the received", () => {
  withStore((db, run) => {
    seedHistory(run);
    seedCartons(run);
    grantBoth(run);
    assert.equal(db.planBackfill().variantsToQueue, 1);

    assert.equal(db.runBackfill(NOW).done, true);
    const rows = variantRows(db);
    assert.deepEqual(rows.map((row) => row.dedupe_key), ["PRODUCT_VARIANT:v-black"]);
    assert.equal(rows[0]?.lease_epoch, null, "a variant is not leased: it travels with the cartons");
    assert.equal(rows[0]?.created_at, "2025-01-01T00:00:00.000Z", "dated as production would have dated it");
    assert.deepEqual(JSON.parse(String(rows[0]?.payload_json)), {
      variantId: "v-black", article: "777", color: "Black", size: "7", description: null, createdAt: "2025-01-01T00:00:00.000Z",
    });
    assert.equal(db.planBackfill().variantsToQueue, 0);

    assert.equal(db.runBackfill(NOW).done, true);
    assert.equal(variantRows(db).length, 1, "run twice, queued once");
  });
});

test("a variant production already queued is not queued again, and a refused backfill queues none", () => {
  withStore((db, run) => {
    seedHistory(run);
    seedCartons(run);
    run(
      `INSERT INTO sync_outbox (id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json, status, available_at, attempts, created_at, updated_at)
       VALUES ('o-1', 'PRODUCT_VARIANT', 'v-black', 'INSERT', 'PRODUCT_VARIANT:v-black', '{}', 'SYNCED', ?, 1, ?, ?)`,
      NOW, NOW, NOW
    );
    assert.equal(db.planBackfill().variantsToQueue, 0);
    run("DELETE FROM sync_outbox");

    assert.equal(db.planBackfill().variantsToQueue, 1);
    const outcome = db.runBackfill(NOW);
    assert.deepEqual([outcome.done, outcome.done ? null : outcome.reason], [false, "NO_LEASE"]);
    assert.equal(variantRows(db).length, 0);
  });
});
