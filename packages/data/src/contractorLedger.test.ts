// Contractor Ledger against a real database, fed by the real chain:
//
//   machine program (machine contractor A, packing contractor B) → carton labels printed
//     → Store In scans cartons back → A earns the machine rate, B the packing rate,
//       and the printing ledger the printing rate — per DOZEN, two cartons to the dozen
//
// Every step goes through the same use case or repository method the screens use.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AssignMachineContractorUseCase,
  InMemoryEventBus,
  ReceiveMachineProgramCartonUseCase,
  SaveMachineProgramArticleRatesUseCase,
  SaveMachineProgramFixRunUseCase,
} from "@erp/application";
import { PRINTING_CONTRACTOR_ACCOUNT_ID, businessDateOf, toPaisa } from "@erp/domain";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { UuidGenerator } from "./idGenerator.js";

const CONTEXT = { factoryId: "factory-1", workstationId: "workstation-1", deviceId: "device-1" };
const ACTOR = "aslam";

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-contractor-ledger-"));
  const db = new SqliteDatabase({ dbPath: path.join(tempDir, "erp.db"), schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  db.ensureOperationalContext({
    factoryId: "factory-1", factoryCode: "F001", factoryName: "Factory",
    workstationId: "workstation-1", workstationCode: "WS001", workstationName: "WS",
    deviceId: "device-1", deviceName: "Device", appVersion: "1.0.0",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- direct schema access for assertions
  const raw = (db as any).db;
  const deps = { txManager: db, repo: db, eventPublisher: new InMemoryEventBus(), idGenerator: new UuidGenerator() };

  const unitId = db.createInventoryUnit({ code: "DOZEN", name: "Dozen", unitFamily: "COUNT" });
  const machine = db.createMachine({ name: "Machine 1", sectionId: db.createWorkSection({ name: "Packing" }).id });
  const party = (partyName: string, mobile: string) =>
    db.createParty({ partyName, partyType: "CONTRACTOR", city: "Lahore", mobileNumber: mobile, status: "ACTIVE" });
  const machineContractor = party("ALAMGIR", "0300-1111111");
  const packingContractor = party("DANIYAL", "0300-2222222");

  // A FIX article: no upper, so a program can be made and its cartons printed without stock.
  // Its STANDARD rates: machine 70, packing 20, printing 5 per DOZEN.
  const group = db.createProductGroup({ groupName: "GENTS" });
  const fix = db.createProductSubGroup({ productGroupId: group, name: "EVR FIX", hasNoUpper: true });
  db.createProduct({ article: "EVR9", size: "7/10", sellingPrice: 550, machineRate: 70, packingRate: 20, printingRate: 5, productGroupId: group, productSubGroupId: fix });
  const evr9 = (raw.prepare("SELECT id FROM article_sizes WHERE article = 'EVR9'").get() as { id: string }).id;

  const dana = db.createInventoryCategory({ name: "DANA" });
  const eva = db.createInventoryCategory({ name: "EVA", parentId: dana });
  db.addInventoryCategoryField({ categoryId: eva, fieldKey: "color", label: "COLOR", fieldType: "TEXT", required: true, sortOrder: 1 });
  for (const color of ["BLACK", "WHITE"]) db.createInventoryItem({ categoryId: eva, values: { color }, unitId });

  const cartonIn = new ReceiveMachineProgramCartonUseCase({
    txManager: db, duplicateChecker: db, qrRegistry: db, productCatalog: db, qrMasterRepo: db,
    productionEventsRepo: db, stockProjectionRepo: db, outboxRepo: db, qrLookupRepo: db, gatepassRepo: db,
    storeEntryEventsRepo: db, cartonOriginRepo: db, eventPublisher: new InMemoryEventBus(), idGenerator: new UuidGenerator(),
  });

  /** Today's program for 10 DOZEN of EVR9, with its 20 carton labels printed. Returns the carton QRs. */
  const programWithCartons = async (programDate: string): Promise<{ programId: string; cartons: string[] }> => {
    await new AssignMachineContractorUseCase(deps).execute({ machineId: machine.id, role: "MACHINE", contractorPartyId: machineContractor, actor: ACTOR });
    await new AssignMachineContractorUseCase(deps).execute({ machineId: machine.id, role: "PACKING", contractorPartyId: packingContractor, actor: ACTOR });
    const saved = await new SaveMachineProgramFixRunUseCase(deps).execute({
      machineId: machine.id, programDate, soleColour: "WHITE", innerSoleColour: "BLACK", articleSizeId: evr9, quantity: 10, actor: ACTOR,
    });
    assert.equal(saved.accepted, true, saved.reason);
    const programId = db.getMachineProgramForDate(machine.id, programDate)!.id;
    const [run] = db.listMachineProgramFixCartonRuns(programId);
    const printed = db.printMachineProgramFixCartons({ programId, runId: run.runId, printedBy: ACTOR, deviceId: "device-1" });
    return { programId, cartons: printed.qrCodes.map((qr) => qr.id) };
  };

  const scanIn = async (programId: string, cartons: string[]) => {
    for (const rawScan of cartons) {
      const result = await cartonIn.execute({ programId, rawScan, context: CONTEXT, actor: ACTOR });
      assert.equal(result.outcome, "RECEIVED", result.reason);
    }
  };

  const today = businessDateOf(new Date().toISOString());
  const ledger = (accountId: string, fromDate = today, toDate = today) => db.getContractorLedger(accountId, { fromDate, toDate });

  return {
    db, raw, evr9, machineContractor, packingContractor, today, programWithCartons, scanIn, ledger,
    priceProgram: (programId: string, rates: { machine: number; packing: number; printing: number }) =>
      new SaveMachineProgramArticleRatesUseCase(deps).execute({
        programId, articleSizeId: evr9, machineRate: rates.machine, packingRate: rates.packing, printingRate: rates.printing, actor: ACTOR,
      }),
    cleanup: () => {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

type Fixture = ReturnType<typeof createFixture>;

const withFixture = async (body: (f: Fixture) => Promise<void>) => {
  const f = createFixture();
  try {
    await body(f);
  } finally {
    f.cleanup();
  }
};

test("cartons Store In received are each contractor's work, at the product's rate when the program was not priced", async () => {
  await withFixture(async (f) => {
    const { programId, cartons } = await f.programWithCartons(f.today);
    // 20 cartons printed, 8 back: only what came back is work.
    await f.scanIn(programId, cartons.slice(0, 8));

    const machine = f.ledger(f.machineContractor);
    assert.equal(machine.dozens, 4);
    assert.equal(machine.earnedPaisa, toPaisa(280), "4 DOZEN × Rs 70");
    const [day] = machine.entries;
    assert.equal(day.kind, "WORK");
    if (day.kind !== "WORK") return;
    assert.equal(day.date, f.today);
    assert.deepEqual(
      day.work.lines.map((line) => [line.programCode, line.role, line.article, line.cartons, line.dozens, line.ratePaisa, line.rateSource, line.amountPaisa]),
      [["MP-000001", "MACHINE", "EVR9", 8, 4, 7000, "PRODUCT", 28000]]
    );

    assert.equal(f.ledger(f.packingContractor).earnedPaisa, toPaisa(80), "4 DOZEN × Rs 20 to the packing contractor");
    assert.equal(f.ledger(PRINTING_CONTRACTOR_ACCOUNT_ID).earnedPaisa, toPaisa(20), "4 DOZEN × Rs 5 on the printing ledger");
  });
});

test("the program's own agreed rate wins over the product's standard", async () => {
  await withFixture(async (f) => {
    const { programId, cartons } = await f.programWithCartons(f.today);
    const priced = await f.priceProgram(programId, { machine: 80, packing: 25, printing: 0 });
    assert.equal(priced.accepted, true, priced.reason);
    await f.scanIn(programId, cartons.slice(0, 4));

    const machine = f.ledger(f.machineContractor);
    assert.equal(machine.earnedPaisa, toPaisa(160), "2 DOZEN × Rs 80");
    const line = machine.entries[0].kind === "WORK" ? machine.entries[0].work.lines[0] : null;
    assert.equal(line?.rateSource, "PROGRAM");
    assert.equal(f.ledger(PRINTING_CONTRACTOR_ACCOUNT_ID).earnedPaisa, 0, "printing agreed at 0 is not paid — and is not 'unpriced'");
    assert.equal(f.ledger(PRINTING_CONTRACTOR_ACCOUNT_ID).unpricedDozens, 0);
  });
});

test("a cash payment to the contractor comes off the balance; earlier work is the opening balance", async () => {
  await withFixture(async (f) => {
    const { programId, cartons } = await f.programWithCartons(f.today);
    await f.scanIn(programId, cartons.slice(0, 6));
    // Two of those cartons came in on 1 Oct (moved back in time, as if scanned then).
    f.raw
      .prepare(`UPDATE production_events SET event_ts_local = '2026-10-01T06:00:00.000Z'
                 WHERE qr_id IN (?, ?) AND json_extract(metadata_json, '$.eventType') = 'STORE_ENTRY'`)
      .run(cartons[0], cartons[1]);
    f.db.createCashVoucher({ partyId: f.machineContractor, voucherDate: f.today, description: "Weekly payment", modeOfTransfer: "Cash", paymentAmount: 100 });

    const ledger = f.ledger(f.machineContractor, "2026-10-02", f.today);
    assert.equal(ledger.openingBalancePaisa, toPaisa(70), "1 DOZEN on 1 Oct × Rs 70");
    assert.deepEqual(ledger.entries.map((entry) => [entry.kind, entry.creditPaisa, entry.debitPaisa, entry.balancePaisa]), [
      ["WORK", toPaisa(140), 0, toPaisa(210)],
      ["PAYMENT", 0, toPaisa(100), toPaisa(110)],
    ]);
    assert.equal(ledger.closingBalancePaisa, toPaisa(110));
    assert.equal(ledger.paidPaisa, toPaisa(100));
  });
});

test("the accounts list says who is a machine and who is a packing contractor", async () => {
  await withFixture(async (f) => {
    await f.programWithCartons(f.today);
    const accounts = f.db.listContractorLedgerAccounts();
    assert.deepEqual(accounts.map((account) => [account.name, account.roles]), [
      ["ALAMGIR", ["MACHINE"]],
      ["DANIYAL", ["PACKING"]],
    ]);
    assert.throws(() => f.ledger("no-such-party"), /not found/);
    assert.throws(() => f.ledger(f.machineContractor, "2026-10-31", "2026-10-01"), /start date/);
  });
});

// B cartons are NOT paid to any contractor (owner, 2026-10-12). They count as back for the
// program — so it can complete — but never as work on a machine, packing or printing ledger.
test("B cartons never reach a contractor ledger — only the ordinary cartons are paid", async () => {
  await withFixture(async (f) => {
    const { programId, cartons } = await f.programWithCartons(f.today); // 10 DOZEN = 20 labels
    await f.scanIn(programId, cartons.slice(0, 10));
    const runId = f.db.listMachineProgramFixCartonRuns(programId)[0].runId;
    const b = f.db.convertFixCartonsToB({ programId, runId, count: 10, convertedBy: ACTOR, deviceId: "device-1" });
    await f.scanIn(programId, b.qrCodes.map((qr) => qr.id));

    // The program has all 20 back…
    assert.equal(f.db.getMachineProgramReconciliation(programId)!.cartonsBack, 20);

    // …but each ledger pays for the 10 ordinary cartons only: 5 DOZEN.
    const machine = f.ledger(f.machineContractor);
    assert.equal(machine.dozens, 5);
    assert.equal(machine.earnedPaisa, toPaisa(350), "5 DOZEN × Rs 70 — the 10 B cartons earn nothing");
    assert.equal(f.ledger(f.packingContractor).earnedPaisa, toPaisa(100), "5 DOZEN × Rs 20");
    assert.equal(f.ledger(PRINTING_CONTRACTOR_ACCOUNT_ID).dozens, 5);
    const lines = machine.entries.flatMap((entry) => (entry.kind === "WORK" ? entry.work.lines : []));
    assert.ok(lines.every((line) => line.cartons === 10), "no line is made of B cartons");
  });
});
