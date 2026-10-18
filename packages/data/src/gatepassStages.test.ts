// Phase 2: the stages operators work from, the journey they read, and the notices that hand
// work from one desk to the next.
//
// A stage is a view of the status, never a separate record — so these tests move a real
// document along the real journey and then ask the list, the counts and the timeline what they
// say about it. Nothing sets a status directly except where the guard itself is under test.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CreateGatepassUseCase,
  InMemoryEventBus,
  ProcessScanUseCase,
  StoreEntryScanUseCase,
  StoreExitScanUseCase,
} from "@erp/application";
import { NOTIFICATION_KIND, PERMISSION } from "@erp/domain";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { UuidGenerator } from "./idGenerator.js";

const FACTORY = "factory-777";
const CONTEXT = { factoryId: FACTORY, workstationId: "ws-prod-01", deviceId: "desktop-main" };

type Raw = import("node:sqlite").DatabaseSync;

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-gp-stages-"));
  const db = new SqliteDatabase({
    dbPath: path.join(tempDir, "stages.db"),
    schemaPath: path.resolve(process.cwd(), "src/local-schema.sql"),
  });
  db.setNumberBlock(1, "test");
  db.ensureOperationalContext({
    factoryId: FACTORY, factoryCode: "777", factoryName: "777 Manufacturing",
    workstationId: "ws-prod-01", workstationCode: "PROD-01", workstationName: "Production Line 01",
    deviceId: "desktop-main", deviceName: "Desktop Main", appVersion: "1.0.0",
  });
  const raw = (db as unknown as { db: Raw }).db;
  const bus = () => new InMemoryEventBus();
  const ids = () => new UuidGenerator();

  const produce = new ProcessScanUseCase({
    txManager: db, duplicateChecker: db, qrRegistry: db, productCatalog: db, qrMasterRepo: db,
    productionEventsRepo: db, stockProjectionRepo: db, outboxRepo: db, eventPublisher: bus(), idGenerator: ids(),
  });
  const receive = new StoreEntryScanUseCase({
    txManager: db, qrLookupRepo: db, gatepassRepo: db, qrRegistry: db, qrMasterRepo: db,
    storeEntryEventsRepo: db, stockProjectionRepo: db, outboxRepo: db, eventPublisher: bus(), idGenerator: ids(),
  });
  const moveOut = new StoreExitScanUseCase({
    txManager: db, qrLookupRepo: db, gatepassRepo: db, qrRegistry: db, qrMasterRepo: db,
    storeExitEventsRepo: db, stockProjectionRepo: db, outboxRepo: db, eventPublisher: bus(), idGenerator: ids(),
  });
  const creator = new CreateGatepassUseCase({ txManager: db, repo: db, idGenerator: ids(), localDate: () => "2026-10-06" });

  return { db, raw, produce, receive, moveOut, creator, cleanup: () => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); } };
}

type Fixture = ReturnType<typeof createFixture>;

async function stockVariant(f: Fixture, quantity: number, color = "BLACK") {
  let row = f.raw.prepare("SELECT id FROM article_sizes WHERE article = 'SK6' AND size = '7/10' AND deleted_at IS NULL LIMIT 1").get() as { id: string } | undefined;
  if (!row) {
    f.db.createProduct({ article: "SK6", size: "7/10", sellingPrice: 550, status: "ACTIVE" });
    row = f.raw.prepare("SELECT id FROM article_sizes WHERE article = 'SK6' AND size = '7/10' AND deleted_at IS NULL LIMIT 1").get() as { id: string };
  }
  const ids = f.db.generateQrBatch({ articleSizeId: row.id, color, quantity, createdBy: "admin" }).qrCodes.map((b) => b.id);
  for (const id of ids) {
    await f.produce.execute({ rawScan: id, context: CONTEXT });
    await f.receive.execute({ rawScan: id, context: CONTEXT });
  }
  const variant = f.raw.prepare("SELECT id FROM product_variants WHERE article = 'SK6' AND color = ? AND size = '7/10'").get(color) as { id: string };
  return { variantId: variant.id, ids };
}

const createParty = (f: Fixture, name = "ABC TRADERS") => f.db.createParty({ partyName: name, partyType: "CUSTOMER", city: "Lahore", status: "ACTIVE" });

async function createGatepass(f: Fixture, partyId: string, variantId: string, quantity: number) {
  const result = await f.creator.execute({ partyId, lines: [{ productVariantId: variantId, quantity }], actor: "clerk" });
  assert.equal(result.accepted, true, result.reason);
  return result.gatepassId!;
}

/** Every gatepass id the list returns for one stage. */
const idsAtStage = (f: Fixture, status: string) =>
  f.db.listGatepasses({ status: status as never, pageSize: 100 }).rows.map((row) => row.id);

/** An approved account holding exactly one permission, so fan-out can be checked by desk. */
function userWith(f: Fixture, username: string, permission: string): string {
  const user = f.db.createUserAccount(username, "Password123");
  f.raw.prepare("UPDATE app_users SET access_status = 'APPROVED' WHERE id = ?").run(user.id);
  const role = f.db.createRole({ name: username + "-role", permissions: [permission] });
  f.db.assignUserRole(user.id, role.code);
  return user.id;
}

const noticesFor = (f: Fixture, userId: string) =>
  f.raw.prepare("SELECT kind, title, message, entity_id FROM user_notifications WHERE user_id = ? ORDER BY created_at DESC, rowid DESC").all(userId) as Array<{ kind: string; title: string; message: string; entity_id: string }>;

// ─── Stage lists ──────────────────────────────────────────────────────────────

test("each status is its own queue, and the document moves between them as it travels", async () => {
  const f = createFixture();
  try {
    const { variantId, ids } = await stockVariant(f, 2);
    const party = createParty(f);
    const gatepassId = await createGatepass(f, party, variantId, 2);

    assert.deepEqual(idsAtStage(f, "CREATED"), [gatepassId], "waiting to be billed");
    assert.deepEqual(idsAtStage(f, "BILLED"), []);

    f.db.createSaleVoucher({ partyId: party, voucherDate: "2026-10-06", bookNo: "1", gatepassId });
    assert.deepEqual(idsAtStage(f, "CREATED"), [], "it left the billing queue");
    assert.deepEqual(idsAtStage(f, "BILLED"), [gatepassId], "and joined the store queue");

    await f.moveOut.execute({ rawScan: ids[0]!, context: CONTEXT });
    await f.moveOut.execute({ rawScan: ids[1]!, context: CONTEXT });
    assert.deepEqual(idsAtStage(f, "BILLED"), []);
    assert.deepEqual(idsAtStage(f, "AT_GATE"), [gatepassId], "ready for dispatch");
  } finally { f.cleanup(); }
});

test("finished and cancelled documents are nobody's queue, but stay findable in All", async () => {
  const f = createFixture();
  try {
    const { variantId } = await stockVariant(f, 2);
    const party = createParty(f);
    const delivered = await createGatepass(f, party, variantId, 1);
    const cancelled = await createGatepass(f, party, variantId, 1);

    f.raw.prepare("UPDATE gatepasses SET status = 'DELIVERED' WHERE id = ?").run(delivered);
    f.raw.prepare("UPDATE gatepasses SET status = 'CANCELLED' WHERE id = ?").run(cancelled);

    for (const stage of ["CREATED", "BILLED", "AT_GATE", "DISPATCHED"]) {
      assert.deepEqual(idsAtStage(f, stage), [], `${stage} is empty`);
    }
    assert.equal(f.db.listGatepasses({ pageSize: 100 }).total, 2, "both are still in All");
    assert.deepEqual(idsAtStage(f, "DELIVERED"), [delivered]);
    assert.deepEqual(idsAtStage(f, "CANCELLED"), [cancelled]);
  } finally { f.cleanup(); }
});

test("the counts are one grouped read and cover every stage, including the empty ones", async () => {
  const f = createFixture();
  try {
    const { variantId } = await stockVariant(f, 4);
    const party = createParty(f);
    const a = await createGatepass(f, party, variantId, 1);
    await createGatepass(f, party, variantId, 1);
    f.db.createSaleVoucher({ partyId: party, voucherDate: "2026-10-06", bookNo: "1", gatepassId: a });

    const counts = f.db.countGatepassesByStage();
    assert.equal(counts.CREATED, 1);
    assert.equal(counts.BILLED, 1);
    assert.equal(counts.AT_GATE, 0, "an empty stage still reports zero rather than nothing");
    assert.equal(counts.DISPATCHED, 0);
    assert.equal(counts.DELIVERED, 0);
    assert.equal(counts.CANCELLED, 0);
  } finally { f.cleanup(); }
});

// ─── The journey ──────────────────────────────────────────────────────────────

test("the journey is in order, marks where the document stands, and invents no times", async () => {
  const f = createFixture();
  try {
    const { variantId, ids } = await stockVariant(f, 1);
    const party = createParty(f);
    const gatepassId = await createGatepass(f, party, variantId, 1);
    f.db.createSaleVoucher({ partyId: party, voucherDate: "2026-10-06", bookNo: "1", gatepassId });
    await f.moveOut.execute({ rawScan: ids[0]!, context: CONTEXT });

    const journey = f.db.getGatepassJourney(gatepassId)!;
    assert.deepEqual(journey.map((s) => s.status), ["CREATED", "BILLED", "AT_GATE", "DISPATCHED", "DELIVERED"]);
    assert.deepEqual(journey.map((s) => s.state), ["DONE", "DONE", "CURRENT", "PENDING", "PENDING"]);
    assert.deepEqual(journey.map((s) => s.label), ["Gatepass Issued", "Billed", "At Gate", "Dispatched", "Delivered"]);

    for (const step of journey.filter((s) => s.state !== "PENDING")) {
      assert.ok(step.at, `${step.status} records when it happened`);
      assert.ok(!Number.isNaN(Date.parse(step.at!)), `${step.status} has a real timestamp`);
    }
    for (const step of journey.filter((s) => s.state === "PENDING")) {
      assert.equal(step.at, null, `${step.status} has not happened, so it has no time`);
    }
  } finally { f.cleanup(); }
});

test("the journey of a brand-new document shows only its first step as reached", async () => {
  const f = createFixture();
  try {
    const { variantId } = await stockVariant(f, 1);
    const gatepassId = await createGatepass(f, createParty(f), variantId, 1);

    const journey = f.db.getGatepassJourney(gatepassId)!;
    assert.deepEqual(journey.map((s) => s.state), ["CURRENT", "PENDING", "PENDING", "PENDING", "PENDING"]);
    assert.ok(journey[0]!.at, "creation is read from the document itself");
    assert.equal(journey[1]!.at, null);
  } finally { f.cleanup(); }
});

test("a document billed, unbilled and billed again keeps the first time it reached each step", async () => {
  const f = createFixture();
  try {
    const { variantId } = await stockVariant(f, 1);
    const party = createParty(f);
    const gatepassId = await createGatepass(f, party, variantId, 1);

    const first = f.db.createSaleVoucher({ partyId: party, voucherDate: "2026-10-06", bookNo: "1", gatepassId });
    const firstBilledAt = f.db.getGatepassJourney(gatepassId)!.find((s) => s.status === "BILLED")!.at;
    assert.ok(firstBilledAt);

    f.db.deleteSaleVoucher(first.id, "wrong rate");
    f.db.createSaleVoucher({ partyId: party, voucherDate: "2026-10-06", bookNo: "2", gatepassId });

    assert.equal(f.db.getGatepassJourney(gatepassId)!.find((s) => s.status === "BILLED")!.at, firstBilledAt);
  } finally { f.cleanup(); }
});

test("an unknown gatepass has no journey rather than an invented one", () => {
  const f = createFixture();
  try {
    assert.equal(f.db.getGatepassJourney("no-such-gatepass"), null);
  } finally { f.cleanup(); }
});

// ─── Notifications ────────────────────────────────────────────────────────────

test("each transition tells exactly the desk that has to act, once", async () => {
  const f = createFixture();
  try {
    const storeUser = userWith(f, "storeop", PERMISSION.STORE_SCANNING);
    const dispatchUser = userWith(f, "dispatchop", PERMISSION.LIVE_DISPATCH);

    const { variantId, ids } = await stockVariant(f, 1);
    const party = createParty(f);
    const gatepassId = await createGatepass(f, party, variantId, 1);

    assert.equal(noticesFor(f, storeUser).length, 0, "nothing for the store while it is unbilled");

    f.db.createSaleVoucher({ partyId: party, voucherDate: "2026-10-06", bookNo: "1", gatepassId });
    const storeNotices = noticesFor(f, storeUser);
    assert.equal(storeNotices.length, 1);
    assert.equal(storeNotices[0]!.kind, NOTIFICATION_KIND.GATEPASS_BILLED);
    assert.match(storeNotices[0]!.title, /ready for Store/);
    assert.equal(storeNotices[0]!.entity_id, gatepassId, "clicking it opens this gatepass");
    assert.match(storeNotices[0]!.message, /ABC TRADERS/);
    assert.match(storeNotices[0]!.message, /DZN/, "the quantity is said in dozens, as the floor reads it");
    assert.equal(noticesFor(f, dispatchUser).length, 0, "dispatch is not told yet");

    await f.moveOut.execute({ rawScan: ids[0]!, context: CONTEXT });
    const dispatchNotices = noticesFor(f, dispatchUser);
    assert.equal(dispatchNotices.length, 1);
    assert.equal(dispatchNotices[0]!.kind, NOTIFICATION_KIND.GATEPASS_AT_GATE);
    assert.match(dispatchNotices[0]!.title, /ready for Dispatch/);
    assert.equal(noticesFor(f, storeUser).length, 1, "the store is not told twice");
  } finally { f.cleanup(); }
});

test("a transition that changes nothing sends no notice", async () => {
  const f = createFixture();
  try {
    const storeUser = userWith(f, "storeop", PERMISSION.STORE_SCANNING);
    const { variantId } = await stockVariant(f, 1);
    const party = createParty(f);
    const gatepassId = await createGatepass(f, party, variantId, 1);
    f.db.createSaleVoucher({ partyId: party, voucherDate: "2026-10-06", bookNo: "1", gatepassId });
    assert.equal(noticesFor(f, storeUser).length, 1);

    // The document is already BILLED, so this guard finds nothing to move.
    assert.equal(f.db.advanceGatepassStatus({ gatepassId, from: "CREATED", to: "BILLED" }), false);
    assert.equal(noticesFor(f, storeUser).length, 1, "no second notice for a move that did not happen");
  } finally { f.cleanup(); }
});

test("a rolled-back transition leaves no notice and no journey step behind", async () => {
  const f = createFixture();
  try {
    const storeUser = userWith(f, "storeop", PERMISSION.STORE_SCANNING);
    const { variantId } = await stockVariant(f, 1);
    const party = createParty(f);
    const gatepassId = await createGatepass(f, party, variantId, 1);

    f.raw.exec("BEGIN IMMEDIATE TRANSACTION");
    assert.equal(f.db.advanceGatepassStatus({ gatepassId, from: "CREATED", to: "BILLED" }), true);
    f.raw.exec("ROLLBACK");

    assert.equal(f.db.getGatepassJourney(gatepassId)!.find((s) => s.status === "BILLED")!.at, null);
    assert.equal(noticesFor(f, storeUser).length, 0, "the desk was never told");
  } finally { f.cleanup(); }
});
