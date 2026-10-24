import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { enqueueProductionProduced, enqueueQrMaster, productionProducedDedupeKey } from "@erp/data";
import type { ProductionProducedPayload } from "@erp/data";
import { OutboxDrain } from "./drain.js";
import { SyncPull } from "./pull.js";
import { readPullCursor, readPullDeferral } from "./pullCursor.js";
import type { OutboxRetryPolicy } from "./outboxQueue.js";
import { HttpSyncTransport } from "./transport.js";
import { startTestSyncBackend, type TestSyncBackend } from "./testOnlyBackend.js";
import type { SyncSqlHandle } from "./sqlPort.js";
import type { SyncEnvelope } from "./contract.js";

// PC2 SHOWING WHAT PC1 RECORDED.
//
// The shape of the real deployment, in miniature: a shared store in the middle, and two computers
// that each push what they recorded and pull what the other did. Three throwaway SQLite files per
// test under the OS temp folder, built from the real local-schema.sql plus migration 082, talking
// over a real socket. The production database is never opened and none of its data is used.
//
// What these prove:
//
//   * a computer that has pulled holds the other computer's cartons and scans
//   * pulling twice changes nothing — the cursor moves, repeats are no-ops
//   * BOTH computers end up with BOTH computers' work
//   * a pull stops at an event whose prerequisite has not arrived and resumes after it has,
//     without skipping anything
//   * an event the receiving computer can never apply is stepped over and reported, not silently
//     dropped and not retried for ever
//   * a failure to reach the store leaves the cursor exactly where it was

const SCHEMA_PATH = path.resolve(import.meta.dirname, "../../data/src/local-schema.sql");
const MIGRATION_082 = path.resolve(
  import.meta.dirname,
  "../../../migrations/sqlite/082_sync_outbox_production_produced.up.sql"
);
const MIGRATION_083 = path.resolve(
  import.meta.dirname,
  "../../../migrations/sqlite/083_sync_outbox_transient_attempts.up.sql"
);
const MIGRATION_088 = path.resolve(import.meta.dirname, "../../../migrations/sqlite/088_replicated_at.up.sql");

const FAST_RETRY: OutboxRetryPolicy = { maxAttempts: 4, baseBackoffMs: 1_000, maxBackoffMs: 60_000, staleInFlightMs: 60_000 };

const FACTORY_ID = "factory-777";
const VARIANT_ID = "variant-sk9-black-7-10";
const SEEDED_AT = "2026-10-01T04:00:00.000Z";

interface Store {
  readonly sql: SyncSqlHandle;
  readonly raw: DatabaseSync;
}

interface Node extends Store {
  readonly deviceId: string;
  readonly workstationId: string;
}

function runMigration(raw: DatabaseSync, file: string): void {
  for (const statement of fs.readFileSync(file, "utf8").split(";")) {
    const trimmed = statement.trim();
    if (trimmed) raw.exec(trimmed);
  }
}

/** A database with the real schema and the master data every participant is given. */
function createStore(root: string, name: string): Store {
  const raw = new DatabaseSync(path.join(root, `${name}.db`));
  raw.exec("PRAGMA journal_mode = WAL;");
  raw.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
  runMigration(raw, MIGRATION_082);
  runMigration(raw, MIGRATION_083);
  runMigration(raw, MIGRATION_088);
  raw.exec("PRAGMA foreign_keys = ON;");
  raw
    .prepare(
      `INSERT INTO factories (id, code, name, timezone, is_active, created_at, updated_at)
       VALUES (?, '777', '777 Manufacturing', 'Asia/Karachi', 1, ?, ?)`
    )
    .run(FACTORY_ID, SEEDED_AT, SEEDED_AT);
  raw
    .prepare(
      `INSERT INTO product_variants (id, article, color, size, status, created_at, updated_at)
       VALUES (?, 'SK9', 'BLACK', '7/10', 'ACTIVE', ?, ?)`
    )
    .run(VARIANT_ID, SEEDED_AT, SEEDED_AT);
  return { sql: raw as unknown as SyncSqlHandle, raw };
}

function seedWorkstation(store: Store, workstationId: string, suffix: string): void {
  store.raw
    .prepare(
      `INSERT INTO workstations (id, factory_id, workstation_code, device_id, name, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    )
    .run(workstationId, FACTORY_ID, `WS-TEST-${suffix}`, `dev-${suffix}`, `Station ${suffix}`, SEEDED_AT, SEEDED_AT);
}

interface Fixture {
  readonly pc1: Node;
  readonly pc2: Node;
  readonly hub: Store;
  readonly backend: TestSyncBackend;
  cleanup(): Promise<void>;
}

/** Two computers and the shared store between them, with every prerequisite in place. */
async function createFixture(prefix: string): Promise<Fixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `erp-pull-${prefix}-`));
  const hub = createStore(root, "hub");
  const pc1: Node = { ...createStore(root, "pc1"), deviceId: "device-pc1", workstationId: "workstation-pc1" };
  const pc2: Node = { ...createStore(root, "pc2"), deviceId: "device-pc2", workstationId: "workstation-pc2" };

  // Master data is NOT synchronised: every participant must already hold the stations whose scans
  // it will see. Device enrolment has to do this before events flow.
  for (const store of [hub, pc1, pc2]) {
    seedWorkstation(store, pc1.workstationId, "PC1");
    seedWorkstation(store, pc2.workstationId, "PC2");
  }

  const backend = await startTestSyncBackend(hub.sql);
  return {
    pc1,
    pc2,
    hub,
    backend,
    cleanup: async () => {
      await backend.close();
      hub.raw.close();
      pc1.raw.close();
      pc2.raw.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const clock = (startIso: string) => {
  let current = new Date(startIso).getTime();
  return {
    nowIso: () => new Date(current).toISOString(),
    nowMs: () => current,
    advanceMs: (ms: number) => {
      current += ms;
    },
  };
};

/** Records one production scan as the application does: rows and both queue entries, one commit. */
function recordScan(
  node: Node,
  input: { qrId: string; serial: string; occurredAt: string; variantId?: string; workstationId?: string }
): { eventId: string } {
  const variantId = input.variantId ?? VARIANT_ID;
  const workstationId = input.workstationId ?? node.workstationId;
  const eventId = crypto.randomUUID();
  const metadataJson = JSON.stringify({ parserVersion: "v1" });
  const eventDate = input.occurredAt.slice(0, 10);
  const eventHour = new Date(input.occurredAt).getHours();

  node.raw.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    node.raw
      .prepare(
        `INSERT INTO qr_master (qr_id, product_variant_id, current_status, current_location_type,
           current_location_id, first_event_id, created_at, updated_at)
         VALUES (?, ?, 'PRODUCED', 'FACTORY', NULL, NULL, ?, ?)`
      )
      .run(input.qrId, variantId, input.occurredAt, input.occurredAt);
    enqueueQrMaster(
      node.sql,
      { qrId: input.qrId, productVariantId: variantId, createdAt: input.occurredAt },
      crypto.randomUUID()
    );
    node.raw
      .prepare(
        `INSERT INTO production_events (
           id, qr_id, product_variant_id, event_type, event_ts_local, event_date, event_hour,
           factory_id, workstation_id, operator_id, device_id,
           article_snapshot, color_snapshot, size_snapshot, serial_snapshot,
           metadata_json, created_at, sync_status, synced_at, sync_error, retry_count, source_app
         ) VALUES (?, ?, ?, 'PRODUCED', ?, ?, ?, ?, ?, NULL, ?, 'SK9', 'BLACK', '7/10', ?, ?, ?, 'PENDING', NULL, NULL, 0, 'desktop-scanner')`
      )
      .run(
        eventId,
        input.qrId,
        variantId,
        input.occurredAt,
        eventDate,
        eventHour,
        FACTORY_ID,
        workstationId,
        node.deviceId,
        input.serial,
        metadataJson,
        input.occurredAt
      );
    const payload: ProductionProducedPayload = {
      eventId,
      qrId: input.qrId,
      productVariantId: variantId,
      occurredAt: input.occurredAt,
      eventDate,
      eventHour,
      factoryId: FACTORY_ID,
      workstationId,
      operatorId: null,
      deviceId: node.deviceId,
      article: "SK9",
      color: "BLACK",
      size: "7/10",
      serial: input.serial,
      metadataJson,
      createdAt: input.occurredAt,
      sourceApp: "desktop-scanner",
    };
    enqueueProductionProduced(node.sql, payload, crypto.randomUUID());
    node.raw.exec("COMMIT");
    return { eventId };
  } catch (error) {
    node.raw.exec("ROLLBACK");
    throw error;
  }
}

const qrIds = (store: Store): string[] =>
  (store.raw.prepare("SELECT qr_id FROM qr_master ORDER BY qr_id").all() as Array<{ qr_id: string }>).map(
    (row) => row.qr_id
  );

const eventSerials = (store: Store): string[] =>
  (
    store.raw.prepare("SELECT serial_snapshot FROM production_events ORDER BY serial_snapshot").all() as Array<{
      serial_snapshot: string;
    }>
  ).map((row) => row.serial_snapshot);

const pusher = (node: Node, backend: TestSyncBackend, now: () => string) =>
  new OutboxDrain(node.sql, new HttpSyncTransport({ host: backend.host, port: backend.port }), {
    deviceId: node.deviceId,
    retryPolicy: FAST_RETRY,
    now,
  });

/** The clock is injected so a test can step past a recorded wait instead of sleeping. */
const puller = (node: Node, backend: TestSyncBackend, now?: () => number) =>
  new SyncPull(node.sql, new HttpSyncTransport({ host: backend.host, port: backend.port }), {
    deferBaseMs: 1_000,
    deferMaxMs: 8_000,
    now,
  });

// ─── the deployment goal, in miniature ──────────────────────────────────────

test("an empty shared store leaves the cursor where it was", async () => {
  const fixture = await createFixture("empty");
  try {
    const result = await puller(fixture.pc2, fixture.backend).runOnce();
    assert.equal(result.fetched, 0);
    assert.equal(result.applied, 0);
    assert.equal(result.cursor, 0);
    assert.equal(readPullCursor(fixture.pc2.sql), 0);
    assert.deepEqual(qrIds(fixture.pc2), []);
  } finally {
    await fixture.cleanup();
  }
});

test("PC2 pulls and shows what PC1 recorded", async () => {
  const fixture = await createFixture("pc2-sees");
  try {
    const time = clock("2026-10-01T09:00:00.000Z");
    const { eventId } = recordScan(fixture.pc1, {
      qrId: "SK9_BLACK_7/10_000001",
      serial: "000001",
      occurredAt: time.nowIso(),
    });

    // PC1 sends what it recorded.
    const pushed = await pusher(fixture.pc1, fixture.backend, time.nowIso).runOnce();
    assert.equal(pushed.synced, 2);
    assert.deepEqual(qrIds(fixture.pc2), [], "PC2 knows nothing yet");

    // PC2 reads the shared store.
    const pulled = await puller(fixture.pc2, fixture.backend, time.nowMs).runOnce();
    assert.equal(pulled.fetched, 2);
    assert.equal(pulled.applied, 2);
    assert.deepEqual(pulled.refused, []);
    assert.equal(pulled.waitingFor, undefined);

    assert.deepEqual(qrIds(fixture.pc2), ["SK9_BLACK_7/10_000001"]);
    const row = fixture.pc2.raw.prepare("SELECT * FROM production_events WHERE id = ?").get(eventId) as
      | Record<string, unknown>
      | undefined;
    assert.ok(row, "the production scan is on PC2");
    assert.equal(row?.serial_snapshot, "000001");
    assert.equal(row?.workstation_id, fixture.pc1.workstationId, "recorded as PC1's work, not PC2's");
    assert.equal(row?.event_type, "PRODUCED");
    assert.equal(readPullCursor(fixture.pc2.sql), pulled.cursor);
  } finally {
    await fixture.cleanup();
  }
});

test("pulling again changes nothing", async () => {
  const fixture = await createFixture("idempotent-pull");
  try {
    const time = clock("2026-10-01T09:15:00.000Z");
    recordScan(fixture.pc1, { qrId: "SK9_BLACK_7/10_000001", serial: "000001", occurredAt: time.nowIso() });
    await pusher(fixture.pc1, fixture.backend, time.nowIso).runOnce();

    const pull = puller(fixture.pc2, fixture.backend, time.nowMs);
    const first = await pull.runOnce();
    const second = await pull.runOnce();

    assert.equal(first.applied, 2);
    assert.equal(second.fetched, 0, "the cursor has moved past them");
    assert.equal(second.applied, 0);
    assert.equal(second.cursor, first.cursor);
    assert.deepEqual(qrIds(fixture.pc2), ["SK9_BLACK_7/10_000001"]);
    assert.equal(
      (fixture.pc2.raw.prepare("SELECT COUNT(*) AS n FROM production_events").get() as { n: number }).n,
      1
    );
  } finally {
    await fixture.cleanup();
  }
});

test("both computers end up holding both computers' work", async () => {
  const fixture = await createFixture("converge");
  try {
    const time = clock("2026-10-01T09:30:00.000Z");
    recordScan(fixture.pc1, { qrId: "SK9_BLACK_7/10_000001", serial: "000001", occurredAt: time.nowIso() });
    recordScan(fixture.pc2, { qrId: "SK9_BLACK_7/10_100001", serial: "100001", occurredAt: time.nowIso() });

    // Each sends its own, then reads the other's.
    await pusher(fixture.pc1, fixture.backend, time.nowIso).runOnce();
    await pusher(fixture.pc2, fixture.backend, time.nowIso).runOnce();
    await puller(fixture.pc1, fixture.backend, time.nowMs).runOnce();
    await puller(fixture.pc2, fixture.backend, time.nowMs).runOnce();

    const expectedQrs = ["SK9_BLACK_7/10_000001", "SK9_BLACK_7/10_100001"];
    const expectedSerials = ["000001", "100001"];
    for (const store of [fixture.pc1, fixture.pc2, fixture.hub]) {
      assert.deepEqual(qrIds(store), expectedQrs);
      assert.deepEqual(eventSerials(store), expectedSerials);
    }
  } finally {
    await fixture.cleanup();
  }
});

// ─── order and prerequisites ────────────────────────────────────────────────

test("a pull waits at a scan whose carton has not arrived, then finishes it later", async () => {
  const fixture = await createFixture("waits");
  try {
    const time = clock("2026-10-01T09:45:00.000Z");
    const { eventId } = recordScan(fixture.pc1, {
      qrId: "SK9_BLACK_7/10_000001",
      serial: "000001",
      occurredAt: time.nowIso(),
    });

    // Put ONLY the scan in the shared log, as if its identity were still in flight.
    const scanRow = fixture.pc1.raw
      .prepare("SELECT payload_json FROM sync_outbox WHERE aggregate_type = 'PRODUCTION_PRODUCED'")
      .get() as { payload_json: string };
    const scanEnvelope: SyncEnvelope = {
      dedupeKey: productionProducedDedupeKey(eventId),
      aggregateType: "PRODUCTION_PRODUCED",
      aggregateId: eventId,
      operation: "INSERT",
      payload: JSON.parse(scanRow.payload_json) as Record<string, unknown>,
      originDeviceId: fixture.pc1.deviceId,
      createdAt: time.nowIso(),
    };
    fixture.hub.raw
      .prepare("INSERT INTO hub_event_log (dedupe_key, envelope_json) VALUES (?, ?)")
      .run(scanEnvelope.dedupeKey, JSON.stringify(scanEnvelope));

    const pull = puller(fixture.pc2, fixture.backend, time.nowMs);
    const stalled = await pull.runOnce();
    assert.equal(stalled.applied, 0);
    assert.ok(stalled.waitingFor, "the run says what it is waiting for");
    assert.match(stalled.waitingFor?.reason ?? "", /QR_NOT_REGISTERED_YET/);
    assert.equal(stalled.cursor, 0, "and the cursor did not step over it");
    assert.equal(readPullCursor(fixture.pc2.sql), 0);

    // The identity arrives. Because the cursor stayed put, the scan is offered again -- once
    // the recorded wait has elapsed, which is what stops a blocked pull spinning.
    await pusher(fixture.pc1, fixture.backend, time.nowIso).runOnce();
    time.advanceMs(10_000);
    const finished = await pull.runOnce();

    assert.equal(finished.waitingFor, undefined);
    assert.deepEqual(qrIds(fixture.pc2), ["SK9_BLACK_7/10_000001"]);
    assert.equal(eventSerials(fixture.pc2).length, 1, "and the scan landed exactly once");
    assert.ok(readPullCursor(fixture.pc2.sql) > 0);
  } finally {
    await fixture.cleanup();
  }
});

test("a pull waits for a missing product instead of stepping over the carton", async () => {
  const fixture = await createFixture("refused");
  try {
    const time = clock("2026-10-01T10:00:00.000Z");
    // A carton naming a product PC2 was never given, followed by one it has.
    fixture.pc1.raw
      .prepare(
        `INSERT INTO product_variants (id, article, color, size, status, created_at, updated_at)
         VALUES ('variant-only-on-pc1', 'SK46', 'GREY', '6/9', 'ACTIVE', ?, ?)`
      )
      .run(SEEDED_AT, SEEDED_AT);
    fixture.hub.raw
      .prepare(
        `INSERT INTO product_variants (id, article, color, size, status, created_at, updated_at)
         VALUES ('variant-only-on-pc1', 'SK46', 'GREY', '6/9', 'ACTIVE', ?, ?)`
      )
      .run(SEEDED_AT, SEEDED_AT);
    enqueueQrMaster(
      fixture.pc1.sql,
      { qrId: "SK46_GREY_6/9_000001", productVariantId: "variant-only-on-pc1", createdAt: time.nowIso() },
      crypto.randomUUID()
    );
    recordScan(fixture.pc1, { qrId: "SK9_BLACK_7/10_000002", serial: "000002", occurredAt: time.nowIso() });

    await pusher(fixture.pc1, fixture.backend, time.nowIso).runOnce();
    const pulled = await puller(fixture.pc2, fixture.backend, time.nowMs).runOnce();

    // WAITS at the carton it cannot place, and does not step over it. Stepping over meant the
    // cursor moved on, so seeding the product afterwards healed nothing and that carton was
    // missed for good -- the likeliest mistake while two computers are being set up.
    assert.deepEqual(pulled.refused, [], "a missing product is not a permanent refusal");
    assert.ok(pulled.waitingFor, "the run says what it is waiting for");
    assert.match(pulled.waitingFor?.reason ?? "", /UNKNOWN_PRODUCT_VARIANT/);
    assert.equal(pulled.cursor, 0, "and the cursor stayed put");
    // Later events are still applied -- applying is idempotent, so getting on with what it can is
    // free. What must not happen is the CURSOR moving past the blocked one, which is what would
    // lose it. The applied ones are simply offered again next time and recognised as duplicates.
    assert.deepEqual(qrIds(fixture.pc2), ["SK9_BLACK_7/10_000002"], "it gets on with what it can");

    // It does not spin: a wait is recorded, and a pull inside it does not even look.
    const tooSoon = await puller(fixture.pc2, fixture.backend, time.nowMs).runOnce();
    assert.equal(tooSoon.fetched, 0, "no request is made while the wait is running");
    assert.ok(tooSoon.deferredUntil, "and it says when it is worth trying again");

    // The owner seeds the product on PC2. The SAME event applies, with no cursor reset by hand.
    fixture.pc2.raw
      .prepare(
        `INSERT INTO product_variants (id, article, color, size, status, created_at, updated_at)
         VALUES ('variant-only-on-pc1', 'SK46', 'GREY', '6/9', 'ACTIVE', ?, ?)`
      )
      .run(SEEDED_AT, SEEDED_AT);

    time.advanceMs(10_000);
    const healed = await puller(fixture.pc2, fixture.backend, time.nowMs).runOnce();

    assert.equal(healed.waitingFor, undefined);
    assert.deepEqual(qrIds(fixture.pc2), ["SK46_GREY_6/9_000001", "SK9_BLACK_7/10_000002"]);
    assert.ok(healed.cursor > 0, "and the cursor finally moves");
    // The recorded wait is cleared once nothing is blocked.
    assert.equal(readPullDeferral(fixture.pc2.sql), null);
  } finally {
    await fixture.cleanup();
  }
});

test("an event that can never be applied is stepped over, reported, and not offered again", async () => {
  const fixture = await createFixture("never-appliable");
  try {
    const time = clock("2026-10-01T10:05:00.000Z");
    recordScan(fixture.pc1, { qrId: "SK9_BLACK_7/10_000003", serial: "000003", occurredAt: time.nowIso() });
    await pusher(fixture.pc1, fixture.backend, time.nowIso).runOnce();

    // An event type with no contract at all. No amount of master data makes this appliable, so
    // unlike a missing product it is stepped over rather than waited on.
    fixture.hub.raw
      .prepare("INSERT INTO hub_event_log (dedupe_key, envelope_json) VALUES (?, ?)")
      .run(
        "DISPATCH_EVENT:e-1",
        JSON.stringify({
          dedupeKey: "DISPATCH_EVENT:e-1",
          aggregateType: "DISPATCH_EVENT",
          aggregateId: "e-1",
          operation: "INSERT",
          payload: { eventId: "e-1" },
          originDeviceId: fixture.pc1.deviceId,
          createdAt: time.nowIso(),
        })
      );

    const pulled = await puller(fixture.pc2, fixture.backend, time.nowMs).runOnce();

    assert.equal(pulled.refused.length, 1);
    assert.match(pulled.refused[0]?.reason ?? "", /UNSUPPORTED_AGGREGATE_TYPE/);
    assert.equal(pulled.waitingFor, undefined, "it is not something to wait for");
    assert.deepEqual(qrIds(fixture.pc2), ["SK9_BLACK_7/10_000003"], "the real work still arrived");

    const again = await puller(fixture.pc2, fixture.backend, time.nowMs).runOnce();
    assert.equal(again.fetched, 0, "the cursor moved past it, and it is reported once");
    assert.deepEqual(again.refused, []);
  } finally {
    await fixture.cleanup();
  }
});

test("a hole left by a rolled-back writer is stepped over, not waited for", async () => {
  const fixture = await createFixture("hole");
  try {
    const time = clock("2026-10-01T10:05:00.000Z");

    // Carton A goes through normally and takes positions 1 and 2.
    recordScan(fixture.pc1, { qrId: "SK9_BLACK_7/10_000001", serial: "000001", occurredAt: time.nowIso() });
    await pusher(fixture.pc1, fixture.backend, time.nowIso).runOnce();
    assert.equal(
      (fixture.hub.raw.prepare("SELECT COUNT(*) AS n FROM hub_event_log").get() as { n: number }).n,
      2
    );

    // Carton B's writer took positions 3 and 4 and then rolled back, so those positions are
    // burnt and nothing will ever appear in them. Its retry took 5 and 6. Sequences do not roll
    // back, which is exactly why a hole is permanent — and why waiting for one would hang for
    // ever.
    recordScan(fixture.pc1, { qrId: "SK9_BLACK_7/10_000002", serial: "000002", occurredAt: time.nowIso() });
    const pending = fixture.pc1.raw
      .prepare(
        `SELECT aggregate_type, aggregate_id, dedupe_key, payload_json
           FROM sync_outbox WHERE status = 'PENDING' ORDER BY rowid`
      )
      .all() as Array<{ aggregate_type: string; aggregate_id: string; dedupe_key: string; payload_json: string }>;
    assert.equal(pending.length, 2);
    pending.forEach((row, index) => {
      const envelope: SyncEnvelope = {
        dedupeKey: row.dedupe_key,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        operation: "INSERT",
        payload: JSON.parse(row.payload_json) as Record<string, unknown>,
        originDeviceId: fixture.pc1.deviceId,
        createdAt: time.nowIso(),
      };
      fixture.hub.raw
        .prepare("INSERT INTO hub_event_log (seq, dedupe_key, envelope_json) VALUES (?, ?, ?)")
        .run(5 + index, row.dedupe_key, JSON.stringify(envelope));
    });

    const pulled = await puller(fixture.pc2, fixture.backend, time.nowMs).runOnce();

    assert.equal(pulled.fetched, 4, "positions 3 and 4 simply are not there");
    assert.equal(pulled.applied, 4);
    assert.equal(pulled.waitingFor, undefined, "a hole is not something to wait for");
    assert.equal(pulled.cursor, 6, "and the cursor moves past it");
    assert.deepEqual(qrIds(fixture.pc2), ["SK9_BLACK_7/10_000001", "SK9_BLACK_7/10_000002"]);
    assert.deepEqual(eventSerials(fixture.pc2), ["000001", "000002"]);

    // Nothing can arrive in the hole later, so a second read finds nothing and does not stall.
    const again = await puller(fixture.pc2, fixture.backend, time.nowMs).runOnce();
    assert.equal(again.fetched, 0);
    assert.equal(readPullCursor(fixture.pc2.sql), 6);
  } finally {
    await fixture.cleanup();
  }
});

// ─── failure ────────────────────────────────────────────────────────────────

test("a store that cannot be reached leaves the cursor exactly where it was", async () => {
  const fixture = await createFixture("offline");
  try {
    const time = clock("2026-10-01T10:15:00.000Z");
    recordScan(fixture.pc1, { qrId: "SK9_BLACK_7/10_000001", serial: "000001", occurredAt: time.nowIso() });
    await pusher(fixture.pc1, fixture.backend, time.nowIso).runOnce();
    await puller(fixture.pc2, fixture.backend, time.nowMs).runOnce();
    const settled = readPullCursor(fixture.pc2.sql);
    assert.ok(settled > 0);

    // Nothing is listening on this port.
    const offline = new SyncPull(fixture.pc2.sql, new HttpSyncTransport({ host: "127.0.0.1", port: 1, timeoutMs: 500 }));
    const result = await offline.runOnce();

    assert.ok(result.transportError, "the run reports it could not reach the store");
    assert.equal(result.cursor, settled);
    assert.equal(readPullCursor(fixture.pc2.sql), settled);
    assert.deepEqual(qrIds(fixture.pc2), ["SK9_BLACK_7/10_000001"], "and what it already had is untouched");
  } finally {
    await fixture.cleanup();
  }
});

test("a store that answers with an error does not move the cursor either", async () => {
  const fixture = await createFixture("server-error");
  try {
    const time = clock("2026-10-01T10:30:00.000Z");
    recordScan(fixture.pc1, { qrId: "SK9_BLACK_7/10_000001", serial: "000001", occurredAt: time.nowIso() });
    await pusher(fixture.pc1, fixture.backend, time.nowIso).runOnce();

    fixture.backend.setFault("SERVER_ERROR");
    const result = await puller(fixture.pc2, fixture.backend, time.nowMs).runOnce();
    assert.match(result.transportError ?? "", /answered 500/);
    assert.equal(readPullCursor(fixture.pc2.sql), 0);
    assert.deepEqual(qrIds(fixture.pc2), []);

    fixture.backend.setFault("NONE");
    const recovered = await puller(fixture.pc2, fixture.backend, time.nowMs).runOnce();
    assert.equal(recovered.applied, 2);
    assert.deepEqual(qrIds(fixture.pc2), ["SK9_BLACK_7/10_000001"]);
  } finally {
    await fixture.cleanup();
  }
});
