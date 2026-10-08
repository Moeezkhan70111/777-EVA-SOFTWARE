import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DispatchScanUseCase,
  InMemoryEventBus,
  ProcessScanUseCase,
  ReturnScanUseCase,
  StoreEntryScanUseCase,
  StoreExitScanUseCase,
} from "@erp/application";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { UuidGenerator } from "./idGenerator.js";

// Carton returns against the real database, driven by real scans through the real use cases.
//
// The rule every test here exists to protect:
//
//   RETURN SCAN  ≠  STORE IN
//
// Confirming a return is a COMMERCIAL event: it credits the customer and leaves the carton
// standing ON GATE. Receiving it is a PHYSICAL event: an ordinary Store Move In, made by an
// operator who selects no party, no voucher and no return. Only the second one moves stock.
//
// Every figure below is read back through the same repositories the screens use, or straight
// out of the tables, never from the use case's own return value.

const FACTORY = "factory-777";
const CONTEXT = { factoryId: FACTORY, workstationId: "ws-01", deviceId: "desktop-main" };

type Raw = import("node:sqlite").DatabaseSync;

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-sale-returns-"));
  const dbPath = path.join(tempDir, "returns.db");
  const db = new SqliteDatabase({ dbPath, schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  db.ensureOperationalContext({
    factoryId: FACTORY,
    factoryCode: "777",
    factoryName: "777 Manufacturing",
    workstationId: "ws-01",
    workstationCode: "WS-01",
    workstationName: "Workstation 01",
    deviceId: "desktop-main",
    deviceName: "Desktop Main",
    appVersion: "1.0.0",
  });
  return {
    db,
    dbPath,
    raw: (db as unknown as { db: Raw }).db,
    cleanup: () => {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

// Wired exactly as apps/desktop/src/main.ts wires them: the database is every repository.
const bus = () => new InMemoryEventBus();
const ids = () => new UuidGenerator();

const producer = (db: SqliteDatabase) =>
  new ProcessScanUseCase({ txManager: db, duplicateChecker: db, qrRegistry: db, productCatalog: db, qrMasterRepo: db, productionEventsRepo: db, stockProjectionRepo: db, outboxRepo: db, eventPublisher: bus(), idGenerator: ids() });

const receiver = (db: SqliteDatabase) =>
  new StoreEntryScanUseCase({ txManager: db, qrLookupRepo: db, gatepassRepo: db, qrRegistry: db, qrMasterRepo: db, storeEntryEventsRepo: db, stockProjectionRepo: db, outboxRepo: db, eventPublisher: bus(), idGenerator: ids() });

const mover = (db: SqliteDatabase) =>
  new StoreExitScanUseCase({ txManager: db, qrLookupRepo: db, gatepassRepo: db, qrRegistry: db, qrMasterRepo: db, storeExitEventsRepo: db, stockProjectionRepo: db, outboxRepo: db, eventPublisher: bus(), idGenerator: ids() });

const dispatcher = (db: SqliteDatabase) =>
  new DispatchScanUseCase({ txManager: db, qrLookupRepo: db, stockProjectionRepo: db, qrMasterRepo: db, dispatchEventsRepo: db, outboxRepo: db, eventPublisher: bus(), idGenerator: ids(), dispatchSessionRepo: db });

const returner = (db: SqliteDatabase) =>
  new ReturnScanUseCase({ txManager: db, qrLookupRepo: db, attributionRepo: db, qrMasterRepo: db, saleReturnsRepo: db, returnEventsRepo: db, outboxRepo: db, eventPublisher: bus(), idGenerator: ids() });

// ─── Setup helpers ───────────────────────────────────────────────────────────

/** Registers `quantity` QR identities for article/size/colour through the real generator. */
function generate(db: SqliteDatabase, raw: Raw, article: string, size: string, color: string, quantity: number): string[] {
  let row = raw.prepare("SELECT id FROM article_sizes WHERE article = ? AND size = ? AND deleted_at IS NULL LIMIT 1").get(article, size) as { id: string } | undefined;
  if (!row) {
    db.createProduct({ article, size, sellingPrice: 550, status: "ACTIVE" });
    row = raw.prepare("SELECT id FROM article_sizes WHERE article = ? AND size = ? AND deleted_at IS NULL LIMIT 1").get(article, size) as { id: string };
  }
  return db.generateQrBatch({ articleSizeId: row.id, color, quantity, createdBy: "admin" }).qrCodes.map((b) => b.id);
}

/** Produces every id and receives it into the store, so each carton is In Store. */
async function stockInStore(db: SqliteDatabase, raw: Raw, article: string, size: string, color: string, quantity: number) {
  const qrIds = generate(db, raw, article, size, color, quantity);
  const produce = producer(db);
  const receive = receiver(db);
  for (const id of qrIds) {
    assert.equal((await produce.execute({ rawScan: id, context: CONTEXT })).accepted, true, `produce ${id}`);
    assert.equal((await receive.execute({ rawScan: id, context: CONTEXT })).outcome, "RECEIVED", `receive ${id}`);
  }
  const variant = raw.prepare("SELECT id FROM product_variants WHERE article = ? AND color = ? AND size = ?").get(article, color, size) as { id: string };
  return { variantId: variant.id, qrIds };
}

/**
 * A customer and a one-line bill for this article/size, with the dispatch session it creates.
 * A discount has to be allowed by a real party discount rule before a line may carry it, so
 * `pairDiscount` sets that rule up the same way the Discount Policy screen would.
 */
function billFor(db: SqliteDatabase, input: { partyName: string; variantId: string; article?: string; dozens: number; pairRate?: number; pairDiscount?: number }) {
  const partyId = db.createParty({ partyName: input.partyName, partyType: "CUSTOMER", city: "Lahore", status: "ACTIVE" });
  if (input.pairDiscount) {
    db.createPartyArticleDiscount({ partyId, article: input.article ?? "SK6", discountPerPair: input.pairDiscount });
  }
  const voucher = db.createSaleVoucher({ partyId, voucherDate: "2026-09-22", bookNo: "B1" });
  db.addVoucherLineItem(voucher.id, {
    productVariantId: input.variantId,
    quantity: input.dozens,
    unitPrice: input.pairRate ?? 180,
    discount: input.pairDiscount === undefined ? 0 : input.pairDiscount * 12 * input.dozens,
  });
  const session = db.listDispatchSessions({ status: "ALL" }).find((s) => s.voucherId === voucher.id)!;
  return { partyId, voucherId: voucher.id, voucherNumber: session.voucherNumber, sessionId: session.sessionId };
}

/** Takes a carton from the store out to the gate, then dispatches it against a bill. */
async function moveOutAndDispatch(db: SqliteDatabase, qrId: string, sessionId: string) {
  assert.equal((await mover(db).execute({ rawScan: qrId, context: CONTEXT, actor: "store-op" })).outcome, "MOVED_OUT", "move out");
  const dispatched = await dispatcher(db).execute({ rawScan: qrId, sessionId, context: CONTEXT });
  assert.equal(dispatched.accepted, true, dispatched.reason);
}

// ─── Assertion helpers ───────────────────────────────────────────────────────

const qrStatus = (raw: Raw, qrId: string): string =>
  String((raw.prepare("SELECT current_status FROM qr_master WHERE qr_id = ?").get(qrId) as { current_status: string }).current_status);

/** Cartons the company holds (variant pool) and cartons physically In Store. */
function stock(raw: Raw, variantId: string) {
  const pool = raw.prepare("SELECT quantity_on_hand FROM stock_projection_by_variant WHERE product_variant_id = ?").get(variantId) as { quantity_on_hand: number } | undefined;
  const store = raw.prepare("SELECT quantity_on_hand FROM stock_projection_by_location WHERE product_variant_id = ? AND location_type = 'WAREHOUSE'").get(variantId) as { quantity_on_hand: number } | undefined;
  return { pool: Number(pool?.quantity_on_hand ?? 0), inStore: Number(store?.quantity_on_hand ?? 0) };
}

const countRows = (raw: Raw, sql: string, ...params: unknown[]): number =>
  Number((raw.prepare(sql).get(...(params as never[])) as { c: number }).c);

const storeEntryEventCount = (raw: Raw, qrId: string): number =>
  countRows(raw, "SELECT COUNT(1) c FROM production_events WHERE qr_id = ? AND event_type = 'MOVED' AND json_extract(metadata_json, '$.eventType') = 'STORE_ENTRY'", qrId);

const returnEventCount = (raw: Raw, qrId: string): number =>
  countRows(raw, "SELECT COUNT(1) c FROM production_events WHERE qr_id = ? AND event_type = 'RETURNED'", qrId);

// ═════════════════════════════════════════════════════════════════════════════
// THE ACCEPTANCE SCENARIO (requirement §23), step by step, in one test.
// ═════════════════════════════════════════════════════════════════════════════

test("ACCEPTANCE — MAMA CHAPPAL buys a carton, returns it on the gate, and the store receives it later", async () => {
  const f = createFixture();
  try {
    // ── Step 1: MAMA CHAPPAL buys one carton (half a dozen) on SV-125. ────────
    const { variantId, qrIds } = await stockInStore(f.db, f.raw, "SK6", "7/10", "RED", 1);
    const qr = qrIds[0];
    const bill = billFor(f.db, { partyName: "MAMA CHAPPAL", variantId, dozens: 0.5, pairRate: 180 });

    assert.deepEqual(stock(f.raw, variantId), { pool: 1, inStore: 1 }, "the carton starts In Store");
    assert.equal(f.db.getCurrentPartyBalance(bill.partyId), 1080, "the bill debits 6 pairs at 180");

    // ── Step 2: the carton appears in Live Dispatch and is scanned out. ───────
    await moveOutAndDispatch(f.db, qr, bill.sessionId);

    assert.equal(qrStatus(f.raw, qr), "DISPATCHED");
    assert.deepEqual(stock(f.raw, variantId), { pool: 0, inStore: 0 }, "dispatch takes the carton out of stock");

    // TEST A — the exact QR resolves its party and voucher while it is out.
    const preview = await returner(f.db).lookup({ rawScan: qr });
    assert.equal(preview.accepted, true, preview.reason);
    assert.equal(preview.attribution?.partyName, "MAMA CHAPPAL");
    assert.equal(preview.attribution?.saleVoucherNumber, bill.voucherNumber);
    assert.equal(preview.attribution?.creditAmount, 1080);
    // The screen shows DISPATCHED before the operator confirms, exactly as specified.
    assert.equal(preview.currentStatus, "DISPATCHED");
    assert.deepEqual([preview.article, preview.color, preview.size], ["SK6", "RED", "7/10"]);

    // ── Step 3: MAMA CHAPPAL returns the carton. The gate confirms. ───────────
    const confirmed = await returner(f.db).execute({ rawScan: qr, context: CONTEXT, actor: "gate-op" });

    assert.equal(confirmed.accepted, true, confirmed.reason);
    assert.equal(confirmed.attribution?.partyName, "MAMA CHAPPAL", "the party came from the QR, not an operator");
    assert.equal(confirmed.returnNumber, "SR-000001");

    // The four things that must be true after a return, and the two that must not.
    assert.equal(qrStatus(f.raw, qr), "ON_GATE", "the carton is ON GATE, not In Store");
    assert.deepEqual(stock(f.raw, variantId), { pool: 0, inStore: 0 }, "a recorded return moves no stock at all");
    assert.equal(storeEntryEventCount(f.raw, qr), 1, "no store entry was invented (still just the original receipt)");
    assert.equal(f.db.getCurrentPartyBalance(bill.partyId), 0, "the ledger return credits MAMA CHAPPAL 1080");

    // The credit is a real document against the right party and the right bill.
    const credit = f.raw.prepare("SELECT * FROM sale_returns WHERE qr_id = ?").get(qr) as Record<string, unknown>;
    assert.equal(String(credit.party_id), bill.partyId);
    assert.equal(String(credit.sale_voucher_id), bill.voucherId);
    assert.equal(Number(credit.total_amount_paisa), 108000, "money is exact integer paisa");
    assert.equal(Number(credit.quantity_cartons), 1);

    // ── Step 4: the carton is carried back and the STORE scans it in. ─────────
    // The store operator selects no party, no voucher and no return.
    const received = await receiver(f.db).execute({ rawScan: qr, context: CONTEXT, actor: "store-op" });

    assert.equal(received.outcome, "RECEIVED", received.reason);
    assert.equal(received.previousStatus, "ON_GATE");
    assert.equal(qrStatus(f.raw, qr), "WAREHOUSE", "only now is the carton In Store");
    assert.deepEqual(stock(f.raw, variantId), { pool: 1, inStore: 1 }, "Store Stock +1 happens here and only here");

    // And no second commercial return was created by the physical receipt.
    assert.equal(countRows(f.raw, "SELECT COUNT(1) c FROM sale_returns WHERE qr_id = ?", qr), 1);
    assert.equal(f.db.getCurrentPartyBalance(bill.partyId), 0, "the balance did not move again");
  } finally {
    f.cleanup();
  }
});

// ─── TEST A — dispatch attribution ───────────────────────────────────────────

test("TEST A — the exact QR resolves its party and sale voucher from its own dispatch event", async () => {
  const f = createFixture();
  try {
    const { variantId, qrIds } = await stockInStore(f.db, f.raw, "SK6", "7/10", "RED", 2);
    const bill = billFor(f.db, { partyName: "MAMA CHAPPAL", variantId, dozens: 1 });
    await moveOutAndDispatch(f.db, qrIds[0], bill.sessionId);

    // The attribution chain is stored, not derived from article/colour/size or a timestamp:
    // the DISPATCHED event names the session, the session names the voucher, the voucher the party.
    const event = f.raw
      .prepare("SELECT dispatch_session_id FROM production_events WHERE qr_id = ? AND event_type = 'DISPATCHED'")
      .get(qrIds[0]) as { dispatch_session_id: string };
    assert.equal(event.dispatch_session_id, bill.sessionId);

    const resolved = await returner(f.db).lookup({ rawScan: qrIds[0] });
    assert.equal(resolved.attribution?.partyId, bill.partyId);
    assert.equal(resolved.attribution?.saleVoucherId, bill.voucherId);

    // The carton that was never dispatched has no attribution and cannot be returned.
    const untouched = await returner(f.db).lookup({ rawScan: qrIds[1] });
    assert.equal(untouched.accepted, false);
    assert.equal(untouched.outcome, "NOT_DISPATCHED");
  } finally {
    f.cleanup();
  }
});

test("two customers ordering the same article and size each get back only their own carton", async () => {
  const f = createFixture();
  try {
    const { variantId, qrIds } = await stockInStore(f.db, f.raw, "SK6", "7/10", "RED", 2);
    const mama = billFor(f.db, { partyName: "MAMA CHAPPAL", variantId, dozens: 0.5 });
    const abc = billFor(f.db, { partyName: "ABC TRADERS", variantId, dozens: 0.5 });

    await moveOutAndDispatch(f.db, qrIds[0], mama.sessionId);
    await moveOutAndDispatch(f.db, qrIds[1], abc.sessionId);

    // Same article, same colour, same size — only the dispatch event tells them apart.
    assert.equal((await returner(f.db).lookup({ rawScan: qrIds[0] })).attribution?.partyName, "MAMA CHAPPAL");
    assert.equal((await returner(f.db).lookup({ rawScan: qrIds[1] })).attribution?.partyName, "ABC TRADERS");

    await returner(f.db).execute({ rawScan: qrIds[1], context: CONTEXT });

    assert.equal(f.db.getCurrentPartyBalance(abc.partyId), 0, "ABC TRADERS was credited");
    assert.equal(f.db.getCurrentPartyBalance(mama.partyId), 1080, "MAMA CHAPPAL's bill is untouched");
  } finally {
    f.cleanup();
  }
});

// ─── TEST E — a duplicate return scan ────────────────────────────────────────

test("TEST E — scanning an already-returned carton again creates no second return and no second credit", async () => {
  const f = createFixture();
  try {
    const { variantId, qrIds } = await stockInStore(f.db, f.raw, "SK6", "7/10", "RED", 1);
    const qr = qrIds[0];
    const bill = billFor(f.db, { partyName: "MAMA CHAPPAL", variantId, dozens: 0.5 });
    await moveOutAndDispatch(f.db, qr, bill.sessionId);

    assert.equal((await returner(f.db).execute({ rawScan: qr, context: CONTEXT })).accepted, true);
    const balanceAfterFirst = f.db.getCurrentPartyBalance(bill.partyId);

    const second = await returner(f.db).execute({ rawScan: qr, context: CONTEXT });

    assert.equal(second.accepted, false);
    assert.equal(second.outcome, "ALREADY_RETURNED");
    assert.match(second.reason ?? "", /Store Move In/i, "the operator is told it is awaiting physical receipt");
    assert.equal(second.existingReturn?.returnNumber, "SR-000001");
    assert.equal(second.existingReturn?.partyName, "MAMA CHAPPAL");

    assert.equal(countRows(f.raw, "SELECT COUNT(1) c FROM sale_returns WHERE qr_id = ?", qr), 1, "exactly one credit");
    assert.equal(returnEventCount(f.raw, qr), 1, "exactly one return event");
    assert.equal(f.db.getCurrentPartyBalance(bill.partyId), balanceAfterFirst, "the balance did not move");
    assert.equal(qrStatus(f.raw, qr), "ON_GATE", "and the carton is still waiting for the store");
  } finally {
    f.cleanup();
  }
});

test("the database itself refuses a second live credit for the same dispatch", () => {
  const f = createFixture();
  try {
    // The idempotency guarantee does not depend on the layers above being correct.
    const index = f.raw
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_sale_returns_dispatch_event_live'")
      .get() as { sql: string } | undefined;
    assert.ok(index, "the partial unique index must exist");
    assert.match(index!.sql, /UNIQUE/i);
    assert.match(index!.sql, /dispatch_event_id/);
    assert.match(index!.sql, /deleted_at IS NULL/);
  } finally {
    f.cleanup();
  }
});

// ─── TEST D — the physical receipt completes the return ──────────────────────

test("TEST D — Store Move In after a return adds stock back and creates no second credit", async () => {
  const f = createFixture();
  try {
    const { variantId, qrIds } = await stockInStore(f.db, f.raw, "SK6", "7/10", "RED", 1);
    const qr = qrIds[0];
    const bill = billFor(f.db, { partyName: "MAMA CHAPPAL", variantId, dozens: 0.5 });
    await moveOutAndDispatch(f.db, qr, bill.sessionId);
    await returner(f.db).execute({ rawScan: qr, context: CONTEXT });

    const creditsBefore = countRows(f.raw, "SELECT COUNT(1) c FROM sale_returns", );
    const balanceBefore = f.db.getCurrentPartyBalance(bill.partyId);

    const received = await receiver(f.db).execute({ rawScan: qr, context: CONTEXT, actor: "store-op" });

    assert.equal(received.outcome, "RECEIVED", received.reason);
    assert.equal(qrStatus(f.raw, qr), "WAREHOUSE");
    assert.deepEqual(stock(f.raw, variantId), { pool: 1, inStore: 1 });

    assert.equal(countRows(f.raw, "SELECT COUNT(1) c FROM sale_returns"), creditsBefore, "no second commercial return");
    assert.equal(f.db.getCurrentPartyBalance(bill.partyId), balanceBefore, "the ledger is untouched by a physical receipt");
  } finally {
    f.cleanup();
  }
});

test("a returned carton still on the gate is not counted as store stock by any reader", async () => {
  const f = createFixture();
  try {
    const { variantId, qrIds } = await stockInStore(f.db, f.raw, "SK6", "7/10", "RED", 3);
    const bill = billFor(f.db, { partyName: "MAMA CHAPPAL", variantId, dozens: 1.5 });
    await moveOutAndDispatch(f.db, qrIds[0], bill.sessionId);
    await returner(f.db).execute({ rawScan: qrIds[0], context: CONTEXT });

    // Two cartons remain In Store; the returned one is at the gate and counts nowhere.
    assert.deepEqual(stock(f.raw, variantId), { pool: 2, inStore: 2 });
    const storeRow = f.db.listStoreStock().find((r) => r.article === "SK6" && r.color === "RED" && r.size === "7/10");
    assert.equal(storeRow?.storeQuantity, 2, "the Store Stock screen sees two, not three");
  } finally {
    f.cleanup();
  }
});

test("a carton standing on the gate cannot be dispatched again before the store receives it", async () => {
  const f = createFixture();
  try {
    const { variantId, qrIds } = await stockInStore(f.db, f.raw, "SK6", "7/10", "RED", 1);
    const qr = qrIds[0];
    const mama = billFor(f.db, { partyName: "MAMA CHAPPAL", variantId, dozens: 0.5 });
    await moveOutAndDispatch(f.db, qr, mama.sessionId);
    await returner(f.db).execute({ rawScan: qr, context: CONTEXT });

    // Dispatching it now would send out a unit no projection holds.
    const abc = billFor(f.db, { partyName: "ABC TRADERS", variantId, dozens: 0.5 });
    const result = await dispatcher(f.db).execute({ rawScan: qr, sessionId: abc.sessionId, context: CONTEXT });

    assert.equal(result.accepted, false);
    assert.equal(result.reason, "ERROR: PRODUCT MUST BE RECEIVED INTO STORE FIRST");
    assert.equal(qrStatus(f.raw, qr), "ON_GATE");
    assert.deepEqual(stock(f.raw, variantId), { pool: 0, inStore: 0 });
  } finally {
    f.cleanup();
  }
});

// ─── TEST G — the same QR goes out again, to someone else ────────────────────

test("TEST G — after Store Move In the carton can be dispatched to a new party, and the old one stays history", async () => {
  const f = createFixture();
  try {
    const { variantId, qrIds } = await stockInStore(f.db, f.raw, "SK6", "7/10", "RED", 1);
    const qr = qrIds[0];

    // First cycle: out to MAMA CHAPPAL, returned, received back.
    const mama = billFor(f.db, { partyName: "MAMA CHAPPAL", variantId, dozens: 0.5 });
    await moveOutAndDispatch(f.db, qr, mama.sessionId);
    await returner(f.db).execute({ rawScan: qr, context: CONTEXT });
    assert.equal((await receiver(f.db).execute({ rawScan: qr, context: CONTEXT })).outcome, "RECEIVED");

    // Second cycle: out to ABC TRADERS.
    const abc = billFor(f.db, { partyName: "ABC TRADERS", variantId, dozens: 0.5 });
    await moveOutAndDispatch(f.db, qr, abc.sessionId);

    // The return screen must now say ABC TRADERS — the CURRENT dispatch, not the first one.
    const preview = await returner(f.db).lookup({ rawScan: qr });
    assert.equal(preview.attribution?.partyName, "ABC TRADERS");
    assert.equal(preview.attribution?.saleVoucherId, abc.voucherId);

    await returner(f.db).execute({ rawScan: qr, context: CONTEXT });

    // Both cycles are on the record, each credited to its own customer, once.
    const credits = f.raw
      .prepare("SELECT sr.return_number, p.party_name FROM sale_returns sr JOIN parties p ON p.id = sr.party_id WHERE sr.qr_id = ? ORDER BY sr.created_at ASC")
      .all(qr) as Array<{ return_number: string; party_name: string }>;
    assert.deepEqual(credits.map((c) => [c.return_number, c.party_name]), [
      ["SR-000001", "MAMA CHAPPAL"],
      ["SR-000002", "ABC TRADERS"],
    ]);
    assert.equal(f.db.getCurrentPartyBalance(mama.partyId), 0);
    assert.equal(f.db.getCurrentPartyBalance(abc.partyId), 0);
  } finally {
    f.cleanup();
  }
});

// ─── TEST H — only a dispatched carton can be returned ───────────────────────

test("TEST H — the Return screen refuses a carton that is not currently out with a customer", async () => {
  const f = createFixture();
  try {
    const { variantId, qrIds } = await stockInStore(f.db, f.raw, "SK6", "7/10", "RED", 2);

    // In Store.
    const inStore = await returner(f.db).lookup({ rawScan: qrIds[0] });
    assert.equal(inStore.accepted, false);
    assert.equal(inStore.outcome, "NOT_DISPATCHED");
    assert.match(inStore.reason ?? "", /In Store/i);

    // At the gate on its way OUT (Store Move Out, not yet dispatched).
    await mover(f.db).execute({ rawScan: qrIds[1], context: CONTEXT, actor: "store-op" });
    const toGate = await returner(f.db).lookup({ rawScan: qrIds[1] });
    assert.equal(toGate.outcome, "NOT_DISPATCHED");

    // In production stock, never received.
    const [produced] = generate(f.db, f.raw, "SK6", "7/10", "BLUE", 1);
    await producer(f.db).execute({ rawScan: produced, context: CONTEXT });
    assert.equal((await returner(f.db).lookup({ rawScan: produced })).outcome, "NOT_DISPATCHED");

    // Never produced at all.
    const [unknown] = generate(f.db, f.raw, "SK6", "7/10", "GREEN", 1);
    assert.equal((await returner(f.db).lookup({ rawScan: unknown })).outcome, "UNKNOWN_QR");

    // Not a QR.
    assert.equal((await returner(f.db).lookup({ rawScan: "hello" })).outcome, "INVALID_FORMAT");

    // Nothing above wrote a credit.
    assert.equal(countRows(f.raw, "SELECT COUNT(1) c FROM sale_returns"), 0);
    assert.equal(stock(f.raw, variantId).inStore, 1, "and the In Store carton is still In Store");
  } finally {
    f.cleanup();
  }
});

test("a carton dispatched with no bill selected cannot be returned, and nothing is written", async () => {
  const f = createFixture();
  try {
    const { variantId, qrIds } = await stockInStore(f.db, f.raw, "SK6", "7/10", "RED", 1);
    const qr = qrIds[0];

    // Dispatched with no session: the event carries no attribution, so there is no party.
    await mover(f.db).execute({ rawScan: qr, context: CONTEXT, actor: "store-op" });
    assert.equal((await dispatcher(f.db).execute({ rawScan: qr, context: CONTEXT })).accepted, true);

    const result = await returner(f.db).execute({ rawScan: qr, context: CONTEXT });

    assert.equal(result.accepted, false);
    assert.equal(result.outcome, "NO_ATTRIBUTION");
    assert.match(result.reason ?? "", /which customer/i);
    assert.equal(qrStatus(f.raw, qr), "DISPATCHED", "the carton is left exactly as it was");
    assert.equal(countRows(f.raw, "SELECT COUNT(1) c FROM sale_returns"), 0);
    assert.deepEqual(stock(f.raw, variantId), { pool: 0, inStore: 0 });
  } finally {
    f.cleanup();
  }
});

// ─── TEST F — the history is preserved ───────────────────────────────────────

test("TEST F — dispatch, return and store receipt all survive on the QR's record", async () => {
  const f = createFixture();
  try {
    const { variantId, qrIds } = await stockInStore(f.db, f.raw, "SK6", "7/10", "RED", 1);
    const qr = qrIds[0];
    const bill = billFor(f.db, { partyName: "MAMA CHAPPAL", variantId, dozens: 0.5 });
    await moveOutAndDispatch(f.db, qr, bill.sessionId);
    const confirmed = await returner(f.db).execute({ rawScan: qr, context: CONTEXT, actor: "gate-op" });
    await receiver(f.db).execute({ rawScan: qr, context: CONTEXT, actor: "store-op" });

    // The original dispatch attribution is still there, untouched by the return.
    const dispatchEvent = f.raw
      .prepare("SELECT dispatch_session_id FROM production_events WHERE qr_id = ? AND event_type = 'DISPATCHED'")
      .get(qr) as { dispatch_session_id: string };
    assert.equal(dispatchEvent.dispatch_session_id, bill.sessionId, "the dispatch still names its session");

    // The return event names the dispatch it answers and the credit it created, both ways.
    const returnEvent = f.raw
      .prepare("SELECT sale_return_id, previous_status, metadata_json FROM production_events WHERE qr_id = ? AND event_type = 'RETURNED'")
      .get(qr) as { sale_return_id: string; previous_status: string; metadata_json: string };
    assert.equal(returnEvent.sale_return_id, confirmed.saleReturnId);
    assert.equal(returnEvent.previous_status, "DISPATCHED");
    const meta = JSON.parse(returnEvent.metadata_json) as Record<string, unknown>;
    assert.equal(meta.eventType, "RETURN_RECORDED");
    assert.equal(meta.newStatus, "ON_GATE");
    assert.equal(meta.partyId, bill.partyId);
    assert.equal(meta.saleVoucherId, bill.voucherId);

    // And the QR Journey reads the whole path back in order.
    const journey = f.db.getQrJourney(qr)!;
    assert.deepEqual(
      journey.steps.map((s) => [s.kind, s.fromStatus, s.toStatus]),
      [
        ["REGISTERED", null, "REGISTERED"],
        ["PRODUCED", "REGISTERED", "PRODUCED"],
        ["STORE_ENTRY", "PRODUCED", "WAREHOUSE"],
        ["STORE_EXIT", "WAREHOUSE", "TO_GATE"],
        ["DISPATCHED", "TO_GATE", "DISPATCHED"],
        ["RETURNED", "DISPATCHED", "ON_GATE"],
        ["STORE_ENTRY", "ON_GATE", "WAREHOUSE"],
      ]
    );
    assert.equal(journey.currentStatus, "WAREHOUSE");
  } finally {
    f.cleanup();
  }
});

// ─── The party ledger ────────────────────────────────────────────────────────

test("the return appears on the customer's ledger as a credit, valued at the rate it was billed", async () => {
  const f = createFixture();
  try {
    const { variantId, qrIds } = await stockInStore(f.db, f.raw, "SK6", "7/10", "RED", 2);
    // One dozen at 180 a pair with 30 a pair off: 12 × 150 = 1800 for the bill.
    const bill = billFor(f.db, { partyName: "MAMA CHAPPAL", variantId, dozens: 1, pairRate: 180, pairDiscount: 30 });
    await moveOutAndDispatch(f.db, qrIds[0], bill.sessionId);
    await returner(f.db).execute({ rawScan: qrIds[0], context: CONTEXT });

    const ledger = f.db.getCustomerLedgerWithCash(bill.partyId, { fromDate: "2026-01-01", toDate: "2026-12-31" });

    const sale = ledger.entries.find((e) => e.voucherType === "SALE")!;
    const credit = ledger.entries.find((e) => e.voucherType === "SALE_RETURN")!;

    assert.equal(sale.debitAmount, 1800);
    // One carton is 6 pairs at the net rate of 150 → 900, exactly half the bill.
    assert.equal(credit.creditAmount, 900);
    assert.equal(credit.debitAmount, 0);
    assert.equal(credit.voucherNumber, "SR-000001");
    assert.match(credit.description, /Return SK6 7\/10 \(1 carton\)/);
    assert.equal(credit.balance, 900, "the running balance falls by the credit");
    assert.equal(ledger.closingBalance, 900);

    // Every reader of the balance must agree with the ledger screen.
    assert.equal(f.db.getCurrentPartyBalance(bill.partyId), 900);
    const balances = f.db.listCustomerBalances({ asOfDate: "2026-12-31" });
    const row = balances.rows.find((r) => r.partyId === bill.partyId)!;
    assert.equal(row.balance, 900);
    assert.equal(row.totalReturns, 900);
  } finally {
    f.cleanup();
  }
});

test("a return dated before the ledger window lands in the opening balance, not the entries", async () => {
  const f = createFixture();
  try {
    const { variantId, qrIds } = await stockInStore(f.db, f.raw, "SK6", "7/10", "RED", 1);
    const bill = billFor(f.db, { partyName: "MAMA CHAPPAL", variantId, dozens: 0.5 });
    await moveOutAndDispatch(f.db, qrIds[0], bill.sessionId);
    await returner(f.db).execute({ rawScan: qrIds[0], context: CONTEXT });

    const later = f.db.getCustomerLedgerWithCash(bill.partyId, { fromDate: "2026-10-01", toDate: "2026-12-31" });

    assert.equal(later.entries.length, 0, "nothing falls inside the window");
    assert.equal(later.openingBalance, 0, "the sale and its credit cancel out in the opening balance");
  } finally {
    f.cleanup();
  }
});

test("Return History lists the credit and says whether the store has received the carton yet", async () => {
  const f = createFixture();
  try {
    const { variantId, qrIds } = await stockInStore(f.db, f.raw, "SK6", "7/10", "RED", 2);
    const bill = billFor(f.db, { partyName: "MAMA CHAPPAL", variantId, dozens: 1 });
    await moveOutAndDispatch(f.db, qrIds[0], bill.sessionId);
    await moveOutAndDispatch(f.db, qrIds[1], bill.sessionId);
    await returner(f.db).execute({ rawScan: qrIds[0], context: CONTEXT, actor: "gate-op" });
    await returner(f.db).execute({ rawScan: qrIds[1], context: CONTEXT, actor: "gate-op" });

    // Only the first carton actually arrives at the store.
    await receiver(f.db).execute({ rawScan: qrIds[0], context: CONTEXT });

    const rows = f.db.listSaleReturns({ partyId: bill.partyId });
    assert.equal(rows.length, 2);

    const arrived = rows.find((r) => r.qrId === qrIds[0])!;
    const stillOut = rows.find((r) => r.qrId === qrIds[1])!;

    assert.equal(arrived.awaitingStoreIn, false);
    assert.equal(arrived.currentStatus, "WAREHOUSE");
    assert.equal(stillOut.awaitingStoreIn, true, "this one is still standing on the gate");
    assert.equal(stillOut.currentStatus, "ON_GATE");

    assert.equal(stillOut.partyName, "MAMA CHAPPAL");
    assert.equal(stillOut.saleVoucherNumber, bill.voucherNumber);
    assert.deepEqual([stillOut.article, stillOut.color, stillOut.size], ["SK6", "RED", "7/10"]);
    assert.equal(stillOut.recordedBy, "gate-op");
  } finally {
    f.cleanup();
  }
});

// ─── The upgrade path ────────────────────────────────────────────────────────

test("migration 035 upgrades a database that predates ON_GATE without losing a single carton", async () => {
  const f = createFixture();
  try {
    // Build real cartons in a spread of statuses, then wind the database back to how it
    // looked before this feature: qr_master with the old CHECK, no sale_returns, and
    // migration 035 unapplied. Reopening it is exactly what a live installation does on the
    // first launch after the update.
    const { qrIds } = await stockInStore(f.db, f.raw, "SK6", "7/10", "RED", 3);
    await mover(f.db).execute({ rawScan: qrIds[1], context: CONTEXT, actor: "store-op" });
    const before = f.raw.prepare("SELECT qr_id, current_status, current_location_type FROM qr_master ORDER BY qr_id").all() as Array<Record<string, unknown>>;
    assert.equal(before.length, 3);

    // production_events references qr_master, so the rewind needs foreign keys off — the
    // same thing the migration runner does around a table rebuild.
    f.raw.exec("PRAGMA foreign_keys = OFF;");
    f.raw.exec(`
      DROP INDEX IF EXISTS idx_sale_returns_dispatch_event_live;
      DROP TABLE IF EXISTS sale_returns;
      CREATE TABLE qr_master_old (
        qr_id TEXT PRIMARY KEY,
        product_variant_id TEXT NOT NULL,
        current_status TEXT NOT NULL,
        current_location_type TEXT NOT NULL DEFAULT 'UNKNOWN',
        current_location_id TEXT,
        first_event_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        deleted_by TEXT,
        delete_reason TEXT,
        CHECK (current_status IN ('PRODUCED','WAREHOUSE','TO_GATE','DISPATCHED','SOLD','RETURNED','DAMAGED','SCRAPPED'))
      );
      INSERT INTO qr_master_old SELECT qr_id, product_variant_id, current_status, current_location_type, current_location_id, first_event_id, created_at, updated_at, deleted_at, deleted_by, delete_reason FROM qr_master;
      DROP TABLE qr_master;
      ALTER TABLE qr_master_old RENAME TO qr_master;
      DELETE FROM schema_migrations WHERE version = '035_sale_returns_on_gate';
    `);
    f.db.close();

    // The upgrade.
    const upgraded = new SqliteDatabase({ dbPath: f.dbPath, schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
    const raw = (upgraded as unknown as { db: Raw }).db;

    try {
      // Every carton survived the table rebuild, in the status and place it was in.
      const after = raw.prepare("SELECT qr_id, current_status, current_location_type FROM qr_master ORDER BY qr_id").all() as Array<Record<string, unknown>>;
      assert.deepEqual(after, before, "no carton changed status or location during the upgrade");

      // And the new state is now accepted, which the old CHECK would have refused.
      raw.prepare("UPDATE qr_master SET current_status = 'ON_GATE' WHERE qr_id = ?").run(String(before[0].qr_id));
      assert.equal(qrStatus(raw, String(before[0].qr_id)), "ON_GATE");

      // The credit table and its idempotency index arrived with it.
      assert.ok(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sale_returns'").get());
      assert.ok(raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sale_returns_dispatch_event_live'").get());
      assert.ok(raw.prepare("SELECT 1 c FROM pragma_table_info('production_events') WHERE name = 'sale_return_id'").get());
    } finally {
      upgraded.close();
    }
  } finally {
    try { f.cleanup(); } catch { /* the fixture db is already closed above */ }
  }
});

// ─── Cancelling the bill a return credits ────────────────────────────────────

test("cancelling a bill cancels the carton credits it created, so no credit outlives its sale", async () => {
  const f = createFixture();
  try {
    const { variantId, qrIds } = await stockInStore(f.db, f.raw, "SK6", "7/10", "RED", 1);
    const qr = qrIds[0];
    const bill = billFor(f.db, { partyName: "MAMA CHAPPAL", variantId, dozens: 0.5 });
    await moveOutAndDispatch(f.db, qr, bill.sessionId);
    await returner(f.db).execute({ rawScan: qr, context: CONTEXT });

    assert.equal(f.db.getCurrentPartyBalance(bill.partyId), 0, "bill 1080 debited, carton 1080 credited");

    const result = f.db.deleteSaleVoucher(bill.voucherId);

    assert.equal(result.cancelled, true);
    assert.equal(result.cancelledReturnCount, 1);
    // Both sides went together: the customer is not left in pocket for a sale that no
    // longer exists, and is not billed for one either.
    assert.equal(f.db.getCurrentPartyBalance(bill.partyId), 0);
    const ledger = f.db.getCustomerLedgerWithCash(bill.partyId, { fromDate: "2026-01-01", toDate: "2026-12-31" });
    assert.equal(ledger.entries.length, 0, "neither the sale nor its credit remains on the ledger");

    // The row is kept for audit, and the carton is untouched — it is still physically at the
    // gate and Store Move In is still the right way to receive it.
    const row = f.raw.prepare("SELECT status, deleted_at FROM sale_returns WHERE qr_id = ?").get(qr) as { status: string; deleted_at: string | null };
    assert.equal(row.status, "CANCELLED");
    assert.ok(row.deleted_at);
    assert.equal(qrStatus(f.raw, qr), "ON_GATE");

    assert.equal((await receiver(f.db).execute({ rawScan: qr, context: CONTEXT })).outcome, "RECEIVED");
    assert.deepEqual(stock(f.raw, variantId), { pool: 1, inStore: 1 }, "the carton still comes back into stock");
  } finally {
    f.cleanup();
  }
});

// ─── Atomicity ───────────────────────────────────────────────────────────────

test("a return that fails part-way leaves no credit, no event and no status change", async () => {
  const f = createFixture();
  try {
    const { variantId, qrIds } = await stockInStore(f.db, f.raw, "SK6", "7/10", "RED", 1);
    const qr = qrIds[0];
    const bill = billFor(f.db, { partyName: "MAMA CHAPPAL", variantId, dozens: 0.5 });
    await moveOutAndDispatch(f.db, qr, bill.sessionId);

    // The event write fails after the status move and the credit have both been made.
    const useCase = new ReturnScanUseCase({
      txManager: f.db,
      qrLookupRepo: f.db,
      attributionRepo: f.db,
      qrMasterRepo: f.db,
      saleReturnsRepo: f.db,
      returnEventsRepo: {
        async appendReturnRecordedEvent() {
          throw new Error("disk full");
        },
      },
      outboxRepo: f.db,
      eventPublisher: bus(),
      idGenerator: ids(),
    });

    await assert.rejects(() => useCase.execute({ rawScan: qr, context: CONTEXT }), /disk full/);

    // The real transaction rolled every part of it back together.
    assert.equal(qrStatus(f.raw, qr), "DISPATCHED", "the status move was undone");
    assert.equal(countRows(f.raw, "SELECT COUNT(1) c FROM sale_returns"), 0, "the credit was undone");
    assert.equal(returnEventCount(f.raw, qr), 0);
    assert.equal(f.db.getCurrentPartyBalance(bill.partyId), 1080, "the customer still owes the whole bill");

    // And the carton can still be returned properly afterwards.
    assert.equal((await returner(f.db).execute({ rawScan: qr, context: CONTEXT })).accepted, true);
    assert.equal(f.db.getCurrentPartyBalance(bill.partyId), 0);
  } finally {
    f.cleanup();
  }
});
