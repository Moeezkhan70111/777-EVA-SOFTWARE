import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddMachineUseCase, CancelGatepassUseCase, CreateGatepassUseCase, InMemoryEventBus } from "@erp/application";
import { businessDateOf } from "@erp/domain";
import { SqliteDatabase, buildCartonStockEvents } from "@erp/data";
import { applyEnvelope } from "./applyEnvelope.js";
import type { SyncEnvelope } from "./contract.js";

// THE CARTON FIGURE MOVES ON ANOTHER COMPUTER EXACTLY AS ON THE ONE THAT HOLDS THE CARTON LEASE
// (docs/42), end to end: PC A makes Manual Production, gatepasses, cancels and voids the ordinary way,
// its capture trigger marks each movement, the real builder queues them, and the real applier writes
// them on PC B. PC B has no machine program, no gatepass and no Manual Production entry -- only the
// product -- and still shows A's figure at every step.

const SCHEMA = path.resolve(import.meta.dirname, "../../data/src/local-schema.sql");
const NOW = "2026-11-03T10:00:00.000Z";
const STORE = "factory-777";
const idGen = { nextId: () => crypto.randomUUID() };

interface Pc {
  readonly db: SqliteDatabase;
  readonly close: () => void;
}

function openPc(name: string): Pc {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `erp-cartons-${name}-`));
  const db = new SqliteDatabase({ dbPath: path.join(dir, "erp.db"), schemaPath: SCHEMA });
  db.setNumberBlock(name === "a" ? 1 : 2, "test");
  db.ensureOperationalContext({
    factoryId: STORE, factoryCode: "F777", factoryName: "777",
    workstationId: `ws-${name}`, workstationCode: `WS-${name}`, workstationName: name,
    deviceId: `dev-${name}`, deviceName: name, appVersion: "1.0.0",
  });
  return { db, close: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const addProduct = (pc: Pc) =>
  pc.db.createProduct({ article: "SK6", size: "7/10", sellingPrice: 550, machineRate: 70, packingRate: 30, colors: ["RED"], status: "ACTIVE" });

/** PC A: holds the carton lease, has a machine with its contractors and a customer. */
async function openWriter() {
  const pc = openPc("a");
  pc.db.db.prepare(
    `INSERT INTO sync_domain_leases (domain, holder_device_id, holder_label, epoch, barrier_seq, granted_at, project_key, fetched_at)
     VALUES ('CARTON_STOCK', 'dev-a', 'Production -- Aslam', 1, 0, ?, 'https://test.supabase.co', ?)`
  ).run(NOW, NOW);
  addProduct(pc);
  const contractor = (name: string, mobile: string) => pc.db.createParty({ partyName: name, partyType: "CONTRACTOR", city: "Lahore", mobileNumber: mobile, status: "ACTIVE" });
  const aslam = contractor("ASLAM", "0300-1111111");
  const babar = contractor("BABAR", "0300-2222222");
  const customer = pc.db.createParty({ partyName: "MAMA CHAPPAL", partyType: "CUSTOMER", city: "Lahore", mobileNumber: "0300-3333333", status: "ACTIVE" });
  const deps = { txManager: pc.db, repo: pc.db, eventPublisher: new InMemoryEventBus(), idGenerator: idGen };
  const machineId = (await new AddMachineUseCase(deps).execute({ name: "Machine 1", contractorPartyId: aslam, packingContractorPartyId: babar, actor: "admin" })).machineId!;
  const sk6 = (pc.db.db.prepare("SELECT id FROM article_sizes WHERE article = 'SK6'").get() as { id: string }).id;
  return {
    pc, aslam,
    produce: (dozens: string) =>
      pc.db.recordManualProduction({ requestId: crypto.randomUUID(), machineId, articleSizeId: sk6, color: "RED", dozens, storeLocationId: STORE, createdBy: "aslam" }).entry,
    gatepass: (quantity: number) =>
      new CreateGatepassUseCase({ txManager: pc.db, repo: pc.db, idGenerator: idGen }).execute({
        partyId: customer, lines: [{ productVariantId: red(pc), quantity }], actor: "clerk",
      }),
    cancel: (gatepassId: string) =>
      new CancelGatepassUseCase({ txManager: pc.db, repo: pc.db, idGenerator: idGen }).execute({ gatepassId, reason: "wrong party", actor: "clerk" }),
  };
}

const red = (pc: Pc): string => (pc.db.db.prepare("SELECT id FROM product_variants WHERE article = 'SK6' AND color = 'RED'").get() as { id: string }).id;

/** What the store shows for SK6 RED: Current Stock, as every screen reads it. */
const inStore = (pc: Pc): number => pc.db.listInventory("SK6").find((row) => row.color === "RED")?.storeQuantity ?? 0;
const onHand = (pc: Pc): number =>
  Number((pc.db.db.prepare("SELECT COALESCE(SUM(quantity_on_hand), 0) AS n FROM stock_projection_by_variant").get() as { n: number }).n);

/** Every carton movement A has queued since the last call, in the order queued. */
function sent(writer: Pc): SyncEnvelope[] {
  buildCartonStockEvents(writer.db.db, NOW);
  const rows = writer.db.db
    .prepare("SELECT aggregate_type, aggregate_id, dedupe_key, payload_json FROM sync_outbox WHERE status = 'PENDING' AND aggregate_type = 'CARTON_STOCK_EVENT' ORDER BY rowid")
    .all() as Array<Record<string, unknown>>;
  writer.db.db.prepare("UPDATE sync_outbox SET status = 'SYNCED' WHERE status = 'PENDING' AND aggregate_type = 'CARTON_STOCK_EVENT'").run();
  return rows.map((row) => ({
    dedupeKey: String(row.dedupe_key),
    aggregateType: String(row.aggregate_type),
    aggregateId: String(row.aggregate_id),
    operation: "INSERT",
    payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    originDeviceId: "dev-a",
    createdAt: NOW,
  }));
}

/** Delivers everything A queued to B; every movement must apply. */
function sync(writer: Pc, reader: Pc): SyncEnvelope[] {
  const envelopes = sent(writer);
  for (const envelope of envelopes) assert.equal(applyEnvelope(reader.db.db, envelope, NOW).status, "APPLIED", envelope.dedupeKey);
  return envelopes;
}

async function withPcs(work: (a: Awaited<ReturnType<typeof openWriter>>, b: Pc) => Promise<void>): Promise<void> {
  const a = await openWriter();
  const b = openPc("b");
  try {
    await work(a, b);
  } finally {
    a.pc.close();
    b.close();
  }
}

test("A produces, B rises; A gatepasses, B falls; A cancels, B comes back; A voids, B falls by exactly its cartons", async () => {
  await withPcs(async (a, b) => {
    addProduct(b);
    const entry = a.produce("10");
    sync(a.pc, b);
    assert.deepEqual([inStore(b), onHand(b)], [20, 20], "B shows A's Manual Production");

    const made = await a.gatepass(5);
    assert.equal(made.accepted, true, made.reason);
    sync(a.pc, b);
    assert.deepEqual([inStore(a.pc), inStore(b)], [15, 15], "the gatepass took them out on both");

    await a.cancel(String(made.gatepassId));
    sync(a.pc, b);
    assert.deepEqual([inStore(a.pc), inStore(b)], [20, 20], "the cancel put them back on both");

    const day = { fromDate: businessDateOf(new Date().toISOString()), toDate: businessDateOf(new Date().toISOString()) };
    const owedBefore = a.pc.db.getContractorLedger(a.aslam, day).earnedPaisa;
    a.pc.db.voidManualProduction({ entryId: entry.id, reason: "entered on the wrong machine", voidedBy: "admin", mayVoidEarlierDays: false });
    sync(a.pc, b);
    assert.deepEqual([inStore(a.pc), inStore(b), onHand(b)], [0, 0, 0], "the void took its 20 cartons out on both");
    assert.ok(owedBefore > 0);
    assert.equal(a.pc.db.getContractorLedger(a.aslam, day).earnedPaisa, 0, "and withdrew the entry from the ledger where the program lives");

    const there = b.db.db.prepare("SELECT event_type, origin_device_id, gatepass_id IS NOT NULL AS names_gatepass FROM carton_stock_events ORDER BY created_at, rowid").all();
    assert.deepEqual(there.map((row) => ({ ...row })), [
      { event_type: "MANUAL_PRODUCE", origin_device_id: "dev-a", names_gatepass: 0 },
      { event_type: "GATEPASS_ISSUE", origin_device_id: "dev-a", names_gatepass: 1 },
      { event_type: "GATEPASS_CANCEL", origin_device_id: "dev-a", names_gatepass: 1 },
      { event_type: "MANUAL_PRODUCTION_VOID", origin_device_id: "dev-a", names_gatepass: 0 },
    ]);
    assert.equal(Number((b.db.db.prepare("SELECT COUNT(*) AS n FROM gatepasses").get() as { n: number }).n), 0, "the gatepass it names is a reference, never needed");
    assert.equal(Number((b.db.db.prepare("SELECT COUNT(*) AS n FROM sync_dirty_records WHERE aggregate_type = 'CARTON_STOCK_EVENT'").get() as { n: number }).n), 0, "received, not B's to send");
  });
});

test("a movement delivered twice moves the figure once, and A's own movements come back to it as duplicates", async () => {
  await withPcs(async (a, b) => {
    addProduct(b);
    a.produce("10");
    const [produced] = sync(a.pc, b);
    assert.ok(produced);
    assert.equal(applyEnvelope(b.db.db, produced, NOW).status, "DUPLICATE");
    assert.equal(inStore(b), 20);
    assert.equal(applyEnvelope(a.pc.db.db, produced, NOW).status, "DUPLICATE", "pulled back by its own writer");
    assert.equal(inStore(a.pc), 20);
  });
});

test("a movement that would take B below zero waits with its reason, writes nothing, and applies once its cause arrives", async () => {
  await withPcs(async (a, b) => {
    addProduct(b);
    a.produce("10");
    await a.gatepass(5);
    const [produced, issued] = sent(a.pc);
    assert.ok(produced && issued);

    const early = applyEnvelope(b.db.db, issued, NOW);
    assert.equal(early.status, "REJECTED");
    assert.equal(early.permanent, false, "parked, never clamped and never refused for good");
    assert.equal(early.reason, `CARTON_STOCK_WOULD_GO_NEGATIVE:${red(b)}`);
    assert.equal(Number((b.db.db.prepare("SELECT COUNT(*) AS n FROM carton_stock_events").get() as { n: number }).n), 0, "nothing of it was written");

    assert.equal(applyEnvelope(b.db.db, produced, NOW).status, "APPLIED");
    assert.equal(applyEnvelope(b.db.db, issued, NOW).status, "APPLIED");
    assert.equal(inStore(b), 15);
  });
});

test("a movement waits for its product, and only for its product", async () => {
  await withPcs(async (a, b) => {
    a.produce("1");
    const [produced] = sent(a.pc);
    assert.ok(produced);
    const waiting = applyEnvelope(b.db.db, produced, NOW);
    assert.equal(waiting.status, "REJECTED");
    assert.equal(waiting.permanent, false);
    assert.match(String(waiting.reason), /^UNKNOWN_PRODUCT_VARIANT:/);
    addProduct(b);
    assert.equal(applyEnvelope(b.db.db, produced, NOW).status, "APPLIED", "the Manual Production entry it names is never waited for");
    assert.equal(inStore(b), 2);
  });
});

test("another movement under a known id is refused for good, and a broken one is never applied", async () => {
  await withPcs(async (a, b) => {
    addProduct(b);
    a.produce("10");
    const [produced] = sync(a.pc, b);
    assert.ok(produced);
    const changed = { ...produced, dedupeKey: `${produced.dedupeKey}:x`, payload: { ...produced.payload, quantity: 30, balanceDelta: 30 } };
    const conflict = applyEnvelope(b.db.db, changed, NOW);
    assert.equal(conflict.status, "REJECTED");
    assert.equal(conflict.permanent, true);
    assert.match(String(conflict.reason), /^CARTON_STOCK_EVENT_IDENTITY_CONFLICT:/);

    const broken = { ...produced, dedupeKey: "CARTON_STOCK_EVENT:broken", aggregateId: "broken", payload: { ...produced.payload, eventId: "broken", balanceDelta: -20 } };
    assert.equal(applyEnvelope(b.db.db, broken, NOW).reason, "PAYLOAD_INCOMPLETE", "a production that takes cartons out is not a production");
    assert.equal(inStore(b), 20);
  });
});
