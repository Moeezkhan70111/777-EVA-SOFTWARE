import test from "node:test";
import { activateCartonCloudForTest } from "@erp/data/dist/testing/cartonCloud.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CancelGatepassUseCase, CreateGatepassUseCase, DeleteGatepassUseCase, EditGatepassUseCase } from "@erp/application";
import { SqliteDatabase, buildCartonStockEvents } from "@erp/data";
import { CARTON_QR_ON_HOLD, LEASE_DOMAIN, PENDING_ORDER_FILTER, type LeaseDomain } from "@erp/domain";
import type { SyncEnvelope } from "./contract.js";
import { OutboxDrain } from "./drain.js";
import { parkedSummary } from "./parking.js";
import { SyncPull } from "./pull.js";
import type { SyncAck, SyncChange, SyncPullTransport, SyncTransport } from "./transport.js";

// PENDING ORDERS ACROSS THE OFFICE (docs/52): the computer holding SALES_DISPATCH enters an order and makes gatepasses
// against it; the cloud takes each order and allocation revision once; the other computers read the same pending
// figures, never working an allocation out for themselves; a replay counts nothing twice; before cloud 036 the order and
// the allocation wait as UNKNOWN_RECORD_TYPE while the gatepass and its stock travel. Real writers, capture triggers,
// builders, outbox, drain, pull and appliers; the cloud is a stand-in holding to push_leased_record's rules.

const SCHEMA = path.resolve(import.meta.dirname, "../../data/src/local-schema.sql");
const PROJECT = "https://test.supabase.co";
const STORE = "factory-777";
const clock = { ms: Date.now() };
const nowIso = () => new Date(clock.ms).toISOString();
const ORDER_TYPES = new Set(["CUSTOMER_ORDER", "GATEPASS_ORDER_ALLOCATION"]);
const DOMAIN_OF: Readonly<Record<string, LeaseDomain>> = {
  ARTICLE_SIZE: LEASE_DOMAIN.MASTER_DATA,
  // Parties travel under their own lease since docs/51 (cloud 035), not MASTER_DATA.
  PARTY: LEASE_DOMAIN.PARTIES,
  PARTY_GROUP: LEASE_DOMAIN.PARTIES,
  CARTON_STOCK_EVENT: LEASE_DOMAIN.CARTON_STOCK,
  GATEPASS: LEASE_DOMAIN.SALES_DISPATCH,
  SALE_VOUCHER: LEASE_DOMAIN.SALES_DISPATCH,
  CUSTOMER_ORDER: LEASE_DOMAIN.ORDERS,
  GATEPASS_ORDER_ALLOCATION: LEASE_DOMAIN.SALES_DISPATCH,
};

class Cloud {
  readonly log: SyncChange[] = [];
  knowsOrders = true;
  readonly leases = new Map<LeaseDomain, { holder: string; epoch: number }>([
    [LEASE_DOMAIN.MASTER_DATA, { holder: "dev-pc1", epoch: 2 }],
    // The computer entering the order also adds the party here (docs/51 gives PARTIES to whoever adds parties).
    [LEASE_DOMAIN.PARTIES, { holder: "dev-pc1", epoch: 2 }],
    [LEASE_DOMAIN.CARTON_STOCK, { holder: "dev-pc1", epoch: 2 }],
    [LEASE_DOMAIN.SALES_DISPATCH, { holder: "dev-pc1", epoch: 2 }],
    // Orders have their own lease since cloud 042 (24 Nov 2026); here one computer holds both, as before.
    [LEASE_DOMAIN.ORDERS, { holder: "dev-pc1", epoch: 2 }],
    [LEASE_DOMAIN.RAW_MATERIAL_STORE, { holder: "dev-pc2", epoch: 1 }],
  ]);

  deliverAgain(): void {
    for (const change of [...this.log]) this.log.push({ seq: this.log.length + 1, envelope: change.envelope });
  }

  private accept(envelope: SyncEnvelope, device: string): SyncAck {
    if (ORDER_TYPES.has(envelope.aggregateType) && !this.knowsOrders) {
      return { dedupeKey: envelope.dedupeKey, accepted: false, reason: "UNKNOWN_RECORD_TYPE", failure: "TRANSIENT" } as SyncAck;
    }
    const domain = DOMAIN_OF[envelope.aggregateType];
    const lease = domain === undefined ? undefined : this.leases.get(domain);
    if (lease !== undefined && (lease.holder !== device || envelope.leaseEpoch !== lease.epoch)) {
      return { dedupeKey: envelope.dedupeKey, accepted: false, reason: "NOT_LEASE_HOLDER", failure: "REFUSED" };
    }
    if (!this.log.some((change) => change.envelope.dedupeKey === envelope.dedupeKey)) {
      this.log.push({ seq: this.log.length + 1, envelope: { ...envelope, originDeviceId: device } });
    }
    return { dedupeKey: envelope.dedupeKey, accepted: true };
  }

  as(device: string): SyncTransport & SyncPullTransport {
    return {
      send: async (envelopes) => envelopes.map((envelope) => this.accept(envelope, device)),
      fetchChanges: async (afterSeq, limit) => this.log.filter((change) => change.seq > afterSeq).slice(0, limit),
    };
  }
}

interface Pc { readonly name: string; readonly device: string; readonly dir: string; readonly db: SqliteDatabase }

function openPc(name: string, block: number): Pc {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `erp-orders-${name}-`));
  const db = new SqliteDatabase({ dbPath: path.join(dir, "erp.db"), schemaPath: SCHEMA });
  const device = `dev-${name}`;
  db.setNumberBlock(block, "test");
  db.ensureOperationalContext({
    factoryId: STORE, factoryCode: "F777", factoryName: "777", workstationId: `ws-${name}`, workstationCode: `WS-${name}`, workstationName: name,
    deviceId: device, deviceName: name, appVersion: "1.0.0",
  });
  db.db.prepare("INSERT OR REPLACE INTO app_settings (setting_key, setting_value, updated_at) VALUES ('device.id', ?, ?)").run(device, nowIso());
  db.cartonQrOnHold = CARTON_QR_ON_HOLD;
  activateCartonCloudForTest(db.db, PROJECT);
  return { name, device, dir, db };
}

function hearLeases(pc: Pc, cloud: Cloud): void {
  for (const [domain, lease] of cloud.leases) {
    pc.db.db.prepare(
      `INSERT INTO sync_domain_leases (domain, holder_device_id, holder_label, epoch, barrier_seq, granted_at, project_key, fetched_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT (domain) DO UPDATE SET holder_device_id = excluded.holder_device_id, epoch = excluded.epoch, fetched_at = excluded.fetched_at`
    ).run(domain, lease.holder, lease.holder, lease.epoch, nowIso(), PROJECT, nowIso());
  }
}

async function pass(pc: Pc, cloud: Cloud): Promise<void> {
  pc.db.buildLeasedRecordRevisions(nowIso());
  buildCartonStockEvents(pc.db.db, nowIso());
  const transport = cloud.as(pc.device);
  const retryPolicy = { maxAttempts: 5, baseBackoffMs: 1, maxBackoffMs: 1, staleInFlightMs: 120_000 };
  await new OutboxDrain(pc.db.db, transport, { deviceId: pc.device, now: nowIso, retryPolicy }).runOnce();
  await new SyncPull(pc.db.db, transport, { now: () => clock.ms, project: PROJECT }).runOnce();
  clock.ms += 60_000;
}

const passAll = async (cloud: Cloud, pcs: readonly Pc[]) => {
  for (let round = 0; round < 3; round += 1) for (const pc of pcs) await pass(pc, cloud);
};

interface Office {
  readonly cloud: Cloud;
  readonly pcs: readonly [Pc, Pc, Pc];
  readonly party: string;
  readonly red: string;
  readonly blue: string;
}

async function withOffice(work: (office: Office) => Promise<void>): Promise<void> {
  const cloud = new Cloud();
  const pcs = [openPc("pc1", 1), openPc("pc2", 2), openPc("pc3", 3)] as const;
  const [pc1] = pcs;
  for (const pc of pcs) hearLeases(pc, cloud);
  try {
    pc1.db.createProduct({ article: "SK6", size: "7/10", sellingPrice: 550, machineRate: 70, packingRate: 30, colors: ["RED", "BLUE"], status: "ACTIVE" } as never);
    const party = pc1.db.createParty({ partyName: "BEHRAAM SHOES", partyType: "CUSTOMER", city: "Lahore", mobileNumber: "0300-1111111", status: "ACTIVE" });
    const variant = (color: string) => (pc1.db.db.prepare("SELECT id FROM product_variants WHERE article = 'SK6' AND color = ?").get(color) as { id: string }).id;
    await passAll(cloud, pcs);
    await work({ cloud, pcs, party, red: variant("RED"), blue: variant("BLUE") });
  } finally {
    for (const pc of pcs) {
      pc.db.close();
      fs.rmSync(pc.dir, { recursive: true, force: true });
    }
  }
}

const ids = () => ({ nextId: () => crypto.randomUUID() });

async function makeGatepass(pc: Pc, partyId: string, lines: Array<[string, number]>): Promise<string> {
  const made = await new CreateGatepassUseCase({ txManager: pc.db, repo: pc.db, idGenerator: ids() }).execute({
    partyId, lines: lines.map(([productVariantId, quantity]) => ({ productVariantId, quantity })), actor: "clerk", requestId: crypto.randomUUID(), storeLocationId: STORE,
  });
  assert.equal(made.accepted, true, made.reason);
  return String(made.gatepassId);
}

/** What the Pending Orders screen shows for the party, on one computer: [ordered, dispatched, pending] per colour. */
const pendingOn = (pc: Pc, partyId: string) =>
  Object.fromEntries(pc.db.pendingOrderPartyLines(partyId, { filter: PENDING_ORDER_FILTER.ALL }).map((line) => [line.color, [line.ordered, line.dispatched, line.pending]]));

const count = (pc: Pc, sql: string): number => Number((pc.db.db.prepare(sql).get() as { n: number }).n);

test("PC1 enters an order and makes two gatepasses; PC2 and PC3 read exactly the same pending figures", async () => {
  await withOffice(async ({ cloud, pcs, party, red, blue }) => {
    const [pc1] = pcs;
    pc1.db.saveCustomerOrder({ requestId: crypto.randomUUID(), partyId: party, lines: [{ productVariantId: red, quantity: 10 }, { productVariantId: blue, quantity: 6 }], actor: "clerk" });
    await makeGatepass(pc1, party, [[red, 4]]);
    await passAll(cloud, pcs);
    for (const pc of pcs) assert.deepEqual(pendingOn(pc, party), { BLUE: [6, 0, 6], RED: [10, 4, 6] }, pc.name);

    await makeGatepass(pc1, party, [[red, 7], [blue, 6]]);
    await passAll(cloud, pcs);
    for (const pc of pcs) {
      assert.deepEqual(pendingOn(pc, party), { BLUE: [6, 6, 0], RED: [10, 10, 0] }, `${pc.name}: the 1 over-dispatched RED stays unallocated`);
      assert.equal(parkedSummary(pc.db.db).count, 0, `${pc.name} has nothing parked: ${JSON.stringify(parkedSummary(pc.db.db).oldest)}`);
    }
  });
});

test("PC1 cancels a gatepass; its exact allocation is reversed on every computer", async () => {
  await withOffice(async ({ cloud, pcs, party, red }) => {
    const [pc1] = pcs;
    pc1.db.saveCustomerOrder({ requestId: crypto.randomUUID(), partyId: party, lines: [{ productVariantId: red, quantity: 10 }], actor: "clerk" });
    const first = await makeGatepass(pc1, party, [[red, 3]]);
    await makeGatepass(pc1, party, [[red, 2]]);
    await passAll(cloud, pcs);
    const cancelled = await new CancelGatepassUseCase({ txManager: pc1.db, repo: pc1.db, idGenerator: ids() }).execute({ gatepassId: first, reason: "wrong party", actor: "clerk" });
    assert.equal(cancelled.accepted, true, cancelled.reason);
    await passAll(cloud, pcs);
    for (const pc of pcs) assert.deepEqual(pendingOn(pc, party), { RED: [10, 2, 8] }, pc.name);
  });
});

test("a replay, and re-reading everything, count nothing twice", async () => {
  await withOffice(async ({ cloud, pcs, party, red }) => {
    const [pc1, pc2, pc3] = pcs;
    pc1.db.saveCustomerOrder({ requestId: crypto.randomUUID(), partyId: party, lines: [{ productVariantId: red, quantity: 10 }], actor: "clerk" });
    await makeGatepass(pc1, party, [[red, 4]]);
    await passAll(cloud, pcs);
    cloud.deliverAgain();
    for (const pc of [pc2, pc3]) pc.db.db.prepare("DELETE FROM app_settings WHERE setting_key = 'sync.pull.cursor'").run();
    await passAll(cloud, pcs);
    for (const pc of pcs) {
      assert.deepEqual(pendingOn(pc, party), { RED: [10, 4, 6] }, pc.name);
      assert.equal(count(pc, "SELECT COUNT(*) AS n FROM gatepass_order_allocation_lines"), 1, `${pc.name}: one allocation line`);
      assert.equal(count(pc, "SELECT COUNT(*) AS n FROM customer_orders"), 1, `${pc.name}: one order`);
    }
    assert.equal(cloud.log.filter((change) => change.envelope.aggregateType === "GATEPASS_ORDER_ALLOCATION").length, 2, "one revision, delivered twice by the replay");
  });
});

test("before cloud 036 the order and allocation wait as UNKNOWN_RECORD_TYPE while the gatepass travels; after it, they follow", async () => {
  await withOffice(async ({ cloud, pcs, party, red }) => {
    const [pc1, pc2] = pcs;
    cloud.knowsOrders = false;
    pc1.db.saveCustomerOrder({ requestId: crypto.randomUUID(), partyId: party, lines: [{ productVariantId: red, quantity: 10 }], actor: "clerk" });
    await makeGatepass(pc1, party, [[red, 4]]);
    await passAll(cloud, pcs);
    assert.equal(count(pc2, "SELECT COUNT(*) AS n FROM gatepasses"), 1, "the gatepass arrives without its allocation");
    assert.deepEqual(pendingOn(pc2, party), {}, "PC2 has no order yet");
    assert.equal(count(pc1, "SELECT COUNT(*) AS n FROM sync_outbox WHERE aggregate_type IN ('CUSTOMER_ORDER', 'GATEPASS_ORDER_ALLOCATION') AND status IN ('PENDING', 'FAILED')"), 2, "queued, not lost");

    cloud.knowsOrders = true;
    clock.ms += 3_600_000;
    await passAll(cloud, pcs);
    assert.deepEqual(pendingOn(pc2, party), { RED: [10, 4, 6] }, "then PC2 reads the same figures");
  });
});

// A GATEPASS EDIT ACROSS THE OFFICE (local migration 118). The edit replaces the gatepass's lines and its order allocation
// in one transaction on PC1, but the others receive the two records one at a time. Neither may wait for the other:
// every computer ends with the new lines, the kept version and the reallocated pending figures, and nothing parked.
test("PC1 edits a gatepass counted against an order; every computer gets the new lines, its history and the new pending figures", async () => {
  await withOffice(async ({ cloud, pcs, party, red, blue }) => {
    const [pc1] = pcs;
    pc1.db.saveCustomerOrder({ requestId: crypto.randomUUID(), partyId: party, lines: [{ productVariantId: red, quantity: 10 }, { productVariantId: blue, quantity: 6 }], actor: "clerk" });
    const gatepassId = await makeGatepass(pc1, party, [[red, 4]]);
    await passAll(cloud, pcs);
    for (const pc of pcs) assert.deepEqual(pendingOn(pc, party), { BLUE: [6, 0, 6], RED: [10, 4, 6] }, pc.name);

    const edited = await new EditGatepassUseCase({ txManager: pc1.db, repo: pc1.db, idGenerator: ids() }).execute({
      gatepassId, revisionNo: 1, partyId: party, reason: "typed cartons, meant dozens", actor: "owner", storeLocationId: STORE,
      lines: [{ productVariantId: red, quantity: 8 }, { productVariantId: blue, quantity: 2 }],
    });
    assert.equal(edited.accepted, true, edited.reason);
    await passAll(cloud, pcs);

    for (const pc of pcs) {
      const gatepass = pc.db.getGatepass(gatepassId)!;
      assert.deepEqual(gatepass.lines.map((line) => [line.color, line.quantity]).sort(), [["BLUE", 2], ["RED", 8]], `${pc.name}: the new lines`);
      assert.deepEqual([gatepass.revisionNo, gatepass.versions.map((v) => v.totalQuantity)], [2, [4]], `${pc.name}: the kept version`);
      assert.deepEqual(pendingOn(pc, party), { BLUE: [6, 2, 4], RED: [10, 8, 2] }, `${pc.name}: reallocated`);
      // The old lines' cartons came back and the new ones' went out, on every computer alike.
      const stock = Object.fromEntries(pc.db.listStoreStockByArticle("SK6").map((row) => [row.color, row.storeQuantity]));
      assert.deepEqual(stock, { BLUE: -2, RED: -8 }, `${pc.name}: stock`);
      assert.equal(parkedSummary(pc.db.db).count, 0, `${pc.name} has nothing parked: ${JSON.stringify(parkedSummary(pc.db.db).oldest)}`);
    }
  });
});

test("PC1 cancels and deletes a gatepass; it leaves every computer's list and is kept on each", async () => {
  await withOffice(async ({ cloud, pcs, party, red }) => {
    const [pc1] = pcs;
    const gatepassId = await makeGatepass(pc1, party, [[red, 3]]);
    await passAll(cloud, pcs);
    assert.equal((await new CancelGatepassUseCase({ txManager: pc1.db, repo: pc1.db, idGenerator: ids() }).execute({ gatepassId, reason: "wrong party", actor: "owner" })).accepted, true);
    const deleted = await new DeleteGatepassUseCase({ txManager: pc1.db, repo: pc1.db, idGenerator: ids() }).execute({ gatepassId, reason: "made in error", actor: "owner" });
    assert.equal(deleted.accepted, true, deleted.reason);
    await passAll(cloud, pcs);
    for (const pc of pcs) {
      assert.equal(pc.db.listGatepasses({}).rows.some((row) => row.id === gatepassId), false, `${pc.name}: off the list`);
      assert.deepEqual(pc.db.listGatepasses({ deleted: true }).rows.map((row) => [row.id, row.deletedBy]), [[gatepassId, "owner"]], `${pc.name}: on the log`);
      assert.equal(parkedSummary(pc.db.db).count, 0, `${pc.name} has nothing parked: ${JSON.stringify(parkedSummary(pc.db.db).oldest)}`);
    }
  });
});

// ─── ORDERS ON PC3, GATEPASSES ON PC1 (owner, 24 Nov 2026; cloud 042) ───────────────────────────────────────────────
// The order is written on PC3 under ORDERS, the gatepass and its allocation on PC1 under SALES_DISPATCH. Both work
// offline, so a reduction, removal or cancellation on PC3 can cross a gatepass PC1 has already counted. Whatever order
// the two records reach each computer in, every computer must end with the same figures, every dispatch kept, and no
// line ordering less than was dispatched (orderAllocation.ts, ORDER_LINE_EFFECTIVE_SQL).

/** Moves the ORDERS lease to PC3, as cloud 042 and its grant do, and tells every computer. */
const ordersOnPc3 = (cloud: Cloud, pcs: readonly Pc[]) => {
  cloud.leases.set(LEASE_DOMAIN.ORDERS, { holder: "dev-pc3", epoch: 1 });
  for (const pc of pcs) hearLeases(pc, cloud);
};

/** One order line as a computer reads it: [ordered, asked, dispatched, pending]. */
const lineOn = (pc: Pc, orderId: string, color: string) => {
  const line = pc.db.requireCustomerOrder(orderId).lines.find((each) => each.color === color);
  return line ? [line.quantity, line.requested, line.dispatched, line.pending] : null;
};

const saveOn = (pc: Pc, party: string, lines: Array<[string, number]>, requestId: string = crypto.randomUUID()) =>
  pc.db.saveCustomerOrder({ requestId, partyId: party, lines: lines.map(([productVariantId, quantity]) => ({ productVariantId, quantity })), actor: "boss" });

const editOn = (pc: Pc, orderId: string, party: string, lines: Array<[string, number]>) => {
  const revision = pc.db.requireCustomerOrder(orderId).revision;
  return pc.db.editCustomerOrder({ orderId, revision, partyId: party, lines: lines.map(([productVariantId, quantity]) => ({ productVariantId, quantity })), actor: "boss" });
};

for (const first of ["pc3", "pc1"] as const) {
  test(`a stale reduction on PC3 crosses a gatepass on PC1, ${first} sending first: every computer counts what was sent`, async () => {
    await withOffice(async ({ cloud, pcs, party, red }) => {
      const [pc1, pc2, pc3] = pcs;
      ordersOnPc3(cloud, pcs);
      const order = saveOn(pc3, party, [[red, 10]]).order;
      await passAll(cloud, pcs);

      await makeGatepass(pc1, party, [[red, 6]]);
      const edited = editOn(pc3, order.id, party, [[red, 4]]);
      assert.equal(edited.changed, true, "PC3 had not heard of the gatepass, so its own check let 4 through");

      for (const pc of first === "pc3" ? [pc3, pc1] : [pc1, pc3]) await pass(pc, cloud);
      await passAll(cloud, pcs);
      for (const pc of [pc1, pc2, pc3]) {
        assert.deepEqual(lineOn(pc, order.id, "RED"), [6, 4, 6, 0], `${pc.name}: orders what was sent, asked 4 kept, nothing pending`);
        assert.deepEqual(pendingOn(pc, party), { RED: [6, 6, 0] }, `${pc.name}: the pending list agrees`);
        assert.equal(count(pc, "SELECT COALESCE(SUM(quantity), 0) AS n FROM gatepass_order_allocation_lines WHERE reversed_at IS NULL"), 6, `${pc.name}: the dispatch is kept`);
      }

      // Duplicate and out-of-order delivery change nothing.
      cloud.deliverAgain();
      for (const pc of [pc2, pc3]) pc.db.db.prepare("DELETE FROM app_settings WHERE setting_key = 'sync.pull.cursor'").run();
      await passAll(cloud, pcs);
      for (const pc of [pc1, pc2, pc3]) {
        assert.deepEqual(lineOn(pc, order.id, "RED"), [6, 4, 6, 0], `${pc.name} after the replay`);
        assert.equal(count(pc, "SELECT COUNT(*) AS n FROM customer_orders"), 1, `${pc.name}: one order`);
        assert.equal(count(pc, "SELECT COUNT(*) AS n FROM gatepass_order_allocation_lines"), 1, `${pc.name}: one allocation line`);
      }
    });
  });
}

test("a stale removal on PC3 crosses a gatepass on PC1: the removed line stays, ordering what was sent", async () => {
  await withOffice(async ({ cloud, pcs, party, red, blue }) => {
    const [pc1, pc2, pc3] = pcs;
    ordersOnPc3(cloud, pcs);
    const order = saveOn(pc3, party, [[red, 10], [blue, 5]]).order;
    await passAll(cloud, pcs);
    await makeGatepass(pc1, party, [[red, 6]]);
    editOn(pc3, order.id, party, [[blue, 5]]);
    await passAll(cloud, pcs);
    for (const pc of [pc1, pc2, pc3]) {
      assert.deepEqual(lineOn(pc, order.id, "RED"), [6, 0, 6, 0], `${pc.name}: taken off, still showing what was sent`);
      assert.deepEqual(pendingOn(pc, party), { BLUE: [5, 0, 5], RED: [6, 6, 0] }, pc.name);
    }
  });
});

test("a stale cancellation on PC3 crosses a gatepass on PC1: the order is closed, and what was sent is kept", async () => {
  await withOffice(async ({ cloud, pcs, party, red }) => {
    const [pc1, pc2, pc3] = pcs;
    ordersOnPc3(cloud, pcs);
    const order = saveOn(pc3, party, [[red, 10]]).order;
    await passAll(cloud, pcs);
    await makeGatepass(pc1, party, [[red, 6]]);
    pc3.db.cancelCustomerOrder({ orderId: order.id, revision: pc3.db.requireCustomerOrder(order.id).revision, reason: "party changed its mind", actor: "boss" });
    await passAll(cloud, pcs);
    for (const pc of [pc1, pc2, pc3]) {
      const seen = pc.db.requireCustomerOrder(order.id);
      assert.equal(seen.status, "CANCELLED", pc.name);
      assert.deepEqual([seen.totals.ordered, seen.totals.dispatched, seen.totals.pending], [10, 6, 0], `${pc.name}: closed, the 6 sent kept`);
    }
  });
});

test("with the gatepass already heard, PC3 refuses to lower a line below what was sent", async () => {
  await withOffice(async ({ cloud, pcs, party, red }) => {
    const [pc1, , pc3] = pcs;
    ordersOnPc3(cloud, pcs);
    const order = saveOn(pc3, party, [[red, 10]]).order;
    await passAll(cloud, pcs);
    await makeGatepass(pc1, party, [[red, 6]]);
    await passAll(cloud, pcs);
    assert.deepEqual(lineOn(pc3, order.id, "RED"), [10, 10, 6, 4], "PC3 has heard of the 6 sent");
    assert.throws(() => editOn(pc3, order.id, party, [[red, 4]]), /cannot be lowered below/);
  });
});

test("several edits on PC3 before a sync, and a retried Save, arrive as one order at its last revision", async () => {
  await withOffice(async ({ cloud, pcs, party, red }) => {
    const [pc1, pc2, pc3] = pcs;
    ordersOnPc3(cloud, pcs);
    const requestId = crypto.randomUUID();
    const order = saveOn(pc3, party, [[red, 10]], requestId).order;
    assert.equal(saveOn(pc3, party, [[red, 10]], requestId).duplicate, true, "the retried Save is the same order");
    editOn(pc3, order.id, party, [[red, 8]]);
    editOn(pc3, order.id, party, [[red, 7]]);
    await passAll(cloud, pcs);
    for (const pc of [pc1, pc2, pc3]) {
      assert.equal(count(pc, "SELECT COUNT(*) AS n FROM customer_orders"), 1, `${pc.name}: one order`);
      assert.deepEqual(lineOn(pc, order.id, "RED"), [7, 7, 0, 7], `${pc.name}: the last edit`);
      assert.equal(pc.db.requireCustomerOrder(order.id).revision, 3, `${pc.name}: at its last revision`);
    }
  });
});

test("once ORDERS is PC3's, PC1's gatepass writes only its allocation, and an order written on PC1 never reaches the cloud", async () => {
  await withOffice(async ({ cloud, pcs, party, red }) => {
    const [pc1, pc2, pc3] = pcs;
    ordersOnPc3(cloud, pcs);
    const order = saveOn(pc3, party, [[red, 10]]).order;
    await passAll(cloud, pcs);
    await makeGatepass(pc1, party, [[red, 6]]);
    await passAll(cloud, pcs);
    const orderRevisions = cloud.log.filter((change) => change.envelope.aggregateType === "CUSTOMER_ORDER");
    assert.ok(orderRevisions.length > 0 && orderRevisions.every((change) => change.envelope.originDeviceId === "dev-pc3"), "every order revision is PC3's: the gatepass did not rewrite the order");
    assert.ok(cloud.log.some((change) => change.envelope.aggregateType === "GATEPASS_ORDER_ALLOCATION" && change.envelope.originDeviceId === "dev-pc1"), "the allocation is PC1's");

    // If PC1 wrote an order anyway (the screen and the IPC guard refuse it first), the cloud does not take it.
    saveOn(pc1, party, [[red, 3]]);
    await passAll(cloud, pcs);
    assert.ok(cloud.log.every((change) => change.envelope.aggregateType !== "CUSTOMER_ORDER" || change.envelope.originDeviceId === "dev-pc3"), "nothing from PC1 under ORDERS");
    for (const pc of [pc2, pc3]) assert.equal(count(pc, "SELECT COUNT(*) AS n FROM customer_orders"), 1, `${pc.name} never receives it`);
    assert.deepEqual(lineOn(pc3, order.id, "RED"), [10, 10, 6, 4]);
  });
});
