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
  ReturnMachineProgramUpperUseCase,
  SaveMachineProgramBatchUseCase,
  SaveMachineProgramLineUseCase,
} from "@erp/application";
import { CLAIM_PARTY_ROLE, type UpperClaim } from "@erp/domain";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { UuidGenerator } from "./idGenerator.js";

// Reconciling an UPPER line, the owner's worked example (2026-10-13):
//
//   SK6 7/10 · BLACK sole · RED upper · 6 DOZEN out in three 2-DOZEN packets = 12 cartons due
//   6 cartons come back                                   → 36 pairs to account for
//   a sealed 2-DOZEN packet is scanned back (Return Upper) → stock + 2 DOZEN, 12 pairs left
//   1 missing carton came back as B (MIX label)            → 6 pairs left
//   on closing: 5 cut size pairs + 1 pair claimed           → nothing left
//
// Every step against the real database, the way the screens make it.

const CONTEXT = { factoryId: "factory-1", workstationId: "workstation-1", deviceId: "device-1" };
const ACTOR = "aslam";
const DATE = "2026-10-13";

type Raw = import("node:sqlite").DatabaseSync;

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-upper-recon-"));
  const dbPath = path.join(tempDir, "erp.db");
  const open = () => {
    const db = new SqliteDatabase({ dbPath, schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
    db.ensureOperationalContext({
      factoryId: "factory-1", factoryCode: "F001", factoryName: "Factory",
      workstationId: "workstation-1", workstationCode: "WS001", workstationName: "WS",
      deviceId: "device-1", deviceName: "Device", appVersion: "1.0.0",
    });
    return db;
  };
  const db = open();
  const raw = (db as unknown as { db: Raw }).db;
  const depsOf = (target: SqliteDatabase) => ({ txManager: target, repo: target, eventPublisher: new InMemoryEventBus(), idGenerator: new UuidGenerator() });
  const deps = depsOf(db);

  const dozen = db.createInventoryUnit({ code: "DOZEN", name: "Dozen", unitFamily: "COUNT" });
  const section = db.createWorkSection({ name: "Packing" });
  const machine = db.createMachine({ name: "Machine 1", sectionId: section.id });
  const party = (partyName: string, partyType: string, mobile: string) =>
    db.createParty({ partyName, partyType, city: "Lahore", mobileNumber: mobile, status: "ACTIVE" });
  const machineContractor = party("CONTRACTOR A", "CONTRACTOR", "0300-1111111");
  const packingContractor = party("CONTRACTOR B", "CONTRACTOR", "0300-2222222");
  const supplier = party("ABC UPPER", "SUPPLIER", "0300-3333333");
  const otherSupplier = party("XYZ UPPER", "SUPPLIER", "0300-4444444");

  db.createProduct({ article: "SK6", size: "7/10", sellingPrice: 550, status: "ACTIVE" });
  const sizeId = (raw.prepare("SELECT id FROM article_sizes WHERE article = 'SK6' AND size = '7/10'").get() as { id: string }).id;

  // A sole is moulded from Dana, so BLACK is a sole colour once there is BLACK Dana.
  const dana = db.createInventoryCategory({ name: "DANA" });
  db.addInventoryCategoryField({ categoryId: dana, fieldKey: "color", label: "COLOR", fieldType: "TEXT", required: true });
  db.createInventoryItem({ categoryId: dana, values: { color: "BLACK" }, unitId: dozen });

  const upperRoot = db.createInventoryCategory({ name: "UPPER" });
  const category = db.createInventoryCategory({ name: "RAGZINE UPPER", parentId: upperRoot });
  ["article", "color", "size"].forEach((fieldKey, index) =>
    db.addInventoryCategoryField({ categoryId: category, fieldKey, label: fieldKey.toUpperCase(), fieldType: "TEXT", required: true, sortOrder: index + 1 })
  );
  const upper = db.createInventoryItem({ categoryId: category, values: { article: "SK6", color: "RED", size: "7/10" }, unitId: dozen }).id;
  db.setRawMaterialMovementConfig(upper, { packName: "PACKET", packingQuantity: 2, packingUnitId: dozen });

  const balance = (itemId: string): number =>
    Number((raw.prepare("SELECT quantity_on_hand AS q FROM inventory_stock_balances WHERE item_id = ?").get(itemId) as { q: number } | undefined)?.q ?? 0);

  return {
    db, raw, dbPath, open, depsOf, supplier, otherSupplier, machineContractor, packingContractor, upper, balance,
    returnUpper: (target: SqliteDatabase, programId: string, rawScan: string) =>
      new ReturnMachineProgramUpperUseCase(depsOf(target)).execute({ programId, rawScan, context: CONTEXT, actor: ACTOR }),
    cartonIn: (programId: string, rawScan: string) =>
      new ReceiveMachineProgramCartonUseCase({
        txManager: db, duplicateChecker: db, qrRegistry: db, productCatalog: db, qrMasterRepo: db,
        productionEventsRepo: db, stockProjectionRepo: db, outboxRepo: db, qrLookupRepo: db, gatepassRepo: db,
        storeEntryEventsRepo: db, cartonOriginRepo: db, eventPublisher: new InMemoryEventBus(), idGenerator: new UuidGenerator(),
      }).execute({ programId, rawScan, context: CONTEXT, actor: ACTOR }),
    /** Receives `count` 2-DOZEN packets of the upper from a supplier. */
    stockIn: async (count: number, partyId = supplier): Promise<string[]> => {
      const session = db.startRawMaterialReceivingSession({ partyId, deviceId: "device-1", startedBy: ACTOR });
      const qrIds = db.generateRawMaterialQrBatch({ partyId, itemId: upper, quantity: count, packingQuantity: 2 }).qrCodes.map((qr) => qr.id);
      for (const qrId of qrIds) {
        const result = await new ReceiveRawMaterialScanUseCase(deps).execute({ rawScan: qrId, partyId, sessionId: session.id, context: CONTEXT, actor: ACTOR });
        assert.equal(result.outcome, "RECEIVED", result.reason);
      }
      db.closeRawMaterialReceivingSession(session.id);
      return qrIds;
    },
    /** MP-000001: 6 DOZEN of the RED upper on a BLACK sole, both contractors assigned. */
    program: async (): Promise<string> => {
      const assign = new AssignMachineContractorUseCase(deps);
      await assign.execute({ machineId: machine.id, role: "MACHINE", contractorPartyId: machineContractor, actor: ACTOR });
      await assign.execute({ machineId: machine.id, role: "PACKING", contractorPartyId: packingContractor, actor: ACTOR });
      const saved = await new SaveMachineProgramLineUseCase(deps).execute({
        machineId: machine.id, programDate: DATE, injectorNo: 1, run: { soleColour: "BLACK", articleSizeId: sizeId }, itemId: upper, quantity: 6, actor: ACTOR,
      });
      assert.equal(saved.outcome, "SAVED", saved.reason);
      return saved.programId!;
    },
    issue: async (programId: string, qrIds: string[]) => {
      const session = db.startOrResumeRawMaterialIssueSession({ deviceId: "device-1", startedBy: ACTOR });
      const saved = await new SaveMachineProgramBatchUseCase(deps).execute({
        programId, batchKey: `batch-${Math.random().toString(16).slice(2)}`, sessionId: session.id, qrIds, context: CONTEXT, actor: ACTOR, deviceId: "device-1",
      });
      assert.equal(saved.accepted, true, saved.reason);
    },
    view: (programId: string) => db.getMachineProgramReconciliation(programId)!,
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

/** The worked example up to the reconciliation: 6 DOZEN out, 12 labels printed, 6 cartons back. */
const sixCartonsBack = async (f: Fixture) => {
  const packets = await f.stockIn(5);
  const programId = await f.program();
  await f.issue(programId, packets.slice(0, 3));
  const owed = f.db.listMachineProgramCartonPackets(programId).filter((packet) => !packet.label);
  const labels = f.db.printMachineProgramCartons({ programId, eventIds: owed.map((packet) => packet.eventId), printedBy: ACTOR, deviceId: "device-1" }).qrCodes.map((qr) => qr.id);
  assert.equal(labels.length, 12, "6 DOZEN is 12 cartons");
  for (const label of labels.slice(0, 6)) assert.equal((await f.cartonIn(programId, label)).outcome, "RECEIVED");
  return { programId, packets, labels, lineId: f.view(programId).lines[0].lineId };
};

const claim = (overrides: Partial<UpperClaim> = {}): UpperClaim => ({
  role: CLAIM_PARTY_ROLE.SUPPLIER, supplierPartyId: null, pairs: 1, ratePaisa: 5_000, reason: "torn upper", ...overrides,
});

const voidCount = (f: Fixture, ids: string[]): number =>
  ids.filter((id) => (f.raw.prepare("SELECT status FROM qr_codes WHERE id = ?").get(id) as { status: string }).status === "VOID").length;

test("A — 12 cartons due, 6 back: 6 cartons = 36 pairs to account for", async () => {
  await withFixture(async (f) => {
    const { programId } = await sixCartonsBack(f);
    const [line] = f.view(programId).lines;
    assert.deepEqual(
      { issued: line.issuedCartons, returned: line.returnedUpperCartons, due: line.cartonsDue, back: line.cartonsBack, missing: line.missingCartons, pairs: line.shortfallUppers },
      { issued: 12, returned: 0, due: 12, back: 6, missing: 6, pairs: 36 }
    );
  });
});

test("B, C — a sealed packet returned restores its stock once; the same scan twice credits nothing", async () => {
  await withFixture(async (f) => {
    const { programId, packets } = await sixCartonsBack(f);
    const before = f.balance(f.upper);

    // The third packet's cartons are the last printed, and none of them is back: it is sealed.
    const returned = await f.returnUpper(f.db, programId, packets[2]);
    assert.equal(returned.outcome, "RECEIVED", returned.reason);
    assert.equal(f.balance(f.upper), before + 2, "2 DOZEN back on the shelf");
    const [line] = f.view(programId).lines;
    assert.deepEqual({ returned: line.returnedUpperCartons, due: line.cartonsDue, missing: line.missingCartons, pairs: line.shortfallUppers }, { returned: 4, due: 8, missing: 2, pairs: 12 });

    const again = await f.returnUpper(f.db, programId, packets[2]);
    assert.equal(again.outcome, "ALREADY_IN_STORE");
    assert.equal(f.balance(f.upper), before + 2, "a second scan credits nothing");
    assert.equal(f.view(programId).lines[0].shortfallUppers, 12);
  });
});

test("Return Upper refuses a packet that was opened, never went out for this program, or belongs to a closed one", async () => {
  await withFixture(async (f) => {
    const { programId, packets } = await sixCartonsBack(f);
    const opened = await f.returnUpper(f.db, programId, packets[0]);
    assert.equal(opened.outcome, "CARTONS_BACK", "the first packet's 4 cartons are back");
    const stillHere = await f.returnUpper(f.db, programId, packets[4]);
    assert.equal(stillHere.outcome, "ALREADY_IN_STORE", "never issued at all");
    const wrongProgram = await f.returnUpper(f.db, "not-a-program", packets[2]);
    assert.equal(wrongProgram.outcome, "NOT_ON_PROGRAM");
    const carton = await f.returnUpper(f.db, programId, "SK6_BLACKRED_7/10_000001");
    assert.equal(carton.outcome, "INVALID_FORMAT");
    assert.equal(f.view(programId).lines[0].shortfallUppers, 36, "nothing was credited");
  });
});

test("K — two terminals return the same packet at once: it is credited exactly once", async () => {
  await withFixture(async (f) => {
    const { programId, packets } = await sixCartonsBack(f);
    const before = f.balance(f.upper);
    // Two computers, each on its own connection to the one file. SQLite serialises their
    // BEGIN IMMEDIATE, so one of them is simply second — and finds the packet already home.
    const other = f.open();
    try {
      const first = await f.returnUpper(f.db, programId, packets[2]);
      const second = await f.returnUpper(other, programId, packets[2]);
      assert.equal(first.outcome, "RECEIVED");
      assert.equal(second.outcome, "ALREADY_IN_STORE");
    } finally {
      other.close();
    }
    assert.equal(f.balance(f.upper), before + 2);
  });
});

test("F — B carton: MIX labels printed, every original not back voided and traced, and it counts once scanned in", async () => {
  await withFixture(async (f) => {
    const { programId, packets, labels, lineId } = await sixCartonsBack(f);
    await f.returnUpper(f.db, programId, packets[2]); // 2 cartons missing now

    const convert = (count: number) => f.db.convertUpperCartonsToB({ programId, lineId, count, convertedBy: ACTOR, deviceId: "device-1" });
    assert.throws(() => convert(3), /at most 2/);
    assert.throws(() => convert(0), /at least 1/);

    const b = convert(1);
    assert.equal(b.qrCodes.length, 1);
    assert.equal(b.batch.color, "MIX");
    assert.deepEqual(b.voidedQrIds.sort(), labels.slice(6).sort(), "all 6 originals not back are cancelled (the owner's rule)");
    assert.equal(voidCount(f, labels.slice(6)), 6);
    assert.equal(voidCount(f, labels.slice(0, 6)), 0, "cartons already back are untouched");
    const traced = f.raw.prepare("SELECT COUNT(*) AS n FROM machine_program_b_conversions WHERE b_qr_batch_id = ?").get(b.batch.id) as { n: number };
    assert.equal(traced.n, 6, "each original says which B run replaced it");

    // Printed but not scanned in: it stands for a carton, and the program cannot close yet.
    let view = f.view(programId);
    assert.deepEqual({ b: view.lines[0].bCartons, bBack: view.lines[0].bBack, missing: view.lines[0].missingCartons }, { b: 1, bBack: 0, missing: 1 });
    assert.match(view.blockedReason ?? "", /B carton .* not scanned in yet/);

    assert.equal((await f.cartonIn(programId, b.qrCodes[0].id)).outcome, "RECEIVED");
    view = f.view(programId);
    assert.deepEqual({ back: view.lines[0].cartonsBack, missing: view.lines[0].missingCartons, pairs: view.lines[0].shortfallUppers }, { back: 7, missing: 1, pairs: 6 });
    assert.equal(view.blockedReason, null);
  });
});

test("D, E, G — the owner's example closes: cut size, a claim on the supplier's ledger, and every pair once", async () => {
  await withFixture(async (f) => {
    f.db.bootstrapFirstAdmin("owner", "Password123");
    const { programId, packets, lineId } = await sixCartonsBack(f);
    await f.returnUpper(f.db, programId, packets[2]);
    const b = f.db.convertUpperCartonsToB({ programId, lineId, count: 1, convertedBy: ACTOR, deviceId: "device-1" });
    await f.cartonIn(programId, b.qrCodes[0].id);

    // 6 pairs remain: 3 cut size pairs + 2 cut size uppers + 1 claimed.
    const close = (entry: { cutSizeUppers: number; cutSizePairs: number; claims: UpperClaim[] }) =>
      f.db.completeMachineProgramProduction({ programId, entries: [{ lineId, ...entry }], closedBy: ACTOR, deviceId: "device-1" });
    assert.throws(() => close({ cutSizeUppers: 0, cutSizePairs: 5, claims: [] }), /1 of the 6 remaining pairs/);
    assert.throws(() => close({ cutSizeUppers: 2, cutSizePairs: 3, claims: [claim({ supplierPartyId: f.otherSupplier })] }), /supplier whose uppers went out/);
    assert.equal(f.db.isMachineProgramClosed(programId), false);
    assert.equal((f.raw.prepare("SELECT COUNT(*) AS n FROM party_claims").get() as { n: number }).n, 0, "a refused close posts no claim");

    const closed = close({ cutSizeUppers: 2, cutSizePairs: 3, claims: [claim({ supplierPartyId: f.supplier })] });
    assert.equal(closed.outcome, "RECONCILED");

    const cutStock = f.raw
      .prepare(
        `SELECT ii.display_name, b.quantity_on_hand, u.code FROM inventory_items ii
           JOIN inventory_stock_balances b ON b.item_id = ii.id JOIN inventory_units u ON u.id = b.unit_id
          WHERE ii.display_name LIKE 'CUT SIZE%' ORDER BY ii.display_name`
      )
      .all() as Array<{ display_name: string; quantity_on_hand: number; code: string }>;
    assert.deepEqual(cutStock.map((row) => [row.quantity_on_hand, row.code]), [[3, "PAIR"], [2, "PAIR"]], "cut size pairs, then cut size uppers, in pairs");
    assert.match(cutStock[0].display_name, /CUT SIZE PAIRS/);
    assert.match(cutStock[1].display_name, /CUT SIZE UPPER/);

    const saved = f.view(programId).lines[0].saved!;
    assert.deepEqual(
      { cutUppers: saved.cutSizeUppers, cutPairs: saved.cutSizePairs, returned: saved.returnedUpperPairs, b: saved.bCartons },
      { cutUppers: 2, cutPairs: 3, returned: 24, b: 1 }
    );
    // 72 pairs out = 36 back as cartons + 24 returned + 6 as a B carton + 3 + 2 cut size + 1 claimed.
    assert.equal(36 + saved.returnedUpperPairs + saved.bCartons * 6 + saved.cutSizePairs + saved.cutSizeUppers + saved.claims[0].pairs, 72);

    const ledger = f.db.getSupplierLedger(f.supplier);
    const claimRow = ledger.entries.find((entry) => entry.voucherType === "CLAIM")!;
    assert.equal(claimRow.voucherNumber, "CL-000001");
    assert.equal(claimRow.debitAmount, 50, "Rs 50 deducted from what we owe ABC UPPER");
    assert.match(claimRow.description, /MP-000001 · 1 pair of .* — torn upper/);
    const balance = f.db.listSupplierBalances().rows.find((row) => row.partyId === f.supplier)!;
    assert.equal(balance.balance, -50);

    const notice = f.raw.prepare("SELECT message FROM user_notifications WHERE kind = 'MACHINE_PROGRAM_RECONCILED'").get() as { message: string };
    assert.match(notice.message, /1 pair of SK6 7\/10 RED claimed to ABC UPPER for Rs 50.00 — "torn upper"/);
  });
});

test("a claim against the packing contractor stands on the contractor ledger as a deduction", async () => {
  await withFixture(async (f) => {
    const { programId, packets, lineId } = await sixCartonsBack(f);
    await f.returnUpper(f.db, programId, packets[2]);
    f.db.completeMachineProgramProduction({
      programId,
      entries: [{ lineId, cutSizeUppers: 0, cutSizePairs: 10, claims: [claim({ role: CLAIM_PARTY_ROLE.PACKING, pairs: 2, ratePaisa: 2_500, reason: "lost at packing" })] }],
      closedBy: ACTOR,
      deviceId: "device-1",
    });
    const ledger = f.db.getContractorLedger(f.packingContractor, { fromDate: "2000-01-01", toDate: "2999-12-31" });
    const claimed = ledger.entries.find((entry) => entry.kind === "CLAIM");
    assert.ok(claimed, "the claim is on the packing contractor's ledger");
    assert.equal(claimed.debitPaisa, 5_000, "2 pairs × Rs 25");
    assert.equal(ledger.claimedPaisa, 5_000);
    assert.equal(ledger.paidPaisa, 0, "a claim is not a payment");
  });
});

test("closing voids every original label still out, so none can be produced or stored in later", async () => {
  await withFixture(async (f) => {
    const { programId, packets, labels, lineId } = await sixCartonsBack(f);
    await f.returnUpper(f.db, programId, packets[2]);
    f.db.completeMachineProgramProduction({ programId, entries: [{ lineId, cutSizeUppers: 12, cutSizePairs: 0, claims: [] }], closedBy: ACTOR, deviceId: "device-1" });
    assert.equal(voidCount(f, labels.slice(6)), 6);
    assert.equal(voidCount(f, labels.slice(0, 6)), 0);
    const late = await f.cartonIn(programId, labels[11]);
    assert.equal(late.accepted, false);
  });
});

test("I — a close that fails part-way writes nothing: no closure, no stock, no claim", async () => {
  await withFixture(async (f) => {
    const { programId, packets, lineId } = await sixCartonsBack(f);
    await f.returnUpper(f.db, programId, packets[2]);
    // The cut size material's unit is taken by another unit's stock first, so receiving cut size
    // fails AFTER the closure row and the claim have been written — and all of it must roll back.
    f.raw.prepare("INSERT INTO inventory_units (id, code, name, unit_family, decimal_scale, created_at, updated_at) VALUES ('kg', 'KG', 'Kilogram', 'WEIGHT', 0, '', '')").run();
    const cat = f.db.createInventoryCategory({ name: "CUT SIZE PAIRS" });
    f.db.addInventoryCategoryField({ categoryId: cat, fieldKey: "item", label: "ITEM", fieldType: "TEXT", required: true });
    f.db.createInventoryItem({ categoryId: cat, values: { item: "SK6 7/10 BLACK RED" }, unitId: "kg", stockQuantity: 1 });

    assert.throws(() =>
      f.db.completeMachineProgramProduction({
        programId,
        entries: [{ lineId, cutSizeUppers: 0, cutSizePairs: 11, claims: [claim({ supplierPartyId: f.supplier })] }],
        closedBy: ACTOR,
        deviceId: "device-1",
      })
    );
    assert.equal(f.db.isMachineProgramClosed(programId), false);
    assert.equal((f.raw.prepare("SELECT COUNT(*) AS n FROM party_claims").get() as { n: number }).n, 0);
    assert.equal((f.raw.prepare("SELECT COUNT(*) AS n FROM machine_program_reconciliation_lines").get() as { n: number }).n, 0);

    // Recorded the right way — the 11 pairs were loose uppers — the close goes through, and the
    // claim the failed attempt rolled back is posted now, once.
    const closed = f.db.completeMachineProgramProduction({
      programId, entries: [{ lineId, cutSizeUppers: 11, cutSizePairs: 0, claims: [claim({ supplierPartyId: f.supplier })] }], closedBy: ACTOR, deviceId: "device-1",
    });
    assert.equal(closed.outcome, "RECONCILED");
    assert.throws(
      () => f.db.completeMachineProgramProduction({ programId, entries: [], closedBy: ACTOR, deviceId: "device-1" }),
      /already closed/,
      "a retried close never posts twice"
    );
    assert.equal((f.raw.prepare("SELECT COUNT(*) AS n FROM party_claims").get() as { n: number }).n, 1);
  });
});
