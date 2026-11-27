import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEASED_AGGREGATE_DOMAIN, SqliteDatabase, buildStockEvents } from "@erp/data";
import { LEASE_DOMAIN, type LeaseDomain } from "@erp/domain";
import type { SyncEnvelope } from "./contract.js";
import { OutboxDrain } from "./drain.js";
import { SyncPull } from "./pull.js";
import type { SyncAck, SyncChange, SyncPullTransport, SyncTransport } from "./transport.js";

// BHAG WAS A TYPO OF BAG (owner, 27 Nov 2026: "i dont want BHAG. it was a typo"). PC2 holds the raw-material store.
// Local 123 on every computer: whatever names BHAG names BAG, no figure converted, BHAG switched off, and PC2 sends the
// materials and the unit again. The cloud is the stand-in of discountRulesSync.test.ts.

const SCHEMA = path.resolve(import.meta.dirname, "../../data/src/local-schema.sql");
const MIGRATION_123 = path.resolve(import.meta.dirname, "../../../migrations/sqlite/123_bhag_is_bag.up.sql");
const PROJECT = "https://test.supabase.co";
const clock = { ms: Date.now() + 86_400_000 };
const nowIso = () => new Date(clock.ms).toISOString();

class Cloud {
  readonly log: SyncChange[] = [];
  readonly leases = new Map<LeaseDomain, { holder: string; epoch: number }>([
    [LEASE_DOMAIN.MASTER_DATA, { holder: "dev-pc1", epoch: 4 }],
    [LEASE_DOMAIN.PARTIES, { holder: "dev-pc1", epoch: 2 }],
    [LEASE_DOMAIN.RAW_MATERIAL_STORE, { holder: "dev-pc2", epoch: 7 }],
  ]);

  private accept(envelope: SyncEnvelope, device: string): SyncAck {
    const domain = (LEASED_AGGREGATE_DOMAIN as Readonly<Record<string, LeaseDomain | undefined>>)[envelope.aggregateType];
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

function openPc(name: string, block: number, cloud: Cloud): Pc {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `erp-bhag-${name}-`));
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


/** As in a real migration run, where the capture triggers are dropped. */
function migrate(pc: Pc, sql: string): void {
  const triggers = pc.db.db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string; sql: string }>;
  for (const trigger of triggers) pc.db.db.exec(`DROP TRIGGER ${trigger.name}`);
  pc.db.db.exec(sql);
  for (const trigger of triggers) pc.db.db.exec(trigger.sql);
}

const unitOf = (pc: Pc, itemId: string): string =>
  (pc.db.db.prepare("SELECT u.code FROM inventory_items i JOIN inventory_units u ON u.id = i.default_unit_id WHERE i.id = ?").get(itemId) as { code: string }).code;
const balanceOf = (pc: Pc, itemId: string): { quantity: number; unit: string } => {
  const row = pc.db.db.prepare("SELECT b.quantity_on_hand AS q, u.code FROM inventory_stock_balances b JOIN inventory_units u ON u.id = b.unit_id WHERE b.item_id = ?").get(itemId) as { q: number; code: string };
  return { quantity: Number(row.q), unit: row.code };
};
const bhagNamed = (pc: Pc): number => {
  const bhag = (pc.db.db.prepare("SELECT id FROM inventory_units WHERE code = 'BHAG'").get() as { id: string }).id;
  const count = (sql: string) => Number((pc.db.db.prepare(sql).get(bhag) as { n: number }).n);
  return count("SELECT COUNT(*) AS n FROM inventory_items WHERE default_unit_id = ? OR packing_unit_id = ?".replace("= ?", "= ?1").replace("= ?", "= ?1"))
    + count("SELECT COUNT(*) AS n FROM inventory_stock_events WHERE unit_id = ?")
    + count("SELECT COUNT(*) AS n FROM inventory_stock_balances WHERE unit_id = ?");
};

test("BHAG becomes BAG everywhere, the figures unchanged, BHAG offered nowhere, and the store's records say BAG in the cloud", async () => {
  await withOffice(async (cloud, pc1, pc2, pc3) => {
    pc2.db.createInventoryUnit({ code: "BHAG", name: "BHAG", unitFamily: "COUNT" });
    pc2.db.createInventoryUnit({ code: "BAG", name: "BAG", unitFamily: "COUNT" });
    const bhag = (pc2.db.db.prepare("SELECT id FROM inventory_units WHERE code = 'BHAG'").get() as { id: string }).id;
    const categoryId = pc2.db.createInventoryCategory({ name: "DANA" });
    pc2.db.addInventoryCategoryField({ categoryId, fieldKey: "article", label: "ARTICLE", fieldType: "TEXT", required: true });
    const silver = pc2.db.createInventoryItem({ categoryId, unitId: bhag, values: { article: "SILVER GREY" } }).id;
    pc2.db.applyInventoryStockChange({ itemId: silver, quantity: 30, eventType: "RECEIVE", note: "Manual move in, 30 BHAG" });
    pc2.db.applyInventoryStockChange({ itemId: silver, quantity: -2, eventType: "TRANSFER_OUT", note: "Manual move out, 2 BHAG" });
    await passAll(cloud, [pc1, pc2, pc3]);
    for (const pc of [pc1, pc2, pc3]) assert.deepEqual(balanceOf(pc, silver), { quantity: 28, unit: "BHAG" }, `${pc.name} before`);

    const sql = fs.readFileSync(MIGRATION_123, "utf8");
    for (const pc of [pc1, pc2, pc3]) migrate(pc, sql);
    assert.equal(Number((pc1.db.db.prepare("SELECT COUNT(*) AS n FROM sync_dirty_records").get() as { n: number }).n), 0, "PC1 does not hold the store: it sends nothing");
    await passAll(cloud, [pc1, pc2, pc3]);

    for (const pc of [pc1, pc2, pc3]) {
      assert.equal(unitOf(pc, silver), "BAG", `${pc.name} counts it in BAG`);
      assert.deepEqual(balanceOf(pc, silver), { quantity: 28, unit: "BAG" }, `${pc.name}: 28 stays 28`);
      assert.equal(bhagNamed(pc), 0, `${pc.name}: nothing names BHAG`);
      assert.ok(!(pc.db.listInventoryUnits() as Array<{ code: string }>).some((unit) => unit.code === "BHAG"), `${pc.name} offers no BHAG`);
    }
    const notes = (pc2.db.db.prepare("SELECT note FROM inventory_stock_events WHERE item_id = ? ORDER BY created_at").all(silver) as Array<{ note: string }>).map((row) => row.note);
    assert.deepEqual(notes, ["Manual move in, 30 BHAG", "Manual move out, 2 BHAG"], "what was typed then is kept");
    const audit = pc2.db.db.prepare("SELECT action, new_value_json AS v FROM inventory_item_audit WHERE item_id = ? AND action = 'CORRECT_UNIT'").get(silver) as { action: string; v: string };
    assert.match(audit.v, /BHAG was a typo of BAG/);

    const latest = (type: string, id: string) => cloud.log.filter((change) => change.envelope.aggregateType === type && change.envelope.aggregateId === id).at(-1);
    const bag = (pc2.db.db.prepare("SELECT id FROM inventory_units WHERE code = 'BAG'").get() as { id: string }).id;
    assert.match(JSON.stringify(latest("INVENTORY_ITEM", silver)?.envelope.payload), new RegExp(`"default_unit_id":"${bag}"`), "the cloud's material says BAG");
    assert.match(JSON.stringify(latest("INVENTORY_UNIT", bhag)?.envelope.payload), /"is_active":0/, "the cloud's BHAG is switched off");

    // Run again: nothing more to do.
    migrate(pc2, sql);
    assert.equal(Number((pc2.db.db.prepare("SELECT COUNT(*) AS n FROM inventory_item_audit WHERE action = 'CORRECT_UNIT'").get() as { n: number }).n), 1);
  });
});
