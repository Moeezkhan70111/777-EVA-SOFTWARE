// CLEARING WHAT A DATABASE REMEMBERS ABOUT THE TEST PROJECT (testStateClear.ts, docs/36 10.5).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { SqliteDatabase } from "./sqliteDatabase.js";
import {
  RETIRED_NOTE,
  TestStateClearRefused,
  applyTestStateClear,
  planTestStateClear,
  verifyTestStateClear,
} from "./database/testStateClear.js";

const SCHEMA = path.resolve(import.meta.dirname, "../src/local-schema.sql");
const DEVICE = "dev-store";
const NOW = "2026-10-31T10:00:00.000Z";

type Run = (sql: string, ...params: Array<string | number | null>) => void;

/** A store database at the current schema, its device id set, and a copy of it to clear. */
async function withStore(work: (input: DatabaseSync, output: DatabaseSync, run: Run) => void, seed: (run: Run) => void): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-clear-"));
  try {
    const store = new SqliteDatabase({ dbPath: path.join(dir, "in.db"), schemaPath: SCHEMA });
    const run: Run = (sql, ...params) => void store.db.prepare(sql).run(...params);
    run(`INSERT INTO app_settings (setting_key, setting_value, value_type, is_encrypted, updated_by, updated_at)
         VALUES ('device.id', ?, 'string', 0, 'test', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`, DEVICE, NOW);
    seed(run);
    store.close();
    const input = new DatabaseSync(path.join(dir, "in.db"), { readOnly: true });
    await backup(input, path.join(dir, "out.db"));
    const output = new DatabaseSync(path.join(dir, "out.db"));
    try {
      work(input, output, (sql, ...params) => void output.prepare(sql).run(...params));
    } finally {
      input.close();
      output.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const outbox = (run: Run, id: string, type: string, status: string, epoch: number | null = null) =>
  run(
    `INSERT INTO sync_outbox (id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json, status, available_at, created_at, updated_at, lease_epoch)
     VALUES (?, ?, ?, 'INSERT', ?, '{}', ?, ?, ?, ?, ?)`,
    id, type, id, `${type}:${id}`, status, NOW, NOW, NOW, epoch
  );
const setting = (run: Run, key: string, value: string) =>
  run(`INSERT INTO app_settings (setting_key, setting_value, value_type, is_encrypted, updated_by, updated_at) VALUES (?, ?, 'string', 0, 'test', ?)`, key, value, NOW);

/** PC2 as it is: two rows sent to test, the legacy queue, test's cursor and lease cache, one label run since. */
const pc2 = (run: Run) => {
  outbox(run, "c-1", "QR_MASTER", "SYNCED");
  outbox(run, "p-1", "PRODUCTION_PRODUCED", "SYNCED");
  for (const id of ["l-1", "l-2", "l-3"]) outbox(run, id, "PRODUCTION_EVENT", "PENDING");
  outbox(run, "d-1", "DISPATCH_EVENT", "PENDING");
  outbox(run, "run-1", "RAW_MATERIAL_QR_BATCH", "PENDING");
  setting(run, "sync.pull.cursor", "2");
  setting(run, "sync.pull.deferred", "{}");
  run(`INSERT INTO sync_domain_leases (domain, holder_device_id, holder_label, epoch, barrier_seq, granted_at, project_key, fetched_at)
       VALUES ('RAW_MATERIAL_STORE', 'desktop-main', 'Host', 4, 0, ?, 'https://test.supabase.co', ?)`, NOW, NOW);
};

const n = (db: DatabaseSync, sql: string): number => Number((db.prepare(sql).get() as { n: number }).n);

test("what was sent to test goes, the legacy queue is retired, the computer's own work stays, and nothing else moves", async () => {
  await withStore((input, output) => {
    const plan = planTestStateClear(output, DEVICE);
    assert.deepEqual(
      [plan.sentToTest, plan.legacyToRetire, plan.legacyAlreadyRetired, plan.keptUnstamped, plan.leaseCacheRows],
      [2, 4, 0, 1, 1]
    );
    assert.deepEqual(plan.settings, ["sync.pull.cursor", "sync.pull.deferred"]);

    applyTestStateClear(output, plan, NOW);

    assert.equal(n(output, "SELECT COUNT(*) AS n FROM sync_outbox WHERE id IN ('c-1', 'p-1')"), 0);
    assert.deepEqual(
      output.prepare("SELECT id, status, last_error FROM sync_outbox WHERE aggregate_type IN ('PRODUCTION_EVENT', 'DISPATCH_EVENT') ORDER BY id").all()
        .map((row) => [row.id, row.status, row.last_error]),
      [["d-1", "SYNCED", RETIRED_NOTE], ["l-1", "SYNCED", RETIRED_NOTE], ["l-2", "SYNCED", RETIRED_NOTE], ["l-3", "SYNCED", RETIRED_NOTE]],
      "retired and kept as a record, never deleted"
    );
    assert.equal(n(output, "SELECT COUNT(*) AS n FROM sync_outbox WHERE id = 'run-1' AND status = 'PENDING'"), 1, "the label run printed since stays queued");
    assert.equal(n(output, "SELECT COUNT(*) AS n FROM app_settings WHERE setting_key LIKE 'sync.pull.%'"), 0);
    assert.equal(n(output, "SELECT COUNT(*) AS n FROM app_settings WHERE setting_key = 'device.id'"), 1, "only test's settings go");

    const checks = verifyTestStateClear(input, output, plan);
    assert.deepEqual(checks.filter((check) => !check.ok), [], "every check passes");
  }, pc2);
});

test("run twice, the second changes nothing", async () => {
  await withStore((input, output) => {
    applyTestStateClear(output, planTestStateClear(output, DEVICE), NOW);
    const again = planTestStateClear(output, DEVICE);
    assert.deepEqual([again.sentToTest, again.legacyToRetire, again.legacyAlreadyRetired, again.leaseCacheRows, again.settings.length], [0, 0, 4, 0, 0]);
    const before = n(output, "SELECT COUNT(*) AS n FROM sync_outbox");
    applyTestStateClear(output, again, NOW);
    assert.equal(n(output, "SELECT COUNT(*) AS n FROM sync_outbox"), before, "the retired rows are not mistaken for sent ones and deleted");
    void input;
  }, pc2);
});

const refusedWithNothingChanged = async (seed: (run: Run) => void, device: string, expected: RegExp) => {
  await withStore((_input, output) => {
    const rows = n(output, "SELECT COUNT(*) AS n FROM sync_outbox");
    assert.throws(() => planTestStateClear(output, device), (error: unknown) => error instanceof TestStateClearRefused && expected.test(error.message));
    assert.equal(n(output, "SELECT COUNT(*) AS n FROM sync_outbox"), rows);
  }, seed);
};

test("refuses another computer's database", async () => {
  await refusedWithNothingChanged(pc2, "pc3-device", /not the computer named/);
});

test("refuses work stamped with another project's lease epoch, rather than send it to be refused", async () => {
  await refusedWithNothingChanged((run) => {
    pc2(run);
    outbox(run, "run-2", "RAW_MATERIAL_QR_BATCH", "PENDING", 4);
  }, DEVICE, /carry a lease epoch/);
});

test("refuses events parked from another project's log, and a dead-lettered row", async () => {
  await refusedWithNothingChanged((run) => {
    pc2(run);
    run(`INSERT INTO sync_inbox_parked (dedupe_key, seq, envelope_json, reason, attempts, parked_at, next_try_at) VALUES ('PARTY:x:1', 9, '{}', 'UNKNOWN_PARTY_GROUP', 1, ?, 0)`, NOW);
    outbox(run, "q-9", "QR_MASTER", "DEAD_LETTER");
  }, DEVICE, /^(?=[\s\S]*parked from another project's log)(?=[\s\S]*DEAD_LETTER)/);
});

test("refuses a database at a schema it was not reviewed for", async () => {
  await refusedWithNothingChanged((run) => {
    pc2(run);
    run("INSERT INTO schema_migrations (version, applied_at) VALUES ('100_future', ?)", NOW);
  }, DEVICE, /not 099_sync_runs_backlog_trigger/);
});
