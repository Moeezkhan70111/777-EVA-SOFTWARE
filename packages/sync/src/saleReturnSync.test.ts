import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase, buildLeasedRecordRevisions } from "@erp/data";
import { activateCartonCloudForTest } from "@erp/data/dist/testing/cartonCloud.js";
import { applyEnvelope } from "./applyEnvelope.js";
import type { SyncEnvelope } from "./contract.js";

// SALE RETURNS ACROSS COMPUTERS (docs/55). A carton a customer sent back is credited at its own bill line's rate, on the
// computer holding the sales lease. Before this, the credit stayed there: every other computer's customer balance was
// too high by it. Now it travels as SALE_RETURN, and its cancellation with its bill travels too.
//
// The row is written here the way the return scan writes it (saleReturns.ts recordSaleReturn). The scan itself is on
// the carton QR hold in this release, and its QR, dispatch and session ids are the sales computer's own references.

const SCHEMA = path.resolve(import.meta.dirname, "../../data/src/local-schema.sql");
const NOW = "2026-11-21T10:00:00.000Z";

interface Pc {
  readonly name: string;
  readonly db: SqliteDatabase;
  readonly close: () => void;
}

function openPc(name: string, domains: readonly string[], block: number): Pc {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `erp-returns-${name}-`));
  const db = new SqliteDatabase({ dbPath: path.join(dir, "erp.db"), schemaPath: SCHEMA });
  db.db.prepare("INSERT OR REPLACE INTO app_settings (setting_key, setting_value, updated_at) VALUES ('device.id', ?, ?)").run(`dev-${name}`, NOW);
  const lease = db.db.prepare(
    `INSERT INTO sync_domain_leases (domain, holder_device_id, holder_label, epoch, barrier_seq, granted_at, project_key, fetched_at)
     VALUES (?, ?, ?, 1, 0, ?, 'https://test.supabase.co', ?)`
  );
  for (const domain of domains) lease.run(domain, `dev-${name}`, name, NOW, NOW);
  db.setNumberBlock(block, "test");
  // Bills and returns travel only once Carton Cloud is active, and never one recorded before (stockProtection.ts).
  activateCartonCloudForTest(db.db, "https://test.supabase.co");
  return { name, db, close: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

function sent(from: Pc): SyncEnvelope[] {
  // As the sync loop does: build, push, and build again until nothing more is queued. A record waits for what it
  // names to have been sent first.
  const rows: Array<Record<string, unknown>> = [];
  while (buildLeasedRecordRevisions(from.db.db, NOW).queued > 0) {
    rows.push(...(from.db.db.prepare("SELECT aggregate_type, aggregate_id, dedupe_key, payload_json FROM sync_outbox WHERE status = 'PENDING' ORDER BY rowid").all() as Array<Record<string, unknown>>));
    from.db.db.prepare("UPDATE sync_outbox SET status = 'SYNCED' WHERE status = 'PENDING'").run();
  }
  return rows.map((row) => ({
    dedupeKey: String(row.dedupe_key),
    aggregateType: String(row.aggregate_type),
    aggregateId: String(row.aggregate_id),
    operation: "INSERT" as const,
    payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    originDeviceId: `dev-${from.name}`,
    createdAt: NOW,
  }));
}

function deliver(reader: Pc, envelopes: readonly SyncEnvelope[]): void {
  for (const envelope of envelopes) {
    const outcome = applyEnvelope(reader.db.db, envelope, NOW);
    assert.ok(outcome.status === "APPLIED" || outcome.status === "DUPLICATE", `${envelope.aggregateType}: ${JSON.stringify(outcome)}`);
  }
}

const count = (pc: Pc, sql: string): number => Number((pc.db.db.prepare(sql).get() as { n: number }).n);

const customerView = (pc: Pc, customer: string) => ({
  balance: pc.db.listCustomerBalances().rows.find((row) => row.partyId === customer)?.balance ?? null,
  closing: pc.db.getCustomerLedgerWithCash(customer).closingBalance,
});

/** One returned carton, written as the return scan writes it. */
function recordReturn(sales: Pc, input: { customer: string; variant: string; billId: string; creditPaisa: number }): string {
  const id = crypto.randomUUID();
  const last = Number((sales.db.db.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(return_number, 4) AS INTEGER)), 0) AS n FROM sale_returns").get() as { n: number }).n);
  sales.db.db
    .prepare(
      `INSERT INTO sale_returns (id, return_number, party_id, return_date, qr_id, product_variant_id, dispatch_event_id, sale_voucher_id,
         quantity_cartons, unit_price_paisa, discount_per_pair_paisa, total_amount_paisa, recorded_by, status, created_at, updated_at)
       VALUES (?, ?, ?, '2026-11-21', ?, ?, ?, ?, 1, ?, 0, ?, 'gate', 'ACTIVE', ?, ?)`
    )
    .run(id, `SR-${String(last + 1).padStart(6, "0")}`, input.customer, `qr-${id}`, input.variant, `dispatch-${id}`, input.billId, input.creditPaisa, input.creditPaisa, NOW, NOW);
  return id;
}

test("a sale return credits the customer on every computer, once, and its cancellation with the bill travels too", () => {
  const sales = openPc("sales", ["SALES_DISPATCH", "MASTER_DATA", "PARTIES", "CARTON_STOCK", "ACCOUNTS"], 1);
  const boss = openPc("boss", [], 3);
  try {
    const customer = sales.db.createParty({ partyName: "SYNTHETIC CUSTOMER ALPHA", partyType: "CUSTOMER", status: "ACTIVE" });
    sales.db.createProduct({ article: "SK6", size: "7/10", sellingPrice: 550, colors: ["RED"], createdBy: "owner" } as never);
    const sku = (sales.db.db.prepare("SELECT id FROM article_sizes WHERE article = 'SK6'").get() as { id: string }).id;
    const red = (sales.db.db.prepare("SELECT id FROM product_variants WHERE article_size_id = ? AND color = 'RED'").get(sku) as { id: string }).id;
    const bill = sales.db.createManualSaleVoucher({
      requestId: crypto.randomUUID(), partyId: customer, voucherDate: "2026-11-20", bookNo: "M1", lines: [{ productVariantId: red, quantity: 2, unitPrice: 100, discount: 0 }],
    });
    deliver(boss, sent(sales));
    assert.deepEqual(customerView(boss, customer), customerView(sales, customer), "the bill arrived");
    const billed = customerView(sales, customer).balance;

    recordReturn(sales, { customer, variant: red, billId: bill.id, creditPaisa: 6_000 });
    const returned = sent(sales);
    assert.deepEqual(returned.map((envelope) => envelope.aggregateType), ["SALE_RETURN"]);
    deliver(boss, returned);
    deliver(boss, returned);
    assert.deepEqual(customerView(boss, customer), customerView(sales, customer), "both computers credit the return");
    assert.equal(customerView(boss, customer).balance, Number(billed) - 60, "Rs 60 credited, once, though delivered twice");
    assert.equal(count(boss, "SELECT COUNT(*) AS n FROM sync_dirty_records WHERE aggregate_type = 'SALE_RETURN'"), 0, "the reader never re-sends it");

    // The bill is deleted: its return is cancelled with it, on both computers.
    sales.db.deleteSaleVoucher(bill.id, "entered twice");
    deliver(boss, sent(sales));
    assert.deepEqual(customerView(boss, customer), customerView(sales, customer));
    assert.equal(customerView(boss, customer).balance, 0);
    assert.equal(count(boss, "SELECT COUNT(*) AS n FROM sale_returns WHERE status = 'CANCELLED' AND deleted_at IS NOT NULL"), 1, "the cancelled return is kept");
  } finally {
    sales.close();
    boss.close();
  }
});
