import test from "node:test";
import { activateCartonCloudForTest } from "@erp/data/dist/testing/cartonCloud.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase, buildCartonStockEvents } from "@erp/data";
import { CARTON_QR_ON_HOLD, LEASE_DOMAIN, type LeaseDomain } from "@erp/domain";
import type { SyncEnvelope } from "./contract.js";
import { OutboxDrain } from "./drain.js";
import { leaseWriteDecision } from "./leases.js";
import { parkedSummary } from "./parking.js";
import { SyncPull } from "./pull.js";
import type { SyncAck, SyncChange, SyncPullTransport, SyncTransport } from "./transport.js";

// STOCK ADJUSTMENT DOCUMENTS ACROSS THE OFFICE (docs/46): PC1 posts, the cloud takes it once, PC2 and PC3 receive the
// document and the figure, a replay adds nothing. Real writers, capture triggers, builders, outbox, drain, pull and
// appliers; the cloud is a stand-in holding to push_leased_record's and push_carton_stock_event's rules: one dedupe
// key is one event, only the current lease holder at the current epoch is accepted, and a type the cloud does not
// know (030 not applied) is answered UNKNOWN_RECORD_TYPE.

const SCHEMA = path.resolve(import.meta.dirname, "../../data/src/local-schema.sql");
const PROJECT = "https://test.supabase.co";
const STORE = "factory-777";
const clock = { ms: Date.now() + 86_400_000 };
const nowIso = () => new Date(clock.ms).toISOString();
const LEASES: readonly LeaseDomain[] = [LEASE_DOMAIN.MASTER_DATA, LEASE_DOMAIN.CARTON_STOCK, LEASE_DOMAIN.RAW_MATERIAL_STORE];
const DOMAIN_OF: Readonly<Record<string, LeaseDomain>> = {
  ARTICLE_SIZE: LEASE_DOMAIN.MASTER_DATA,
  CARTON_STOCK_EVENT: LEASE_DOMAIN.CARTON_STOCK,
  CARTON_STOCK_ADJUSTMENT: LEASE_DOMAIN.CARTON_STOCK,
  STOCK_EVENT: LEASE_DOMAIN.RAW_MATERIAL_STORE,
};

class Cloud {
  readonly log: SyncChange[] = [];
  readonly received: SyncEnvelope[] = [];
  knowsAdjustments = true;
  readonly leases = new Map<LeaseDomain, { holder: string; epoch: number }>([
    [LEASE_DOMAIN.MASTER_DATA, { holder: "dev-pc1", epoch: 2 }],
    [LEASE_DOMAIN.CARTON_STOCK, { holder: "dev-pc1", epoch: 2 }],
    [LEASE_DOMAIN.RAW_MATERIAL_STORE, { holder: "dev-pc2", epoch: 1 }],
  ]);

  deliverAgain(): void {
    for (const change of [...this.log]) this.log.push({ seq: this.log.length + 1, envelope: change.envelope });
  }

  private accept(envelope: SyncEnvelope, device: string): SyncAck {
    this.received.push(envelope);
    if (envelope.aggregateType === "CARTON_STOCK_ADJUSTMENT" && !this.knowsAdjustments) {
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `erp-sa-${name}-`));
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
  clock.ms += 3_600_000;
}

const passAll = async (cloud: Cloud, pcs: readonly Pc[]) => {
  for (let round = 0; round < 3; round += 1) for (const pc of pcs) await pass(pc, cloud);
};

interface Office { readonly cloud: Cloud; readonly pc1: Pc; readonly pc2: Pc; readonly pc3: Pc; readonly sku: (size: string) => string }

async function withOffice(work: (office: Office) => Promise<void>): Promise<void> {
  const cloud = new Cloud();
  const pcs = [openPc("pc1", 1), openPc("pc2", 2), openPc("pc3", 3)] as const;
  const [pc1, pc2, pc3] = pcs;
  for (const pc of pcs) hearLeases(pc, cloud);
  try {
    for (const size of ["7/10", "10/13"]) {
      pc1.db.createProduct({ article: "SK6", size, sellingPrice: 550, machineRate: 70, packingRate: 30, colors: ["RED"], createdBy: "owner" } as never);
    }
    await passAll(cloud, pcs);
    const sku = (size: string) => (pc1.db.db.prepare("SELECT id FROM article_sizes WHERE article = 'SK6' AND size = ?").get(size) as { id: string }).id;
    await work({ cloud, pc1, pc2, pc3, sku });
  } finally {
    for (const pc of pcs) {
      pc.db.close();
      fs.rmSync(pc.dir, { recursive: true, force: true });
    }
  }
}

const post = (pc: Pc, kind: string, lines: Array<{ articleSizeId: string; color: string; direction: string; cartons: number }>, requestId: string = crypto.randomUUID()) =>
  pc.db.postCartonStockAdjustment({ requestId, kind, businessDate: "2026-11-11", reason: "Physical count", lines, postedBy: "owner", workstationId: `ws-${pc.name}`, storeLocationId: STORE });
const figure = (pc: Pc, size: string): number => pc.db.cartonAdjustmentArticle("SK6").find((c) => c.size === size && c.color === "RED")?.inStore ?? Number.NaN;
const count = (pc: Pc, sql: string): number => Number((pc.db.db.prepare(sql).get() as { n: number }).n);

test("PC1 posts opening stock and an adjustment; the cloud takes each once; PC2 and PC3 get the documents and the figure", async () => {
  await withOffice(async ({ cloud, pc1, pc2, pc3, sku }) => {
    const opening = post(pc1, "OPENING", [{ articleSizeId: sku("7/10"), color: "RED", direction: "IN", cartons: 20 }, { articleSizeId: sku("10/13"), color: "RED", direction: "IN", cartons: 35 }]);
    const adjustment = post(pc1, "ADJUSTMENT", [{ articleSizeId: sku("7/10"), color: "RED", direction: "OUT", cartons: 3 }]);
    await passAll(cloud, [pc1, pc2, pc3]);

    assert.equal(cloud.log.filter((c) => c.envelope.aggregateType === "CARTON_STOCK_ADJUSTMENT").length, 2, "two documents, once each");
    assert.equal(cloud.log.filter((c) => c.envelope.aggregateType === "CARTON_STOCK_EVENT").length, 3, "three movements, once each");
    assert.equal(cloud.log.filter((c) => c.envelope.aggregateType === "STOCK_EVENT").length, 0, "nothing of the raw material store");
    for (const pc of [pc1, pc2, pc3]) {
      assert.equal(figure(pc, "7/10"), 17, `${pc.name} 7/10`);
      assert.equal(figure(pc, "10/13"), 35, `${pc.name} 10/13`);
      assert.equal(parkedSummary(pc.db.db).count, 0, `${pc.name} has nothing parked`);
    }
    for (const pc of [pc2, pc3]) {
      const page = pc.db.listCartonStockAdjustments();
      assert.deepEqual(page.documents.map((d) => `${d.code} ${d.kind} +${d.cartonsIn} -${d.cartonsOut}`), [`${adjustment.document.code} ADJUSTMENT +0 -3`, `${opening.document.code} OPENING +55 -0`]);
      assert.deepEqual(
        page.documents[1]?.lines.map((l) => l.eventId),
        opening.document.lines.map((l) => l.eventId),
        "each line names the same movement on every computer"
      );
      assert.equal(pc.db.cartonAdjustmentArticle("SK6").find((c) => c.size === "7/10")?.hasOpening, true, `${pc.name} knows 7/10 has opening stock`);
    }
  });
});

test("replay, restart-style re-reading and a retried Post add nothing", async () => {
  await withOffice(async ({ cloud, pc1, pc2, pc3, sku }) => {
    const requestId = crypto.randomUUID();
    post(pc1, "OPENING", [{ articleSizeId: sku("7/10"), color: "RED", direction: "IN", cartons: 20 }], requestId);
    post(pc1, "OPENING", [{ articleSizeId: sku("7/10"), color: "RED", direction: "IN", cartons: 20 }], requestId);
    await passAll(cloud, [pc1, pc2, pc3]);
    cloud.deliverAgain();
    for (const pc of [pc2, pc3]) pc.db.db.prepare("DELETE FROM app_settings WHERE setting_key = 'sync.pull.cursor'").run();
    await passAll(cloud, [pc1, pc2, pc3]);
    for (const pc of [pc1, pc2, pc3]) {
      assert.equal(figure(pc, "7/10"), 20, pc.name);
      assert.equal(count(pc, "SELECT COUNT(*) AS n FROM carton_stock_events"), 1, `${pc.name}: one movement`);
      assert.equal(count(pc, "SELECT COUNT(*) AS n FROM carton_stock_adjustments"), 1, `${pc.name}: one document`);
    }
  });
});

test("only the CARTON_STOCK holder may post: PC2 and PC3 are refused by the lease, and the raw material lease is not asked", async () => {
  await withOffice(async ({ pc1, pc2, pc3 }) => {
    const decide = (pc: Pc, domain: LeaseDomain) => leaseWriteDecision(pc.db.db, { domain, deviceId: pc.device, syncConfigured: true });
    assert.equal(decide(pc1, LEASE_DOMAIN.CARTON_STOCK).allowed, true);
    for (const pc of [pc2, pc3]) {
      const refused = decide(pc, LEASE_DOMAIN.CARTON_STOCK);
      assert.equal(refused.allowed, false);
      assert.equal(refused.allowed === false && refused.reason, "HELD_ELSEWHERE");
    }
    assert.equal(decide(pc1, LEASE_DOMAIN.RAW_MATERIAL_STORE).allowed, false, "PC1 does not hold the store, and posting never needs it");
  });
});

test("before cloud 030, the document waits as UNKNOWN_RECORD_TYPE while its movements travel; after it, the document follows", async () => {
  await withOffice(async ({ cloud, pc1, pc2, pc3, sku }) => {
    cloud.knowsAdjustments = false;
    post(pc1, "OPENING", [{ articleSizeId: sku("7/10"), color: "RED", direction: "IN", cartons: 20 }]);
    await passAll(cloud, [pc1, pc2, pc3]);
    assert.equal(figure(pc2, "7/10"), 20, "the figure arrives without the document");
    assert.equal(count(pc2, "SELECT COUNT(*) AS n FROM carton_stock_adjustments"), 0);
    assert.equal(count(pc1, "SELECT COUNT(*) AS n FROM sync_outbox WHERE aggregate_type = 'CARTON_STOCK_ADJUSTMENT' AND status IN ('PENDING', 'FAILED')"), 1, "still queued, not lost");

    cloud.knowsAdjustments = true;
    await passAll(cloud, [pc1, pc2, pc3]);
    for (const pc of [pc2, pc3]) {
      assert.equal(count(pc, "SELECT COUNT(*) AS n FROM carton_stock_adjustments"), 1, `${pc.name} has the document`);
      assert.equal(figure(pc, "7/10"), 20, `${pc.name} figure unchanged by the document`);
    }
  });
});
