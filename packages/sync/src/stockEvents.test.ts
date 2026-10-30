import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase, buildLeasedRecordRevisions, buildStockEvents } from "@erp/data";
import { applyEnvelope } from "./applyEnvelope.js";
import type { SyncEnvelope } from "./contract.js";

// STOCK MOVES ON ANOTHER COMPUTER EXACTLY AS IT MOVED ON THE STORE PC (stockEventContracts.ts), end to
// end: the store PC records movements the ordinary way, its capture trigger marks them, the real
// builder queues them with their balance change, and the real applier writes them on a reader.

const SCHEMA = path.resolve(import.meta.dirname, "../../data/src/local-schema.sql");
const NOW = "2026-10-26T10:00:00.000Z";

interface Pc {
  readonly db: SqliteDatabase;
  readonly close: () => void;
}

function openPc(name: string): Pc {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `erp-stock-${name}-`));
  const db = new SqliteDatabase({ dbPath: path.join(dir, "erp.db"), schemaPath: SCHEMA });
  return { db, close: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

/** The store PC, holding both leases, with one material whose stock is counted in KG. */
function openHolder(): Pc {
  const pc = openPc("holder");
  for (const domain of ["MASTER_DATA", "RAW_MATERIAL_STORE"]) {
    pc.db.db.prepare(
      `INSERT INTO sync_domain_leases (domain, holder_device_id, holder_label, epoch, barrier_seq, granted_at, project_key, fetched_at)
       VALUES (?, 'dev-holder', 'Store PC', 1, 0, ?, 'https://test.supabase.co', ?)`
    ).run(domain, NOW, NOW);
  }
  run(pc, "INSERT INTO inventory_units (id, code, name, created_at, updated_at) VALUES ('u-kg', 'KG', 'Kilogram', ?, ?)", NOW, NOW);
  run(pc, "INSERT INTO inventory_categories (id, category_code, name, created_at, updated_at) VALUES ('c-1', 'C1', 'Dana', ?, ?)", NOW, NOW);
  run(
    pc,
    "INSERT INTO inventory_items (id, item_code, category_id, display_name, signature_hash, default_unit_id, created_at, updated_at) VALUES ('i-1', 'RM-1', 'c-1', 'Dana Black', 'sig', 'u-kg', ?, ?)",
    NOW, NOW
  );
  return pc;
}

const run = (pc: Pc, sql: string, ...params: Array<string | number | null>) => pc.db.db.prepare(sql).run(...params);

/** A movement as the store's write paths record it: the event and its balance change together. */
function record(pc: Pc, id: string, eventType: string, quantity: number, balanceChange: number): void {
  run(pc, "INSERT INTO inventory_stock_events (id, item_id, event_type, quantity, unit_id, note, created_at) VALUES (?, 'i-1', ?, ?, 'u-kg', 'test', ?)", id, eventType, quantity, NOW);
  run(
    pc,
    `INSERT INTO inventory_stock_balances (item_id, quantity_on_hand, unit_id, updated_at) VALUES ('i-1', ?, 'u-kg', ?)
     ON CONFLICT(item_id) DO UPDATE SET quantity_on_hand = quantity_on_hand + excluded.quantity_on_hand`,
    balanceChange, NOW
  );
}

/** Everything the holder has queued since the last call, as envelopes keyed by dedupe key. */
function sent(holder: Pc): Map<string, SyncEnvelope> {
  buildLeasedRecordRevisions(holder.db.db, NOW);
  buildStockEvents(holder.db.db, NOW);
  const rows = holder.db.db.prepare("SELECT aggregate_type, aggregate_id, dedupe_key, payload_json FROM sync_outbox WHERE status = 'PENDING' ORDER BY rowid").all() as Array<Record<string, unknown>>;
  holder.db.db.prepare("UPDATE sync_outbox SET status = 'SYNCED' WHERE status = 'PENDING'").run();
  return new Map(rows.map((row) => [String(row.dedupe_key), envelope(String(row.aggregate_type), String(row.aggregate_id), JSON.parse(String(row.payload_json)) as Record<string, unknown>)]));
}

const envelope = (aggregateType: string, aggregateId: string, payload: Record<string, unknown>): SyncEnvelope => ({
  dedupeKey: aggregateType === "STOCK_EVENT" ? `STOCK_EVENT:${aggregateId}` : `${aggregateType}:${aggregateId}:${String(payload.revision)}`,
  aggregateType,
  aggregateId,
  operation: "INSERT",
  payload,
  originDeviceId: "dev-holder",
  createdAt: NOW,
});

const apply = (pc: Pc, item: SyncEnvelope | undefined) => {
  assert.ok(item, "it was queued");
  return applyEnvelope(pc.db.db, item, NOW);
};

const balance = (pc: Pc): number | null =>
  (pc.db.db.prepare("SELECT quantity_on_hand AS q FROM inventory_stock_balances WHERE item_id = 'i-1'").get() as { q: number } | undefined)?.q ?? null;

const marks = (pc: Pc): number => Number((pc.db.db.prepare("SELECT COUNT(*) AS n FROM sync_dirty_records").get() as { n: number }).n);

/** The master records a reader needs first: unit, category, material. */
function receiveMaterial(reader: Pc, queued: Map<string, SyncEnvelope>): void {
  for (const key of ["INVENTORY_UNIT:u-kg:1", "INVENTORY_CATEGORY:c-1:1", "INVENTORY_ITEM:i-1:1"]) {
    assert.equal(apply(reader, queued.get(key)).status, "APPLIED", key);
  }
}

test("a movement waits for its material, then moves the reader's balance exactly as the store's -- once", () => {
  const holder = openHolder();
  const reader = openPc("reader");
  try {
    record(holder, "e-open", "RECEIVE", 10, 10);
    record(holder, "e-scan-out", "TRANSFER_OUT", 2, -2); // a packet scanned out: stored positive
    record(holder, "e-hand-out", "TRANSFER_OUT", -3, -3); // a hand move out: stored signed
    const queued = sent(holder);

    assert.deepEqual(apply(reader, queued.get("STOCK_EVENT:e-open")), {
      dedupeKey: "STOCK_EVENT:e-open", status: "REJECTED", reason: "UNKNOWN_INVENTORY_ITEM:i-1", permanent: false,
    }, "the material first: a wait, not a refusal");
    receiveMaterial(reader, queued);
    for (const id of ["e-open", "e-scan-out", "e-hand-out"]) assert.equal(apply(reader, queued.get(`STOCK_EVENT:${id}`)).status, "APPLIED");

    assert.equal(balance(reader), balance(holder));
    assert.equal(balance(reader), 5, "10 - 2 - 3, each convention read once");
    assert.equal(apply(reader, queued.get("STOCK_EVENT:e-scan-out")).status, "DUPLICATE");
    assert.equal(balance(reader), 5, "a repeat moves nothing");
    assert.equal(marks(reader), 0, "received movements are not the reader's own to send");
    const arrived = reader.db.db.prepare("SELECT quantity, replicated_at FROM inventory_stock_events WHERE id = 'e-scan-out'").get() as Record<string, unknown>;
    assert.deepEqual([arrived.quantity, arrived.replicated_at], [2, NOW], "stored as the store stored it, stamped on arrival");
  } finally {
    holder.close();
    reader.close();
  }
});

test("the store PC's own movements come back as duplicates, even after a unit correction rewrote them", () => {
  const holder = openHolder();
  try {
    record(holder, "e-1", "RECEIVE", 4, 4);
    const queued = sent(holder);
    run(holder, "INSERT INTO inventory_units (id, code, name, created_at, updated_at) VALUES ('u-g', 'G', 'Gram', ?, ?)", NOW, NOW);
    run(holder, "UPDATE inventory_stock_events SET unit_id = 'u-g'"); // W.5, not replicated
    assert.equal(apply(holder, queued.get("STOCK_EVENT:e-1")).status, "DUPLICATE");
    assert.equal(balance(holder), 4);
  } finally {
    holder.close();
  }
});

test("a balance kept here in another unit waits rather than mixing units, and writes nothing", () => {
  const holder = openHolder();
  const reader = openPc("reader");
  try {
    record(holder, "e-1", "RECEIVE", 4, 4);
    const queued = sent(holder);
    receiveMaterial(reader, queued);
    run(reader, "INSERT INTO inventory_units (id, code, name, created_at, updated_at) VALUES ('u-g', 'G', 'Gram', ?, ?)", NOW, NOW);
    run(reader, "INSERT INTO inventory_stock_balances (item_id, quantity_on_hand, unit_id, updated_at) VALUES ('i-1', 4000, 'u-g', ?)", NOW);

    const outcome = apply(reader, queued.get("STOCK_EVENT:e-1"));
    assert.deepEqual([outcome.status, outcome.reason, outcome.permanent], ["REJECTED", "STOCK_UNIT_DIFFERS:i-1", false]);
    assert.equal(balance(reader), 4000);
    assert.equal(Number((reader.db.db.prepare("SELECT COUNT(*) AS n FROM inventory_stock_events").get() as { n: number }).n), 0, "rolled back whole");
  } finally {
    holder.close();
    reader.close();
  }
});

test("a Dana issue keeps its machine program aside where programs are not, and another movement under its id is refused", () => {
  const holder = openHolder();
  const reader = openPc("reader");
  try {
    receiveMaterial(reader, sent(holder));
    const dana = {
      eventId: "e-dana", itemId: "i-1", eventType: "TRANSFER_OUT", quantity: -1.5, unitId: "u-kg", note: null, createdBy: null,
      createdAt: NOW, partyId: null, machineProgramId: "mp-9", balanceDelta: -1.5,
    };
    assert.equal(apply(reader, envelope("STOCK_EVENT", "e-dana", dana)).status, "APPLIED");
    const row = reader.db.db.prepare("SELECT machine_program_id, pending_machine_program_id FROM inventory_stock_events WHERE id = 'e-dana'").get() as Record<string, unknown>;
    assert.deepEqual([row.machine_program_id, row.pending_machine_program_id], [null, "mp-9"]);
    assert.equal(balance(reader), -1.5);

    const other = apply(reader, envelope("STOCK_EVENT", "e-dana", { ...dana, quantity: -2, balanceDelta: -2 }));
    assert.deepEqual([other.status, other.reason, other.permanent], ["REJECTED", "STOCK_EVENT_IDENTITY_CONFLICT:e-dana", true]);
    assert.equal(balance(reader), -1.5, "never written over");
  } finally {
    holder.close();
    reader.close();
  }
});

test("a movement whose delta is not its quantity's size is unreadable, not applied", () => {
  const reader = openPc("reader");
  try {
    const broken = {
      eventId: "e-x", itemId: "i-1", eventType: "RECEIVE", quantity: 2, unitId: "u-kg", note: null, createdBy: null,
      createdAt: NOW, partyId: null, machineProgramId: null, balanceDelta: 3,
    };
    const outcome = apply(reader, envelope("STOCK_EVENT", "e-x", broken));
    assert.equal(outcome.status, "REJECTED");
    assert.equal(outcome.permanent, true);
  } finally {
    reader.close();
  }
});
