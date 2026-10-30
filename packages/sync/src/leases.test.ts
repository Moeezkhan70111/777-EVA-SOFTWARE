import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  LEASE_DOMAIN,
  enqueueQrMaster,
  enqueueRawMaterialQrBatch,
  type RawMaterialQrBatchPayload,
} from "@erp/data";
import {
  decideLeaseWrite,
  leaseWriteDecision,
  markLeasesUnsupported,
  readDomainLeases,
  replaceLeaseCache,
  type DomainLease,
  type LeaseDecisionInput,
} from "./leases.js";
import { leaseBatch, newestSendableRow, outboxSummary } from "./outboxQueue.js";
import { bindPullCursorToProject, writePullCursor } from "./pullCursor.js";
import type { SyncSqlHandle } from "./sqlPort.js";

// THE LOCAL HALF OF THE WRITE LEASE (docs/37 section W, migration 093).
//
// The cloud refuses a leased push from anyone but the holder, under the epoch it was written under
// (cloud migrations 011 and 012, proved on test by check_leases.sql and
// check_raw_material_identity.sql). These tests prove the computer's side: it refuses a leased
// write it could not deliver, it stamps what it does write with the epoch, and it never sends a
// leased row that has no epoch.

const ROOT = path.resolve(import.meta.dirname, "../../..");
const SCHEMA = path.join(ROOT, "packages/data/src/local-schema.sql");
const MIGRATIONS = [
  "082_sync_outbox_production_produced",
  "083_sync_outbox_transient_attempts",
  "086_sync_outbox_product_variant",
  "090_sync_outbox_raw_material_identity",
  "091_sync_inbox_parked",
  "093_domain_leases",
].map((name) => path.join(ROOT, "migrations/sqlite", `${name}.up.sql`));

const TEST_PROJECT = "https://wpkrhgqsizjjdaztijwv.supabase.co";
const PROD_PROJECT = "https://ykhvbmhmeefdtrzqeoxm.supabase.co";
const THIS_PC = "desktop-store";
const NOW = "2026-10-25T06:00:00.000Z";

function openStore(): { sql: SyncSqlHandle; raw: DatabaseSync; close: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "erp-leases-"));
  const raw = new DatabaseSync(path.join(root, "erp.db"));
  raw.exec(fs.readFileSync(SCHEMA, "utf8"));
  for (const file of MIGRATIONS) {
    for (const statement of fs.readFileSync(file, "utf8").split(";")) {
      if (statement.trim()) raw.exec(statement.trim());
    }
  }
  return {
    sql: raw,
    raw,
    close: () => {
      raw.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const lease = (overrides: Partial<DomainLease> = {}): DomainLease => ({
  domain: LEASE_DOMAIN.RAW_MATERIAL_STORE,
  holderDeviceId: THIS_PC,
  holderLabel: "Store PC",
  epoch: 4,
  barrierSeq: 0,
  grantedAt: "2026-10-25T05:00:00.000Z",
  ...overrides,
});

const decide = (overrides: Partial<LeaseDecisionInput>) =>
  decideLeaseWrite({
    domain: LEASE_DOMAIN.RAW_MATERIAL_STORE,
    syncConfigured: true,
    deviceId: THIS_PC,
    lease: lease(),
    leasesUnsupported: false,
    pulledSeq: 100,
    parkedBeforeBarrier: 0,
    ...overrides,
  });

// ─── The decision ───────────────────────────────────────────────────────────

test("a computer not set up for cloud sync writes exactly as before", () => {
  assert.deepEqual(decide({ syncConfigured: false, lease: null }), { allowed: true, domain: "RAW_MATERIAL_STORE", epoch: null });
});

test("a synced computer refuses every way it could be writing on someone else's lease", () => {
  assert.equal((decide({ lease: null }) as { reason?: string }).reason, "NO_LEASE_INFO");
  assert.deepEqual(decide({ lease: lease({ holderDeviceId: null, holderLabel: null }) }), {
    allowed: false, domain: "RAW_MATERIAL_STORE", reason: "NOT_HELD", holderLabel: null,
  });
  assert.deepEqual(decide({ lease: lease({ holderDeviceId: "desktop-office", holderLabel: "Office PC -- Aslam" }) }), {
    allowed: false, domain: "RAW_MATERIAL_STORE", reason: "HELD_ELSEWHERE", holderLabel: "Office PC -- Aslam",
  });
});

test("the holder waits until it has read past the previous holder's last write", () => {
  const behind = decide({ lease: lease({ barrierSeq: 250 }), pulledSeq: 249 });
  assert.equal(behind.allowed, false);
  assert.equal((behind as { reason: string }).reason, "CATCHING_UP");
  // Read that far, but one of the previous holder's events is parked here, not applied.
  const parked = decide({ lease: lease({ barrierSeq: 250 }), pulledSeq: 300, parkedBeforeBarrier: 1 });
  assert.equal((parked as { reason: string }).reason, "CATCHING_UP");
  assert.deepEqual(decide({ lease: lease({ barrierSeq: 250 }), pulledSeq: 250 }), { allowed: true, domain: "RAW_MATERIAL_STORE", epoch: 4 });
});

// ─── The cloud's answer, at the boundary ────────────────────────────────────

test("the cloud's answer is validated whole, and a domain this version does not know is skipped", () => {
  const good = {
    domain: "RAW_MATERIAL_STORE", holder_device_id: THIS_PC, holder_label: "Store PC",
    epoch: 4, barrier_seq: 12, granted_at: "2026-10-25T05:00:00+00:00",
  };
  assert.deepEqual(readDomainLeases([good, { ...good, domain: "SOME_FUTURE_DOMAIN" }]), [
    { domain: "RAW_MATERIAL_STORE", holderDeviceId: THIS_PC, holderLabel: "Store PC", epoch: 4, barrierSeq: 12, grantedAt: "2026-10-25T05:00:00+00:00" },
  ]);
  assert.deepEqual(readDomainLeases([{ ...good, holder_device_id: null, holder_label: null, granted_at: null }])?.[0]?.holderDeviceId, null);
  // One bad row and the whole answer is refused: a half-trusted answer about who may write is
  // worse than the last good one.
  for (const bad of [{ ...good, epoch: "4" }, { ...good, epoch: -1 }, { ...good, barrier_seq: 1.5 }, { ...good, holder_device_id: 7 }, null]) {
    assert.equal(readDomainLeases([good, bad]), null, JSON.stringify(bad));
  }
  assert.equal(readDomainLeases({ leases: [] }), null);
});

// ─── The cache, tied to its project ─────────────────────────────────────────

test("a lease cached from one project never authorises a write for another", () => {
  const store = openStore();
  try {
    const input = { domain: LEASE_DOMAIN.RAW_MATERIAL_STORE, deviceId: THIS_PC, syncConfigured: true };
    replaceLeaseCache(store.sql, TEST_PROJECT, [lease()], NOW);
    // Never pulled: no project yet, so nothing is known.
    assert.equal((leaseWriteDecision(store.sql, input) as { reason?: string }).reason, "NO_LEASE_INFO");
    bindPullCursorToProject(store.sql, TEST_PROJECT);
    assert.deepEqual(leaseWriteDecision(store.sql, input), { allowed: true, domain: "RAW_MATERIAL_STORE", epoch: 4 });
    // Moved to production: test's lease means nothing there.
    bindPullCursorToProject(store.sql, PROD_PROJECT);
    assert.equal((leaseWriteDecision(store.sql, input) as { reason?: string }).reason, "NO_LEASE_INFO");
  } finally {
    store.close();
  }
});

test("the cache is replaced whole, and the barrier is judged against what this computer has read", () => {
  const store = openStore();
  try {
    const input = { domain: LEASE_DOMAIN.RAW_MATERIAL_STORE, deviceId: THIS_PC, syncConfigured: true };
    bindPullCursorToProject(store.sql, TEST_PROJECT);
    replaceLeaseCache(store.sql, TEST_PROJECT, [lease({ barrierSeq: 40 }), lease({ domain: LEASE_DOMAIN.MASTER_DATA })], NOW);
    writePullCursor(store.sql, 39);
    assert.equal((leaseWriteDecision(store.sql, input) as { reason?: string }).reason, "CATCHING_UP");
    writePullCursor(store.sql, 40);
    assert.equal(leaseWriteDecision(store.sql, input).allowed, true);

    // A parked carton event says nothing about the store. A parked label run before the barrier does.
    const park = store.raw.prepare(
      "INSERT INTO sync_inbox_parked (dedupe_key, seq, envelope_json, reason, parked_at, next_try_at) VALUES (?, ?, '{}', 'WAITING', ?, 0)"
    );
    park.run("QR_MASTER:SK9_BLACK_7/10_000001", 30, NOW);
    assert.equal(leaseWriteDecision(store.sql, input).allowed, true);
    park.run("RAW_MATERIAL_QR_BATCH:rmb-1", 35, NOW);
    assert.equal((leaseWriteDecision(store.sql, input) as { reason?: string }).reason, "CATCHING_UP");

    // A later answer without the domain at all: nothing is known about it any more.
    replaceLeaseCache(store.sql, TEST_PROJECT, [lease({ domain: LEASE_DOMAIN.MASTER_DATA })], NOW);
    assert.equal((leaseWriteDecision(store.sql, input) as { reason?: string }).reason, "NO_LEASE_INFO");
  } finally {
    store.close();
  }
});

test("a project with no leases at all does not lock the store, and stops counting once it has them", () => {
  const store = openStore();
  try {
    const input = { domain: LEASE_DOMAIN.RAW_MATERIAL_STORE, deviceId: THIS_PC, syncConfigured: true };
    bindPullCursorToProject(store.sql, PROD_PROJECT);
    // A lease cached while the project had them, then the project answers 404: the old lease goes.
    replaceLeaseCache(store.sql, PROD_PROJECT, [lease({ holderDeviceId: "desktop-office" })], NOW);
    markLeasesUnsupported(store.sql, PROD_PROJECT);
    assert.deepEqual(leaseWriteDecision(store.sql, input), { allowed: true, domain: "RAW_MATERIAL_STORE", epoch: null });
    // "No leases" on ANOTHER project says nothing about this one.
    bindPullCursorToProject(store.sql, TEST_PROJECT);
    assert.equal((leaseWriteDecision(store.sql, input) as { reason?: string }).reason, "NO_LEASE_INFO");
    // The project grows leases: its first answer replaces the marker, and the gate enforces again.
    bindPullCursorToProject(store.sql, PROD_PROJECT);
    replaceLeaseCache(store.sql, PROD_PROJECT, [lease({ holderDeviceId: "desktop-office", holderLabel: "Office PC" })], NOW);
    assert.equal((leaseWriteDecision(store.sql, input) as { reason?: string }).reason, "HELD_ELSEWHERE");
  } finally {
    store.close();
  }
});

// ─── Stamping, and never sending an unstamped leased row ────────────────────

const run = (batchId: string): RawMaterialQrBatchPayload => ({
  batchId, partyId: "party-1", itemId: "item-1", startSequence: 1, endSequence: 2, quantity: 2,
  createdAt: NOW, createdBy: null, requestedBy: null,
});

const queuedEpochs = (raw: DatabaseSync): Record<string, number | null> => {
  const rows = raw.prepare("SELECT aggregate_id, lease_epoch FROM sync_outbox ORDER BY rowid").all() as Array<Record<string, unknown>>;
  return Object.fromEntries(rows.map((row) => [String(row.aggregate_id), row.lease_epoch === null ? null : Number(row.lease_epoch)]));
};

test("a leased event is stamped with this computer's epoch as it is queued, and a carton is not", () => {
  const store = openStore();
  try {
    // Before this computer knows any lease: queued, but with no epoch.
    assert.equal(enqueueRawMaterialQrBatch(store.raw, run("rmb-before"), "o-1"), true);
    replaceLeaseCache(store.sql, TEST_PROJECT, [lease({ epoch: 7 })], NOW);
    assert.equal(enqueueRawMaterialQrBatch(store.raw, run("rmb-after"), "o-2"), true);
    assert.equal(enqueueQrMaster(store.raw, { qrId: "SK9_BLACK_7/10_000001", productVariantId: "v-1", createdAt: NOW }, "o-3"), true);
    assert.deepEqual(queuedEpochs(store.raw), { "rmb-before": null, "rmb-after": 7, "SK9_BLACK_7/10_000001": null });
  } finally {
    store.close();
  }
});

test("a leased row with no epoch is never claimed, never counted as sendable, and never nudges a pass", () => {
  const store = openStore();
  try {
    const types = ["QR_MASTER", "RAW_MATERIAL_QR_BATCH"];
    enqueueRawMaterialQrBatch(store.raw, run("rmb-unstamped"), "o-1");
    assert.equal(newestSendableRow(store.sql, types), 0, "nothing sendable, so no pass is started for it");
    replaceLeaseCache(store.sql, TEST_PROJECT, [lease({ epoch: 7 })], NOW);
    enqueueRawMaterialQrBatch(store.raw, run("rmb-stamped"), "o-2");
    assert.ok(newestSendableRow(store.sql, types) > 0);

    const summary = outboxSummary(store.sql, { pushableTypes: types, nowIso: NOW });
    assert.equal(summary.pushableNow, 1);
    assert.equal(summary.notPushable, 1, "the unstamped run waits for the backfill, counted as not sendable");

    const claimed = leaseBatch(store.sql, { limit: 10, nowIso: NOW, lockToken: "t-1", deviceId: THIS_PC, aggregateTypes: types });
    assert.deepEqual(claimed.map((event) => [event.envelope.aggregateId, event.envelope.leaseEpoch]), [["rmb-stamped", 7]]);
    const status = store.raw.prepare("SELECT status FROM sync_outbox WHERE aggregate_id = 'rmb-unstamped'").get() as { status: string };
    assert.equal(status.status, "PENDING", "left exactly as it was");
  } finally {
    store.close();
  }
});
