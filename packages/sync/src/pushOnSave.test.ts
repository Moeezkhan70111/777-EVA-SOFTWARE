import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { LEASED_AGGREGATE_DOMAIN } from "@erp/data";
import { installPushOnSaveSignal } from "./pushOnSave.js";

// Push on save, at the moment of the save: a signal exactly when a save queues something a pass
// would send -- the watcher's own conditions -- that can never fail the save, and leaves nothing in
// the database file.

const UNLEASED = "QR_MASTER";
const LEASED = Object.keys(LEASED_AGGREGATE_DOMAIN)[0];
const PUSHABLE = [UNLEASED, LEASED];

function connection(onQueued: () => void = () => undefined): { db: DatabaseSync; signals: () => number } {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE sync_outbox (id TEXT PRIMARY KEY, aggregate_type TEXT NOT NULL, status TEXT NOT NULL, lease_epoch INTEGER);
           CREATE TABLE sync_dirty_records (aggregate_type TEXT NOT NULL, record_id TEXT NOT NULL, lease_epoch INTEGER,
             marked_at TEXT NOT NULL, PRIMARY KEY (aggregate_type, record_id));`);
  let count = 0;
  installPushOnSaveSignal(db, PUSHABLE, () => {
    count += 1;
    onQueued();
  });
  return { db, signals: () => count };
}

let row = 0;
const queue = (db: DatabaseSync, type: string, status = "PENDING", epoch: number | null = null): void => {
  row += 1;
  db.prepare("INSERT INTO sync_outbox (id, aggregate_type, status, lease_epoch) VALUES (?, ?, ?, ?)").run(`row-${String(row)}`, type, status, epoch);
};
const mark = (db: DatabaseSync, id: string, epoch: number | null): void => {
  db.prepare(
    `INSERT INTO sync_dirty_records (aggregate_type, record_id, lease_epoch, marked_at) VALUES ('PARTY', ?, ?, '2026-10-28T00:00:00Z')
     ON CONFLICT (aggregate_type, record_id) DO UPDATE SET lease_epoch = excluded.lease_epoch, marked_at = excluded.marked_at`
  ).run(id, epoch);
};

test("signals when a save queues a row a pass would send", () => {
  const { db, signals } = connection();
  queue(db, UNLEASED);
  assert.equal(signals(), 1);
  queue(db, LEASED, "PENDING", 3);
  assert.equal(signals(), 2, "a leased row stamped with its epoch is sendable");
});

test("stays quiet for rows the watcher would ignore", () => {
  const { db, signals } = connection();
  queue(db, "NOT_PUSHED_YET");
  queue(db, UNLEASED, "SYNCED");
  queue(db, LEASED, "PENDING", null);
  assert.equal(signals(), 0, "no contract, already sent, or a leased row without its epoch");
});

test("signals for a stamped master-data mark, first edit and every edit after", () => {
  const { db, signals } = connection();
  mark(db, "p-1", null);
  assert.equal(signals(), 0, "an unstamped mark is not sent");
  mark(db, "p-1", 2);
  assert.equal(signals(), 1, "the upsert's update");
  mark(db, "p-2", 2);
  assert.equal(signals(), 2, "the upsert's insert");
});

test("never fails the save, even when the callback throws", () => {
  const { db, signals } = connection(() => {
    throw new Error("scheduler gone");
  });
  queue(db, UNLEASED);
  assert.equal(signals(), 1);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM sync_outbox").get()?.n), 1, "the row was saved");
});

test("writes nothing into the database file: the triggers are temporary", () => {
  const { db } = connection();
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'").get()?.n), 0);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM sqlite_temp_master WHERE type = 'trigger'").get()?.n), 3);
});

test("refuses anything but an aggregate type in the type list", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE sync_outbox (id TEXT, aggregate_type TEXT, status TEXT, lease_epoch INTEGER)");
  assert.throws(() => installPushOnSaveSignal(db, ["QR_MASTER') OR 1=1 --"], () => undefined), /Not an aggregate type/);
});
