import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyEnvelope } from "./applyEnvelope.js";
import { qrMasterDedupeKey, type SyncEnvelope } from "./contract.js";
import { OutboxDrain } from "./drain.js";
import {
  deadLetters,
  enqueueQrMasterInsert,
  markFailed,
  outboxCounts,
  reclaimStale,
  type OutboxRetryPolicy,
} from "./outboxQueue.js";
import { HttpSyncTransport, type SyncTransport } from "./transport.js";
import { startTestSyncBackend } from "./testOnlyBackend.js";
import type { SyncSqlHandle } from "./sqlPort.js";

// TWO COMPUTERS, ONE EVENT TYPE, PROVED END TO END.
//
// Every case here runs against two throwaway SQLite files under the OS temp folder, created from
// the real local-schema.sql so the real primary keys, CHECK constraints and foreign keys apply,
// with foreign keys enforced exactly as the application enforces them. The production database is
// never opened, and nothing is read from it.
//
// The receiving side is a service on the loopback interface, so a batch really is serialised,
// sent over a socket, applied and acknowledged.
//
// What these tests are for:
//
//   * an event is never lost — a claimed batch that does not get through comes back
//   * an event is never applied twice — delivery is at-least-once, application is exactly-once
//   * an interrupted run is safe — including the case where the receiver applied the batch and
//     the sender never heard
//   * a permanent refusal stops visibly instead of being retried for ever
//   * two computers converge
//   * an event type whose contract is incomplete is REFUSED, never guessed at

const SCHEMA_PATH = path.resolve(import.meta.dirname, "../../data/src/local-schema.sql");
const MIGRATION_083 = path.resolve(
  import.meta.dirname,
  "../../../migrations/sqlite/083_sync_outbox_transient_attempts.up.sql"
);

/** Applies a shipped migration the way the runner does: split on semicolons. */
function runMigration(raw: DatabaseSync, file: string): void {
  for (const statement of fs.readFileSync(file, "utf8").split(";")) {
    const trimmed = statement.trim();
    if (trimmed) raw.exec(trimmed);
  }
}

const FAST_RETRY: OutboxRetryPolicy = { maxAttempts: 3, baseBackoffMs: 1_000, maxBackoffMs: 60_000, staleInFlightMs: 60_000 };

const FACTORY_ID = "factory-777";
const VARIANT_ID = "variant-sk9-black-7-10";

interface Node {
  readonly name: string;
  readonly sql: SyncSqlHandle;
  readonly raw: DatabaseSync;
  readonly deviceId: string;
}

function createNode(root: string, name: string): Node {
  const raw = new DatabaseSync(path.join(root, `${name}.db`));
  raw.exec("PRAGMA journal_mode = WAL;");
  raw.exec("PRAGMA foreign_keys = ON;");
  raw.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
  runMigration(raw, MIGRATION_083);
  // The master data both computers are given when they are set up. Events carry identity, never
  // the products themselves, so a receiver must already hold the product a QR names.
  const now = "2026-10-01T04:00:00.000Z";
  raw
    .prepare(
      `INSERT INTO product_variants (id, article, color, size, status, created_at, updated_at)
       VALUES (?, 'SK9', 'BLACK', '7/10', 'ACTIVE', ?, ?)`
    )
    .run(VARIANT_ID, now, now);
  return { name, sql: raw as unknown as SyncSqlHandle, raw, deviceId: `device-${name}` };
}

interface Fixture {
  readonly a: Node;
  readonly b: Node;
  cleanup(): void;
}

function createFixture(prefix: string): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `erp-sync-${prefix}-`));
  const a = createNode(root, "a");
  const b = createNode(root, "b");
  return {
    a,
    b,
    cleanup: () => {
      a.raw.close();
      b.raw.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A clock the test moves by hand, so a retry delay never costs real time. */
function clock(startIso: string) {
  let current = new Date(startIso).getTime();
  return {
    nowIso: () => new Date(current).toISOString(),
    advanceMs: (ms: number) => {
      current += ms;
    },
  };
}

/**
 * Records one carton the way the production scan does: the qr_master row and the event that will
 * carry it, in ONE transaction, so the two can never disagree.
 */
const recordCarton = (node: Node, qrId: string, createdAt: string): boolean => {
  node.raw.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    node.raw
      .prepare(
        `INSERT INTO qr_master (qr_id, product_variant_id, current_status, current_location_type,
           current_location_id, first_event_id, created_at, updated_at)
         VALUES (?, ?, 'PRODUCED', 'FACTORY', NULL, NULL, ?, ?)
         ON CONFLICT(qr_id) DO NOTHING`
      )
      .run(qrId, VARIANT_ID, createdAt, createdAt);
    const queued = enqueueQrMasterInsert(
      node.sql,
      {
        identity: { qrId, productVariantId: VARIANT_ID, createdAt },
        originDeviceId: node.deviceId,
        outboxId: crypto.randomUUID(),
      },
      createdAt
    );
    node.raw.exec("COMMIT");
    return queued;
  } catch (error) {
    node.raw.exec("ROLLBACK");
    throw error;
  }
};

const qrIds = (node: Node): string[] =>
  (node.raw.prepare("SELECT qr_id FROM qr_master ORDER BY qr_id").all() as Array<{ qr_id: string }>).map(
    (row) => row.qr_id
  );

const qrRow = (node: Node, qrId: string): Record<string, unknown> | undefined =>
  node.raw.prepare("SELECT * FROM qr_master WHERE qr_id = ?").get(qrId) as Record<string, unknown> | undefined;

const envelopeFor = (node: Node, qrId: string, createdAt: string): SyncEnvelope => ({
  dedupeKey: qrMasterDedupeKey(qrId),
  aggregateType: "QR_MASTER",
  aggregateId: qrId,
  operation: "INSERT",
  payload: { qrId, productVariantId: VARIANT_ID, createdAt },
  originDeviceId: node.deviceId,
  createdAt,
});

// ─── putting an event in the outbox ─────────────────────────────────────────

test("queueing the same QR twice adds one event and never fails the local write", () => {
  const fixture = createFixture("enqueue");
  try {
    const first = recordCarton(fixture.a, "SK9_BLACK_7/10_000001", "2026-10-01T05:00:00.000Z");
    const second = recordCarton(fixture.a, "SK9_BLACK_7/10_000001", "2026-10-01T05:00:01.000Z");

    assert.equal(first, true, "the first call queues it");
    assert.equal(second, false, "the second call is a no-op, not an error");
    assert.deepEqual(outboxCounts(fixture.a.sql), {
      PENDING: 1,
      IN_FLIGHT: 0,
      FAILED: 0,
      DEAD_LETTER: 0,
      SYNCED: 0,
    });
  } finally {
    fixture.cleanup();
  }
});

test("a local transaction commits with the service unreachable, and the event waits", async () => {
  const fixture = createFixture("offline-local");
  try {
    // Nothing is listening on this port. The local work still has to finish.
    const transport = new HttpSyncTransport({ host: "127.0.0.1", port: 1, timeoutMs: 500 });
    const time = clock("2026-10-01T05:00:00.000Z");

    // The whole local transaction — carton plus event — with nothing listening anywhere.
    assert.equal(recordCarton(fixture.a, "SK9_BLACK_7/10_000009", time.nowIso()), true);
    assert.deepEqual(qrIds(fixture.a), ["SK9_BLACK_7/10_000009"], "the carton is recorded locally");

    const drain = new OutboxDrain(fixture.a.sql, transport, {
      deviceId: fixture.a.deviceId,
      retryPolicy: FAST_RETRY,
      now: time.nowIso,
    });
    const result = await drain.runOnce();

    assert.ok(result.transportError, "the drain reports that the service could not be reached");
    assert.equal(result.synced, 0);
    assert.equal(result.counts.FAILED, 1, "the event is waiting, not lost");
    assert.deepEqual(qrIds(fixture.a), ["SK9_BLACK_7/10_000009"], "and the local record is untouched");
  } finally {
    fixture.cleanup();
  }
});

// ─── delivery and convergence ───────────────────────────────────────────────

test("events reach the other computer and the queue is marked sent", async () => {
  const fixture = createFixture("deliver");
  const backend = await startTestSyncBackend(fixture.b.sql);
  try {
    const time = clock("2026-10-01T05:00:00.000Z");
    for (const serial of ["000001", "000002", "000003"]) {
      recordCarton(fixture.a, `SK9_BLACK_7/10_${serial}`, time.nowIso());
    }

    const drain = new OutboxDrain(
      fixture.a.sql,
      new HttpSyncTransport({ host: backend.host, port: backend.port }),
      { deviceId: fixture.a.deviceId, retryPolicy: FAST_RETRY, now: time.nowIso }
    );
    const result = await drain.runOnce();

    assert.equal(result.leased, 3);
    assert.equal(result.synced, 3);
    assert.equal(result.counts.SYNCED, 3);
    assert.equal(result.counts.PENDING, 0);
    assert.deepEqual(qrIds(fixture.b), [
      "SK9_BLACK_7/10_000001",
      "SK9_BLACK_7/10_000002",
      "SK9_BLACK_7/10_000003",
    ]);

    // The identity arrives as it was created, with the fixed opening state the receiver sets.
    const row = qrRow(fixture.b, "SK9_BLACK_7/10_000001");
    assert.equal(row?.product_variant_id, VARIANT_ID);
    assert.equal(row?.current_status, "PRODUCED");
    assert.equal(row?.current_location_type, "FACTORY");
    assert.equal(row?.current_location_id, null);
  } finally {
    await backend.close();
    fixture.cleanup();
  }
});

test("two computers converge: each sends its own cartons and both end up holding all of them", async () => {
  const fixture = createFixture("converge");
  const backendOnB = await startTestSyncBackend(fixture.b.sql);
  const backendOnA = await startTestSyncBackend(fixture.a.sql);
  try {
    const time = clock("2026-10-01T05:00:00.000Z");
    // Both work offline at the same time, on different cartons.
    recordCarton(fixture.a, "SK9_BLACK_7/10_000001", time.nowIso());
    recordCarton(fixture.a, "SK9_BLACK_7/10_000002", time.nowIso());
    recordCarton(fixture.b, "SK9_BLACK_7/10_100001", time.nowIso());
    recordCarton(fixture.b, "SK9_BLACK_7/10_100002", time.nowIso());

    const aToB = new OutboxDrain(
      fixture.a.sql,
      new HttpSyncTransport({ host: backendOnB.host, port: backendOnB.port }),
      { deviceId: fixture.a.deviceId, retryPolicy: FAST_RETRY, now: time.nowIso }
    );
    const bToA = new OutboxDrain(
      fixture.b.sql,
      new HttpSyncTransport({ host: backendOnA.host, port: backendOnA.port }),
      { deviceId: fixture.b.deviceId, retryPolicy: FAST_RETRY, now: time.nowIso }
    );

    await bToA.runOnce();
    await aToB.runOnce();

    const expected = [
      "SK9_BLACK_7/10_000001",
      "SK9_BLACK_7/10_000002",
      "SK9_BLACK_7/10_100001",
      "SK9_BLACK_7/10_100002",
    ];
    assert.deepEqual(qrIds(fixture.a), expected);
    assert.deepEqual(qrIds(fixture.b), expected);

    // Running again changes nothing, in either direction.
    const again = await aToB.runOnce();
    assert.equal(again.leased, 0);
    assert.deepEqual(qrIds(fixture.b), expected);
  } finally {
    await backendOnA.close();
    await backendOnB.close();
    fixture.cleanup();
  }
});

// ─── exactly-once ───────────────────────────────────────────────────────────

test("the same event delivered three times is applied once and never changes the row", () => {
  const fixture = createFixture("duplicate");
  try {
    const envelope = envelopeFor(fixture.a, "SK9_BLACK_7/10_000001", "2026-10-01T05:00:00.000Z");

    const first = applyEnvelope(fixture.b.sql, envelope);
    const second = applyEnvelope(fixture.b.sql, envelope);
    const third = applyEnvelope(fixture.b.sql, { ...envelope, createdAt: "2026-10-02T05:00:00.000Z" });

    assert.equal(first.status, "APPLIED");
    assert.equal(second.status, "DUPLICATE");
    assert.equal(third.status, "DUPLICATE", "a repeat is recognised even if the envelope differs");

    assert.deepEqual(qrIds(fixture.b), ["SK9_BLACK_7/10_000001"], "exactly one row");
    assert.equal(
      qrRow(fixture.b, "SK9_BLACK_7/10_000001")?.created_at,
      "2026-10-01T05:00:00.000Z",
      "and the first application's values stand"
    );
  } finally {
    fixture.cleanup();
  }
});

test("a batch applied by the receiver whose answer is lost is re-sent and applied once", async () => {
  const fixture = createFixture("lost-ack");
  const backend = await startTestSyncBackend(fixture.b.sql);
  try {
    const time = clock("2026-10-01T05:00:00.000Z");
    recordCarton(fixture.a, "SK9_BLACK_7/10_000001", time.nowIso());
    recordCarton(fixture.a, "SK9_BLACK_7/10_000002", time.nowIso());

    const drain = new OutboxDrain(
      fixture.a.sql,
      new HttpSyncTransport({ host: backend.host, port: backend.port }),
      { deviceId: fixture.a.deviceId, retryPolicy: FAST_RETRY, now: time.nowIso }
    );

    // The receiver applies the batch and then the connection dies. The sender learns nothing.
    backend.setFault("APPLY_THEN_DROP");
    const interrupted = await drain.runOnce();
    assert.equal(interrupted.synced, 0);
    assert.ok(interrupted.transportError);
    assert.deepEqual(qrIds(fixture.b), ["SK9_BLACK_7/10_000001", "SK9_BLACK_7/10_000002"], "but it did arrive");

    // The sender offers it again once the retry is due.
    backend.setFault("NONE");
    time.advanceMs(FAST_RETRY.baseBackoffMs + 1);
    const retried = await drain.runOnce();

    assert.equal(retried.leased, 2);
    assert.equal(retried.synced, 2, "the receiver calls them duplicates and the sender can finish");
    assert.deepEqual(qrIds(fixture.b), ["SK9_BLACK_7/10_000001", "SK9_BLACK_7/10_000002"], "still two rows");
    assert.equal(outboxCounts(fixture.a.sql).SYNCED, 2);
  } finally {
    await backend.close();
    fixture.cleanup();
  }
});

test("a run interrupted after claiming a batch gives the events back", async () => {
  const fixture = createFixture("restart");
  const backend = await startTestSyncBackend(fixture.b.sql);
  try {
    const time = clock("2026-10-01T05:00:00.000Z");
    recordCarton(fixture.a, "SK9_BLACK_7/10_000001", time.nowIso());

    // The state an application killed mid-send leaves behind: claimed, never settled.
    fixture.a.raw
      .prepare("UPDATE sync_outbox SET status = 'IN_FLIGHT', lock_token = 'lost-run', updated_at = ?")
      .run(time.nowIso());
    assert.equal(outboxCounts(fixture.a.sql).IN_FLIGHT, 1);

    // Nothing is reclaimed while it could still be in progress.
    assert.equal(reclaimStale(fixture.a.sql, { nowIso: time.nowIso(), staleInFlightMs: FAST_RETRY.staleInFlightMs }), 0);

    time.advanceMs(FAST_RETRY.staleInFlightMs + 1);
    const drain = new OutboxDrain(
      fixture.a.sql,
      new HttpSyncTransport({ host: backend.host, port: backend.port }),
      { deviceId: fixture.a.deviceId, retryPolicy: FAST_RETRY, now: time.nowIso }
    );
    const result = await drain.runOnce();

    assert.equal(result.reclaimed, 1, "the abandoned claim is taken back");
    assert.equal(result.synced, 1);
    assert.deepEqual(qrIds(fixture.b), ["SK9_BLACK_7/10_000001"]);
  } finally {
    await backend.close();
    fixture.cleanup();
  }
});

// ─── failures that must be seen ─────────────────────────────────────────────

test("a carton naming a product the receiver lacks waits for it, and heals when it arrives", async () => {
  const fixture = createFixture("unknown-variant");
  const backend = await startTestSyncBackend(fixture.b.sql);
  try {
    const time = clock("2026-10-01T05:00:00.000Z");
    // Sent by a computer that has a product the receiver has never been given.
    fixture.a.raw
      .prepare(
        `INSERT INTO product_variants (id, article, color, size, status, created_at, updated_at)
         VALUES ('variant-only-on-a', 'SK46', 'GREY', '6/9', 'ACTIVE', ?, ?)`
      )
      .run(time.nowIso(), time.nowIso());
    enqueueQrMasterInsert(
      fixture.a.sql,
      {
        identity: {
          qrId: "SK46_GREY_6/9_000001",
          productVariantId: "variant-only-on-a",
          createdAt: time.nowIso(),
        },
        originDeviceId: fixture.a.deviceId,
        outboxId: crypto.randomUUID(),
      },
      time.nowIso()
    );

    const drain = new OutboxDrain(
      fixture.a.sql,
      new HttpSyncTransport({ host: backend.host, port: backend.port }),
      { deviceId: fixture.a.deviceId, retryPolicy: FAST_RETRY, now: time.nowIso }
    );
    const result = await drain.runOnce();

    // WAITS, rather than being parked. The product is missing, not wrong: the owner seeds it and
    // the carton then goes through. Parking it meant the carton silently stopped being sent, and
    // seeding the product afterwards healed nothing.
    assert.equal(result.deadLettered, 0, "a missing prerequisite must never park a good carton");
    assert.equal(result.counts.DEAD_LETTER, 0);
    assert.equal(result.counts.FAILED, 1, "it is waiting, and will be offered again");
    assert.deepEqual(deadLetters(fixture.a.sql), []);
    assert.deepEqual(qrIds(fixture.b), [], "nothing was written on the receiver yet");

    // However many times it is offered, it is never parked -- the wait only lengthens.
    for (let pass = 0; pass < FAST_RETRY.maxAttempts * 3; pass += 1) {
      time.advanceMs(FAST_RETRY.maxBackoffMs);
      await drain.runOnce();
    }
    assert.equal(outboxCounts(fixture.a.sql).DEAD_LETTER, 0, "still not parked after many passes");
    assert.equal(outboxCounts(fixture.a.sql).FAILED, 1);

    // The owner seeds the product on the receiving side. The SAME waiting event now goes through,
    // with nothing reset by hand.
    fixture.b.raw
      .prepare(
        `INSERT INTO product_variants (id, article, color, size, status, created_at, updated_at)
         VALUES ('variant-only-on-a', 'SK46', 'GREY', '6/9', 'ACTIVE', ?, ?)`
      )
      .run(time.nowIso(), time.nowIso());

    time.advanceMs(FAST_RETRY.maxBackoffMs);
    const healed = await drain.runOnce();
    assert.equal(healed.synced, 1, "it heals itself once the prerequisite exists");
    assert.deepEqual(qrIds(fixture.b), ["SK46_GREY_6/9_000001"]);
    assert.equal(outboxCounts(fixture.a.sql).SYNCED, 1);
  } finally {
    await backend.close();
    fixture.cleanup();
  }
});

test("a service that keeps failing is retried for ever and never parks the carton", async () => {
  const fixture = createFixture("outage");
  const backend = await startTestSyncBackend(fixture.b.sql);
  try {
    const time = clock("2026-10-01T05:00:00.000Z");
    recordCarton(fixture.a, "SK9_BLACK_7/10_000001", time.nowIso());
    backend.setFault("SERVER_ERROR");

    const drain = new OutboxDrain(
      fixture.a.sql,
      new HttpSyncTransport({ host: backend.host, port: backend.port }),
      { deviceId: fixture.a.deviceId, retryPolicy: FAST_RETRY, now: time.nowIso }
    );

    // Far more passes than the refusal limit. An outage is not the carton's fault, and parking
    // it at a counter meant a few minutes offline silently stopped it being sent.
    for (let pass = 0; pass < FAST_RETRY.maxAttempts * 4; pass += 1) {
      const result = await drain.runOnce();
      assert.equal(result.deadLettered, 0, `pass ${String(pass)} must not park the carton`);
      time.advanceMs(FAST_RETRY.maxBackoffMs);
    }

    assert.equal(outboxCounts(fixture.a.sql).DEAD_LETTER, 0);
    assert.equal(outboxCounts(fixture.a.sql).FAILED, 1, "still waiting, still ours");
    assert.deepEqual(qrIds(fixture.b), []);

    // The service comes back. The carton goes, with nothing recovered by hand.
    backend.setFault("NONE");
    time.advanceMs(FAST_RETRY.maxBackoffMs);
    assert.equal((await drain.runOnce()).synced, 1);
    assert.deepEqual(qrIds(fixture.b), ["SK9_BLACK_7/10_000001"]);
  } finally {
    await backend.close();
    fixture.cleanup();
  }
});

test("the wait between tries widens but is capped, so an outage neither hammers nor stalls", () => {
  const fixture = createFixture("backoff-cap");
  try {
    const policy: OutboxRetryPolicy = {
      maxAttempts: 5,
      baseBackoffMs: 1_000,
      maxBackoffMs: 8_000,
      staleInFlightMs: 60_000,
    };
    const start = "2026-10-01T05:00:00.000Z";
    recordCarton(fixture.a, "SK9_BLACK_7/10_000001", start);
    const row = fixture.a.raw.prepare("SELECT id FROM sync_outbox LIMIT 1").get() as { id: string };

    const waits: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      markFailed(
        fixture.a.sql,
        { outboxId: row.id, attempts: 0, transientAttempts: attempt, error: "offline", kind: "TRANSIENT" },
        start,
        policy
      );
      const after = fixture.a.raw
        .prepare("SELECT available_at FROM sync_outbox WHERE id = ?")
        .get(row.id) as { available_at: string };
      waits.push(new Date(after.available_at).getTime() - new Date(start).getTime());
    }

    assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000, 8_000, 8_000], "doubles, then holds at the cap");
    assert.equal(outboxCounts(fixture.a.sql).DEAD_LETTER, 0);
  } finally {
    fixture.cleanup();
  }
});

test("a service that never answers is a failure, not a hang the application inherits", async () => {
  const fixture = createFixture("hang");
  const backend = await startTestSyncBackend(fixture.b.sql);
  try {
    const time = clock("2026-10-01T05:00:00.000Z");
    recordCarton(fixture.a, "SK9_BLACK_7/10_000001", time.nowIso());
    backend.setFault("HANG");

    const drain = new OutboxDrain(
      fixture.a.sql,
      new HttpSyncTransport({ host: backend.host, port: backend.port, timeoutMs: 300 }),
      { deviceId: fixture.a.deviceId, retryPolicy: FAST_RETRY, now: time.nowIso }
    );
    const result = await drain.runOnce();

    assert.match(result.transportError ?? "", /did not answer in time/);
    assert.equal(result.counts.FAILED, 1);
  } finally {
    await backend.close();
    fixture.cleanup();
  }
});

// ─── what must not travel ───────────────────────────────────────────────────

test("an event type whose contract is incomplete is refused, never written with guessed values", () => {
  const fixture = createFixture("unsupported");
  try {
    // Exactly what production.ts enqueues today for a PRODUCED scan. It names no product variant
    // and no article, colour, size or serial, all of which production_events requires.
    const produced: SyncEnvelope = {
      dedupeKey: "PRODUCTION_EVENT:event-1",
      aggregateType: "PRODUCTION_EVENT",
      aggregateId: "event-1",
      operation: "INSERT",
      payload: {
        eventId: "event-1",
        qrId: "SK9_BLACK_7/10_000001",
        parserVersion: "v1",
        factoryId: FACTORY_ID,
        workstationId: "ws-1",
        deviceId: "device-a",
        createdAt: "2026-10-01T05:00:00.000Z",
      },
      originDeviceId: "device-a",
      createdAt: "2026-10-01T05:00:00.000Z",
    };

    for (const aggregateType of ["PRODUCTION_EVENT", "DISPATCH_EVENT", "RETURN_EVENT", "PROJECTION"]) {
      const outcome = applyEnvelope(fixture.b.sql, { ...produced, aggregateType });
      assert.equal(outcome.status, "REJECTED", `${aggregateType} must be refused`);
      assert.equal(outcome.permanent, true, `${aggregateType} must not be retried`);
      assert.match(outcome.reason ?? "", /UNSUPPORTED_AGGREGATE_TYPE/);
    }

    assert.equal(
      (fixture.b.raw.prepare("SELECT COUNT(*) AS n FROM production_events").get() as { n: number }).n,
      0,
      "nothing was written"
    );
    assert.deepEqual(qrIds(fixture.b), []);
  } finally {
    fixture.cleanup();
  }
});

test("a QR_MASTER payload missing a required fact is refused rather than defaulted", () => {
  const fixture = createFixture("incomplete-payload");
  try {
    const base = envelopeFor(fixture.a, "SK9_BLACK_7/10_000001", "2026-10-01T05:00:00.000Z");

    const noVariant = applyEnvelope(fixture.b.sql, { ...base, payload: { qrId: base.aggregateId, createdAt: base.createdAt } });
    assert.equal(noVariant.status, "REJECTED");
    assert.equal(noVariant.reason, "PAYLOAD_INCOMPLETE");

    const mismatched = applyEnvelope(fixture.b.sql, { ...base, aggregateId: "SOMETHING_ELSE" });
    assert.equal(mismatched.status, "REJECTED");
    assert.equal(mismatched.reason, "AGGREGATE_ID_MISMATCH");

    const notAnInsert = applyEnvelope(fixture.b.sql, { ...base, operation: "UPDATE" });
    assert.equal(notAnInsert.status, "REJECTED");
    assert.match(notAnInsert.reason ?? "", /UNSUPPORTED_OPERATION/);

    assert.deepEqual(qrIds(fixture.b), []);
  } finally {
    fixture.cleanup();
  }
});

test("the QR_MASTER contract carries identity only — no status, location or quantity", () => {
  const fixture = createFixture("contract-shape");
  try {
    recordCarton(fixture.a, "SK9_BLACK_7/10_000001", "2026-10-01T05:00:00.000Z");
    const row = fixture.a.raw.prepare("SELECT payload_json FROM sync_outbox").get() as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;

    assert.deepEqual(Object.keys(payload).sort(), ["createdAt", "productVariantId", "qrId"]);
    // Pinned deliberately: a mutable value added here would start being merged by last-write-wins.
    for (const forbidden of ["currentStatus", "currentLocationType", "quantityOnHand", "quantity"]) {
      assert.equal(forbidden in payload, false, `${forbidden} must never travel`);
    }
  } finally {
    fixture.cleanup();
  }
});

test("a batch that is not what the contract describes is refused at the service boundary", async () => {
  const fixture = createFixture("bad-request");
  const backend = await startTestSyncBackend(fixture.b.sql);
  try {
    const transport: SyncTransport = new HttpSyncTransport({ host: backend.host, port: backend.port });
    // An envelope missing its dedupe key never reaches an applier.
    const broken = { aggregateType: "QR_MASTER", aggregateId: "x", operation: "INSERT", payload: {} };
    await assert.rejects(
      () => transport.send([broken as unknown as SyncEnvelope]),
      /answered 400/
    );
    assert.deepEqual(qrIds(fixture.b), []);
  } finally {
    await backend.close();
    fixture.cleanup();
  }
});
