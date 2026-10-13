// Machine Program against a real database, driven by real scans.
//
//   machine + date → injector → sole run (sole colour, article + size) → upper lines
//
//   Physical    the upper's authoritative balance (inventory_stock_balances), in DOZEN
//   Reserved    Σ over live programs' upper lines of (quantity − scanned out for that line)
//   Available   Physical − Reserved
//
// Stock is built the only way it can be — Raw Material QR Generator → Raw Material Input — and
// consumed the only way it can be — a plain Raw Material Output scan, which the business layer
// counts against the oldest program still owing that upper. A program names no supplier
// (2026-10-07), so any packet of the upper satisfies it. Every figure is read back through the
// same repository the screens use.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AssignMachineContractorUseCase,
  DeleteMachineProgramUseCase,
  InMemoryEventBus,
  IssueRawMaterialScanUseCase,
  ReceiveRawMaterialScanUseCase,
  RemoveMachineProgramLineUseCase,
  RemoveMachineProgramRunUseCase,
  SaveMachineProgramArticleRatesUseCase,
  SaveMachineProgramLineUseCase,
  SaveMachineProgramRunUseCase,
  SetMachineProgramShiftUseCase,
  SetMachineProgramSoleSlotUseCase,
} from "@erp/application";
import {
  MACHINE_PROGRAM_DISPLAY_STATUS,
  MACHINE_PROGRAM_STATUS,
  programContractorPricing,
  toPaisa,
} from "@erp/domain";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { UuidGenerator } from "./idGenerator.js";

const CONTEXT = { factoryId: "factory-1", workstationId: "workstation-1", deviceId: "device-1" };
const ACTOR = "aslam";
const TODAY = "2026-10-04";
const TOMORROW = "2026-10-05";

function createFixture(options: { withDana?: boolean } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-machine-program-"));
  const db = new SqliteDatabase({ dbPath: path.join(tempDir, "erp.db"), schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  db.ensureOperationalContext({
    factoryId: "factory-1", factoryCode: "F001", factoryName: "Factory",
    workstationId: "workstation-1", workstationCode: "WS001", workstationName: "WS",
    deviceId: "device-1", deviceName: "Device", appVersion: "1.0.0",
  });

  const deps = { txManager: db, repo: db, eventPublisher: new InMemoryEventBus(), idGenerator: new UuidGenerator() };
  const useCases = {
    assign: new AssignMachineContractorUseCase(deps),
    saveLine: new SaveMachineProgramLineUseCase(deps),
    saveRun: new SaveMachineProgramRunUseCase(deps),
    removeLine: new RemoveMachineProgramLineUseCase(deps),
    removeRun: new RemoveMachineProgramRunUseCase(deps),
    remove: new DeleteMachineProgramUseCase(deps),
    receive: new ReceiveRawMaterialScanUseCase(deps),
    issue: new IssueRawMaterialScanUseCase(deps),
    priceArticle: new SaveMachineProgramArticleRatesUseCase(deps),
    setShift: new SetMachineProgramShiftUseCase(deps),
    setSoleSlot: new SetMachineProgramSoleSlotUseCase(deps),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- direct schema access for assertions
  const raw = (db as any).db;

  const unitId = db.createInventoryUnit({ code: "DOZEN", name: "Dozen", unitFamily: "COUNT" });
  // The machines stand in PACKING and the store sends uppers to PACKING — as in the live store.
  const packing = db.createWorkSection({ name: "Packing" });
  const upperMaker = db.createWorkSection({ name: "Upper Maker" });
  const machine1 = db.createMachine({ name: "Machine 1", sectionId: packing.id });
  const machine2 = db.createMachine({ name: "Machine 2", sectionId: packing.id });

  const party = (partyName: string, partyType: string, mobile: string) =>
    db.createParty({ partyName, partyType, city: "Lahore", mobileNumber: mobile, status: "ACTIVE" });
  const contractorA = party("CONTRACTOR A", "CONTRACTOR", "0300-1111111");
  const contractorB = party("CONTRACTOR B", "CONTRACTOR", "0300-2222222");
  const supplierA = party("ABC UPPER", "SUPPLIER", "0300-3333333");
  const supplierB = party("XYZ UPPER", "SUPPLIER", "0300-4444444");

  // Product Master.
  const articleSize = (article: string, size: string): string => {
    db.createProduct({ article, size, sellingPrice: 550, status: "ACTIVE" });
    return (raw.prepare("SELECT id FROM article_sizes WHERE article = ? AND size = ?").get(article, size) as { id: string }).id;
  };
  const sk6_710 = articleSize("SK6", "7/10");
  const sk6_46 = articleSize("SK6", "4/6");
  const sk6_13 = articleSize("SK6", "1/3");

  // UPPER — RAGZINE UPPER: article, colour, size, type. Packed in PACKETs, routed to PACKING.
  const upper = db.createInventoryCategory({ name: "UPPER" });
  const ragzine = db.createInventoryCategory({ name: "RAGZINE UPPER", parentId: upper });
  ["article", "color", "size", "type"].forEach((fieldKey, index) =>
    db.addInventoryCategoryField({ categoryId: ragzine, fieldKey, label: fieldKey.toUpperCase(), fieldType: "TEXT", required: fieldKey !== "type", sortOrder: index + 1 })
  );
  const makeUpper = (article: string, color: string, size: string, sectionId = packing.id) => {
    const { id } = db.createInventoryItem({ categoryId: ragzine, values: { article, color, size, type: "SILAI" }, unitId });
    db.setRawMaterialMovementConfig(id, { packName: "PACKET", packingQuantity: 5, packingUnitId: unitId});
    return id;
  };
  const black = makeUpper("SK6", "BLACK", "7/10");
  const green = makeUpper("SK6", "GREEN", "7/10");
  // The upper SK6 4/6 AND SK6 1/3 are both made with: one 1/6 upper covers both size ranges.
  const black16 = makeUpper("SK6", "BLACK", "1/6");
  const blueElsewhere = makeUpper("SK6", "BLUE", "7/10", upperMaker.id);

  // DANA — EVA: colour only.
  let danaBlack: string | null = null;
  if (options.withDana !== false) {
    const dana = db.createInventoryCategory({ name: "DANA" });
    const eva = db.createInventoryCategory({ name: "EVA", parentId: dana });
    db.addInventoryCategoryField({ categoryId: eva, fieldKey: "color", label: "COLOR", fieldType: "TEXT", required: true, sortOrder: 1 });
    const makeDana = (color: string) => {
      const { id } = db.createInventoryItem({ categoryId: eva, values: { color }, unitId });
      db.setRawMaterialMovementConfig(id, { packName: "BAG", packingQuantity: 25, packingUnitId: unitId});
      return id;
    };
    danaBlack = makeDana("BLACK");
    makeDana("RED");
  }

  /** Prints `count` labels of `perPacket` DOZEN from a supplier and receives every one into the store. */
  const stockIn = async (itemId: string, count: number, partyId: string, perPacket = 5): Promise<string[]> => {
    const session = db.startRawMaterialReceivingSession({ partyId, deviceId: "device-1", startedBy: ACTOR });
    const qrIds = db.generateRawMaterialQrBatch({ partyId, itemId, quantity: count, packingQuantity: perPacket }).qrCodes.map((qr) => qr.id);
    for (const qrId of qrIds) {
      const result = await useCases.receive.execute({ rawScan: qrId, partyId, sessionId: session.id, context: CONTEXT, actor: ACTOR });
      assert.equal(result.outcome, "RECEIVED", `${qrId} should have been received`);
    }
    db.closeRawMaterialReceivingSession(session.id);
    return qrIds;
  };

  /** Dana is never labelled: it comes in loose and is moved in by hand, in its own stock unit. */
  const danaIn = (itemId: string, quantity: number, partyId: string) => {
    const unitCode = db.inventoryItemStockUnit(itemId)?.code ?? "DOZEN";
    const moved = db.moveRawMaterialByHand({ itemId, direction: "IN", quantity, unitCode, partyId, actor: ACTOR });
    assert.equal(moved.outcome, "MOVED", moved.reason);
  };

  /** A plain Raw Material Output scan — the storekeeper names no program. */
  const issueOut = async (qrId: string) => {
    const session = db.startOrResumeRawMaterialIssueSession({ deviceId: "device-1", startedBy: ACTOR });
    return useCases.issue.execute({ rawScan: qrId, sessionId: session.id, context: CONTEXT, actor: ACTOR });
  };

  const bringBack = async (qrId: string, partyId: string) => {
    const session = db.startRawMaterialReceivingSession({ partyId, deviceId: "device-1", startedBy: ACTOR });
    return useCases.receive.execute({ rawScan: qrId, partyId, sessionId: session.id, context: CONTEXT, actor: ACTOR });
  };

  /** One upper as the program screen shows it for an article + size. */
  const upperFor = (machineId: string, itemId: string, articleSizeId = sk6_710) => {
    const row = db.listMachineProgramUppers(machineId, articleSizeId).find((candidate) => candidate.itemId === itemId);
    assert.ok(row, "the upper should be offered for this article and size");
    return row;
  };

  const assignContractor = (machineId: string, contractorPartyId: string, role: "MACHINE" | "PACKING" = "MACHINE") =>
    useCases.assign.execute({ machineId, role, contractorPartyId, actor: ACTOR });

  /** Both of a machine's contractors at once — what a machine needs before it can be programmed. */
  const assignBothContractors = async (machineId: string, contractorPartyId: string, packerPartyId: string) => {
    await assignContractor(machineId, contractorPartyId, "MACHINE");
    return assignContractor(machineId, packerPartyId, "PACKING");
  };

  /** Adds an upper to a NEW sole run on a machine's injector for a date. */
  const addToNewRun = (input: { machineId: string; date?: string; injectorNo?: number; articleSizeId?: string; soleColour?: string; itemId: string; quantity: number }) =>
    useCases.saveLine.execute({
      machineId: input.machineId,
      programDate: input.date ?? TODAY,
      injectorNo: input.injectorNo ?? 1,
      run: { soleColour: input.soleColour ?? "BLACK", articleSizeId: input.articleSizeId ?? sk6_710 },
      itemId: input.itemId,
      quantity: input.quantity,
      actor: ACTOR,
    });

  /** Adds or changes an upper on a run that already exists. */
  const saveOnRun = (input: { machineId: string; runId: string; lineId?: string; itemId: string; quantity: number; injectorNo?: number }) =>
    useCases.saveLine.execute({
      machineId: input.machineId,
      programDate: TODAY,
      injectorNo: input.injectorNo ?? 1,
      runId: input.runId,
      lineId: input.lineId ?? null,
      itemId: input.itemId,
      quantity: input.quantity,
      actor: ACTOR,
    });

  const balanceOf = (itemId: string): number =>
    Number((raw.prepare("SELECT quantity_on_hand AS q FROM inventory_stock_balances WHERE item_id = ?").get(itemId) as { q: number } | undefined)?.q ?? 0);

  /** Prices one article's work on a program — machine, packing and printing per DOZEN, in rupees. */
  const price = (input: { programId: string; articleSizeId?: string; machine: number; packing: number; printing: number }) =>
    useCases.priceArticle.execute({
      programId: input.programId,
      articleSizeId: input.articleSizeId ?? sk6_710,
      machineRate: input.machine,
      packingRate: input.packing,
      printingRate: input.printing,
      actor: ACTOR,
    });

  /** Times one sole colour on one injector — "BLACK runs 06:00 to 10:00". */
  const timeSole = (input: {
    programId: string;
    injectorNo?: number;
    soleColour?: string;
    slot: { startMinute: number; endMinute: number } | null;
  }) =>
    useCases.setSoleSlot.execute({
      programId: input.programId,
      injectorNo: input.injectorNo ?? 1,
      soleColour: input.soleColour ?? "BLACK",
      slot: input.slot,
      actor: ACTOR,
    });

  /** The hours stored against every run, straight from the table. */
  const runSlots = (programId: string) =>
    raw
      .prepare(
        `SELECT injector_no, sole_colour, article_size_id, start_minute, end_minute FROM machine_program_runs
          WHERE program_id = ? ORDER BY injector_no, run_no`
      )
      .all(programId) as Array<{
      injector_no: number; sole_colour: string; article_size_id: string; start_minute: number | null; end_minute: number | null;
    }>;

  /** Every rate row stored for a program, straight from the table. */
  const rateRows = (programId: string) =>
    raw
      .prepare(
        "SELECT article_size_id, machine_rate_paisa, packing_rate_paisa, printing_rate_paisa FROM machine_program_article_rates WHERE program_id = ?"
      )
      .all(programId) as Array<{ article_size_id: string; machine_rate_paisa: number; packing_rate_paisa: number; printing_rate_paisa: number }>;

  return {
    db, raw, unitId, ...useCases, machine1, machine2, contractorA, contractorB, supplierA, supplierB, assignBothContractors,
    sk6_710, sk6_46, sk6_13, black, green, black16, blueElsewhere, danaBlack,
    stockIn, danaIn, issueOut, bringBack, upperFor, assignContractor, addToNewRun, saveOnRun, balanceOf, price, rateRows,
    timeSole, runSlots,
    cleanup: () => {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

type Fixture = ReturnType<typeof createFixture>;

const withFixture = async (body: (f: Fixture) => Promise<void>, options: { withDana?: boolean } = {}) => {
  const f = createFixture(options);
  try {
    await body(f);
  } finally {
    f.cleanup();
  }
};

/**
 * Both machines get BOTH their contractors, and the store gets 10 packets of 5 DOZEN of BLACK
 * from ABC. A machine cannot be programmed until it has a machine contractor AND a packing one.
 */
const readyToProgram = async (f: Fixture) => {
  await f.assignBothContractors(f.machine1.id, f.contractorA, f.contractorB);
  await f.assignBothContractors(f.machine2.id, f.contractorB, f.contractorA);
  return f.stockIn(f.black, 10, f.supplierA);
};

// ─── The machine's contractor ─────────────────────────────────────────────────

test("a machine's two contractors are set once and stay until they are changed", async () => {
  await withFixture(async (f) => {
    const assigned = await f.assignBothContractors(f.machine1.id, f.contractorA, f.contractorB);
    assert.equal(assigned.outcome, "ASSIGNED");

    const machine = f.db.listMachines().find((row) => row.id === f.machine1.id);
    assert.equal(machine?.contractorName, "CONTRACTOR A");
    assert.equal(machine?.packingContractorName, "CONTRACTOR B", "the packing contractor is its own assignment");
    assert.equal(f.db.listMachineProgramBoard(TODAY).find((row) => row.machine.id === f.machine1.id)?.machine.contractorName, "CONTRACTOR A");
    assert.equal(f.db.listMachineProgramBoard(TOMORROW).find((row) => row.machine.id === f.machine1.id)?.machine.contractorName, "CONTRACTOR A", "every date shows the same contractor");
  });
});

test("only an active party of type Contractor can be put on a machine", async () => {
  await withFixture(async (f) => {
    const supplier = await f.assignContractor(f.machine1.id, f.supplierA);
    assert.equal(supplier.outcome, "NOT_A_CONTRACTOR");
    assert.equal(f.db.listMachines().find((row) => row.id === f.machine1.id)?.contractorPartyId, null);
  });
});

test("a machine with no contractor cannot be programmed", async () => {
  await withFixture(async (f) => {
    await f.stockIn(f.black, 2, f.supplierA);
    const result = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 5 });
    assert.equal(result.outcome, "NO_CONTRACTOR");
    assert.equal(f.db.getMachineProgramForDate(f.machine1.id, TODAY), null, "nothing half-made is left behind");
  });
});

test("a machine with nobody to PACK for it cannot be programmed either", async () => {
  await withFixture(async (f) => {
    await f.stockIn(f.black, 2, f.supplierA);
    await f.assignContractor(f.machine1.id, f.contractorA, "MACHINE");

    const result = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 5 });
    assert.equal(result.outcome, "NO_PACKING_CONTRACTOR");
    assert.equal(f.db.getMachineProgramForDate(f.machine1.id, TODAY), null, "nothing half-made is left behind");

    await f.assignContractor(f.machine1.id, f.contractorB, "PACKING");
    const second = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 5 });
    assert.equal(second.outcome, "SAVED");
  });
});

test("a program snapshots BOTH contractors, and changing either never rewrites a saved one", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 5 });

    const saved = f.db.getMachineProgramForDate(f.machine1.id, TODAY);
    assert.equal(saved?.contractorName, "CONTRACTOR A");
    assert.equal(saved?.packingContractorName, "CONTRACTOR B");

    // Swap only who packs, and program tomorrow.
    await f.assignContractor(f.machine1.id, f.contractorA, "PACKING");
    await f.addToNewRun({ machineId: f.machine1.id, date: TOMORROW, itemId: f.black, quantity: 5 });

    assert.equal(f.db.getMachineProgramForDate(f.machine1.id, TODAY)?.packingContractorName, "CONTRACTOR B", "today keeps the pair it was made with");
    assert.equal(f.db.getMachineProgramForDate(f.machine1.id, TOMORROW)?.packingContractorName, "CONTRACTOR A");
    assert.equal(f.db.getMachineProgramForDate(f.machine1.id, TOMORROW)?.contractorName, "CONTRACTOR A", "the machine contractor was not touched");
  });
});

test("changing the contractor changes future programs and never a saved one", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 5 });

    await f.assignContractor(f.machine1.id, f.contractorB);
    await f.addToNewRun({ machineId: f.machine1.id, date: TOMORROW, itemId: f.black, quantity: 5 });

    assert.equal(f.db.getMachineProgramForDate(f.machine1.id, TODAY)?.contractorName, "CONTRACTOR A", "the saved program keeps its contractor");
    assert.equal(f.db.getMachineProgramForDate(f.machine1.id, TOMORROW)?.contractorName, "CONTRACTOR B");
  });
});

// ─── Dates and injectors ─────────────────────────────────────────────────────

test("programs are per date: a second date is a second program, the same date adds to the first", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    const first = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 5 });
    const sameDay = await f.addToNewRun({ machineId: f.machine1.id, injectorNo: 2, itemId: f.black, quantity: 5 });
    const nextDay = await f.addToNewRun({ machineId: f.machine1.id, date: TOMORROW, itemId: f.black, quantity: 5 });

    assert.equal(sameDay.programId, first.programId, "the same date opens the program already there");
    assert.notEqual(nextDay.programId, first.programId);
    assert.equal(f.db.getMachineProgramForDate(f.machine1.id, TODAY)?.runs.length, 2);
    assert.equal(f.db.getMachineProgramForDate(f.machine1.id, TOMORROW)?.runs.length, 1);
    assert.equal(f.raw.prepare("SELECT COUNT(1) AS n FROM machine_programs").get().n, 2);
  });
});

test("the database itself refuses a second live program for one machine and date", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 5 });
    assert.throws(() =>
      f.raw
        .prepare(
          `INSERT INTO machine_programs (id, program_number, machine_id, contractor_party_id, machine_name_snapshot, contractor_name_snapshot,
             program_date, status, layout, created_at, updated_at) VALUES ('dup', 99, ?, ?, 'M', 'C', ?, 'PROGRAMMED', 'INJECTORS', 'x', 'x')`
        )
        .run(f.machine1.id, f.contractorA, TODAY)
    );
  });
});

test("injector 1 and injector 2 are programmed independently, each with several soles", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    await f.stockIn(f.black16, 4, f.supplierA);
    await f.addToNewRun({ machineId: f.machine1.id, injectorNo: 1, itemId: f.black, quantity: 10 });
    await f.addToNewRun({ machineId: f.machine1.id, injectorNo: 1, articleSizeId: f.sk6_46, soleColour: "RED", itemId: f.black16, quantity: 5 });
    await f.addToNewRun({ machineId: f.machine1.id, injectorNo: 2, itemId: f.black, quantity: 15 });

    const program = f.db.getMachineProgramForDate(f.machine1.id, TODAY);
    const injector1 = program?.runs.filter((run) => run.injectorNo === 1) ?? [];
    const injector2 = program?.runs.filter((run) => run.injectorNo === 2) ?? [];
    assert.deepEqual(injector1.map((run) => [run.runNo, run.soleColour, run.size]), [[1, "BLACK", "7/10"], [2, "RED", "4/6"]]);
    assert.deepEqual(injector2.map((run) => run.totalQuantity), [15]);
    assert.equal(program?.totalQuantity, 30);

    const bad = await f.addToNewRun({ machineId: f.machine1.id, injectorNo: 3, itemId: f.black, quantity: 1 });
    assert.equal(bad.outcome, "INVALID_INJECTOR", "a machine has exactly two injectors");
  });
});

// ─── Sole colour, Dana ────────────────────────────────────────────────────────

test("the sole colour and the article are checked against the masters", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    const base = { machineId: f.machine1.id, programDate: TODAY, injectorNo: 1, itemId: f.black, quantity: 5, actor: ACTOR };
    const noColour = await f.saveLine.execute({ ...base, run: { soleColour: "PURPLE", articleSizeId: f.sk6_710 } });
    assert.equal(noColour.outcome, "UNKNOWN_COLOUR");
    const noArticle = await f.saveLine.execute({ ...base, run: { soleColour: "BLACK", articleSizeId: "nope" } });
    assert.equal(noArticle.outcome, "ARTICLE_NOT_FOUND");
    const saved = await f.saveLine.execute({ ...base, run: { soleColour: "BLACK", articleSizeId: f.sk6_710 } });
    assert.equal(saved.outcome, "SAVED", "a run is the sole colour, the article and the size — nothing else is asked for");
  });
});

test("a saved run names no sole type at all", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    const line = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 5 });
    const stored = f.raw.prepare("SELECT sole_type_id, sole_colour FROM machine_program_runs WHERE id = ?").get(line.runId!);
    assert.equal(stored.sole_type_id, null, "the column is kept for the runs made before 2026-10-07, and never written again");
    assert.equal(stored.sole_colour, "BLACK");
  });
});

test("sole colours come from the Dana in the store, with how much of it there is", async () => {
  await withFixture(async (f) => {
    f.danaIn(f.danaBlack!, 100, f.supplierA);
    const options = f.db.listSoleColourOptions();
    assert.deepEqual(options.map((option) => option.colour), ["BLACK", "RED"]);
    assert.equal(options[0].danaQuantity, 100);
    assert.equal(options[0].danaUnitCode, "DOZEN");

    const dana = f.db.listMachineProgramDana("black");
    assert.equal(dana.length, 1);
    // Loose Dana carries no labels, so there are no packets to count — only what is on the shelf.
    assert.deepEqual(dana[0].sources.map((source) => [source.packets, source.physical]), [[null, 100]]);
    assert.equal(f.db.listMachineProgramDana("RED").length, 0, "a colour with no Dana in the store has none to show");
  });
});

test("with no Dana set up, every colour the store knows is offered", async () => {
  await withFixture(
    async (f) => {
      const options = f.db.listSoleColourOptions();
      assert.deepEqual(options.map((option) => option.colour), ["BLACK", "BLUE", "GREEN"]);
      assert.ok(options.every((option) => !option.hasDana));
    },
    { withDana: false }
  );
});

// ─── Articles and uppers ─────────────────────────────────────────────────────

test("articles and sizes come from the Product Master", async () => {
  await withFixture(async (f) => {
    const articles = f.db.listMachineProgramArticles();
    assert.deepEqual(articles.map((article) => [article.article, article.sizes.map((size) => size.size)]), [["SK6", ["1/3", "4/6", "7/10"]]]);
  });
});

test("every colour of an upper for the article and size is offered, whoever supplied it", async () => {
  await withFixture(async (f) => {
    await f.stockIn(f.black, 10, f.supplierA);
    await f.stockIn(f.black, 6, f.supplierB);
    await f.stockIn(f.green, 4, f.supplierA);
    await f.stockIn(f.black16, 4, f.supplierA);
    f.db.adjustInventoryStock({ itemId: f.green, quantity: 7, unitId: f.unitId, note: "Opening stock" });

    const uppers = f.db.listMachineProgramUppers(f.machine1.id, f.sk6_710);
    assert.deepEqual(uppers.map((row) => row.colour), ["BLACK", "GREEN"], "the 1/6 upper is for 4/6 and 1/3, and BLUE has nothing in the store");

    // One figure per upper: two suppliers' BLACK is one pile of BLACK as far as a program cares.
    const black = f.upperFor(f.machine1.id, f.black);
    assert.deepEqual([black.physical, black.reserved, black.available], [80, 0, 80], "50 from ABC and 30 from XYZ");

    // Opening stock has no label and so no supplier, and counts towards the upper all the same.
    const green = f.upperFor(f.machine1.id, f.green);
    assert.deepEqual([green.physical, green.available], [27, 27], "20 labelled plus 7 counted in the store");
  });
});

// ─── One upper for two size ranges ───────────────────────────────────────────
//
// An upper is not cut in every size range a sole is moulded in: ONE 1/6 upper is cut for both
// the 1/3 and the 4/6 soles, for every article (owner, 2026-10-13). A program for either size
// must therefore find, reserve and be saved against that 1/6 upper.

test("4/6 and 1/3 are both offered the 1/6 upper, and 7/10 is not", async () => {
  await withFixture(async (f) => {
    await f.stockIn(f.black16, 4, f.supplierA);
    await f.stockIn(f.black, 4, f.supplierA);

    const for46 = f.db.listMachineProgramUppers(f.machine1.id, f.sk6_46);
    const for13 = f.db.listMachineProgramUppers(f.machine1.id, f.sk6_13);
    const for710 = f.db.listMachineProgramUppers(f.machine1.id, f.sk6_710);

    assert.deepEqual(for46.map((row) => row.itemId), [f.black16], "SK6 4/6 is made with the SK6 1/6 upper");
    assert.deepEqual(for13.map((row) => row.itemId), [f.black16], "and so is SK6 1/3 — the same pile");
    assert.deepEqual(for710.map((row) => row.itemId), [f.black], "7/10 wears its own 7/10 upper");
  });
});

test("a 4/6 run is saved against the 1/6 upper, and the two sizes draw on one pile", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    await f.stockIn(f.black16, 4, f.supplierA); // 4 packets of 5 = 20

    const on46 = await f.addToNewRun({ machineId: f.machine1.id, injectorNo: 1, articleSizeId: f.sk6_46, itemId: f.black16, quantity: 12 });
    assert.equal(on46.outcome, "SAVED");

    // What 4/6 promised is gone from what 1/3 may promise: it is one upper, not two.
    const for13 = f.db.listMachineProgramUppers(f.machine1.id, f.sk6_13).find((row) => row.itemId === f.black16);
    assert.deepEqual([for13?.physical, for13?.reserved, for13?.available], [20, 12, 8]);

    const on13 = await f.addToNewRun({ machineId: f.machine1.id, injectorNo: 2, articleSizeId: f.sk6_13, itemId: f.black16, quantity: 8 });
    assert.equal(on13.outcome, "SAVED");
    const over = await f.addToNewRun({ machineId: f.machine1.id, injectorNo: 2, articleSizeId: f.sk6_13, soleColour: "RED", itemId: f.black16, quantity: 1 });
    assert.equal(over.outcome, "NOT_ENOUGH_STOCK", "the 1/6 pile is fully promised across both sizes");
  });
});

// ─── Reservation, not movement ────────────────────────────────────────────────

test("a program reserves uppers and moves no stock at all", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    const eventsBefore = f.raw.prepare("SELECT COUNT(1) AS n FROM inventory_stock_events").get().n;
    const inStoreBefore = f.raw.prepare("SELECT COUNT(1) AS n FROM raw_material_qrs WHERE current_status = 'IN_STORE'").get().n;

    const result = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 30 });
    assert.equal(result.outcome, "SAVED");

    assert.equal(f.balanceOf(f.black), 50, "physical stock is untouched by a program");
    assert.equal(f.raw.prepare("SELECT COUNT(1) AS n FROM inventory_stock_events").get().n, eventsBefore);
    assert.equal(f.raw.prepare("SELECT COUNT(1) AS n FROM raw_material_qrs WHERE current_status = 'IN_STORE'").get().n, inStoreBefore);

    const upper = f.upperFor(f.machine2.id, f.black);
    assert.deepEqual([upper.physical, upper.reserved, upper.available], [50, 30, 20], "machine 2 sees 20, not 50");
  });
});

test("the same uppers cannot be promised twice, and the refusal says what is free", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 30 });

    const tooMany = await f.addToNewRun({ machineId: f.machine2.id, itemId: f.black, quantity: 21 });
    assert.equal(tooMany.outcome, "NOT_ENOUGH_STOCK");
    assert.equal(tooMany.available, 20);
    assert.equal(f.db.getMachineProgramForDate(f.machine2.id, TODAY), null, "the refused program was rolled back whole");

    const exactly = await f.addToNewRun({ machineId: f.machine2.id, itemId: f.black, quantity: 20 });
    assert.equal(exactly.outcome, "SAVED");
    assert.equal(f.upperFor(f.machine1.id, f.black).available, 0);
  });
});

test("zero, negative, over-precise and missing quantities are refused", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    for (const quantity of [0, -5, 1.234, Number.NaN]) {
      const result = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity });
      assert.equal(result.outcome, "INVALID_QUANTITY", `${quantity} should be refused`);
    }
    const half = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 0.5 });
    assert.equal(half.outcome, "SAVED", "half a dozen is a real quantity");
  });
});

test("several upper colours go on one sole, and the same upper twice is refused", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    await f.stockIn(f.green, 12, f.supplierA);
    const first = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 30 });
    const second = await f.saveOnRun({ machineId: f.machine1.id, runId: first.runId!, itemId: f.green, quantity: 10 });
    assert.equal(second.runId, first.runId);

    const run = f.db.getMachineProgramForDate(f.machine1.id, TODAY)?.runs[0];
    assert.deepEqual(run?.lines.map((line) => [line.upperColour, line.quantity]), [["BLACK", 30], ["GREEN", 10]]);
    assert.equal(run?.totalQuantity, 40);
    assert.equal(run?.soleColour, "BLACK", "the sole colour is its own thing — the uppers are BLACK and GREEN");

    const twice = await f.saveOnRun({ machineId: f.machine1.id, runId: first.runId!, itemId: f.green, quantity: 5 });
    assert.equal(twice.outcome, "ALREADY_ON_PROGRAM");
    assert.equal(twice.lineId, second.lineId);
  });
});

test("an upper for another article, or a non-upper, is refused", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    await f.stockIn(f.black16, 2, f.supplierA);
    await f.stockIn(f.blueElsewhere, 2, f.supplierA);
    f.danaIn(f.danaBlack!, 50, f.supplierA);

    // 7/10 wears the 7/10 upper, so the 1/6 upper is the wrong size for this run.
    const wrongSize = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black16, quantity: 5 });
    assert.equal(wrongSize.outcome, "WRONG_ARTICLE");
    const dana = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.danaBlack!, quantity: 5 });
    assert.equal(dana.outcome, "NOT_AN_UPPER", "Dana is shown, never reserved");
    // Where the store sends a material used to decide which machine could be given it. Raw
    // material routes were removed on 2026-10-07, so anything in stock can be programmed.
    const elsewhere = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.blueElsewhere, quantity: 5 });
    assert.equal(elsewhere.outcome, "SAVED");
    assert.equal(f.upperFor(f.machine1.id, f.blueElsewhere).allocatable, true, "every material in stock is allocatable now");
  });
});

test("a line may take everything the store holds of the upper, whichever supplier it came from", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    await f.stockIn(f.black, 2, f.supplierB);

    const all = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 60 });
    assert.equal(all.outcome, "SAVED", "50 DOZEN from ABC and 10 from XYZ are 60 DOZEN of BLACK");
    assert.equal(f.upperFor(f.machine2.id, f.black).available, 0);

    const more = await f.addToNewRun({ machineId: f.machine2.id, itemId: f.black, quantity: 1 });
    assert.equal(more.outcome, "NOT_ENOUGH_STOCK");
    assert.equal(more.available, 0);
  });
});

// ─── Editing ─────────────────────────────────────────────────────────────────

test("raising a line is measured against what is free plus what it already holds", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    const line = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 30 });
    await f.addToNewRun({ machineId: f.machine2.id, itemId: f.black, quantity: 10 });

    const tooHigh = await f.saveOnRun({ machineId: f.machine1.id, runId: line.runId!, lineId: line.lineId!, itemId: f.black, quantity: 41 });
    assert.equal(tooHigh.outcome, "NOT_ENOUGH_STOCK");
    assert.equal(tooHigh.available, 40);

    const raised = await f.saveOnRun({ machineId: f.machine1.id, runId: line.runId!, lineId: line.lineId!, itemId: f.black, quantity: 40 });
    assert.equal(raised.outcome, "SAVED");
    assert.equal(f.upperFor(f.machine2.id, f.black).available, 0);

    await f.saveOnRun({ machineId: f.machine1.id, runId: line.runId!, lineId: line.lineId!, itemId: f.black, quantity: 25 });
    assert.equal(f.upperFor(f.machine2.id, f.black).available, 15, "lowering a line releases the difference");
  });
});

test("changing the sole colour keeps the uppers, changing the article takes them off", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    const line = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 30 });

    const recoloured = await f.saveRun.execute({ runId: line.runId!, soleColour: "RED", articleSizeId: f.sk6_710, actor: ACTOR });
    assert.equal(recoloured.removedLines, 0);
    const run = f.db.getMachineProgramForDate(f.machine1.id, TODAY)?.runs[0];
    assert.deepEqual([run?.soleColour, run?.lines.length], ["RED", 1]);

    const resized = await f.saveRun.execute({ runId: line.runId!, soleColour: "RED", articleSizeId: f.sk6_46, actor: ACTOR });
    assert.equal(resized.removedLines, 1);
    assert.equal(f.upperFor(f.machine2.id, f.black).available, 50, "the uppers for 7/10 went back to the store");
  });
});

test("an upper or a sole with nothing scanned can be taken off, releasing its reservation", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    await f.stockIn(f.green, 4, f.supplierA);
    const first = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 30 });
    const second = await f.saveOnRun({ machineId: f.machine1.id, runId: first.runId!, itemId: f.green, quantity: 10 });

    const removed = await f.removeLine.execute({ lineId: second.lineId!, actor: ACTOR });
    assert.equal(removed.outcome, "REMOVED");
    assert.equal(removed.runId, first.runId, "the sole is still there with its other upper");
    assert.equal(f.upperFor(f.machine2.id, f.green).available, 20);

    await f.removeLine.execute({ lineId: first.lineId!, actor: ACTOR });
    assert.equal(f.db.getMachineProgramForDate(f.machine1.id, TODAY)?.runs.length, 0, "a sole with no uppers left goes too");

    const again = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 5 });
    const runRemoved = await f.removeRun.execute({ runId: again.runId!, actor: ACTOR });
    assert.equal(runRemoved.outcome, "REMOVED");
    assert.equal(f.upperFor(f.machine2.id, f.black).available, 50);
  });
});

// ─── Raw Material Output consumes, Raw Material Input gives back ─────────────

test("a plain Output scan consumes the packet's contents from the oldest matching line", async () => {
  await withFixture(async (f) => {
    const packets = await readyToProgram(f);
    await f.addToNewRun({ machineId: f.machine1.id, date: TOMORROW, itemId: f.black, quantity: 10 });
    const today = await f.addToNewRun({ machineId: f.machine2.id, itemId: f.black, quantity: 20 });

    const issued = await f.issueOut(packets[0]);
    assert.equal(issued.outcome, "ISSUED");
    assert.equal(issued.machineProgram?.programId, today.programId, "the earliest date is served first");
    assert.deepEqual([issued.machineProgram?.lineQuantity, issued.machineProgram?.lineConsumed, issued.machineProgram?.lineOutstanding], [20, 5, 15]);
    assert.equal(issued.machineProgram?.unitCode, "DOZEN");

    assert.equal(f.balanceOf(f.black), 45, "Store Move OUT is what lowers physical stock");
    const upper = f.upperFor(f.machine1.id, f.black);
    assert.deepEqual([upper.physical, upper.reserved, upper.available], [45, 25, 20], "available does not move: the packet was already promised");

    const program = f.db.getMachineProgramForDate(f.machine2.id, TODAY);
    assert.equal(program?.consumedQuantity, 5);
    assert.equal(program?.displayStatus, MACHINE_PROGRAM_DISPLAY_STATUS.PARTIALLY_USED);
  });
});

test("a packet serves the oldest line for its upper, whoever supplied the packet", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    const fromXyz = await f.stockIn(f.black, 2, f.supplierB);
    const first = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 10 });
    const second = await f.addToNewRun({ machineId: f.machine2.id, itemId: f.black, quantity: 10 });

    // The oldest program asked for BLACK, not for ABC's BLACK — so XYZ's packet satisfies it.
    const issued = await f.issueOut(fromXyz[0]);
    assert.equal(issued.machineProgram?.programId, first.programId);
    assert.notEqual(issued.machineProgram?.programId, second.programId);
    assert.equal(issued.machineProgram?.lineConsumed, 5);
  });
});

test("the last packet completes the program, and bringing it back re-opens it", async () => {
  await withFixture(async (f) => {
    const packets = await readyToProgram(f);
    const line = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 10 });
    await f.issueOut(packets[0]);
    const last = await f.issueOut(packets[1]);
    assert.equal(last.machineProgram?.programCompleted, true);
    assert.equal(f.db.getMachineProgramForDate(f.machine1.id, TODAY)?.status, MACHINE_PROGRAM_STATUS.COMPLETED);

    const back = await f.bringBack(packets[1], f.supplierA);
    assert.equal(back.outcome, "RECEIVED");
    const program = f.db.getMachineProgramForDate(f.machine1.id, TODAY);
    assert.equal(program?.id, line.programId);
    assert.equal(program?.status, MACHINE_PROGRAM_STATUS.PROGRAMMED);
    assert.equal(program?.outstandingQuantity, 5, "the packet is back on the shelf, so the program is owed it again");
    assert.equal(f.balanceOf(f.black), 45);
  });
});

test("a scanned line cannot go below what was taken, nor be taken off", async () => {
  await withFixture(async (f) => {
    const packets = await readyToProgram(f);
    const line = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 20 });
    await f.issueOut(packets[0]);
    await f.issueOut(packets[1]);

    const below = await f.saveOnRun({ machineId: f.machine1.id, runId: line.runId!, lineId: line.lineId!, itemId: f.black, quantity: 9 });
    assert.equal(below.outcome, "BELOW_CONSUMED");
    const down = await f.saveOnRun({ machineId: f.machine1.id, runId: line.runId!, lineId: line.lineId!, itemId: f.black, quantity: 10 });
    assert.equal(down.outcome, "SAVED", "lowering to exactly what was taken is allowed");
    assert.equal(f.db.getMachineProgramForDate(f.machine1.id, TODAY)?.status, MACHINE_PROGRAM_STATUS.COMPLETED, "and that finishes it");

    const off = await f.removeLine.execute({ lineId: line.lineId!, actor: ACTOR });
    assert.equal(off.outcome, "IN_USE", "a scanned line is a record");
    const runOff = await f.removeRun.execute({ runId: line.runId!, actor: ACTOR });
    assert.equal(runOff.outcome, "IN_USE");
    const resize = await f.saveRun.execute({ runId: line.runId!, soleColour: "BLACK", articleSizeId: f.sk6_46, actor: ACTOR });
    assert.equal(resize.outcome, "IN_USE");
  });
});

// ─── Deleting ────────────────────────────────────────────────────────────────

test("deleting releases only what is outstanding, restores no stock, and frees the date", async () => {
  await withFixture(async (f) => {
    const packets = await readyToProgram(f);
    const line = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 30 });
    await f.issueOut(packets[0]);
    assert.equal(f.balanceOf(f.black), 45);

    const deleted = await f.remove.execute({ programId: line.programId!, reason: "Shift cancelled", actor: ACTOR });
    assert.equal(deleted.outcome, "CANCELLED");
    assert.equal(deleted.releasedQuantity, 25);
    assert.equal(deleted.consumedQuantity, 5);

    assert.equal(f.balanceOf(f.black), 45, "deleting a plan never puts issued stock back");
    assert.equal(f.upperFor(f.machine2.id, f.black).available, 45, "everything still in the store is free again");
    assert.equal(f.db.getMachineProgramForDate(f.machine1.id, TODAY), null, "the date is free for a new program");
    assert.equal(f.db.getMachineProgram(line.programId!)?.status, MACHINE_PROGRAM_STATUS.CANCELLED, "the deleted program is kept as history");

    const again = await f.remove.execute({ programId: line.programId!, actor: ACTOR });
    assert.equal(again.outcome, "PROGRAM_CLOSED");
    const next = await f.issueOut(packets[1]);
    assert.equal(next.machineProgram, undefined, "a deleted program owes nothing");
  });
});

test("every change is audited", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    const line = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 30 });
    await f.saveOnRun({ machineId: f.machine1.id, runId: line.runId!, lineId: line.lineId!, itemId: f.black, quantity: 20 });
    await f.remove.execute({ programId: line.programId!, actor: ACTOR });
    const events = (f.raw.prepare("SELECT event_type FROM audit_log WHERE entity_type = 'MACHINE_PROGRAM' ORDER BY occurred_at, rowid").all() as Array<{ event_type: string }>).map((row) => row.event_type);
    // Four assignments: each machine gets its machine contractor and its packing contractor,
    // and each role is its own audited transaction.
    assert.deepEqual(events, [
      "MACHINE_CONTRACTOR_ASSIGNED",
      "MACHINE_CONTRACTOR_ASSIGNED",
      "MACHINE_CONTRACTOR_ASSIGNED",
      "MACHINE_CONTRACTOR_ASSIGNED",
      "MACHINE_PROGRAM_CREATED",
      "MACHINE_PROGRAM_LINE_ADDED",
      "MACHINE_PROGRAM_LINE_CHANGED",
      "MACHINE_PROGRAM_DELETED",
    ]);
  });
});

// ─── Adding a machine by name alone ───────────────────────────────────────────

function bareDatabase() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-machine-add-"));
  return new SqliteDatabase({ dbPath: path.join(tempDir, "erp.db"), schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
}

test("a machine added by name alone goes in the floor's existing section", () => {
  const db = bareDatabase();
  const packing = db.createWorkSection({ name: "Packing" });
  db.createWorkSection({ name: "Upper Maker" });

  const machine = db.createMachine({ name: "Machine 4" });
  assert.equal(machine.name, "MACHINE 4");
  assert.equal(machine.sectionId, packing.id);
  assert.equal(machine.status, "ACTIVE");
  assert.equal(db.listWorkSections().length, 2, "no extra section is made when one exists");
});

test("on a floor with no section yet, adding a machine makes one MACHINES section for it", () => {
  const db = bareDatabase();
  const first = db.createMachine({ name: "Machine 1" });
  const second = db.createMachine({ name: "Machine 2" });

  const sections = db.listWorkSections();
  assert.deepEqual(sections.map((section) => section.name), ["MACHINES"]);
  assert.equal(first.sectionId, sections[0].id);
  assert.equal(second.sectionId, sections[0].id);
  assert.deepEqual(db.listMachines().map((machine) => machine.name), ["MACHINE 1", "MACHINE 2"]);
});

test("adding a machine name twice returns the first machine, and a chosen section must exist", () => {
  const db = bareDatabase();
  const first = db.createMachine({ name: "Machine 1" });
  assert.equal(db.createMachine({ name: "machine 1" }).id, first.id);
  assert.equal(db.listMachines().length, 1);
  assert.throws(() => db.createMachine({ name: "Machine 2", sectionId: "no-such-section" }), /no longer exists/);
  assert.throws(() => db.createMachine({ name: "   " }), /name is required/);
});

// ─── Contractor pricing ───────────────────────────────────────────────────────
// What the day's work is paid at: machine, packing and printing, per DOZEN, per ARTICLE
// (migration 063). Stored as integer paisa, one row per article, and never an amount — what is
// owed is settled when production is recorded, which this ERP does not do yet.

test("pricing an article stores the three rates in paisa, and the program reads them back", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    const saved = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 20 });
    assert.equal(saved.accepted, true, saved.reason);

    const priced = await f.price({ programId: saved.programId!, machine: 45, packing: 18, printing: 12 });
    assert.equal(priced.accepted, true, priced.reason);

    // Paisa in the table, never rupees (R15).
    assert.deepEqual(
      f.rateRows(saved.programId!).map((row) => [row.article_size_id, row.machine_rate_paisa, row.packing_rate_paisa, row.printing_rate_paisa]),
      [[f.sk6_710, 4500, 1800, 1200]]
    );

    const program = f.db.getMachineProgram(saved.programId!);
    assert.deepEqual(program?.articleRates.map((row) => [row.articleSizeId, row.machineRatePaisa, row.packingRatePaisa, row.printingRatePaisa]), [
      [f.sk6_710, 4500, 1800, 1200],
    ]);

    // 20 DOZEN at 75.00 the dozen — the arithmetic is the domain's, from the record as stored.
    const pricing = programContractorPricing({ runs: program!.runs, rates: program!.articleRates });
    assert.equal(pricing.committed.totalPaisa, toPaisa(75) * 20);
    assert.equal(pricing.committed.machinePaisa, toPaisa(45) * 20);
    assert.equal(pricing.fullyPriced, true);
  });
});

test("pricing the same article again CHANGES its rates — one price per article, never two", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    const saved = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 20 });

    await f.price({ programId: saved.programId!, machine: 45, packing: 18, printing: 12 });
    const again = await f.price({ programId: saved.programId!, machine: 50, packing: 18, printing: 0 });
    assert.equal(again.accepted, true, again.reason);

    const rows = f.rateRows(saved.programId!);
    assert.equal(rows.length, 1, "re-pricing replaces, it does not add a second row");
    assert.equal(rows[0].machine_rate_paisa, 5000);
    assert.equal(rows[0].printing_rate_paisa, 0, "a rate taken back to zero is stored as zero");
  });
});

test("the same article on two sole runs is ONE price for both", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    await f.stockIn(f.green, 6, f.supplierA);
    // SK6 7/10 on a BLACK sole and again on a RED one: two runs, one article.
    const first = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 20, soleColour: "BLACK" });
    const second = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.green, quantity: 10, soleColour: "RED" });
    assert.equal(second.accepted, true, second.reason);
    assert.equal(first.programId, second.programId, "one program for the machine and date");

    await f.price({ programId: first.programId!, machine: 45, packing: 18, printing: 0 });

    assert.equal(f.rateRows(first.programId!).length, 1, "the article is priced once, not per run");
    const program = f.db.getMachineProgram(first.programId!);
    const pricing = programContractorPricing({ runs: program!.runs, rates: program!.articleRates });
    assert.equal(pricing.articles.length, 1);
    assert.equal(pricing.articles[0].quantity, 30, "both runs are one priced quantity");
    assert.equal(pricing.committed.totalPaisa, toPaisa(63) * 30);
  });
});

test("an article the program is not making cannot be priced", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    const saved = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 20 });

    // SK6 4/6 is a real product, but nothing on this program is making it.
    const refused = await f.price({ programId: saved.programId!, articleSizeId: f.sk6_46, machine: 45, packing: 18, printing: 0 });
    assert.equal(refused.accepted, false);
    assert.equal(refused.outcome, "ARTICLE_NOT_FOUND");
    assert.match(refused.reason ?? "", /not on the program/);
    assert.equal(f.rateRows(saved.programId!).length, 0, "nothing was stored");
  });
});

test("a rate that is negative or absurd is refused, and nothing is stored", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    const saved = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 20 });

    for (const bad of [{ machine: -1, packing: 0, printing: 0 }, { machine: 0, packing: 100_001, printing: 0 }]) {
      const refused = await f.price({ programId: saved.programId!, ...bad });
      assert.equal(refused.accepted, false, JSON.stringify(bad));
      assert.equal(refused.outcome, "INVALID_RATE");
    }
    assert.equal(f.rateRows(saved.programId!).length, 0);

    // Zero is not absurd: it means that job is not paid for this article.
    const free = await f.price({ programId: saved.programId!, machine: 0, packing: 0, printing: 0 });
    assert.equal(free.accepted, true, free.reason);
    assert.deepEqual(f.rateRows(saved.programId!).map((row) => row.machine_rate_paisa), [0]);
  });
});

test("a deleted program cannot be priced", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    const saved = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 20 });
    const deleted = await f.remove.execute({ programId: saved.programId!, reason: "wrong machine", actor: ACTOR });
    assert.equal(deleted.accepted, true, deleted.reason);

    const refused = await f.price({ programId: saved.programId!, machine: 45, packing: 18, printing: 0 });
    assert.equal(refused.accepted, false);
    assert.equal(refused.outcome, "PROGRAM_CLOSED");
    assert.equal(f.rateRows(saved.programId!).length, 0);
  });
});

test("pricing is on the record: who priced what, from what to what", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    const saved = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 20 });
    await f.price({ programId: saved.programId!, machine: 45, packing: 18, printing: 12 });
    await f.price({ programId: saved.programId!, machine: 50, packing: 18, printing: 12 });

    const rows = f.raw
      .prepare("SELECT payload_json FROM audit_log WHERE event_type = 'MACHINE_PROGRAM_ARTICLE_PRICED' ORDER BY occurred_at, rowid")
      .all() as Array<{ payload_json: string }>;
    assert.equal(rows.length, 2);

    const first = JSON.parse(rows[0].payload_json) as Record<string, unknown>;
    assert.equal(first.from, null, "nothing was priced before the first one");
    assert.deepEqual(first.to, { machineRatePaisa: 4500, packingRatePaisa: 1800, printingRatePaisa: 1200 });
    assert.equal(first.actor, ACTOR);

    const second = JSON.parse(rows[1].payload_json) as Record<string, unknown>;
    assert.deepEqual(second.from, { machineRatePaisa: 4500, packingRatePaisa: 1800, printingRatePaisa: 1200 }, "the rate it was changed FROM");
    assert.deepEqual(second.to, { machineRatePaisa: 5000, packingRatePaisa: 1800, printingRatePaisa: 1200 });
  });
});

// ─── The product's standard rates ─────────────────────────────────────────────
// Set on the product itself (migration 064), beside its sale price, and offered to a program as
// the default for an article it has not priced yet.

test("a product's standard contractor rates are stored in paisa and offered to the program", async () => {
  await withFixture(async (f) => {
    f.db.createProduct({
      article: "SK6",
      size: "7/10",
      sellingPrice: 650,
      machineRate: 45,
      packingRate: 18.5,
      printingRate: 0,
      status: "ACTIVE",
    });

    // Read back through the product screens…
    const product = f.db.getProduct(f.sk6_710);
    assert.equal(product?.machineRatePaisa, 4500);
    assert.equal(product?.packingRatePaisa, 1850, "18.50 is exact in paisa");
    assert.equal(product?.printingRatePaisa, 0, "an explicit zero is a rate, not a missing one");

    // …and offered to the Machine Program's article list, which is where a program defaults from.
    const size = f.db
      .listMachineProgramArticles()
      .flatMap((entry) => entry.sizes)
      .find((entry) => entry.articleSizeId === f.sk6_710);
    assert.deepEqual(
      [size?.machineRatePaisa, size?.packingRatePaisa, size?.printingRatePaisa],
      [4500, 1850, 0]
    );
  });
});

test("a product nobody has priced is offered as UNPRICED, never as zero", async () => {
  await withFixture(async (f) => {
    // The fixture's own products were made with no rates at all.
    const product = f.db.getProduct(f.sk6_46);
    assert.equal(product?.machineRatePaisa, null);
    assert.equal(product?.packingRatePaisa, null);
    assert.equal(product?.printingRatePaisa, null);

    const size = f.db
      .listMachineProgramArticles()
      .flatMap((entry) => entry.sizes)
      .find((entry) => entry.articleSizeId === f.sk6_46);
    assert.deepEqual([size?.machineRatePaisa, size?.packingRatePaisa, size?.printingRatePaisa], [null, null, null]);
  });
});

test("changing a product's standard rate does NOT change a program already priced", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    const saved = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 20 });
    await f.price({ programId: saved.programId!, machine: 45, packing: 18, printing: 12 });

    // The deal with the contractors changes afterwards.
    f.db.updateProduct(f.sk6_710, { article: "SK6", size: "7/10", sellingPrice: 650, machineRate: 60, packingRate: 25, printingRate: 15 });

    assert.equal(f.db.getProduct(f.sk6_710)?.machineRatePaisa, 6000, "the product carries the new standard");
    assert.deepEqual(
      f.rateRows(saved.programId!).map((row) => [row.machine_rate_paisa, row.packing_rate_paisa, row.printing_rate_paisa]),
      [[4500, 1800, 1200]],
      "the program keeps what its own day was agreed at"
    );
  });
});

test("a product saved by a form that knows nothing about the rates leaves them alone", async () => {
  await withFixture(async (f) => {
    f.db.updateProduct(f.sk6_710, { article: "SK6", size: "7/10", sellingPrice: 650, machineRate: 45, packingRate: 18, printingRate: 12 });
    assert.equal(f.db.getProduct(f.sk6_710)?.machineRatePaisa, 4500);

    // The simple product form (ProductsPage) sends no rate fields at all. Blanking an agreed rate
    // because another screen does not know about it would be silent data loss.
    f.db.updateProduct(f.sk6_710, { article: "SK6", size: "7/10", sellingPrice: 700 });

    const after = f.db.getProduct(f.sk6_710);
    assert.equal(after?.sellingPrice, 700, "the price it DID send is saved");
    assert.deepEqual(
      [after?.machineRatePaisa, after?.packingRatePaisa, after?.printingRatePaisa],
      [4500, 1800, 1200],
      "and the rates it said nothing about are untouched"
    );

    // Sending them as null IS a change — that is how a box cleared on the full form clears a rate.
    f.db.updateProduct(f.sk6_710, { article: "SK6", size: "7/10", sellingPrice: 700, machineRate: null, packingRate: null, printingRate: null });
    const cleared = f.db.getProduct(f.sk6_710);
    assert.deepEqual([cleared?.machineRatePaisa, cleared?.packingRatePaisa, cleared?.printingRatePaisa], [null, null, null]);
  });
});

// ─── The shift, and how long each sole runs in it ────────────────────────────
// The shift says how long the MACHINE runs. A sole slot says which sole is on it when, which is
// what a minder standing at the machine needs when an injector changes colour mid-shift.

const DAY_SHIFT = { startMinute: 6 * 60, endMinute: 18 * 60 };

test("a program can run hours nobody chose from a list", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    const saved = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 10 });
    const custom = { startMinute: 8 * 60, endMinute: 14 * 60 + 30 };

    const result = await f.setShift.execute({ programId: saved.programId!, shift: custom, actor: ACTOR });
    assert.equal(result.outcome, "SAVED");

    const program = f.db.getMachineProgram(saved.programId!);
    assert.equal(program?.shiftStartMinute, 480);
    assert.equal(program?.shiftEndMinute, 870, "08:00 to 14:30 is a shift like any other");
    assert.equal(program?.totalQuantity, 10, "the hours move nothing");
  });
});

test("timing a sole writes every run of that colour on that injector, and nothing else", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    await f.stockIn(f.black16, 4, f.supplierA);
    // BLACK on injector 1 across two articles, RED beside it, and BLACK again on injector 2.
    const saved = await f.addToNewRun({ machineId: f.machine1.id, injectorNo: 1, itemId: f.black, quantity: 10 });
    await f.addToNewRun({ machineId: f.machine1.id, injectorNo: 1, articleSizeId: f.sk6_46, itemId: f.black16, quantity: 5 });
    await f.addToNewRun({ machineId: f.machine1.id, injectorNo: 1, soleColour: "RED", itemId: f.black, quantity: 3 });
    await f.addToNewRun({ machineId: f.machine1.id, injectorNo: 2, itemId: f.black, quantity: 4 });
    const programId = saved.programId!;

    const result = await f.timeSole({ programId, injectorNo: 1, soleColour: "BLACK", slot: { startMinute: 360, endMinute: 600 } });
    assert.equal(result.outcome, "SAVED");

    assert.deepEqual(
      f.runSlots(programId).map((row) => [row.injector_no, row.sole_colour, row.start_minute, row.end_minute]),
      [
        [1, "BLACK", 360, 600],
        [1, "BLACK", 360, 600],
        [1, "RED", null, null],
        [2, "BLACK", null, null],
      ],
      "both BLACK runs on injector 1 are timed together; RED and injector 2 are left alone"
    );

    const program = f.db.getMachineProgram(programId);
    const blackOnOne = program?.runs.filter((run) => run.injectorNo === 1 && run.soleColour === "BLACK") ?? [];
    assert.equal(blackOnOne.length, 2);
    assert.ok(blackOnOne.every((run) => run.startMinute === 360 && run.endMinute === 600), "the screens read the hours back");
    assert.equal(program?.totalQuantity, 22, "timing a sole reserves and releases nothing");
  });
});

test("a sole cannot be timed to run while the machine is stopped", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    const saved = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 10 });
    const programId = saved.programId!;

    const late = await f.timeSole({ programId, slot: { startMinute: 600, endMinute: 19 * 60 } });
    assert.equal(late.outcome, "INVALID_SHIFT", "the day shift ends at 06:00 PM");
    assert.match(late.reason ?? "", /06:00 AM – 06:00 PM/, "the refusal says what hours the machine does run");

    const early = await f.timeSole({ programId, slot: { startMinute: 5 * 60, endMinute: 600 } });
    assert.equal(early.outcome, "INVALID_SHIFT");

    const backwards = await f.timeSole({ programId, slot: { startMinute: 600, endMinute: 600 } });
    assert.equal(backwards.outcome, "INVALID_SHIFT");

    assert.deepEqual(
      f.runSlots(programId).map((row) => [row.start_minute, row.end_minute]),
      [[null, null]],
      "nothing was stored by any of the three"
    );
  });
});

test("two soles on one injector may share an hour — that is the colour being changed", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    const saved = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 10 });
    await f.addToNewRun({ machineId: f.machine1.id, soleColour: "RED", itemId: f.black, quantity: 5 });
    const programId = saved.programId!;

    assert.equal((await f.timeSole({ programId, soleColour: "BLACK", slot: { startMinute: 360, endMinute: 660 } })).outcome, "SAVED");
    assert.equal((await f.timeSole({ programId, soleColour: "RED", slot: { startMinute: 600, endMinute: 1080 } })).outcome, "SAVED");

    assert.deepEqual(
      f.runSlots(programId).map((row) => [row.sole_colour, row.start_minute, row.end_minute]),
      [
        ["BLACK", 360, 660],
        ["RED", 600, 1080],
      ]
    );
  });
});

test("a sole hours are cleared back to the whole shift", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    const saved = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 10 });
    const programId = saved.programId!;

    await f.timeSole({ programId, slot: { startMinute: 360, endMinute: 600 } });
    const cleared = await f.timeSole({ programId, slot: null });
    assert.equal(cleared.outcome, "SAVED");
    assert.deepEqual(f.runSlots(programId).map((row) => [row.start_minute, row.end_minute]), [[null, null]]);
    assert.equal(f.db.getMachineProgram(programId)?.runs[0]?.startMinute, null, "untimed again: it runs the whole shift");
  });
});

test("a sole hours follow the shift the program was given, not the standard one", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    const saved = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 10 });
    const programId = saved.programId!;
    await f.setShift.execute({ programId, shift: { startMinute: 18 * 60, endMinute: 30 * 60 }, actor: ACTOR });

    const inDayHours = await f.timeSole({ programId, slot: { startMinute: 360, endMinute: 600 } });
    assert.equal(inDayHours.outcome, "INVALID_SHIFT", "this machine is running nights now");

    // 10:00 PM to 02:00 AM, which on the shift own clock is 1320 to 1560.
    const overnight = await f.timeSole({ programId, slot: { startMinute: 1320, endMinute: 1560 } });
    assert.equal(overnight.outcome, "SAVED");
    assert.deepEqual(f.runSlots(programId).map((row) => [row.start_minute, row.end_minute]), [[1320, 1560]]);
  });
});

test("only a colour actually on the injector can be timed, and only on a live program", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    const saved = await f.addToNewRun({ machineId: f.machine1.id, injectorNo: 1, itemId: f.black, quantity: 10 });
    const programId = saved.programId!;

    const wrongColour = await f.timeSole({ programId, soleColour: "PURPLE", slot: { startMinute: 360, endMinute: 600 } });
    assert.equal(wrongColour.outcome, "RUN_NOT_FOUND");
    const wrongInjector = await f.timeSole({ programId, injectorNo: 2, slot: { startMinute: 360, endMinute: 600 } });
    assert.equal(wrongInjector.outcome, "RUN_NOT_FOUND");
    assert.deepEqual(f.runSlots(programId).map((row) => [row.start_minute, row.end_minute]), [[null, null]]);

    // Deleting a program CANCELS it — its history is kept, never erased — so timing a sole on
    // it is refused as closed rather than as missing.
    await f.remove.execute({ programId, reason: "test", actor: ACTOR });
    const deleted = await f.timeSole({ programId, slot: { startMinute: 360, endMinute: 600 } });
    assert.equal(deleted.outcome, "PROGRAM_CLOSED");
    assert.deepEqual(f.runSlots(programId).map((row) => [row.start_minute, row.end_minute]), [[null, null]]);
  });
});

test("timing a sole is on the record, with the hours it was given", async () => {
  await withFixture(async (f) => {
    await readyToProgram(f);
    const saved = await f.addToNewRun({ machineId: f.machine1.id, itemId: f.black, quantity: 10 });
    const programId = saved.programId!;
    await f.timeSole({ programId, slot: DAY_SHIFT });

    const row = f.raw
      .prepare(
        "SELECT payload_json FROM audit_log WHERE event_type = 'MACHINE_PROGRAM_SOLE_SLOT_CHANGED' ORDER BY occurred_at DESC LIMIT 1"
      )
      .get() as { payload_json: string } | undefined;
    assert.ok(row, "the change should be on the audit trail");
    const payload = JSON.parse(row.payload_json) as { soleColour: string; injectorNo: number; slot: string | null; runs: number };
    assert.equal(payload.soleColour, "BLACK");
    assert.equal(payload.injectorNo, 1);
    assert.equal(payload.slot, "06:00 AM – 06:00 PM");
    assert.equal(payload.runs, 1);
  });
});
