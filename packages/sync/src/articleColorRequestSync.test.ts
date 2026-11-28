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

// A NEW COLOUR ASKED FOR ON THE BOSS'S COMPUTER (owner, 27 Nov 2026: "MAKE BOSS PC CAN ALSO ADD NEW COLOR IN ENTER
// ORDERS", "AUTO ACCEPT IT FROM PC1"). PC1 holds MASTER_DATA, PC3 holds ORDERS. PC3 writes a request, PC1 adds the
// colour by itself after the pull that brings it, in the same pass, and every computer then has it. Real writers,
// builders, outbox, drain, pull and appliers; the cloud is the stand-in of discountRulesSync.test.ts.

const SCHEMA = path.resolve(import.meta.dirname, "../../data/src/local-schema.sql");
const PROJECT = "https://test.supabase.co";
const clock = { ms: Date.now() + 86_400_000 };
const nowIso = () => new Date(clock.ms).toISOString();

class Cloud {
  readonly log: SyncChange[] = [];
  readonly leases = new Map<LeaseDomain, { holder: string; epoch: number }>([
    [LEASE_DOMAIN.MASTER_DATA, { holder: "dev-pc1", epoch: 4 }],
    [LEASE_DOMAIN.PARTIES, { holder: "dev-pc1", epoch: 2 }],
    [LEASE_DOMAIN.ORDERS, { holder: "dev-pc3", epoch: 5 }],
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `erp-colour-requests-${name}-`));
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
  // As cloudSyncPass.ts: requests first, then every colour of an article onto all its sizes.
  if (pc.db.applyArticleColorRequests(nowIso()) + pc.db.fillArticleColourGaps() > 0) {
    pc.db.buildLeasedRecordRevisions(nowIso());
    await new OutboxDrain(pc.db.db, transport, { deviceId: pc.device, now: nowIso, retryPolicy }).runOnce();
  }
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
  (pc.db.db.prepare("SELECT color FROM product_variants WHERE article = 'HR-5' AND deleted_at IS NULL ORDER BY color, size").all() as Array<{ color: string }>).map((row) => row.color);

test("a colour asked for on PC3 is added by PC1 by itself, on every size, and reaches every computer", async () => {
  await withOffice(async (cloud, pc1, pc2, pc3) => {
    for (const size of ["7/10", "10/13"]) {
      pc1.db.createProduct({ article: "HR-5", size, sellingPrice: 550, machineRate: 70, packingRate: 30, colors: ["BROWN"], status: "ACTIVE" });
    }
    await passAll(cloud, [pc1, pc2, pc3]);
    assert.deepEqual(coloursOf(pc3), ["BROWN", "BROWN"]);

    assert.deepEqual(pc3.db.requestArticleColor({ article: "hr-5", color: " black  mustard ", actor: "boss" }), { status: "REQUESTED", color: "BLACK MUSTARD" });
    assert.deepEqual(pc3.db.requestArticleColor({ article: "HR-5", color: "BLACKMUSTARD", actor: "boss" }), { status: "REQUESTED", color: "BLACKMUSTARD" }, "asked again");
    assert.equal(Number((pc3.db.db.prepare("SELECT COUNT(*) AS n FROM article_color_requests").get() as { n: number }).n), 1, "one request, however often asked");
    assert.deepEqual(coloursOf(pc3), ["BROWN", "BROWN"], "PC3 does not write Product Master");
    await passAll(cloud, [pc1, pc2, pc3]);

    for (const pc of [pc1, pc2, pc3]) assert.deepEqual(coloursOf(pc), ["BLACK MUSTARD", "BLACK MUSTARD", "BROWN", "BROWN"], `${pc.name} has it on both sizes`);
    assert.equal(pc1.db.applyArticleColorRequests(nowIso()), 0, "dealt with once");
    assert.deepEqual(pc3.db.requestArticleColor({ article: "HR-5", color: "black mustard" }), { status: "ALREADY_THERE", color: "BLACK MUSTARD" });
  });
});

test("nowhere but the Product Master computer adds a requested colour, and a refused one is noted, not retried", async () => {
  await withOffice(async (cloud, pc1, pc2, pc3) => {
    pc1.db.createProduct({ article: "HR-5", size: "7/10", sellingPrice: 550, machineRate: 70, packingRate: 30, colors: ["BROWN"], status: "ACTIVE" });
    await passAll(cloud, [pc1, pc2, pc3]);
    pc3.db.requestArticleColor({ article: "HR-5", color: "WHITE", actor: "boss" });
    assert.equal(pc3.db.applyArticleColorRequests(nowIso()), 0, "PC3 does not hold MASTER_DATA");
    assert.equal(pc2.db.applyArticleColorRequests(nowIso()), 0);

    assert.throws(() => pc3.db.requestArticleColor({ article: "ZZ-9", color: "WHITE" }), /ZZ-9 has no active sizes/);
    assert.throws(() => pc3.db.requestArticleColor({ article: "HR-5", color: "n/a" }), /real colour name/);

    // A request for an article that went away before PC1 saw it.
    pc3.db.db.prepare("INSERT INTO article_color_requests (id, article, color, created_at, updated_at) VALUES ('gone', 'OLD-1', 'RED', 'x', 'x')").run();
    await passAll(cloud, [pc1, pc2, pc3]);
    const noted = pc1.db.db.prepare("SELECT refusal FROM article_color_request_results WHERE request_id = 'gone'").get() as { refusal: string };
    assert.match(noted.refusal, /OLD-1 has no active sizes/);
    assert.deepEqual(coloursOf(pc2), ["BROWN", "WHITE"]);
  });
});

// Owner, 28 Nov 2026: "if a color is in one size, it is available in all of its sizes".
test("PC1 puts every colour of an article on all its sizes by itself, and every computer gets them", async () => {
  await withOffice(async (cloud, pc1, pc2, pc3) => {
    pc1.db.createProduct({ article: "SK30", size: "7/10", sellingPrice: 550, machineRate: 70, packingRate: 30, colors: ["BROWN", "BLACK GREY"], status: "ACTIVE" });
    pc1.db.createProduct({ article: "SK30", size: "4/6", sellingPrice: 470, machineRate: 70, packingRate: 30, colors: ["BLACKGREY"], status: "ACTIVE" });
    assert.equal(pc2.db.fillArticleColourGaps(), 0, "PC2 does not write Product Master");
    await passAll(cloud, [pc1, pc2, pc3]);

    const sk30 = (pc: Pc) => (pc.db.db.prepare("SELECT size || ' ' || color AS v FROM product_variants WHERE article = 'SK30' AND deleted_at IS NULL ORDER BY size, color").all() as Array<{ v: string }>).map((row) => row.v);
    // BROWN reaches 4/6; BLACKGREY and BLACK GREY are one colour as a QR reads it, so neither is added twice.
    for (const pc of [pc1, pc2, pc3]) assert.deepEqual(sk30(pc), ["4/6 BLACKGREY", "4/6 BROWN", "7/10 BLACK GREY", "7/10 BROWN"], pc.name);
    assert.equal(pc1.db.fillArticleColourGaps(), 0, "nothing left to fill");
  });
});

// Owner, 28 Nov 2026: "give an option to edit a color name in all the places where it is needed".
test("a colour renamed on PC1 keeps its products, takes the name on every size, and every computer gets it", async () => {
  await withOffice(async (cloud, pc1, pc2, pc3) => {
    for (const size of ["7/10", "4/6"]) {
      pc1.db.createProduct({ article: "SK31", size, sellingPrice: 520, machineRate: 70, packingRate: 30, colors: ["BOWN", "BLACKGREY"], status: "ACTIVE" });
    }
    await passAll(cloud, [pc1, pc2, pc3]);
    const ids = (pc: Pc, color: string) => (pc.db.db.prepare("SELECT id FROM product_variants WHERE article = 'SK31' AND color = ? ORDER BY size").all(color) as Array<{ id: string }>).map((row) => row.id);
    const before = ids(pc1, "BOWN");

    assert.deepEqual(pc1.db.renameColorOnArticle({ article: "sk31", from: "bown", to: " brown " }), { from: "BOWN", color: "BROWN", renamed: 2 });
    // The same colour respelled is allowed; another colour of the article's name is not, nor no change at all.
    assert.equal(pc1.db.renameColorOnArticle({ article: "SK31", from: "BLACKGREY", to: "BLACK GREY" }).renamed, 2);
    assert.throws(() => pc1.db.renameColorOnArticle({ article: "SK31", from: "BROWN", to: "blackgrey" }), /already has BLACK GREY/);
    assert.throws(() => pc1.db.renameColorOnArticle({ article: "SK31", from: "BROWN", to: "brown" }), /already has that name/);
    assert.throws(() => pc1.db.renameColorOnArticle({ article: "SK31", from: "RED", to: "BLUE" }), /has no colour RED/);
    await passAll(cloud, [pc1, pc2, pc3]);

    for (const pc of [pc1, pc2, pc3]) {
      assert.deepEqual(ids(pc, "BROWN"), before, `${pc.name}: the same products, renamed`);
      assert.deepEqual(ids(pc, "BOWN"), [], pc.name);
      assert.equal(ids(pc, "BLACK GREY").length, 2, pc.name);
    }
    // The old name given again later is a colour of its own, with new products.
    assert.equal(pc1.db.addColorToArticle({ article: "SK31", color: "BOWN" }).added, 2);
    assert.equal(ids(pc1, "BOWN").filter((id) => before.includes(id)).length, 0);
  });
});
