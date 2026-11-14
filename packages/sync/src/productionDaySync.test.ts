import test from "node:test";
import { activateCartonCloudForTest } from "@erp/data/dist/testing/cartonCloud.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddMachineUseCase, InMemoryEventBus } from "@erp/application";
import { SqliteDatabase, buildCartonStockEvents } from "@erp/data";
import { CARTON_QR_ON_HOLD, LEASE_DOMAIN, businessToday, productionDayId, type LeaseDomain } from "@erp/domain";
import type { SyncEnvelope } from "./contract.js";
import { OutboxDrain } from "./drain.js";
import { parkedSummary } from "./parking.js";
import { SyncPull } from "./pull.js";
import type { SyncAck, SyncChange, SyncPullTransport, SyncTransport } from "./transport.js";

// "COMPLETE TODAY'S PRODUCTION" ACROSS THE OFFICE (docs/48): PC1 saves the day's production and completes the day;
// the cloud takes the mark once; PC2 and PC3 receive it, so their Carton Stock says Production added; a replay adds
// nothing. Before cloud 032 the mark waits as UNKNOWN_RECORD_TYPE while the production itself travels. Real writers,
// capture triggers, builders, outbox, drain, pull and appliers; the cloud is a stand-in holding to push_leased_record's
// rules, as in cartonStockDocuments.test.ts.

const SCHEMA = path.resolve(import.meta.dirname, "../../data/src/local-schema.sql");
const PROJECT = "https://test.supabase.co";
const STORE = "factory-777";
const clock = { ms: Date.now() };
const nowIso = () => new Date(clock.ms).toISOString();
const DOMAIN_OF: Readonly<Record<string, LeaseDomain>> = {
  ARTICLE_SIZE: LEASE_DOMAIN.MASTER_DATA,
  PARTY: LEASE_DOMAIN.MASTER_DATA,
  PARTY_GROUP: LEASE_DOMAIN.MASTER_DATA,
  MACHINE: LEASE_DOMAIN.MASTER_DATA,
  WORK_SECTION: LEASE_DOMAIN.MASTER_DATA,
  CARTON_STOCK_EVENT: LEASE_DOMAIN.CARTON_STOCK,
  MANUAL_PRODUCTION_ENTRY: LEASE_DOMAIN.CARTON_STOCK,
  PRODUCTION_DAY: LEASE_DOMAIN.CARTON_STOCK,
};

class Cloud {
  readonly log: SyncChange[] = [];
  knowsProductionDays = true;
  readonly leases = new Map<LeaseDomain, { holder: string; epoch: number }>([
    [LEASE_DOMAIN.MASTER_DATA, { holder: "dev-pc1", epoch: 2 }],
    [LEASE_DOMAIN.CARTON_STOCK, { holder: "dev-pc1", epoch: 2 }],
    [LEASE_DOMAIN.RAW_MATERIAL_STORE, { holder: "dev-pc2", epoch: 1 }],
  ]);

  deliverAgain(): void {
    for (const change of [...this.log]) this.log.push({ seq: this.log.length + 1, envelope: change.envelope });
  }

  private accept(envelope: SyncEnvelope, device: string): SyncAck {
    if (envelope.aggregateType === "PRODUCTION_DAY" && !this.knowsProductionDays) {
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `erp-pd-${name}-`));
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

interface Office { readonly cloud: Cloud; readonly pcs: readonly [Pc, Pc, Pc]; readonly produce: (dozens: string) => void }

async function withOffice(work: (office: Office) => Promise<void>): Promise<void> {
  const cloud = new Cloud();
  const pcs = [openPc("pc1", 1), openPc("pc2", 2), openPc("pc3", 3)] as const;
  const [pc1] = pcs;
  for (const pc of pcs) hearLeases(pc, cloud);
  try {
    pc1.db.createProduct({ article: "SK6", size: "7/10", sellingPrice: 550, machineRate: 70, packingRate: 30, colors: ["RED"], status: "ACTIVE" } as never);
    const contractor = (name: string, mobile: string) => pc1.db.createParty({ partyName: name, partyType: "CONTRACTOR", city: "Lahore", mobileNumber: mobile, status: "ACTIVE" });
    const [aslam, babar] = [contractor("ASLAM", "0300-1111111"), contractor("BABAR", "0300-2222222")];
    const deps = { txManager: pc1.db, repo: pc1.db, eventPublisher: new InMemoryEventBus(), idGenerator: { nextId: () => crypto.randomUUID() } };
    const machineId = (await new AddMachineUseCase(deps).execute({ name: "Machine 1", contractorPartyId: aslam, packingContractorPartyId: babar, actor: "admin" })).machineId!;
    const sk6 = (pc1.db.db.prepare("SELECT id FROM article_sizes WHERE article = 'SK6'").get() as { id: string }).id;
    await passAll(cloud, pcs);
    const produce = (dozens: string) => {
      pc1.db.recordManualProductionBatch({ lines: [{ requestId: crypto.randomUUID(), machineId, articleSizeId: sk6, color: "RED", dozens }], storeLocationId: STORE, createdBy: "aslam" });
    };
    await work({ cloud, pcs, produce });
  } finally {
    for (const pc of pcs) {
      pc.db.close();
      fs.rmSync(pc.dir, { recursive: true, force: true });
    }
  }
}

const count = (pc: Pc, sql: string): number => Number((pc.db.db.prepare(sql).get() as { n: number }).n);

test("PC1 completes today's production; the cloud takes it once; PC2 and PC3 then say Production added", async () => {
  await withOffice(async ({ cloud, pcs, produce }) => {
    const [pc1, pc2, pc3] = pcs;
    produce("10");
    await passAll(cloud, pcs);
    for (const pc of [pc2, pc3]) assert.equal(pc.db.productionDayMark(businessToday()), null, `${pc.name}: not added until completed`);

    pc1.db.completeProductionDay({ completedBy: "aslam" });
    await passAll(cloud, pcs);
    assert.equal(cloud.log.filter((change) => change.envelope.aggregateType === "PRODUCTION_DAY").length, 1, "the mark, once");
    for (const pc of [pc1, pc2, pc3]) {
      const mark = pc.db.productionDayMark(businessToday());
      assert.deepEqual([mark?.completedBy, mark?.cartons, mark?.entries], ["aslam", 20, 1], pc.name);
      assert.equal(pc.db.productionDayView(businessToday())?.totalCartons, 20, `${pc.name} reads the day's production`);
      assert.equal(parkedSummary(pc.db.db).count, 0, `${pc.name} has nothing parked`);
    }
  });
});

test("a replay, and re-reading everything, add nothing", async () => {
  await withOffice(async ({ cloud, pcs, produce }) => {
    const [pc1, pc2, pc3] = pcs;
    produce("1");
    pc1.db.completeProductionDay({ completedBy: "aslam" });
    await passAll(cloud, pcs);
    cloud.deliverAgain();
    for (const pc of [pc2, pc3]) pc.db.db.prepare("DELETE FROM app_settings WHERE setting_key = 'sync.pull.cursor'").run();
    await passAll(cloud, pcs);
    for (const pc of pcs) {
      assert.equal(count(pc, "SELECT COUNT(*) AS n FROM production_days"), 1, pc.name);
      assert.equal((pc.db.db.prepare("SELECT id FROM production_days").get() as { id: string }).id, productionDayId(businessToday()));
    }
  });
});

test("before cloud 032 the mark waits as UNKNOWN_RECORD_TYPE while the production travels; after it, the mark follows", async () => {
  await withOffice(async ({ cloud, pcs, produce }) => {
    const [pc1, pc2] = pcs;
    cloud.knowsProductionDays = false;
    produce("10");
    pc1.db.completeProductionDay({ completedBy: "aslam" });
    await passAll(cloud, pcs);
    assert.equal(pc2.db.productionDayView(businessToday())?.totalCartons, 20, "the production arrives without the mark");
    assert.equal(pc2.db.productionDayMark(businessToday()), null, "PC2 still says Production not added");
    assert.equal(count(pc1, "SELECT COUNT(*) AS n FROM sync_outbox WHERE aggregate_type = 'PRODUCTION_DAY' AND status IN ('PENDING', 'FAILED')"), 1, "queued, not lost");

    cloud.knowsProductionDays = true;
    clock.ms += 3_600_000;
    await passAll(cloud, pcs);
    assert.equal(pc2.db.productionDayMark(businessToday())?.completedBy, "aslam", "then PC2 says Production added");
  });
});
