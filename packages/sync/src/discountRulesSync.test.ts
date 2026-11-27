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

// A CUSTOMER'S DISCOUNT RULES TRAVEL WITH THE CUSTOMER (owner, 27 Nov 2026: "make discount policies sync to the cloud").
// The factory's assignment: PC1 holds MASTER_DATA and PARTIES and makes the bills, PC2 and PC3 read. Real writers,
// capture triggers, builders, outbox, drain, pull and appliers; the cloud is a stand-in holding to push_leased_record's
// rule (a record only from the holder of its type's lease, at that lease's epoch). No cloud change is needed: the rules
// ride inside the PARTY record, which the cloud already takes.

const SCHEMA = path.resolve(import.meta.dirname, "../../data/src/local-schema.sql");
const MIGRATION_119 = path.resolve(import.meta.dirname, "../../../migrations/sqlite/119_discount_rules_travel.up.sql");
const MIGRATION_122 = path.resolve(import.meta.dirname, "../../../migrations/sqlite/122_discount_rules_again.up.sql");
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `erp-discounts-${name}-`));
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

/** Every rule a computer holds, live or deleted, in one comparable list. */
function rulesOf(pc: Pc): string[] {
  const rows = (sql: string) => (pc.db.db.prepare(sql).all() as Array<Record<string, unknown>>).map((row) => JSON.stringify(row));
  return [
    ...rows("SELECT 'group' AS k, id, party_id, product_group_id, discount_per_pair_paisa, deleted_at FROM party_product_group_discounts ORDER BY id"),
    ...rows("SELECT 'series' AS k, id, party_id, article_series_id, discount_per_pair_paisa, deleted_at FROM party_article_series_discounts ORDER BY id"),
    ...rows("SELECT 'article' AS k, id, party_id, article, size_scope, size, discount_per_pair_paisa, deleted_at FROM party_article_discounts ORDER BY id"),
    ...rows("SELECT 'range' AS k, id, party_id, start_price_paisa, end_price_paisa, discount_per_pair_paisa, deleted_at FROM party_price_range_discounts ORDER BY id"),
  ];
}

/** PC1's catalogue and one customer, made the ordinary way. */
function setUp(pc1: Pc): { groupId: string; seriesId: string; partyId: string } {
  const groupId = pc1.db.createProductGroup({ groupName: "EVR GENTS" });
  const seriesId = pc1.db.createArticleSeries({ name: "X SERIES" });
  pc1.db.createProduct({ article: "SK6", size: "7/10", sellingPrice: 550, machineRate: 70, packingRate: 30, colors: ["RED"], status: "ACTIVE", productGroupId: groupId } as never);
  const partyId = pc1.db.createParty({ partyName: "ABDUL GHANI HYDERABAD", partyType: "CUSTOMER", city: "Hyderabad", mobileNumber: "0300-1111111", status: "ACTIVE" });
  return { groupId, seriesId, partyId };
}

test("rules made on PC1 reach PC2 and PC3 exactly, all four kinds, and resolve the same discount there", async () => {
  await withOffice(async (cloud, pc1, pc2, pc3) => {
    const { groupId, seriesId, partyId } = setUp(pc1);
    pc1.db.createPartyProductGroupDiscount({ partyId, productGroupId: groupId, discountPerPair: 12 });
    pc1.db.createPartyArticleSeriesDiscount({ partyId, articleSeriesId: seriesId, discountPerPair: 9.5 });
    pc1.db.createPartyArticleDiscount({ partyId, article: "SK6", discountPerPair: 15 });
    pc1.db.createPartyPriceRangeDiscount({ partyId, startPrice: 100, endPrice: 300, discountPerPair: 5 });
    await passAll(cloud, [pc1, pc2, pc3]);

    assert.equal(rulesOf(pc1).length, 4);
    assert.deepEqual(rulesOf(pc2), rulesOf(pc1), "PC2 holds PC1's rules");
    assert.deepEqual(rulesOf(pc3), rulesOf(pc1), "PC3 holds PC1's rules");
    const asked = { partyId, productGroupId: groupId };
    assert.deepEqual(pc3.db.resolveDiscount(asked), pc1.db.resolveDiscount(asked), "the same discount on a bill anywhere");
    assert.equal(pc3.db.resolveDiscount(asked).discountPerPair, 12);
  });
});

test("a changed or deleted rule follows, and a receiver holds exactly PC1's rules for the customer", async () => {
  await withOffice(async (cloud, pc1, pc2, pc3) => {
    const { groupId, partyId } = setUp(pc1);
    const ruleId = pc1.db.createPartyProductGroupDiscount({ partyId, productGroupId: groupId, discountPerPair: 12 });
    pc1.db.createPartyPriceRangeDiscount({ partyId, startPrice: 100, endPrice: 300, discountPerPair: 5 });
    await passAll(cloud, [pc1, pc2, pc3]);

    pc1.db.createPartyProductGroupDiscount({ partyId, productGroupId: groupId, discountPerPair: 14 });
    const range = (pc1.db.db.prepare("SELECT id FROM party_price_range_discounts").get() as { id: string }).id;
    pc1.db.deletePartyPriceRangeDiscount(range);
    await passAll(cloud, [pc1, pc2, pc3]);

    assert.deepEqual(rulesOf(pc3), rulesOf(pc1));
    assert.equal(Number((pc3.db.db.prepare("SELECT discount_per_pair_paisa AS v FROM party_product_group_discounts WHERE id = ?").get(ruleId) as { v: number }).v), 1400);
    assert.ok((pc3.db.db.prepare("SELECT deleted_at AS v FROM party_price_range_discounts WHERE id = ?").get(range) as { v: string | null }).v, "deleted there too");
  });
});

test("rules saved before this build go up once from PC1 (local 119), and nowhere else queues them", async () => {
  await withOffice(async (cloud, pc1, pc2, pc3) => {
    const { groupId, partyId } = setUp(pc1);
    await passAll(cloud, [pc1, pc2, pc3]);
    // As before this build: rules written, never marked for sending.
    pc1.db.createPartyProductGroupDiscount({ partyId, productGroupId: groupId, discountPerPair: 12 });
    pc1.db.db.exec("DELETE FROM sync_dirty_records");
    pc2.db.db.prepare(
      "INSERT INTO party_product_group_discounts (id, party_id, product_group_id, discount_per_pair_paisa, created_at, updated_at) VALUES ('pc2-own', ?, ?, 700, 'x', 'x')"
    ).run(partyId, groupId);
    pc2.db.db.exec("DELETE FROM sync_dirty_records");
    await passAll(cloud, [pc1, pc2, pc3]);
    assert.equal(rulesOf(pc3).length, 0, "nothing went before 119");

    const migration = fs.readFileSync(MIGRATION_119, "utf8");
    pc1.db.db.exec(migration);
    pc2.db.db.exec(migration);
    assert.equal(Number((pc2.db.db.prepare("SELECT COUNT(*) AS n FROM sync_dirty_records").get() as { n: number }).n), 0, "PC2 does not hold PARTIES: it queues nothing");
    await passAll(cloud, [pc1, pc2, pc3]);

    assert.deepEqual(rulesOf(pc3), rulesOf(pc1), "PC1's rule reached PC3");
    assert.deepEqual(rulesOf(pc2), rulesOf(pc1), "PC2 now holds PC1's rules for the customer, as every computer does");
  });
});

// Owner, 27 Nov 2026: "PC3 SHOWS NOTHING IN DISCOUNT POLICY". PC3 read the customers 119 sent while still on an older
// build, which kept each customer and dropped its rules, and it never reads a revision twice. 122 sends them again.
test("a computer that read the customers without their rules gets them when 122 sends them again from PC1", async () => {
  await withOffice(async (cloud, pc1, pc2, pc3) => {
    const { groupId, partyId } = setUp(pc1);
    pc1.db.createPartyProductGroupDiscount({ partyId, productGroupId: groupId, discountPerPair: 12 });
    await passAll(cloud, [pc1, pc2, pc3]);
    // As the older build left PC3: the customer at its latest revision, and none of its rules.
    pc3.db.db.exec("DELETE FROM party_product_group_discounts");
    pc3.db.db.exec("DELETE FROM sync_dirty_records");
    await passAll(cloud, [pc1, pc2, pc3]);
    assert.equal(rulesOf(pc3).length, 0, "nothing comes on its own: PC3 already holds the revision");

    const migration = fs.readFileSync(MIGRATION_122, "utf8");
    pc1.db.db.exec(migration);
    pc3.db.db.exec(migration);
    assert.equal(Number((pc3.db.db.prepare("SELECT COUNT(*) AS n FROM sync_dirty_records").get() as { n: number }).n), 0, "PC3 queues nothing");
    await passAll(cloud, [pc1, pc2, pc3]);

    assert.deepEqual(rulesOf(pc3), rulesOf(pc1), "PC3 holds PC1's rules");
    assert.equal(pc3.db.resolveDiscount({ partyId, productGroupId: groupId }).discountPerPair, 12);
  });
});
