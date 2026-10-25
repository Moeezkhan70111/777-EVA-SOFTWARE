import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { newestSendableRow } from "./outboxQueue.js";
import type { SyncSqlHandle } from "./sqlPort.js";

// What push on save watches: the newest row a pass could send. It must grow when a sendable row is
// queued, and ignore rows a pass would not send -- a type with no cloud contract yet, or a row that
// has already gone -- so that a nudge is never wasted on nothing.

const PUSHABLE = ["QR_MASTER", "PRODUCTION_PRODUCED"] as const;

function queue(): { sql: SyncSqlHandle; add: (type: string, status?: string) => void; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  raw.exec("CREATE TABLE sync_outbox (id TEXT PRIMARY KEY, aggregate_type TEXT NOT NULL, status TEXT NOT NULL, lease_epoch INTEGER)");
  let n = 0;
  return {
    sql: raw as unknown as SyncSqlHandle,
    raw,
    add: (type, status = "PENDING") => {
      n += 1;
      raw.prepare("INSERT INTO sync_outbox (id, aggregate_type, status) VALUES (?, ?, ?)").run(`row-${String(n)}`, type, status);
    },
  };
}

test("an empty queue, or one with nothing sendable, reads 0", () => {
  const q = queue();
  assert.equal(newestSendableRow(q.sql, PUSHABLE), 0);
  q.add("RAW_MATERIAL_QR"); // no cloud contract yet
  q.add("QR_MASTER", "SYNCED"); // already sent
  assert.equal(newestSendableRow(q.sql, PUSHABLE), 0);
  assert.equal(newestSendableRow(q.sql, []), 0, "a transport that can send nothing watches nothing");
});

test("queueing a sendable row makes it grow", () => {
  const q = queue();
  q.add("QR_MASTER");
  const first = newestSendableRow(q.sql, PUSHABLE);
  assert.ok(first > 0);

  q.add("RAW_MATERIAL_QR");
  assert.equal(newestSendableRow(q.sql, PUSHABLE), first, "a row a pass would not send does not count");

  q.add("PRODUCTION_PRODUCED");
  assert.ok(newestSendableRow(q.sql, PUSHABLE) > first);
});
