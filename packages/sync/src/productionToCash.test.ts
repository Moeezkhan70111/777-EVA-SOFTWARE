import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddMachineUseCase, CancelGatepassUseCase, CreateGatepassUseCase, InMemoryEventBus } from "@erp/application";
import { SqliteDatabase, buildCartonStockEvents, resendCartonMovementsRefusedForLease, runBackfill } from "@erp/data";
import { CARTON_QR_ON_HOLD, LEASE_DOMAIN, type LeaseDomain } from "@erp/domain";
import type { SyncEnvelope } from "./contract.js";
import { OutboxDrain } from "./drain.js";
import { leaseWriteDecision } from "./leases.js";
import { parkedSummary } from "./parking.js";
import { SyncPull } from "./pull.js";
import type { SyncAck, SyncChange, SyncPullTransport, SyncTransport } from "./transport.js";

// THE MANUAL PRODUCTION-TO-CASH WORKFLOW, end to end, on two computers (docs/43).
//
//   Machine, product, quantity -> production -> carton stock + contractor ledger
//   Gatepass -> stock falls once, one bill -> bill entry -> customer debit -> cash voucher -> customer credit
//
// Real writers, real capture triggers, real builders, real outbox and drain, real pull and appliers, real lease
// decision. Only the cloud is a stand-in, holding to what push_leased_record and push_carton_stock_event hold to: one
// dedupe key is one event, and only the current holder of a type's lease at the current epoch is accepted.
//
// THIS IS A SIMULATION. The real cloud-connected rehearsal is separate (docs/43 section 7).

const SCHEMA = path.resolve(import.meta.dirname, "../../data/src/local-schema.sql");
const PROJECT = "https://test.supabase.co";
const STORE = "factory-777";
const idGen = { nextId: () => crypto.randomUUID() };
const clock = { ms: Date.now() + 86_400_000 };
const nowIso = () => new Date(clock.ms).toISOString();
const passTime = () => { clock.ms += 3_600_000; };
const LEASES: readonly LeaseDomain[] = [LEASE_DOMAIN.MASTER_DATA, LEASE_DOMAIN.CARTON_STOCK, LEASE_DOMAIN.SALES_DISPATCH, LEASE_DOMAIN.ACCOUNTS];
const DOMAIN_OF: Readonly<Record<string, LeaseDomain>> = {
  PARTY_GROUP: LEASE_DOMAIN.MASTER_DATA, PARTY: LEASE_DOMAIN.MASTER_DATA, WORK_SECTION: LEASE_DOMAIN.MASTER_DATA, MACHINE: LEASE_DOMAIN.MASTER_DATA,
  MAIN_GROUP: LEASE_DOMAIN.MASTER_DATA, PRODUCT_GROUP: LEASE_DOMAIN.MASTER_DATA, ARTICLE_SERIES: LEASE_DOMAIN.MASTER_DATA, PRODUCT_TYPE: LEASE_DOMAIN.MASTER_DATA,
  PRODUCT_SUB_GROUP: LEASE_DOMAIN.MASTER_DATA, ARTICLE_SIZE: LEASE_DOMAIN.MASTER_DATA,
  CARTON_STOCK_EVENT: LEASE_DOMAIN.CARTON_STOCK, MANUAL_PRODUCTION_ENTRY: LEASE_DOMAIN.CARTON_STOCK,
  GATEPASS: LEASE_DOMAIN.SALES_DISPATCH, SALE_VOUCHER: LEASE_DOMAIN.SALES_DISPATCH, CASH_VOUCHER: LEASE_DOMAIN.ACCOUNTS,
};

class Cloud {
  readonly log: SyncChange[] = [];
  readonly leases = new Map<LeaseDomain, { holder: string; epoch: number }>(LEASES.map((domain) => [domain, { holder: "dev-a", epoch: 1 }]));
  private readonly unreachable = new Set<string>();

  offline(device: string): void { this.unreachable.add(device); }
  online(device: string): void { this.unreachable.delete(device); }
  grant(domain: LeaseDomain, holder: string): void {
    this.leases.set(domain, { holder, epoch: (this.leases.get(domain)?.epoch ?? 0) + 1 });
  }
  /** At-least-once: every event offered again at a later position. */
  deliverAgain(): void {
    for (const change of [...this.log]) this.log.push({ seq: this.log.length + 1, envelope: change.envelope });
  }

  private accept(envelope: SyncEnvelope, device: string): SyncAck {
    const domain = DOMAIN_OF[envelope.aggregateType];
    const lease = domain === undefined ? undefined : this.leases.get(domain);
    if (lease !== undefined && (lease.holder !== device || envelope.leaseEpoch !== lease.epoch)) {
      return { dedupeKey: envelope.dedupeKey, accepted: false, reason: "NOT_LEASE_HOLDER", failure: "REFUSED" };
    }
    if (!this.log.some((change) => change.envelope.dedupeKey === envelope.dedupeKey)) {
      this.log.push({ seq: this.log.length + 1, envelope: { ...envelope, originDeviceId: device } });
    }
    return { dedupeKey: envelope.dedupeKey, accepted: true };
  }

  as(device: string): SyncTransport & SyncPullTransport {
    return {
      send: async (envelopes) => {
        if (this.unreachable.has(device)) throw new Error("the cloud could not be reached");
        return envelopes.map((envelope) => this.accept(envelope, device));
      },
      fetchChanges: async (afterSeq, limit) => {
        if (this.unreachable.has(device)) throw new Error("the cloud could not be reached");
        return this.log.filter((change) => change.seq > afterSeq).slice(0, limit);
      },
    };
  }
}

interface Pc { readonly name: string; readonly device: string; readonly dbPath: string; db: SqliteDatabase }

const openDb = (dbPath: string) => new SqliteDatabase({ dbPath, schemaPath: SCHEMA });

function openPc(name: string, block: number): Pc {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `erp-cash-${name}-`)), "erp.db");
  const db = openDb(dbPath);
  const device = `dev-${name}`;
  db.setNumberBlock(block, "test");
  db.ensureOperationalContext({
    factoryId: STORE, factoryCode: "F777", factoryName: "777",
    workstationId: `ws-${name}`, workstationCode: `WS-${name}`, workstationName: name,
    deviceId: device, deviceName: name, appVersion: "1.0.0",
  });
  db.db.prepare("INSERT OR REPLACE INTO app_settings (setting_key, setting_value, updated_at) VALUES ('device.id', ?, ?)").run(device, nowIso());
  db.cartonQrOnHold = CARTON_QR_ON_HOLD;
  return { name, device, dbPath, db };
}

function hearLeases(pc: Pc, cloud: Cloud): void {
  for (const [domain, lease] of cloud.leases) {
    pc.db.db.prepare(
      `INSERT INTO sync_domain_leases (domain, holder_device_id, holder_label, epoch, barrier_seq, granted_at, project_key, fetched_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT (domain) DO UPDATE SET holder_device_id = excluded.holder_device_id, holder_label = excluded.holder_label,
         epoch = excluded.epoch, barrier_seq = 0, project_key = excluded.project_key, fetched_at = excluded.fetched_at`
    ).run(domain, lease.holder, lease.holder, lease.epoch, nowIso(), PROJECT, nowIso());
  }
}

async function pass(pc: Pc, cloud: Cloud): Promise<void> {
  resendCartonMovementsRefusedForLease(pc.db.db, nowIso());
  pc.db.buildLeasedRecordRevisions(nowIso());
  buildCartonStockEvents(pc.db.db, nowIso());
  const transport = cloud.as(pc.device);
  const retryPolicy = { maxAttempts: 2, baseBackoffMs: 1, maxBackoffMs: 1, staleInFlightMs: 120_000 };
  await new OutboxDrain(pc.db.db, transport, { deviceId: pc.device, now: nowIso, retryPolicy }).runOnce();
  await new SyncPull(pc.db.db, transport, { now: () => clock.ms, project: PROJECT }).runOnce();
  passTime();
}

const passAll = async (cloud: Cloud, ...pcs: Pc[]) => {
  for (let round = 0; round < 3; round += 1) for (const pc of pcs) await pass(pc, cloud);
};

interface Office {
  readonly cloud: Cloud;
  readonly a: Pc;
  readonly b: Pc;
  readonly machine: string;
  readonly contractor: string;
  readonly packer: string;
  readonly customer: string;
  readonly sku: string;
  readonly red: string;
}

const gatepassDeps = (pc: Pc) => ({ txManager: pc.db, repo: pc.db, idGenerator: idGen });
const issueGatepass = (pc: Pc, office: Office, quantity: number) =>
  new CreateGatepassUseCase(gatepassDeps(pc)).execute({ partyId: office.customer, lines: [{ productVariantId: office.red, quantity }], actor: "clerk" });
const cancelGatepass = (pc: Pc, gatepassId: string) =>
  new CancelGatepassUseCase(gatepassDeps(pc)).execute({ gatepassId, reason: "wrong party", actor: "clerk" });

const produce = (pc: Pc, office: Office, dozens: string, requestId: string = crypto.randomUUID()) =>
  pc.db.recordManualProduction({ requestId, machineId: office.machine, articleSizeId: office.sku, color: "RED", dozens, storeLocationId: STORE, createdBy: "aslam" });

const inStore = (pc: Pc, office: Office): number =>
  pc.db.listStoreStock().filter((row) => row.productVariantId === office.red).reduce((sum, row) => sum + row.storeQuantity, 0);
const balanceOf = (pc: Pc, office: Office): number => pc.db.listCustomerBalances().rows.find((row) => row.partyId === office.customer)?.balance ?? Number.NaN;
const earned = (pc: Pc, office: Office, account: string = office.contractor) =>
  pc.db.getContractorLedger(account, { fromDate: "2020-01-01", toDate: "2999-12-31" });
const count = (pc: Pc, table: string, where = "1 = 1"): number =>
  Number((pc.db.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n);
const entryPayment = (pc: Pc, office: Office, amount: number, requestId?: string) =>
  pc.db.createCashVoucher({
    requestId, partyId: office.customer, voucherDate: "2026-11-07", modeOfTransfer: "Cash", description: "against the bill", receiptAmount: amount,
    lines: [{ partyId: office.customer, description: "against the bill", modeOfTransfer: "Cash", receiptAmount: amount, paymentAmount: 0 }],
  });
const enterBill = (pc: Pc, office: Office, billId: string, dozens: number, rate = 100) =>
  pc.db.enterGatepassBill(billId, { bookNo: "B1", lines: [{ productVariantId: office.red, quantity: dozens, unitPrice: rate, discount: 0 }] });

/** A holds every lease, with the master data made there and already on B. */
async function withOffice(work: (office: Office) => Promise<void>): Promise<void> {
  const cloud = new Cloud();
  const a = openPc("a", 1);
  const b = openPc("b", 2);
  hearLeases(a, cloud);
  hearLeases(b, cloud);
  try {
    const party = (name: string, type: string, mobile: string) => a.db.createParty({ partyName: name, partyType: type as never, city: "Lahore", mobileNumber: mobile, status: "ACTIVE" });
    const contractor = party("ASLAM", "CONTRACTOR", "0300-1111111");
    const packer = party("BABAR", "CONTRACTOR", "0300-2222222");
    const customer = party("MAMA CHAPPAL", "CUSTOMER", "0300-3333333");
    const added = await new AddMachineUseCase({ txManager: a.db, repo: a.db, eventPublisher: new InMemoryEventBus(), idGenerator: idGen })
      .execute({ name: "Machine 1", contractorPartyId: contractor, packingContractorPartyId: packer, actor: "admin" });
    a.db.createProduct({ article: "SK6", size: "7/10", sellingPrice: 550, machineRate: 70, packingRate: 30, printingRate: 10, colors: ["RED"], createdBy: "owner" } as never);
    const sku = (a.db.db.prepare("SELECT id FROM article_sizes WHERE article = 'SK6'").get() as { id: string }).id;
    const red = (a.db.db.prepare("SELECT id FROM product_variants WHERE article_size_id = ? AND color = 'RED'").get(sku) as { id: string }).id;
    await passAll(cloud, a, b);
    await work({ cloud, a, b, machine: added.machineId ?? "", contractor, packer, customer, sku, red });
  } finally {
    for (const pc of [a, b]) {
      try { pc.db.close(); } catch { /* already closed by a restart */ }
      fs.rmSync(path.dirname(pc.dbPath), { recursive: true, force: true });
    }
  }
}

/** Nothing stuck on either computer, and the same figures on both. */
function assertSameEverywhere(office: Office): void {
  const { a, b } = office;
  for (const pc of [a, b]) {
    assert.equal(parkedSummary(pc.db.db).count, 0, `${pc.name} has nothing parked`);
    assert.equal(count(pc, "sync_outbox", "status IN ('FAILED', 'DEAD_LETTER')"), 0, `${pc.name} has nothing refused`);
  }
  assert.equal(inStore(a, office), inStore(b, office), "the same carton stock");
  assert.equal(balanceOf(a, office), balanceOf(b, office), "the same customer balance");
  assert.equal(earned(a, office).closingBalancePaisa, earned(b, office).closingBalancePaisa, "the same contractor balance");
  assert.equal(a.db.cartonStockReconciliation().fingerprint, b.db.cartonStockReconciliation().fingerprint, "the same movement history");
}

test("1, 2: production raises the right stock and earns one ledger line, at the rate saved with it", async () => {
  await withOffice(async (office) => {
    const { a, b, cloud } = office;
    const saved = produce(a, office, "10");
    assert.equal(saved.entry.cartons, 20, "10 dozen is 20 cartons");
    assert.equal(inStore(a, office), 20);
    const row = a.db.db.prepare("SELECT machine_rate_paisa, packing_rate_paisa, printing_rate_paisa, rate_source, contractor_party_id, packing_contractor_party_id FROM manual_production_entries").get() as Record<string, unknown>;
    assert.deepEqual({ ...row }, { machine_rate_paisa: 7000, packing_rate_paisa: 3000, printing_rate_paisa: 1000, rate_source: "PRODUCT", contractor_party_id: office.contractor, packing_contractor_party_id: office.packer });
    assert.equal(earned(a, office).earnedPaisa, 70_000, "10 dozen at Rs 70");
    assert.equal(earned(a, office, office.packer).earnedPaisa, 30_000, "10 dozen at Rs 30");

    const again = produce(a, office, "10", (a.db.db.prepare("SELECT request_id FROM manual_production_entries").get() as { request_id: string }).request_id);
    assert.equal(again.duplicate, true, "the same press of Save is the same entry");
    assert.equal(inStore(a, office), 20, "and adds nothing");
    assert.equal(earned(a, office).earnedPaisa, 70_000, "and earns nothing");

    await passAll(cloud, a, b);
    assert.equal(inStore(b, office), 20, "the other computer holds them too, at the same grain");
    assert.equal(count(b, "manual_production_entries"), 1);
    assert.equal(earned(b, office).earnedPaisa, 70_000, "and the contractor's ledger reads the same, with no program there");
    assert.equal(count(b, "machine_programs"), 0, "programs do not travel: the entry stands on its own");
    assertSameEverywhere(office);
  });
});

test("3: a later change to the product's rate does not rewrite what was earned", async () => {
  await withOffice(async (office) => {
    const { a, b, cloud } = office;
    produce(a, office, "10");
    a.db.db.prepare("UPDATE article_sizes SET machine_rate_paisa = 99900 WHERE id = ?").run(office.sku);
    assert.equal(earned(a, office).earnedPaisa, 70_000, "the old entry keeps the old rate");
    produce(a, office, "1");
    assert.equal(earned(a, office).earnedPaisa, 70_000 + 99_900, "the new entry is at the new rate");
    await passAll(cloud, a, b);
    assert.equal(earned(b, office).earnedPaisa, 70_000 + 99_900, "both computers agree, and the new rate reached the other one");
    assert.equal(Number((b.db.db.prepare("SELECT machine_rate_paisa FROM article_sizes WHERE id = ?").get(office.sku) as { machine_rate_paisa: number }).machine_rate_paisa), 99_900);
  });
});

test("3: an entry with no saved rate, from before migration 104, is priced the old way and nothing is invented for it", async () => {
  await withOffice(async (office) => {
    const { a } = office;
    produce(a, office, "10");
    a.db.db.prepare("UPDATE manual_production_entries SET machine_rate_paisa = NULL, packing_rate_paisa = NULL, printing_rate_paisa = NULL, rate_source = NULL").run();
    assert.equal(earned(a, office).earnedPaisa, 70_000, "the product's standard");
    a.db.db.prepare("UPDATE article_sizes SET machine_rate_paisa = 8000 WHERE id = ?").run(office.sku);
    assert.equal(earned(a, office).earnedPaisa, 80_000, "and it follows it, as it always did");
  });
});

test("4, 5, 6: a gatepass reads available stock, takes it once, and makes one linked bill with no money on it", async () => {
  await withOffice(async (office) => {
    const { a, b, cloud } = office;
    produce(a, office, "10");
    assert.equal(a.db.listStoreStock()[0]?.reflectedQuantity, 20, "the gatepass grid shows what can be cut");
    const refused = await issueGatepass(a, office, 21);
    assert.equal(refused.accepted, false, "not more than the store holds");
    assert.equal(count(a, "gatepasses"), 0);
    assert.equal(count(a, "sale_vouchers"), 0, "a refused gatepass leaves no bill");

    const made = await issueGatepass(a, office, 6);
    assert.equal(made.accepted, true, made.reason);
    assert.equal(inStore(a, office), 14, "the stock fell once");
    assert.equal(count(a, "carton_stock_events", "event_type = 'GATEPASS_ISSUE'"), 1);
    assert.equal(a.db.findSaleVoucherByGatepass(made.gatepassId ?? "")?.id, made.billId, "one bill, linked");
    assert.equal(count(a, "sale_vouchers"), 1);
    assert.equal(balanceOf(a, office), 0, "the customer owes nothing until the bill is entered");
    assert.equal(a.db.getCustomerLedgerWithCash(office.customer).entries.length, 0, "and the empty bill is not a ledger line");

    await passAll(cloud, a, b);
    assert.equal(inStore(b, office), 14);
    assert.equal(b.db.findSaleVoucherByGatepass(made.gatepassId ?? "")?.id, made.billId, "the same bill, under the same link, on the other computer");
    assertSameEverywhere(office);
  });
});

test("7: entering the bill debits the customer once, moves no stock, and twice is once", async () => {
  await withOffice(async (office) => {
    const { a, b, cloud } = office;
    produce(a, office, "10");
    const made = await issueGatepass(a, office, 6);
    const billId = made.billId ?? "";
    assert.throws(() => a.db.addVoucherLineItem(billId, { productVariantId: office.red, quantity: 3, unitPrice: 100, discount: 0 }), /saved together/, "not a line at a time");

    const stockBefore = inStore(a, office);
    assert.equal(enterBill(a, office, billId, 3).duplicate, false);
    // 3 dozen is 36 pairs, at Rs 100 a pair.
    assert.equal(balanceOf(a, office), 3600);
    assert.equal(inStore(a, office), stockBefore, "bill entry moves no stock");
    assert.equal(count(a, "carton_stock_events", "event_type = 'GATEPASS_ISSUE'"), 1);
    assert.equal(a.db.db.prepare("SELECT status FROM gatepasses").get()?.status, "BILLED");

    assert.equal(enterBill(a, office, billId, 3).duplicate, true, "entered again, nothing happens");
    assert.equal(balanceOf(a, office), 3600, "one debit");
    assert.equal(count(a, "sale_voucher_line_items"), 1);

    await passAll(cloud, a, b);
    assert.equal(balanceOf(b, office), 3600, "the same debit on the other computer");
    assertSameEverywhere(office);
  });
});

test("a bill is all or nothing: a wrong quantity or a missing line saves nothing", async () => {
  await withOffice(async (office) => {
    const { a } = office;
    produce(a, office, "10");
    const made = await issueGatepass(a, office, 6);
    assert.throws(() => enterBill(a, office, made.billId ?? "", 4), /must say 3/);
    assert.equal(count(a, "sale_voucher_line_items"), 0);
    assert.equal(balanceOf(a, office), 0);
    assert.equal(a.db.db.prepare("SELECT status FROM gatepasses").get()?.status, "CREATED", "the gatepass stays open");
    assert.throws(() => a.db.enterGatepassBill(made.billId ?? "", { bookNo: "B1", lines: [] }), /must carry everything/);
    assert.equal(a.db.db.prepare("SELECT status FROM gatepasses").get()?.status, "CREATED");
  });
});

test("a bill over the customer's limit is refused whole", async () => {
  await withOffice(async (office) => {
    const { a } = office;
    a.db.db.prepare("UPDATE parties SET balance_limit_paisa = 100000 WHERE id = ?").run(office.customer);
    produce(a, office, "10");
    const made = await issueGatepass(a, office, 6);
    assert.equal(made.accepted, true, "the empty bill does not trip the limit");
    assert.throws(() => enterBill(a, office, made.billId ?? "", 3), (error: unknown) => (error as { name?: string }).name === "PartyBalanceLimitExceededError");
    assert.equal(balanceOf(a, office), 0);
    assert.equal(count(a, "sale_voucher_line_items"), 0);
  });
});

test("8, 9: cash vouchers credit once, part payments leave the right balance, and a double Save is one payment", async () => {
  await withOffice(async (office) => {
    const { a, b, cloud } = office;
    produce(a, office, "10");
    const made = await issueGatepass(a, office, 6);
    enterBill(a, office, made.billId ?? "", 3);
    const requestId = crypto.randomUUID();
    assert.equal(entryPayment(a, office, 1000, requestId), requestId);
    assert.equal(entryPayment(a, office, 1000, requestId), requestId, "the same press of Save");
    assert.equal(count(a, "cash_vouchers"), 1, "one voucher");
    assert.equal(balanceOf(a, office), 2600);
    entryPayment(a, office, 600);
    assert.equal(balanceOf(a, office), 2000, "part payments add up");
    await passAll(cloud, a, b);
    assert.equal(balanceOf(b, office), 2000, "the other computer agrees");
    assert.equal(count(b, "cash_voucher_lines"), 2);
    assertSameEverywhere(office);
  });
});

test("a voucher paying two customers credits each on the balance list, as it does on the ledger", async () => {
  await withOffice(async (office) => {
    const { a } = office;
    const other = a.db.createParty({ partyName: "SECOND CUSTOMER", partyType: "CUSTOMER", city: "Lahore", mobileNumber: "0300-4444444", status: "ACTIVE" });
    a.db.createCashVoucher({
      partyId: office.customer, voucherDate: "2026-11-07", modeOfTransfer: "Cash", description: "two", receiptAmount: 100,
      lines: [
        { partyId: office.customer, description: "one", modeOfTransfer: "Cash", receiptAmount: 100, paymentAmount: 0 },
        { partyId: other, description: "two", modeOfTransfer: "Cash", receiptAmount: 40, paymentAmount: 0 },
      ],
    });
    const rows = a.db.listCustomerBalances().rows;
    assert.equal(rows.find((row) => row.partyId === office.customer)?.balance, -100);
    assert.equal(rows.find((row) => row.partyId === other)?.balance, -40, "the second party on the voucher");
    assert.equal(a.db.getCustomerLedgerWithCash(other).closingBalance, -40, "the ledger says the same");
  });
});

test("10: every event delivered again changes nothing: not production, stock, bills or payments", async () => {
  await withOffice(async (office) => {
    const { a, b, cloud } = office;
    produce(a, office, "10");
    const made = await issueGatepass(a, office, 6);
    enterBill(a, office, made.billId ?? "", 3);
    entryPayment(a, office, 1000);
    await passAll(cloud, a, b);
    const seen = () => ({
      stock: inStore(b, office), balance: balanceOf(b, office), earned: earned(b, office).earnedPaisa,
      entries: count(b, "manual_production_entries"), movements: count(b, "carton_stock_events"), gatepasses: count(b, "gatepasses"),
      bills: count(b, "sale_vouchers"), billLines: count(b, "sale_voucher_line_items"), vouchers: count(b, "cash_vouchers"), voucherLines: count(b, "cash_voucher_lines"),
    });
    const before = seen();
    assert.deepEqual(before, { stock: 14, balance: 2600, earned: 70_000, entries: 1, movements: 2, gatepasses: 1, bills: 1, billLines: 1, vouchers: 1, voucherLines: 1 });
    cloud.deliverAgain();
    await passAll(cloud, a, b);
    assert.deepEqual(seen(), before);
    assertSameEverywhere(office);
  });
});

test("11: a second computer cannot over-issue: refused here, refused by the cloud, and the stock is never oversold", async () => {
  await withOffice(async (office) => {
    const { a, b, cloud } = office;
    produce(a, office, "10");
    await passAll(cloud, a, b);
    assert.equal(leaseWriteDecision(b.db.db, { domain: LEASE_DOMAIN.CARTON_STOCK, deviceId: b.device, syncConfigured: true }).allowed, false, "B may not write cartons");

    // Past the local gate on purpose: the cloud is what must hold if the gate is bypassed.
    const rogue = await issueGatepass(b, office, 20);
    assert.equal(rogue.accepted, true, "the data layer alone does not know about leases");
    const taken = await issueGatepass(a, office, 20);
    assert.equal(taken.accepted, true);
    await passAll(cloud, a, b);
    const cloudIssues = cloud.log.filter((change) => change.envelope.aggregateType === "CARTON_STOCK_EVENT" && JSON.stringify(change.envelope.payload).includes("GATEPASS_ISSUE"));
    assert.equal(cloudIssues.length, 1, "only the holder's movement reached the cloud");
    assert.equal(inStore(a, office), 0);
    assert.ok(count(b, "sync_outbox", "status IN ('FAILED', 'DEAD_LETTER') AND last_error LIKE '%NOT_LEASE_HOLDER%'") > 0, "the bypass is refused visibly, never dropped quietly");
  });
});

test("12: offline on the holder, then a restart, then a reconnect: everything arrives, once", async () => {
  await withOffice(async (office) => {
    const { a, b, cloud } = office;
    cloud.offline(a.device);
    produce(a, office, "10");
    const made = await issueGatepass(a, office, 6);
    enterBill(a, office, made.billId ?? "", 3);
    entryPayment(a, office, 1000);
    await pass(a, cloud);
    assert.equal(inStore(b, office), 0, "nothing has reached the other computer");
    assert.equal(inStore(a, office), 14, "the holder kept working");

    a.db.close();
    a.db = openDb(a.dbPath);
    assert.equal(inStore(a, office), 14, "and a restart loses nothing");

    cloud.online(a.device);
    await passAll(cloud, a, b);
    assert.equal(inStore(b, office), 14);
    assert.equal(balanceOf(b, office), 2600);
    assertSameEverywhere(office);
  });
});

test("12: work done offline after losing the lease is not lost: it goes when the lease comes back", async () => {
  await withOffice(async (office) => {
    const { a, b, cloud } = office;
    produce(a, office, "10");
    const made = await issueGatepass(a, office, 6);
    await passAll(cloud, a, b);
    cloud.offline(a.device);
    enterBill(a, office, made.billId ?? "", 3);
    entryPayment(a, office, 1000);
    cloud.grant(LEASE_DOMAIN.SALES_DISPATCH, b.device);
    cloud.grant(LEASE_DOMAIN.ACCOUNTS, b.device);
    cloud.online(a.device);
    await pass(a, cloud);
    assert.equal(balanceOf(a, office), 2600, "the computer that did the work says so");
    await pass(b, cloud);
    assert.equal(balanceOf(b, office), 0, "the cloud refused it, so the other does not yet");
    assert.ok(cloud.log.every((change) => !["CASH_VOUCHER"].includes(change.envelope.aggregateType)));

    cloud.grant(LEASE_DOMAIN.SALES_DISPATCH, a.device);
    cloud.grant(LEASE_DOMAIN.ACCOUNTS, a.device);
    hearLeases(a, cloud);
    hearLeases(b, cloud);
    await passAll(cloud, a, b);
    assert.equal(balanceOf(b, office), 2600, "the same work, sent again under the new epoch");
    assert.equal(count(b, "cash_vouchers"), 1, "once");
    assertSameEverywhere(office);
  });
});

test("a handover: the new holder sees the stock, the bills and the ledgers, and carries on", async () => {
  await withOffice(async (office) => {
    const { a, b, cloud } = office;
    produce(a, office, "10");
    const first = await issueGatepass(a, office, 6);
    enterBill(a, office, first.billId ?? "", 3);
    await passAll(cloud, a, b);
    for (const domain of LEASES) cloud.grant(domain, b.device);
    hearLeases(a, cloud);
    hearLeases(b, cloud);

    produce(b, office, "2");
    const second = await issueGatepass(b, office, 2);
    assert.equal(second.accepted, true, second.reason);
    enterBill(b, office, second.billId ?? "", 1);
    entryPayment(b, office, 500);
    assert.notEqual(second.billNumber, first.billNumber, "numbers from B's own block");
    await passAll(cloud, a, b);
    assert.equal(inStore(a, office), 16);
    // 3 dozen, then 1 dozen, at Rs 100 a pair, less Rs 500.
    assert.equal(balanceOf(a, office), 4300);
    assert.equal(earned(a, office).earnedPaisa, 70_000 + 14_000, "both computers' entries on one contractor");
    assertSameEverywhere(office);
  });
});

test("13: arriving work tells open screens which kinds of data changed", async () => {
  // Which screens those kinds reload is the desktop app's: dataChange.test.ts there, and the real rehearsal.
  await withOffice(async (office) => {
    const { a, b, cloud } = office;
    produce(a, office, "1");
    await pass(a, cloud);
    const pulled = await new SyncPull(b.db.db, cloud.as(b.device), { now: () => clock.ms, project: PROJECT }).runOnce();
    assert.ok(pulled.appliedTypes?.includes("MANUAL_PRODUCTION_ENTRY"), "the pull names what it applied");
    assert.ok(pulled.appliedTypes?.includes("CARTON_STOCK_EVENT"));
  });
});

test("14: cancelling puts the stock back once and leaves no money or phantom bill; deleting a bill leaves no debit", async () => {
  await withOffice(async (office) => {
    const { a, b, cloud } = office;
    produce(a, office, "10");
    const open = await issueGatepass(a, office, 6);
    assert.equal(inStore(a, office), 14);
    const cancelled = await cancelGatepass(a, open.gatepassId ?? "");
    assert.equal(cancelled.accepted, true, cancelled.reason);
    assert.equal(inStore(a, office), 20, "back in stock");
    assert.equal(a.db.findSaleVoucherByGatepass(open.gatepassId ?? ""), null, "its empty bill went with it");
    assert.equal((await cancelGatepass(a, open.gatepassId ?? "")).accepted, false, "not twice");
    assert.equal(inStore(a, office), 20, "and nothing put back twice");

    const billed = await issueGatepass(a, office, 6);
    enterBill(a, office, billed.billId ?? "", 3);
    assert.equal((await cancelGatepass(a, billed.gatepassId ?? "")).accepted, false, "an entered bill must be deleted first");
    assert.equal(inStore(a, office), 14);
    a.db.deleteSaleVoucher(billed.billId ?? "", "wrong rate");
    assert.equal(balanceOf(a, office), 0, "the debit went with the bill");
    assert.equal(count(a, "sale_vouchers", "deleted_at IS NOT NULL AND id = '" + (billed.billId ?? "") + "'"), 1, "kept, marked");
    assert.equal(inStore(a, office), 14, "a deleted bill does not bring the cartons back: the gatepass still holds them");
    assert.equal((await cancelGatepass(a, billed.gatepassId ?? "")).accepted, true, "now the gatepass can be cancelled");
    assert.equal(inStore(a, office), 20);

    const voucher = entryPayment(a, office, 1000);
    a.db.deleteCashVoucher(voucher);
    a.db.deleteCashVoucher(voucher);
    assert.equal(balanceOf(a, office), 0, "a cancelled voucher credits nothing");

    produce(a, office, "1");
    const entry = (a.db.db.prepare("SELECT id FROM manual_production_entries ORDER BY entry_number DESC LIMIT 1").get() as { id: string }).id;
    const before = earned(a, office).earnedPaisa;
    a.db.voidManualProduction({ entryId: entry, reason: "miscounted", voidedBy: "admin", mayVoidEarlierDays: true });
    assert.equal(inStore(a, office), 20);
    assert.equal(earned(a, office).earnedPaisa, before - 7000, "the void withdraws the ledger line");

    await passAll(cloud, a, b);
    assert.equal(inStore(b, office), 20);
    assert.equal(balanceOf(b, office), 0);
    assert.equal(earned(b, office).earnedPaisa, before - 7000, "and on the other computer");
    assert.equal(count(b, "cash_vouchers", "status = 'CANCELLED'"), 1);
    assertSameEverywhere(office);
  });
});

test("the backfill sends a domain's documents only from the computer holding that domain's lease", async () => {
  await withOffice(async (office) => {
    const { a, b, cloud } = office;
    produce(a, office, "10");
    const made = await issueGatepass(a, office, 6);
    enterBill(a, office, made.billId ?? "", 3);
    entryPayment(a, office, 1000);
    await passAll(cloud, a, b);
    cloud.grant(LEASE_DOMAIN.SALES_DISPATCH, b.device);
    hearLeases(a, cloud);
    a.db.db.prepare("UPDATE sync_domain_leases SET holder_device_id = ?, epoch = 9 WHERE domain = 'SALES_DISPATCH'").run(b.device);
    a.db.db.prepare("INSERT INTO sync_domain_leases (domain, holder_device_id, holder_label, epoch, barrier_seq, granted_at, project_key, fetched_at) VALUES ('RAW_MATERIAL_STORE', ?, 'a', 1, 0, ?, ?, ?)").run(a.device, nowIso(), PROJECT, nowIso());
    const outcome = runBackfill(a.db.db, nowIso());
    assert.equal(outcome.done, true);
    const marked = (type: string) => count(a, "sync_dirty_records", `aggregate_type = '${type}'`);
    assert.equal(marked("CASH_VOUCHER"), 1, "accounts are held: its vouchers go");
    assert.equal(marked("ARTICLE_SIZE"), 1, "master data is held: its products go");
    assert.equal(marked("GATEPASS"), 0, "sales is held elsewhere now: its gatepasses are that computer's to send");
    assert.equal(marked("SALE_VOUCHER"), 0, "and its bills");
    assert.equal(Number((a.db.db.prepare("SELECT lease_epoch FROM sync_dirty_records WHERE aggregate_type = 'CASH_VOUCHER'").get() as { lease_epoch: number }).lease_epoch), 1, "under that lease's own epoch");
  });
});

test("14: a bill deleted, or a payment cancelled, after the other computer has them, is gone there too, once", async () => {
  await withOffice(async (office) => {
    const { a, b, cloud } = office;
    produce(a, office, "10");
    const made = await issueGatepass(a, office, 6);
    enterBill(a, office, made.billId ?? "", 3);
    const voucher = entryPayment(a, office, 1000);
    await passAll(cloud, a, b);
    assert.equal(balanceOf(b, office), 2600);
    a.db.updateSaleVoucher(made.billId ?? "", { bookNo: "B9", remarks: "corrected book" });
    await passAll(cloud, a, b);
    assert.equal(b.db.getSaleVoucher(made.billId ?? "")?.bookNo, "B9", "an edit of the bill's header alone travels");
    a.db.deleteSaleVoucher(made.billId ?? "", "wrong rate");
    a.db.deleteCashVoucher(voucher);
    const cancelledAt = (a.db.db.prepare("SELECT deleted_at FROM cash_vouchers WHERE id = ?").get(voucher) as { deleted_at: string }).deleted_at;
    a.db.deleteCashVoucher(voucher);
    assert.equal((a.db.db.prepare("SELECT deleted_at FROM cash_vouchers WHERE id = ?").get(voucher) as { deleted_at: string }).deleted_at, cancelledAt, "a second cancel changes nothing");
    await passAll(cloud, a, b);
    assert.equal(balanceOf(b, office), 0, "the other computer no longer counts either");
    assert.equal(b.db.db.prepare("SELECT status FROM gatepasses").get()?.status, "CREATED", "and its gatepass is open again there too");
    assertSameEverywhere(office);
  });
});

test("15: raw material replicates and moves as before, and these writes do not touch it", async () => {
  await withOffice(async (office) => {
    const { a, b, cloud } = office;
    const hash = (pc: Pc) => JSON.stringify(["inventory_stock_events", "inventory_stock_balances", "raw_material_qrs", "raw_material_qr_events", "raw_material_qr_batches"].map((table) => [table, count(pc, table)]));
    const before = [hash(a), hash(b)];
    produce(a, office, "10");
    const made = await issueGatepass(a, office, 6);
    enterBill(a, office, made.billId ?? "", 3);
    entryPayment(a, office, 1000);
    await passAll(cloud, a, b);
    assert.deepEqual([hash(a), hash(b)], before);
  });
});

test("carton QR is out of the way: a bill with QR cartons out on it cannot reverse them while it is on hold", async () => {
  await withOffice(async (office) => {
    const { a } = office;
    produce(a, office, "10");
    const made = await issueGatepass(a, office, 6);
    enterBill(a, office, made.billId ?? "", 3);
    assert.equal(count(a, "carton_stock_events", "event_type = 'GATEPASS_ISSUE'"), 1, "the whole line left as a movement, none reserved for scanners");
    const session = (a.db.db.prepare("SELECT id FROM dispatch_sessions").get() as { id: string }).id;
    const original = a.db.listDispatchedEventsForSession.bind(a.db);
    a.db.listDispatchedEventsForSession = (() => [{ id: "e1" }]) as never;
    try {
      assert.throws(() => a.db.deleteSaleVoucher(made.billId ?? ""), /carton QR is on hold/);
      assert.equal(balanceOf(a, office), 3600, "nothing changed");
    } finally {
      a.db.listDispatchedEventsForSession = original;
    }
    assert.ok(session);
  });
});
