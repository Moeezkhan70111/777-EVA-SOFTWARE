import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  enqueueProductVariant,
  enqueueProductionProduced,
  enqueueQrMaster,
  productVariantDedupeKey,
  productionProducedDedupeKey,
} from "@erp/data";
import type { ProductVariantPayload, ProductionProducedPayload } from "@erp/data";
import { applyEnvelope } from "./applyEnvelope.js";
import { qrMasterDedupeKey, type SyncEnvelope } from "./contract.js";
import { OutboxDrain } from "./drain.js";
import {
  deadLetters,
  leaseBatch,
  markFailed,
  markSynced,
  outboxCounts,
  outboxSummary,
  requeueDeadLetter,
  type OutboxRetryPolicy,
} from "./outboxQueue.js";
import { HttpSyncTransport, SyncTransportError, type SyncTransport } from "./transport.js";
import { startTestSyncBackend } from "./testOnlyBackend.js";
import type { SyncSqlHandle, SyncStatement } from "./sqlPort.js";

// ONE PRODUCTION SCAN, CARRIED WHOLE, BETWEEN TWO COMPUTERS.
//
// Two throwaway SQLite files per test under the OS temp folder, built from the real
// local-schema.sql and then migration 082, with foreign keys enforced as the application
// enforces them. A real socket between them. The production database is never opened and none of
// its data is used.
//
// The slice is QR registration (QR_MASTER) plus the production scan (PRODUCTION_PRODUCED). What
// it proves:
//
//   * the local scan commits whether or not anything is listening
//   * the identity arrives with the right product and opening state
//   * the scan rebuilds production_events with every snapshot exactly as recorded
//   * a scan whose carton has not arrived yet WAITS, and succeeds once it has
//   * repeats and lost answers never produce a second row
//   * master data this computer was never given is a visible, permanent refusal
//   * no stock counter is carried as a value

const SCHEMA_PATH = path.resolve(import.meta.dirname, "../../data/src/local-schema.sql");
const MIGRATION_082 = path.resolve(
  import.meta.dirname,
  "../../../migrations/sqlite/082_sync_outbox_production_produced.up.sql"
);
const MIGRATION_083 = path.resolve(
  import.meta.dirname,
  "../../../migrations/sqlite/083_sync_outbox_transient_attempts.up.sql"
);
const MIGRATION_086 = path.resolve(
  import.meta.dirname,
  "../../../migrations/sqlite/086_sync_outbox_product_variant.up.sql"
);
const MIGRATION_088 = path.resolve(import.meta.dirname, "../../../migrations/sqlite/088_replicated_at.up.sql");
const MIGRATION_093 = path.resolve(import.meta.dirname, "../../../migrations/sqlite/093_domain_leases.up.sql");

const FAST_RETRY: OutboxRetryPolicy = { maxAttempts: 4, baseBackoffMs: 1_000, maxBackoffMs: 60_000, staleInFlightMs: 60_000 };

const FACTORY_ID = "factory-777";
const VARIANT_ID = "variant-sk9-black-7-10";
/** A product created on one computer that the other has never been given. */
const NEW_VARIANT = "variant-sk46-black-4-6";
const SEEDED_AT = "2026-10-01T04:00:00.000Z";

interface Node {
  readonly name: string;
  readonly sql: SyncSqlHandle;
  readonly raw: DatabaseSync;
  readonly deviceId: string;
  readonly workstationId: string;
}

/** Runs a shipped migration file the way the application's runner does: split on semicolons. */
function runMigration(raw: DatabaseSync, file: string): void {
  for (const statement of fs.readFileSync(file, "utf8").split(";")) {
    const trimmed = statement.trim();
    if (trimmed) raw.exec(trimmed);
  }
}

function createNode(root: string, name: string): Node {
  const raw = new DatabaseSync(path.join(root, `${name}.db`));
  raw.exec("PRAGMA journal_mode = WAL;");
  raw.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
  runMigration(raw, MIGRATION_082);
  runMigration(raw, MIGRATION_083);
  runMigration(raw, MIGRATION_086);
  runMigration(raw, MIGRATION_088);
  runMigration(raw, MIGRATION_093);
  raw.exec("PRAGMA foreign_keys = ON;");

  // The master data a computer is given when it is set up. None of it is synchronised by this
  // slice, and the tests below prove what happens when a piece of it is missing.
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

  return {
    name,
    sql: raw as unknown as SyncSqlHandle,
    raw,
    deviceId: `device-${name}`,
    workstationId: `workstation-${name}`,
  };
}

/** Registers a workstation. Device enrolment has to do this on every computer before events flow. */
function seedWorkstation(node: Node, workstationId: string, suffix: string): void {
  node.raw
    .prepare(
      `INSERT INTO workstations (id, factory_id, workstation_code, device_id, name, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    )
    .run(workstationId, FACTORY_ID, `WS-TEST-${suffix}`, `dev-${suffix}`, `Station ${suffix}`, SEEDED_AT, SEEDED_AT);
}

interface Fixture {
  readonly a: Node;
  readonly b: Node;
  cleanup(): void;
}

function createFixture(prefix: string): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `erp-slice-${prefix}-`));
  const a = createNode(root, "a");
  const b = createNode(root, "b");
  // Each computer knows its own station, and B has been told about A's — the prerequisite this
  // slice depends on and does not provide.
  seedWorkstation(a, a.workstationId, "A");
  seedWorkstation(b, b.workstationId, "B");
  seedWorkstation(b, a.workstationId, "A");
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

function clock(startIso: string) {
  let current = new Date(startIso).getTime();
  return {
    nowIso: () => new Date(current).toISOString(),
    advanceMs: (ms: number) => {
      current += ms;
    },
  };
}

interface ScanInput {
  qrId: string;
  article?: string;
  color?: string;
  size?: string;
  serial: string;
  occurredAt: string;
  variantId?: string;
  workstationId?: string;
  operatorId?: string | null;
}

/**
 * Records one production scan exactly as the application does: the carton identity, the PRODUCED
 * event and both queue entries, in ONE transaction. Mirrors processScanUseCase's order, which is
 * what puts the identity in the queue ahead of the event that references it.
 */
function recordScan(node: Node, input: ScanInput): { eventId: string } {
  const article = input.article ?? "SK9";
  const color = input.color ?? "BLACK";
  const size = input.size ?? "7/10";
  const variantId = input.variantId ?? VARIANT_ID;
  const workstationId = input.workstationId ?? node.workstationId;
  const operatorId = input.operatorId ?? null;
  const eventId = crypto.randomUUID();
  const metadataJson = JSON.stringify({ parserVersion: "v1", actor: "babar", station: "Live Production" });
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
         ) VALUES (?, ?, ?, 'PRODUCED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL, NULL, 0, 'desktop-scanner')`
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
        operatorId,
        node.deviceId,
        article,
        color,
        size,
        input.serial,
        metadataJson,
        input.occurredAt
      );
    node.raw
      .prepare("UPDATE qr_master SET first_event_id = COALESCE(first_event_id, ?), updated_at = ? WHERE qr_id = ?")
      .run(eventId, input.occurredAt, input.qrId);

    const payload: ProductionProducedPayload = {
      eventId,
      qrId: input.qrId,
      productVariantId: variantId,
      occurredAt: input.occurredAt,
      eventDate,
      eventHour,
      factoryId: FACTORY_ID,
      workstationId,
      operatorId,
      deviceId: node.deviceId,
      article,
      color,
      size,
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

const qrIds = (node: Node): string[] =>
  (node.raw.prepare("SELECT qr_id FROM qr_master ORDER BY qr_id").all() as Array<{ qr_id: string }>).map(
    (row) => row.qr_id
  );

const productionRows = (node: Node): Array<Record<string, unknown>> =>
  node.raw.prepare("SELECT * FROM production_events ORDER BY id").all() as Array<Record<string, unknown>>;

const drainTo = (from: Node, host: string, port: number, now: () => string) =>
  new OutboxDrain(from.sql, new HttpSyncTransport({ host, port }), {
    deviceId: from.deviceId,
    retryPolicy: FAST_RETRY,
    now,
  });

// ─── the migration ──────────────────────────────────────────────────────────

test("migration 082 adds the new type on a fresh database and keeps the queued rows", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "erp-slice-migration-"));
  const raw = new DatabaseSync(path.join(root, "m.db"));
  try {
    raw.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
    // A row queued under the old catch-all type, as an existing installation would hold.
    raw
      .prepare(
        `INSERT INTO sync_outbox (id, aggregate_type, aggregate_id, operation, dedupe_key,
           payload_json, status, available_at, created_at, updated_at)
         VALUES ('old-1', 'PRODUCTION_EVENT', 'e-1', 'INSERT', 'PRODUCTION_EVENT:e-1', '{}', 'PENDING', ?, ?, ?)`
      )
      .run(SEEDED_AT, SEEDED_AT, SEEDED_AT);

    // Before: the new type is refused.
    assert.throws(() =>
      raw
        .prepare(
          `INSERT INTO sync_outbox (id, aggregate_type, aggregate_id, operation, dedupe_key,
             payload_json, status, available_at, created_at, updated_at)
           VALUES ('new-0', 'PRODUCTION_PRODUCED', 'e-0', 'INSERT', 'k0', '{}', 'PENDING', ?, ?, ?)`
        )
        .run(SEEDED_AT, SEEDED_AT, SEEDED_AT)
    );

    runMigration(raw, MIGRATION_082);

    // After: accepted, the old row is still there, and the index came back.
    raw
      .prepare(
        `INSERT INTO sync_outbox (id, aggregate_type, aggregate_id, operation, dedupe_key,
           payload_json, status, available_at, created_at, updated_at)
         VALUES ('new-1', 'PRODUCTION_PRODUCED', 'e-2', 'INSERT', 'k1', '{}', 'PENDING', ?, ?, ?)`
      )
      .run(SEEDED_AT, SEEDED_AT, SEEDED_AT);

    // node:sqlite hands back null-prototype rows, so compare plain copies.
    const rows = (
      raw.prepare("SELECT id, aggregate_type FROM sync_outbox ORDER BY rowid").all() as Array<{
        id: string;
        aggregate_type: string;
      }>
    ).map((row) => ({ id: row.id, aggregate_type: row.aggregate_type }));
    assert.deepEqual(rows, [
      { id: "old-1", aggregate_type: "PRODUCTION_EVENT" },
      { id: "new-1", aggregate_type: "PRODUCTION_PRODUCED" },
    ]);
    const index = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_sync_outbox_status_available_at'")
      .get();
    assert.ok(index, "the index is recreated after the rebuild");
    // An invented type is still refused.
    assert.throws(() =>
      raw
        .prepare(
          `INSERT INTO sync_outbox (id, aggregate_type, aggregate_id, operation, dedupe_key,
             payload_json, status, available_at, created_at, updated_at)
           VALUES ('bad', 'MADE_UP', 'e-3', 'INSERT', 'k2', '{}', 'PENDING', ?, ?, ?)`
        )
        .run(SEEDED_AT, SEEDED_AT, SEEDED_AT)
    );
  } finally {
    raw.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("migration 086 teaches the outbox the variant, and carries 083's column with it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "erp-slice-migration-086-"));
  const raw = new DatabaseSync(path.join(root, "m.db"));
  try {
    raw.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
    runMigration(raw, MIGRATION_082);
    runMigration(raw, MIGRATION_083);

    // A row part-way through its retries, as an installation that has been offline would hold.
    raw
      .prepare(
        `INSERT INTO sync_outbox (id, aggregate_type, aggregate_id, operation, dedupe_key,
           payload_json, status, available_at, attempts, transient_attempts, last_error,
           created_at, updated_at)
         VALUES ('queued-1', 'PRODUCTION_PRODUCED', 'e-1', 'INSERT', 'PRODUCTION_PRODUCED:e-1',
           '{}', 'FAILED', ?, 2, 7, 'service refused', ?, ?)`
      )
      .run(SEEDED_AT, SEEDED_AT, SEEDED_AT);

    const insertVariant = () =>
      raw
        .prepare(
          `INSERT INTO sync_outbox (id, aggregate_type, aggregate_id, operation, dedupe_key,
             payload_json, status, available_at, created_at, updated_at)
           VALUES ('v-1', 'PRODUCT_VARIANT', 'variant-x', 'INSERT', 'PRODUCT_VARIANT:variant-x',
             '{}', 'PENDING', ?, ?, ?)`
        )
        .run(SEEDED_AT, SEEDED_AT, SEEDED_AT);

    // Before: the type does not exist, so a variant cannot be queued at all.
    assert.throws(insertVariant);

    runMigration(raw, MIGRATION_086);

    insertVariant();

    // THE REBUILD CARRIED transient_attempts, which 083 added after 082 last rebuilt this table.
    // A rebuild copied from 082 alone would have dropped it silently, and with it the separation
    // between "the service refused this" and "this could not be delivered" -- which is what
    // stops an hour offline parking every queued carton.
    const kept = raw
      .prepare("SELECT status, attempts, transient_attempts, last_error FROM sync_outbox WHERE id = 'queued-1'")
      .get() as { status: string; attempts: number; transient_attempts: number; last_error: string };
    assert.deepEqual(
      { status: kept.status, attempts: kept.attempts, transient: kept.transient_attempts, last: kept.last_error },
      { status: "FAILED", attempts: 2, transient: 7, last: "service refused" },
      "a row part-way through its retries keeps its place exactly"
    );

    const index = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_sync_outbox_status_available_at'")
      .get();
    assert.ok(index, "the index is recreated after the rebuild");

    // And an invented type is still refused: the CHECK was widened, not removed.
    assert.throws(() =>
      raw
        .prepare(
          `INSERT INTO sync_outbox (id, aggregate_type, aggregate_id, operation, dedupe_key,
             payload_json, status, available_at, created_at, updated_at)
           VALUES ('bad', 'MADE_UP', 'x', 'INSERT', 'k9', '{}', 'PENDING', ?, ?, ?)`
        )
        .run(SEEDED_AT, SEEDED_AT, SEEDED_AT)
    );
  } finally {
    raw.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── local-first ────────────────────────────────────────────────────────────

test("a production scan commits locally with nothing listening, and both events wait", async () => {
  const fixture = createFixture("offline");
  try {
    const time = clock("2026-10-01T09:00:00.000Z");
    const { eventId } = recordScan(fixture.a, { qrId: "SK9_BLACK_7/10_000001", serial: "000001", occurredAt: time.nowIso() });

    assert.deepEqual(qrIds(fixture.a), ["SK9_BLACK_7/10_000001"]);
    assert.equal(productionRows(fixture.a).length, 1);
    assert.equal(productionRows(fixture.a)[0]?.id, eventId);
    assert.equal(outboxCounts(fixture.a.sql).PENDING, 2, "the identity and the scan are both queued");

    // Nothing is listening on this port.
    const result = await drainTo(fixture.a, "127.0.0.1", 1, time.nowIso).runOnce();
    assert.ok(result.transportError);
    assert.equal(result.counts.FAILED, 2, "both are waiting, neither is lost");
    assert.equal(productionRows(fixture.a).length, 1, "and the scan is still recorded locally");
  } finally {
    fixture.cleanup();
  }
});

// ─── the slice, end to end ──────────────────────────────────────────────────

test("the carton identity and the scan both arrive, and the row is rebuilt exactly", async () => {
  const fixture = createFixture("rebuild");
  const backend = await startTestSyncBackend(fixture.b.sql);
  try {
    const time = clock("2026-10-01T09:15:00.000Z");
    const { eventId } = recordScan(fixture.a, {
      qrId: "SK9_BLACK_7/10_000001",
      serial: "000001",
      occurredAt: time.nowIso(),
    });

    const result = await drainTo(fixture.a, backend.host, backend.port, time.nowIso).runOnce();
    assert.equal(result.leased, 2);
    assert.equal(result.synced, 2);

    // The identity, with the opening state the receiver writes itself.
    const identity = fixture.b.raw.prepare("SELECT * FROM qr_master WHERE qr_id = ?").get("SK9_BLACK_7/10_000001") as
      | Record<string, unknown>
      | undefined;
    assert.equal(identity?.product_variant_id, VARIANT_ID);
    assert.equal(identity?.current_status, "PRODUCED");
    assert.equal(identity?.current_location_type, "FACTORY");
    assert.equal(identity?.first_event_id, eventId, "and the scan is recorded as its first event");

    // The scan, column for column against what A recorded.
    const sent = productionRows(fixture.a)[0];
    const received = productionRows(fixture.b)[0];
    assert.ok(received, "the production event arrived");
    for (const column of [
      "id",
      "qr_id",
      "product_variant_id",
      "event_type",
      "event_ts_local",
      "event_date",
      "event_hour",
      "factory_id",
      "workstation_id",
      "operator_id",
      "device_id",
      "article_snapshot",
      "color_snapshot",
      "size_snapshot",
      "serial_snapshot",
      "metadata_json",
      "created_at",
      "source_app",
    ]) {
      assert.deepEqual(received?.[column], sent?.[column], `${column} must be preserved`);
    }
    assert.equal(received?.event_type, "PRODUCED", "and it says what it is");
    // Not copied: the receiver did not originate this row, so it has nothing to send on.
    assert.equal(received?.sync_status, "SYNCED");
    assert.equal(received?.retry_count, 0);
  } finally {
    await backend.close();
    fixture.cleanup();
  }
});

test("two computers converge on each other's production", async () => {
  const fixture = createFixture("converge");
  const backendOnB = await startTestSyncBackend(fixture.b.sql);
  const backendOnA = await startTestSyncBackend(fixture.a.sql);
  try {
    // A knows about B's station too, so both directions have their prerequisites.
    seedWorkstation(fixture.a, fixture.b.workstationId, "B");
    const time = clock("2026-10-01T09:30:00.000Z");
    recordScan(fixture.a, { qrId: "SK9_BLACK_7/10_000001", serial: "000001", occurredAt: time.nowIso() });
    recordScan(fixture.b, { qrId: "SK9_BLACK_7/10_100001", serial: "100001", occurredAt: time.nowIso() });

    await drainTo(fixture.a, backendOnB.host, backendOnB.port, time.nowIso).runOnce();
    await drainTo(fixture.b, backendOnA.host, backendOnA.port, time.nowIso).runOnce();

    const expected = ["SK9_BLACK_7/10_000001", "SK9_BLACK_7/10_100001"];
    assert.deepEqual(qrIds(fixture.a), expected);
    assert.deepEqual(qrIds(fixture.b), expected);
    assert.equal(productionRows(fixture.a).length, 2);
    assert.equal(productionRows(fixture.b).length, 2);
  } finally {
    await backendOnA.close();
    await backendOnB.close();
    fixture.cleanup();
  }
});

// ─── prerequisites ──────────────────────────────────────────────────────────

test("a scan whose carton has not arrived waits, then succeeds once it has", async () => {
  const fixture = createFixture("prerequisite");
  const backend = await startTestSyncBackend(fixture.b.sql);
  try {
    const time = clock("2026-10-01T09:45:00.000Z");
    const { eventId } = recordScan(fixture.a, {
      qrId: "SK9_BLACK_7/10_000001",
      serial: "000001",
      occurredAt: time.nowIso(),
    });

    // Deliver ONLY the production event — the identity is still on its way.
    const scanOnly = fixture.a.raw
      .prepare("SELECT payload_json FROM sync_outbox WHERE aggregate_type = 'PRODUCTION_PRODUCED'")
      .get() as { payload_json: string };
    const envelope: SyncEnvelope = {
      dedupeKey: productionProducedDedupeKey(eventId),
      aggregateType: "PRODUCTION_PRODUCED",
      aggregateId: eventId,
      operation: "INSERT",
      payload: JSON.parse(scanOnly.payload_json) as Record<string, unknown>,
      originDeviceId: fixture.a.deviceId,
      createdAt: time.nowIso(),
    };

    const early = applyEnvelope(fixture.b.sql, envelope);
    assert.equal(early.status, "REJECTED");
    assert.equal(early.permanent, false, "waiting for a prerequisite is not a permanent failure");
    assert.match(early.reason ?? "", /QR_NOT_REGISTERED_YET/);
    assert.equal(productionRows(fixture.b).length, 0, "and nothing was written");

    // Now the whole queue goes, identity first because it was queued first.
    const result = await drainTo(fixture.a, backend.host, backend.port, time.nowIso).runOnce();
    assert.equal(result.synced, 2);
    assert.deepEqual(qrIds(fixture.b), ["SK9_BLACK_7/10_000001"]);
    assert.equal(productionRows(fixture.b).length, 1);
    assert.equal(productionRows(fixture.b)[0]?.id, eventId);
  } finally {
    await backend.close();
    fixture.cleanup();
  }
});

test("a scan naming a station the receiver lacks waits for it, and goes once it is enrolled", async () => {
  const fixture = createFixture("unknown-station");
  const backend = await startTestSyncBackend(fixture.b.sql);
  try {
    const time = clock("2026-10-01T10:00:00.000Z");
    seedWorkstation(fixture.a, "workstation-never-shared", "X");
    recordScan(fixture.a, {
      qrId: "SK9_BLACK_7/10_000001",
      serial: "000001",
      occurredAt: time.nowIso(),
      workstationId: "workstation-never-shared",
    });

    const drain = drainTo(fixture.a, backend.host, backend.port, time.nowIso);
    const result = await drain.runOnce();

    assert.equal(result.synced, 1, "the identity still arrives");
    // A station that has not been enrolled yet is a prerequisite, not a verdict on the scan.
    // Parking it meant enrolling the station afterwards healed nothing.
    assert.equal(result.deadLettered, 0, "a missing prerequisite must never park a real scan");
    assert.deepEqual(deadLetters(fixture.a.sql), []);
    assert.deepEqual(qrIds(fixture.b), ["SK9_BLACK_7/10_000001"]);
    assert.equal(productionRows(fixture.b).length, 0, "the scan is waiting");

    // Offered many more times than the refusal limit, and still not parked.
    for (let pass = 0; pass < FAST_RETRY.maxAttempts * 3; pass += 1) {
      time.advanceMs(FAST_RETRY.maxBackoffMs);
      await drain.runOnce();
    }
    assert.equal(outboxCounts(fixture.a.sql).DEAD_LETTER, 0);

    // The owner enrols the station on the receiving computer. The waiting scan applies itself.
    seedWorkstation(fixture.b, "workstation-never-shared", "X");
    time.advanceMs(FAST_RETRY.maxBackoffMs);
    await drain.runOnce();

    assert.equal(productionRows(fixture.b).length, 1, "it heals once the station exists");
    assert.equal(outboxCounts(fixture.a.sql).SYNCED, 2);
  } finally {
    await backend.close();
    fixture.cleanup();
  }
});

test("a transport that carries only cartons leaves the scan waiting, not refused or parked", async () => {
  const fixture = createFixture("partial-transport");
  const backend = await startTestSyncBackend(fixture.b.sql);
  try {
    const time = clock("2026-10-01T10:50:00.000Z");
    recordScan(fixture.a, { qrId: "SK9_BLACK_7/10_000001", serial: "000001", occurredAt: time.nowIso() });

    // The Supabase slice can send QR_MASTER and not yet PRODUCTION_PRODUCED. The drain is told
    // so, and must therefore not claim the scan at all: offering it would walk it up the attempt
    // limit and into the dead-letter queue, which to an operator looks exactly like losing it.
    const drain = new OutboxDrain(
      fixture.a.sql,
      new HttpSyncTransport({ host: backend.host, port: backend.port }),
      { deviceId: fixture.a.deviceId, retryPolicy: FAST_RETRY, now: time.nowIso, aggregateTypes: ["QR_MASTER"] }
    );
    const result = await drain.runOnce();

    assert.equal(result.leased, 1, "only the carton identity was claimed");
    assert.equal(result.synced, 1);
    assert.deepEqual(result.counts, { PENDING: 1, IN_FLIGHT: 0, FAILED: 0, DEAD_LETTER: 0, SYNCED: 1 });

    const waiting = fixture.a.raw
      .prepare("SELECT aggregate_type, status, attempts FROM sync_outbox WHERE status = 'PENDING'")
      .get() as { aggregate_type: string; status: string; attempts: number };
    assert.equal(waiting.aggregate_type, "PRODUCTION_PRODUCED");
    assert.equal(waiting.attempts, 0, "it was never even attempted");

    // The carton arrived; the scan did not, and that is the honest state of this slice.
    assert.deepEqual(qrIds(fixture.b), ["SK9_BLACK_7/10_000001"]);
    assert.equal(productionRows(fixture.b).length, 0);

    // Running again changes nothing: it is still not claimed.
    time.advanceMs(FAST_RETRY.baseBackoffMs * 10);
    assert.equal((await drain.runOnce()).leased, 0);
    assert.equal(outboxCounts(fixture.a.sql).DEAD_LETTER, 0, "nothing was ever parked");
  } finally {
    await backend.close();
    fixture.cleanup();
  }
});

// ─── exactly once ───────────────────────────────────────────────────────────

test("the same scan delivered three times leaves one carton and one production row", () => {
  const fixture = createFixture("duplicate");
  try {
    const { eventId } = recordScan(fixture.a, {
      qrId: "SK9_BLACK_7/10_000001",
      serial: "000001",
      occurredAt: "2026-10-01T10:15:00.000Z",
    });
    const rows = fixture.a.raw
      .prepare("SELECT aggregate_type, aggregate_id, dedupe_key, payload_json FROM sync_outbox ORDER BY rowid")
      .all() as Array<{ aggregate_type: string; aggregate_id: string; dedupe_key: string; payload_json: string }>;

    const envelopes: SyncEnvelope[] = rows.map((row) => ({
      dedupeKey: row.dedupe_key,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      operation: "INSERT",
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      originDeviceId: fixture.a.deviceId,
      createdAt: "2026-10-01T10:15:00.000Z",
    }));

    const first = envelopes.map((envelope) => applyEnvelope(fixture.b.sql, envelope));
    assert.deepEqual(first.map((outcome) => outcome.status), ["APPLIED", "APPLIED"]);

    for (let round = 0; round < 2; round += 1) {
      const again = envelopes.map((envelope) => applyEnvelope(fixture.b.sql, envelope));
      assert.deepEqual(again.map((outcome) => outcome.status), ["DUPLICATE", "DUPLICATE"]);
    }

    assert.deepEqual(qrIds(fixture.b), ["SK9_BLACK_7/10_000001"]);
    assert.equal(productionRows(fixture.b).length, 1);
    assert.equal(productionRows(fixture.b)[0]?.id, eventId);
    assert.deepEqual(envelopes.map((e) => e.dedupeKey), [
      qrMasterDedupeKey("SK9_BLACK_7/10_000001"),
      productionProducedDedupeKey(eventId),
    ]);
  } finally {
    fixture.cleanup();
  }
});

test("a batch applied by the receiver whose answer is lost is re-sent without duplicating anything", async () => {
  const fixture = createFixture("lost-ack");
  const backend = await startTestSyncBackend(fixture.b.sql);
  try {
    const time = clock("2026-10-01T10:30:00.000Z");
    recordScan(fixture.a, { qrId: "SK9_BLACK_7/10_000001", serial: "000001", occurredAt: time.nowIso() });
    const drain = drainTo(fixture.a, backend.host, backend.port, time.nowIso);

    backend.setFault("APPLY_THEN_DROP");
    const interrupted = await drain.runOnce();
    assert.equal(interrupted.synced, 0);
    assert.ok(interrupted.transportError);
    assert.equal(productionRows(fixture.b).length, 1, "it did arrive, the sender just never heard");

    backend.setFault("NONE");
    time.advanceMs(FAST_RETRY.baseBackoffMs + 1);
    const retried = await drain.runOnce();
    assert.equal(retried.leased, 2);
    assert.equal(retried.synced, 2, "both are recognised as duplicates and the sender can finish");
    assert.deepEqual(qrIds(fixture.b), ["SK9_BLACK_7/10_000001"]);
    assert.equal(productionRows(fixture.b).length, 1, "still one production row");
    assert.equal(outboxCounts(fixture.a.sql).SYNCED, 2);
  } finally {
    await backend.close();
    fixture.cleanup();
  }
});

test("a run interrupted after claiming the batch gives both events back and delivers once", async () => {
  const fixture = createFixture("restart");
  const backend = await startTestSyncBackend(fixture.b.sql);
  try {
    const time = clock("2026-10-01T10:45:00.000Z");
    recordScan(fixture.a, { qrId: "SK9_BLACK_7/10_000001", serial: "000001", occurredAt: time.nowIso() });

    // The state a process killed mid-send leaves behind.
    fixture.a.raw
      .prepare("UPDATE sync_outbox SET status = 'IN_FLIGHT', lock_token = 'lost-run', updated_at = ?")
      .run(time.nowIso());
    assert.equal(outboxCounts(fixture.a.sql).IN_FLIGHT, 2);

    time.advanceMs(FAST_RETRY.staleInFlightMs + 1);
    const result = await drainTo(fixture.a, backend.host, backend.port, time.nowIso).runOnce();
    assert.equal(result.reclaimed, 2);
    assert.equal(result.synced, 2);
    assert.deepEqual(qrIds(fixture.b), ["SK9_BLACK_7/10_000001"]);
    assert.equal(productionRows(fixture.b).length, 1);
  } finally {
    await backend.close();
    fixture.cleanup();
  }
});

// ─── what must not travel ───────────────────────────────────────────────────

test("no stock counter is carried as a value, and the receiver's stock is left alone", async () => {
  const fixture = createFixture("no-stock");
  const backend = await startTestSyncBackend(fixture.b.sql);
  try {
    const time = clock("2026-10-01T11:00:00.000Z");
    recordScan(fixture.a, { qrId: "SK9_BLACK_7/10_000001", serial: "000001", occurredAt: time.nowIso() });

    const payloads = (
      fixture.a.raw.prepare("SELECT payload_json FROM sync_outbox ORDER BY rowid").all() as Array<{
        payload_json: string;
      }>
    ).map((row) => JSON.parse(row.payload_json) as Record<string, unknown>);

    assert.deepEqual(Object.keys(payloads[0] ?? {}).sort(), ["createdAt", "productVariantId", "qrId"]);
    assert.deepEqual(Object.keys(payloads[1] ?? {}).sort(), [
      "article",
      "color",
      "createdAt",
      "deviceId",
      "eventDate",
      "eventHour",
      "eventId",
      "factoryId",
      "metadataJson",
      "occurredAt",
      "operatorId",
      "productVariantId",
      "qrId",
      "serial",
      "size",
      "sourceApp",
      "workstationId",
    ]);
    // Pinned deliberately: a quantity added to either payload would start being merged by
    // last-write-wins, which is how one computer's count silently destroys another's.
    for (const payload of payloads) {
      for (const forbidden of ["quantityOnHand", "quantity", "quantityReserved", "quantityDamaged", "currentStatus"]) {
        assert.equal(forbidden in payload, false, `${forbidden} must never travel`);
      }
    }

    await drainTo(fixture.a, backend.host, backend.port, time.nowIso).runOnce();
    const projection = fixture.b.raw.prepare("SELECT COUNT(*) AS n FROM stock_projection_by_variant").get() as {
      n: number;
    };
    assert.equal(
      Number(projection.n),
      0,
      "the receiver's stock projection is untouched: only production syncs, so counting arrivals would make it wrong"
    );
  } finally {
    await backend.close();
    fixture.cleanup();
  }
});

// A REPLICA MUST NOT RECOMPUTE. An arriving event carries the hour the computer that made it
// stored, and this computer writes that value verbatim -- it does not derive its own from
// occurredAt. Two reasons. The log is append-only, so the receiver's copy has to be the
// sender's row, not a re-derivation of it; and during a rollout an older computer still
// sends host-local hours, which must arrive as the (wrong) value it actually recorded rather
// than being silently corrected on one machine and not another.
//
// The numbers below are the real ones from the two-computer pilot: 19:00:13Z is midnight in
// Karachi (hour 0), and the sending machine -- on UTC-7 -- stored 12.
test("an applied event keeps the sender's event_hour, and never recomputes it", () => {
  const fixture = createFixture("hour-verbatim");
  try {
    const occurredAt = "2026-10-19T19:00:13.479Z";
    const senderHour = 12; // what a UTC-7 host recorded: not the business hour
    const payload = {
      eventId: "e-hour-1",
      qrId: "SK9_BLACK_7/10_000042",
      productVariantId: VARIANT_ID,
      occurredAt,
      eventDate: "2026-10-19",
      eventHour: senderHour,
      factoryId: FACTORY_ID,
      workstationId: fixture.b.workstationId,
      operatorId: null,
      deviceId: "device-a",
      article: "SK9",
      color: "BLACK",
      size: "7/10",
      serial: "000042",
      metadataJson: "{}",
      createdAt: occurredAt,
      sourceApp: "desktop-scanner",
    };

    // The carton has to be here first, exactly as the real ordering guarantees.
    fixture.b.raw
      .prepare(
        `INSERT INTO qr_master (qr_id, product_variant_id, current_status, current_location_type,
           current_location_id, first_event_id, created_at, updated_at)
         VALUES (?, ?, 'PRODUCED', 'FACTORY', NULL, NULL, ?, ?)`
      )
      .run(payload.qrId, VARIANT_ID, occurredAt, occurredAt);

    const outcome = applyEnvelope(fixture.b.sql, {
      dedupeKey: productionProducedDedupeKey("e-hour-1"),
      aggregateType: "PRODUCTION_PRODUCED",
      aggregateId: "e-hour-1",
      operation: "INSERT",
      payload,
      originDeviceId: "device-a",
      createdAt: occurredAt,
    });
    assert.equal(outcome.status, "APPLIED");

    const row = fixture.b.raw
      .prepare("SELECT event_hour, event_date, event_ts_local FROM production_events WHERE id = ?")
      .get("e-hour-1") as { event_hour: number; event_date: string; event_ts_local: string };
    assert.equal(row.event_hour, senderHour, "the sender's hour is kept, not recalculated");
    assert.notEqual(row.event_hour, 0, "recomputing in the business zone here would give 0");
    assert.equal(row.event_date, "2026-10-19", "event_date is replicated verbatim too");
    assert.equal(row.event_ts_local, occurredAt, "the absolute instant is what stays authoritative");
  } finally {
    fixture.cleanup();
  }
});

test("a variant arrives before the carton of it, and the receiver can then take both", () => {
  const fixture = createFixture("variant-apply");
  try {
    const receiver = fixture.b;
    const payload: ProductVariantPayload = {
      variantId: NEW_VARIANT,
      article: "SK46",
      color: "BLACK",
      size: "4/6",
      description: "SK46 BLACK 4/6",
      createdAt: "2026-10-22T12:26:22.000Z",
    };
    const cartonEnvelope: SyncEnvelope = {
      dedupeKey: qrMasterDedupeKey("SK46_BLACK_4/6_000001"),
      aggregateType: "QR_MASTER",
      aggregateId: "SK46_BLACK_4/6_000001",
      operation: "INSERT",
      payload: {
        qrId: "SK46_BLACK_4/6_000001",
        productVariantId: NEW_VARIANT,
        createdAt: "2026-10-22T12:26:32.000Z",
      },
      originDeviceId: fixture.a.deviceId,
      createdAt: "2026-10-22T12:26:32.000Z",
    };

    // Before: a carton of this product cannot be applied, because the product is not here. This
    // is the receiving half of the 2026-10-22 refusal.
    const early = applyEnvelope(receiver.sql, cartonEnvelope);
    assert.equal(early.status, "REJECTED", "an unknown product is refused, never an invented row");
    assert.equal(early.permanent, false, "and refused retryably, so the variant can still rescue it");
    assert.match(early.reason ?? "", /UNKNOWN_PRODUCT_VARIANT/);

    const applied = applyEnvelope(receiver.sql, {
      dedupeKey: productVariantDedupeKey(NEW_VARIANT),
      aggregateType: "PRODUCT_VARIANT",
      aggregateId: NEW_VARIANT,
      operation: "INSERT",
      payload: { ...payload },
      originDeviceId: fixture.a.deviceId,
      createdAt: payload.createdAt,
    });
    assert.equal(applied.status, "APPLIED");

    const row = receiver.raw
      .prepare(
        `SELECT article, color, size, description, status, created_at, cost_price, selling_price
         FROM product_variants WHERE id = ?`
      )
      .get(NEW_VARIANT) as {
      article: string;
      color: string;
      size: string;
      description: string;
      status: string;
      created_at: string;
      cost_price: number | null;
      selling_price: number | null;
    };
    assert.deepEqual(
      {
        article: row.article,
        color: row.color,
        size: row.size,
        description: row.description,
        status: row.status,
        createdAt: row.created_at,
      },
      {
        article: "SK46",
        color: "BLACK",
        size: "4/6",
        description: "SK46 BLACK 4/6",
        // The receiver writes the opening status itself. Nothing about it travelled.
        status: "ACTIVE",
        createdAt: "2026-10-22T12:26:22.000Z",
      }
    );

    // NO PRICE REACHED THIS COMPUTER. The price columns exist locally and must still be unset:
    // pricing is set where the product is sold, and a sync must never quietly carry it across.
    // (In a migrated database these are the paisa columns migration 029 adds. Either way the
    // payload has no field for a price, so there is nothing here to write.)
    assert.deepEqual(
      { cost: row.cost_price, selling: row.selling_price },
      { cost: null, selling: null },
      "a variant push carries identity only"
    );

    // And now the carton goes.
    assert.equal(applyEnvelope(receiver.sql, cartonEnvelope).status, "APPLIED");
  } finally {
    fixture.cleanup();
  }
});

test("the same variant delivered twice leaves one row, and never edits the one already here", () => {
  const fixture = createFixture("variant-twice");
  try {
    const receiver = fixture.b;

    // VARIANT_ID is seeded on every computer, so this is the ordinary case: the product is
    // already here. INSERT-ONLY means the arriving copy must not overwrite it. An article is
    // part of a product identity, and a sync that could rewrite it could rewrite history.
    const outcome = applyEnvelope(receiver.sql, {
      dedupeKey: productVariantDedupeKey(VARIANT_ID),
      aggregateType: "PRODUCT_VARIANT",
      aggregateId: VARIANT_ID,
      operation: "INSERT",
      payload: {
        variantId: VARIANT_ID,
        article: "WRONG",
        color: "BLACK",
        size: "7/10",
        description: "renamed by the sender",
        createdAt: "2026-10-22T12:26:22.000Z",
      },
      originDeviceId: fixture.a.deviceId,
      createdAt: "2026-10-22T12:26:22.000Z",
    });
    // DUPLICATE, not APPLIED: it is here, which is what the sender needed to know, and nothing
    // was written. Either way the row leaves the queue instead of retrying for ever.
    assert.equal(outcome.status, "DUPLICATE");

    const rows = receiver.raw
      .prepare("SELECT article, description FROM product_variants WHERE id = ?")
      .all(VARIANT_ID) as Array<{ article: string; description: string | null }>;
    assert.equal(rows.length, 1, "one product, one row");
    assert.equal(rows[0]?.article, "SK9", "the local row is left exactly as it was");
  } finally {
    fixture.cleanup();
  }
});

test("the event types without a contract are still refused, and a broken payload is never patched up", () => {
  const fixture = createFixture("refusals");
  try {
    const base: SyncEnvelope = {
      dedupeKey: "PRODUCTION_EVENT:event-1",
      aggregateType: "PRODUCTION_EVENT",
      aggregateId: "event-1",
      operation: "INSERT",
      payload: { eventId: "event-1", qrId: "SK9_BLACK_7/10_000001", createdAt: "2026-10-01T11:15:00.000Z" },
      originDeviceId: "device-a",
      createdAt: "2026-10-01T11:15:00.000Z",
    };

    for (const aggregateType of ["PRODUCTION_EVENT", "DISPATCH_EVENT", "RETURN_EVENT", "PROJECTION"]) {
      const outcome = applyEnvelope(fixture.b.sql, { ...base, aggregateType });
      assert.equal(outcome.status, "REJECTED", `${aggregateType} must be refused`);
      assert.equal(outcome.permanent, true, `${aggregateType} must not be retried`);
      assert.match(outcome.reason ?? "", /UNSUPPORTED_AGGREGATE_TYPE/);
    }

    // A PRODUCED event missing a snapshot is refused rather than completed with a default.
    const complete = {
      eventId: "e-9",
      qrId: "SK9_BLACK_7/10_000009",
      productVariantId: VARIANT_ID,
      occurredAt: "2026-10-01T11:15:00.000Z",
      eventDate: "2026-10-01",
      eventHour: 11,
      factoryId: FACTORY_ID,
      workstationId: fixture.b.workstationId,
      operatorId: null,
      deviceId: "device-a",
      article: "SK9",
      color: "BLACK",
      size: "7/10",
      serial: "000009",
      metadataJson: "{}",
      createdAt: "2026-10-01T11:15:00.000Z",
      sourceApp: "desktop-scanner",
    };
    for (const missing of ["article", "serial", "eventDate", "productVariantId", "sourceApp"]) {
      const payload: Record<string, unknown> = { ...complete };
      delete payload[missing];
      const outcome = applyEnvelope(fixture.b.sql, {
        ...base,
        aggregateType: "PRODUCTION_PRODUCED",
        aggregateId: "e-9",
        dedupeKey: productionProducedDedupeKey("e-9"),
        payload,
      });
      assert.equal(outcome.status, "REJECTED", `a payload without ${missing} must be refused`);
      assert.equal(outcome.reason, "PAYLOAD_INCOMPLETE");
    }

    // An hour that is not an hour is refused too.
    const badHour = applyEnvelope(fixture.b.sql, {
      ...base,
      aggregateType: "PRODUCTION_PRODUCED",
      aggregateId: "e-9",
      dedupeKey: productionProducedDedupeKey("e-9"),
      payload: { ...complete, eventHour: 25 },
    });
    assert.equal(badHour.reason, "PAYLOAD_INCOMPLETE");

    assert.equal(productionRows(fixture.b).length, 0);
    assert.deepEqual(qrIds(fixture.b), []);
  } finally {
    fixture.cleanup();
  }
});

// ─── an apply that is interrupted half way ──────────────────────────────────
//
// A production scan arrives as one row in production_events plus one pointer on qr_master. Two
// statements, one arrival. What these prove is that a stop between them cannot leave the pair
// half written: either both are there or neither is, and the retry that at-least-once delivery
// guarantees finishes the job.

/**
 * The real handle, until the statement matching `failOn` is prepared — then it throws, standing
 * in for a process that stops mid-apply. Everything else, including BEGIN and ROLLBACK, goes
 * straight through to the database, so the rollback being tested is a real one.
 */
function handleThatFailsOn(node: Node, failOn: RegExp): SyncSqlHandle {
  const interrupted = (): never => {
    throw new Error("INTERRUPTED");
  };
  return {
    prepare: (sql: string): SyncStatement =>
      failOn.test(sql)
        ? { all: interrupted, get: interrupted, run: interrupted }
        : (node.raw.prepare(sql) as unknown as SyncStatement),
    exec: (sql: string): void => {
      node.raw.exec(sql);
    },
  };
}

/** When a row was made at its origin, and when it arrived here (null: recorded here). */
const stampsOf = (
  node: Node,
  select: string,
  id: string
): { created_at: string; replicated_at: string | null } | undefined => {
  const row = node.raw.prepare(select).get(id) as { created_at: string; replicated_at: string | null } | undefined;
  // node:sqlite rows have a null prototype, which strict deepEqual counts as a difference.
  return row === undefined ? undefined : { created_at: row.created_at, replicated_at: row.replicated_at };
};

const CARTON_STAMPS = "SELECT created_at, replicated_at FROM qr_master WHERE qr_id = ?";
const EVENT_STAMPS = "SELECT created_at, replicated_at FROM production_events WHERE id = ?";

test("an arrival keeps the origin's created_at, and records its own arrival time once", () => {
  const fixture = createFixture("replicated-at");
  try {
    const at = "2026-10-01T11:30:00.000Z";
    const qrId = "SK9_BLACK_7/10_000002";
    const { eventId } = recordScan(fixture.a, { qrId, serial: "000002", occurredAt: at });
    const [identity, scan] = envelopesFor(fixture.a, at);
    assert.ok(identity !== undefined && scan !== undefined);

    const arrived = "2026-10-02T09:00:00.000Z";
    assert.equal(applyEnvelope(fixture.b.sql, identity, arrived).status, "APPLIED");
    assert.equal(applyEnvelope(fixture.b.sql, scan, arrived).status, "APPLIED");

    // The origin recorded it, so on the origin there is no arrival time.
    const originCarton = stampsOf(fixture.a, CARTON_STAMPS, qrId);
    const originEvent = stampsOf(fixture.a, EVENT_STAMPS, eventId);
    assert.equal(originCarton?.replicated_at, null);
    assert.equal(originEvent?.replicated_at, null);

    // The receiver keeps the origin's business time, and the arrival time beside it.
    assert.deepEqual(stampsOf(fixture.b, CARTON_STAMPS, qrId), {
      created_at: originCarton?.created_at,
      replicated_at: arrived,
    });
    assert.deepEqual(stampsOf(fixture.b, EVENT_STAMPS, eventId), {
      created_at: originEvent?.created_at,
      replicated_at: arrived,
    });

    // A second arrival is a no-op, and does not move the first arrival's time.
    const later = "2026-10-03T09:00:00.000Z";
    assert.equal(applyEnvelope(fixture.b.sql, scan, later).status, "DUPLICATE");
    assert.equal(stampsOf(fixture.b, EVENT_STAMPS, eventId)?.replicated_at, arrived);
  } finally {
    fixture.cleanup();
  }
});

const firstEventIdOf = (node: Node, qrId: string): string | null => {
  const row = node.raw.prepare("SELECT first_event_id FROM qr_master WHERE qr_id = ?").get(qrId) as
    | { first_event_id: string | null }
    | undefined;
  return row?.first_event_id ?? null;
};

/** The carton identity and the scan, as the outbox queued them. */
function envelopesFor(node: Node, createdAt: string): SyncEnvelope[] {
  const rows = node.raw
    .prepare("SELECT aggregate_type, aggregate_id, dedupe_key, payload_json FROM sync_outbox ORDER BY rowid")
    .all() as Array<{ aggregate_type: string; aggregate_id: string; dedupe_key: string; payload_json: string }>;
  return rows.map((row) => ({
    dedupeKey: row.dedupe_key,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    operation: "INSERT",
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    originDeviceId: node.deviceId,
    createdAt,
  }));
}

test("an apply stopped between the row and its pointer leaves neither, and the retry writes both", () => {
  const fixture = createFixture("half-apply");
  try {
    const at = "2026-10-01T11:30:00.000Z";
    const qrId = "SK9_BLACK_7/10_000001";
    const { eventId } = recordScan(fixture.a, { qrId, serial: "000001", occurredAt: at });
    const [identity, scan] = envelopesFor(fixture.a, at);
    assert.ok(identity !== undefined && scan !== undefined);

    // The carton is already here; only the scan is being applied.
    assert.equal(applyEnvelope(fixture.b.sql, identity).status, "APPLIED");
    assert.equal(firstEventIdOf(fixture.b, qrId), null, "a registered carton has no first event yet");

    // The process stops after the event row is inserted and before the pointer is written.
    const dying = handleThatFailsOn(fixture.b, /UPDATE qr_master SET first_event_id/);
    assert.throws(() => applyEnvelope(dying, scan), /INTERRUPTED/);

    // NOTHING survived. Before the fix the insert had committed on its own, the retry below
    // would have answered DUPLICATE, and first_event_id would have stayed null for good.
    assert.equal(productionRows(fixture.b).length, 0, "the event row must have been rolled back");
    assert.equal(firstEventIdOf(fixture.b, qrId), null);
    assert.deepEqual(qrIds(fixture.b), [qrId], "and the carton itself is untouched");

    // The retry that at-least-once delivery guarantees. It applies the whole arrival.
    const retry = applyEnvelope(fixture.b.sql, scan);
    assert.equal(retry.status, "APPLIED", "the retry must apply, not report a duplicate");
    assert.equal(productionRows(fixture.b).length, 1);
    assert.equal(productionRows(fixture.b)[0]?.id, eventId);
    assert.equal(firstEventIdOf(fixture.b, qrId), eventId, "the pointer is no longer lost");

    // And applying it once more is still the no-op it has always been.
    assert.equal(applyEnvelope(fixture.b.sql, scan).status, "DUPLICATE");
    assert.equal(productionRows(fixture.b).length, 1);
    assert.equal(firstEventIdOf(fixture.b, qrId), eventId);
  } finally {
    fixture.cleanup();
  }
});

test("a failed apply leaves no transaction open, and the database is usable afterwards", () => {
  const fixture = createFixture("rollback-clean");
  try {
    const at = "2026-10-01T11:45:00.000Z";
    const qrId = "SK9_BLACK_7/10_000002";
    recordScan(fixture.a, { qrId, serial: "000002", occurredAt: at });
    const [identity, scan] = envelopesFor(fixture.a, at);
    assert.ok(identity !== undefined && scan !== undefined);
    assert.equal(applyEnvelope(fixture.b.sql, identity).status, "APPLIED");

    const dying = handleThatFailsOn(fixture.b, /UPDATE qr_master SET first_event_id/);
    assert.throws(() => applyEnvelope(dying, scan), /INTERRUPTED/);

    // A leaked transaction would make this throw "cannot start a transaction within a
    // transaction" — and would hold the write lock against every scan on this computer.
    fixture.b.raw.exec("BEGIN IMMEDIATE TRANSACTION");
    fixture.b.raw.exec("COMMIT");

    // The insert itself failing rolls back the same way: a bad foreign key writes nothing.
    const orphan: SyncEnvelope = {
      ...scan,
      aggregateId: "event-orphan",
      dedupeKey: productionProducedDedupeKey("event-orphan"),
      payload: { ...scan.payload, eventId: "event-orphan", qrId: "SK9_BLACK_7/10_999999" },
    };
    const refused = applyEnvelope(fixture.b.sql, orphan);
    assert.equal(refused.status, "REJECTED", "a scan whose carton is absent is refused, not written");
    assert.equal(productionRows(fixture.b).length, 0);

    fixture.b.raw.exec("BEGIN IMMEDIATE TRANSACTION");
    fixture.b.raw.exec("COMMIT");
  } finally {
    fixture.cleanup();
  }
});

// ─── bringing a parked event back ───────────────────────────────────────────
//
// DEAD_LETTER used to be the end of the line. The service refuses a carton the agreed number of
// times — a product the cloud has not been given, a device nobody enrolled — the row parks, and
// nothing in the application could offer it again: `dedupe_key` is UNIQUE and every enqueue is
// ON CONFLICT DO NOTHING, so it could not even be re-queued. The event sat in the database
// having quietly stopped being sent.
//
// These prove the way back: one named row, only if it really is parked, with the event itself
// left exactly as it was so the receiver still recognises a repeat.

const outboxRow = (node: Node, aggregateType: string): Record<string, unknown> =>
  node.raw
    .prepare("SELECT * FROM sync_outbox WHERE aggregate_type = ? LIMIT 1")
    .get(aggregateType) as Record<string, unknown>;

/** Parks a row the way a run of refusals does, without needing a service to refuse it. */
function park(node: Node, outboxId: string, error: string, whenIso: string): void {
  const status = markFailed(
    node.sql,
    { outboxId, attempts: 4, transientAttempts: 0, error, kind: "PERMANENT" },
    whenIso,
    FAST_RETRY
  );
  assert.equal(status, "DEAD_LETTER", "the fixture must really park the row");
}

test("a parked event is listed with what identifies it and why it stopped, and no payload", () => {
  const fixture = createFixture("dead-letter-list");
  try {
    const at = "2026-10-01T12:00:00.000Z";
    recordScan(fixture.a, { qrId: "SK9_BLACK_7/10_000001", serial: "000001", occurredAt: at });
    const carton = outboxRow(fixture.a, "QR_MASTER");
    park(fixture.a, String(carton.id), "42501:row-level security refused this device", at);

    const parked = deadLetters(fixture.a.sql);
    assert.equal(parked.length, 1, "only the parked row is listed");
    const entry = parked[0];
    assert.ok(entry !== undefined);
    assert.equal(entry.outboxId, String(carton.id));
    assert.equal(entry.aggregateType, "QR_MASTER");
    assert.equal(entry.aggregateId, "SK9_BLACK_7/10_000001", "the aggregate is identifiable");
    assert.equal(entry.attempts, 5, "the refusal that parked it is counted");
    assert.equal(entry.transientAttempts, 0);
    assert.match(entry.error, /42501/);
    assert.equal(entry.updatedAt, at);
    assert.ok(entry.createdAt.length > 0);

    // THE REDACTION: the payload is not in the shape at all, so none of it can leak into a
    // screen or a log. A production scan's payload carries the operator and every snapshot.
    assert.deepEqual(Object.keys(entry).sort(), [
      "aggregateId",
      "aggregateType",
      "attempts",
      "createdAt",
      "dedupeKey",
      "error",
      "outboxId",
      "transientAttempts",
      "updatedAt",
    ]);
  } finally {
    fixture.cleanup();
  }
});

test("only a parked event can be put back, and only when it is named exactly", () => {
  const fixture = createFixture("dead-letter-guards");
  try {
    const at = "2026-10-01T12:15:00.000Z";
    recordScan(fixture.a, { qrId: "SK9_BLACK_7/10_000001", serial: "000001", occurredAt: at });
    const carton = outboxRow(fixture.a, "QR_MASTER");
    const scan = outboxRow(fixture.a, "PRODUCTION_PRODUCED");

    // An id that is not in this queue.
    assert.deepEqual(requeueDeadLetter(fixture.a.sql, "no-such-outbox-row", at), {
      requeued: false,
      reason: "NOT_FOUND",
    });
    // An empty id is simply not found either — it can never match a row.
    assert.deepEqual(requeueDeadLetter(fixture.a.sql, "", at), { requeued: false, reason: "NOT_FOUND" });

    // A row that is waiting perfectly well must not be disturbed.
    assert.deepEqual(requeueDeadLetter(fixture.a.sql, String(scan.id), at), {
      requeued: false,
      reason: "NOT_DEAD_LETTERED",
      status: "PENDING",
    });
    assert.equal(String(outboxRow(fixture.a, "PRODUCTION_PRODUCED").status), "PENDING", "and is untouched");

    // Parked, recovered, and then refused a second time: it is no longer parked.
    park(fixture.a, String(carton.id), "23503:the cloud has no such product", at);
    const first = requeueDeadLetter(fixture.a.sql, String(carton.id), "2026-10-01T12:20:00.000Z");
    assert.equal(first.requeued, true);
    const second = requeueDeadLetter(fixture.a.sql, String(carton.id), "2026-10-01T12:21:00.000Z");
    assert.deepEqual(second, { requeued: false, reason: "NOT_DEAD_LETTERED", status: "PENDING" });

    assert.deepEqual(deadLetters(fixture.a.sql), [], "nothing is parked any more");
  } finally {
    fixture.cleanup();
  }
});

test("a recovered event keeps its identity and its place, and only the retry fields are reset", () => {
  const fixture = createFixture("dead-letter-fields");
  try {
    const at = "2026-10-01T12:30:00.000Z";
    recordScan(fixture.a, { qrId: "SK9_BLACK_7/10_000001", serial: "000001", occurredAt: at });
    const before = outboxRow(fixture.a, "QR_MASTER");
    // A spell offline first, so both counters have something to reset. A transient failure is
    // never parked — it leaves the row FAILED — so the refusals that park it come after.
    markFailed(
      fixture.a.sql,
      { outboxId: String(before.id), attempts: 0, transientAttempts: 2, error: "offline", kind: "TRANSIENT" },
      at,
      FAST_RETRY
    );
    park(fixture.a, String(before.id), "42501:not enrolled", at);
    assert.equal(Number(outboxRow(fixture.a, "QR_MASTER").transient_attempts), 3, "both counters are set");

    const recoveredAt = "2026-10-01T12:35:00.000Z";
    const outcome = requeueDeadLetter(fixture.a.sql, String(before.id), recoveredAt);
    assert.ok(outcome.requeued, "the parked row is put back");
    // The answer carries what it WAS, which is what an audit entry has to be able to say.
    assert.equal(outcome.entry.attempts, 5);
    assert.match(outcome.entry.error, /42501/);

    const after = outboxRow(fixture.a, "QR_MASTER");
    assert.equal(String(after.status), "PENDING");
    assert.equal(after.lock_token, null);
    assert.equal(Number(after.attempts), 0, "the refusal budget is given back");
    assert.equal(Number(after.transient_attempts), 0);
    assert.equal(String(after.available_at), recoveredAt, "and it is due now, not after a backoff");
    assert.equal(String(after.updated_at), recoveredAt);

    // DEDUPLICATION IS PRESERVED. The event must go as the event it always was: a changed key
    // would be a second carton to the receiver, and a changed created_at would send it to the
    // back of a queue it has been waiting at the front of.
    assert.equal(String(after.dedupe_key), String(before.dedupe_key));
    assert.equal(String(after.payload_json), String(before.payload_json));
    assert.equal(String(after.created_at), String(before.created_at));
    assert.equal(String(after.aggregate_id), String(before.aggregate_id));
    // The reason it stopped is kept as the trail, exactly as reclaimStale keeps it.
    assert.match(String(after.last_error), /42501|offline/);
  } finally {
    fixture.cleanup();
  }
});

test("a recovered event is delivered by the next pass, once, and never twice", async () => {
  const fixture = createFixture("dead-letter-retry");
  const backend = await startTestSyncBackend(fixture.b.sql);
  try {
    const time = clock("2026-10-01T12:45:00.000Z");
    recordScan(fixture.a, { qrId: "SK9_BLACK_7/10_000001", serial: "000001", occurredAt: time.nowIso() });
    const carton = outboxRow(fixture.a, "QR_MASTER");
    park(fixture.a, String(carton.id), "23503:the cloud has no such product", time.nowIso());

    // A parked row is never claimed, so a pass before the recovery offers only the scan — and
    // the receiver cannot take a scan whose carton never arrived. Nothing gets through, and
    // that is the whole cost of a parked identity: everything behind it stops too.
    const beforeRecovery = await drainTo(fixture.a, backend.host, backend.port, time.nowIso).runOnce();
    assert.equal(beforeRecovery.leased, 1, "the parked carton is not even claimed");
    assert.equal(beforeRecovery.synced, 0, "and the scan cannot land without it");
    assert.equal(outboxCounts(fixture.a.sql).DEAD_LETTER, 1);
    assert.deepEqual(qrIds(fixture.b), [], "the parked carton never went");
    assert.equal(productionRows(fixture.b).length, 0, "so the scan is waiting on the other side");

    // The owner fixes the cause, then puts the one parked event back.
    time.advanceMs(60_000);
    assert.equal(requeueDeadLetter(fixture.a.sql, String(carton.id), time.nowIso()).requeued, true);
    assert.equal(outboxCounts(fixture.a.sql).DEAD_LETTER, 0, "nothing is parked any more");
    assert.equal(outboxCounts(fixture.a.sql).PENDING, 1, "the carton is queued again");

    // Requeuing sends nothing by itself. The next pass does.
    assert.deepEqual(qrIds(fixture.b), [], "putting it back does not send it");

    const afterRecovery = await drainTo(fixture.a, backend.host, backend.port, time.nowIso).runOnce();
    assert.equal(afterRecovery.synced, 2, "the carton goes first, and the scan it was holding up follows");
    assert.deepEqual(qrIds(fixture.b), ["SK9_BLACK_7/10_000001"], "the carton finally arrives");
    assert.deepEqual(outboxCounts(fixture.a.sql), {
      PENDING: 0,
      IN_FLIGHT: 0,
      FAILED: 0,
      DEAD_LETTER: 0,
      SYNCED: 2,
    });

    // Delivered exactly once despite the earlier attempts: the key never changed.
    time.advanceMs(60_000);
    await drainTo(fixture.a, backend.host, backend.port, time.nowIso).runOnce();
    assert.deepEqual(qrIds(fixture.b), ["SK9_BLACK_7/10_000001"]);
    assert.equal(productionRows(fixture.b).length, 1, "and the scan it was holding up is applied");
  } finally {
    await backend.close();
    fixture.cleanup();
  }
});

// ─── reading the queue as an operator has to read it ────────────────────────
//
// outboxCounts partitions by STATUS, which is the whole story only while everything in the
// queue can be sent. It cannot: four of the six aggregate types have no transport, so a PENDING
// count mixes cartons that go on the next pass with dispatch and store events that will not go
// for months. These prove the second view — by sendability — and that it agrees with the lease.

/** Queues one row directly, so a case can be built without driving a whole scan through. */
function queueRow(
  node: Node,
  row: { id: string; type: string; aggregateId: string; status: string; availableAt: string; createdAt: string }
): void {
  node.raw
    .prepare(
      `INSERT INTO sync_outbox (
         id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
         status, lock_token, available_at, attempts, last_error, created_at, updated_at
       ) VALUES (?, ?, ?, 'INSERT', ?, '{}', ?, NULL, ?, 0, NULL, ?, ?)`
    )
    .run(
      row.id,
      row.type,
      row.aggregateId,
      `${row.type}:${row.aggregateId}`,
      row.status,
      row.availableAt,
      row.createdAt,
      row.createdAt
    );
}

const NOW = "2026-10-01T14:00:00.000Z";
const EARLIER = "2026-10-01T13:00:00.000Z";
const LATER = "2026-10-01T15:00:00.000Z";
const PUSHABLE = ["QR_MASTER"] as const;

test("an empty queue reports zeros and no timestamps, never a pretended sync", () => {
  const fixture = createFixture("summary-empty");
  try {
    const summary = outboxSummary(fixture.a.sql, { pushableTypes: PUSHABLE, nowIso: NOW });
    assert.deepEqual(summary.counts, { PENDING: 0, IN_FLIGHT: 0, FAILED: 0, DEAD_LETTER: 0, SYNCED: 0 });
    assert.equal(summary.pushableNow, 0);
    assert.equal(summary.pushableWaiting, 0);
    assert.equal(summary.notPushable, 0);
    // A computer that has never sent anything must not be given a time at which it did.
    assert.equal(summary.lastSyncedAt, null);
    assert.equal(summary.lastFailureAt, null);
  } finally {
    fixture.cleanup();
  }
});

// ─── a thrown send is settled by what the transport SAYS it was ──────────────
//
// drain.runOnce used to settle every thrown send as TRANSIENT, whatever the cause, so a call the
// service will never accept was retried without limit: the queue stopped draining and the only
// sign was a growing last_error. The kind now travels on SyncTransportError, and absent is still
// TRANSIENT because a batch that may never have arrived says nothing about the events in it.

/** A transport that always throws, with whatever classification the test wants to prove. */
const throwingTransport = (failure?: "TRANSIENT" | "REFUSED" | "PERMANENT"): SyncTransport => ({
  send: () => Promise.reject(new SyncTransportError("the service said no", failure)),
});

test("a refused CALL parks the batch once the bounded budget is spent", async () => {
  const fixture = createFixture("drain-refused-call");
  try {
    const sender = fixture.a;
    recordScan(sender, { qrId: "SK9_BLACK_7/10_000001", serial: "000001", occurredAt: "2026-10-16T08:01:00.000Z" });

    const time = { value: Date.parse("2026-10-16T09:00:00.000Z") };
    const drain = new OutboxDrain(sender.sql, throwingTransport("REFUSED"), {
      deviceId: sender.deviceId,
      retryPolicy: FAST_RETRY,
      aggregateTypes: ["QR_MASTER"],
      now: () => new Date(time.value).toISOString(),
    });

    let parked = 0;
    for (let pass = 0; pass < FAST_RETRY.maxAttempts; pass += 1) {
      const result = await drain.runOnce();
      parked += result.deadLettered;
      time.value += 24 * 3_600_000; // past any backoff
    }

    assert.equal(parked, 1, "a call the service refuses is bounded, and ends in the dead-letter queue");
    const row = sender.raw
      .prepare("SELECT status, attempts, transient_attempts FROM sync_outbox WHERE aggregate_type = 'QR_MASTER'")
      .get() as { status: string; attempts: number; transient_attempts: number };
    assert.equal(row.status, "DEAD_LETTER");
    assert.equal(row.attempts, FAST_RETRY.maxAttempts, "it spent the bounded budget, as a refusal should");
    assert.equal(row.transient_attempts, 0);
    // And it is recoverable by name, which is the whole point of parking rather than losing it.
    assert.equal(deadLetters(sender.sql).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("an unclassified thrown send is still never parked, however many times it fails", async () => {
  const fixture = createFixture("drain-unclassified");
  try {
    const sender = fixture.a;
    recordScan(sender, { qrId: "SK9_BLACK_7/10_000001", serial: "000001", occurredAt: "2026-10-16T08:01:00.000Z" });

    const time = { value: Date.parse("2026-10-16T09:00:00.000Z") };
    // No failure kind: an unreachable service, a timeout, a proxy returning nonsense.
    const drain = new OutboxDrain(sender.sql, throwingTransport(undefined), {
      deviceId: sender.deviceId,
      retryPolicy: FAST_RETRY,
      aggregateTypes: ["QR_MASTER"],
      now: () => new Date(time.value).toISOString(),
    });

    for (let pass = 0; pass < FAST_RETRY.maxAttempts + 3; pass += 1) {
      assert.equal((await drain.runOnce()).deadLettered, 0, "nothing may be parked for an unknown cause");
      time.value += 24 * 3_600_000;
    }

    const row = sender.raw
      .prepare("SELECT status, attempts, transient_attempts FROM sync_outbox WHERE aggregate_type = 'QR_MASTER'")
      .get() as { status: string; attempts: number; transient_attempts: number };
    assert.notEqual(row.status, "DEAD_LETTER");
    assert.equal(row.attempts, 0, "the bounded budget is untouched by a failure that is not a refusal");
    assert.ok(row.transient_attempts >= FAST_RETRY.maxAttempts);
  } finally {
    fixture.cleanup();
  }
});

// ─── the batch boundary ──────────────────────────────────────────────────────
//
// A scan is refused by push_production_produced until its carton identity is in the cloud. Inside
// one call that cannot happen: send() offers cartons first. But the LEASE decides which rows share
// a call, and it is capped. Ordered purely by created_at, a busy run put the scans in this batch
// and their cartons in the next, so every scan came back QR_NOT_REGISTERED_YET -- and bounded,
// five passes parked perfectly good work.
//
// Two defences, and these tests pin both: identities are claimed first, and that particular
// refusal is transient so an ordering miss costs a wait rather than the event.

test("a variant is leased ahead of the carton of it, and the carton ahead of the scan", () => {
  const fixture = createFixture("lease-order-variant");
  try {
    const sender = fixture.a;

    // The 2026-10-22 order of events on the floor: the product is created, then a carton of it
    // is registered, then it is scanned -- ten seconds apart, so by created_at the queue holds
    // them variant, carton, scan. The lease must keep that order however they were written.
    enqueueProductVariant(
      sender.sql,
      {
        variantId: NEW_VARIANT,
        article: "SK46",
        color: "BLACK",
        size: "4/6",
        description: "SK46 BLACK 4/6",
        createdAt: "2026-10-22T12:26:22.000Z",
      },
      crypto.randomUUID()
    );
    recordScan(sender, {
      qrId: "SK46_BLACK_4/6_000001",
      serial: "000001",
      occurredAt: "2026-10-22T12:26:32.000Z",
    });

    const leased = leaseBatch(sender.sql, {
      limit: 1,
      nowIso: "2026-10-22T12:30:00.000Z",
      lockToken: "lock-variant-1",
      deviceId: sender.deviceId,
      aggregateTypes: ["PRODUCT_VARIANT", "QR_MASTER", "PRODUCTION_PRODUCED"],
    });
    assert.deepEqual(
      leased.map((event) => event.envelope.aggregateType),
      ["PRODUCT_VARIANT"],
      "a lease of one takes the product, because a carton of it cannot land without it"
    );
    for (const event of leased) markSynced(sender.sql, event.outboxId, "2026-10-22T12:30:01.000Z");

    const rest = leaseBatch(sender.sql, {
      limit: 5,
      nowIso: "2026-10-22T12:30:02.000Z",
      lockToken: "lock-variant-2",
      deviceId: sender.deviceId,
      aggregateTypes: ["PRODUCT_VARIANT", "QR_MASTER", "PRODUCTION_PRODUCED"],
    });
    assert.deepEqual(
      rest.map((event) => event.envelope.aggregateType),
      ["QR_MASTER", "PRODUCTION_PRODUCED"],
      "then the carton, then the scan: each link only ever ahead of the next"
    );
  } finally {
    fixture.cleanup();
  }
});

test("a lease smaller than the queue still takes every carton identity before any scan", () => {
  const fixture = createFixture("lease-order");
  try {
    const sender = fixture.a;

    // Six scans, each writing a carton and then its event -- so by created_at the queue
    // interleaves identity, scan, identity, scan, ... and a limit of 6 would once have taken
    // three pairs. The carton of pair 4 would then have been a batch behind its own scan.
    for (let i = 1; i <= 6; i += 1) {
      recordScan(sender, {
        qrId: `SK9_BLACK_7/10_00000${String(i)}`,
        serial: `00000${String(i)}`,
        occurredAt: `2026-10-16T08:0${String(i)}:00.000Z`,
      });
    }
    assert.equal(outboxCounts(sender.sql).PENDING, 12, "six identities and six scans are queued");

    const leased = leaseBatch(sender.sql, {
      limit: 6,
      nowIso: "2026-10-16T09:00:00.000Z",
      lockToken: "lock-order",
      deviceId: sender.deviceId,
      aggregateTypes: ["QR_MASTER", "PRODUCTION_PRODUCED"],
    });

    assert.equal(leased.length, 6);
    assert.deepEqual(
      leased.map((event) => event.envelope.aggregateType),
      Array.from({ length: 6 }, () => "QR_MASTER"),
      "every identity goes first, so no scan can be offered ahead of its own carton"
    );
    // And within the identities, the queue's own order is kept.
    assert.deepEqual(
      leased.map((event) => event.envelope.aggregateId),
      [1, 2, 3, 4, 5, 6].map((i) => `SK9_BLACK_7/10_00000${String(i)}`)
    );
  } finally {
    fixture.cleanup();
  }
});

test("a scan is claimed once its carton has been, and the queue drains in two passes", () => {
  const fixture = createFixture("lease-order-second");
  try {
    const sender = fixture.a;
    for (let i = 1; i <= 3; i += 1) {
      recordScan(sender, {
        qrId: `SK9_BLACK_7/10_00000${String(i)}`,
        serial: `00000${String(i)}`,
        occurredAt: `2026-10-16T08:0${String(i)}:00.000Z`,
      });
    }

    const first = leaseBatch(sender.sql, {
      limit: 3, nowIso: "2026-10-16T09:00:00.000Z", lockToken: "lock-1",
      deviceId: sender.deviceId, aggregateTypes: ["QR_MASTER", "PRODUCTION_PRODUCED"],
    });
    assert.deepEqual(first.map((e) => e.envelope.aggregateType), ["QR_MASTER", "QR_MASTER", "QR_MASTER"]);
    for (const event of first) markSynced(sender.sql, event.outboxId, "2026-10-16T09:00:01.000Z");

    const second = leaseBatch(sender.sql, {
      limit: 3, nowIso: "2026-10-16T09:00:02.000Z", lockToken: "lock-2",
      deviceId: sender.deviceId, aggregateTypes: ["QR_MASTER", "PRODUCTION_PRODUCED"],
    });
    assert.deepEqual(
      second.map((e) => e.envelope.aggregateType),
      ["PRODUCTION_PRODUCED", "PRODUCTION_PRODUCED", "PRODUCTION_PRODUCED"],
      "the scans follow, every carton already acknowledged"
    );
    for (const event of second) markSynced(sender.sql, event.outboxId, "2026-10-16T09:00:03.000Z");
    assert.equal(outboxCounts(sender.sql).PENDING, 0, "nothing is left behind");
  } finally {
    fixture.cleanup();
  }
});

test("an ordering miss costs a wait, not the event: the transient budget is unbounded", () => {
  const fixture = createFixture("lease-order-transient");
  try {
    const sender = fixture.a;
    const { eventId } = recordScan(sender, {
      qrId: "SK9_BLACK_7/10_000001",
      serial: "000001",
      occurredAt: "2026-10-16T08:01:00.000Z",
    });

    const dedupeKey = productionProducedDedupeKey(eventId);
    const row = (): { id: string; status: string; attempts: number; transient_attempts: number } =>
      sender.raw
        .prepare("SELECT id, status, attempts, transient_attempts FROM sync_outbox WHERE dedupe_key = ?")
        .get(dedupeKey) as { id: string; status: string; attempts: number; transient_attempts: number };

    // Refused as QR_NOT_REGISTERED_YET more times than maxAttempts allows. Bounded, this would
    // be DEAD_LETTER by the fifth; transient, it is still waiting.
    let at = "2026-10-16T09:00:00.000Z";
    for (let i = 0; i < FAST_RETRY.maxAttempts + 3; i += 1) {
      const current = row();
      markFailed(
        sender.sql,
        {
          outboxId: current.id,
          attempts: current.attempts,
          transientAttempts: current.transient_attempts,
          error: "QR_NOT_REGISTERED_YET",
          kind: "TRANSIENT",
        },
        at,
        FAST_RETRY
      );
      at = new Date(new Date(at).getTime() + 3_600_000).toISOString();
    }

    const final = row();
    assert.notEqual(final.status, "DEAD_LETTER", "a wait must never park the event");
    assert.equal(final.attempts, 0, "the bounded budget was never touched");
    assert.ok(final.transient_attempts >= FAST_RETRY.maxAttempts, "it is counted, just not against the limit");
  } finally {
    fixture.cleanup();
  }
});

test("mixed types and statuses are split by what could actually be sent", () => {
  const fixture = createFixture("summary-mixed");
  try {
    const rows = [
      // Sendable and due: exactly what the next pass would claim.
      { id: "o1", type: "QR_MASTER", aggregateId: "qr-1", status: "PENDING", availableAt: EARLIER },
      { id: "o2", type: "QR_MASTER", aggregateId: "qr-2", status: "FAILED", availableAt: EARLIER },
      // Sendable, but backing off.
      { id: "o3", type: "QR_MASTER", aggregateId: "qr-3", status: "FAILED", availableAt: LATER },
      // Queued, and nothing can carry them yet.
      { id: "o4", type: "PRODUCTION_PRODUCED", aggregateId: "ev-1", status: "PENDING", availableAt: EARLIER },
      { id: "o5", type: "DISPATCH_EVENT", aggregateId: "ev-2", status: "PENDING", availableAt: EARLIER },
      { id: "o6", type: "RETURN_EVENT", aggregateId: "ev-3", status: "FAILED", availableAt: LATER },
      // Not unsent at all.
      { id: "o7", type: "QR_MASTER", aggregateId: "qr-4", status: "IN_FLIGHT", availableAt: EARLIER },
      { id: "o8", type: "QR_MASTER", aggregateId: "qr-5", status: "DEAD_LETTER", availableAt: EARLIER },
      { id: "o9", type: "QR_MASTER", aggregateId: "qr-6", status: "SYNCED", availableAt: EARLIER },
    ];
    for (const row of rows) queueRow(fixture.a, { ...row, createdAt: EARLIER });

    const summary = outboxSummary(fixture.a.sql, { pushableTypes: PUSHABLE, nowIso: NOW });

    assert.deepEqual(summary.counts, { PENDING: 3, IN_FLIGHT: 1, FAILED: 3, DEAD_LETTER: 1, SYNCED: 1 });
    assert.equal(summary.pushableNow, 2, "two cartons are due");
    assert.equal(summary.pushableWaiting, 1, "one carton is backing off");
    assert.equal(summary.notPushable, 3, "the production, dispatch and return events have no transport");

    // THE PARTITION HOLDS: the sendability view accounts for every unsent row, exactly once.
    assert.equal(
      summary.pushableNow + summary.pushableWaiting + summary.notPushable,
      summary.counts.PENDING + summary.counts.FAILED
    );
  } finally {
    fixture.cleanup();
  }
});

test("what the summary calls due is what the drain actually claims", () => {
  const fixture = createFixture("summary-agrees");
  try {
    queueRow(fixture.a, { id: "o1", type: "QR_MASTER", aggregateId: "qr-1", status: "PENDING", availableAt: EARLIER, createdAt: EARLIER });
    queueRow(fixture.a, { id: "o2", type: "QR_MASTER", aggregateId: "qr-2", status: "FAILED", availableAt: LATER, createdAt: EARLIER });
    queueRow(fixture.a, { id: "o3", type: "DISPATCH_EVENT", aggregateId: "ev-1", status: "PENDING", availableAt: EARLIER, createdAt: EARLIER });

    const summary = outboxSummary(fixture.a.sql, { pushableTypes: PUSHABLE, nowIso: NOW });
    const leased = leaseBatch(fixture.a.sql, {
      limit: 100,
      nowIso: NOW,
      lockToken: "token-1",
      deviceId: fixture.a.deviceId,
      aggregateTypes: PUSHABLE,
    });

    // One number, two code paths. If the lease predicate ever changes, this is what notices.
    assert.equal(summary.pushableNow, leased.length);
    assert.deepEqual(leased.map((event) => event.outboxId), ["o1"]);
  } finally {
    fixture.cleanup();
  }
});

test("a parked event is counted as parked, and never as something that is about to go", () => {
  const fixture = createFixture("summary-parked");
  try {
    recordScan(fixture.a, { qrId: "SK9_BLACK_7/10_000001", serial: "000001", occurredAt: EARLIER });
    const carton = outboxRow(fixture.a, "QR_MASTER");
    park(fixture.a, String(carton.id), "42501:not enrolled", NOW);

    const summary = outboxSummary(fixture.a.sql, { pushableTypes: PUSHABLE, nowIso: NOW });
    assert.equal(summary.counts.DEAD_LETTER, 1);
    assert.equal(summary.pushableNow, 0, "a parked carton is not about to go anywhere");
    assert.equal(summary.pushableWaiting, 0);
    assert.equal(summary.notPushable, 1, "only the production event is still waiting for a transport");
    assert.equal(summary.lastFailureAt, NOW, "and the failure is dated from the row, not invented");
    assert.equal(summary.lastSyncedAt, null);

    // Recovering it puts it straight back into the "would go next pass" number.
    assert.equal(requeueDeadLetter(fixture.a.sql, String(carton.id), NOW).requeued, true);
    const after = outboxSummary(fixture.a.sql, { pushableTypes: PUSHABLE, nowIso: NOW });
    assert.equal(after.counts.DEAD_LETTER, 0);
    assert.equal(after.pushableNow, 1);
  } finally {
    fixture.cleanup();
  }
});

test("the timestamps come off rows that exist, and stay null until they do", () => {
  const fixture = createFixture("summary-times");
  try {
    queueRow(fixture.a, { id: "o1", type: "QR_MASTER", aggregateId: "qr-1", status: "PENDING", availableAt: EARLIER, createdAt: EARLIER });
    assert.equal(outboxSummary(fixture.a.sql, { pushableTypes: PUSHABLE, nowIso: NOW }).lastSyncedAt, null);

    markSynced(fixture.a.sql, "o1", EARLIER);
    queueRow(fixture.a, { id: "o2", type: "QR_MASTER", aggregateId: "qr-2", status: "PENDING", availableAt: EARLIER, createdAt: EARLIER });
    markSynced(fixture.a.sql, "o2", LATER);

    const summary = outboxSummary(fixture.a.sql, { pushableTypes: PUSHABLE, nowIso: NOW });
    assert.equal(summary.lastSyncedAt, LATER, "the most recent send, not the first");
    assert.equal(summary.counts.SYNCED, 2);
    assert.equal(summary.lastFailureAt, null, "nothing has failed, and nothing says it has");
  } finally {
    fixture.cleanup();
  }
});

test("a transport that can carry nothing says so, instead of promising a pass", () => {
  const fixture = createFixture("summary-nothing-sendable");
  try {
    queueRow(fixture.a, { id: "o1", type: "QR_MASTER", aggregateId: "qr-1", status: "PENDING", availableAt: EARLIER, createdAt: EARLIER });
    const summary = outboxSummary(fixture.a.sql, { pushableTypes: [], nowIso: NOW });
    assert.equal(summary.pushableNow, 0);
    assert.equal(summary.pushableWaiting, 0);
    assert.equal(summary.notPushable, 1, "with no sendable types, every unsent row is waiting on one");
    assert.equal(summary.counts.PENDING, 1);
  } finally {
    fixture.cleanup();
  }
});

test("reading the summary changes nothing in the queue", () => {
  const fixture = createFixture("summary-read-only");
  try {
    recordScan(fixture.a, { qrId: "SK9_BLACK_7/10_000001", serial: "000001", occurredAt: EARLIER });
    const before = fixture.a.raw.prepare("SELECT * FROM sync_outbox ORDER BY id").all();

    for (let read = 0; read < 3; read += 1) {
      outboxSummary(fixture.a.sql, { pushableTypes: PUSHABLE, nowIso: NOW });
    }

    const after = fixture.a.raw.prepare("SELECT * FROM sync_outbox ORDER BY id").all();
    assert.deepEqual(after, before, "every column of every row is exactly as it was");
  } finally {
    fixture.cleanup();
  }
});
