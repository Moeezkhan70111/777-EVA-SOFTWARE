// FIX articles on a machine program: no upper, two soles.
//
//   a normal article   BLACK sole  +  an UPPER going on it     quantity lives on the upper line
//   a FIX article      OUTER sole  +  INNER sole, no upper     quantity lives on the run
//
// The owner settled it on 2026-10-11. What these tests are here to pin:
//
//   * which articles are FIX is a fact about the PRODUCT SUB GROUP, never a name in the code
//   * a fix run reserves NOTHING — no balance moves, and the store has nothing to issue for it
//   * the two kinds can never be mixed on one article, whichever save is reached
//   * the figure a fix run plans is kept apart from the figure the program RESERVES

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AssignMachineContractorUseCase,
  InMemoryEventBus,
  ReceiveMachineProgramCartonUseCase,
  ReceiveRawMaterialScanUseCase,
  SaveMachineProgramFixRunUseCase,
  SaveMachineProgramLineUseCase,
} from "@erp/application";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { UuidGenerator } from "./idGenerator.js";

const CONTEXT = { factoryId: "factory-1", workstationId: "workstation-1", deviceId: "device-1" };
const ACTOR = "aslam";
const TODAY = "2026-10-11";

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-mp-fix-"));
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
    saveFix: new SaveMachineProgramFixRunUseCase(deps),
    receive: new ReceiveRawMaterialScanUseCase(deps),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- direct schema access for assertions
  const raw = (db as any).db;

  const unitId = db.createInventoryUnit({ code: "DOZEN", name: "Dozen", unitFamily: "COUNT" });
  const packing = db.createWorkSection({ name: "Packing" });
  const machine = db.createMachine({ name: "Machine 1", sectionId: packing.id });

  const party = (partyName: string, partyType: string, mobile: string) =>
    db.createParty({ partyName, partyType, city: "Lahore", mobileNumber: mobile, status: "ACTIVE" });
  const contractorA = party("CONTRACTOR A", "CONTRACTOR", "0300-1111111");
  const contractorB = party("CONTRACTOR B", "CONTRACTOR", "0300-2222222");
  const supplier = party("ABC UPPER", "SUPPLIER", "0300-3333333");

  // Two sub groups: one ordinary, one FIX.
  const group = db.createProductGroup({ groupName: "GENTS" });
  const casual = db.createProductSubGroup({ productGroupId: group, name: "CASUAL" });
  const evrFix = db.createProductSubGroup({ productGroupId: group, name: "EVR FIX", hasNoUpper: true });

  const articleSize = (article: string, size: string, subGroupId: string | null): string => {
    db.createProduct({ article, size, sellingPrice: 550, status: "ACTIVE", productGroupId: group, productSubGroupId: subGroupId ?? undefined });
    return (raw.prepare("SELECT id FROM article_sizes WHERE article = ? AND size = ?").get(article, size) as { id: string }).id;
  };
  const sk6 = articleSize("SK6", "7/10", casual);
  const evr9 = articleSize("EVR9", "7/10", evrFix);

  // An upper for SK6, so an ordinary run has something real to reserve.
  const upper = db.createInventoryCategory({ name: "UPPER" });
  const ragzine = db.createInventoryCategory({ name: "RAGZINE UPPER", parentId: upper });
  ["article", "color", "size", "type"].forEach((fieldKey, index) =>
    db.addInventoryCategoryField({ categoryId: ragzine, fieldKey, label: fieldKey.toUpperCase(), fieldType: "TEXT", required: fieldKey !== "type", sortOrder: index + 1 })
  );
  const black = db.createInventoryItem({ categoryId: ragzine, values: { article: "SK6", color: "BLACK", size: "7/10", type: "SILAI" }, unitId }).id;
  db.setRawMaterialMovementConfig(black, { packName: "PACKET", packingQuantity: 5, packingUnitId: unitId });

  // Dana, so BLACK and RED are colours the store knows and a sole may be moulded in them.
  const dana = db.createInventoryCategory({ name: "DANA" });
  const eva = db.createInventoryCategory({ name: "EVA", parentId: dana });
  db.addInventoryCategoryField({ categoryId: eva, fieldKey: "color", label: "COLOR", fieldType: "TEXT", required: true, sortOrder: 1 });
  for (const color of ["BLACK", "RED", "WHITE"]) {
    const id = db.createInventoryItem({ categoryId: eva, values: { color }, unitId }).id;
    db.setRawMaterialMovementConfig(id, { packName: "BAG", packingQuantity: 25, packingUnitId: unitId });
  }

  const stockIn = async (itemId: string, count: number): Promise<string[]> => {
    const session = db.startRawMaterialReceivingSession({ partyId: supplier, deviceId: "device-1", startedBy: ACTOR });
    const qrIds = db.generateRawMaterialQrBatch({ partyId: supplier, itemId, quantity: count, packingQuantity: 5 }).qrCodes.map((qr) => qr.id);
    for (const qrId of qrIds) {
      await useCases.receive.execute({ rawScan: qrId, partyId: supplier, sessionId: session.id, context: CONTEXT, actor: ACTOR });
    }
    db.closeRawMaterialReceivingSession(session.id);
    return qrIds;
  };

  const ready = async () => {
    await useCases.assign.execute({ machineId: machine.id, role: "MACHINE", contractorPartyId: contractorA, actor: ACTOR });
    await useCases.assign.execute({ machineId: machine.id, role: "PACKING", contractorPartyId: contractorB, actor: ACTOR });
    await stockIn(black, 20);
  };

  const saveFix = (input: { articleSizeId?: string; outer?: string; inner?: string; quantity?: number }) =>
    useCases.saveFix.execute({
      machineId: machine.id,
      programDate: TODAY,
      soleColour: input.outer ?? "BLACK",
      innerSoleColour: input.inner ?? "RED",
      articleSizeId: input.articleSizeId ?? evr9,
      quantity: input.quantity ?? 30,
      actor: ACTOR,
    });

  const saveUpper = (input: { articleSizeId?: string; itemId?: string; quantity?: number }) =>
    useCases.saveLine.execute({
      machineId: machine.id,
      programDate: TODAY,
      injectorNo: 1,
      run: { soleColour: "BLACK", articleSizeId: input.articleSizeId ?? sk6 },
      itemId: input.itemId ?? black,
      quantity: input.quantity ?? 10,
      actor: ACTOR,
    });

  const program = () => db.getMachineProgramForDate(machine.id, TODAY);
  const balanceOf = (itemId: string): number =>
    Number((raw.prepare("SELECT quantity_on_hand AS q FROM inventory_stock_balances WHERE item_id = ?").get(itemId) as { q: number } | undefined)?.q ?? 0);

  /** Store In scanning one of the program's carton labels back — produced and stored in. */
  const cartonIn = new ReceiveMachineProgramCartonUseCase({
    txManager: db, duplicateChecker: db, qrRegistry: db, productCatalog: db, qrMasterRepo: db,
    productionEventsRepo: db, stockProjectionRepo: db, outboxRepo: db, qrLookupRepo: db, gatepassRepo: db,
    storeEntryEventsRepo: db, cartonOriginRepo: db, eventPublisher: new InMemoryEventBus(), idGenerator: new UuidGenerator(),
  });

  /** The cartons each FIX run of today's program is owed. */
  const fixCartons = () => db.listMachineProgramFixCartonRuns(program()?.id ?? "");

  /** Prints a fix run's outstanding cartons, as Machine Move Out does. */
  const printFixCartons = (runId: string) =>
    db.printMachineProgramFixCartons({ programId: program()?.id ?? "", runId, printedBy: ACTOR, deviceId: "device-1" });

  return {
    db, raw, machine, sk6, evr9, black, casual, evrFix, group,
    ready, saveFix, saveUpper, program, balanceOf, fixCartons, printFixCartons, cartonIn,
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

test("a FIX article is known by its product sub group, not by its name", async () => {
  await withFixture(async (f) => {
    assert.equal(f.db.articleHasNoUpper(f.evr9), true, "EVR9 is in a sub group ticked as having no upper");
    assert.equal(f.db.articleHasNoUpper(f.sk6), false);

    // Renaming EVR FIX cannot turn its articles back into upper articles.
    f.db.renameProductListEntry({ kind: "product-sub-group", id: f.evrFix, newName: "FIXED SOLE" });
    assert.equal(f.db.articleHasNoUpper(f.evr9), true, "the flag is the rule, not the word FIX");

    // Unticking it is what changes them.
    f.db.setProductSubGroupHasNoUpper(f.evrFix, false);
    assert.equal(f.db.articleHasNoUpper(f.evr9), false);
  });
});

test("a fix run saves two soles and its own quantity, and reserves nothing", async () => {
  await withFixture(async (f) => {
    await f.ready();
    const before = f.balanceOf(f.black);

    const saved = await f.saveFix({ outer: "BLACK", inner: "RED", quantity: 30 });
    assert.equal(saved.outcome, "SAVED");

    const run = f.program()?.runs[0];
    assert.equal(run?.article, "EVR9");
    assert.equal(run?.soleColour, "BLACK", "the outer sole");
    assert.equal(run?.innerSoleColour, "RED", "the inner sole — what makes it a fix run");
    assert.equal(run?.fixQuantity, 30);
    assert.deepEqual(run?.lines, [], "and no uppers at all");

    // It plans 30, and promises the store nothing.
    const record = f.program()!;
    assert.equal(record.fixQuantity, 30);
    assert.equal(record.totalQuantity, 0, "nothing is RESERVED");
    assert.equal(record.outstandingQuantity, 0);
    assert.equal(record.productionQuantity, 30, "but the machine is still making 30");
    assert.equal(f.balanceOf(f.black), before, "no stock moved");
  });
});

test("an upper and a fix run can never be mixed on one article", async () => {
  await withFixture(async (f) => {
    await f.ready();

    // An upper cannot go on a FIX article.
    const upperOnFix = await f.saveUpper({ articleSizeId: f.evr9 });
    assert.equal(upperOnFix.accepted, false);
    assert.equal(upperOnFix.outcome, "WRONG_ARTICLE");
    assert.match(upperOnFix.reason ?? "", /two soles/);

    // And a second sole cannot go on an article that is made with an upper.
    const fixOnUpper = await f.saveFix({ articleSizeId: f.sk6 });
    assert.equal(fixOnUpper.accepted, false);
    assert.equal(fixOnUpper.outcome, "WRONG_ARTICLE");
    assert.match(fixOnUpper.reason ?? "", /made with an upper/);

    assert.equal(f.program(), null, "nothing half-made is left behind");
  });
});

// EVR FIX is not moulded on the injectors (owner, 2026-10-12; migration 073).
test("a fix run has NO injector — it belongs to the program", async () => {
  await withFixture(async (f) => {
    await f.ready();
    const saved = await f.saveFix({ quantity: 30 });
    assert.equal(saved.accepted, true, saved.reason);
    const [run] = f.program()?.runs ?? [];
    assert.equal(run.injectorNo, null);
    assert.equal(run.runNo, 1, "fix runs are numbered among themselves");
    assert.equal(
      (f.raw.prepare("SELECT injector_no FROM machine_program_runs WHERE id = ?").get(run.id) as { injector_no: number | null }).injector_no,
      null
    );

    // The table itself holds the rule both ways: a normal run must have an injector, a fix run must not.
    const programId = f.program()!.id;
    const insert = (injector: number | null, inner: string | null) =>
      f.raw
        .prepare(
          `INSERT INTO machine_program_runs (id, program_id, injector_no, run_no, sole_colour, inner_sole_colour, article_size_id, created_at, updated_at)
           VALUES (?, ?, ?, 99, 'BLACK', ?, ?, '2026-10-12', '2026-10-12')`
        )
        .run(`r-${injector}-${inner}`, programId, injector, inner, f.sk6);
    assert.throws(() => insert(null, null), /CHECK/, "a normal run with no injector");
    assert.throws(() => insert(1, "RED"), /CHECK/, "a fix run on an injector");
  });
});

test("the same fix article on the program is CHANGED, never duplicated", async () => {
  await withFixture(async (f) => {
    await f.ready();
    const first = await f.saveFix({ quantity: 30 });
    const again = await f.saveFix({ outer: "WHITE", inner: "BLACK", quantity: 45 });

    assert.equal(again.runId, first.runId, "the same run");
    const runs = f.program()?.runs ?? [];
    assert.equal(runs.length, 1);
    assert.equal(runs[0].soleColour, "WHITE");
    assert.equal(runs[0].innerSoleColour, "BLACK");
    assert.equal(runs[0].fixQuantity, 45);
  });
});

test("a fix run refuses a quantity that is not a quantity, and a colour the store does not know", async () => {
  await withFixture(async (f) => {
    await f.ready();
    for (const quantity of [0, -5, Number.NaN, 10.123]) {
      const result = await f.saveFix({ quantity });
      assert.equal(result.accepted, false, `${quantity} should be refused`);
      assert.equal(result.outcome, "INVALID_QUANTITY");
    }
    const unknown = await f.saveFix({ inner: "TURQUOISE" });
    assert.equal(unknown.accepted, false);
    assert.equal(unknown.outcome, "UNKNOWN_COLOUR");

    const blank = await f.saveFix({ inner: "   " });
    assert.equal(blank.accepted, false);
    assert.equal(blank.outcome, "UNKNOWN_COLOUR");

    assert.equal(f.program(), null);
  });
});

test("a program can hold fix runs and upper runs together, counted apart", async () => {
  await withFixture(async (f) => {
    await f.ready();
    await f.saveUpper({ quantity: 10 });
    await f.saveFix({ quantity: 30 });

    const record = f.program()!;
    assert.equal(record.totalQuantity, 10, "only the upper is reserved");
    assert.equal(record.fixQuantity, 30);
    assert.equal(record.productionQuantity, 40, "the machine makes both");
    // The reservation status is judged on the uppers alone, so a fix run can never leave a
    // program that is impossible to finish.
    assert.equal(record.displayStatus, "PROGRAMMED");
    assert.equal(record.runs.length, 2);
  });
});

test("reclassifying a sub group never rewrites a program already saved", async () => {
  await withFixture(async (f) => {
    await f.ready();
    await f.saveFix({ outer: "BLACK", inner: "RED", quantity: 30 });

    // EVR FIX stops being a fix sub group tomorrow.
    f.db.setProductSubGroupHasNoUpper(f.evrFix, false);

    const run = f.program()?.runs[0];
    assert.equal(run?.innerSoleColour, "RED", "yesterday's run is still the run it was made as");
    assert.equal(run?.fixQuantity, 30);
  });
});

// ─── The cartons a fix article is owed ───────────────────────────────────────
// A fix article has no upper, so nothing ever leaves the store for it and there is no issued
// packet to hang a carton label on. What it is owed is its PLAN: 32 DOZEN is 64 cartons.

test("a fix run is owed cartons for what it PLANS, two to the dozen", async () => {
  await withFixture(async (f) => {
    await f.ready();
    await f.saveFix({ outer: "WHITE", inner: "BLACK", quantity: 32 });

    const [run] = f.fixCartons();
    assert.equal(run.article, "EVR9");
    assert.equal(run.size, "7/10");
    assert.equal(run.outerSoleColour, "WHITE", "the carton carries the OUTER sole, which is what is sold");
    assert.equal(run.innerSoleColour, "BLACK");
    assert.equal(run.quantity, 32);
    assert.equal(run.cartonsPlanned, 64);
    assert.equal(run.cartonsToPrint, 64);
    assert.equal(run.cartonNote, null);
    assert.deepEqual(run.labels, []);
  });
});

test("printing a fix run generates exactly its cartons, against the outer sole", async () => {
  await withFixture(async (f) => {
    await f.ready();
    await f.saveFix({ outer: "WHITE", inner: "BLACK", quantity: 32 });
    const [run] = f.fixCartons();

    const printed = f.printFixCartons(run.runId);
    assert.equal(printed.qrCodes.length, 64, "32 dozen is 64 cartons");
    assert.equal(printed.batch.article, "EVR9");
    assert.equal(printed.batch.color, "WHITE");
    assert.equal(printed.batch.size, "7/10");

    // The print is on the record, and the run is no longer owed anything.
    const after = f.fixCartons()[0];
    assert.equal(after.cartonsToPrint, 0);
    assert.equal(after.labels.length, 1);
    assert.equal(after.labels[0].cartonCount, 64);
    assert.equal(after.labels[0].printedBy, ACTOR);
    assert.equal(after.labels[0].receivedInRun, 0);

    const again = () => f.printFixCartons(run.runId);
    assert.throws(again, /already been labelled/, "a carton identity is permanent — never printed twice");
    assert.equal(
      Number(f.raw.prepare("SELECT COUNT(*) AS n FROM machine_program_fix_carton_labels").get().n),
      1
    );
  });
});

test("raising the quantity afterwards owes only the difference", async () => {
  await withFixture(async (f) => {
    await f.ready();
    await f.saveFix({ outer: "WHITE", inner: "BLACK", quantity: 32 });
    f.printFixCartons(f.fixCartons()[0].runId);

    // The same article saved again CHANGES the run (never duplicates it), so this is 40 planned.
    await f.saveFix({ outer: "WHITE", inner: "BLACK", quantity: 40 });
    const run = f.fixCartons()[0];
    assert.equal(run.cartonsPlanned, 80);
    assert.equal(run.cartonsToPrint, 16, "64 are already labelled");

    const printed = f.printFixCartons(run.runId);
    assert.equal(printed.qrCodes.length, 16);
    assert.equal(f.fixCartons()[0].cartonsToPrint, 0);
    assert.equal(f.fixCartons()[0].labels.length, 2);
  });
});

test("a fix run that does not come to whole cartons is sent to QR Generator, never rounded", async () => {
  await withFixture(async (f) => {
    await f.ready();
    // Half a dozen IS a carton, so 32.5 would be a fine 65. A quarter dozen is not.
    await f.saveFix({ outer: "WHITE", inner: "BLACK", quantity: 32.25 });

    const run = f.fixCartons()[0];
    assert.equal(run.cartonsPlanned, null);
    assert.equal(run.cartonsToPrint, 0);
    assert.match(run.cartonNote ?? "", /whole cartons of DOZEN/);
    assert.throws(() => f.printFixCartons(run.runId), /whole cartons of DOZEN/);
  });
});

test("an upper run is not offered as a fix run, and a fix run is not offered as a packet", async () => {
  await withFixture(async (f) => {
    await f.ready();
    await f.saveUpper({ quantity: 10 });
    await f.saveFix({ outer: "WHITE", inner: "BLACK", quantity: 32 });

    const programId = f.program()!.id;
    assert.deepEqual(f.fixCartons().map((run) => run.article), ["EVR9"], "only the fix run");
    assert.deepEqual(
      f.db.listMachineProgramCartonPackets(programId),
      [],
      "and nothing has been issued, so no packet is owed cartons"
    );
  });
});

test("a fix carton scanned back in finds the program it was printed for", async () => {
  await withFixture(async (f) => {
    await f.ready();
    await f.saveFix({ outer: "WHITE", inner: "BLACK", quantity: 2 });
    const printed = f.printFixCartons(f.fixCartons()[0].runId);
    assert.equal(printed.qrCodes.length, 4);

    // Store In asks this question of every carton scanned against an open program.
    const origin = await f.db.runInTransaction(async (tx) => f.db.findMachineProgramOfCartonQr(printed.qrCodes[0].id, tx));
    assert.equal(origin?.programId, f.program()!.id);
    assert.equal(origin?.closed, false);
  });
});

// ─── The whole journey, end to end ───────────────────────────────────────────
// What the owner asked to have confirmed on 2026-10-12:
//
//   machine program made -> Store Out prints the carton QRs -> Store In scans one
//     -> it is PRODUCED (the Daily Production page counts it) -> Current Stock goes up
//
// Every step is driven through the same use case the screen calls, and every figure is read
// back through the same query the page reads.

test("EVR FIX: program -> carton labels -> scanned back -> produced -> in stock", async () => {
  await withFixture(async (f) => {
    await f.ready();

    // 1. THE PROGRAM. 32 DOZEN of a fix article: two soles, no upper, nothing reserved.
    const saved = await f.saveFix({ outer: "WHITE", inner: "BLACK", quantity: 32 });
    assert.equal(saved.accepted, true, saved.reason);
    const programId = f.program()!.id;
    assert.equal(f.program()!.totalQuantity, 0, "a fix run reserves nothing");
    assert.equal(f.program()!.fixQuantity, 32);

    // 2. STORE OUT PRINTS THE CARTON QRs. 32 dozen is 64 cartons, owed by the plan.
    const [run] = f.fixCartons();
    assert.equal(run.cartonsToPrint, 64);
    const cartons = f.printFixCartons(run.runId).qrCodes.map((qr) => qr.id);
    assert.equal(cartons.length, 64);
    assert.match(cartons[0], /^EVR9_WHITE_7\/10_\d{6}$/, "the identity is the article, the OUTER sole and the size");

    // 3. STORE IN SCANS ONE BACK.
    const received = await f.cartonIn.execute({ programId, rawScan: cartons[0], context: CONTEXT, actor: ACTOR });
    assert.equal(received.outcome, "RECEIVED", received.reason);
    assert.equal(received.producedNow, true);

    // 4. PRODUCED — one transaction wrote the production and the store-in.
    const events = f.raw
      .prepare("SELECT event_type FROM production_events WHERE qr_id = ? ORDER BY rowid")
      .all(cartons[0]) as Array<{ event_type: string }>;
    assert.deepEqual(events.map((event) => event.event_type), ["PRODUCED", "MOVED"]);

    // The Daily Production page reads getReport. One carton is one unit of production.
    const report = f.db.getReport("DAILY");
    assert.equal(report.totalProduction, 1);
    assert.deepEqual(report.byArticle.map((row) => [row.key, row.quantity]), [["EVR9", 1]]);
    assert.deepEqual(report.byColor.map((row) => [row.key, row.quantity]), [["WHITE", 1]]);

    // The page itself asks for ONE operational day (06:00 to 06:00), so ask the way it does.
    const operationalDate = (() => {
      const now = new Date();
      if (now.getHours() < 6) now.setDate(now.getDate() - 1);
      return now.toISOString().slice(0, 10);
    })();
    assert.equal(f.db.getReport("CUSTOM", operationalDate, operationalDate).totalProduction, 1);

    // 5. CURRENT STOCK. The Stock page reads listInventory.
    const stock = f.db.listInventory("EVR9");
    assert.equal(stock.length, 1, "one variant: EVR9 7/10 WHITE");
    assert.equal(stock[0].color, "WHITE");
    assert.equal(stock[0].quantity, 1, "the carton is in the store");
    assert.equal(stock[0].storeQuantity, 1);

    // And a second carton moves it to 2 — the chain is not a one-off.
    await f.cartonIn.execute({ programId, rawScan: cartons[1], context: CONTEXT, actor: ACTOR });
    assert.equal(f.db.getReport("DAILY").totalProduction, 2);
    assert.equal(f.db.listInventory("EVR9")[0].quantity, 2);
  });
});

// ─── Closing an EVR FIX program against its cartons ──────────────────────────
// Reported 2026-10-12: 1 of 20 fix cartons back, and Complete Program said "0 of 0 cartons back —
// every carton due is back", because it only counted cartons owed for UPPERS. A fix run's cartons
// are owed by its plan and must be counted, and a short one can never close as COMPLETE.

test("Complete Program counts a fix run's cartons: 1 of 20 back is 1 of 20, not 0 of 0", async () => {
  await withFixture(async (f) => {
    await f.ready();
    await f.saveFix({ outer: "BLACK", inner: "RED", quantity: 10 });
    const programId = f.program()!.id;
    const cartons = f.printFixCartons(f.fixCartons()[0].runId).qrCodes.map((qr) => qr.id);
    const received = await f.cartonIn.execute({ programId, rawScan: cartons[0], context: CONTEXT, actor: ACTOR });
    assert.equal(received.outcome, "RECEIVED", received.reason);

    const view = f.db.getMachineProgramReconciliation(programId)!;
    assert.equal(view.cartonsDue, 20);
    assert.equal(view.cartonsBack, 1);
    assert.equal(view.fixCartonsShort, 19);
    assert.deepEqual(view.fixRuns.map((run) => [run.article, run.cartonsDue, run.cartonsBack]), [["EVR9", 20, 1]]);
    // The program CANNOT close while a fix carton is out (owner, 2026-10-12) — not even short.
    assert.match(view.blockedReason ?? "", /19 EVR FIX cartons are still to come back/);
    assert.throws(
      () => f.db.completeMachineProgramProduction({ programId, entries: [], closedBy: ACTOR, deviceId: "device-1" }),
      /cannot close until every carton is back/
    );
    assert.equal(f.db.isMachineProgramClosed(programId), false);
    // Turning the missing labels into B cartons stays open while it is blocked.
    assert.equal(f.db.convertFixCartonsToB({ programId, runId: f.fixCartons()[0].runId, count: 19, convertedBy: ACTOR, deviceId: "device-1" }).qrCodes.length, 19);
  });
});

test("a fix program with every carton back closes COMPLETE", async () => {
  await withFixture(async (f) => {
    await f.ready();
    await f.saveFix({ outer: "BLACK", inner: "RED", quantity: 1 });
    const programId = f.program()!.id;
    const cartons = f.printFixCartons(f.fixCartons()[0].runId).qrCodes.map((qr) => qr.id);
    for (const rawScan of cartons) await f.cartonIn.execute({ programId, rawScan, context: CONTEXT, actor: ACTOR });

    const view = f.db.getMachineProgramReconciliation(programId)!;
    assert.equal(view.cartonsDue, 2);
    assert.equal(view.cartonsBack, 2);
    assert.equal(view.fixCartonsShort, 0);
    assert.equal(f.db.completeMachineProgramProduction({ programId, entries: [], closedBy: ACTOR, deviceId: "device-1" }).outcome, "COMPLETE");
  });
});

// ─── B cartons: the labels that did not come back, labelled again as MIX / B ─────────────
// The owner's flow (2026-10-12): 20 labels printed, 10 back. "Where are the other 10?" They came
// off the machine in mixed colours — B cartons. Reconciliation turns the 10 labels not back into
// 10 new labels (MIX, grade B); those are scanned in, and the program completes.

test("B cartons: the labels not back are voided and relabelled MIX / B, and scanning them completes the program", async () => {
  await withFixture(async (f) => {
    await f.ready();
    await f.saveFix({ outer: "BLACK", inner: "RED", quantity: 10 });
    const programId = f.program()!.id;
    const runId = f.fixCartons()[0].runId;
    const originals = f.printFixCartons(runId).qrCodes.map((qr) => qr.id);
    for (const rawScan of originals.slice(0, 10)) await f.cartonIn.execute({ programId, rawScan, context: CONTEXT, actor: ACTOR });

    const before = f.db.getMachineProgramReconciliation(programId)!;
    assert.equal(before.fixRuns[0].convertible, 10);

    const b = f.db.convertFixCartonsToB({ programId, runId, count: 10, convertedBy: ACTOR, deviceId: "device-1" });
    assert.equal(b.qrCodes.length, 10);
    assert.match(b.qrCodes[0].id, /^EVR9_MIX_7\/10_\d{6}$/, "same article and size, colour MIX");
    assert.deepEqual([...b.voidedQrIds].sort(), [...originals.slice(10)].sort(), "exactly the 10 that did not come back");
    assert.equal((f.raw.prepare("SELECT grade FROM qr_batches WHERE id = ?").get(b.batch.id) as { grade: string }).grade, "B");

    // A converted label can never be stored in afterwards — it would be counted twice.
    const stale = await f.cartonIn.execute({ programId, rawScan: originals[15], context: CONTEXT, actor: ACTOR });
    assert.equal(stale.accepted, false);
    assert.equal(stale.outcome, "VOIDED");

    // The B run replaces labels; it never shows as more cartons to print for the plan.
    assert.equal(f.fixCartons()[0].cartonsToPrint, 0);
    assert.equal(f.fixCartons()[0].labels.find((label) => label.grade === "B")?.colour, "MIX");

    for (const qr of b.qrCodes) {
      const received = await f.cartonIn.execute({ programId, rawScan: qr.id, context: CONTEXT, actor: ACTOR });
      assert.equal(received.outcome, "RECEIVED", received.reason);
    }
    const after = f.db.getMachineProgramReconciliation(programId)!;
    assert.equal(after.cartonsBack, 20);
    assert.equal(after.fixRuns[0].bCartons, 10);
    assert.equal(after.fixRuns[0].bBack, 10);
    assert.equal(after.fixCartonsShort, 0);
    assert.equal(f.db.completeMachineProgramProduction({ programId, entries: [], closedBy: ACTOR, deviceId: "device-1" }).outcome, "COMPLETE");
  });
});

test("B cartons: never more than are missing, the last serials first, and a label is never converted twice", async () => {
  await withFixture(async (f) => {
    await f.ready();
    await f.saveFix({ outer: "BLACK", inner: "RED", quantity: 2.5 });
    const programId = f.program()!.id;
    const runId = f.fixCartons()[0].runId;
    const originals = f.printFixCartons(runId).qrCodes.map((qr) => qr.id); // 5 labels: 0001..0005
    for (const rawScan of originals.slice(0, 3)) await f.cartonIn.execute({ programId, rawScan, context: CONTEXT, actor: ACTOR });

    assert.throws(() => f.db.convertFixCartonsToB({ programId, runId, count: 3, convertedBy: ACTOR, deviceId: "device-1" }), /at most 2/);
    assert.throws(() => f.db.convertFixCartonsToB({ programId, runId, count: 0, convertedBy: ACTOR, deviceId: "device-1" }), /at least 1/);

    const one = f.db.convertFixCartonsToB({ programId, runId, count: 1, convertedBy: ACTOR, deviceId: "device-1" });
    assert.deepEqual(one.voidedQrIds, [originals[4]], "0005 first");
    const two = f.db.convertFixCartonsToB({ programId, runId, count: 1, convertedBy: ACTOR, deviceId: "device-1" });
    assert.deepEqual(two.voidedQrIds, [originals[3]], "then 0004");
    assert.throws(() => f.db.convertFixCartonsToB({ programId, runId, count: 1, convertedBy: ACTOR, deviceId: "device-1" }), /nothing to make B/);
  });
});
