import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SqliteDatabase,
  rawMaterialQrBatchDedupeKey,
  rawMaterialQrDedupeKey,
  readRawMaterialQrBatchPayload,
  readRawMaterialQrPayload,
} from "@erp/data";
import { applyEnvelope } from "./applyEnvelope.js";
import type { SyncEnvelope } from "./contract.js";
import type { SyncSqlHandle } from "./sqlPort.js";

// RAW-MATERIAL PACKET IDENTITY, from one real computer to another.
//
// Both databases are built by the application's own SqliteDatabase, so every migration up to the
// newest has run, foreign keys are on, and the label run is printed by the real generator. B is a
// snapshot of A taken before any labels exist -- the way a second PC is provisioned (docs/37
// section 2.2) -- so the two share their master data, and only the label runs travel.
//
// Envelopes are read from A's outbox -- exactly what the generator queued -- so both halves are
// proved together: what the sender writes is what the receiver can apply.

const SCHEMA_PATH = path.resolve(import.meta.dirname, "../../data/src/local-schema.sql");
const CONTEXT = {
  factoryId: "factory-1", factoryCode: "F001", factoryName: "Factory",
  workstationId: "workstation-1", workstationCode: "WS001", workstationName: "WS",
  deviceId: "device-a", deviceName: "PC A", appVersion: "1.0.0",
};

interface Fixture {
  readonly a: SqliteDatabase;
  readonly b: SqliteDatabase;
  readonly itemId: string;
  readonly supplierId: string;
  cleanup(): void;
}

function createFixture(prefix: string): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `erp-rm-sync-${prefix}-`));
  const a = new SqliteDatabase({ dbPath: path.join(root, "a.db"), schemaPath: SCHEMA_PATH });
  a.setNumberBlock(1, "test");
  a.ensureOperationalContext(CONTEXT);

  const unitId = a.createInventoryUnit({ code: "DOZ", name: "Dozen", unitFamily: "COUNT" });
  const supplierId = a.createParty({
    partyName: "SHEHZAD RUBBER TOPPING", partyType: "SUPPLIER", city: "Lahore",
    mobileNumber: "0300-1111111", status: "ACTIVE",
  });
  const categoryId = a.createInventoryCategory({ name: "RUBBER UPPER" });
  a.addInventoryCategoryField({ categoryId, fieldKey: "article", label: "Article", fieldType: "TEXT", required: true, sortOrder: 1 });
  const itemId = a.createInventoryItem({ categoryId, values: { article: "SK9" }, unitId }).id;

  // Provision B from a snapshot of A, before anything is labelled.
  const snapshot = path.join(root, "b.db");
  a.db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
  const b = new SqliteDatabase({ dbPath: snapshot, schemaPath: SCHEMA_PATH });

  return {
    a, b, itemId, supplierId,
    cleanup: () => {
      a.db.close();
      b.db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const sqlOf = (db: SqliteDatabase): SyncSqlHandle => db.db as unknown as SyncSqlHandle;

function envelope(aggregateType: string, aggregateId: string, dedupeKey: string, payload: Record<string, unknown>): SyncEnvelope {
  return { dedupeKey, aggregateType, aggregateId, operation: "INSERT", payload, originDeviceId: "device-a", createdAt: String(payload.createdAt) };
}

interface QueuedRow {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly dedupeKey: string;
  readonly payload: Record<string, unknown>;
}

/** A's raw-material queue rows, in the order they would be sent. */
function queuedRawMaterial(a: SqliteDatabase): QueuedRow[] {
  const rows = a.db
    .prepare(
      `SELECT aggregate_type, aggregate_id, dedupe_key, payload_json FROM sync_outbox
       WHERE aggregate_type IN ('RAW_MATERIAL_QR_BATCH', 'RAW_MATERIAL_QR') ORDER BY rowid`
    )
    .all() as Array<{ aggregate_type: string; aggregate_id: string; dedupe_key: string; payload_json: string }>;
  return rows.map((row) => ({
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    dedupeKey: row.dedupe_key,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  }));
}

/** One label run as A QUEUED it -- the real sender's envelopes: the run, then its packets. */
function runEnvelopes(a: SqliteDatabase, batchId: string): { run: SyncEnvelope; packets: SyncEnvelope[] } {
  const ofRun = queuedRawMaterial(a)
    .filter((row) => row.payload.batchId === batchId)
    .map((row) => envelope(row.aggregateType, row.aggregateId, row.dedupeKey, row.payload));
  const [run, ...packets] = ofRun;
  assert.ok(run !== undefined, `nothing was queued for run ${batchId}`);
  assert.equal(run.aggregateType, "RAW_MATERIAL_QR_BATCH", "the run is queued ahead of its packets");
  return { run, packets };
}

const packetHere = (db: SqliteDatabase, qrId: string) =>
  db.db
    .prepare("SELECT batch_id, packing_quantity, current_status, current_hop_index, created_at, replicated_at FROM raw_material_qrs WHERE id = ?")
    .get(qrId) as Record<string, string | number | null> | undefined;

test("a label run and its packets arrive with the origin's identity and times, exactly once", () => {
  const f = createFixture("arrive");
  try {
    const generated = f.a.generateRawMaterialQrBatch({ partyId: f.supplierId, itemId: f.itemId, quantity: 3, packingQuantity: 12 });
    const { run, packets } = runEnvelopes(f.a, generated.batch.id);
    const arrived = "2026-10-24T06:00:00.000Z";

    assert.equal(applyEnvelope(sqlOf(f.b), run, arrived).status, "APPLIED");
    for (const packet of packets) assert.equal(applyEnvelope(sqlOf(f.b), packet, arrived).status, "APPLIED");

    for (const qrId of generated.qrCodes.map((q) => q.id)) {
      const here = packetHere(f.b, qrId);
      const origin = packetHere(f.a, qrId);
      assert.equal(here?.batch_id, generated.batch.id);
      assert.equal(Number(here?.packing_quantity), 12, "what one packet holds travels with it");
      assert.equal(here?.current_status, "GENERATED", "the opening state, until events say otherwise");
      assert.equal(Number(here?.current_hop_index), 0);
      assert.equal(here?.created_at, origin?.created_at, "the origin's created_at is kept");
      assert.equal(here?.replicated_at, arrived);
      assert.equal(origin?.replicated_at, null, "recorded on A, so no arrival time there");
    }

    // At-least-once delivery: everything offered again is a no-op.
    assert.equal(applyEnvelope(sqlOf(f.b), run).status, "DUPLICATE");
    for (const packet of packets) assert.equal(applyEnvelope(sqlOf(f.b), packet).status, "DUPLICATE");
  } finally {
    f.cleanup();
  }
});

test("a packet that arrives before its run waits, and applies once the run is here", () => {
  const f = createFixture("order");
  try {
    const generated = f.a.generateRawMaterialQrBatch({ partyId: f.supplierId, itemId: f.itemId, quantity: 1, packingQuantity: 5 });
    const { run, packets } = runEnvelopes(f.a, generated.batch.id);
    const [packet] = packets;
    assert.ok(packet !== undefined);

    const early = applyEnvelope(sqlOf(f.b), packet);
    assert.equal(early.status, "REJECTED");
    assert.equal(early.permanent, false, "a missing run is a wait, not a refusal");
    assert.match(early.reason ?? "", /^RAW_MATERIAL_QR_BATCH_NOT_HERE_YET:/);

    assert.equal(applyEnvelope(sqlOf(f.b), run).status, "APPLIED");
    assert.equal(applyEnvelope(sqlOf(f.b), packet).status, "APPLIED");
  } finally {
    f.cleanup();
  }
});

test("a run for a material this computer has not got waits for the master data", () => {
  const f = createFixture("master");
  try {
    const generated = f.a.generateRawMaterialQrBatch({ partyId: f.supplierId, itemId: f.itemId, quantity: 1, packingQuantity: 5 });
    const { run } = runEnvelopes(f.a, generated.batch.id);
    const unknownItem = { ...run, payload: { ...run.payload, itemId: "item-created-on-a-after-b-was-provisioned" } };

    const outcome = applyEnvelope(sqlOf(f.b), unknownItem);
    assert.equal(outcome.status, "REJECTED");
    assert.equal(outcome.permanent, false);
    assert.equal(outcome.reason, "UNKNOWN_INVENTORY_ITEM:item-created-on-a-after-b-was-provisioned");
  } finally {
    f.cleanup();
  }
});

test("a run erased and printed again under the same serials is refused, never taken for a duplicate", () => {
  const f = createFixture("reprint");
  try {
    // A prints a run of 12-packs, and B receives it.
    const first = f.a.generateRawMaterialQrBatch({ partyId: f.supplierId, itemId: f.itemId, quantity: 2, packingQuantity: 12 });
    const firstRun = runEnvelopes(f.a, first.batch.id);
    applyEnvelope(sqlOf(f.b), firstRun.run);
    for (const packet of firstRun.packets) applyEnvelope(sqlOf(f.b), packet);

    // A erases it untouched, which rewinds the serials, and prints 20-packs under the same ids.
    f.a.deleteRawMaterialQrBatch({ batchId: first.batch.id });
    const second = f.a.generateRawMaterialQrBatch({ partyId: f.supplierId, itemId: f.itemId, quantity: 2, packingQuantity: 20 });
    assert.deepEqual(second.qrCodes.map((q) => q.id), first.qrCodes.map((q) => q.id), "the generator reuses the serials");

    const secondRun = runEnvelopes(f.a, second.batch.id);
    assert.equal(applyEnvelope(sqlOf(f.b), secondRun.run).status, "APPLIED", "a new run id is a new run");
    for (const packet of secondRun.packets) {
      const outcome = applyEnvelope(sqlOf(f.b), packet);
      assert.equal(outcome.status, "REJECTED", "the same id now means a different packet");
      assert.equal(outcome.permanent, true);
      assert.equal(outcome.reason, `RAW_MATERIAL_QR_IDENTITY_CONFLICT:${packet.aggregateId}`);
    }

    // And B's packets are exactly as they arrived: nothing was written over.
    for (const qrId of first.qrCodes.map((q) => q.id)) {
      assert.equal(packetHere(f.b, qrId)?.batch_id, first.batch.id);
      assert.equal(Number(packetHere(f.b, qrId)?.packing_quantity), 12);
    }
  } finally {
    f.cleanup();
  }
});

test("the readers refuse a run that does not add up and a packet with half its packing", () => {
  const run = {
    batchId: "b1", partyId: "p1", itemId: "i1", startSequence: 1, endSequence: 3, quantity: 3,
    createdAt: "2026-10-24T06:00:00.000Z", createdBy: null, requestedBy: null,
  };
  assert.ok(readRawMaterialQrBatchPayload(run) !== null);
  assert.equal(readRawMaterialQrBatchPayload({ ...run, quantity: 4 }), null, "serials 1-3 are three packets, not four");
  assert.equal(readRawMaterialQrBatchPayload({ ...run, startSequence: 0 }), null);

  const packet = {
    qrId: "q1", batchId: "b1", partyId: "p1", itemId: "i1", sequence: 1,
    packingQuantity: 12, packingUnitId: "u1", createdAt: "2026-10-24T06:00:00.000Z",
  };
  assert.ok(readRawMaterialQrPayload(packet) !== null);
  assert.ok(readRawMaterialQrPayload({ ...packet, packingQuantity: null, packingUnitId: null }) !== null, "an old unpacked packet");
  assert.equal(readRawMaterialQrPayload({ ...packet, packingUnitId: null }), null, "a quantity with no unit");
  assert.equal(readRawMaterialQrPayload({ ...packet, packingQuantity: null }), null, "a unit with no quantity");
  assert.equal(readRawMaterialQrPayload({ ...packet, packingQuantity: -1 }), null);
});

// ─── The sending side ───────────────────────────────────────────────────────

test("printing a run queues the run, then each packet, in one go with the run itself", () => {
  const f = createFixture("queue");
  try {
    const generated = f.a.generateRawMaterialQrBatch({ partyId: f.supplierId, itemId: f.itemId, quantity: 3, packingQuantity: 12 });
    const queued = queuedRawMaterial(f.a);

    assert.deepEqual(
      queued.map((row) => row.dedupeKey),
      [
        rawMaterialQrBatchDedupeKey(generated.batch.id),
        ...generated.qrCodes.map((q) => rawMaterialQrDedupeKey(q.id)),
      ],
      "the run first, then its packets in serial order"
    );
    // Every queued payload is one the receiving contract accepts as it stands.
    const [run, ...packets] = queued;
    assert.ok(run !== undefined && readRawMaterialQrBatchPayload(run.payload) !== null);
    for (const packet of packets) assert.ok(readRawMaterialQrPayload(packet.payload) !== null);
  } finally {
    f.cleanup();
  }
});

test("erasing a run nobody has been sent takes its queue back, and a reprint queues afresh", () => {
  const f = createFixture("withdraw");
  try {
    const first = f.a.generateRawMaterialQrBatch({ partyId: f.supplierId, itemId: f.itemId, quantity: 2, packingQuantity: 12 });
    assert.equal(queuedRawMaterial(f.a).length, 3);

    f.a.deleteRawMaterialQrBatch({ batchId: first.batch.id });
    assert.equal(queuedRawMaterial(f.a).length, 0, "the erased run must not be sent");

    // The same serials, printed again, are queued as the new run -- not blocked by the old keys.
    const second = f.a.generateRawMaterialQrBatch({ partyId: f.supplierId, itemId: f.itemId, quantity: 2, packingQuantity: 20 });
    const { run, packets } = runEnvelopes(f.a, second.batch.id);
    assert.equal(packets.length, 2);
    assert.equal(applyEnvelope(sqlOf(f.b), run).status, "APPLIED");
    for (const packet of packets) {
      assert.equal(applyEnvelope(sqlOf(f.b), packet).status, "APPLIED");
      assert.equal(Number(packetHere(f.b, packet.aggregateId)?.packing_quantity), 20, "B gets the reprint, never the erased run");
    }
  } finally {
    f.cleanup();
  }
});

test("a run whose queue may already have left this computer cannot be erased", () => {
  const f = createFixture("refuse");
  try {
    const generated = f.a.generateRawMaterialQrBatch({ partyId: f.supplierId, itemId: f.itemId, quantity: 2, packingQuantity: 12 });
    // One delivery attempt was made. Whether it landed is unknown, so the run may be elsewhere.
    f.a.db
      .prepare("UPDATE sync_outbox SET status = 'FAILED', attempts = 1 WHERE dedupe_key = ?")
      .run(rawMaterialQrDedupeKey(generated.qrCodes[0]?.id ?? ""));

    assert.throws(
      () => f.a.deleteRawMaterialQrBatch({ batchId: generated.batch.id }),
      /already been sent to the other computers/
    );
    // Refused means untouched: the run, its packets and its whole queue are still there.
    assert.equal(packetHere(f.a, generated.qrCodes[0]?.id ?? "")?.batch_id, generated.batch.id);
    assert.equal(queuedRawMaterial(f.a).length, 3);
  } finally {
    f.cleanup();
  }
});
