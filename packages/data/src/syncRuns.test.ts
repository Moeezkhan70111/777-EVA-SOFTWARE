import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "./sqliteDatabase.js";

// sync_runs STAYS BOUNDED. A pass runs every minute (2026-10-25), so without pruning every computer
// adds about 1,440 rows a day for ever. Idle passes go after a day, everything else after 30 days,
// and the latest successful pass is never deleted -- the Health panel's "last synced" reads it.

const SCHEMA = path.resolve(import.meta.dirname, "../src/local-schema.sql");
const NOW = Date.parse("2026-10-25T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function withDatabase(work: (db: SqliteDatabase) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-sync-runs-"));
  const db = new SqliteDatabase({ dbPath: path.join(dir, "erp.db"), schemaPath: SCHEMA });
  try {
    work(db);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A finished run, `ageMs` before NOW. */
function seedRun(db: SqliteDatabase, id: string, ageMs: number, outcome: string | null, counts: { pushed?: number; fetched?: number; refused?: number } = {}): void {
  const at = new Date(NOW - ageMs).toISOString();
  db.db
    .prepare(
      `INSERT INTO sync_runs (id, started_at, finished_at, trigger, outcome, pushed, fetched, applied, duplicates, refused)
       VALUES (?, ?, ?, 'TIMER', ?, ?, ?, 0, 0, ?)`
    )
    .run(id, at, outcome === null ? null : at, outcome, counts.pushed ?? 0, counts.fetched ?? 0, counts.refused ?? 0);
}

const remaining = (db: SqliteDatabase): string[] =>
  (db.db.prepare("SELECT id FROM sync_runs ORDER BY id").all() as Array<{ id: string }>).map((row) => row.id);

test("idle passes go after a day, passes that did something stay for 30 days", () => {
  withDatabase((db) => {
    seedRun(db, "idle-recent", 2 * HOUR, "OK");
    seedRun(db, "idle-old", 25 * HOUR, "OK");
    seedRun(db, "pushed-old", 25 * HOUR, "OK", { pushed: 11 });
    seedRun(db, "fetched-old", 10 * DAY, "OK", { fetched: 11 });
    seedRun(db, "refused-old", 3 * DAY, "OK", { refused: 1 });
    seedRun(db, "failed-old", 3 * DAY, "TRANSPORT_ERROR");
    seedRun(db, "ancient", 31 * DAY, "OK", { pushed: 4 });
    seedRun(db, "open-ancient", 31 * DAY, null);
    assert.equal(db.pruneSyncRuns(NOW), 3);
    assert.deepEqual(remaining(db), ["failed-old", "fetched-old", "idle-recent", "pushed-old", "refused-old"]);
  });
});

test("the latest successful pass survives however old it is, so 'last synced' never goes blank", () => {
  withDatabase((db) => {
    seedRun(db, "last-success", 40 * DAY, "OK");
    seedRun(db, "failure-after", 2 * DAY, "TRANSPORT_ERROR");
    db.pruneSyncRuns(NOW);
    assert.deepEqual(remaining(db), ["failure-after", "last-success"]);
    assert.equal(db.syncRunSummary().lastSuccess?.id, "last-success");
  });
});

test("closing a pass prunes, so the table cannot grow while the computer runs", () => {
  withDatabase((db) => {
    seedRun(db, "idle-old", 2 * DAY, "OK");
    const id = db.startSyncRun("TIMER");
    db.finishSyncRun(id, "OK", { pushed: 0, fetched: 0 });
    assert.deepEqual(remaining(db), [id].sort());
  });
});
