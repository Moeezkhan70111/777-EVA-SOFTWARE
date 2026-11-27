import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEASED_AGGREGATE_DOMAIN, SqliteDatabase } from "@erp/data";
import { LEASE_DOMAIN, type LeaseDomain } from "@erp/domain";
import type { SyncEnvelope } from "./contract.js";
import { OutboxDrain } from "./drain.js";
import { SyncPull } from "./pull.js";
import type { SyncAck, SyncChange, SyncPullTransport, SyncTransport } from "./transport.js";

// BOWN ON HR-5 WAS NEVER A COLOUR (owner, 27 Nov 2026: remove it from the cloud so on every PC it is removed like it
// never existed). Local 120 deletes it on every computer where nothing names it, and PC1, holding MASTER_DATA, sends
// HR-5 again without it. Real writers, builders, outbox, drain, pull and appliers; the cloud is the stand-in of
// discountRulesSync.test.ts.

const SCHEMA = path.resolve(import.meta.dirname, "../../data/src/local-schema.sql");
const MIGRATION_120 = path.resolve(import.meta.dirname, "../../../migrations/sqlite/120_remove_hr5_bown.up.sql");
const PROJECT = "https://test.supabase.co";
const clock = { ms: Date.now() + 86_400_000 };
const nowIso = () => new Date(clock.ms).toISOString();

class Cloud {
  readonly log: SyncChange[] = [];
  readonly leases = new Map<LeaseDomain, { holder: string; epoch: number }>([
    [LEASE_DOMAIN.MASTER_DATA, { holder: "dev-pc1", epoch: 4 }],
    [LEASE_DOMAIN.PARTIES, { holder: "dev-pc1", epoch: 2 }],
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `erp-bown-${name}-`));
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

const coloursOf = (pc: Pc): string[] =>
  (pc.db.db.prepare("SELECT color FROM product_variants WHERE article = 'HR-5' ORDER BY color").all() as Array<{ color: string }>).map((row) => row.color);

/** HR-5 as the factory made it on PC1: BROWN, and the BOWN typed by mistake. */
function setUp(pc1: Pc): string {
  pc1.db.createProduct({ article: "HR-5", size: "7/10", sellingPrice: 550, machineRate: 70, packingRate: 30, colors: ["BROWN", "BOWN", "SKIN"], status: "ACTIVE" });
  return (pc1.db.db.prepare("SELECT id FROM article_sizes WHERE article = 'HR-5'").get() as { id: string }).id;
}

/** The newest HR-5 body the cloud holds: its colours. */
function cloudColours(cloud: Cloud, articleSizeId: string): string[] {
  const latest = cloud.log.filter((change) => change.envelope.aggregateType === "ARTICLE_SIZE" && change.envelope.aggregateId === articleSizeId).at(-1);
  assert.ok(latest, "the cloud holds HR-5");
  const text = JSON.stringify(latest.envelope.payload);
  return ["BOWN", "BROWN", "SKIN"].filter((colour) => text.includes(`"color":"${colour}"`));
}

test("120 removes BOWN on every computer and PC1 sends HR-5 without it, the other colours untouched", async () => {
  await withOffice(async (cloud, pc1, pc2, pc3) => {
    const sizeId = setUp(pc1);
    await passAll(cloud, [pc1, pc2, pc3]);
    assert.deepEqual(coloursOf(pc3), ["BOWN", "BROWN", "SKIN"], "as it was before 120");

    const migration = fs.readFileSync(MIGRATION_120, "utf8");
    pc1.db.db.exec(migration);
    assert.equal(Number((pc1.db.db.prepare("SELECT COUNT(*) AS n FROM sync_dirty_records WHERE aggregate_type = 'ARTICLE_SIZE'").get() as { n: number }).n), 1, "PC1 queues HR-5");
    // As in a real migration run, where the capture triggers are dropped: only 120's own marks count.
    const triggers = pc2.db.db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string; sql: string }>;
    for (const trigger of triggers) pc2.db.db.exec(`DROP TRIGGER ${trigger.name}`);
    pc2.db.db.exec(migration);
    for (const trigger of triggers) pc2.db.db.exec(trigger.sql);
    assert.equal(Number((pc2.db.db.prepare("SELECT COUNT(*) AS n FROM sync_dirty_records").get() as { n: number }).n), 0, "PC2 does not hold MASTER_DATA: it queues nothing");
    await passAll(cloud, [pc1, pc2, pc3]);

    for (const pc of [pc1, pc2, pc3]) {
      assert.deepEqual(coloursOf(pc), ["BROWN", "SKIN"], `${pc.name} holds no BOWN, not even a deleted one`);
    }
    assert.deepEqual(cloudColours(cloud, sizeId), ["BROWN", "SKIN"], "the cloud's newest HR-5 has no BOWN");
  });
});

test("120 keeps BOWN where anything names it, and changes nothing there", async () => {
  await withOffice(async (cloud, pc1, pc2, pc3) => {
    const sizeId = setUp(pc1);
    pc1.db.cartonQrOnHold = true;
    pc1.db.postCartonStockAdjustment({
      requestId: crypto.randomUUID(), kind: "ADJUSTMENT", businessDate: "2026-11-27", reason: "Count", remarks: null,
      lines: [{ articleSizeId: sizeId, color: "BOWN", cartons: 1, direction: "IN" }], postedBy: "owner", workstationId: "ws-pc1", storeLocationId: "factory-777",
    });
    await passAll(cloud, [pc1, pc2, pc3]);
    pc1.db.db.exec("DELETE FROM sync_dirty_records");

    pc1.db.db.exec(fs.readFileSync(MIGRATION_120, "utf8"));
    assert.deepEqual(coloursOf(pc1), ["BOWN", "BROWN", "SKIN"], "an adjustment names it: kept");
    assert.equal(Number((pc1.db.db.prepare("SELECT COUNT(*) AS n FROM sync_dirty_records").get() as { n: number }).n), 0, "nothing queued");
  });
});
