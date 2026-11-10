// THE COLOUR LIST (local migration 106, docs/45).
//
// Every computer starts with the same list, under the same record ids, and the seed is not queued as a change. An
// existing database upgrades to 106 without any colour stored anywhere changing. Adding, editing and removing a
// mapping are this computer's own master-data changes: captured for sync, refused when they would make one English
// colour mean two things, and still there after the database is closed and opened again.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { COLOR_TRANSLATION_ERROR, DEFAULT_COLOR_TRANSLATIONS, seededColorTranslationId } from "@erp/domain";
import { ColorTranslationRefusedError, SqliteDatabase, buildLeasedRecordRevisions } from "./sqliteDatabase.js";

const SCHEMA = path.resolve(import.meta.dirname, "../src/local-schema.sql");
const MIGRATIONS = path.resolve(import.meta.dirname, "../../../migrations/sqlite");

function withDatabase(check: (open: () => SqliteDatabase) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-106-"));
  const dbPath = path.join(dir, "erp.db");
  const opened: SqliteDatabase[] = [];
  try {
    check(() => {
      const db = new SqliteDatabase({ dbPath, schemaPath: SCHEMA, migrationsDir: MIGRATIONS });
      opened.push(db);
      return db;
    });
  } finally {
    for (const db of opened) {
      try { db.close(); } catch { /* closed by the check */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const refusal = (code: string) => (error: unknown): boolean => error instanceof ColorTranslationRefusedError && error.code === code;

const marks = (db: SqliteDatabase): string[] =>
  (db.db.prepare("SELECT record_id FROM sync_dirty_records WHERE aggregate_type = 'COLOR_TRANSLATION' ORDER BY record_id").all() as Array<{ record_id: string }>).map((row) => row.record_id);

test("every computer starts with the same 23 mappings, under the same ids, spelled exactly as the list in @erp/domain", () => {
  withDatabase((open) => {
    const db = open();
    const stored = db.listColorTranslations();
    assert.equal(stored.length, DEFAULT_COLOR_TRANSLATIONS.length);
    for (const expected of DEFAULT_COLOR_TRANSLATIONS) {
      const row = stored.find((entry) => entry.id === seededColorTranslationId(expected.english));
      assert.ok(row, `${expected.english} is seeded`);
      assert.equal(row.englishName, expected.english);
      assert.equal(row.urduName, expected.urdu, `${expected.english}: Urdu byte for byte`);
    }
    assert.deepEqual(marks(db), [], "the seed is not queued as this computer's change");
  });
});

test("add, edit and delete are captured for sync, and survive closing and opening the database", () => {
  withDatabase((open) => {
    const first = open();
    const purple = first.createColorTranslation({ englishName: "  Purple  ", urduName: " پرپل " });
    assert.deepEqual({ englishName: purple.englishName, urduName: purple.urduName }, { englishName: "Purple", urduName: "پرپل" });
    first.updateColorTranslation(seededColorTranslationId("Black"), { englishName: "Black", urduName: "کالا" });
    first.deleteColorTranslation(seededColorTranslationId("Sky"));
    assert.deepEqual(marks(first), [purple.id, seededColorTranslationId("Black"), seededColorTranslationId("Sky")].sort());
    first.close();

    const reopened = open();
    const list = reopened.listColorTranslations();
    assert.equal(list.find((entry) => entry.id === purple.id)?.urduName, "پرپل");
    assert.equal(list.find((entry) => entry.englishName === "Black")?.urduName, "کالا");
    assert.equal(list.some((entry) => entry.englishName === "Sky"), false);
  });
});

test("under the master-data lease, a colour change is queued for the other computers as a whole record", () => {
  withDatabase((open) => {
    const db = open();
    const now = "2026-11-10T00:00:00.000Z";
    db.db.prepare("INSERT OR REPLACE INTO app_settings (setting_key, setting_value, value_type, is_encrypted, updated_by, updated_at) VALUES ('device.id', 'dev-1', 'string', 0, 'test', ?)").run(now);
    db.db
      .prepare(
        `INSERT OR REPLACE INTO sync_domain_leases (domain, holder_device_id, holder_label, epoch, barrier_seq, granted_at, project_key, fetched_at)
         VALUES ('MASTER_DATA', 'dev-1', 'Store PC', 4, 0, ?, 'https://test.supabase.co', ?)`
      )
      .run(now, now);
    db.updateColorTranslation(seededColorTranslationId("Black"), { englishName: "Black", urduName: "کالا" });
    const built = buildLeasedRecordRevisions(db.db, now);
    assert.equal(built.queued, 1, "the outbox takes the new record type");
    const queued = db.db.prepare("SELECT aggregate_id, payload_json, lease_epoch FROM sync_outbox WHERE aggregate_type = 'COLOR_TRANSLATION'").get() as
      | { aggregate_id: string; payload_json: string; lease_epoch: number }
      | undefined;
    assert.equal(queued?.aggregate_id, "color:black");
    assert.equal(queued?.lease_epoch, 4);
    const payload = JSON.parse(queued?.payload_json ?? "{}") as { body?: { row?: Record<string, unknown> } };
    assert.equal(payload.body?.row?.urdu_name, "کالا", "Urdu travels exactly as stored");
  });
});

test("one English colour is one mapping, however it is written", () => {
  withDatabase((open) => {
    const db = open();
    assert.throws(() => db.createColorTranslation({ englishName: "BLACK", urduName: "کالا" }), refusal(COLOR_TRANSLATION_ERROR.DUPLICATE_ENGLISH));
    assert.throws(() => db.createColorTranslation({ englishName: " army   green ", urduName: "گرین" }), refusal(COLOR_TRANSLATION_ERROR.DUPLICATE_ENGLISH));
    assert.throws(
      () => db.updateColorTranslation(seededColorTranslationId("Red"), { englishName: "black", urduName: "لال" }),
      refusal(COLOR_TRANSLATION_ERROR.DUPLICATE_ENGLISH),
      "renaming onto another colour's name"
    );
    // Renaming a mapping onto its own key (a change of case) is not a duplicate.
    assert.equal(db.updateColorTranslation(seededColorTranslationId("Red"), { englishName: "RED", urduName: "لال" }).englishName, "RED");
    assert.equal(db.listColorTranslations().filter((entry) => entry.englishName.toLowerCase() === "black").length, 1);
  });
});

test("an invalid or missing entry is refused, and writes nothing", () => {
  withDatabase((open) => {
    const db = open();
    const before = db.listColorTranslations().length;
    assert.throws(() => db.createColorTranslation({ englishName: "", urduName: "سیاہ" }), refusal(COLOR_TRANSLATION_ERROR.ENGLISH_REQUIRED));
    assert.throws(() => db.createColorTranslation({ englishName: "Teal", urduName: "Teal" }), refusal(COLOR_TRANSLATION_ERROR.URDU_NOT_URDU));
    assert.throws(() => db.updateColorTranslation("no-such-id", { englishName: "Teal", urduName: "ٹیل" }), refusal(COLOR_TRANSLATION_ERROR.NOT_FOUND));
    assert.throws(() => db.deleteColorTranslation("no-such-id"), refusal(COLOR_TRANSLATION_ERROR.NOT_FOUND));
    assert.equal(db.listColorTranslations().length, before);
  });
});

test("the down script takes the list away and puts the outbox back, keeping its rows", () => {
  withDatabase((open) => {
    const db = open();
    const now = "2026-11-10T00:00:00.000Z";
    db.db
      .prepare(
        `INSERT INTO sync_outbox (id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json, status, available_at, created_at, updated_at)
         VALUES ('o-1', 'PARTY', 'p-1', 'INSERT', 'PARTY:p-1:1', '{}', 'PENDING', ?, ?, ?)`
      )
      .run(now, now, now);
    const down = fs.readFileSync(path.join(MIGRATIONS, "106_color_translations.down.sql"), "utf8");
    db.db.exec(`BEGIN; ${down} COMMIT;`);
    assert.equal(db.db.prepare("SELECT 1 AS found FROM sqlite_master WHERE name = 'color_translations'").get(), undefined);
    assert.equal((db.db.prepare("SELECT COUNT(*) AS n FROM sync_outbox").get() as { n: number }).n, 1, "the queued row is kept");
    assert.throws(
      () =>
        db.db
          .prepare(
            `INSERT INTO sync_outbox (id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json, status, available_at, created_at, updated_at)
             VALUES ('o-2', 'COLOR_TRANSLATION', 'c', 'INSERT', 'c', '{}', 'PENDING', ?, ?, ?)`
          )
          .run(now, now, now),
      /CHECK constraint failed/,
      "the old outbox no longer takes the type"
    );
  });
});
