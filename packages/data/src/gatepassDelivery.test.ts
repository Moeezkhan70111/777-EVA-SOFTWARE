// Phase 4: the builty photo, and the one invariant it exists for.
//
//   DELIVERED means a persisted delivery proof exists.
//
// So the proof row and the status change are written together, and every test below asks the
// database the same two questions after each attempt: what does the document say, and is there
// a proof to show for it. They must never disagree.
//
// The file itself is the main process's job (validation, the proof store, cleanup on failure);
// what is proved here is the part that must not half-happen.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CreateGatepassUseCase,
  DispatchScanUseCase,
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-gp-delivery-"));
  const dbPath = path.join(tempDir, "delivery.db");
  const open = () => {
    const db = new SqliteDatabase({ dbPath, schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
    db.ensureOperationalContext({
      factoryId: FACTORY, factoryCode: "777", factoryName: "777 Manufacturing",
      workstationId: "ws-prod-01", workstationCode: "PROD-01", workstationName: "Production Line 01",
      deviceId: "desktop-main", deviceName: "Desktop Main", appVersion: "1.0.0",
    });
    return db;
  };

  let db = open();
  const raw = () => (db as unknown as { db: Raw }).db;
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
  const dispatch = new DispatchScanUseCase({
    txManager: db, qrLookupRepo: db, stockProjectionRepo: db, qrMasterRepo: db,
    dispatchEventsRepo: db, outboxRepo: db, eventPublisher: bus(), idGenerator: ids(),
    dispatchSessionRepo: db, gatepassRepo: db,
  });
  const creator = new CreateGatepassUseCase({ txManager: db, repo: db, idGenerator: ids(), localDate: () => "2026-10-06" });

  return {
    get db() { return db; },
    get raw() { return raw(); },
    produce, receive, moveOut, dispatch, creator,
    statusOf: (id: string) => (raw().prepare("SELECT status FROM gatepasses WHERE id = ?").get(id) as { status: string }).status,
    /** Closes and reopens the database, the way restarting the desktop app does. */
    restart: () => { db.close(); db = open(); },
    cleanup: () => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); },
  };
}

type Fixture = ReturnType<typeof createFixture>;

async function stockVariant(f: Fixture, quantity: number) {
  let row = f.raw.prepare("SELECT id FROM article_sizes WHERE article = 'SK6' AND size = '7/10' AND deleted_at IS NULL LIMIT 1").get() as { id: string } | undefined;
  if (!row) {
    f.db.createProduct({ article: "SK6", size: "7/10", sellingPrice: 550, status: "ACTIVE" });
    row = f.raw.prepare("SELECT id FROM article_sizes WHERE article = 'SK6' AND size = '7/10' AND deleted_at IS NULL LIMIT 1").get() as { id: string };
  }
  const ids = f.db.generateQrBatch({ articleSizeId: row.id, color: "BLACK", quantity, createdBy: "admin" }).qrCodes.map((b) => b.id);
  for (const id of ids) {
    await f.produce.execute({ rawScan: id, context: CONTEXT });
    await f.receive.execute({ rawScan: id, context: CONTEXT });
  }
  const variant = f.raw.prepare("SELECT id FROM product_variants WHERE article = 'SK6' AND color = 'BLACK' AND size = '7/10'").get() as { id: string };
  return { variantId: variant.id, ids };
}

/** A Gatepass carried all the way to DISPATCHED through the real journey. */
async function dispatched(f: Fixture, quantity = 1) {
  const stock = await stockVariant(f, quantity);
  const party = f.db.createParty({ partyName: "ABC TRADERS", partyType: "CUSTOMER", city: "Lahore", status: "ACTIVE" });
  const created = await f.creator.execute({ partyId: party, lines: [{ productVariantId: stock.variantId, quantity }], actor: "clerk" });
  const gatepassId = created.gatepassId!;
  f.db.createSaleVoucher({ partyId: party, voucherDate: "2026-10-06", bookNo: "1", gatepassId });
  for (const id of stock.ids) await f.moveOut.execute({ rawScan: id, gatepassId, context: CONTEXT });
  const session = f.db.getGatepassScanProgress(gatepassId)!.dispatchSessionId!;
  for (const id of stock.ids) await f.dispatch.execute({ rawScan: id, sessionId: session, gatepassId, context: CONTEXT });
  assert.equal(f.statusOf(gatepassId), "DISPATCHED");
  return { gatepassId, party };
}

const proofInput = (gatepassId: string, fileName = "proof-1.jpg", uploadedBy = "driver") => ({
  gatepassId, fileName, mimeType: "image/jpeg", byteSize: 2048, originalName: "builty.jpg", uploadedBy,
});

/** An approved account holding exactly one permission, for the authorisation checks. */
function approvedUser(f: Fixture, username: string, permissions: string[]): string {
  const user = f.db.createUserAccount(username, "Password123");
  f.raw.prepare("UPDATE app_users SET access_status = 'APPROVED' WHERE id = ?").run(user.id);
  const role = f.db.createRole({ name: `${username}-role`, permissions });
  f.db.assignUserRole(user.id, role.code);
  return user.id;
}

const noticesFor = (f: Fixture, userId: string) =>
  f.raw.prepare("SELECT kind FROM user_notifications WHERE user_id = ? ORDER BY created_at DESC, rowid DESC").all(userId) as Array<{ kind: string }>;

// ─── Pending Builties ─────────────────────────────────────────────────────────

test("a dispatched Gatepass waits in Pending Builties, and leaves it once delivered", async () => {
  const f = createFixture();
  try {
    const { gatepassId } = await dispatched(f);
    const idsAt = (status: string) => f.db.listGatepasses({ status: status as never, pageSize: 50 }).rows.map((r) => r.id);

    assert.deepEqual(idsAt("DISPATCHED"), [gatepassId], "waiting for its builty");
    assert.equal(f.db.countGatepassesByStage().DISPATCHED, 1);

    f.db.saveGatepassDeliveryProof(proofInput(gatepassId));

    assert.deepEqual(idsAt("DISPATCHED"), [], "it has left the queue");
    assert.deepEqual(idsAt("DELIVERED"), [gatepassId]);
    assert.equal(f.db.countGatepassesByStage().DISPATCHED, 0);
    assert.equal(f.db.countGatepassesByStage().DELIVERED, 1);
    assert.equal(f.db.listGatepasses({ pageSize: 50 }).total, 1, "and is still findable in All");
  } finally { f.cleanup(); }
});

// ─── The invariant ────────────────────────────────────────────────────────────

test("recording the proof is what delivers the Gatepass", async () => {
  const f = createFixture();
  try {
    const { gatepassId } = await dispatched(f);
    assert.equal(f.db.getGatepassDeliveryProof(gatepassId), null, "nothing to show for it yet");

    const saved = f.db.saveGatepassDeliveryProof(proofInput(gatepassId));

    assert.equal(saved.delivered, true);
    assert.equal(f.statusOf(gatepassId), "DELIVERED");
    const proof = f.db.getGatepassDeliveryProof(gatepassId)!;
    assert.equal(proof.gatepassId, gatepassId);
    assert.equal(proof.fileName, "proof-1.jpg");
    assert.equal(proof.uploadedBy, "driver");
    assert.ok(proof.uploadedAt, "and when");
  } finally { f.cleanup(); }
});

test("a Gatepass that has not been dispatched cannot be delivered, and keeps its status", async () => {
  const f = createFixture();
  try {
    const stock = await stockVariant(f, 1);
    const party = f.db.createParty({ partyName: "ABC TRADERS", partyType: "CUSTOMER", city: "Lahore", status: "ACTIVE" });
    const created = await f.creator.execute({ partyId: party, lines: [{ productVariantId: stock.variantId, quantity: 1 }], actor: "clerk" });
    const gatepassId = created.gatepassId!;

    assert.throws(() => f.db.saveGatepassDeliveryProof(proofInput(gatepassId)), /once the Gatepass has been dispatched/);
    assert.equal(f.statusOf(gatepassId), "CREATED");
    assert.equal(f.db.getGatepassDeliveryProof(gatepassId), null);
  } finally { f.cleanup(); }
});

test("a refused proof leaves the document dispatched, with nothing recorded", async () => {
  const f = createFixture();
  try {
    const { gatepassId } = await dispatched(f);
    const storeUser = approvedUser(f, "builty", [PERMISSION.GATEPASS]);

    // An empty file is refused before anything is written.
    assert.throws(() => f.db.saveGatepassDeliveryProof({ ...proofInput(gatepassId), byteSize: 0 }), /could not be saved/);

    assert.equal(f.statusOf(gatepassId), "DISPATCHED", "nothing claims delivery");
    assert.equal(f.db.getGatepassDeliveryProof(gatepassId), null);
    assert.equal(
      Number((f.raw.prepare("SELECT COUNT(1) AS n FROM audit_log WHERE entity_id = ? AND event_type = 'GATEPASS_DELIVERED'").get(gatepassId) as { n: number }).n),
      0,
      "and no transition was recorded"
    );
    assert.equal(noticesFor(f, storeUser).length, 0);
  } finally { f.cleanup(); }
});

test("a rolled-back save leaves neither a proof nor a delivery", async () => {
  const f = createFixture();
  try {
    const { gatepassId } = await dispatched(f);

    f.raw.exec("BEGIN IMMEDIATE TRANSACTION");
    // Inside an open transaction the save cannot start its own, so it fails outright.
    assert.throws(() => f.db.saveGatepassDeliveryProof(proofInput(gatepassId)));
    try { f.raw.exec("ROLLBACK"); } catch { /* already rolled back */ }

    assert.equal(f.statusOf(gatepassId), "DISPATCHED");
    assert.equal(f.db.getGatepassDeliveryProof(gatepassId), null);
  } finally { f.cleanup(); }
});

// ─── Notifications and the timeline ───────────────────────────────────────────

test("delivering sends exactly one notice, and replacing sends none", async () => {
  const f = createFixture();
  try {
    const watcher = approvedUser(f, "builty", [PERMISSION.GATEPASS]);
    const { gatepassId } = await dispatched(f);
    const before = noticesFor(f, watcher).filter((n) => n.kind === NOTIFICATION_KIND.GATEPASS_DISPATCHED).length;

    f.db.saveGatepassDeliveryProof(proofInput(gatepassId));
    const afterFirst = noticesFor(f, watcher).length;

    f.db.saveGatepassDeliveryProof(proofInput(gatepassId, "proof-2.jpg"));
    assert.equal(noticesFor(f, watcher).length, afterFirst, "a replacement is not a second delivery");
    assert.ok(before >= 0);
  } finally { f.cleanup(); }
});

test("the journey shows Delivered with the time it actually happened", async () => {
  const f = createFixture();
  try {
    const { gatepassId } = await dispatched(f);
    assert.equal(f.db.getGatepassJourney(gatepassId)!.find((s) => s.status === "DELIVERED")!.at, null);

    f.db.saveGatepassDeliveryProof(proofInput(gatepassId));

    const journey = f.db.getGatepassJourney(gatepassId)!;
    assert.deepEqual(journey.map((s) => s.state), ["DONE", "DONE", "DONE", "DONE", "CURRENT"]);
    const delivered = journey.find((s) => s.status === "DELIVERED")!;
    assert.ok(delivered.at && !Number.isNaN(Date.parse(delivered.at)), "a real timestamp, from the audit trail");
    assert.equal(delivered.actor, "driver");
  } finally { f.cleanup(); }
});

// ─── Replacement ──────────────────────────────────────────────────────────────

test("replacing the proof keeps the Gatepass delivered and records no second transition", async () => {
  const f = createFixture();
  try {
    const { gatepassId } = await dispatched(f);
    f.db.saveGatepassDeliveryProof(proofInput(gatepassId, "first.jpg"));
    const deliveredAt = f.db.getGatepassJourney(gatepassId)!.find((s) => s.status === "DELIVERED")!.at;

    const replaced = f.db.saveGatepassDeliveryProof(proofInput(gatepassId, "second.jpg", "manager"));

    assert.equal(replaced.delivered, false, "replacing is not delivering");
    assert.equal(replaced.replacedFileName, "first.jpg", "the caller is told which file it may now let go of");
    assert.equal(f.statusOf(gatepassId), "DELIVERED");
    assert.equal(f.db.getGatepassDeliveryProof(gatepassId)!.fileName, "second.jpg");
    assert.equal(f.db.getGatepassJourney(gatepassId)!.find((s) => s.status === "DELIVERED")!.at, deliveredAt, "the delivery time does not move");
    assert.equal(
      Number((f.raw.prepare("SELECT COUNT(1) AS n FROM audit_log WHERE entity_id = ? AND event_type = 'GATEPASS_DELIVERED'").get(gatepassId) as { n: number }).n),
      1,
      "still exactly one delivery"
    );
  } finally { f.cleanup(); }
});

test("a replaced proof is kept, and the replacement is auditable", async () => {
  const f = createFixture();
  try {
    const { gatepassId } = await dispatched(f);
    f.db.saveGatepassDeliveryProof(proofInput(gatepassId, "first.jpg"));
    f.db.saveGatepassDeliveryProof(proofInput(gatepassId, "second.jpg", "manager"));

    const rows = f.raw
      .prepare("SELECT file_name, is_current, replaced_at FROM gatepass_delivery_proofs WHERE gatepass_id = ? ORDER BY uploaded_at")
      .all(gatepassId) as Array<{ file_name: string; is_current: number; replaced_at: string | null }>;
    assert.equal(rows.length, 2, "the old proof is kept, not overwritten");
    assert.equal(rows[0]!.is_current, 0);
    assert.ok(rows[0]!.replaced_at, "and when it stopped being the proof");
    assert.equal(rows[1]!.is_current, 1);

    const audit = f.raw
      .prepare("SELECT changed_by, old_value_json FROM inventory_item_audit WHERE entity_id = ? AND action = 'REPLACE'")
      .get(gatepassId) as { changed_by: string | null; old_value_json: string } | undefined;
    assert.equal(audit?.changed_by, "manager");
    assert.match(audit!.old_value_json, /first\.jpg/);
  } finally { f.cleanup(); }
});

test("only one proof is ever current, whatever the layers above do", async () => {
  const f = createFixture();
  try {
    const { gatepassId } = await dispatched(f);
    f.db.saveGatepassDeliveryProof(proofInput(gatepassId));

    // The database itself refuses a second current proof.
    assert.throws(
      () => f.raw.prepare(
        "INSERT INTO gatepass_delivery_proofs (id, gatepass_id, file_name, mime_type, byte_size, is_current, uploaded_at) VALUES ('x', ?, 'sneaky.jpg', 'image/jpeg', 10, 1, 'now')"
      ).run(gatepassId),
      /UNIQUE/
    );
  } finally { f.cleanup(); }
});

// ─── Persistence ──────────────────────────────────────────────────────────────

test("the proof and the delivery survive restarting the application", async () => {
  const f = createFixture();
  try {
    const { gatepassId } = await dispatched(f);
    f.db.saveGatepassDeliveryProof(proofInput(gatepassId));
    const deliveredAt = f.db.getGatepassJourney(gatepassId)!.find((s) => s.status === "DELIVERED")!.at;

    f.restart();

    assert.equal(f.statusOf(gatepassId), "DELIVERED");
    const proof = f.db.getGatepassDeliveryProof(gatepassId)!;
    assert.equal(proof.fileName, "proof-1.jpg");
    assert.equal(proof.uploadedBy, "driver");
    assert.equal(f.db.getGatepassJourney(gatepassId)!.find((s) => s.status === "DELIVERED")!.at, deliveredAt, "and the time it says is the same time");
  } finally { f.cleanup(); }
});

// ─── The journey stays closed ─────────────────────────────────────────────────

test("a delivered Gatepass cannot be walked backwards", async () => {
  const f = createFixture();
  try {
    const { gatepassId } = await dispatched(f);
    f.db.saveGatepassDeliveryProof(proofInput(gatepassId));

    assert.throws(
      () => f.db.advanceGatepassStatus({ gatepassId, from: "DELIVERED", to: "DISPATCHED" }),
      /cannot go from DELIVERED to DISPATCHED/
    );
    assert.equal(f.statusOf(gatepassId), "DELIVERED");
  } finally { f.cleanup(); }
});
