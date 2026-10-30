import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "@erp/data";
import { SyncPull } from "./pull.js";
import type { SyncChange } from "./transport.js";

// A LONG PAGE DOES NOT HOLD THE WINDOW (pull.ts, YIELD_EVERY). Applying is synchronous database work
// on the main process; a first sync applies thousands of events. Without handing control back, the
// window got no turn until a whole page was done, and Windows marked it "not responding" (2026-10-27).

const SCHEMA = path.resolve(import.meta.dirname, "../../data/src/local-schema.sql");
const NOW = "2026-10-27T10:00:00.000Z";

const groups = (count: number): SyncChange[] =>
  Array.from({ length: count }, (_, index) => {
    const id = `g-${String(index + 1)}`;
    return {
      seq: index + 1,
      envelope: {
        dedupeKey: `PARTY_GROUP:${id}:1`,
        aggregateType: "PARTY_GROUP",
        aggregateId: id,
        operation: "INSERT" as const,
        payload: { recordId: id, revision: 1, deleted: false, body: { row: { id, group_name: `Group ${String(index + 1)}`, created_at: NOW, updated_at: NOW }, children: {} } },
        originDeviceId: "dev-store",
        createdAt: NOW,
      },
    };
  });

test("applying a page of 100 hands control back to the window as it goes, and applies all of it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-pull-yield-"));
  const reader = new SqliteDatabase({ dbPath: path.join(dir, "erp.db"), schemaPath: SCHEMA });
  try {
    const changes = groups(100);
    const pull = new SyncPull(reader.db, { fetchChanges: async (after) => changes.filter((change) => change.seq > after) }, { batchSize: 200 });

    // Something else that wants a turn while the page applies -- a click, a repaint.
    let turns = 0;
    let running = true;
    const other = () => {
      if (!running) return;
      turns += 1;
      setImmediate(other);
    };
    setImmediate(other);
    const result = await pull.runOnce();
    running = false;

    assert.equal(result.applied, 100);
    assert.ok(turns >= 4, `the window had ${String(turns)} turns during the page; it needs one every 25 events`);
  } finally {
    reader.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
