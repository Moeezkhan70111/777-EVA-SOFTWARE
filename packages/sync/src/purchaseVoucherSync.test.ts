import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase, buildLeasedRecordRevisions } from "@erp/data";
import { applyEnvelope } from "./applyEnvelope.js";
import type { SyncEnvelope } from "./contract.js";

// PURCHASE BILLS ACROSS COMPUTERS (docs/54), end to end: the accounts computer writes, edits and deletes a supplier's
// bill the ordinary way; its capture marks the bill; the real builder queues it; another computer applies it with the
// real applier. Both must show the same supplier balance at every step, a revision delivered twice must change nothing,
// the reader must never mark what it received as its own, and no stock, cash or claim may move on either computer.

const SCHEMA = path.resolve(import.meta.dirname, "../../data/src/local-schema.sql");
const NOW = "2026-11-20T10:00:00.000Z";

interface Pc {
  readonly db: SqliteDatabase;
  readonly close: () => void;
}

function openPc(name: string): Pc {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `erp-purchase-${name}-`));
  const db = new SqliteDatabase({ dbPath: path.join(dir, "erp.db"), schemaPath: SCHEMA });
  return { db, close: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

/** The accounts computer holds ACCOUNTS. It also holds PARTIES and the store's lease here, so the supplier and the
 * material a bill names travel too (in the factory they come from their own holders). */
function openAccounts(): Pc {
  const pc = openPc("accounts");
  const lease = pc.db.db.prepare(
    `INSERT INTO sync_domain_leases (domain, holder_device_id, holder_label, epoch, barrier_seq, granted_at, project_key, fetched_at)
     VALUES (?, 'dev-accounts', 'Accounts PC', 1, 0, ?, 'https://test.supabase.co', ?)`
  );
  for (const domain of ["ACCOUNTS", "PARTIES", "RAW_MATERIAL_STORE"]) lease.run(domain, NOW, NOW);
  pc.db.setNumberBlock(1, "test");
  return pc;
}

function sent(from: Pc): SyncEnvelope[] {
  buildLeasedRecordRevisions(from.db.db, NOW);
  const rows = from.db.db.prepare("SELECT aggregate_type, aggregate_id, dedupe_key, payload_json FROM sync_outbox WHERE status = 'PENDING' ORDER BY rowid").all() as Array<Record<string, unknown>>;
  from.db.db.prepare("UPDATE sync_outbox SET status = 'SYNCED' WHERE status = 'PENDING'").run();
  return rows.map((row) => ({
    dedupeKey: String(row.dedupe_key),
    aggregateType: String(row.aggregate_type),
    aggregateId: String(row.aggregate_id),
    operation: "INSERT" as const,
    payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    originDeviceId: "dev-accounts",
    createdAt: NOW,
  }));
}

const deliver = (reader: Pc, envelopes: readonly SyncEnvelope[]) => {
  for (const envelope of envelopes) applyEnvelope(reader.db.db, envelope, NOW);
};

const count = (pc: Pc, sql: string): number => Number((pc.db.db.prepare(sql).get() as { n: number }).n);

/** What both computers must agree on about the supplier. */
const supplierView = (pc: Pc, supplier: string) => ({
  listed: pc.db.listSupplierBalances({ asOfDate: "2026-12-31" }).rows.find((row) => row.partyId === supplier)?.balance ?? null,
  ledgerClosing: pc.db.getSupplierLedger(supplier).closingBalance,
  entries: pc.db.getSupplierLedger(supplier).entries.map((entry) => [entry.voucherType, entry.voucherNumber, entry.creditAmount, entry.debitAmount]),
});

/** Nothing a bill must ever move: stock, cash, claims, carton figures. */
const untouched = (pc: Pc) =>
  ["inventory_stock_events", "inventory_stock_balances", "carton_stock_events", "cash_vouchers", "party_claims"].map((table) => count(pc, `SELECT COUNT(*) AS n FROM ${table}`));

function material(pc: Pc): string {
  pc.db.createInventoryUnit({ code: "KG", name: "Kilogram" });
  const unitId = (pc.db.listInventoryUnits() as Array<{ id: string }>)[0]!.id;
  const categoryId = pc.db.createInventoryCategory({ name: "DANA" });
  pc.db.addInventoryCategoryField({ categoryId, fieldKey: "article", label: "ARTICLE", fieldType: "TEXT", required: true });
  return pc.db.createInventoryItem({ categoryId, unitId, values: { article: "DANA EVA" } }).id;
}

test("a purchase bill arrives whole, and both computers show the same supplier balance after every change", () => {
  const accounts = openAccounts();
  const reader = openPc("reader");
  try {
    const supplier = accounts.db.createParty({ partyName: "SYNTHETIC SUPPLIER DELTA", partyType: "SUPPLIER", status: "ACTIVE" });
    const item = material(accounts);
    accounts.db.postPartyOpeningBalance({
      requestId: crypto.randomUUID(), partyId: supplier, direction: "CREDIT", amountPaisa: 10_000_000, effectiveDate: "2026-11-01", sourceReference: "Old ledger 1201901", actor: "admin",
    });
    const before = { accounts: untouched(accounts), reader: untouched(reader) };
    const bill = accounts.db.createPurchaseVoucher({ partyId: supplier, voucherDate: "2026-11-20", referenceNo: "bill 77", lines: [{ itemId: item, quantity: 200, unitPrice: 450 }] });

    const first = sent(accounts);
    const types = first.map((envelope) => envelope.aggregateType);
    assert.ok(types.indexOf("PARTY") < types.indexOf("PURCHASE_VOUCHER") && types.indexOf("INVENTORY_ITEM") < types.indexOf("PURCHASE_VOUCHER"), `the bill after what it names: ${types.join(", ")}`);
    assert.equal(types.filter((type) => type === "PURCHASE_VOUCHER").length, 1, "one bill, one revision, its lines inside it");
    deliver(reader, first);
    assert.deepEqual(supplierView(reader, supplier), supplierView(accounts, supplier));
    assert.equal(supplierView(reader, supplier).listed, 190_000, "100,000 opening payable + 90,000 bill");

    // Edited: one new revision, and only the current line is on the bill anywhere.
    accounts.db.updatePurchaseVoucher(bill.id, { lines: [{ itemId: item, quantity: 100, unitPrice: 450 }] });
    const edit = sent(accounts);
    assert.deepEqual(edit.map((envelope) => envelope.aggregateType), ["PURCHASE_VOUCHER"]);
    deliver(reader, edit);
    assert.deepEqual(supplierView(reader, supplier), supplierView(accounts, supplier));
    assert.equal(supplierView(reader, supplier).listed, 145_000);
    for (const pc of [accounts, reader]) {
      assert.equal(count(pc, `SELECT COUNT(*) AS n FROM purchase_voucher_line_items WHERE voucher_id = '${bill.id}' AND deleted_at IS NULL`), 1, "one current line");
      assert.equal(count(pc, `SELECT COUNT(*) AS n FROM purchase_voucher_line_items WHERE voucher_id = '${bill.id}' AND deleted_at IS NOT NULL`), 1, "the replaced line kept as history");
    }

    // Delivered twice: nothing changes, and the reader never queues what it received.
    deliver(reader, [...first, ...edit]);
    assert.equal(supplierView(reader, supplier).listed, 145_000);
    assert.equal(count(reader, "SELECT COUNT(*) AS n FROM sync_dirty_records WHERE aggregate_type = 'PURCHASE_VOUCHER'"), 0);

    // Deleted: the bill leaves the balance on both, and stays stored with who deleted it.
    accounts.db.deletePurchaseVoucher(bill.id, "accounts");
    deliver(reader, sent(accounts));
    assert.deepEqual(supplierView(reader, supplier), supplierView(accounts, supplier));
    assert.equal(supplierView(reader, supplier).listed, 100_000);
    assert.equal(count(reader, `SELECT COUNT(*) AS n FROM purchase_vouchers WHERE id = '${bill.id}' AND deleted_by = 'accounts'`), 1);

    assert.deepEqual({ accounts: untouched(accounts), reader: untouched(reader) }, before, "no stock, cash, claim or carton figure moved on either computer");
  } finally {
    accounts.close();
    reader.close();
  }
});

test("a bill stored before this release is not sent by itself: only bills written or changed from now on travel", () => {
  const accounts = openAccounts();
  try {
    const supplier = accounts.db.createParty({ partyName: "SYNTHETIC SUPPLIER ECHO", partyType: "SUPPLIER", status: "ACTIVE" });
    const item = material(accounts);
    accounts.db.createPurchaseVoucher({ partyId: supplier, voucherDate: "2026-11-20", lines: [{ itemId: item, quantity: 1, unitPrice: 10 }] });
    sent(accounts);
    // An older bill: as if it had been stored before the capture triggers existed.
    accounts.db.db.prepare("DELETE FROM sync_dirty_records").run();
    accounts.db.db.prepare("DELETE FROM sync_record_revisions WHERE aggregate_type = 'PURCHASE_VOUCHER'").run();
    assert.deepEqual(sent(accounts).filter((envelope) => envelope.aggregateType === "PURCHASE_VOUCHER"), [], "nothing is sent for a bill nobody changed");
  } finally {
    accounts.close();
  }
});
