// MIGRATION 105 ADDS REQUEST IDS TO DOCUMENTS, AND TAKES NOTHING AWAY.
//
// A real database at 104 holding a gatepass, its bill and a cash voucher is upgraded exactly as a release would
// upgrade it: every row and every value it held is still there, the new columns are NULL on old rows, and the
// partial unique indexes allow any number of NULLs but never one request id twice. The down script then puts the
// schema back, and an older build refuses a 105 database rather than misread it.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "./sqliteDatabase.js";

const SCHEMA = path.resolve(import.meta.dirname, "../src/local-schema.sql");
const MIGRATIONS = path.resolve(import.meta.dirname, "../../../migrations/sqlite");
const NOW = "2026-11-09T00:00:00.000Z";

/** A migrations folder holding exactly the files up to `last`, as a build of that level ships them. */
function migrationsUpTo(dir: string, last: number): string {
  const folder = path.join(dir, `migrations-${last}`);
  if (fs.existsSync(folder)) return folder;
  fs.mkdirSync(folder);
  for (const file of fs.readdirSync(MIGRATIONS)) {
    if (file.endsWith(".up.sql") && Number(file.slice(0, 3)) <= last) fs.copyFileSync(path.join(MIGRATIONS, file), path.join(folder, file));
  }
  return folder;
}

const DOCUMENTS = ["gatepasses", "sale_vouchers", "cash_vouchers", "cash_voucher_lines"] as const;

/** Every row of the document tables, every column but the new ones, as text: what an upgrade must not change. */
function snapshot(db: SqliteDatabase): string {
  return DOCUMENTS.map((table) => {
    const columns = (db.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((c) => c.name)
      .filter((name) => name !== "request_id" && name !== "request_fingerprint");
    return JSON.stringify(db.db.prepare(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY id`).all());
  }).join("\n");
}

const columnsOf = (db: SqliteDatabase, table: string): string[] =>
  (db.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
const indexExists = (db: SqliteDatabase, name: string): boolean =>
  Boolean(db.db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'index' AND name = ?").get(name));

/** A database at 104 with a party, a gatepass, its bill and a cash voucher with one line. */
function seed104(dbPath: string, migrationsDir: string): void {
  const db = new SqliteDatabase({ dbPath, schemaPath: SCHEMA, migrationsDir });
  db.db.prepare("INSERT INTO parties (id, party_code, party_name, party_type, status, created_at, updated_at) VALUES ('p-1', 'PTY-000001', 'MAMA CHAPPAL', 'CUSTOMER', 'ACTIVE', ?, ?)").run(NOW, NOW);
  db.db.prepare("INSERT INTO gatepasses (id, gatepass_number, party_id, gatepass_date, status, total_quantity, created_by, created_at, updated_at) VALUES ('g-1', 7, 'p-1', '2026-11-08', 'CREATED', 6, 'clerk', ?, ?)").run(NOW, NOW);
  db.db.prepare("INSERT INTO sale_vouchers (id, voucher_number, party_id, voucher_date, book_no, status, total_quantity, total_amount_paisa, gatepass_id, created_at, updated_at) VALUES ('s-1', '41', 'p-1', '2026-11-08', 'B1', 'DRAFT', 0, 0, 'g-1', ?, ?)").run(NOW, NOW);
  db.db.prepare("INSERT INTO cash_vouchers (id, voucher_number, party_id, voucher_date, description, mode_of_transfer, receipt_amount_paisa, payment_amount_paisa, status, created_at, updated_at) VALUES ('c-1', 12, 'p-1', '2026-11-08', 'paid', 'Cash', 100000, 0, 'ACTIVE', ?, ?)").run(NOW, NOW);
  db.db.prepare("INSERT INTO cash_voucher_lines (id, voucher_id, party_id, description, mode_of_transfer, receipt_amount_paisa, payment_amount_paisa, created_at) VALUES ('l-1', 'c-1', 'p-1', 'paid', 'Cash', 100000, 0, ?)").run(NOW);
  db.close();
}

function withUpgraded(check: (db: SqliteDatabase, before: string, dir: string, dbPath: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-105-"));
  const dbPath = path.join(dir, "erp.db");
  try {
    const old = migrationsUpTo(dir, 104);
    seed104(dbPath, old);
    const at104 = new SqliteDatabase({ dbPath, schemaPath: SCHEMA, migrationsDir: old });
    const before = snapshot(at104);
    assert.equal(columnsOf(at104, "gatepasses").includes("request_id"), false, "104 has no request columns");
    at104.close();
    const upgraded = new SqliteDatabase({ dbPath, schemaPath: SCHEMA, migrationsDir: MIGRATIONS });
    try {
      check(upgraded, before, dir, dbPath);
    } finally {
      try { upgraded.close(); } catch { /* already closed by the check */ }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("an existing database upgrades to 105 with every document and every value it held", () => {
  withUpgraded((db, before) => {
    assert.equal(snapshot(db), before, "nothing that was there has changed");
    assert.ok(db.db.prepare("SELECT 1 AS found FROM schema_migrations WHERE version LIKE '105%'").get(), "105 is recorded as applied");
    for (const table of ["gatepasses", "sale_vouchers"]) {
      assert.ok(columnsOf(db, table).includes("request_id") && columnsOf(db, table).includes("request_fingerprint"), `${table} gained both columns`);
    }
    assert.ok(columnsOf(db, "cash_vouchers").includes("request_fingerprint"));
    assert.equal(columnsOf(db, "cash_vouchers").includes("request_id"), false, "a cash voucher's id is already its request id");
    const nulls = db.db.prepare(
      `SELECT (SELECT COUNT(*) FROM gatepasses WHERE request_id IS NULL AND request_fingerprint IS NULL)
            + (SELECT COUNT(*) FROM sale_vouchers WHERE request_id IS NULL AND request_fingerprint IS NULL)
            + (SELECT COUNT(*) FROM cash_vouchers WHERE request_fingerprint IS NULL) AS n`
    ).get() as { n: number };
    assert.equal(Number(nulls.n), 3, "old documents carry no request");
    assert.ok(indexExists(db, "idx_gatepasses_request") && indexExists(db, "idx_sale_vouchers_request"));
  });
});

test("after 105, any number of documents may have no request id, but one request id is one document", () => {
  withUpgraded((db) => {
    const insert = (id: string, number: number, requestId: string | null) =>
      db.db.prepare("INSERT INTO gatepasses (id, gatepass_number, party_id, gatepass_date, status, total_quantity, created_by, created_at, updated_at, request_id) VALUES (?, ?, 'p-1', '2026-11-09', 'CREATED', 1, 'clerk', ?, ?, ?)").run(id, number, NOW, NOW, requestId);
    insert("g-2", 8, null);
    insert("g-3", 9, null);
    insert("g-4", 10, "7d3f6a7e-0c1b-4f6e-9a55-1c2d3e4f5a6b");
    assert.throws(() => insert("g-5", 11, "7d3f6a7e-0c1b-4f6e-9a55-1c2d3e4f5a6b"), /UNIQUE constraint failed/);
    const insertBill = (id: string, number: string, requestId: string) =>
      db.db.prepare("INSERT INTO sale_vouchers (id, voucher_number, party_id, voucher_date, book_no, status, total_quantity, total_amount_paisa, created_at, updated_at, request_id) VALUES (?, ?, 'p-1', '2026-11-09', '', 'DRAFT', 0, 0, ?, ?, ?)").run(id, number, NOW, NOW, requestId);
    insertBill("s-2", "42", "0b9c8d7e-6f5a-4b3c-8d2e-1f0a9b8c7d6e");
    assert.throws(() => insertBill("s-3", "43", "0b9c8d7e-6f5a-4b3c-8d2e-1f0a9b8c7d6e"), /UNIQUE constraint failed/);
  });
});

test("an older build refuses a 105 database, changing nothing; the down script puts 104 back, keeping every row", () => {
  withUpgraded((db, before, dir, dbPath) => {
    db.close();
    const old = migrationsUpTo(dir, 104);
    assert.throws(() => new SqliteDatabase({ dbPath, schemaPath: SCHEMA, migrationsDir: old }), /created by a newer version of 777 ERP/);

    // Rollback, as an operator would run it by hand: the down script, then the version forgotten.
    const reopened = new SqliteDatabase({ dbPath, schemaPath: SCHEMA, migrationsDir: MIGRATIONS });
    const down = fs.readFileSync(path.join(MIGRATIONS, "105_document_request_ids.down.sql"), "utf8");
    reopened.db.exec("BEGIN IMMEDIATE TRANSACTION");
    for (const statement of down.replace(/--[^\n]*/g, "").split(";").map((s) => s.trim()).filter(Boolean)) reopened.db.exec(statement);
    reopened.db.prepare("DELETE FROM schema_migrations WHERE version LIKE '105%'").run();
    reopened.db.exec("COMMIT");
    reopened.close();

    const back = new SqliteDatabase({ dbPath, schemaPath: SCHEMA, migrationsDir: old });
    try {
      assert.equal(snapshot(back), before, "every row and value is still there");
      for (const table of ["gatepasses", "sale_vouchers", "cash_vouchers"]) {
        assert.equal(columnsOf(back, table).some((name) => name.startsWith("request_")), false, `${table} is as 104 left it`);
      }
      assert.equal(indexExists(back, "idx_gatepasses_request") || indexExists(back, "idx_sale_vouchers_request"), false);
    } finally {
      back.close();
    }
  });
});
