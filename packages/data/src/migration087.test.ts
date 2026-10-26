// MIGRATION 087 STAMPS THE DOCUMENTS ALREADY HERE WITH THIS COMPUTER'S OWN ID.
//
// PC 2 took over the retired PC 1's documents under a freshly minted identity. Upgrading it from
// 0.3.6 (migrations up to 086) must record its existing numbered documents as ITS OWN -- the id in
// its device-identity.json -- not the retired machine's 'desktop-main'. These upgrade a real 0.3.6
// database exactly as the release will.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "./sqliteDatabase.js";

const SCHEMA = path.resolve(import.meta.dirname, "../src/local-schema.sql");
const MIGRATIONS = path.resolve(import.meta.dirname, "../../../migrations/sqlite");
const PC2 = "47c0dace-fe68-42cb-989c-e94f69c62c0f";
const NOW = "2026-10-20T00:00:00.000Z";

/** A database as 0.3.6 left it, holding a party and a work section, upgraded with `deviceId`. */
function upgradeFrom036(deviceId: string | null, check: (db: SqliteDatabase) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-087-"));
  const released = path.join(dir, "migrations-0.3.6");
  fs.mkdirSync(released);
  for (const file of fs.readdirSync(MIGRATIONS)) {
    if (file.endsWith(".up.sql") && Number(file.slice(0, 3)) <= 86) fs.copyFileSync(path.join(MIGRATIONS, file), path.join(released, file));
  }
  const dbPath = path.join(dir, "erp.db");
  const old = new SqliteDatabase({ dbPath, schemaPath: SCHEMA, migrationsDir: released });
  old.db.prepare(
    `INSERT INTO parties (id, party_name, party_type, party_code, status, created_at, updated_at)
     VALUES ('p-1', 'SHAN', 'SUPPLIER', 'PTY-000012', 'ACTIVE', ?, ?)`
  ).run(NOW, NOW);
  old.db.prepare("INSERT INTO work_sections (id, name, section_code, created_at, updated_at) VALUES ('ws-1', 'Cutting', 'WS-0003', ?, ?)").run(NOW, NOW);
  old.close();

  const upgraded = new SqliteDatabase({ dbPath, schemaPath: SCHEMA, migrationsDir: MIGRATIONS, migrationDeviceId: deviceId });
  try {
    check(upgraded);
  } finally {
    upgraded.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const origins = (db: SqliteDatabase): unknown[] => [
  (db.db.prepare("SELECT origin_device_id AS o FROM parties WHERE id = 'p-1'").get() as { o: unknown }).o,
  (db.db.prepare("SELECT origin_device_id AS o FROM work_sections WHERE id = 'ws-1'").get() as { o: unknown }).o,
];

const deviceSetting = (db: SqliteDatabase): unknown =>
  (db.db.prepare("SELECT setting_value AS v FROM app_settings WHERE setting_key = 'device.id'").get() as { v: unknown } | undefined)?.v;

test("an upgraded computer's existing documents are stamped with its own id, never the retired PC 1's", () => {
  upgradeFrom036(PC2, (db) => {
    assert.deepEqual(origins(db), [PC2, PC2]);
    assert.equal(deviceSetting(db), PC2);
    assert.equal(
      Number((db.db.prepare("SELECT COUNT(*) AS n FROM app_settings WHERE setting_value = 'desktop-main'").get() as { n: number }).n),
      0
    );
  });
});

test("with no identity stored yet, the documents are left unstamped -- which the number guard reads as this computer's", () => {
  upgradeFrom036(null, (db) => {
    assert.deepEqual(origins(db), [null, null]);
    assert.equal(deviceSetting(db), undefined, "set on start by ensureOperationalContext, once the identity is known");
  });
});

test("the id is bound, never pasted into the SQL", () => {
  upgradeFrom036("x'); DROP TABLE parties; --", (db) => {
    assert.deepEqual(origins(db), ["x'); DROP TABLE parties; --", "x'); DROP TABLE parties; --"]);
  });
});
