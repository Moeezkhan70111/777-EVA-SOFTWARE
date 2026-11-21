import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase, buildLeasedRecordRevisions } from "@erp/data";
import { applyEnvelope } from "./applyEnvelope.js";
import type { SyncEnvelope } from "./contract.js";

// CLAIMS ACROSS THE THREE COMPUTERS (docs/55), end to end, each computer its own real database:
//
//   STORE (PC2)     holds the store's lease. Closing a program records a claim REQUEST: pairs, material, party, reason.
//   ACCOUNTS (PC1)  holds ACCOUNTS and PARTIES. Receives the request, prices it, posts, reverses, re-posts, rejects.
//   BOSS (PC3)      holds nothing. Receives everything, writes nothing.
//
// Every step is delivered with the real builder and the real applier, in the order the cloud's log would give it. All
// three must agree on the request's status and the supplier's balance after every step; a delivery made twice must
// change nothing; a reader must never mark what it received as its own; and no stock, cash or carton figure may move.

const SCHEMA = path.resolve(import.meta.dirname, "../../data/src/local-schema.sql");
const NOW = "2026-11-21T10:00:00.000Z";

interface Pc {
  readonly name: string;
  readonly deviceId: string;
  readonly db: SqliteDatabase;
  readonly close: () => void;
}

function openPc(name: string, domains: readonly string[], block: number): Pc {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `erp-claims-${name}-`));
  const db = new SqliteDatabase({ dbPath: path.join(dir, "erp.db"), schemaPath: SCHEMA });
  const deviceId = `dev-${name}`;
  db.db.prepare("INSERT OR REPLACE INTO app_settings (setting_key, setting_value, updated_at) VALUES ('device.id', ?, ?)").run(deviceId, NOW);
  const lease = db.db.prepare(
    `INSERT INTO sync_domain_leases (domain, holder_device_id, holder_label, epoch, barrier_seq, granted_at, project_key, fetched_at)
     VALUES (?, ?, ?, 1, 0, ?, 'https://test.supabase.co', ?)`
  );
  for (const domain of domains) lease.run(domain, deviceId, name, NOW, NOW);
  db.setNumberBlock(block, "test");
  return { name, deviceId, db, close: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

/** What `from` sends now: its new revisions, as envelopes, in the order it queued them. */
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
    originDeviceId: from.deviceId,
    createdAt: NOW,
  }));
}

/** Delivers to every reader, and checks each applied (or already had) every envelope. */
function deliver(readers: readonly Pc[], envelopes: readonly SyncEnvelope[]): void {
  for (const reader of readers) {
    for (const envelope of envelopes) {
      const outcome = applyEnvelope(reader.db.db, envelope, NOW);
      assert.ok(outcome.status === "APPLIED" || outcome.status === "DUPLICATE", `${reader.name} ${envelope.aggregateType}: ${JSON.stringify(outcome)}`);
    }
  }
}

const count = (pc: Pc, sql: string): number => Number((pc.db.db.prepare(sql).get() as { n: number }).n);

/** What all three must agree on: each request's number and status, and the supplier's balance and claim lines. */
const view = (pc: Pc, supplier: string) => ({
  requests: pc.db.listPartyClaimRequests({ filter: "ALL" }).rows.map((row) => [row.requestNumber, row.status, row.posted?.claimNumber ?? null, row.posted?.amountPaisa ?? null, row.reversed.length]),
  balance: pc.db.listSupplierBalances({ asOfDate: "2026-12-31" }).rows.find((row) => row.partyId === supplier)?.balance ?? null,
  claimLines: pc.db.getSupplierLedger(supplier).entries.filter((entry) => entry.voucherType === "CLAIM").map((entry) => [entry.voucherNumber, entry.debitAmount, entry.description]),
});

/** Nothing a claim may ever move. */
const untouched = (pc: Pc) =>
  ["inventory_stock_events", "inventory_stock_balances", "carton_stock_events", "cash_vouchers", "purchase_vouchers"].map((table) => count(pc, `SELECT COUNT(*) AS n FROM ${table}`));

/** The store closes a program short and asks for `pairs` to be claimed: the same write the close makes, in its transaction. */
function storeRequests(store: Pc, input: { supplier: string; item: string; pairs: number; reason: string; program: string }): string {
  store.db.db.exec("BEGIN IMMEDIATE TRANSACTION");
  const number = store.db.recordClaimRequest({
    partyId: input.supplier, role: "SUPPLIER", programId: `prog-${input.program}`, programCode: input.program, lineId: `line-${input.program}`,
    itemId: input.item, pairs: input.pairs, reason: input.reason, actor: "store-operator",
  });
  store.db.db.exec("COMMIT");
  return number;
}

function material(store: Pc): string {
  store.db.createInventoryUnit({ code: "DOZEN", name: "Dozen", unitFamily: "COUNT" });
  const unitId = (store.db.listInventoryUnits() as Array<{ id: string }>)[0]!.id;
  const categoryId = store.db.createInventoryCategory({ name: "UPPER" });
  store.db.addInventoryCategoryField({ categoryId, fieldKey: "article", label: "ARTICLE", fieldType: "TEXT", required: true });
  return store.db.createInventoryItem({ categoryId, unitId, values: { article: "SK6 RED" } }).id;
}

const requestId = (pc: Pc, number: string): string => pc.db.listPartyClaimRequests({ filter: "ALL" }).rows.find((row) => row.requestNumber === number)!.requestId;

test("a claim request travels from the store, Accounts prices, reverses and re-posts it, and all three computers agree", () => {
  const accounts = openPc("accounts", ["ACCOUNTS", "PARTIES"], 1);
  const store = openPc("store", ["RAW_MATERIAL_STORE"], 2);
  const boss = openPc("boss", [], 3);
  const all = [accounts, store, boss];
  try {
    const supplier = accounts.db.createParty({ partyName: "SYNTHETIC SUPPLIER DELTA", partyType: "SUPPLIER", status: "ACTIVE" });
    deliver([store, boss], sent(accounts));
    const item = material(store);
    deliver([accounts, boss], sent(store));
    const before = all.map(untouched);

    // 1. The store asks. Nothing is on any ledger.
    const cr = storeRequests(store, { supplier, item, pairs: 2, reason: "torn upper", program: "MP-000012" });
    assert.match(cr, /^CR-\d{6,}$/);
    const request = sent(store);
    assert.deepEqual(request.map((envelope) => envelope.aggregateType), ["PARTY_CLAIM_REQUEST"], "one request, one record");
    deliver([accounts, boss], request);
    for (const pc of all) {
      assert.deepEqual(view(pc, supplier), { requests: [[cr, "PENDING", null, null, 0]], balance: 0, claimLines: [] }, `${pc.name} sees the request and no claim`);
    }
    const arrived = accounts.db.getPartyClaimRequest(requestId(accounts, cr))!;
    assert.deepEqual(
      [arrived.programCode, arrived.materialName, arrived.partyName, arrived.pairs, arrived.reason, arrived.originDeviceId, arrived.createdBy],
      ["MP-000012", "UPPER — SK6 RED", "SYNTHETIC SUPPLIER DELTA", 2, "torn upper", "dev-store", "store-operator"],
      "Accounts sees what the store saw: program, material, party, pairs, reason, and who and where"
    );

    // 2. Accounts posts at Rs 50 a pair. A retry with the same claim id posts nothing more.
    const claimId = crypto.randomUUID();
    const post = { claimId, requestId: requestId(accounts, cr), ratePaisa: 5_000, actor: "accounts-clerk" };
    const posted = accounts.db.postClaimFromRequest(post);
    assert.equal(posted.status, "POSTED");
    assert.equal(accounts.db.postClaimFromRequest(post).posted?.claimId, claimId, "the same attempt again is answered, not posted twice");
    assert.throws(() => accounts.db.postClaimFromRequest({ ...post, claimId: crypto.randomUUID() }), /already posted as CL-/);
    const claim = sent(accounts);
    assert.deepEqual(claim.map((envelope) => envelope.aggregateType), ["PARTY_CLAIM"]);
    deliver([store, boss], claim);
    deliver([store, boss], [...request, ...claim]);
    const afterPost = view(accounts, supplier);
    assert.equal(afterPost.balance, -100, "Rs 100 deducted from what we owe the supplier");
    assert.match(String(afterPost.claimLines[0]?.[2]), /^Claim · MP-000012 · 2 pairs of UPPER — SK6 RED — torn upper$/, "the ledger line names the program and material without the program");
    for (const pc of all) assert.deepEqual(view(pc, supplier), afterPost, `${pc.name} agrees after the post`);

    // 3. Reversed with a reason: off every ledger, kept, and the request is pending again.
    assert.throws(() => accounts.db.reversePartyClaim({ claimId, reason: "  ", actor: "accounts-clerk" }), /Say why/);
    accounts.db.reversePartyClaim({ claimId, reason: "wrong rate", actor: "accounts-clerk" });
    deliver([store, boss], sent(accounts));
    for (const pc of all) {
      const seen = view(pc, supplier);
      assert.deepEqual([seen.balance, seen.claimLines, seen.requests[0]?.[1], seen.requests[0]?.[4]], [0, [], "PENDING", 1], `${pc.name}: reversed and pending again`);
      assert.equal(count(pc, `SELECT COUNT(*) AS n FROM party_claims WHERE id = '${claimId}' AND status = 'REVERSED' AND reversal_reason = 'wrong rate' AND reversed_by = 'accounts-clerk'`), 1, `${pc.name} keeps the reversed claim`);
    }

    // 4. Re-posted at the right amount.
    accounts.db.postClaimFromRequest({ claimId: crypto.randomUUID(), requestId: requestId(accounts, cr), ratePaisa: 4_000, actor: "accounts-clerk" });
    deliver([store, boss], sent(accounts));
    for (const pc of all) assert.deepEqual(view(pc, supplier), view(accounts, supplier), `${pc.name} agrees after the re-post`);
    assert.equal(view(boss, supplier).balance, -80);

    // 5. A second request is rejected: final, on every computer, and it can no longer be posted.
    const second = storeRequests(store, { supplier, item, pairs: 1, reason: "dirty upper", program: "MP-000013" });
    deliver([accounts, boss], sent(store));
    assert.throws(() => accounts.db.rejectClaimRequest({ requestId: requestId(accounts, second), reason: "", actor: "accounts-clerk" }), /Say why/);
    accounts.db.rejectClaimRequest({ requestId: requestId(accounts, second), reason: "supplier replaced the uppers", actor: "accounts-clerk" });
    deliver([store, boss], sent(accounts));
    assert.throws(() => accounts.db.postClaimFromRequest({ claimId: crypto.randomUUID(), requestId: requestId(accounts, second), ratePaisa: 1_000, actor: "accounts-clerk" }), /was rejected/);
    for (const pc of all) {
      const statuses = Object.fromEntries(view(pc, supplier).requests.map((row) => [row[0], row[1]]));
      assert.deepEqual(statuses, { [cr]: "POSTED", [second]: "REJECTED" }, `${pc.name}`);
      assert.equal(view(pc, supplier).balance, -80, `${pc.name}: a rejection moves no balance`);
    }

    // Nobody re-sends what it received, and nothing else moved anywhere.
    for (const reader of [store, boss]) {
      assert.equal(count(reader, "SELECT COUNT(*) AS n FROM sync_dirty_records WHERE aggregate_type IN ('PARTY_CLAIM','PARTY_CLAIM_REJECTION')"), 0, `${reader.name} never marks Accounts' records`);
    }
    assert.equal(count(accounts, "SELECT COUNT(*) AS n FROM sync_dirty_records WHERE aggregate_type = 'PARTY_CLAIM_REQUEST'"), 0, "Accounts never marks the store's requests");
    assert.equal(count(boss, "SELECT COUNT(*) AS n FROM sync_dirty_records"), 0, "the boss computer marks nothing");
    assert.deepEqual(all.map(untouched), before, "no stock, cash, carton or purchase figure moved on any computer");
  } finally {
    for (const pc of all) pc.close();
  }
});

test("a claim that arrives before its request waits, and is applied once the request is there", () => {
  const accounts = openPc("accounts", ["ACCOUNTS", "PARTIES"], 1);
  const store = openPc("store", ["RAW_MATERIAL_STORE"], 2);
  const boss = openPc("boss", [], 3);
  try {
    const supplier = accounts.db.createParty({ partyName: "SYNTHETIC SUPPLIER ECHO", partyType: "SUPPLIER", status: "ACTIVE" });
    const parties = sent(accounts);
    deliver([store, boss], parties);
    const item = material(store);
    const items = sent(store);
    deliver([accounts, boss], items);
    const cr = storeRequests(store, { supplier, item, pairs: 3, reason: "lost", program: "MP-000020" });
    const request = sent(store);
    deliver([accounts], request);
    accounts.db.postClaimFromRequest({ claimId: crypto.randomUUID(), requestId: requestId(accounts, cr), ratePaisa: 1_000, actor: "accounts-clerk" });
    const claim = sent(accounts);

    const early = applyEnvelope(boss.db.db, claim[0]!, NOW);
    assert.notEqual(early.status, "APPLIED", "the claim names a request the boss computer does not have yet");
    assert.equal(count(boss, "SELECT COUNT(*) AS n FROM party_claims"), 0);
    deliver([boss], [...request, ...claim]);
    assert.equal(view(boss, supplier).balance, -30);
  } finally {
    accounts.close();
    store.close();
    boss.close();
  }
});
