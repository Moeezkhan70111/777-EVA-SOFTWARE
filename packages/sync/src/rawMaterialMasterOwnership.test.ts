import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEASED_AGGREGATE_DOMAIN, SqliteDatabase, buildStockEvents, leaseDomainOf } from "@erp/data";
import { LEASE_DOMAIN, type LeaseDomain } from "@erp/domain";
import type { SyncEnvelope } from "./contract.js";
import { OutboxDrain } from "./drain.js";
import { leaseWriteDecision } from "./leases.js";
import { parkedSummary } from "./parking.js";
import { SyncPull } from "./pull.js";
import type { SyncAck, SyncChange, SyncPullTransport, SyncTransport } from "./transport.js";

// TWO WRITERS OF MASTER DATA (docs/47, cloud 031). PC1 holds MASTER_DATA and writes general master data (party groups,
// parties, machines, products). PC2 holds RAW_MATERIAL_STORE and writes its materials, their categories and units, with
// their stock. PC3 writes neither. Real writers, capture triggers, builders, outbox, drain, pull and appliers; the cloud
// is a stand-in holding to push_leased_record's rule: a record is accepted only from the holder of ITS TYPE'S lease, at
// that lease's epoch, read from the same mapping the cloud's leased_record_types holds after 031.

const SCHEMA = path.resolve(import.meta.dirname, "../../data/src/local-schema.sql");
const PROJECT = "https://test.supabase.co";
const clock = { ms: Date.now() + 86_400_000 };
const nowIso = () => new Date(clock.ms).toISOString();

class Cloud {
  readonly log: SyncChange[] = [];
  readonly refused: SyncEnvelope[] = [];
  readonly leases = new Map<LeaseDomain, { holder: string; epoch: number }>([
    [LEASE_DOMAIN.MASTER_DATA, { holder: "dev-pc1", epoch: 4 }],
    [LEASE_DOMAIN.RAW_MATERIAL_STORE, { holder: "dev-pc2", epoch: 1 }],
  ]);

  private accept(envelope: SyncEnvelope, device: string): SyncAck {
    const domain = (LEASED_AGGREGATE_DOMAIN as Readonly<Record<string, LeaseDomain | undefined>>)[envelope.aggregateType];
    const lease = domain === undefined ? undefined : this.leases.get(domain);
    if (lease !== undefined && (lease.holder !== device || envelope.leaseEpoch !== lease.epoch)) {
      this.refused.push(envelope);
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

function openPc(name: string, block: number, cloud: Cloud): Pc {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `erp-owners-${name}-`));
  const db = new SqliteDatabase({ dbPath: path.join(dir, "erp.db"), schemaPath: SCHEMA });
  const device = `dev-${name}`;
  db.setNumberBlock(block, "test");
  db.ensureOperationalContext({
    factoryId: "factory-777", factoryCode: "F777", factoryName: "777", workstationId: `ws-${name}`, workstationCode: `WS-${name}`, workstationName: name,
    deviceId: device, deviceName: name, appVersion: "1.0.0",
  });
  db.db.prepare("INSERT OR REPLACE INTO app_settings (setting_key, setting_value, updated_at) VALUES ('device.id', ?, ?)").run(device, nowIso());
  db.db.prepare("INSERT OR REPLACE INTO app_settings (setting_key, setting_value, updated_at) VALUES ('sync.pull.project', ?, ?)").run(PROJECT, nowIso());
  for (const [domain, lease] of cloud.leases) {
    db.db.prepare(
      `INSERT OR REPLACE INTO sync_domain_leases (domain, holder_device_id, holder_label, epoch, barrier_seq, granted_at, project_key, fetched_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?)`
    ).run(domain, lease.holder, lease.holder, lease.epoch, nowIso(), PROJECT, nowIso());
  }
  return { name, device, dir, db };
}

async function pass(pc: Pc, cloud: Cloud): Promise<void> {
  pc.db.buildLeasedRecordRevisions(nowIso());
  buildStockEvents(pc.db.db, nowIso());
  const transport = cloud.as(pc.device);
  const retryPolicy = { maxAttempts: 2, baseBackoffMs: 1, maxBackoffMs: 1, staleInFlightMs: 120_000 };
  await new OutboxDrain(pc.db.db, transport, { deviceId: pc.device, now: nowIso, retryPolicy }).runOnce();
  await new SyncPull(pc.db.db, transport, { now: () => clock.ms, project: PROJECT }).runOnce();
  clock.ms += 3_600_000;
}

async function withOffice(work: (cloud: Cloud, pc1: Pc, pc2: Pc, pc3: Pc) => Promise<void>): Promise<void> {
  const cloud = new Cloud();
  const pcs = [openPc("pc1", 1, cloud), openPc("pc2", 2, cloud), openPc("pc3", 3, cloud)] as const;
  try {
    await work(cloud, ...pcs);
  } finally {
    for (const pc of pcs) {
      pc.db.close();
      fs.rmSync(pc.dir, { recursive: true, force: true });
    }
  }
}

const passAll = async (cloud: Cloud, pcs: readonly Pc[]) => {
  for (let round = 0; round < 3; round += 1) for (const pc of pcs) await pass(pc, cloud);
};
const count = (pc: Pc, sql: string, ...params: string[]): number => Number((pc.db.db.prepare(sql).get(...params) as { n: number }).n);
const decide = (pc: Pc, domain: LeaseDomain) => leaseWriteDecision(pc.db.db, { domain, deviceId: pc.device, syncConfigured: true }).allowed;

/** PC2's material: a unit, a category with a field, and the material with 10 in stock, made the ordinary way. */
function addMaterial(pc2: Pc): string {
  pc2.db.createInventoryUnit({ code: "DZN", name: "Dozen" });
  const unitId = (pc2.db.listInventoryUnits() as Array<{ id: string; code: string }>).find((unit) => unit.code === "DZN")?.id ?? "";
  const categoryId = pc2.db.createInventoryCategory({ name: "Rubber Upper" });
  pc2.db.addInventoryCategoryField({ categoryId, fieldKey: "article", label: "Article", fieldType: "TEXT", required: true });
  return pc2.db.createInventoryItem({ categoryId, unitId, stockQuantity: 10, values: { article: "SK6" } }).id;
}

test("the raw-material taxonomy is the store's lease; general master data stays MASTER_DATA", () => {
  for (const type of ["INVENTORY_UNIT", "UNIT_LADDER_PRESET", "INVENTORY_CATEGORY", "INVENTORY_ITEM", "STOCK_EVENT", "RAW_MATERIAL_QR_BATCH", "RAW_MATERIAL_QR"]) {
    assert.equal(leaseDomainOf(type), LEASE_DOMAIN.RAW_MATERIAL_STORE, type);
  }
  for (const type of ["PARTY_GROUP", "PARTY", "WORK_SECTION", "MACHINE", "MAIN_GROUP", "PRODUCT_GROUP", "ARTICLE_SIZE", "COLOR_TRANSLATION"]) {
    assert.equal(leaseDomainOf(type), LEASE_DOMAIN.MASTER_DATA, type);
  }
});

test("PC1 adds a group, PC2 adds a material with stock: each reaches the other two once, nothing refused or parked", async () => {
  await withOffice(async (cloud, pc1, pc2, pc3) => {
    assert.equal(decide(pc1, LEASE_DOMAIN.MASTER_DATA), true);
    assert.equal(decide(pc2, LEASE_DOMAIN.RAW_MATERIAL_STORE), true);
    const groupId = pc1.db.createProductGroup({ groupName: "SLIPPERS" });
    const itemId = addMaterial(pc2);
    await passAll(cloud, [pc1, pc2, pc3]);

    assert.deepEqual(cloud.refused.map((envelope) => envelope.aggregateType), [], "nothing refused by the cloud");
    const ofType = (type: string) => cloud.log.filter((change) => change.envelope.aggregateType === type);
    assert.equal(ofType("PRODUCT_GROUP").length, 1);
    assert.equal(ofType("INVENTORY_ITEM").length, 1);
    assert.equal(ofType("STOCK_EVENT").length, 1, "the material's opening stock, once");
    assert.ok(ofType("INVENTORY_ITEM").every((change) => change.envelope.originDeviceId === "dev-pc2" && change.envelope.leaseEpoch === 1));
    assert.ok(ofType("PRODUCT_GROUP").every((change) => change.envelope.originDeviceId === "dev-pc1" && change.envelope.leaseEpoch === 4));

    for (const pc of [pc1, pc2, pc3]) {
      assert.equal(count(pc, "SELECT COUNT(*) AS n FROM product_groups WHERE id = ?", groupId), 1, `${pc.name} has the group`);
      assert.equal(count(pc, "SELECT COUNT(*) AS n FROM inventory_items WHERE id = ?", itemId), 1, `${pc.name} has the material`);
      assert.equal(count(pc, "SELECT COALESCE(SUM(quantity_on_hand), 0) AS n FROM inventory_stock_balances WHERE item_id = ?", itemId), 10, `${pc.name} holds 10`);
      assert.equal(count(pc, "SELECT COUNT(*) AS n FROM inventory_stock_events WHERE item_id = ?", itemId), 1, `${pc.name}: one movement`);
      assert.equal(parkedSummary(pc.db.db).count, 0, `${pc.name} has nothing parked`);
    }
  });
});

test("a computer without the lease stays read-only for it, both ways", async () => {
  await withOffice(async (_cloud, pc1, pc2, pc3) => {
    assert.equal(decide(pc1, LEASE_DOMAIN.RAW_MATERIAL_STORE), false, "PC1 does not write materials");
    assert.equal(decide(pc2, LEASE_DOMAIN.MASTER_DATA), false, "PC2 does not write general master data");
    assert.equal(decide(pc3, LEASE_DOMAIN.MASTER_DATA), false);
    assert.equal(decide(pc3, LEASE_DOMAIN.RAW_MATERIAL_STORE), false);
  });
});

test("a material written on a computer that does not hold the store lease is refused by the cloud, never applied elsewhere", async () => {
  await withOffice(async (cloud, pc1, pc2, pc3) => {
    const itemId = addMaterial(pc1);
    await passAll(cloud, [pc1, pc2, pc3]);
    assert.equal(cloud.log.filter((change) => change.envelope.aggregateType === "INVENTORY_ITEM").length, 0);
    for (const pc of [pc2, pc3]) assert.equal(count(pc, "SELECT COUNT(*) AS n FROM inventory_items WHERE id = ?", itemId), 0, pc.name);
  });
});

test("an existing material and its stock are untouched by the change of lease: a new revision moves nothing", async () => {
  await withOffice(async (cloud, pc1, pc2, pc3) => {
    const itemId = addMaterial(pc2);
    await passAll(cloud, [pc1, pc2, pc3]);
    const movementsBefore = cloud.log.filter((change) => change.envelope.aggregateType === "STOCK_EVENT").length;
    pc2.db.db.prepare("UPDATE inventory_items SET display_name = display_name WHERE id = ?").run(itemId);
    await passAll(cloud, [pc1, pc2, pc3]);
    assert.equal(cloud.log.filter((change) => change.envelope.aggregateType === "STOCK_EVENT").length, movementsBefore, "no movement re-sent");
    for (const pc of [pc1, pc2, pc3]) {
      assert.equal(count(pc, "SELECT COALESCE(SUM(quantity_on_hand), 0) AS n FROM inventory_stock_balances WHERE item_id = ?", itemId), 10, pc.name);
    }
  });
});
