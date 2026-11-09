import test from "node:test";
import { activateCartonCloudForTest } from "@erp/data/dist/testing/cartonCloud.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddMachineUseCase, InMemoryEventBus } from "@erp/application";
import { SqliteDatabase, buildCartonStockEvents, resendCartonMovementsRefusedForLease } from "@erp/data";
import type { SyncEnvelope } from "./contract.js";
import { OutboxDrain } from "./drain.js";
import { leaseWriteDecision } from "./leases.js";
import { outboxSummary } from "./outboxQueue.js";
import { parkedSummary } from "./parking.js";
import { SyncPull } from "./pull.js";
import type { SyncAck, SyncChange, SyncPullTransport, SyncTransport } from "./transport.js";
import { waitCause, waitingSummary } from "./waiting.js";

// EVERY COMPUTER SHOWS THE SAME CARTON STOCK (docs/42), three computers end to end. Real writers, real
// capture, real builder, real outbox and drain, real pull and applier, real lease decision. Only the
// cloud is a stand-in, and it holds to the two rules push_carton_stock_event holds to: one id is one
// movement for good, and only the current lease holder at the current epoch is accepted.
//
// Convergence is read through each computer's own reconciliation: the same fingerprint, the same
// figures, nothing waiting and no difference.

const SCHEMA = path.resolve(import.meta.dirname, "../../data/src/local-schema.sql");
const PROJECT = "https://test.supabase.co";
const STORE = "factory-777";
const CARTONS_LEASE = "CARTON_STOCK";
const idGen = { nextId: () => crypto.randomUUID() };
// A day ahead of the wall clock: a product is dated when it was made, and the queue will not send it early.
const clock = { ms: Date.now() + 86_400_000 };
const nowIso = () => new Date(clock.ms).toISOString();
/** Past every retry wait, so a test does not depend on backoff. */
const passTime = () => { clock.ms += 3_600_000; };

/** The cloud: one log, one lease, and the two rules. */
class Cloud {
  readonly log: SyncChange[] = [];
  lease = { holder: "dev-a", epoch: 1 };
  private readonly unreachable = new Set<string>();

  offline(device: string): void { this.unreachable.add(device); }
  online(device: string): void { this.unreachable.delete(device); }
  /** A later grant: the epoch moves, and the barrier is where the log stands. */
  grant(holder: string): number {
    this.lease = { holder, epoch: this.lease.epoch + 1 };
    return this.log.length;
  }
  /** At-least-once: the same event offered again at a later position. */
  deliverAgain(): void {
    for (const change of [...this.log]) this.log.push({ seq: this.log.length + 1, envelope: change.envelope });
  }
  movements(): SyncEnvelope[] {
    return this.log.map((change) => change.envelope).filter((envelope) => envelope.aggregateType === "CARTON_STOCK_EVENT");
  }

  private accept(envelope: SyncEnvelope, device: string): SyncAck {
    if (envelope.aggregateType === "CARTON_STOCK_EVENT" && (this.lease.holder !== device || envelope.leaseEpoch !== this.lease.epoch)) {
      return { dedupeKey: envelope.dedupeKey, accepted: false, reason: "NOT_LEASE_HOLDER", failure: "REFUSED" };
    }
    if (!this.log.some((change) => change.envelope.dedupeKey === envelope.dedupeKey)) {
      this.log.push({ seq: this.log.length + 1, envelope: { ...envelope, originDeviceId: device } });
    }
    return { dedupeKey: envelope.dedupeKey, accepted: true };
  }

  as(device: string): SyncTransport & SyncPullTransport {
    return {
      send: async (envelopes) => {
        if (this.unreachable.has(device)) throw new Error("the cloud could not be reached");
        return envelopes.map((envelope) => this.accept(envelope, device));
      },
      fetchChanges: async (afterSeq, limit) => {
        if (this.unreachable.has(device)) throw new Error("the cloud could not be reached");
        return this.log.filter((change) => change.seq > afterSeq).slice(0, limit);
      },
    };
  }
}

interface Pc {
  readonly name: string;
  readonly device: string;
  readonly dbPath: string;
  db: SqliteDatabase;
}

const openDb = (dbPath: string) => new SqliteDatabase({ dbPath, schemaPath: SCHEMA });

function openPc(name: string, block: number): Pc {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `erp-converge-${name}-`));
  const dbPath = path.join(dir, "erp.db");
  const db = openDb(dbPath);
  const device = `dev-${name}`;
  db.setNumberBlock(block, "test");
  db.ensureOperationalContext({
    factoryId: STORE, factoryCode: "F777", factoryName: "777",
    workstationId: `ws-${name}`, workstationCode: `WS-${name}`, workstationName: name,
    deviceId: device, deviceName: name, appVersion: "1.0.0",
  });
  db.db.prepare("INSERT OR REPLACE INTO app_settings (setting_key, setting_value, updated_at) VALUES ('device.id', ?, ?)").run(device, nowIso());
  // After go-live: Carton Cloud active from the start, through the real activation (stockProtection.ts).
  activateCartonCloudForTest(db.db, PROJECT);
  return { name, device, dbPath, db };
}

/** What this computer last heard about the carton lease. */
function hearLease(pc: Pc, cloud: Cloud, barrier = 0): void {
  pc.db.db.prepare(
    `INSERT INTO sync_domain_leases (domain, holder_device_id, holder_label, epoch, barrier_seq, granted_at, project_key, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (domain) DO UPDATE SET holder_device_id = excluded.holder_device_id, holder_label = excluded.holder_label,
       epoch = excluded.epoch, barrier_seq = excluded.barrier_seq, project_key = excluded.project_key, fetched_at = excluded.fetched_at`
  ).run(CARTONS_LEASE, cloud.lease.holder, cloud.lease.holder, cloud.lease.epoch, barrier, nowIso(), PROJECT, nowIso());
}

const addProduct = (pc: Pc) =>
  pc.db.createProduct({ article: "SK6", size: "7/10", sellingPrice: 550, machineRate: 70, packingRate: 30, colors: ["RED"], createdBy: "owner" } as never);
const skuId = (pc: Pc) => (pc.db.db.prepare("SELECT id FROM article_sizes WHERE article = 'SK6'").get() as { id: string }).id;

async function addMachine(pc: Pc): Promise<string> {
  const contractor = (name: string, mobile: string) => pc.db.createParty({ partyName: name, partyType: "CONTRACTOR", city: "Lahore", mobileNumber: mobile, status: "ACTIVE" });
  const deps = { txManager: pc.db, repo: pc.db, eventPublisher: new InMemoryEventBus(), idGenerator: idGen };
  const added = await new AddMachineUseCase(deps).execute({ name: "Machine 1", contractorPartyId: contractor("ASLAM", "0300-1111111"), packingContractorPartyId: contractor("BABAR", "0300-2222222"), actor: "admin" });
  return added.machineId ?? "";
}

const produce = (pc: Pc, machineId: string, dozens = "10") =>
  pc.db.recordManualProduction({ requestId: crypto.randomUUID(), machineId, articleSizeId: skuId(pc), color: "RED", dozens, storeLocationId: STORE, createdBy: "aslam" });

const adjust = (pc: Pc, direction: "IN" | "OUT", cartons: number, requestId: string = crypto.randomUUID()) =>
  pc.db.adjustCartonStock({ requestId, articleSizeId: skuId(pc), color: "RED", direction, cartons, reason: "counted in the store", adjustedBy: "owner", storeLocationId: STORE });

/** One sync pass, as cloudSyncPass does it: resend, build, send, read. */
async function pass(pc: Pc, cloud: Cloud): Promise<void> {
  resendCartonMovementsRefusedForLease(pc.db.db, nowIso());
  buildCartonStockEvents(pc.db.db, nowIso());
  const transport = cloud.as(pc.device);
  const retryPolicy = { maxAttempts: 2, baseBackoffMs: 1, maxBackoffMs: 1, staleInFlightMs: 120_000 };
  await new OutboxDrain(pc.db.db, transport, { deviceId: pc.device, now: nowIso, retryPolicy }).runOnce();
  await new SyncPull(pc.db.db, transport, { now: () => clock.ms, project: PROJECT }).runOnce();
  passTime();
}

const passAll = async (cloud: Cloud, ...pcs: Pc[]) => {
  // Twice: everyone sends, then everyone reads what the others sent.
  for (const pc of pcs) await pass(pc, cloud);
  for (const pc of pcs) await pass(pc, cloud);
};

const inStore = (pc: Pc) => pc.db.cartonStockReconciliation().rows.reduce((sum, row) => sum + row.storeFigure, 0);
const history = (pc: Pc) => pc.db.cartonStockReconciliation().fingerprint;

function assertConverged(cartons: number, movements: number, ...pcs: Pc[]): void {
  const fingerprints = new Set(pcs.map(history));
  assert.equal(fingerprints.size, 1, `the same movement history everywhere: ${pcs.map((pc) => `${pc.name}=${history(pc)}`).join(" ")}`);
  for (const pc of pcs) {
    const seen = pc.db.cartonStockReconciliation();
    assert.equal(inStore(pc), cartons, `${pc.name} holds ${cartons} cartons`);
    assert.equal(seen.movements, movements, `${pc.name} has ${movements} movements`);
    assert.equal(seen.differences, 0, `${pc.name} has no figure a movement does not explain`);
    assert.equal(seen.waiting, 0, `${pc.name} has nothing waiting`);
    assert.equal(parkedSummary(pc.db.db).count, 0, `${pc.name} has nothing parked`);
  }
}

interface Office {
  readonly cloud: Cloud;
  readonly a: Pc;
  readonly b: Pc;
  readonly c: Pc;
  readonly machine: string;
}

/** A holds the lease, with a product and a machine. B has its product for adjusting. C has nothing. */
async function withOffice(work: (office: Office) => Promise<void>): Promise<void> {
  const cloud = new Cloud();
  const a = openPc("a", 1);
  const b = openPc("b", 2);
  const c = openPc("c", 3);
  const pcs = [a, b, c];
  try {
    for (const pc of pcs) {
      await new SyncPull(pc.db.db, cloud.as(pc.device), { now: () => clock.ms, project: PROJECT }).runOnce();
      hearLease(pc, cloud);
    }
    addProduct(a);
    const machine = await addMachine(a);
    await work({ cloud, a, b, c, machine });
  } finally {
    for (const pc of pcs) {
      pc.db.close();
      fs.rmSync(path.dirname(pc.dbPath), { recursive: true, force: true });
    }
  }
}

const mayWrite = (pc: Pc) => leaseWriteDecision(pc.db.db, { domain: CARTONS_LEASE as never, deviceId: pc.device, syncConfigured: true });

// ─── G1: the product travels with the movement ───

test("Manual Production on A reaches B and C, who never had the product: it arrives first, and nothing waits", async () => {
  await withOffice(async ({ cloud, a, b, c, machine }) => {
    assert.equal(b.db.db.prepare("SELECT COUNT(1) AS n FROM product_variants WHERE article = 'SK6'").get()?.n, 0);

    produce(a, machine);
    await passAll(cloud, a, b, c);

    const types = cloud.log.map((change) => change.envelope.aggregateType);
    assert.ok(types.indexOf("PRODUCT_VARIANT") < types.indexOf("CARTON_STOCK_EVENT"), "the product goes ahead of its movement");
    assert.equal(c.db.db.prepare("SELECT COUNT(1) AS n FROM product_variants WHERE article = 'SK6' AND color = 'RED'").get()?.n, 1);
    assertConverged(20, 1, a, b, c);
  });
});

test("the product is queued once, however many movements name it", async () => {
  await withOffice(async ({ cloud, a, b, machine }) => {
    produce(a, machine);
    produce(a, machine);
    await passAll(cloud, a, b);
    assert.equal(cloud.log.filter((change) => change.envelope.aggregateType === "PRODUCT_VARIANT").length, 1);
    assert.equal(cloud.movements().length, 2);
  });
});

test("the product and its movement commit together: a movement refused queues no product", async () => {
  await withOffice(async ({ a }) => {
    addProduct(a);
    assert.throws(() => adjust(a, "OUT", 5), /does not hold/);
    assert.equal(outboxSummary(a.db.db, { pushableTypes: ["PRODUCT_VARIANT"], nowIso: nowIso() }).counts.PENDING, 0);
  });
});

// ─── G2: adjustments travel ───

test("an adjustment reaches every computer, with who made it and why", async () => {
  await withOffice(async ({ cloud, a, b, c, machine }) => {
    produce(a, machine);
    adjust(a, "OUT", 3);
    adjust(a, "IN", 1);
    await passAll(cloud, a, b, c);

    assertConverged(18, 3, a, b, c);
    const row = c.db.db.prepare("SELECT created_by, reason, origin_device_id FROM carton_stock_events WHERE event_type = 'CARTON_ADJUST_OUT'").get() as Record<string, unknown>;
    assert.deepEqual({ ...row }, { created_by: "owner", reason: "counted in the store", origin_device_id: "dev-a" });
    assert.equal(c.db.cartonStockReconciliation().rows[0]?.adjusted, -2);
  });
});

test("a retried adjustment with the same request id moves the figure once, here and everywhere", async () => {
  await withOffice(async ({ cloud, a, b, machine }) => {
    produce(a, machine);
    const request = crypto.randomUUID();
    assert.equal(adjust(a, "OUT", 4, request).duplicate, false);
    assert.equal(adjust(a, "OUT", 4, request).duplicate, true);
    await passAll(cloud, a, b);
    assertConverged(16, 2, a, b);
  });
});

test("every movement type converges: produce, void, gatepass-free adjustments", async () => {
  await withOffice(async ({ cloud, a, b, c, machine }) => {
    const entry = produce(a, machine).entry;
    produce(a, machine);
    a.db.voidManualProduction({ entryId: entry?.id ?? "", reason: "entered twice", voidedBy: "owner", mayVoidEarlierDays: true });
    adjust(a, "OUT", 2);
    await passAll(cloud, a, b, c);
    assertConverged(18, 4, a, b, c);
    assert.equal(b.db.cartonStockReconciliation().rows[0]?.produced, 20);
  });
});

// ─── G8: duplicates, offline, restart ───

test("every event delivered again moves nothing on anyone", async () => {
  await withOffice(async ({ cloud, a, b, c, machine }) => {
    produce(a, machine);
    adjust(a, "OUT", 1);
    await passAll(cloud, a, b, c);
    cloud.deliverAgain();
    await passAll(cloud, a, b, c);
    assertConverged(19, 2, a, b, c);
  });
});

test("work done offline stays here, then arrives once on reconnecting", async () => {
  await withOffice(async ({ cloud, a, b, c, machine }) => {
    cloud.offline(a.device);
    produce(a, machine);
    adjust(a, "OUT", 5);
    await pass(a, cloud);
    await pass(a, cloud);

    assert.equal(inStore(a), 15, "the store keeps working");
    assert.ok(a.db.cartonStockReconciliation().unsent >= 2, "and it says what has not gone yet");
    assert.equal(cloud.movements().length, 0);

    cloud.online(a.device);
    await passAll(cloud, a, b, c);
    assert.equal(a.db.cartonStockReconciliation().unsent, 0);
    assertConverged(15, 2, a, b, c);
  });
});

test("a reader offline catches up when it comes back", async () => {
  await withOffice(async ({ cloud, a, b, c, machine }) => {
    cloud.offline(c.device);
    produce(a, machine);
    await passAll(cloud, a, b, c);
    assert.equal(inStore(c), 0);
    cloud.online(c.device);
    await passAll(cloud, a, b, c);
    assertConverged(20, 1, a, b, c);
  });
});

test("a computer restarted after missing events catches up from where it stopped, counting nothing twice", async () => {
  await withOffice(async ({ cloud, a, b, c, machine }) => {
    produce(a, machine);
    await passAll(cloud, a, b, c);

    c.db.close();
    adjust(a, "OUT", 7);
    produce(a, machine);
    await passAll(cloud, a, b);
    c.db = openDb(c.dbPath);
    assert.equal(inStore(c), 20, "what it had survives the restart");

    await passAll(cloud, a, b, c);
    assertConverged(33, 3, a, b, c);
  });
});

// ─── G8: the lease ───

test("a second writer is refused before anything is written, naming who writes", async () => {
  await withOffice(async ({ cloud, a, b, machine }) => {
    produce(a, machine);
    await passAll(cloud, a, b);
    const before = b.db.cartonStockReconciliation();

    const decision = mayWrite(b);
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed ? "" : decision.reason, "HELD_ELSEWHERE");
    assert.equal(decision.allowed ? "" : decision.holderLabel, "dev-a");
    assert.deepEqual(b.db.cartonStockReconciliation(), before);
  });
});

test("even past the local gate, the cloud refuses a computer that does not hold the lease, and the log stays clean", async () => {
  await withOffice(async ({ cloud, a, b, machine }) => {
    produce(a, machine);
    await passAll(cloud, a, b);
    addProduct(b);
    b.db.db.prepare("UPDATE sync_domain_leases SET holder_device_id = ? WHERE domain = ?").run(b.device, CARTONS_LEASE);
    adjust(b, "IN", 1);
    await pass(b, cloud);
    await pass(b, cloud);
    assert.equal(cloud.movements().length, 1, "only A's movement is in the log");
    assert.ok(b.db.cartonStockReconciliation().refused + b.db.cartonStockReconciliation().unsent >= 1, "and B says so");
  });
});

test("safe handover: the new holder must catch up first, the old holder stops, and both sets of work converge", async () => {
  await withOffice(async ({ cloud, a, b, c, machine }) => {
    produce(a, machine);
    await pass(a, cloud);
    addProduct(b);

    const barrier = cloud.grant(b.device);
    hearLease(a, cloud, barrier);
    hearLease(b, cloud, barrier);
    hearLease(c, cloud, barrier);

    assert.equal(mayWrite(a).allowed, false, "the old holder stops at once");
    const catching = mayWrite(b);
    assert.equal(catching.allowed ? "" : catching.reason, "CATCHING_UP", "the new holder waits for what came before");

    await pass(b, cloud);
    assert.equal(mayWrite(b).allowed, true);
    adjust(b, "OUT", 6);
    await passAll(cloud, a, b, c);
    assertConverged(14, 2, a, b, c);
  });
});

// ─── G7: a movement made just before the lease was lost ───

test("a movement refused for a lease lost is not lost and not doubled: it goes out when the lease comes back", async () => {
  await withOffice(async ({ cloud, a, b, c, machine }) => {
    produce(a, machine);
    await passAll(cloud, a, b, c);

    // A is offline and still believes it holds the lease: it may write, offline-first. Meanwhile the
    // lease moves to B, who writes too.
    cloud.offline(a.device);
    adjust(a, "OUT", 2);
    const barrier = cloud.grant(b.device);
    hearLease(b, cloud, barrier);
    hearLease(c, cloud, barrier);
    addProduct(b);
    await pass(b, cloud);
    adjust(b, "OUT", 3);
    await passAll(cloud, b, c);

    // A comes back and hears. Its movement is refused, for as long as it takes to reach the dead letters.
    cloud.online(a.device);
    hearLease(a, cloud, barrier);
    await pass(a, cloud);
    await pass(a, cloud);
    await pass(a, cloud);
    const refused = a.db.cartonStockReconciliation();
    assert.equal(refused.refused, 1, "A says plainly that the cloud refused it");
    assert.equal(cloud.movements().length, 2, "it is not in the log");
    assert.equal(inStore(a), 15, "A's figure holds it");
    assert.equal(inStore(b), 15 + 2, "B's does not");
    assert.notEqual(history(a), history(b), "the history shows they differ");
    assert.equal(resendCartonMovementsRefusedForLease(a.db.db, nowIso()), 0, "not sent again while A does not hold the lease");

    // The lease comes back to A.
    const back = cloud.grant(a.device);
    for (const pc of [a, b, c]) hearLease(pc, cloud, back);
    await passAll(cloud, a, b, c);

    assert.equal(cloud.movements().length, 3, "the one movement, once");
    assert.equal(a.db.cartonStockReconciliation().refused, 0);
    assertConverged(15, 3, a, b, c);
  });
});

test("a refusal for any other reason is not sent again: resending cannot help it", async () => {
  await withOffice(async ({ a, machine }) => {
    produce(a, machine);
    buildCartonStockEvents(a.db.db, nowIso());
    a.db.db.prepare("UPDATE sync_outbox SET status = 'DEAD_LETTER', last_error = 'IDENTITY_CONFLICT', lease_epoch = 0 WHERE aggregate_type = 'CARTON_STOCK_EVENT'").run();
    assert.equal(resendCartonMovementsRefusedForLease(a.db.db, nowIso()), 0);
  });
});

// ─── G6: a movement that cannot apply says so in words ───

test("a movement that would take the figure below zero waits, is visible, and applies once its cause arrives", async () => {
  await withOffice(async ({ cloud, a, b, c, machine }) => {
    produce(a, machine);
    await pass(a, cloud);
    adjust(a, "OUT", 5);
    await pass(a, cloud);

    // B reads the take-out before the stock it takes from: only by losing the first event.
    const [variant, made, taken] = cloud.log;
    assert.ok(variant && made && taken);
    const shortLog = { fetchChanges: async (afterSeq: number) => [variant, { ...taken, seq: 2 }].filter((change) => change.seq > afterSeq) };
    await new SyncPull(b.db.db, shortLog as never, { now: () => clock.ms, project: PROJECT }).runOnce();

    assert.equal(inStore(b), 0, "never clamped");
    const wait = waitingSummary(b.db.db, clock.ms).entries[0];
    assert.equal(wait?.cause.kind, "CARTONS_SHORT");
    assert.equal(b.db.cartonStockReconciliation().waiting, 1);
    assert.equal(c.db.cartonStockReconciliation().waiting, 0);
  });
});

test("the parked code becomes a cause a screen can say in words", () => {
  assert.deepEqual(waitCause("CARTON_STOCK_WOULD_GO_NEGATIVE:v-1"), { kind: "CARTONS_SHORT", id: "v-1" });
});
