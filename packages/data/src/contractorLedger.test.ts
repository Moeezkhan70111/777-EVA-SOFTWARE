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
  ReceiveProductionUseCase,
  SaveMachineProgramArticleRatesUseCase,
  SaveMachineProgramFixRunUseCase,
  StoreEntryScanUseCase,
} from "@erp/application";
import { CARTON_GRADE, PRINTING_CONTRACTOR_ACCOUNT_ID, businessDateOf, toPaisa } from "@erp/domain";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { UuidGenerator } from "./idGenerator.js";

const CONTEXT = { factoryId: "factory-1", workstationId: "workstation-1", deviceId: "device-1" };
const ACTOR = "aslam";

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-contractor-ledger-"));
  const db = new SqliteDatabase({ dbPath: path.join(tempDir, "erp.db"), schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  db.setNumberBlock(1, "test");
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
  // The same article with NO rates agreed at all — its cartons are unpriced work, never free work.
  db.createProduct({ article: "EVR7", size: "7/10", sellingPrice: 550, productGroupId: group, productSubGroupId: fix });
  const evr7 = (raw.prepare("SELECT id FROM article_sizes WHERE article = 'EVR7'").get() as { id: string }).id;

  const dana = db.createInventoryCategory({ name: "DANA" });
  const eva = db.createInventoryCategory({ name: "EVA", parentId: dana });
  db.addInventoryCategoryField({ categoryId: eva, fieldKey: "color", label: "COLOR", fieldType: "TEXT", required: true, sortOrder: 1 });
  for (const color of ["BLACK", "WHITE"]) db.createInventoryItem({ categoryId: eva, values: { color }, unitId });

  const cartonIn = new ReceiveMachineProgramCartonUseCase({
    txManager: db, duplicateChecker: db, qrRegistry: db, productCatalog: db, qrMasterRepo: db,
    productionEventsRepo: db, stockProjectionRepo: db, outboxRepo: db, qrLookupRepo: db, gatepassRepo: db,
    storeEntryEventsRepo: db, cartonOriginRepo: db, eventPublisher: new InMemoryEventBus(), idGenerator: new UuidGenerator(),
  });

  // The current workflow's two steps, each the one the screens run: Receive Production records the
  // carton as produced, and Store Move In is what the ledger recognises as the work being done.
  const receiver = new ReceiveProductionUseCase({
    txManager: db, duplicateChecker: db, qrRegistry: db, productCatalog: db, qrMasterRepo: db,
    productionEventsRepo: db, stockProjectionRepo: db, outboxRepo: db,
    eventPublisher: new InMemoryEventBus(), idGenerator: new UuidGenerator(),
  });
  const storeInUseCase = new StoreEntryScanUseCase({
    txManager: db, qrLookupRepo: db, qrRegistry: db, qrMasterRepo: db, storeEntryEventsRepo: db,
    stockProjectionRepo: db, outboxRepo: db, eventPublisher: new InMemoryEventBus(), idGenerator: new UuidGenerator(),
  });

  /** Both contractors on the machine — nothing can open a program for it until they are set. */
  const assignBoth = async () => {
    await new AssignMachineContractorUseCase(deps).execute({ machineId: machine.id, role: "MACHINE", contractorPartyId: machineContractor, actor: ACTOR });
    await new AssignMachineContractorUseCase(deps).execute({ machineId: machine.id, role: "PACKING", contractorPartyId: packingContractor, actor: ACTOR });
  };

  /** Today's program for 10 DOZEN of EVR9, with its 20 carton labels printed. Returns the carton QRs. */
  const programWithCartons = async (programDate: string): Promise<{ programId: string; cartons: string[] }> => {
    await assignBoth();
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

  /**
   * The CURRENT workflow's carton run: a quantity typed into the QR Generator for a machine, which
   * opens that machine's program for the day and stamps it on the run (qr_batches.machine_program_id).
   * No label row is written anywhere — that is the whole difference from `programWithCartons`.
   */
  const generate = async (input: { quantity: number; color?: string; articleSizeId?: string; grade?: "B" }) => {
    await assignBoth();
    const generated = db.generateQrBatch({
      articleSizeId: input.articleSizeId ?? evr9,
      color: input.color ?? "WHITE",
      quantity: input.quantity,
      createdBy: ACTOR,
      machineId: machine.id,
      grade: input.grade ?? null,
    });
    return { batch: generated.batch, programId: generated.program!.id, cartons: generated.qrCodes.map((qr) => qr.id) };
  };

  /** Receive Production: the carton becomes a produced unit. No store entry, so no work yet. */
  const receive = async (cartons: string[]) => {
    for (const rawScan of cartons) {
      const result = await receiver.execute({ rawScan, context: CONTEXT, actor: ACTOR });
      assert.equal(result.outcome, "RECEIVED", result.reason);
    }
  };

  /** Store Move In: the event the ledger recognises. Returns the last outcome, refusals included. */
  const storeIn = async (cartons: string[]) => {
    let last = "";
    for (const rawScan of cartons) {
      last = (await storeInUseCase.execute({ rawScan, context: CONTEXT, actor: ACTOR })).outcome;
    }
    return last;
  };

  const producedAndStored = async (cartons: string[]) => {
    await receive(cartons);
    assert.equal(await storeIn(cartons), "RECEIVED");
  };

  const today = businessDateOf(new Date().toISOString());
  const ledger = (accountId: string, fromDate = today, toDate = today) => db.getContractorLedger(accountId, { fromDate, toDate });
  const workLines = (accountId: string) =>
    ledger(accountId).entries.flatMap((entry) => (entry.kind === "WORK" ? entry.work.lines : []));

  return {
    db, raw, evr9, evr7, machineContractor, packingContractor, today, programWithCartons, scanIn, ledger, workLines,
    generate, receive, storeIn, producedAndStored,
    manual: (color: string, dozens: string) =>
      db.recordManualProduction({
        requestId: crypto.randomUUID(), machineId: machine.id, articleSizeId: evr9, color, dozens,
        storeLocationId: "factory-1", createdBy: ACTOR,
      }),
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

// ─── The QR Generator's own cartons — the current workflow ────────────────────
// A quantity typed into the QR Generator for a machine carries its program on the RUN
// (qr_batches.machine_program_id, migration 078) and writes no carton-label row at all. The ledger
// read program membership from the label tables alone, so these cartons were work nobody was paid
// for. They are paid at the same moment a printed label's carton is: the Store Move In.

test("a QR Generator carton stored in is each contractor's work, exactly as a printed label's is", async () => {
  await withFixture(async (f) => {
    const { cartons, batch } = await f.generate({ quantity: 20 });
    assert.equal(batch.quantity, 20);
    // Generating is not work: the labels exist, nothing has been made or received.
    assert.equal(f.ledger(f.machineContractor).earnedPaisa, 0, "generating the labels earns nothing");
    assert.equal(f.ledger(f.machineContractor).dozens, 0);

    // 20 generated, 8 produced and stored in: only what came in is work — 4 DOZEN.
    await f.producedAndStored(cartons.slice(0, 8));

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

test("Receive Production alone is not work — the store entry is what earns it", async () => {
  await withFixture(async (f) => {
    const { cartons } = await f.generate({ quantity: 2 });

    // Produced, and that is all: a carton in the factory is not a carton the store has taken in.
    await f.receive(cartons);
    assert.equal(f.ledger(f.machineContractor).earnedPaisa, 0, "produced is not received");
    assert.equal(f.ledger(f.machineContractor).entries.length, 0);
    assert.equal(f.ledger(PRINTING_CONTRACTOR_ACCOUNT_ID).earnedPaisa, 0);

    assert.equal(await f.storeIn(cartons), "RECEIVED");
    assert.equal(f.ledger(f.machineContractor).dozens, 1, "2 cartons is 1 DOZEN");
    assert.equal(f.ledger(f.machineContractor).earnedPaisa, toPaisa(70));
  });
});

test("the same carton is never charged twice: a repeat store entry is refused, and a later one never re-dates it", async () => {
  await withFixture(async (f) => {
    const { cartons } = await f.generate({ quantity: 2 });
    await f.producedAndStored(cartons);
    assert.equal(f.ledger(f.machineContractor).earnedPaisa, toPaisa(70));

    // The same scan again, through the same use case: refused, and nothing is added.
    assert.equal(await f.storeIn(cartons), "ALREADY_IN_STORE");
    assert.equal(f.ledger(f.machineContractor).earnedPaisa, toPaisa(70), "a refused re-scan adds nothing");
    assert.deepEqual(f.workLines(f.machineContractor).map((line) => line.cartons), [2]);

    // A second STORE_ENTRY event, as a carton brought back from the gate and taken in again leaves
    // behind. The ledger dates a carton by its FIRST one and counts it once either way.
    f.raw
      .prepare(
        `INSERT INTO production_events (id, qr_id, product_variant_id, event_type, event_ts_local, event_date, event_hour,
           factory_id, workstation_id, operator_id, device_id, article_snapshot, color_snapshot, size_snapshot, serial_snapshot,
           metadata_json, created_at, sync_status, retry_count, source_app)
         SELECT ?, qr_id, product_variant_id, 'MOVED', ?, ?, 9, factory_id, workstation_id, operator_id, device_id,
                article_snapshot, color_snapshot, size_snapshot, serial_snapshot, metadata_json, ?, 'PENDING', 0, source_app
           FROM production_events
          WHERE qr_id = ? AND json_extract(metadata_json, '$.eventType') = 'STORE_ENTRY' LIMIT 1`
      )
      .run(crypto.randomUUID(), `${f.today}T09:00:00.000Z`, f.today, `${f.today}T09:00:00.000Z`, cartons[0]);

    const machine = f.ledger(f.machineContractor);
    assert.equal(machine.earnedPaisa, toPaisa(70), "two store entries for one carton are still one carton of work");
    assert.deepEqual(machine.entries.map((entry) => entry.kind), ["WORK"], "one day, not two");
    assert.deepEqual(f.workLines(f.machineContractor).map((line) => line.cartons), [2]);
  });
});

test("a B carton generated for a machine earns nothing either", async () => {
  await withFixture(async (f) => {
    const b = await f.generate({ quantity: 4, grade: CARTON_GRADE.B });
    assert.equal(b.batch.grade, CARTON_GRADE.B);
    await f.producedAndStored(b.cartons);

    assert.equal(f.ledger(f.machineContractor).earnedPaisa, 0, "no contractor is paid for a B carton");
    assert.equal(f.ledger(f.machineContractor).dozens, 0);
    assert.equal(f.ledger(f.packingContractor).earnedPaisa, 0);
    assert.equal(f.ledger(PRINTING_CONTRACTOR_ACCOUNT_ID).earnedPaisa, 0);
  });
});

test("Manual Production and QR Generator cartons on one program are each counted once", async () => {
  await withFixture(async (f) => {
    // 4 generated for the machine, 2 of them stored in: 1 DOZEN. The run also makes the WHITE
    // colour of EVR9 exist, which is what Manual Production then records against.
    const { cartons } = await f.generate({ quantity: 4 });
    await f.producedAndStored(cartons.slice(0, 2));
    const { entry, duplicate } = f.manual("WHITE", "3");
    assert.equal(duplicate, false);
    assert.equal(entry.cartons, 6, "3 DOZEN typed is 6 cartons");
    assert.equal(entry.programCode, "MP-000001", "both are on the machine's one program for the day");
    assert.equal(f.raw.prepare("SELECT COUNT(*) AS n FROM machine_programs").get().n, 1, "one program, not two");

    // 2 scanned + 6 typed = 8 cartons = 4 DOZEN, on one line for the one program and article.
    const machine = f.ledger(f.machineContractor);
    assert.equal(machine.dozens, 4);
    assert.equal(machine.earnedPaisa, toPaisa(280), "4 DOZEN × Rs 70 — neither source counted twice");
    assert.deepEqual(f.workLines(f.machineContractor).map((line) => [line.programCode, line.cartons, line.dozens]), [["MP-000001", 8, 4]]);
    assert.equal(f.ledger(f.packingContractor).earnedPaisa, toPaisa(80));
  });
});

test("a printed label run and a QR Generator run on one program are each counted once", async () => {
  await withFixture(async (f) => {
    // The legacy route first: it makes the program, and its labels carry no machine_program_id.
    const { programId, cartons: printed } = await f.programWithCartons(f.today);
    await f.scanIn(programId, printed.slice(0, 8));
    assert.equal(f.ledger(f.machineContractor).dozens, 4);

    // Now the current route, on the same machine and day: it joins that same program.
    const generated = await f.generate({ quantity: 2 });
    assert.equal(generated.programId, programId);
    assert.equal(
      f.raw.prepare("SELECT COUNT(*) AS n FROM qr_batches WHERE machine_program_id IS NOT NULL").get().n,
      1,
      "only the generated run carries the program on itself"
    );
    await f.producedAndStored(generated.cartons);

    // 8 printed-and-returned + 2 generated-and-stored = 10 cartons = 5 DOZEN. Neither is lost and
    // neither is doubled, although both resolve to the one program.
    const machine = f.ledger(f.machineContractor);
    assert.equal(machine.dozens, 5);
    assert.equal(machine.earnedPaisa, toPaisa(350), "5 DOZEN × Rs 70");
    assert.deepEqual(f.workLines(f.machineContractor).map((line) => [line.programCode, line.cartons]), [["MP-000001", 10]]);
    assert.equal(f.ledger(PRINTING_CONTRACTOR_ACCOUNT_ID).dozens, 5);
  });
});

test("a product with no rates agreed is unpriced work, never free work", async () => {
  await withFixture(async (f) => {
    const { cartons } = await f.generate({ quantity: 4, articleSizeId: f.evr7, color: "BLACK" });
    await f.producedAndStored(cartons);

    const machine = f.ledger(f.machineContractor);
    assert.equal(machine.dozens, 2, "the work is on the ledger");
    assert.equal(machine.earnedPaisa, 0, "but nothing is owed, because no rate was ever agreed");
    assert.equal(machine.unpricedDozens, 2, "and it is reported as unpriced, not as paid at zero");
    assert.deepEqual(
      f.workLines(f.machineContractor).map((line) => [line.article, line.cartons, line.ratePaisa, line.rateSource, line.amountPaisa]),
      [["EVR7", 4, null, null, 0]]
    );
  });
});
