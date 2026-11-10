import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "@erp/data";
import { LEASE_DOMAIN, seededColorTranslationId } from "@erp/domain";
import type { SyncEnvelope } from "./contract.js";
import { OutboxDrain } from "./drain.js";
import { leaseWriteDecision } from "./leases.js";
import { SyncPull } from "./pull.js";
import type { SyncAck, SyncChange, SyncPullTransport, SyncTransport } from "./transport.js";

// THE COLOUR LIST, END TO END, ON TWO COMPUTERS (docs/45).
//
// Real writers, capture triggers, builders, outbox, drain, pull and appliers. Only the cloud is a stand-in, and it holds
// to what push_leased_record holds to (checked on TEST by check_color_translations.sql): one dedupe key is one event,
// only the master-data holder at the current epoch is accepted, and before cloud 029 the type is UNKNOWN_RECORD_TYPE.

const SCHEMA = path.resolve(import.meta.dirname, "../../data/src/local-schema.sql");
const PROJECT = "https://test.supabase.co";
const clock = { ms: Date.now() + 86_400_000 };
const nowIso = () => new Date(clock.ms).toISOString();

class Cloud {
  readonly log: SyncChange[] = [];
  master = { holder: "dev-a", epoch: 1 };
  /** Whether cloud migration 029 has been applied. */
  knowsColors = true;
  private readonly unreachable = new Set<string>();
  offline(device: string): void { this.unreachable.add(device); }
  online(device: string): void { this.unreachable.delete(device); }

  private accept(envelope: SyncEnvelope, device: string): SyncAck {
    if (envelope.aggregateType === "COLOR_TRANSLATION" && !this.knowsColors) {
      return { dedupeKey: envelope.dedupeKey, accepted: false, reason: "UNKNOWN_RECORD_TYPE", failure: "TRANSIENT" };
    }
    if (this.master.holder !== device || envelope.leaseEpoch !== this.master.epoch) {
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

interface Pc { readonly device: string; readonly dbPath: string; db: SqliteDatabase }

function openPc(name: string, block: number): Pc {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `erp-colors-${name}-`)), "erp.db");
  const db = new SqliteDatabase({ dbPath, schemaPath: SCHEMA });
  const device = `dev-${name}`;
  db.setNumberBlock(block, "test");
  db.ensureOperationalContext({
    factoryId: "factory-777", factoryCode: "F777", factoryName: "777",
    workstationId: `ws-${name}`, workstationCode: `WS-${name}`, workstationName: name, deviceId: device, deviceName: name, appVersion: "0.5.1",
  });
  db.db.prepare("INSERT OR REPLACE INTO app_settings (setting_key, setting_value, updated_at) VALUES ('device.id', ?, ?)").run(device, nowIso());
  return { device, dbPath, db };
}

function hearLease(pc: Pc, cloud: Cloud): void {
  pc.db.db.prepare(
    `INSERT INTO sync_domain_leases (domain, holder_device_id, holder_label, epoch, barrier_seq, granted_at, project_key, fetched_at)
     VALUES ('MASTER_DATA', ?, ?, ?, 0, ?, ?, ?)
     ON CONFLICT (domain) DO UPDATE SET holder_device_id = excluded.holder_device_id, epoch = excluded.epoch, fetched_at = excluded.fetched_at`
  ).run(cloud.master.holder, cloud.master.holder, cloud.master.epoch, nowIso(), PROJECT, nowIso());
}

async function pass(pc: Pc, cloud: Cloud): Promise<void> {
  pc.db.buildLeasedRecordRevisions(nowIso());
  const transport = cloud.as(pc.device);
  const retryPolicy = { maxAttempts: 2, baseBackoffMs: 1, maxBackoffMs: 1, staleInFlightMs: 120_000 };
  try {
    await new OutboxDrain(pc.db.db, transport, { deviceId: pc.device, now: nowIso, retryPolicy }).runOnce();
    await new SyncPull(pc.db.db, transport, { now: () => clock.ms, project: PROJECT }).runOnce();
  } catch {
    // Offline: the pass fails, and the next one tries again.
  }
  clock.ms += 3_600_000;
}

const passBoth = async (cloud: Cloud, a: Pc, b: Pc) => {
  for (let round = 0; round < 3; round += 1) {
    await pass(a, cloud);
    await pass(b, cloud);
  }
};

const urduOf = (pc: Pc, english: string): string | undefined =>
  pc.db.listColorTranslations().find((row) => row.englishName.toLowerCase() === english.toLowerCase())?.urduName;

function office(): { cloud: Cloud; a: Pc; b: Pc } {
  const cloud = new Cloud();
  const a = openPc("a", 11);
  const b = openPc("b", 12);
  hearLease(a, cloud);
  hearLease(b, cloud);
  return { cloud, a, b };
}

const close = (...pcs: Pc[]) => pcs.forEach((pc) => pc.db.close());

test("an added, edited and deleted colour reaches the other computer, Urdu exactly as entered", async () => {
  const { cloud, a, b } = office();
  try {
    a.db.createColorTranslation({ englishName: "Purple", urduName: "پرپل" });
    a.db.updateColorTranslation(seededColorTranslationId("Black"), { englishName: "Black", urduName: "کالا" });
    a.db.deleteColorTranslation(seededColorTranslationId("Sky"));
    await passBoth(cloud, a, b);

    assert.equal(urduOf(b, "Purple"), "پرپل");
    assert.equal(urduOf(b, "Black"), "کالا", "a seeded colour, edited: the same record on both, updated in place");
    assert.equal(urduOf(b, "Sky"), undefined);
    assert.deepEqual(b.db.listColorTranslations(), a.db.listColorTranslations(), "the two lists are the same");
    assert.equal(b.db.db.prepare("SELECT COUNT(*) AS n FROM sync_displaced_records").get()?.n ?? 0, 0, "no name was moved aside");
  } finally {
    close(a, b);
  }
});

test("a computer that was offline and restarted catches up, and its own restart loses nothing", async () => {
  const { cloud, a, b } = office();
  try {
    cloud.offline(b.device);
    a.db.createColorTranslation({ englishName: "Maroon", urduName: "مہرون" });
    await passBoth(cloud, a, b);
    assert.equal(urduOf(b, "Maroon"), undefined, "offline: not yet");

    b.db.close();
    b.db = new SqliteDatabase({ dbPath: b.dbPath, schemaPath: SCHEMA });
    a.db.close();
    a.db = new SqliteDatabase({ dbPath: a.dbPath, schemaPath: SCHEMA });
    assert.equal(urduOf(a, "Maroon"), "مہرون", "the writer keeps its own change across a restart");

    cloud.online(b.device);
    await passBoth(cloud, a, b);
    assert.equal(urduOf(b, "Maroon"), "مہرون");
  } finally {
    close(a, b);
  }
});

test("before cloud 029 a colour change waits, holds nothing else up, and goes once 029 is applied", async () => {
  const { cloud, a, b } = office();
  try {
    cloud.knowsColors = false;
    a.db.createColorTranslation({ englishName: "Purple", urduName: "پرپل" });
    a.db.createWorkSection({ name: "PACKING CHECK" });
    await passBoth(cloud, a, b);
    assert.equal(urduOf(b, "Purple"), undefined);
    assert.ok(b.db.listWorkSections().some((section) => section.name === "PACKING CHECK"), "the work section went");
    const waiting = a.db.db.prepare("SELECT status FROM sync_outbox WHERE aggregate_type = 'COLOR_TRANSLATION'").all() as Array<{ status: string }>;
    assert.ok(waiting.length === 1 && waiting[0]?.status !== "DEAD_LETTER", "waiting, not dead-lettered");

    cloud.knowsColors = true;
    clock.ms += 3_600_000;
    await passBoth(cloud, a, b);
    assert.equal(urduOf(b, "Purple"), "پرپل");
  } finally {
    close(a, b);
  }
});

test("only the master-data holder may change the list, and one English colour is one mapping on every computer", async () => {
  const { cloud, a, b } = office();
  try {
    await passBoth(cloud, a, b);
    const forB = leaseWriteDecision(b.db.db, { domain: LEASE_DOMAIN.MASTER_DATA, deviceId: b.device, syncConfigured: true });
    assert.equal(forB.allowed, false, "B does not hold the lease, so the write gate refuses its change");
    assert.equal(leaseWriteDecision(a.db.db, { domain: LEASE_DOMAIN.MASTER_DATA, deviceId: a.device, syncConfigured: true }).allowed, true, "A, the holder, may write once it has read the log");
    assert.throws(() => a.db.createColorTranslation({ englishName: " black ", urduName: "کالا" }), /DUPLICATE_ENGLISH/);
    a.db.createColorTranslation({ englishName: "Teal", urduName: "ٹیل" });
    await passBoth(cloud, a, b);
    assert.throws(() => b.db.createColorTranslation({ englishName: "TEAL", urduName: "ٹیل" }), /DUPLICATE_ENGLISH/, "the arrived colour is a duplicate there too");
    assert.equal(b.db.listColorTranslations().filter((row) => row.englishName.toLowerCase() === "teal").length, 1);
  } finally {
    close(a, b);
  }
});
