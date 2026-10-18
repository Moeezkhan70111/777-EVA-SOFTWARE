import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CreateGatepassUseCase, InMemoryEventBus, ProcessScanUseCase, StoreEntryScanUseCase } from "@erp/application";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { UuidGenerator } from "./idGenerator.js";

// A bill made from a gatepass must keep saying what the gatepass says.
//
// The gatepass is the document the goods physically left on, so WHAT went out — articles,
// sizes, quantities — is its to state. WHAT IT IS WORTH — rate, price type, "less" — is not
// on the gatepass at all and stays the billing desk's.
//
// These tests drive the real database through the real use cases, because the rule is only
// worth anything if it holds on the write path the app actually uses.

const FACTORY = "factory-777";
const CONTEXT = { factoryId: FACTORY, workstationId: "ws-prod-01", deviceId: "desktop-main" };

type Raw = import("node:sqlite").DatabaseSync;

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-bill-gatepass-"));
  const db = new SqliteDatabase({
    dbPath: path.join(tempDir, "bill.db"),
    schemaPath: path.resolve(process.cwd(), "src/local-schema.sql"),
  });
  db.setNumberBlock(1, "test");
  db.ensureOperationalContext({
    factoryId: FACTORY,
    factoryCode: "777",
    factoryName: "777 Manufacturing",
    workstationId: "ws-prod-01",
    workstationCode: "PROD-01",
    workstationName: "Production Line 01",
    deviceId: "desktop-main",
    deviceName: "Desktop Main",
    appVersion: "1.0.0",
  });
  return {
    db,
    raw: (db as unknown as { db: Raw }).db,
    cleanup: () => {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

const producer = (db: SqliteDatabase) =>
  new ProcessScanUseCase({
    txManager: db, duplicateChecker: db, qrRegistry: db, productCatalog: db, qrMasterRepo: db,
    productionEventsRepo: db, stockProjectionRepo: db, outboxRepo: db,
    eventPublisher: new InMemoryEventBus(), idGenerator: new UuidGenerator(),
  });

const receiver = (db: SqliteDatabase) =>
  new StoreEntryScanUseCase({
    txManager: db, qrLookupRepo: db, gatepassRepo: db, qrRegistry: db, qrMasterRepo: db,
    storeEntryEventsRepo: db, stockProjectionRepo: db, outboxRepo: db,
    eventPublisher: new InMemoryEventBus(), idGenerator: new UuidGenerator(),
  });

const gatepassCreator = (db: SqliteDatabase) =>
  new CreateGatepassUseCase({ txManager: db, repo: db, idGenerator: new UuidGenerator(), localDate: () => "2026-09-29" });

function createParty(db: SqliteDatabase, name: string): string {
  return db.createParty({ partyName: name, partyType: "CUSTOMER", city: "Lahore", status: "ACTIVE" });
}

/** Builds In Store stock through the real scanners and returns the variant id. */
async function stockVariant(db: SqliteDatabase, raw: Raw, article: string, size: string, color: string, cartons: number): Promise<string> {
  let row = raw.prepare("SELECT id FROM article_sizes WHERE article = ? AND size = ? AND deleted_at IS NULL LIMIT 1").get(article, size) as { id: string } | undefined;
  if (!row) {
    db.createProduct({ article, size, sellingPrice: 550, status: "ACTIVE" });
    row = raw.prepare("SELECT id FROM article_sizes WHERE article = ? AND size = ? AND deleted_at IS NULL LIMIT 1").get(article, size) as { id: string };
  }
  const ids = db.generateQrBatch({ articleSizeId: row.id, color, quantity: cartons, createdBy: "admin" }).qrCodes.map((b) => b.id);
  const produce = producer(db);
  const receive = receiver(db);
  for (const id of ids) {
    await produce.execute({ rawScan: id, context: CONTEXT });
    await receive.execute({ rawScan: id, context: CONTEXT });
  }
  const variant = raw.prepare("SELECT id FROM product_variants WHERE article = ? AND color = ? AND size = ?").get(article, color, size) as { id: string };
  return variant.id;
}

const mismatchOf = (error: unknown) => (error as { mismatch?: string }).mismatch;
const liveLines = (db: SqliteDatabase, voucherId: string) => db.getSaleVoucher(voucherId)?.lineItems ?? [];

/** A party, 6 cartons (= 3 dozen) of SK6 7/10 RED on a gatepass, and a bill made from it. */
async function billedGatepass(f: ReturnType<typeof createFixture>) {
  const partyId = createParty(f.db, "ABC TRADERS");
  const variantId = await stockVariant(f.db, f.raw, "SK6", "7/10", "RED", 6);
  const gatepass = await gatepassCreator(f.db).execute({ partyId, lines: [{ productVariantId: variantId, quantity: 6 }], actor: "clerk" });
  const bill = f.db.createSaleVoucher({ partyId, voucherDate: "2026-09-29", bookNo: "B1", gatepassId: gatepass.gatepassId });
  return { partyId, variantId, gatepassId: gatepass.gatepassId!, bill };
}

test("the gatepass says what the bill must carry: cartons per colour folded into dozens per article + size", async () => {
  const f = createFixture();
  try {
    const partyId = createParty(f.db, "ABC TRADERS");
    const red = await stockVariant(f.db, f.raw, "SK6", "7/10", "RED", 4);
    const black = await stockVariant(f.db, f.raw, "SK6", "7/10", "BLACK", 2);
    const other = await stockVariant(f.db, f.raw, "SK9", "4/6", "RED", 3);

    const gatepass = await gatepassCreator(f.db).execute({
      partyId,
      lines: [
        { productVariantId: red, quantity: 4 },
        { productVariantId: black, quantity: 2 },
        { productVariantId: other, quantity: 3 },
      ],
      actor: "clerk",
    });

    const expected = f.db.gatepassBillQuantities(gatepass.gatepassId!);
    assert.equal(expected.size, 2, "colour never reaches a bill — SK6 7/10 is one line");
    assert.equal(expected.get("SK6|||7/10")!.dozens, 3, "4 + 2 cartons = 6 cartons = 3 dozen");
    assert.equal(expected.get("SK9|||4/6")!.dozens, 1.5, "an odd carton count stays exact");
  } finally {
    f.cleanup();
  }
});

test("a line at the gatepass's quantity is accepted", async () => {
  const f = createFixture();
  try {
    const { variantId, bill } = await billedGatepass(f);

    const added = f.db.addVoucherLineItem(bill.id, { productVariantId: variantId, quantity: 3, unitPrice: 550, discount: 0 });
    assert.ok(added.id);
    assert.equal(liveLines(f.db, bill.id).length, 1);
    assert.equal(liveLines(f.db, bill.id)[0].quantity, 3);
  } finally {
    f.cleanup();
  }
});

test("a different quantity is refused, and says what the gatepass sent", async () => {
  const f = createFixture();
  try {
    const { variantId, bill } = await billedGatepass(f);

    assert.throws(
      () => f.db.addVoucherLineItem(bill.id, { productVariantId: variantId, quantity: 5, unitPrice: 550, discount: 0 }),
      (error: unknown) => {
        assert.equal(mismatchOf(error), "QUANTITY_DIFFERS");
        assert.equal((error as { expectedDozens?: number }).expectedDozens, 3);
        assert.equal((error as { billedDozens?: number }).billedDozens, 5);
        assert.match((error as Error).message, /GP-000001 sent 3 dozen of SK6 7\/10/);
        assert.match((error as Error).message, /cancel GP-000001 and make the right gatepass/);
        return true;
      }
    );
    assert.equal(liveLines(f.db, bill.id).length, 0, "nothing is written when the line is refused");
  } finally {
    f.cleanup();
  }
});

test("a saved line cannot have its quantity edited afterwards", async () => {
  const f = createFixture();
  try {
    const { variantId, bill } = await billedGatepass(f);
    const line = f.db.addVoucherLineItem(bill.id, { productVariantId: variantId, quantity: 3, unitPrice: 550, discount: 0 });

    assert.throws(
      () => f.db.updateVoucherLineItem(line.id, { quantity: 2, unitPrice: 550, discount: 0 }),
      (error: unknown) => mismatchOf(error) === "QUANTITY_DIFFERS"
    );
    assert.equal(liveLines(f.db, bill.id)[0].quantity, 3, "the saved quantity is untouched");
  } finally {
    f.cleanup();
  }
});

test("the rate, the price type and the less are still the desk's to set", async () => {
  const f = createFixture();
  try {
    const { variantId, bill } = await billedGatepass(f);
    const line = f.db.addVoucherLineItem(bill.id, { productVariantId: variantId, quantity: 3, unitPrice: 550, discount: 0 });

    f.db.updateVoucherLineItem(line.id, { quantity: 3, unitPrice: 600, discount: 0 });
    assert.equal(liveLines(f.db, bill.id)[0].unitPrice, 600);

    f.db.updateVoucherLineItem(line.id, { quantity: 3, unitPrice: 600, discount: 0, priceType: "B_TYPE" });
    assert.equal(liveLines(f.db, bill.id)[0].priceType, "B_TYPE");
    assert.equal(liveLines(f.db, bill.id)[0].quantity, 3, "changing the price never changes what went out");
  } finally {
    f.cleanup();
  }
});

test("an article the gatepass never sent cannot be billed on it", async () => {
  const f = createFixture();
  try {
    const { bill } = await billedGatepass(f);
    const stranger = await stockVariant(f.db, f.raw, "SK99", "11/13", "BLACK", 2);

    assert.throws(
      () => f.db.addVoucherLineItem(bill.id, { productVariantId: stranger, quantity: 1, unitPrice: 550, discount: 0 }),
      (error: unknown) => {
        assert.equal(mismatchOf(error), "LINE_NOT_ON_GATEPASS");
        assert.match((error as Error).message, /GP-000001 does not carry SK99 11\/13/);
        return true;
      }
    );
    assert.equal(liveLines(f.db, bill.id).length, 0);
  } finally {
    f.cleanup();
  }
});

test("the same article + size cannot be billed twice — the gatepass carries it once", async () => {
  const f = createFixture();
  try {
    const { variantId, bill } = await billedGatepass(f);
    f.db.addVoucherLineItem(bill.id, { productVariantId: variantId, quantity: 3, unitPrice: 550, discount: 0 });

    assert.throws(
      () => f.db.addVoucherLineItem(bill.id, { productVariantId: variantId, quantity: 3, unitPrice: 550, discount: 0 }),
      (error: unknown) => mismatchOf(error) === "LINE_ALREADY_ON_BILL"
    );
    assert.equal(liveLines(f.db, bill.id).length, 1);
  } finally {
    f.cleanup();
  }
});

test("another colour of the same article + size is the same bill line, not a second one", async () => {
  const f = createFixture();
  try {
    const partyId = createParty(f.db, "ABC TRADERS");
    const red = await stockVariant(f.db, f.raw, "SK6", "7/10", "RED", 4);
    const black = await stockVariant(f.db, f.raw, "SK6", "7/10", "BLACK", 2);
    const gatepass = await gatepassCreator(f.db).execute({
      partyId,
      lines: [{ productVariantId: red, quantity: 4 }, { productVariantId: black, quantity: 2 }],
      actor: "clerk",
    });
    const bill = f.db.createSaleVoucher({ partyId, voucherDate: "2026-09-29", bookNo: "B1", gatepassId: gatepass.gatepassId });

    // One line, at the two colours' combined dozens.
    f.db.addVoucherLineItem(bill.id, { productVariantId: red, quantity: 3, unitPrice: 550, discount: 0 });
    assert.equal(liveLines(f.db, bill.id).length, 1);

    // The other colour is the same article + size, so it is the same line.
    assert.throws(
      () => f.db.addVoucherLineItem(bill.id, { productVariantId: black, quantity: 3, unitPrice: 550, discount: 0 }),
      (error: unknown) => mismatchOf(error) === "LINE_ALREADY_ON_BILL"
    );
  } finally {
    f.cleanup();
  }
});

test("a gatepass line cannot be taken off the bill", async () => {
  const f = createFixture();
  try {
    const { variantId, bill } = await billedGatepass(f);
    const line = f.db.addVoucherLineItem(bill.id, { productVariantId: variantId, quantity: 3, unitPrice: 550, discount: 0 });

    assert.throws(
      () => f.db.deleteVoucherLineItem(line.id),
      (error: unknown) => {
        assert.equal(mismatchOf(error), "LINE_MAY_NOT_BE_REMOVED");
        assert.match((error as Error).message, /Delete the whole bill/);
        return true;
      }
    );
    assert.equal(liveLines(f.db, bill.id).length, 1, "the line is still on the bill");
  } finally {
    f.cleanup();
  }
});

test("a bill not made from a gatepass is unaffected — there is nothing for it to disagree with", async () => {
  const f = createFixture();
  try {
    const partyId = createParty(f.db, "ABC TRADERS");
    const variantId = await stockVariant(f.db, f.raw, "SK6", "7/10", "RED", 6);
    const bill = f.db.createSaleVoucher({ partyId, voucherDate: "2026-09-29", bookNo: "B1" });

    const line = f.db.addVoucherLineItem(bill.id, { productVariantId: variantId, quantity: 7, unitPrice: 550, discount: 0 });
    f.db.updateVoucherLineItem(line.id, { quantity: 9, unitPrice: 550, discount: 0 });
    assert.equal(liveLines(f.db, bill.id)[0].quantity, 9);

    f.db.deleteVoucherLineItem(line.id);
    assert.equal(liveLines(f.db, bill.id).length, 0);
  } finally {
    f.cleanup();
  }
});
