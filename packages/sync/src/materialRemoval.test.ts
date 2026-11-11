import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase, buildLeasedRecordRevisions, markItemRemoved, stockEventPayloadOf } from "@erp/data";
import type { SyncEnvelope } from "./contract.js";
import { parkedSummary } from "./parking.js";
import { SyncPull } from "./pull.js";
import type { SyncChange, SyncPullTransport } from "./transport.js";
import { waitingSummary } from "./waiting.js";

// REMOVING A MATERIAL, ACROSS COMPUTERS (production, 2026-11-05).
//
// Six materials were removed on the store PC with their ledger. The movements had already
// replicated, append-only, so every other computer held rows naming them, and "still in use" could
// never clear. Stock decides now, not references. Real capture, real builder, real pull: the
// sender's revisions are applied to another computer's database exactly as they would arrive.

const SCHEMA = path.resolve(import.meta.dirname, "../../data/src/local-schema.sql");
const NOW = "2026-11-05T09:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const NINE_DAYS_MS = 9 * 24 * 60 * 60 * 1000;
const ITEM = "i-1";

interface Pc {
  readonly db: SqliteDatabase;
  readonly close: () => void;
}

function openPc(name: string): Pc {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `erp-removal-${name}-`));
  const db = new SqliteDatabase({ dbPath: path.join(dir, "erp.db"), schemaPath: SCHEMA });
  return { db, close: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const run = (pc: Pc, sql: string, ...params: Array<string | number | null>) => pc.db.db.prepare(sql).run(...params);
const one = (pc: Pc, sql: string, ...params: string[]) => pc.db.db.prepare(sql).get(...params) as Record<string, unknown> | undefined;

/** The store PC, holding the master-data lease, with one material. */
function openHolder(): Pc {
  const pc = openPc("holder");
  run(pc, `INSERT INTO sync_domain_leases (domain, holder_device_id, holder_label, epoch, barrier_seq, granted_at, project_key, fetched_at)
           VALUES ('MASTER_DATA', 'dev-holder', 'Store PC', 1, 0, ?, 'https://test.supabase.co', ?),
            ('RAW_MATERIAL_STORE', 'dev-holder', 'Store PC', 1, 0, ?, 'https://test.supabase.co', ?)`, NOW, NOW, NOW, NOW);
  run(pc, "INSERT INTO inventory_units (id, code, name, created_at, updated_at) VALUES ('u-kg', 'KG', 'Kilogram', ?, ?)", NOW, NOW);
  run(pc, "INSERT INTO inventory_categories (id, category_code, name, created_at, updated_at) VALUES ('c-1', 'C1', 'Dana', ?, ?)", NOW, NOW);
  run(pc, `INSERT INTO inventory_items (id, item_code, category_id, display_name, signature_hash, default_unit_id, created_at, updated_at)
           VALUES (?, 'RM-001017', 'c-1', 'DANA D GREY', 'sig-1', 'u-kg', ?, ?)`, ITEM, NOW, NOW);
  return pc;
}

/** The cloud's log, as a pull reads it: in order, by position. */
class Log implements SyncPullTransport {
  private readonly changes: SyncChange[] = [];

  add(...envelopes: SyncEnvelope[]): void {
    for (const envelope of envelopes) this.changes.push({ seq: this.changes.length + 1, envelope });
  }

  async fetchChanges(afterSeq: number, limit: number): Promise<SyncChange[]> {
    return this.changes.filter((change) => change.seq > afterSeq).slice(0, limit);
  }
}

/** What the holder has marked, built by the real builder and queued as envelopes. */
function sent(holder: Pc): SyncEnvelope[] {
  buildLeasedRecordRevisions(holder.db.db, NOW);
  const rows = holder.db.db
    .prepare("SELECT aggregate_type, aggregate_id, dedupe_key, payload_json FROM sync_outbox WHERE status = 'PENDING' ORDER BY rowid")
    .all() as Array<Record<string, unknown>>;
  run(holder, "UPDATE sync_outbox SET status = 'SYNCED' WHERE status = 'PENDING'");
  return rows.map((row) => ({
    dedupeKey: String(row.dedupe_key),
    aggregateType: String(row.aggregate_type),
    aggregateId: String(row.aggregate_id),
    operation: "INSERT" as const,
    payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    originDeviceId: "dev-holder",
    createdAt: NOW,
  }));
}

/** A stock movement as the wire carries it, through the sender's own payload rule. */
function movement(eventId: string, eventType: string, quantity: number): SyncEnvelope {
  const payload = stockEventPayloadOf({ id: eventId, item_id: ITEM, event_type: eventType, quantity, unit_id: "u-kg", created_at: NOW });
  assert.ok(payload);
  return {
    dedupeKey: `STOCK_EVENT:${eventId}`, aggregateType: "STOCK_EVENT", aggregateId: eventId, operation: "INSERT",
    payload: payload as unknown as Record<string, unknown>, originDeviceId: "dev-holder", createdAt: NOW,
  };
}

/** The old form: the store PC deletes the row, and the revision goes out with no body. */
function oldStyleDeletion(holder: Pc): SyncEnvelope[] {
  run(holder, "DELETE FROM inventory_items WHERE id = ?", ITEM);
  return sent(holder);
}

const pullOn = (pc: Pc, log: Log, nowMs = NOW_MS) => new SyncPull(pc.db.db, log, { now: () => nowMs }).runOnce();
const balance = (pc: Pc) => Number(one(pc, "SELECT quantity_on_hand AS q FROM inventory_stock_balances WHERE item_id = ?", ITEM)?.q ?? 0);
const movements = (pc: Pc) => Number(one(pc, "SELECT COUNT(*) AS n FROM inventory_stock_events WHERE item_id = ?", ITEM)?.n);
const item = (pc: Pc) => one(pc, "SELECT status, removed_at, signature_hash FROM inventory_items WHERE id = ?", ITEM);
const parkedReasons = (pc: Pc) =>
  (pc.db.db.prepare("SELECT reason FROM sync_inbox_parked ORDER BY seq").all() as Array<{ reason: string }>).map((row) => row.reason);

function withPcs(run: (holder: Pc, reader: Pc, log: Log) => Promise<void>): Promise<void> {
  const holder = openHolder();
  const reader = openPc("reader");
  return run(holder, reader, new Log()).finally(() => { holder.close(); reader.close(); });
}

test("the production case: a removal of a material still holding stock here waits on its stock, not on its history", async () => {
  await withPcs(async (holder, reader, log) => {
    log.add(...sent(holder), movement("e-in", "RECEIVE", 100), movement("e-out", "CONSUME", -19), ...oldStyleDeletion(holder));

    await pullOn(reader, log);

    assert.deepEqual(parkedReasons(reader), [`STILL_HOLDS_STOCK:INVENTORY_ITEM:${ITEM}`]);
    assert.equal(balance(reader), 81);
    assert.equal(movements(reader), 2, "the ledger is not touched");
    assert.equal(item(reader)?.removed_at, null);
    const wait = waitingSummary(reader.db.db, NOW_MS).entries[0];
    assert.deepEqual(wait?.cause, { kind: "HOLDS_STOCK", id: ITEM });
    assert.equal(wait?.itemId, ITEM, "the stock screen can mark the row it leaves incomplete");
  });
});

test("a compensating movement reaching zero lets the waiting removal through in the same pull, keeping every movement", async () => {
  await withPcs(async (holder, reader, log) => {
    log.add(...sent(holder), movement("e-in", "RECEIVE", 81), ...oldStyleDeletion(holder));
    await pullOn(reader, log);
    assert.equal(parkedSummary(reader.db.db).count, 1);

    log.add(movement("e-fix", "ADJUST", -81));
    const pulled = await pullOn(reader, log);

    assert.equal(pulled.parked, 0, "the arrival re-examined it, with no timer to wait out");
    assert.equal(balance(reader), 0);
    assert.equal(movements(reader), 2, "both movements stay: the trail says where the stock went");
    assert.equal(item(reader)?.status, "INACTIVE");
    assert.ok(item(reader)?.removed_at, "the row stays, marked, because history names it");
  });
});

test("the arrival wins over any stored retry time: a date nine days off does not hold it back", async () => {
  await withPcs(async (holder, reader, log) => {
    log.add(...sent(holder), movement("e-in", "RECEIVE", 81), ...oldStyleDeletion(holder));
    await pullOn(reader, log);
    run(reader, "UPDATE sync_inbox_parked SET next_try_at = ?", NOW_MS + NINE_DAYS_MS);

    log.add(movement("e-fix", "ADJUST", -81));
    const pulled = await pullOn(reader, log);

    assert.equal(pulled.parked, 0);
    assert.ok(item(reader)?.removed_at);
  });
});

test("a stored retry time beyond the longest wait is not honoured, even with nothing arriving", async () => {
  await withPcs(async (holder, reader, log) => {
    log.add(...sent(holder));
    await pullOn(reader, log);
    // A waiting record whose wait is keyed: only its own arrival, or its time, tries it.
    log.add(movement("e-orphan", "RECEIVE", 5));
    run(reader, "DELETE FROM inventory_items WHERE id = ?", ITEM);
    await pullOn(reader, log);
    assert.deepEqual(parkedReasons(reader), [`UNKNOWN_INVENTORY_ITEM:${ITEM}`]);
    run(reader, "UPDATE sync_inbox_parked SET next_try_at = ?, attempts = 1", NOW_MS + NINE_DAYS_MS);

    await pullOn(reader, log);

    const attempts = Number(one(reader, "SELECT attempts AS n FROM sync_inbox_parked")?.n);
    assert.equal(attempts, 2, "tried now, not in nine days");
    const next = Number(one(reader, "SELECT next_try_at AS t FROM sync_inbox_parked")?.t);
    assert.ok(next <= NOW_MS + 900_000, "and it comes back inside the longest wait");
  });
});

test("an old deletion of a material nothing names still deletes the row", async () => {
  await withPcs(async (holder, reader, log) => {
    log.add(...sent(holder), ...oldStyleDeletion(holder));

    const pulled = await pullOn(reader, log);

    assert.equal(pulled.parked, 0);
    assert.equal(item(reader), undefined, "no history, so nothing to keep");
  });
});

test("a marked removal is an ordinary revision: it carries the row, and the row stays on the reader", async () => {
  await withPcs(async (holder, reader, log) => {
    log.add(...sent(holder));
    await pullOn(reader, log);

    markItemRemoved(holder.db.db, ITEM, NOW, "owner");
    const removal = sent(holder);
    assert.equal(removal.length, 1);
    assert.equal(removal[0]?.payload.deleted, false, "never a deletion");
    log.add(...removal);
    await pullOn(reader, log);

    assert.deepEqual({ ...item(reader) }, { status: "INACTIVE", removed_at: NOW, signature_hash: `removed:${ITEM}` });
  });
});

test("a marked removal that overtakes the last movement waits for it, then a late movement still lands", async () => {
  await withPcs(async (holder, reader, log) => {
    log.add(...sent(holder), movement("e-in", "RECEIVE", 7));
    await pullOn(reader, log);

    // Master data goes first in a pass, so the removal can reach the log before the movement that emptied it.
    markItemRemoved(holder.db.db, ITEM, NOW, "owner");
    log.add(...sent(holder));
    await pullOn(reader, log);
    assert.deepEqual(parkedReasons(reader), [`STILL_HOLDS_STOCK:INVENTORY_ITEM:${ITEM}`]);
    assert.equal(item(reader)?.removed_at, null);

    log.add(movement("e-out", "CONSUME", -7));
    await pullOn(reader, log);

    assert.equal(parkedSummary(reader.db.db).count, 0);
    assert.equal(item(reader)?.removed_at, NOW);
    assert.equal(balance(reader), 0);

    log.add(movement("e-late", "ADJUST", 0.5));
    await pullOn(reader, log);
    assert.equal(movements(reader), 3, "a removed material still takes the history it is owed");
  });
});

test("a newer revision supersedes a waiting deletion, which then leaves the park as a duplicate", async () => {
  await withPcs(async (holder, reader, log) => {
    log.add(...sent(holder), movement("e-in", "RECEIVE", 81), ...oldStyleDeletion(holder));
    await pullOn(reader, log);
    assert.equal(parkedSummary(reader.db.db).count, 1);

    // The material comes back at a later revision: the store PC restored it.
    run(holder, `INSERT INTO inventory_items (id, item_code, category_id, display_name, signature_hash, default_unit_id, created_at, updated_at)
                 VALUES (?, 'RM-001017', 'c-1', 'DANA D GREY', 'sig-1', 'u-kg', ?, ?)`, ITEM, NOW, NOW);
    log.add(...sent(holder));
    await pullOn(reader, log);

    assert.equal(parkedSummary(reader.db.db).count, 0);
    assert.equal(item(reader)?.removed_at, null, "it is back, and it was never removed here");
    assert.equal(balance(reader), 81);
  });
});

test("two computers rebuilding from the same log end the same", async () => {
  const holder = openHolder();
  const first = openPc("first");
  const second = openPc("second");
  try {
    const log = new Log();
    log.add(...sent(holder), movement("e-in", "RECEIVE", 42), ...oldStyleDeletion(holder), movement("e-fix", "ADJUST", -42));

    await pullOn(first, log);
    await pullOn(second, log);

    for (const pc of [first, second]) {
      assert.equal(parkedSummary(pc.db.db).count, 0);
      assert.equal(balance(pc), 0);
      assert.equal(movements(pc), 2);
      assert.equal(item(pc)?.signature_hash, `removed:${ITEM}`);
    }
  } finally {
    holder.close();
    first.close();
    second.close();
  }
});
