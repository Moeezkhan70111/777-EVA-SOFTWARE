import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "@erp/data";
import { readDomainLeases, replaceLeaseCache } from "./leases.js";
import { SyncPull } from "./pull.js";
import type { SyncPullTransport } from "./transport.js";

// CARTON CLOUD READINESS FROM WHAT A REAL SYNC PASS WRITES (PC1, 11 Nov 2026).
//
// The other activation tests write sync.pull.project and the lease cache by hand. These run the real pull and the real
// lease-cache replacement on a fresh database, in the order a pass runs them (cloudSyncPass.ts: pull, then leases), and
// read readiness after. A computer that has read the log and holds the three carton leases must be recognised; a log
// position alone must not make anyone a holder.

const SCHEMA = path.resolve(import.meta.dirname, "../../data/src/local-schema.sql");
const PROD = "https://ykhvbmhmeefdtrzqeoxm.supabase.co";
const PC1 = "fd435526-69ba-45f9-bfa0-c1f5933433cd";
const PC2 = "47c0dace-fe68-42cb-989c-e94f69c62c0f";
const NOW = "2026-11-11T09:00:00.000Z";

function freshComputer(): { db: SqliteDatabase; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-readiness-"));
  const db = new SqliteDatabase({ dbPath: path.join(dir, "erp.db"), schemaPath: SCHEMA });
  db.ensureOperationalContext({
    factoryId: "factory-777", factoryCode: "F777", factoryName: "777",
    workstationId: "ws-pc1", workstationCode: "WS-MOEEZKHAN", workstationName: "MOEEZKHAN",
    deviceId: PC1, deviceName: "MOEEZKHAN", appVersion: "0.5.1",
  });
  return { db, dir };
}

const emptyLog: SyncPullTransport = { fetchChanges: async () => [] };

/** current_leases() as production answers it after the transfer: three carton domains on PC1, two on PC2. */
const productionLeases = (carton: string, label = "PC1") =>
  readDomainLeases([
    { domain: "ACCOUNTS", holder_device_id: carton, holder_label: label, epoch: 2, barrier_seq: 22101, granted_at: NOW },
    { domain: "CARTON_STOCK", holder_device_id: carton, holder_label: label, epoch: 2, barrier_seq: 22101, granted_at: NOW },
    { domain: "MASTER_DATA", holder_device_id: PC2, holder_label: "PC2", epoch: 1, barrier_seq: 0, granted_at: NOW },
    { domain: "RAW_MATERIAL_STORE", holder_device_id: PC2, holder_label: "PC2", epoch: 1, barrier_seq: 0, granted_at: NOW },
    { domain: "SALES_DISPATCH", holder_device_id: carton, holder_label: label, epoch: 2, barrier_seq: 22101, granted_at: NOW },
  ]);

test("before the first pull: one reason, that it has never read -- not three about cloud migrations", () => {
  const { db, dir } = freshComputer();
  try {
    const status = db.cartonCloudStatus(NOW);
    assert.equal(status.projectKey, null);
    assert.deepEqual(status.problems, ["This computer has never read from the cloud. Set up cloud sync and sync once."]);
    assert.equal(status.leases.length, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("after a real pull and lease refresh, PC1's three carton leases are recognised and nothing else is in the way", async () => {
  const { db, dir } = freshComputer();
  try {
    await new SyncPull(db.db, emptyLog, { project: PROD }).runOnce();
    const leases = productionLeases(PC1);
    assert.ok(leases !== null && leases.length === 5);
    replaceLeaseCache(db.db, PROD, leases, NOW);

    const status = db.cartonCloudStatus(NOW);
    assert.equal(status.projectKey, "https://ykhvbmhmeefdtrzqeoxm.supabase.co");
    assert.deepEqual(status.problems, []);
    assert.deepEqual(status.leases.map((l) => [l.domain, l.heldHere]), [["CARTON_STOCK", true], ["SALES_DISPATCH", true], ["ACCOUNTS", true]]);
    // PC2 keeps the master data and the store: the cache says so, and readiness does not ask for them.
    const others = db.db.prepare("SELECT domain, holder_device_id FROM sync_domain_leases WHERE domain IN ('MASTER_DATA', 'RAW_MATERIAL_STORE') ORDER BY domain").all();
    assert.deepEqual(others.map((r) => [r.domain, r.holder_device_id]), [["MASTER_DATA", PC2], ["RAW_MATERIAL_STORE", PC2]]);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a log position alone is not a lease: read up to the barrier, but held by PC2, it is shown as PC2's", async () => {
  const { db, dir } = freshComputer();
  try {
    await new SyncPull(db.db, emptyLog, { project: PROD }).runOnce();
    replaceLeaseCache(db.db, PROD, productionLeases(PC2, "PC2") ?? [], NOW);
    const status = db.cartonCloudStatus(NOW);
    assert.deepEqual(status.problems, []);
    assert.ok(status.leases.every((l) => !l.heldHere && l.holderLabel === "PC2"));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a lease read too long ago is still refused, and a project with no lease answer still says so", async () => {
  const { db, dir } = freshComputer();
  try {
    await new SyncPull(db.db, emptyLog, { project: PROD }).runOnce();
    let status = db.cartonCloudStatus(NOW);
    assert.equal(status.problems.filter((p) => p.includes("has not reported")).length, 3);
    replaceLeaseCache(db.db, PROD, productionLeases(PC1) ?? [], "2026-11-11T08:00:00.000Z");
    status = db.cartonCloudStatus(NOW);
    assert.equal(status.problems.filter((p) => p.includes("too long ago")).length, 3);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
