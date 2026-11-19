import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEASED_AGGREGATE_DOMAIN, SqliteDatabase, leaseDomainOf } from "@erp/data";
import { LEASE_DOMAIN, type LeaseDomain } from "@erp/domain";
import type { SyncEnvelope } from "./contract.js";
import { OutboxDrain } from "./drain.js";
import { leaseWriteDecision } from "./leases.js";
import { parkedSummary } from "./parking.js";
import { SyncPull } from "./pull.js";
import type { SyncAck, SyncChange, SyncPullTransport, SyncTransport } from "./transport.js";

// PARTIES ON THEIR OWN LEASE (docs/51, cloud 035). The store computer, PC2, holds PARTIES and adds the supplier or
// contractor in front of it. PC1 keeps MASTER_DATA: products, sizes, machines, groups and colours. PC3 writes neither
// and reads both. Real writers, capture triggers, builders, outbox, drain, pull and appliers; the cloud is a stand-in
// holding to push_leased_record's rule: a record is accepted only from the holder of ITS TYPE'S lease, at that lease's
// epoch, read from the same mapping the cloud's leased_record_types holds after 035.

const SCHEMA = path.resolve(import.meta.dirname, "../../data/src/local-schema.sql");
const PROJECT = "https://test.supabase.co";
const clock = { ms: Date.now() + 86_400_000 };
const nowIso = () => new Date(clock.ms).toISOString();

class Cloud {
  readonly log: SyncChange[] = [];
  readonly refused: SyncEnvelope[] = [];
  readonly leases = new Map<LeaseDomain, { holder: string; epoch: number }>([
    [LEASE_DOMAIN.MASTER_DATA, { holder: "dev-pc1", epoch: 4 }],
    [LEASE_DOMAIN.PARTIES, { holder: "dev-pc2", epoch: 1 }],
    [LEASE_DOMAIN.RAW_MATERIAL_STORE, { holder: "dev-pc2", epoch: 1 }],
  ]);

  /** Every logged change, delivered a second time: what a pull retried after a lost answer receives. */
  deliverAgain(): void {
    for (const change of [...this.log]) this.log.push({ seq: this.log.length + 1, envelope: change.envelope });
  }

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `erp-parties-${name}-`));
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
const text = (pc: Pc, sql: string, ...params: string[]): string | null => {
  const row = pc.db.db.prepare(sql).get(...params) as { v: string | null } | undefined;
  return row?.v ?? null;
};
const count = (pc: Pc, sql: string, ...params: string[]): number => Number((pc.db.db.prepare(sql).get(...params) as { n: number }).n);
const decide = (pc: Pc, domain: LeaseDomain) => leaseWriteDecision(pc.db.db, { domain, deviceId: pc.device, syncConfigured: true }).allowed;
const ofType = (cloud: Cloud, type: string) => cloud.log.filter((change) => change.envelope.aggregateType === type);

/** PC2's supplier, in a new group, made the ordinary way. */
function addSupplier(pc2: Pc, name = "SHEHZAD RUBBER"): { groupId: string; partyId: string } {
  const groupId = pc2.db.createPartyGroup({ groupName: "RUBBER SUPPLIERS" });
  const partyId = pc2.db.createParty({ partyName: name, partyType: "SUPPLIER", city: "Lahore", mobileNumber: "0300-1234567", status: "ACTIVE", partyGroupId: groupId });
  return { groupId, partyId };
}

test("parties and party groups are their own lease; products, sizes, machines and colours stay MASTER_DATA", () => {
  assert.equal(leaseDomainOf("PARTY"), LEASE_DOMAIN.PARTIES);
  assert.equal(leaseDomainOf("PARTY_GROUP"), LEASE_DOMAIN.PARTIES);
  for (const type of ["WORK_SECTION", "MACHINE", "MAIN_GROUP", "PRODUCT_GROUP", "ARTICLE_SERIES", "PRODUCT_TYPE", "PRODUCT_SUB_GROUP", "ARTICLE_SIZE", "COLOR_TRANSLATION"]) {
    assert.equal(leaseDomainOf(type), LEASE_DOMAIN.MASTER_DATA, type);
  }
});

test("only the PARTIES holder may write parties; MASTER_DATA stays where it is", async () => {
  await withOffice(async (_cloud, pc1, pc2, pc3) => {
    assert.equal(decide(pc2, LEASE_DOMAIN.PARTIES), true, "PC2 adds parties");
    assert.equal(decide(pc1, LEASE_DOMAIN.PARTIES), false, "PC1 no longer writes parties");
    assert.equal(decide(pc3, LEASE_DOMAIN.PARTIES), false);
    assert.equal(decide(pc1, LEASE_DOMAIN.MASTER_DATA), true, "PC1 keeps products, sizes, machines and colours");
    assert.equal(decide(pc2, LEASE_DOMAIN.MASTER_DATA), false, "PC2 does not gain general master data");
  });
});

test("PC2 adds a supplier in a new group: the cloud takes both once, under PARTIES, and PC1 and PC3 receive them", async () => {
  await withOffice(async (cloud, pc1, pc2, pc3) => {
    const { groupId, partyId } = addSupplier(pc2);
    // PC1 carries on with general master data at the same time.
    const productGroupId = pc1.db.createProductGroup({ groupName: "SLIPPERS" });
    await passAll(cloud, [pc1, pc2, pc3]);

    assert.deepEqual(cloud.refused.map((envelope) => envelope.aggregateType), [], "nothing refused by the cloud");
    assert.equal(ofType(cloud, "PARTY").length, 1);
    assert.equal(ofType(cloud, "PARTY_GROUP").length, 1);
    for (const change of [...ofType(cloud, "PARTY"), ...ofType(cloud, "PARTY_GROUP")]) {
      assert.equal(change.envelope.originDeviceId, "dev-pc2");
      assert.equal(change.envelope.leaseEpoch, 1, "written under the PARTIES lease's epoch");
    }
    assert.ok(ofType(cloud, "PRODUCT_GROUP").every((change) => change.envelope.originDeviceId === "dev-pc1" && change.envelope.leaseEpoch === 4));

    for (const pc of [pc1, pc2, pc3]) {
      assert.equal(text(pc, "SELECT party_name AS v FROM parties WHERE id = ?", partyId), "SHEHZAD RUBBER", `${pc.name} has the supplier`);
      assert.equal(text(pc, "SELECT party_group_id AS v FROM parties WHERE id = ?", partyId), groupId, `${pc.name} files it in its group`);
      assert.equal(count(pc, "SELECT COUNT(*) AS n FROM product_groups WHERE id = ?", productGroupId), 1, `${pc.name} has PC1's product group`);
      assert.equal(parkedSummary(pc.db.db).count, 0, `${pc.name} has nothing parked`);
    }
  });
});

test("PC2 edits the supplier: PC1 and PC3 follow, and a second delivery of everything changes nothing", async () => {
  await withOffice(async (cloud, pc1, pc2, pc3) => {
    const { partyId } = addSupplier(pc2);
    await passAll(cloud, [pc1, pc2, pc3]);
    pc2.db.updateParty(partyId, { partyName: "SHEHZAD RUBBER INDUSTRIES", city: "Gujranwala" });
    await passAll(cloud, [pc1, pc2, pc3]);
    assert.equal(ofType(cloud, "PARTY").length, 2, "two revisions of one party");

    cloud.deliverAgain();
    await passAll(cloud, [pc1, pc2, pc3]);
    for (const pc of [pc1, pc2, pc3]) {
      assert.equal(text(pc, "SELECT party_name AS v FROM parties WHERE id = ?", partyId), "SHEHZAD RUBBER INDUSTRIES", pc.name);
      assert.equal(text(pc, "SELECT city AS v FROM parties WHERE id = ?", partyId), "Gujranwala", pc.name);
      assert.equal(count(pc, "SELECT COUNT(*) AS n FROM parties"), 1, `${pc.name}: one party, never two`);
      assert.equal(parkedSummary(pc.db.db).count, 0, `${pc.name} has nothing parked`);
    }
    assert.deepEqual(cloud.refused, []);
  });
});

test("a party written on a computer without the PARTIES lease is refused by the cloud and never reaches the others", async () => {
  await withOffice(async (cloud, pc1, pc2, pc3) => {
    // PC1 holds MASTER_DATA only. The app's write gate refuses this before it is made (leaseChannels.ts); here the data
    // layer is called directly, as a computer on an older release would, to prove the cloud refuses it too.
    const partyId = pc1.db.createParty({ partyName: "STRAY PARTY", partyType: "SUPPLIER", city: "Lahore", mobileNumber: "0300-7654321", status: "ACTIVE" });
    await passAll(cloud, [pc1, pc2, pc3]);

    assert.equal(ofType(cloud, "PARTY").length, 0, "the cloud logged nothing");
    assert.ok(cloud.refused.some((envelope) => envelope.aggregateType === "PARTY" && envelope.aggregateId === partyId), "refused NOT_LEASE_HOLDER");
    for (const pc of [pc2, pc3]) assert.equal(count(pc, "SELECT COUNT(*) AS n FROM parties WHERE id = ?", partyId), 0, `${pc.name} never has it`);
  });
});

test("a holder that lost PARTIES has its later party writes refused: the epoch, not the device, decides", async () => {
  await withOffice(async (cloud, pc1, pc2, pc3) => {
    addSupplier(pc2);
    await passAll(cloud, [pc1, pc2, pc3]);
    // The owner grants PARTIES elsewhere (a takeover bumps the epoch), and PC2 has not heard yet.
    cloud.leases.set(LEASE_DOMAIN.PARTIES, { holder: "dev-pc3", epoch: 2 });
    const late = pc2.db.createParty({ partyName: "LATE PARTY", partyType: "CONTRACTOR", city: "Lahore", mobileNumber: "0300-0000001", status: "ACTIVE" });
    await pass(pc2, cloud);
    assert.ok(cloud.refused.some((envelope) => envelope.aggregateId === late), "the stale write is refused");
    assert.equal(ofType(cloud, "PARTY").filter((change) => change.envelope.aggregateId === late).length, 0);
  });
});

test("PC2 writes no party until it has pulled every party PC1 wrote before the lease moved (035's barrier)", async () => {
  await withOffice(async (cloud, pc1, pc2, pc3) => {
    // Before 035, PC1 wrote parties under MASTER_DATA: here, two revisions it logged.
    cloud.leases.set(LEASE_DOMAIN.PARTIES, { holder: "dev-pc1", epoch: 1 });
    for (const pc of [pc1, pc2, pc3]) pc.db.db.prepare("UPDATE sync_domain_leases SET holder_device_id = 'dev-pc1' WHERE domain = 'PARTIES'").run();
    const old = pc1.db.createParty({ partyName: "OLD CUSTOMER", partyType: "CUSTOMER", city: "Lahore", mobileNumber: "0300-5555555", status: "ACTIVE" });
    await pass(pc1, cloud);
    const barrier = Math.max(...ofType(cloud, "PARTY").map((change) => change.seq));

    // 035, then the owner's grant: PARTIES to PC2, its barrier at PC1's last party revision. PC2 hears the lease first.
    cloud.leases.set(LEASE_DOMAIN.PARTIES, { holder: "dev-pc2", epoch: 2 });
    pc2.db.db.prepare("UPDATE sync_domain_leases SET holder_device_id = 'dev-pc2', epoch = 2, barrier_seq = ? WHERE domain = 'PARTIES'").run(barrier);
    assert.equal(decide(pc2, LEASE_DOMAIN.PARTIES), false, "not before it has caught up");

    await pass(pc2, cloud);
    assert.equal(count(pc2, "SELECT COUNT(*) AS n FROM parties WHERE id = ?", old), 1, "it has PC1's party");
    assert.equal(decide(pc2, LEASE_DOMAIN.PARTIES), true, "caught up: it may write parties");
  });
});
