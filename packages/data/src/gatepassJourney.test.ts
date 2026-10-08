// The Gatepass journey: the document's status is the authority for where the goods have got
// to, and every move along it is the consequence of a real operation.
//
//   CREATED ──bill made──▶ BILLED ──last carton out of the store──▶ AT_GATE
//
// Nothing here sets a status directly. Each test performs the business operation — generate,
// produce, receive, bill, move out — and then asks the database what the document says.
// Phase 1 covers those two transitions, the inverse of the first, and what cancelling may no
// longer do once something real has happened.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CancelGatepassUseCase,
  CreateGatepassUseCase,
  InMemoryEventBus,
  ProcessScanUseCase,
  StoreEntryScanUseCase,
  StoreExitScanUseCase,
} from "@erp/application";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { UuidGenerator } from "./idGenerator.js";

const FACTORY = "factory-777";
const CONTEXT = { factoryId: FACTORY, workstationId: "ws-prod-01", deviceId: "desktop-main" };

type Raw = import("node:sqlite").DatabaseSync;

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-gatepass-journey-"));
  const db = new SqliteDatabase({
    dbPath: path.join(tempDir, "journey.db"),
    schemaPath: path.resolve(process.cwd(), "src/local-schema.sql"),
  });
  db.ensureOperationalContext({
    factoryId: FACTORY, factoryCode: "777", factoryName: "777 Manufacturing",
    workstationId: "ws-prod-01", workstationCode: "PROD-01", workstationName: "Production Line 01",
    deviceId: "desktop-main", deviceName: "Desktop Main", appVersion: "1.0.0",
  });
  const raw = (db as unknown as { db: Raw }).db;
  const bus = () => new InMemoryEventBus();
  const ids = () => new UuidGenerator();

  // Wired exactly as apps/desktop/src/main.ts wires them: the database is also the gatepass repository.
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
  const canceller = new CancelGatepassUseCase({ txManager: db, repo: db, idGenerator: ids() });

  const statusOf = (gatepassId: string) =>
    (raw.prepare("SELECT status FROM gatepasses WHERE id = ?").get(gatepassId) as { status: string }).status;

  return { db, raw, produce, receive, moveOut, creator, canceller, statusOf, cleanup: () => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); } };
}

type Fixture = ReturnType<typeof createFixture>;

/** Produces and receives `quantity` cartons of one article/colour/size, the only way stock exists. */
async function stockVariant(f: Fixture, quantity: number, color = "BLACK", article = "SK6", size = "7/10") {
  let row = f.raw.prepare("SELECT id FROM article_sizes WHERE article = ? AND size = ? AND deleted_at IS NULL LIMIT 1").get(article, size) as { id: string } | undefined;
  if (!row) {
    f.db.createProduct({ article, size, sellingPrice: 550, status: "ACTIVE" });
    row = f.raw.prepare("SELECT id FROM article_sizes WHERE article = ? AND size = ? AND deleted_at IS NULL LIMIT 1").get(article, size) as { id: string };
  }
  const ids = f.db.generateQrBatch({ articleSizeId: row.id, color, quantity, createdBy: "admin" }).qrCodes.map((b) => b.id);
  for (const id of ids) {
    assert.equal((await f.produce.execute({ rawScan: id, context: CONTEXT })).accepted, true, `produce ${id}`);
    assert.equal((await f.receive.execute({ rawScan: id, context: CONTEXT })).outcome, "RECEIVED", `receive ${id}`);
  }
  const variant = f.raw.prepare("SELECT id FROM product_variants WHERE article = ? AND color = ? AND size = ?").get(article, color, size) as { id: string };
  return { variantId: variant.id, ids };
}

const createParty = (f: Fixture, name = "ABC TRADERS") => f.db.createParty({ partyName: name, partyType: "CUSTOMER", city: "Lahore", status: "ACTIVE" });

async function createGatepass(f: Fixture, partyId: string, lines: Array<{ variantId: string; quantity: number }>) {
  const result = await f.creator.execute({
    partyId,
    lines: lines.map((l) => ({ productVariantId: l.variantId, quantity: l.quantity })),
    actor: "clerk",
  });
  assert.equal(result.accepted, true, result.reason);
  return result.gatepassId!;
}

const bill = (f: Fixture, partyId: string, gatepassId: string, bookNo = "1") =>
  f.db.createSaleVoucher({ partyId, voucherDate: "2026-10-06", bookNo, gatepassId });

// ─── The journey ──────────────────────────────────────────────────────────────

test("a new Gatepass starts at CREATED — what the screens call Gatepass Issued", async () => {
  const f = createFixture();
  try {
    const { variantId } = await stockVariant(f, 2);
    const gatepassId = await createGatepass(f, createParty(f), [{ variantId, quantity: 2 }]);
    assert.equal(f.statusOf(gatepassId), "CREATED");
  } finally { f.cleanup(); }
});

test("making the bill is what makes it BILLED, and deleting that bill puts it back", async () => {
  const f = createFixture();
  try {
    const { variantId } = await stockVariant(f, 2);
    const party = createParty(f);
    const gatepassId = await createGatepass(f, party, [{ variantId, quantity: 2 }]);

    const voucher = bill(f, party, gatepassId);
    assert.equal(f.statusOf(gatepassId), "BILLED");

    f.db.deleteSaleVoucher(voucher.id, "wrong party");
    assert.equal(f.statusOf(gatepassId), "CREATED", "the document is waiting to be billed again");
  } finally { f.cleanup(); }
});

test("a refused second bill leaves both the Gatepass and the first bill exactly as they were", async () => {
  const f = createFixture();
  try {
    const { variantId } = await stockVariant(f, 2);
    const party = createParty(f);
    const gatepassId = await createGatepass(f, party, [{ variantId, quantity: 2 }]);
    bill(f, party, gatepassId);

    assert.throws(() => bill(f, party, gatepassId, "2"), /already has Sale Voucher/);

    assert.equal(f.statusOf(gatepassId), "BILLED");
    assert.equal(
      Number((f.raw.prepare("SELECT COUNT(1) n FROM sale_vouchers WHERE gatepass_id = ? AND deleted_at IS NULL").get(gatepassId) as { n: number }).n),
      1,
      "nothing was written by the refused attempt"
    );
  } finally { f.cleanup(); }
});

test("the carton that empties the last line sends the whole document to AT_GATE", async () => {
  const f = createFixture();
  try {
    const { variantId, ids } = await stockVariant(f, 2);
    const party = createParty(f);
    const gatepassId = await createGatepass(f, party, [{ variantId, quantity: 2 }]);
    bill(f, party, gatepassId);

    const first = await f.moveOut.execute({ rawScan: ids[0]!, context: CONTEXT });
    assert.equal(first.accepted, true);
    assert.equal(first.gatepassReachedGate, false, "one of two cartons is not the whole document");
    assert.equal(f.statusOf(gatepassId), "BILLED");

    const second = await f.moveOut.execute({ rawScan: ids[1]!, context: CONTEXT });
    assert.equal(second.gatepassReachedGate, true);
    assert.equal(f.statusOf(gatepassId), "AT_GATE");
  } finally { f.cleanup(); }
});

test("a Gatepass with two lines waits for both of them", async () => {
  const f = createFixture();
  try {
    const black = await stockVariant(f, 1, "BLACK");
    const blue = await stockVariant(f, 1, "BLUE");
    const party = createParty(f);
    const gatepassId = await createGatepass(f, party, [
      { variantId: black.variantId, quantity: 1 },
      { variantId: blue.variantId, quantity: 1 },
    ]);
    bill(f, party, gatepassId);

    await f.moveOut.execute({ rawScan: black.ids[0]!, context: CONTEXT });
    assert.equal(f.statusOf(gatepassId), "BILLED", "the blue line is still owed");

    await f.moveOut.execute({ rawScan: blue.ids[0]!, context: CONTEXT });
    assert.equal(f.statusOf(gatepassId), "AT_GATE");
  } finally { f.cleanup(); }
});

test("an unbilled Gatepass is not carried through the journey by store scans alone", async () => {
  const f = createFixture();
  try {
    const { variantId, ids } = await stockVariant(f, 1);
    const gatepassId = await createGatepass(f, createParty(f), [{ variantId, quantity: 1 }]);

    const result = await f.moveOut.execute({ rawScan: ids[0]!, context: CONTEXT });
    assert.equal(result.accepted, true, "the carton still physically moves");
    assert.equal(result.gatepassReachedGate, false);
    assert.equal(f.statusOf(gatepassId), "CREATED", "billing has not happened, so the document waits");
  } finally { f.cleanup(); }
});

test("reserved cartons stay reserved after billing — Reflected Stock must not jump", async () => {
  const f = createFixture();
  try {
    const { variantId } = await stockVariant(f, 5);
    const party = createParty(f);
    const gatepassId = await createGatepass(f, party, [{ variantId, quantity: 3 }]);

    const before = f.db.listStoreStock().find((row) => row.productVariantId === variantId);
    assert.equal(before?.reservedQuantity, 3);
    assert.equal(before?.reflectedQuantity, 2);

    bill(f, party, gatepassId);

    const after = f.db.listStoreStock().find((row) => row.productVariantId === variantId);
    assert.equal(after?.reservedQuantity, 3, "billing does not release the reservation");
    assert.equal(after?.reflectedQuantity, 2);
    assert.equal(after?.storeQuantity, 5, "and nothing physical moved");
  } finally { f.cleanup(); }
});

// ─── What cancelling may no longer do ─────────────────────────────────────────

test("a Gatepass can still be cancelled while nothing has happened to it", async () => {
  const f = createFixture();
  try {
    const { variantId } = await stockVariant(f, 2);
    const gatepassId = await createGatepass(f, createParty(f), [{ variantId, quantity: 2 }]);

    const result = await f.canceller.execute({ gatepassId, reason: "wrong party", actor: "clerk" });
    assert.equal(result.accepted, true);
    assert.equal(f.statusOf(gatepassId), "CANCELLED");
  } finally { f.cleanup(); }
});

test("a billed Gatepass is unwound from the billing side, not cancelled behind the bill", async () => {
  const f = createFixture();
  try {
    const { variantId } = await stockVariant(f, 2);
    const party = createParty(f);
    const gatepassId = await createGatepass(f, party, [{ variantId, quantity: 2 }]);
    bill(f, party, gatepassId);

    const result = await f.canceller.execute({ gatepassId, reason: "wrong party", actor: "clerk" });
    assert.equal(result.accepted, false);
    assert.equal(result.outcome, "BILLED");
    assert.match(result.reason ?? "", /Delete Sale Voucher #1 first/);
    assert.equal(f.statusOf(gatepassId), "BILLED", "nothing changed");
  } finally { f.cleanup(); }
});

test("once a carton has left the store the document can no longer be cancelled", async () => {
  const f = createFixture();
  try {
    const { variantId, ids } = await stockVariant(f, 2);
    const gatepassId = await createGatepass(f, createParty(f), [{ variantId, quantity: 2 }]);
    await f.moveOut.execute({ rawScan: ids[0]!, context: CONTEXT });

    const result = await f.canceller.execute({ gatepassId, reason: "changed mind", actor: "clerk" });
    assert.equal(result.accepted, false);
    assert.equal(result.outcome, "ALREADY_MOVED");
    assert.match(result.reason ?? "", /already left the store/);
    assert.equal(f.statusOf(gatepassId), "CREATED", "nothing changed");
  } finally { f.cleanup(); }
});

// ─── The guard itself ─────────────────────────────────────────────────────────

test("an illegal status move is refused as a programming error, never written", () => {
  const f = createFixture();
  try {
    assert.throws(
      () => f.db.advanceGatepassStatus({ gatepassId: "whatever", from: "CREATED", to: "DELIVERED" }),
      /cannot go from CREATED to DELIVERED/
    );
  } finally { f.cleanup(); }
});

test("only one of two racing completions moves the document", async () => {
  const f = createFixture();
  try {
    const { variantId } = await stockVariant(f, 1);
    const party = createParty(f);
    const gatepassId = await createGatepass(f, party, [{ variantId, quantity: 1 }]);
    bill(f, party, gatepassId);

    assert.equal(f.db.advanceGatepassStatus({ gatepassId, from: "BILLED", to: "AT_GATE" }), true);
    assert.equal(
      f.db.advanceGatepassStatus({ gatepassId, from: "BILLED", to: "AT_GATE" }),
      false,
      "the second caller is told it changed nothing rather than advancing it twice"
    );
    assert.equal(f.statusOf(gatepassId), "AT_GATE");
  } finally { f.cleanup(); }
});
