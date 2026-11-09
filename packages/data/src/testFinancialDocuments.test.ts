import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { activateCartonCloudForTest } from "./testing/cartonCloud.js";

// TEST BILLS AND CASH VOUCHERS AFTER GO-LIVE (stockProtection.ts, "Test financial documents"): a bill, cash voucher or
// sale return made before Carton Cloud was activated is test data. After activation it counts in no customer balance
// -- ledger, balance list, the credit-limit balance -- and cannot be changed. Nothing is deleted: the rows stay,
// the document lists show them, and their history is untouched. Before activation nothing changes at all.

function withDatabase(work: (db: SqliteDatabase) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-test-money-"));
  const db = new SqliteDatabase({ dbPath: path.join(dir, "erp.db"), schemaPath: path.resolve(import.meta.dirname, "../src/local-schema.sql") });
  try {
    db.setNumberBlock(1, "test");
    db.ensureOperationalContext({
      factoryId: "factory-777", factoryCode: "F777", factoryName: "777", workstationId: "ws-1", workstationCode: "WS1",
      workstationName: "1", deviceId: "dev-1", deviceName: "1", appVersion: "1.0.0",
    });
    work(db);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const RANGE = { fromDate: "2026-01-01", toDate: "2026-12-31" };

function customerWithBill(db: SqliteDatabase): { partyId: string; billId: string } {
  const partyId = db.createParty({ partyName: "MAMA CHAPPAL", partyType: "CUSTOMER", city: "Lahore", mobileNumber: "0300-3333333", status: "ACTIVE" });
  db.createProduct({ article: "SK6", size: "7/10", sellingPrice: 550, machineRate: 70, packingRate: 30, colors: ["RED"], status: "ACTIVE" });
  const variantId = (db.db.prepare("SELECT id FROM product_variants WHERE article = 'SK6'").get() as { id: string }).id;
  const bill = db.createSaleVoucher({ partyId, voucherDate: "2026-09-22", bookNo: "B1" });
  db.addVoucherLineItem(bill.id, { productVariantId: variantId, quantity: 1, unitPrice: 100, discount: 0 });
  return { partyId, billId: bill.id };
}

const balanceListed = (db: SqliteDatabase, partyId: string) =>
  db.listCustomerBalances({ asOfDate: "2026-12-31" }).rows.find((row) => row.partyId === partyId)?.balance ?? null;

test("before activation, test bills and cash vouchers count exactly as they always did", () => {
  withDatabase((db) => {
    const { partyId } = customerWithBill(db);
    db.createCashVoucher({ requestId: crypto.randomUUID(), partyId, voucherDate: "2026-10-01", description: "test receipt", receiptAmount: 500 });
    assert.equal(db.getCurrentPartyBalance(partyId), 1200 - 500);
    assert.equal(balanceListed(db, partyId), 700);
    assert.equal(db.getCustomerLedgerWithCash(partyId, RANGE).entries.length, 2);
  });
});

test("after activation, documents made before it count in no balance; documents made after it count as normal", () => {
  withDatabase((db) => {
    const { partyId, billId } = customerWithBill(db);
    const testReceipt = db.createCashVoucher({ requestId: crypto.randomUUID(), partyId, voucherDate: "2026-10-01", description: "test receipt", receiptAmount: 500 }).id;
    activateCartonCloudForTest(db.db, "p");

    assert.equal(db.getCurrentPartyBalance(partyId), 0, "the credit-limit balance leaves test documents out");
    assert.equal(balanceListed(db, partyId), 0, "so does the customer balance list");
    assert.deepEqual(db.getCustomerLedgerWithCash(partyId, RANGE).entries, [], "and the ledger");
    assert.deepEqual(db.getCustomerLedger(partyId, RANGE).entries, []);

    const real = db.createCashVoucher({ requestId: crypto.randomUUID(), partyId, voucherDate: "2026-11-10", description: "real receipt", receiptAmount: 300 }).id;
    assert.equal(db.getCurrentPartyBalance(partyId), -300);
    assert.equal(balanceListed(db, partyId), -300);
    assert.deepEqual(db.getCustomerLedgerWithCash(partyId, RANGE).entries.map((entry) => entry.voucherId), [real]);

    // Kept for the record: the documents are still there and still listed.
    assert.ok(db.getSaleVoucher(billId));
    assert.ok(db.getCashVoucher(testReceipt));
    assert.ok(db.listCashVouchers({}).rows.some((row) => row.id === testReceipt), "the cash voucher list still shows it");
  });
});

test("after activation, a test bill or cash voucher cannot be changed, entered or deleted; a new one can", () => {
  withDatabase((db) => {
    const { partyId, billId } = customerWithBill(db);
    const testReceipt = db.createCashVoucher({ requestId: crypto.randomUUID(), partyId, voucherDate: "2026-10-01", description: "test receipt", receiptAmount: 500 }).id;
    activateCartonCloudForTest(db.db, "p");
    const refused = /made before Carton Cloud went live on this computer/;
    assert.throws(() => db.updateSaleVoucher(billId, { remarks: "edited after go-live" }), refused);
    assert.throws(() => db.deleteSaleVoucher(billId, "after go-live"), refused);
    assert.throws(() => db.updateCashVoucher(testReceipt, { description: "edited" }), refused);
    assert.throws(() => db.deleteCashVoucher(testReceipt), refused);
    const stored = db.db.prepare("SELECT deleted_at, remarks FROM sale_vouchers WHERE id = ?").get(billId) as { deleted_at: string | null; remarks: string | null };
    assert.equal(stored.deleted_at, null, "nothing was changed");
    assert.notEqual(stored.remarks, "edited after go-live");

    const real = db.createCashVoucher({ requestId: crypto.randomUUID(), partyId, voucherDate: "2026-11-10", description: "real", receiptAmount: 300 }).id;
    db.updateCashVoucher(real, { description: "real, corrected" });
    assert.equal(db.getCashVoucher(real)?.description, "real, corrected");
  });
});

test("contractor pay leaves out Manual Production and payments made before activation", () => {
  withDatabase((db) => {
    const contractor = db.createParty({ partyName: "ASLAM", partyType: "CONTRACTOR", city: "Lahore", mobileNumber: "0300-1111111", status: "ACTIVE" });
    db.createCashVoucher({ requestId: crypto.randomUUID(), partyId: contractor, voucherDate: "2026-10-01", description: "test advance", paymentAmount: 400 });
    const before = db.getContractorLedger(contractor, RANGE);
    activateCartonCloudForTest(db.db, "p");
    const after = db.getContractorLedger(contractor, RANGE);
    assert.notDeepEqual(after, before, "the test payment no longer counts");
    assert.equal(JSON.stringify(after).includes("test advance"), false);
  });
});

test("a document the cloud sent before this computer was activated is real: it counts, and may be changed", () => {
  withDatabase((db) => {
    const { partyId } = customerWithBill(db);
    // As the receiver leaves a cash voucher another computer made after IT went live (leasedRecordContracts.ts).
    const received = db.createCashVoucher({ requestId: crypto.randomUUID(), partyId, voucherDate: "2026-11-10", description: "from the cloud", receiptAmount: 250 }).id;
    db.db.prepare("INSERT INTO sync_record_revisions (aggregate_type, record_id, revision) VALUES ('CASH_VOUCHER', ?, 1)").run(received);
    activateCartonCloudForTest(db.db, "p");
    assert.equal(db.getCurrentPartyBalance(partyId), -250, "the received voucher counts; the local test bill does not");
    assert.deepEqual(db.getCustomerLedgerWithCash(partyId, RANGE).entries.map((entry) => entry.voucherId), [received]);
    db.updateCashVoucher(received, { description: "from the cloud, corrected" });
    assert.equal(db.getCashVoucher(received)?.description, "from the cloud, corrected");
  });
});
