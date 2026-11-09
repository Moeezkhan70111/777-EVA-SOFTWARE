import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddMachineUseCase, CancelGatepassUseCase, CreateGatepassUseCase, InMemoryEventBus } from "@erp/application";
import {
  CARTON_CLOUD_ACTIVATION_KEY,
  LOCAL_STOCK_PARKED_ERROR,
  SqliteDatabase,
  buildCartonStockEvents,
  buildLeasedRecordRevisions,
  isLocalStockRecord,
  markRecordToSendAgain,
  readCartonCloudState,
  resendCartonMovementsRefusedForLease,
  stockRefusalForOutboxRow,
} from "@erp/data";
import { applyEnvelope } from "./applyEnvelope.js";
import type { SyncEnvelope } from "./contract.js";
import { OutboxDrain } from "./drain.js";
import { SUPABASE_PUSHABLE_AGGREGATES } from "./supabaseTransport.js";
import type { SyncAck, SyncTransport } from "./transport.js";

// THE CARTON CLOUD ACTIVATION BOUNDARY (@erp/data stockProtection.ts), end to end, on real databases.
//
// Carton work made before an administrator activates Carton Cloud -- on the old version, or on this one before go-live
// -- is test data and never leaves the computer, by any path. Activation records a fresh cutoff once; only work made
// after it travels. What the cloud sends down applies throughout.

const SCHEMA = path.resolve(import.meta.dirname, "../../data/src/local-schema.sql");
const NOW = "2026-11-09T10:00:00.000Z";
const PROJECT = "https://prod.supabase.co";
const STORE = "factory-777";
const idGen = { nextId: () => crypto.randomUUID() };

interface Computer {
  readonly db: SqliteDatabase;
  readonly dir: string;
  readonly deviceId: string;
}

function openComputer(name: string): Computer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `erp-activation-${name}-`));
  const db = new SqliteDatabase({ dbPath: path.join(dir, "erp.db"), schemaPath: SCHEMA });
  db.setNumberBlock(name === "a" ? 1 : 2, "test");
  db.ensureOperationalContext({
    factoryId: STORE, factoryCode: "F777", factoryName: "777",
    workstationId: `ws-${name}`, workstationCode: `WS-${name}`, workstationName: name,
    deviceId: `dev-${name}`, deviceName: name, appVersion: "1.0.0",
  });
  setSetting({ db, dir, deviceId: `dev-${name}` }, "sync.pull.project", PROJECT);
  return { db, dir, deviceId: `dev-${name}` };
}

const close = (pc: Computer) => {
  pc.db.close();
  fs.rmSync(pc.dir, { recursive: true, force: true });
};

function setSetting(pc: Computer, key: string, value: string): void {
  pc.db.db.prepare(
    `INSERT INTO app_settings (setting_key, setting_value, value_type, is_encrypted, updated_by, updated_at) VALUES (?, ?, 'string', 0, 'test', ?)
     ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`
  ).run(key, value, NOW);
}

/** The lease cache as a sync pass leaves it: `holder` holds `domain` in PROJECT, read at `fetchedAt`. */
const cacheLease = (pc: Computer, domain: string, holder: string | null, fetchedAt = NOW) =>
  pc.db.db.prepare(
    `INSERT OR REPLACE INTO sync_domain_leases (domain, holder_device_id, holder_label, epoch, barrier_seq, granted_at, project_key, fetched_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?)`
  ).run(domain, holder, holder === null ? null : `PC ${holder}`, holder === null ? 0 : 1, NOW, PROJECT, fetchedAt);

const ready = (pc: Computer) => {
  for (const domain of ["CARTON_STOCK", "SALES_DISPATCH", "ACCOUNTS"]) cacheLease(pc, domain, pc.deviceId);
};

const addProduct = (pc: Computer) =>
  pc.db.createProduct({ article: "SK6", size: "7/10", sellingPrice: 550, machineRate: 70, packingRate: 30, colors: ["RED"], status: "ACTIVE" });
const red = (pc: Computer): string => (pc.db.db.prepare("SELECT id FROM product_variants WHERE article = 'SK6' AND color = 'RED'").get() as { id: string }).id;
const inStore = (pc: Computer): number => pc.db.listInventory("SK6").find((row) => row.color === "RED")?.storeQuantity ?? 0;

/** The carton computer, holding every lease: a machine, its contractors, a customer -- and its carton work. */
async function openWriter() {
  const pc = openComputer("a");
  ready(pc);
  addProduct(pc);
  const contractor = (name: string, mobile: string) => pc.db.createParty({ partyName: name, partyType: "CONTRACTOR", city: "Lahore", mobileNumber: mobile, status: "ACTIVE" });
  const aslam = contractor("ASLAM", "0300-1111111");
  const babar = contractor("BABAR", "0300-2222222");
  const customer = pc.db.createParty({ partyName: "MAMA CHAPPAL", partyType: "CUSTOMER", city: "Lahore", mobileNumber: "0300-3333333", status: "ACTIVE" });
  const deps = { txManager: pc.db, repo: pc.db, eventPublisher: new InMemoryEventBus(), idGenerator: idGen };
  const machineId = (await new AddMachineUseCase(deps).execute({ name: "Machine 1", contractorPartyId: aslam, packingContractorPartyId: babar, actor: "admin" })).machineId!;
  const sk6 = (pc.db.db.prepare("SELECT id FROM article_sizes WHERE article = 'SK6'").get() as { id: string }).id;
  return {
    pc,
    produce: (dozens: string) =>
      pc.db.recordManualProduction({ requestId: crypto.randomUUID(), machineId, articleSizeId: sk6, color: "RED", dozens, storeLocationId: STORE, createdBy: "aslam" }).entry,
    gatepass: async (quantity: number) => {
      const made = await new CreateGatepassUseCase({ txManager: pc.db, repo: pc.db, idGenerator: idGen }).execute({
        partyId: customer, lines: [{ productVariantId: red(pc), quantity }], actor: "clerk",
      });
      assert.equal(made.accepted, true, made.reason);
      return String(made.gatepassId);
    },
    cancel: (gatepassId: string) =>
      new CancelGatepassUseCase({ txManager: pc.db, repo: pc.db, idGenerator: idGen }).execute({ gatepassId, reason: "wrong party", actor: "clerk" }),
    void: (entryId: string) => pc.db.voidManualProduction({ entryId, reason: "test", voidedBy: "admin", mayVoidEarlierDays: true }),
  };
}

type Writer = Awaited<ReturnType<typeof openWriter>>;

const STOCK_TYPES = ["CARTON_STOCK_EVENT", "MANUAL_PRODUCTION_ENTRY", "GATEPASS", "SALE_VOUCHER", "CASH_VOUCHER"];
const queuedStock = (pc: Computer): Array<{ type: string; id: string }> =>
  (pc.db.db
    .prepare(`SELECT aggregate_type AS type, aggregate_id AS id FROM sync_outbox WHERE status IN ('PENDING','FAILED') AND aggregate_type IN (${STOCK_TYPES.map(() => "?").join(",")}) ORDER BY rowid`)
    .all(...STOCK_TYPES) as Array<{ type: string; id: string }>).map((row) => ({ type: row.type, id: row.id }));
const marks = (pc: Computer, type: string): number =>
  Number((pc.db.db.prepare("SELECT COUNT(*) AS n FROM sync_dirty_records WHERE aggregate_type = ?").get(type) as { n: number }).n);

const buildAll = (pc: Computer) => ({ records: buildLeasedRecordRevisions(pc.db.db, NOW), cartons: buildCartonStockEvents(pc.db.db, NOW) });

/** A transport that accepts everything and remembers it: what would have reached the cloud. */
function recordingTransport(): SyncTransport & { readonly sent: SyncEnvelope[] } {
  const sent: SyncEnvelope[] = [];
  return {
    sent,
    send: async (envelopes): Promise<SyncAck[]> => {
      sent.push(...envelopes);
      return envelopes.map((envelope) => ({ dedupeKey: envelope.dedupeKey, accepted: true }));
    },
  };
}
const drainOnce = async (pc: Computer, transport: SyncTransport) =>
  new OutboxDrain(pc.db.db, transport, { deviceId: pc.deviceId, aggregateTypes: SUPABASE_PUSHABLE_AGGREGATES, now: () => NOW }).runOnce();
const stockSent = (transport: { sent: SyncEnvelope[] }) => transport.sent.filter((envelope) => STOCK_TYPES.includes(envelope.aggregateType));

/**
 * The go-live order on a computer that did test carton work: the carton fresh start clears the test cartons from the
 * figure (the real tool, scripts/reset-carton-stock.mjs, is tested in @erp/data cartonStockAdjust.test.ts; its effect is
 * applied here), then activation.
 */
function freshStart(pc: Computer): void {
  pc.db.db.exec(`UPDATE stock_projection_by_variant SET quantity_on_hand = quantity_on_hand - (
      SELECT COALESCE(SUM(l.quantity_on_hand), 0) FROM stock_projection_by_location l
       WHERE l.product_variant_id = stock_projection_by_variant.product_variant_id AND l.location_type = 'WAREHOUSE');
    UPDATE stock_projection_by_location SET quantity_on_hand = 0 WHERE location_type = 'WAREHOUSE';`);
}
const activateOnly = (pc: Computer) => pc.db.activateCartonCloud({ nowIso: NOW, activatedBy: "owner" });
const activate = (pc: Computer) => {
  freshStart(pc);
  return activateOnly(pc);
};

async function withWriter(work: (a: Writer) => Promise<void>): Promise<void> {
  const a = await openWriter();
  try {
    await work(a);
  } finally {
    close(a.pc);
  }
}

test("before activation nothing of carton stock is built or sent -- not even work made today -- and the marks wait untouched", async () => {
  await withWriter(async (a) => {
    assert.equal(readCartonCloudState(a.pc.db.db).state, "NOT_ACTIVATED", "off by default: opening never activates");
    a.produce("10");
    await a.gatepass(5);
    const built = buildAll(a.pc);
    assert.equal(built.cartons.notActivated, true);
    assert.deepEqual(queuedStock(a.pc), []);
    assert.ok(marks(a.pc, "CARTON_STOCK_EVENT") >= 2 && marks(a.pc, "MANUAL_PRODUCTION_ENTRY") >= 1, "the marks are kept, for the activation to retire");
    const transport = recordingTransport();
    await drainOnce(a.pc, transport);
    assert.deepEqual(stockSent(transport), [], "the cloud receives none of it");
  });
});

test("activation is refused, changing nothing, until the cloud has the carton leases and someone holds each, freshly read", async () => {
  await withWriter(async (a) => {
    a.pc.db.db.prepare("DELETE FROM sync_domain_leases").run();
    const missing = activate(a.pc);
    assert.equal(missing.activated, false);
    assert.ok(!missing.activated && missing.problems.some((p) => /CARTON_STOCK lease/.test(p) && /026-028/.test(p)));
    cacheLease(a.pc, "CARTON_STOCK", a.pc.deviceId);
    cacheLease(a.pc, "SALES_DISPATCH", null);
    cacheLease(a.pc, "ACCOUNTS", a.pc.deviceId, "2026-11-09T09:00:00.000Z");
    const unheld = activate(a.pc);
    assert.ok(!unheld.activated && unheld.problems.some((p) => /Nobody holds the SALES_DISPATCH/.test(p)));
    assert.ok(!unheld.activated && unheld.problems.some((p) => /ACCOUNTS lease was last read too long ago/.test(p)));
    assert.equal(readCartonCloudState(a.pc.db.db).state, "NOT_ACTIVATED", "nothing written");
  });
});

test("activation is refused while the carton figure still holds test cartons; the fresh start clears the way", async () => {
  await withWriter(async (a) => {
    a.produce("10");
    const refused = activateOnly(a.pc);
    assert.ok(!refused.activated && refused.problems.some((p) => /still holds 20 test carton/.test(p) && /fresh start/.test(p)));
    assert.equal(readCartonCloudState(a.pc.db.db).state, "NOT_ACTIVATED");
    freshStart(a.pc);
    assert.equal(activateOnly(a.pc).activated, true);
  });
});

test("activation records a fresh cutoff once, retires every old mark and parks every old queued event; it cannot be repeated", async () => {
  await withWriter(async (a) => {
    a.produce("10");
    await a.gatepass(5);
    const now = new Date().toISOString();
    a.pc.db.db.prepare(
      `INSERT INTO sync_outbox (id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json, status, available_at, attempts, created_at, updated_at, lease_epoch)
       VALUES ('older-build', 'CARTON_STOCK_EVENT', 'x', 'INSERT', 'CARTON_STOCK_EVENT:older', '{}', 'PENDING', ?, 0, ?, ?, 1)`
    ).run(now, now, now);
    const outcome = activate(a.pc);
    assert.equal(outcome.activated, true);
    if (!outcome.activated) return;
    assert.equal(outcome.activation.deviceId, "dev-a");
    assert.equal(outcome.activation.projectKey, PROJECT);
    assert.ok(outcome.activation.cutoff.carton_stock_events >= 2 && outcome.activation.cutoff.gatepasses >= 1);
    assert.ok((outcome.retiredMarks.CARTON_STOCK_EVENT ?? 0) >= 2, "every old movement's mark retired");
    assert.equal(outcome.parked, 1, "the event an older build queued is parked");
    for (const type of STOCK_TYPES) assert.equal(marks(a.pc, type), 0, `${type}: no old mark left to wait`);
    assert.equal(readCartonCloudState(a.pc.db.db).state, "ACTIVE");
    const again = activate(a.pc);
    assert.ok(!again.activated && again.problems.some((p) => /already active/.test(p)), "the cutoff can never be moved");
  });
});

test("work made after activation travels; an old test gatepass cannot be cancelled nor an old entry voided, so test cartons never re-enter the live figure", async () => {
  await withWriter(async (a) => {
    const oldEntry = a.produce("10");
    const oldGatepass = await a.gatepass(5);
    assert.equal(activate(a.pc).activated, true);

    const fresh = a.produce("2");
    const figure = inStore(a.pc);
    const cancelled = await a.cancel(oldGatepass);
    assert.equal(cancelled.accepted, false);
    assert.equal(cancelled.accepted ? null : cancelled.outcome, "BEFORE_GO_LIVE");
    assert.throws(() => a.void(oldEntry.id), Error, "voiding a test entry is refused outright: its cartons are gone from the live figure");
    assert.equal(inStore(a.pc), figure, "the live figure did not move");
    buildAll(a.pc);
    const queued = queuedStock(a.pc);
    assert.ok(queued.some((row) => row.type === "MANUAL_PRODUCTION_ENTRY" && row.id === fresh.id), "the new entry is queued");
    assert.ok(!queued.some((row) => row.id === oldEntry.id || row.id === oldGatepass), "the old documents are not");
    const transport = recordingTransport();
    const result = await drainOnce(a.pc, transport);
    assert.equal(result.parkedLocalStock, 0);
    const movements = stockSent(transport).filter((envelope) => envelope.aggregateType === "CARTON_STOCK_EVENT");
    assert.equal(movements.length, 1, "exactly the new production's movement reaches the cloud");
    assert.equal(marks(a.pc, "CARTON_STOCK_EVENT"), 0, "excluded marks are retired, so nothing waits for ever");
  });
});

test("test carton work made on this release after the upgrade but before activation is excluded for ever", async () => {
  await withWriter(async (a) => {
    // The release is installed; people keep testing for a week before go-live.
    const testing = a.produce("7");
    const testGatepass = await a.gatepass(3);
    buildAll(a.pc);
    assert.equal(activate(a.pc).activated, true);
    buildAll(a.pc);
    assert.equal(markRecordToSendAgain(a.pc.db.db, "MANUAL_PRODUCTION_ENTRY", testing.id, NOW), "LOCAL_STOCK_DATA");
    assert.equal(markRecordToSendAgain(a.pc.db.db, "GATEPASS", testGatepass, NOW), "LOCAL_STOCK_DATA");
    assert.deepEqual(queuedStock(a.pc), []);
  });
});

test("'send again' refuses every stock document before activation, and old ones after it; master data is unaffected", async () => {
  await withWriter(async (a) => {
    const entry = a.produce("1");
    assert.equal(markRecordToSendAgain(a.pc.db.db, "MANUAL_PRODUCTION_ENTRY", entry.id, NOW), "CARTON_CLOUD_NOT_ACTIVE");
    const party = (a.pc.db.db.prepare("SELECT id FROM parties LIMIT 1").get() as { id: string }).id;
    cacheLease(a.pc, "MASTER_DATA", a.pc.deviceId);
    assert.equal(markRecordToSendAgain(a.pc.db.db, "PARTY", party, NOW), "MARKED");
    activate(a.pc);
    assert.equal(markRecordToSendAgain(a.pc.db.db, "MANUAL_PRODUCTION_ENTRY", entry.id, NOW), "LOCAL_STOCK_DATA");
  });
});

test("an old queued event is parked by the drain, cannot be put back, and the lease-return resend skips it but not new work", async () => {
  await withWriter(async (a) => {
    const oldMovement = (() => {
      a.produce("4");
      return (a.pc.db.db.prepare("SELECT id FROM carton_stock_events ORDER BY rowid DESC LIMIT 1").get() as { id: string }).id;
    })();
    activate(a.pc);
    const fresh = a.produce("1");
    buildAll(a.pc);
    const freshMovement = (a.pc.db.db.prepare("SELECT id FROM carton_stock_events WHERE manual_production_entry_id = ?").get(fresh.id) as { id: string }).id;
    // Both refused for the lease, as if this computer had lost it for a while.
    a.pc.db.db.prepare(
      `INSERT INTO sync_outbox (id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json, status, available_at, attempts, last_error, created_at, updated_at, lease_epoch)
       VALUES ('old-refused', 'CARTON_STOCK_EVENT', ?, 'INSERT', 'CARTON_STOCK_EVENT:old', '{}', 'DEAD_LETTER', ?, 5, 'NOT_LEASE_HOLDER', ?, ?, 0)`
    ).run(oldMovement, NOW, NOW, NOW);
    a.pc.db.db.prepare("UPDATE sync_outbox SET status = 'DEAD_LETTER', last_error = 'NOT_LEASE_HOLDER', lease_epoch = 0 WHERE aggregate_id = ?").run(freshMovement);
    assert.equal(resendCartonMovementsRefusedForLease(a.pc.db.db, NOW), 1, "only the new movement goes again");
    assert.notEqual(stockRefusalForOutboxRow(a.pc.db.db, "old-refused"), null, "and the requeue refuses the old one");
    a.pc.db.db.prepare("UPDATE sync_outbox SET status = 'PENDING' WHERE id = 'old-refused'").run(); // as a requeue would, if it could
    const transport = recordingTransport();
    const result = await drainOnce(a.pc, transport);
    assert.equal(result.parkedLocalStock, 1, "the drain's last gate parks it: reported, not silent");
    assert.deepEqual(stockSent(transport).filter((envelope) => envelope.aggregateId === oldMovement), []);
    const row = a.pc.db.db.prepare("SELECT status, last_error FROM sync_outbox WHERE id = 'old-refused'").get() as { status: string; last_error: string };
    assert.deepEqual([row.status, row.last_error], ["DEAD_LETTER", LOCAL_STOCK_PARKED_ERROR]);
  });
});

test("fails closed: an activation changed by hand, made for another computer or for another cloud project is not active", async () => {
  await withWriter(async (a) => {
    a.produce("1");
    activate(a.pc);
    const raw = (a.pc.db.db.prepare("SELECT setting_value FROM app_settings WHERE setting_key = ?").get(CARTON_CLOUD_ACTIVATION_KEY) as { setting_value: string }).setting_value;
    const cases: Array<[string, () => void, RegExp]> = [
      ["the cutoff lowered by hand", () => setSetting(a.pc, CARTON_CLOUD_ACTIVATION_KEY, raw.replace(/"carton_stock_events":\d+/, '"carton_stock_events":0')), /seal/],
      ["unreadable", () => setSetting(a.pc, CARTON_CLOUD_ACTIVATION_KEY, "{not json"), /not readable/],
      ["a database copied to another computer", () => { setSetting(a.pc, CARTON_CLOUD_ACTIVATION_KEY, raw); setSetting(a.pc, "device.id", "dev-other"); }, /another computer/],
      ["moved from TEST to production", () => { setSetting(a.pc, "device.id", "dev-a"); setSetting(a.pc, "sync.pull.project", "https://other.supabase.co"); }, /another cloud project/],
    ];
    for (const [name, change, reason] of cases) {
      change();
      const state = readCartonCloudState(a.pc.db.db);
      assert.equal(state.state, "INVALID", name);
      assert.match(state.state === "INVALID" ? state.reason : "", reason, name);
      a.produce("1");
      assert.equal(buildCartonStockEvents(a.pc.db.db, NOW).notActivated, true, `${name}: nothing is built`);
    }
    assert.deepEqual(queuedStock(a.pc), []);
  });
});

test("a gatepass the cloud sent before this computer was activated is real, not test data", async () => {
  await withWriter(async (a) => {
    a.produce("5");
    const received = await a.gatepass(2);
    const local = await a.gatepass(1);
    // As the receiver records a leased record it applied (leasedRecordContracts.ts).
    a.pc.db.db.prepare("INSERT INTO sync_record_revisions (aggregate_type, record_id, revision) VALUES ('GATEPASS', ?, 1)").run(received);
    activate(a.pc);
    assert.equal(isLocalStockRecord(a.pc.db.db, "GATEPASS", received), false, "it came from the cloud: real");
    assert.equal(isLocalStockRecord(a.pc.db.db, "GATEPASS", local), true, "made here before activation: test data");
    assert.equal(markRecordToSendAgain(a.pc.db.db, "GATEPASS", local, NOW), "LOCAL_STOCK_DATA");
  });
});

test("carton QR identities and production scans are never claimed by the drain", () => {
  assert.ok(!SUPABASE_PUSHABLE_AGGREGATES.includes("QR_MASTER"));
  assert.ok(!SUPABASE_PUSHABLE_AGGREGATES.includes("PRODUCTION_PRODUCED"));
});

test("carton movements from the cloud apply before and after activation here, and are never sent back up", async () => {
  const a = await openWriter();
  const b = openComputer("b");
  try {
    addProduct(b);
    ready(b);
    activate(a.pc);
    a.produce("5");
    buildCartonStockEvents(a.pc.db.db, NOW);
    const deliver = () => {
      const rows = a.pc.db.db
        .prepare("SELECT aggregate_type, aggregate_id, dedupe_key, payload_json FROM sync_outbox WHERE aggregate_type = 'CARTON_STOCK_EVENT' AND status = 'PENDING' ORDER BY rowid")
        .all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        const envelope: SyncEnvelope = {
          dedupeKey: String(row.dedupe_key), aggregateType: String(row.aggregate_type), aggregateId: String(row.aggregate_id),
          operation: "INSERT", payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>, originDeviceId: "dev-a", createdAt: NOW,
        };
        assert.equal(applyEnvelope(b.db.db, envelope, NOW).status, "APPLIED", envelope.dedupeKey);
      }
      a.pc.db.db.prepare("UPDATE sync_outbox SET status = 'SYNCED' WHERE aggregate_type = 'CARTON_STOCK_EVENT'").run();
    };
    deliver();
    assert.equal(inStore(b), 10, "b, not activated, shows the cloud's figure");
    assert.equal(activateOnly(b).activated, true, "a figure that came only from the cloud is not test stock: no fresh start needed");
    a.produce("1");
    buildCartonStockEvents(a.pc.db.db, NOW);
    deliver();
    assert.equal(inStore(b), 12, "and still after b is activated");
    buildAll(b);
    assert.deepEqual(queuedStock(b), [], "what came down is not b's to send");
  } finally {
    close(a.pc);
    close(b);
  }
});
