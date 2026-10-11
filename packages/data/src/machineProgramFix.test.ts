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

  const saveFix = (input: { articleSizeId?: string; outer?: string; inner?: string; quantity?: number; injectorNo?: number }) =>
    useCases.saveFix.execute({
      machineId: machine.id,
      programDate: TODAY,
      injectorNo: input.injectorNo ?? 1,
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

  return {
    db, raw, machine, sk6, evr9, black, casual, evrFix, group,
    ready, saveFix, saveUpper, program, balanceOf,
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

test("the same fix article on an injector is CHANGED, never duplicated", async () => {
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
