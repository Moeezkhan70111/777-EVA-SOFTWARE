import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MASTER_CAPTURE,
  SqliteDatabase,
  captureTriggerName,
  withCaptureSuppressed,
} from "./sqliteDatabase.js";

// MASTER DATA IS MARKED BY THE DATABASE (migration 094, database/masterCapture.ts).
//
// The capture triggers replace "every write path remembers to queue its record". These tests prove
// they cover every master table (and fail on a new table nobody classified), mark the right RECORD
// for a child row, coalesce, carry the lease epoch of the moment, stay off for suppressed writes,
// and never fire during a migration.

const SCHEMA = path.resolve(import.meta.dirname, "../src/local-schema.sql");
const MIGRATIONS = path.resolve(import.meta.dirname, "../../../migrations/sqlite");
const NOW = "2026-10-25T10:00:00.000Z";

/**
 * Every table that is NOT master data, and why. With MASTER_CAPTURE it must name every table in
 * the database: a new table appears in neither, and the coverage test below fails until someone
 * decides which it is.
 */
const NOT_MASTER: Readonly<Record<string, readonly string[]>> = {
  "Carton and QR flows: multi-writer events and their projections (docs/37 W.1), not leased records": [
    "production_events", "qr_master", "qr_codes", "qr_batches", "store_receiving_sessions",
    "store_move_out_sessions", "dispatch_sessions", "stock_projection_by_location",
    "stock_projection_by_variant", "report_daily_summary",
  ],
  "Installation identity, provisioned per computer and mirrored by the owner, not replicated as master data": [
    "factories", "workstations", "devices", "operators",
  ],
  "Products and their classification: master data, but not in Milestone 1 (variants travel as identities, 008)": [
    "article_series", "article_size_migration_diagnostics", "article_size_packing_items", "article_sizes",
    "main_groups", "product_groups", "product_sub_groups", "product_types", "product_variants", "sole_types",
  ],
  "The raw material store: leased EVENTS and their derived balances, not records replaced whole": [
    "inventory_stock_balances", "inventory_stock_events", "raw_material_issue_sessions", "raw_material_qr_batches",
    "raw_material_qr_events", "raw_material_qrs", "raw_material_receiving_sessions", "inventory_item_audit",
  ],
  "Sales and dispatch documents and pricing: Milestone 2": [
    "gatepasses", "gatepass_lines", "gatepass_delivery_proofs", "sale_vouchers", "sale_voucher_line_items",
    "sale_returns", "party_article_discounts", "party_article_series_discounts", "party_price_range_discounts",
    "party_product_group_discounts",
  ],
  "Accounts documents: Milestone 2": ["cash_vouchers", "cash_voucher_lines", "purchase_vouchers", "purchase_voucher_line_items"],
  "Machine programs: Milestone 2": [
    "machine_programs", "machine_program_article_rates", "machine_program_b_conversions", "machine_program_carton_labels",
    "machine_program_closures", "machine_program_fix_carton_labels", "machine_program_issue_batches",
    "machine_program_lines", "machine_program_reconciliation_lines", "machine_program_runs",
    "machine_program_upper_b_labels", "machine_program_upper_lines", "manual_production_entries",
  ],
  "Approvals: transitions, Milestone 2": [
    "access_requests", "permission_requests", "party_claims", "removal_requests", "stock_correction_requests",
  ],
  "People and access: cloud-authoritative under docs/37 U.2, never replicated as records": [
    "app_users", "roles", "role_permissions", "user_role_assignments", "user_additional_permissions",
    "job_role_options", "user_notifications", "user_sessions",
  ],
  "Workspace messages and tasks: per installation": [
    "workspace_activity", "workspace_conversation_members", "workspace_conversations", "workspace_messages",
    "workspace_requests", "workspace_tasks",
  ],
  "This computer's own state: never replicated (replicationScope.ts)": [
    "app_settings", "audit_log", "backup_history", "metrics_counters", "metrics_timeseries", "schema_migrations",
    "system_health_snapshots", "qr_sequences", "raw_material_qr_sequences", "sync_capture", "sync_dirty_records",
    "sync_record_revisions", "sync_displaced_records", "sync_domain_leases", "sync_inbox_parked", "sync_outbox", "sync_runs",
  ],
};

function openDatabase(migrationsDir = MIGRATIONS): { db: SqliteDatabase; dir: string; close: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-capture-"));
  const db = new SqliteDatabase({ dbPath: path.join(dir, "erp.db"), schemaPath: SCHEMA, migrationsDir });
  return { db, dir, close: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const marks = (db: SqliteDatabase): Array<{ aggregate_type: string; record_id: string; lease_epoch: number | null }> =>
  (db.db.prepare("SELECT aggregate_type, record_id, lease_epoch FROM sync_dirty_records ORDER BY aggregate_type, record_id").all() as Array<Record<string, unknown>>)
    .map((row) => ({ aggregate_type: String(row.aggregate_type), record_id: String(row.record_id), lease_epoch: row.lease_epoch === null ? null : Number(row.lease_epoch) }));

const clearMarks = (db: SqliteDatabase) => db.db.exec("DELETE FROM sync_dirty_records");

// ─── Coverage ───────────────────────────────────────────────────────────────

test("every table is either captured master data or classified as not master data, with a reason", () => {
  const { db, close } = openDatabase();
  try {
    const tables = (db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>)
      .map((row) => row.name);
    const master = new Set(MASTER_CAPTURE.map((capture) => capture.table));
    const notMaster = new Set(Object.values(NOT_MASTER).flat());
    const unclassified = tables.filter((table) => !master.has(table) && !notMaster.has(table));
    assert.deepEqual(unclassified, [], "a new table: add it to MASTER_CAPTURE (with its record), or to NOT_MASTER with why");
    // And no table is in both lists, or listed but gone.
    assert.deepEqual([...master].filter((table) => notMaster.has(table)), []);
    const present = new Set(tables);
    assert.deepEqual([...master, ...notMaster].filter((table) => !present.has(table)), [], "a listed table no longer exists");
  } finally {
    close();
  }
});

test("every master table has its insert, update and delete triggers after the database opens", () => {
  const { db, close } = openDatabase();
  try {
    const triggers = new Set((db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>).map((row) => row.name));
    for (const capture of MASTER_CAPTURE) {
      for (const suffix of ["ins", "upd", "del"] as const) {
        assert.ok(triggers.has(captureTriggerName(capture.table, suffix)), `${capture.table} has no ${suffix} capture trigger`);
      }
    }
  } finally {
    close();
  }
});

// ─── What is marked ─────────────────────────────────────────────────────────

const seedLease = (db: SqliteDatabase, epoch: number) =>
  db.db.prepare(
    `INSERT OR REPLACE INTO sync_domain_leases (domain, holder_device_id, holder_label, epoch, barrier_seq, granted_at, project_key, fetched_at)
     VALUES ('MASTER_DATA', 'dev-1', 'Store PC', ?, 0, ?, 'https://test.supabase.co', ?)`
  ).run(epoch, NOW, NOW);

function seedMaterial(db: SqliteDatabase, itemId: string): void {
  const run = (sql: string, ...params: Array<string | number>) => db.db.prepare(sql).run(...params);
  run("INSERT OR IGNORE INTO inventory_units (id, code, name, created_at, updated_at) VALUES ('u-kg', 'KG', 'Kilogram', ?, ?)", NOW, NOW);
  run("INSERT OR IGNORE INTO inventory_categories (id, category_code, name, created_at, updated_at) VALUES ('c-1', 'C1', 'Leather', ?, ?)", NOW, NOW);
  run("INSERT OR IGNORE INTO inventory_category_fields (id, category_id, field_key, label, field_type, created_at, updated_at) VALUES ('f-1', 'c-1', 'colour', 'Colour', 'DROPDOWN', ?, ?)", NOW, NOW);
  run(
    "INSERT INTO inventory_items (id, item_code, category_id, display_name, signature_hash, created_at, updated_at) VALUES (?, ?, 'c-1', ?, ?, ?, ?)",
    itemId, `RM-${itemId}`, `Leather ${itemId}`, `sig-${itemId}`, NOW, NOW
  );
  run("INSERT INTO inventory_item_values (id, item_id, field_id, text_value) VALUES (?, ?, 'f-1', 'BLACK')", `v-${itemId}`, itemId);
  run(
    "INSERT INTO inventory_item_unit_steps (id, item_id, step_order, from_unit_id, to_unit_id, factor, created_at, updated_at) VALUES (?, ?, 0, 'u-kg', 'u-kg-g', 1000, ?, ?)",
    `s-${itemId}`, itemId, NOW, NOW
  );
}

test("a child row marks its RECORD, with the master-data lease epoch held at that moment", () => {
  const { db, close } = openDatabase();
  try {
    db.db.exec("PRAGMA foreign_keys = OFF");
    seedLease(db, 5);
    seedMaterial(db, "i-1");
    // The unit, the category (its field) and the material (its values and unit steps): three records.
    assert.deepEqual(marks(db), [
      { aggregate_type: "INVENTORY_CATEGORY", record_id: "c-1", lease_epoch: 5 },
      { aggregate_type: "INVENTORY_ITEM", record_id: "i-1", lease_epoch: 5 },
      { aggregate_type: "INVENTORY_UNIT", record_id: "u-kg", lease_epoch: 5 },
    ]);
    // An option marks the category through its field.
    clearMarks(db);
    db.db.prepare("INSERT INTO inventory_category_field_options (id, field_id, option_value, display_label) VALUES ('o-1', 'f-1', 'RED', 'Red')").run();
    assert.deepEqual(marks(db), [{ aggregate_type: "INVENTORY_CATEGORY", record_id: "c-1", lease_epoch: 5 }]);
    // A later write under a later lease carries the later epoch.
    seedLease(db, 6);
    db.db.prepare("UPDATE inventory_item_values SET text_value = 'BROWN' WHERE item_id = 'i-1'").run();
    assert.deepEqual(marks(db).find((mark) => mark.record_id === "i-1"), { aggregate_type: "INVENTORY_ITEM", record_id: "i-1", lease_epoch: 6 });
  } finally {
    close();
  }
});

test("moving a child to another record marks both, and deleting marks the record that lost it", () => {
  const { db, close } = openDatabase();
  try {
    db.db.exec("PRAGMA foreign_keys = OFF");
    seedMaterial(db, "i-1");
    db.db.prepare("INSERT INTO inventory_categories (id, category_code, name, created_at, updated_at) VALUES ('c-2', 'C2', 'Rubber', ?, ?)").run(NOW, NOW);
    clearMarks(db);
    db.db.prepare("UPDATE inventory_category_fields SET category_id = 'c-2' WHERE id = 'f-1'").run();
    assert.deepEqual(marks(db).map((mark) => mark.record_id), ["c-1", "c-2"]);
    clearMarks(db);
    db.db.prepare("DELETE FROM inventory_items WHERE id = 'i-1'").run();
    assert.deepEqual(marks(db).map((mark) => `${mark.aggregate_type}:${mark.record_id}`), ["INVENTORY_ITEM:i-1"]);
    // Without a lease (a standalone computer) the mark has no epoch, and waits for the backfill.
    assert.equal(marks(db)[0]?.lease_epoch, null);
  } finally {
    close();
  }
});

test("bulk: many writes to one record are one mark, and 400 materials are 400 marks, not 1,200", () => {
  const { db, close } = openDatabase();
  try {
    db.db.exec("PRAGMA foreign_keys = OFF");
    seedMaterial(db, "i-1");
    clearMarks(db);
    for (let edit = 0; edit < 50; edit += 1) {
      db.db.prepare("UPDATE inventory_items SET display_name = ? WHERE id = 'i-1'").run(`Leather ${edit}`);
    }
    assert.equal(marks(db).length, 1);

    clearMarks(db);
    db.db.exec("BEGIN");
    for (let n = 0; n < 400; n += 1) seedMaterial(db, `bulk-${n}`);
    db.db.exec("COMMIT");
    // Each material wrote three rows (item, value, unit step); each is still one record.
    assert.equal(marks(db).filter((mark) => mark.aggregate_type === "INVENTORY_ITEM").length, 400);
  } finally {
    close();
  }
});

// ─── When nothing is marked ─────────────────────────────────────────────────

test("a suppressed write marks nothing, the switch is back afterwards, and it refuses to run outside a transaction", () => {
  const { db, close } = openDatabase();
  try {
    db.db.exec("PRAGMA foreign_keys = OFF");
    db.db.exec("BEGIN");
    withCaptureSuppressed(db.db, () => seedMaterial(db, "applied-from-another-computer"));
    db.db.exec("COMMIT");
    assert.deepEqual(marks(db), []);
    const switchRow = db.db.prepare("SELECT suppressed FROM sync_capture WHERE id = 1").get() as { suppressed: number };
    assert.equal(switchRow.suppressed, 0);
    // A failure inside still puts the switch back, and the rollback takes the writes with it.
    db.db.exec("BEGIN");
    assert.throws(() => withCaptureSuppressed(db.db, () => { throw new Error("boom"); }));
    db.db.exec("ROLLBACK");
    assert.equal((db.db.prepare("SELECT suppressed FROM sync_capture WHERE id = 1").get() as { suppressed: number }).suppressed, 0);
    assert.throws(() => withCaptureSuppressed(db.db, () => undefined), /inside a transaction/);
  } finally {
    close();
  }
});

test("a migration never fires the triggers, and they are back, complete, once it has run", () => {
  // A copy of the real migrations, so one extra migration can be added that rewrites master data.
  const migrations = fs.mkdtempSync(path.join(os.tmpdir(), "erp-capture-migrations-"));
  for (const file of fs.readdirSync(MIGRATIONS)) fs.copyFileSync(path.join(MIGRATIONS, file), path.join(migrations, file));
  const first = openDatabase(migrations);
  try {
    first.db.db.exec("PRAGMA foreign_keys = OFF");
    seedMaterial(first.db, "i-1");
    clearMarks(first.db);
    first.db.close();

    // A bulk UPDATE and a table rebuild, as a real migration would do them.
    fs.writeFileSync(
      path.join(migrations, "999_test_rewrite_master.up.sql"),
      [
        "UPDATE inventory_items SET display_name = display_name || ' (renamed)'",
        "CREATE TABLE work_sections_rebuilt AS SELECT * FROM work_sections",
        "DROP TABLE work_sections",
        "ALTER TABLE work_sections_rebuilt RENAME TO work_sections",
      ].join(";\n") + ";\n"
    );
    const reopened = new SqliteDatabase({ dbPath: path.join(first.dir, "erp.db"), schemaPath: SCHEMA, migrationsDir: migrations });
    try {
      assert.deepEqual(marks(reopened), [], "the migration marked nothing");
      const renamed = reopened.db.prepare("SELECT display_name FROM inventory_items WHERE id = 'i-1'").get() as { display_name: string };
      assert.match(renamed.display_name, /\(renamed\)$/, "and it did run");
      // The rebuilt table lost its triggers with the old table; the start put them back.
      const triggers = reopened.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'work_sections'").get() as { n: number };
      assert.equal(Number(triggers.n), 3);
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(first.dir, { recursive: true, force: true });
    fs.rmSync(migrations, { recursive: true, force: true });
  }
});
