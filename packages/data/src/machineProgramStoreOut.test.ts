// Store Out against a Machine Program, driven against a real database by real scans.
//
//   Production plans MP-000001 → the store is notified → the storekeeper opens it →
//   scans into an unsaved batch → Save Batch → stock moves, once, atomically
//
// What these tests are here to pin down:
//
//   * a scan into an unsaved batch moves NOTHING — not the balance, not the packet's status
//   * Save Batch is all-or-nothing, and is idempotent under a repeated request
//   * only the uppers the open program authorises may be issued against it
//   * a PARTIAL batch commits and the program stays resumable; a FULL one closes it
//   * every committed packet is permanently linked to its allocation AND its saved batch
//
// Stock is built the only way it can be built — Raw Material QR Generator → Raw Material Input —
// and every figure is read back through the same repository the screens use. Nothing is asserted
// against a cached number, because there are none: issued and remaining are recomputed from
// raw_material_qr_events every time they are asked for.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AssignMachineContractorUseCase,
  CheckMachineProgramScanUseCase,
  DeleteMachineProgramUseCase,
  InMemoryEventBus,
  IssueRawMaterialScanUseCase,
  OpenMachineProgramForStoreOutUseCase,
  ProcessScanUseCase,
  ReceiveMachineProgramCartonUseCase,
  ReceiveRawMaterialScanUseCase,
  SaveMachineProgramBatchUseCase,
  SaveMachineProgramLineUseCase,
  parseMachineProgramLookup,
} from "@erp/application";
import { MACHINE_PROGRAM_DISPLAY_STATUS, MACHINE_PROGRAM_STATUS, NOTIFICATION_KIND, PERMISSION } from "@erp/domain";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { UuidGenerator } from "./idGenerator.js";

const CONTEXT = { factoryId: "factory-1", workstationId: "workstation-1", deviceId: "device-1" };
const ACTOR = "aslam";
const TODAY = "2026-10-09";

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-mp-store-out-"));
  const dbPath = path.join(tempDir, "erp.db");
  const db = new SqliteDatabase({ dbPath, schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  db.ensureOperationalContext({
    factoryId: "factory-1", factoryCode: "F001", factoryName: "Factory",
    workstationId: "workstation-1", workstationCode: "WS001", workstationName: "WS",
    deviceId: "device-1", deviceName: "Device", appVersion: "1.0.0",
  });

  const deps = { txManager: db, repo: db, eventPublisher: new InMemoryEventBus(), idGenerator: new UuidGenerator() };
  const useCases = {
    assign: new AssignMachineContractorUseCase(deps),
    saveLine: new SaveMachineProgramLineUseCase(deps),
    deleteProgram: new DeleteMachineProgramUseCase(deps),
    receive: new ReceiveRawMaterialScanUseCase(deps),
    issue: new IssueRawMaterialScanUseCase(deps),
    open: new OpenMachineProgramForStoreOutUseCase(deps),
    checkScan: new CheckMachineProgramScanUseCase(deps),
    saveBatch: new SaveMachineProgramBatchUseCase(deps),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- direct schema access for assertions
  const raw = (db as any).db;

  const unitId = db.createInventoryUnit({ code: "DOZEN", name: "Dozen", unitFamily: "COUNT" });
  const packing = db.createWorkSection({ name: "Packing" });
  const machine1 = db.createMachine({ name: "Machine 1", sectionId: packing.id });
  const machine2 = db.createMachine({ name: "Machine 2", sectionId: packing.id });

  const party = (partyName: string, partyType: string, mobile: string) =>
    db.createParty({ partyName, partyType, city: "Lahore", mobileNumber: mobile, status: "ACTIVE" });
  const contractorA = party("CONTRACTOR A", "CONTRACTOR", "0300-1111111");
  const contractorB = party("CONTRACTOR B", "CONTRACTOR", "0300-2222222");
  const supplierA = party("ABC UPPER", "SUPPLIER", "0300-3333333");

  const articleSize = (article: string, size: string): string => {
    db.createProduct({ article, size, sellingPrice: 550, status: "ACTIVE" });
    return (raw.prepare("SELECT id FROM article_sizes WHERE article = ? AND size = ?").get(article, size) as { id: string }).id;
  };
  const sk6_710 = articleSize("SK6", "7/10");

  // UPPER — RAGZINE UPPER: article, colour, size, type. Packed 5 DOZEN to a PACKET.
  const upper = db.createInventoryCategory({ name: "UPPER" });
  const ragzine = db.createInventoryCategory({ name: "RAGZINE UPPER", parentId: upper });
  ["article", "color", "size", "type"].forEach((fieldKey, index) =>
    db.addInventoryCategoryField({ categoryId: ragzine, fieldKey, label: fieldKey.toUpperCase(), fieldType: "TEXT", required: fieldKey !== "type", sortOrder: index + 1 })
  );
  const makeUpper = (article: string, color: string, size: string) => {
    const { id } = db.createInventoryItem({ categoryId: ragzine, values: { article, color, size, type: "SILAI" }, unitId });
    db.setRawMaterialMovementConfig(id, { packName: "PACKET", packingQuantity: 5, packingUnitId: unitId });
    return id;
  };
  const black = makeUpper("SK6", "BLACK", "7/10");
  const red = makeUpper("SK6", "RED", "7/10");
  const green = makeUpper("SK6", "GREEN", "7/10");

  // An upper with NO colour on it — a real shape in the store (a plain rubber upper). It can be
  // issued like any other, but a carton QR identity cannot be built from it.
  const rubber = db.createInventoryCategory({ name: "RUBBER UPPER", parentId: upper });
  ["article", "size"].forEach((fieldKey, index) =>
    db.addInventoryCategoryField({ categoryId: rubber, fieldKey, label: fieldKey.toUpperCase(), fieldType: "TEXT", required: true, sortOrder: index + 1 })
  );
  const colourless = (() => {
    const { id } = db.createInventoryItem({ categoryId: rubber, values: { article: "SK6", size: "7/10" }, unitId });
    db.setRawMaterialMovementConfig(id, { packName: "PACKET", packingQuantity: 5, packingUnitId: unitId });
    return id;
  })();

  /** Prints `count` labels of 5 DOZEN from a supplier and receives every one into the store. */
  const stockIn = async (itemId: string, count: number, partyId = supplierA): Promise<string[]> => {
    const session = db.startRawMaterialReceivingSession({ partyId, deviceId: "device-1", startedBy: ACTOR });
    const qrIds = db.generateRawMaterialQrBatch({ partyId, itemId, quantity: count, packingQuantity: 5 }).qrCodes.map((qr) => qr.id);
    for (const qrId of qrIds) {
      const result = await useCases.receive.execute({ rawScan: qrId, partyId, sessionId: session.id, context: CONTEXT, actor: ACTOR });
      assert.equal(result.outcome, "RECEIVED", `${qrId} should have been received`);
    }
    db.closeRawMaterialReceivingSession(session.id);
    return qrIds;
  };

  const assignBoth = async (machineId: string, runner: string, packer: string) => {
    await useCases.assign.execute({ machineId, role: "MACHINE", contractorPartyId: runner, actor: ACTOR });
    return useCases.assign.execute({ machineId, role: "PACKING", contractorPartyId: packer, actor: ACTOR });
  };

  /** Puts an upper on a NEW sole run of a machine's injector 1 for a date. */
  const program = (input: { machineId?: string; date?: string; itemId: string; quantity: number; soleColour?: string }) =>
    useCases.saveLine.execute({
      machineId: input.machineId ?? machine1.id,
      programDate: input.date ?? TODAY,
      injectorNo: 1,
      run: { soleColour: input.soleColour ?? "BLACK", articleSizeId: sk6_710 },
      itemId: input.itemId,
      quantity: input.quantity,
      actor: ACTOR,
    });

  const openSession = () => db.startOrResumeRawMaterialIssueSession({ deviceId: "device-1", startedBy: ACTOR });

  /** A plain Raw Material Output scan — the storekeeper names no program (the generic station). */
  const plainIssue = (qrId: string) =>
    useCases.issue.execute({ rawScan: qrId, sessionId: openSession().id, context: CONTEXT, actor: ACTOR });

  const saveBatch = (input: { programId: string; qrIds: string[]; batchKey?: string; sessionId?: string | null }) =>
    useCases.saveBatch.execute({
      programId: input.programId,
      batchKey: input.batchKey ?? `batch-${Math.random().toString(16).slice(2)}`,
      sessionId: input.sessionId === undefined ? openSession().id : input.sessionId,
      qrIds: input.qrIds,
      context: CONTEXT,
      actor: ACTOR,
      deviceId: "device-1",
    });

  const check = (programId: string, rawScan: string, batchQrIds: string[] = []) =>
    useCases.checkScan.execute({ programId, rawScan, batchQrIds });

  const balanceOf = (itemId: string): number =>
    Number((raw.prepare("SELECT quantity_on_hand AS q FROM inventory_stock_balances WHERE item_id = ?").get(itemId) as { q: number } | undefined)?.q ?? 0);

  /** A raw material packet's physical lifecycle status (raw_material_qrs, not qr_master). */
  const statusOf = (qrId: string): string =>
    String((raw.prepare("SELECT current_status AS s FROM raw_material_qrs WHERE id = ?").get(qrId) as { s: string } | undefined)?.s ?? "");

  /** Every line of a program, flattened, so a variant's figures can be read by colour. */
  const lines = (programId: string) => {
    const record = db.getMachineProgram(programId);
    assert.ok(record, "the program should be readable");
    return record.runs.flatMap((run) => run.lines);
  };
  const lineFor = (programId: string, itemId: string) => {
    const line = lines(programId).find((candidate) => candidate.itemId === itemId);
    assert.ok(line, "the program should have a line for this upper");
    return line;
  };

  /** An approved account holding exactly one permission, so the notice fan-out can be checked. */
  const userWith = (username: string, permission: string): string => {
    const user = db.createUserAccount(username, "Password123");
    raw.prepare("UPDATE app_users SET access_status = 'APPROVED' WHERE id = ?").run(user.id);
    const role = db.createRole({ name: `${username}-role`, permissions: [permission] });
    db.assignUserRole(user.id, role.code);
    return user.id;
  };

  const noticesFor = (userId: string) =>
    raw
      .prepare("SELECT kind, title, message, entity_id FROM user_notifications WHERE user_id = ? ORDER BY created_at DESC, rowid DESC")
      .all(userId) as Array<{ kind: string; title: string; message: string; entity_id: string }>;

  /** The allocation and saved batch stamped on a packet's STORE_EXIT — the traceability record. */
  const exitStampOf = (qrId: string) =>
    raw
      .prepare(
        `SELECT machine_program_upper_line_id AS line_id, machine_program_batch_id AS batch_id, session_id, actor, quantity, event_ts_local
         FROM raw_material_qr_events WHERE qr_id = ? AND event_type = 'STORE_EXIT' ORDER BY event_ts_local DESC, rowid DESC LIMIT 1`
      )
      .get(qrId) as { line_id: string | null; batch_id: string | null; session_id: string | null; actor: string; quantity: number; event_ts_local: string } | undefined;

  const batchRows = (): Array<{ id: string; batch_key: string; program_id: string; packet_count: number }> =>
    raw.prepare("SELECT id, batch_key, program_id, packet_count FROM machine_program_issue_batches ORDER BY created_at, rowid").all();

  /**
   * A SECOND terminal: its own connection to the same database file, with its own use case.
   *
   * This is what two computers in the store actually are. They never share a transaction — each
   * opens its own BEGIN IMMEDIATE against the one file, so SQLite serialises them and the
   * optimistic status guard inside the batch is what decides who gets a packet.
   */
  const secondTerminal = () => {
    const other = new SqliteDatabase({ dbPath, schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
    const otherDeps = { txManager: other, repo: other, eventPublisher: new InMemoryEventBus(), idGenerator: new UuidGenerator() };
    return {
      db: other,
      saveBatch: new SaveMachineProgramBatchUseCase(otherDeps),
      close: () => other.close(),
    };
  };

  return {
    db, raw, unitId, dbPath, secondTerminal, ...useCases, machine1, machine2, contractorA, contractorB, supplierA,
    sk6_710, black, red, green, colourless,
    stockIn, assignBoth, program, openSession, plainIssue, saveBatch, check,
    balanceOf, statusOf, lines, lineFor, userWith, noticesFor, exitStampOf, batchRows,
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

/**
 * MP-000001 on MACHINE 1: 100 DOZEN of BLACK and 50 DOZEN of RED on the same sole, with 40
 * packets of each in the store (5 DOZEN to a packet, so 200 DOZEN of each is held).
 *
 * This is the worked example from the requirement, in the units this ERP actually counts in.
 */
const readyProgram = async (f: Fixture) => {
  await f.assignBoth(f.machine1.id, f.contractorA, f.contractorB);
  const blackQrs = await f.stockIn(f.black, 40);
  const redQrs = await f.stockIn(f.red, 40);
  const first = await f.program({ itemId: f.black, quantity: 100 });
  assert.equal(first.outcome, "SAVED");
  const second = await f.program({ itemId: f.red, quantity: 50 });
  assert.equal(second.outcome, "SAVED");
  assert.ok(first.programId);
  return { programId: first.programId, blackQrs, redQrs };
};

// ─── Opening a program ────────────────────────────────────────────────────────

test("a program number is one number however it is written, and nothing else is a lookup", () => {
  for (const written of ["MP-000012", "MP000012", "mp-12", "MP 12", "000012", "12"]) {
    assert.deepEqual(parseMachineProgramLookup(written), { kind: "NUMBER", programNumber: 12 }, written);
  }
  assert.deepEqual(parseMachineProgramLookup("0f8e4d2c-1111-4222-8333-444455556666"), {
    kind: "ID",
    id: "0f8e4d2c-1111-4222-8333-444455556666",
  });
  // Never a guess: a raw material label, a carton, an empty box and MP-0 are all refusals.
  for (const nonsense of ["", "   ", "RM_6_42_18", "SK6_RED_7/10_1", "MP-", "MP-0", "0"]) {
    assert.equal(parseMachineProgramLookup(nonsense), null, JSON.stringify(nonsense));
  }
});

test("the store is notified once when a program is made, and the notice carries its id", async () => {
  await withFixture(async (f) => {
    const storekeeper = f.userWith("babar", PERMISSION.STORE_SCANNING);
    const biller = f.userWith("rashid", PERMISSION.SALE_VOUCHER_FORM);

    const { programId } = await readyProgram(f);

    const notices = f.noticesFor(storekeeper).filter((notice) => notice.kind === NOTIFICATION_KIND.MACHINE_PROGRAM_ISSUED);
    assert.equal(notices.length, 1, "one notice per program, not one per upper added to it");
    assert.equal(notices[0].entity_id, programId, "the stored id travels, never the printed number");
    assert.match(notices[0].message, /MP-000001/);
    assert.match(notices[0].message, /MACHINE 1/);
    assert.equal(
      f.noticesFor(biller).filter((notice) => notice.kind === NOTIFICATION_KIND.MACHINE_PROGRAM_ISSUED).length,
      0,
      "the billing desk is not the store"
    );

    // And the id in that notice opens exactly that program.
    const opened = await f.open.execute({ lookup: programId });
    assert.equal(opened.outcome, "OPENED");
    assert.equal(opened.programId, programId);
    assert.equal(opened.programCode, "MP-000001");
  });
});

test("a program opens by its printed number, and a number that is not a program is refused", async () => {
  await withFixture(async (f) => {
    const { programId } = await readyProgram(f);

    for (const written of ["MP-000001", "1", "mp1"]) {
      const opened = await f.open.execute({ lookup: written });
      assert.equal(opened.outcome, "OPENED", written);
      assert.equal(opened.programId, programId, "the same program, however it was named");
    }

    const missing = await f.open.execute({ lookup: "MP-000999" });
    assert.equal(missing.accepted, false);
    assert.equal(missing.outcome, "PROGRAM_NOT_FOUND");
    assert.match(missing.reason ?? "", /MP-000999/);

    const nonsense = await f.open.execute({ lookup: "RM_6_42_18" });
    assert.equal(nonsense.accepted, false);
    assert.equal(nonsense.outcome, "INVALID_LOOKUP", "a raw material label is never silently treated as a program");
  });
});

test("a deleted program cannot be opened for Store Out, and says so", async () => {
  await withFixture(async (f) => {
    const { programId } = await readyProgram(f);
    const deleted = await f.deleteProgram.execute({ programId, reason: "machine down", actor: ACTOR });
    assert.equal(deleted.outcome, "CANCELLED");

    const opened = await f.open.execute({ lookup: programId });
    assert.equal(opened.accepted, false);
    assert.equal(opened.outcome, "PROGRAM_CANCELLED");
    assert.match(opened.reason ?? "", /deleted/i);
  });
});

test("a program with no uppers on it yet is refused: there is nothing to fetch", async () => {
  await withFixture(async (f) => {
    await f.assignBoth(f.machine1.id, f.contractorA, f.contractorB);
    await f.stockIn(f.black, 2);
    const saved = await f.program({ itemId: f.black, quantity: 5 });
    assert.ok(saved.lineId);
    // Taking its only upper off leaves the program row behind with nothing on it.
    f.raw.prepare("DELETE FROM machine_program_upper_lines WHERE id = ?").run(saved.lineId);

    const opened = await f.open.execute({ lookup: saved.programId! });
    assert.equal(opened.accepted, false);
    assert.equal(opened.outcome, "PROGRAM_EMPTY");
  });
});

// ─── Scanning into the unsaved batch ─────────────────────────────────────────

test("an authorised packet is accepted into the batch and nothing moves", async () => {
  await withFixture(async (f) => {
    const { programId, blackQrs } = await readyProgram(f);
    const before = f.balanceOf(f.black);

    const verdict = await f.check(programId, blackQrs[0]);
    assert.equal(verdict.accepted, true);
    assert.equal(verdict.verdict, "ACCEPTED");
    assert.equal(verdict.itemId, f.black);
    assert.equal(verdict.packingQuantity, 5, "one packet holds 5 DOZEN");
    assert.equal(verdict.authorized, 100);
    assert.equal(verdict.issued, 0);
    assert.equal(verdict.pending, 5, "what this batch would add, this packet included");

    // A CHECK writes nothing at all. Both of these would be different if it did.
    assert.equal(f.balanceOf(f.black), before, "a scan into an unsaved batch does not touch stock");
    assert.equal(f.statusOf(blackQrs[0]), "IN_STORE", "the packet is still in the store");
    assert.equal(f.lineFor(programId, f.black).consumed, 0, "and the program is still owed everything");
    assert.equal(f.batchRows().length, 0, "no batch row exists until one is saved");
  });
});

test("an upper the program does not ask for is refused, and a packet already in the batch is refused", async () => {
  await withFixture(async (f) => {
    const { programId, blackQrs } = await readyProgram(f);
    const greenQrs = await f.stockIn(f.green, 2);

    const unauthorised = await f.check(programId, greenQrs[0]);
    assert.equal(unauthorised.accepted, false);
    assert.equal(unauthorised.verdict, "NOT_ON_PROGRAM");
    assert.match(unauthorised.reason ?? "", /MP-000001/);

    const duplicate = await f.check(programId, blackQrs[0], [blackQrs[0]]);
    assert.equal(duplicate.accepted, false);
    assert.equal(duplicate.verdict, "ALREADY_IN_BATCH");

    // Case and whitespace are the same packet, not a second one.
    const sameAgain = await f.check(programId, ` ${blackQrs[0].toLowerCase()} `, [blackQrs[0]]);
    assert.equal(sameAgain.verdict, "ALREADY_IN_BATCH");

    assert.equal(f.balanceOf(f.green), 10, "the refused upper's stock is untouched");
  });
});

test("a packet already issued elsewhere, an unknown code and a carton are each refused by name", async () => {
  await withFixture(async (f) => {
    const { programId, blackQrs } = await readyProgram(f);

    // Issued on the generic station: it is no longer in the store to take out of it.
    const gone = await f.plainIssue(blackQrs[0]);
    assert.equal(gone.outcome, "ISSUED");
    const alreadyIssued = await f.check(programId, blackQrs[0]);
    assert.equal(alreadyIssued.accepted, false);
    assert.equal(alreadyIssued.verdict, "NOT_IN_STORE");

    const unknown = await f.check(programId, "RM_6_999_7");
    assert.equal(unknown.verdict, "UNKNOWN_QR");

    const carton = await f.check(programId, "SK6_RED_7/10_1");
    assert.equal(carton.verdict, "INVALID_FORMAT");
    assert.match(carton.reason ?? "", /Store Move Out/);
  });
});

test("once the program has everything it asked for of an upper, another packet of it is refused", async () => {
  await withFixture(async (f) => {
    await f.assignBoth(f.machine1.id, f.contractorA, f.contractorB);
    const qrs = await f.stockIn(f.black, 4);
    // 10 DOZEN asked for, and a packet holds 5: two packets fill it exactly.
    const saved = await f.program({ itemId: f.black, quantity: 10 });
    const programId = saved.programId!;

    // Two in the unsaved batch already cover it, so a third is refused before anything is saved.
    const third = await f.check(programId, qrs[2], [qrs[0], qrs[1]]);
    assert.equal(third.accepted, false);
    assert.equal(third.verdict, "VARIANT_FULFILLED");

    // And after they are committed, it is refused for the same reason from the event log.
    const committed = await f.saveBatch({ programId, qrIds: [qrs[0], qrs[1]] });
    assert.equal(committed.outcome, "SAVED");
    const afterSave = await f.check(programId, qrs[2]);
    assert.equal(afterSave.verdict, "PROGRAM_CLOSED", "the whole program is finished, not just the line");
  });
});

// ─── Saving a partial batch ───────────────────────────────────────────────────

test("a PARTIAL batch commits, the program stays resumable, and a second batch adds to it", async () => {
  await withFixture(async (f) => {
    const { programId, blackQrs, redQrs } = await readyProgram(f);

    // 6 packets of BLACK (30 DOZEN of 100) and 2 of RED (10 DOZEN of 50) — the requirement's
    // example, in the DOZEN this ERP counts uppers in.
    const first = await f.saveBatch({ programId, qrIds: [...blackQrs.slice(0, 6), ...redQrs.slice(0, 2)] });
    assert.equal(first.accepted, true);
    assert.equal(first.outcome, "SAVED");
    assert.equal(first.packetCount, 8);
    assert.equal(first.programCompleted, false, "saving a batch never finishes a program by itself");

    assert.equal(f.lineFor(programId, f.black).consumed, 30, "30 of 100 issued");
    assert.equal(f.lineFor(programId, f.black).outstanding, 70);
    assert.equal(f.lineFor(programId, f.red).consumed, 10, "10 of 50 issued");
    assert.equal(f.lineFor(programId, f.red).outstanding, 40);

    const program = f.db.getMachineProgram(programId)!;
    assert.equal(program.status, MACHINE_PROGRAM_STATUS.PROGRAMMED, "still live, so it still reserves the rest");
    assert.equal(program.displayStatus, MACHINE_PROGRAM_DISPLAY_STATUS.PARTIALLY_USED);

    // The stock ledger agrees exactly: 40 packets of 5 in, 6 out, and the same for RED.
    assert.equal(f.balanceOf(f.black), 170);
    assert.equal(f.balanceOf(f.red), 190);

    // Come back later and issue more against the same program.
    const second = await f.saveBatch({ programId, qrIds: blackQrs.slice(6, 10) });
    assert.equal(second.outcome, "SAVED");
    assert.equal(f.lineFor(programId, f.black).consumed, 50, "30 then 20 — the first batch is not overwritten");
    assert.equal(f.lineFor(programId, f.black).outstanding, 50);
    assert.equal(f.balanceOf(f.black), 150);
    assert.equal(f.batchRows().length, 2, "two saved batches, both kept");
  });
});

test("a fully issued program closes itself and then refuses everything", async () => {
  await withFixture(async (f) => {
    await f.assignBoth(f.machine1.id, f.contractorA, f.contractorB);
    const qrs = await f.stockIn(f.black, 5);
    const saved = await f.program({ itemId: f.black, quantity: 10 });
    const programId = saved.programId!;

    const batch = await f.saveBatch({ programId, qrIds: [qrs[0], qrs[1]] });
    assert.equal(batch.outcome, "SAVED");
    assert.equal(batch.programCompleted, true, "this batch took the last thing it was owed");
    assert.equal(f.db.getMachineProgram(programId)!.status, MACHINE_PROGRAM_STATUS.COMPLETED);

    // No further issuance, by either door.
    const reopened = await f.open.execute({ lookup: programId });
    assert.equal(reopened.accepted, false);
    assert.equal(reopened.outcome, "PROGRAM_COMPLETED");

    const more = await f.saveBatch({ programId, qrIds: [qrs[2]] });
    assert.equal(more.accepted, false);
    assert.equal(more.outcome, "PROGRAM_COMPLETED");
    assert.equal(f.statusOf(qrs[2]), "IN_STORE", "the refused packet never left the store");
    assert.equal(f.balanceOf(f.black), 15, "and the balance is exactly the two packets that did");
  });
});

// ─── All-or-nothing, retries and concurrency ──────────────────────────────────

test("one bad packet rolls the WHOLE batch back — no stock moves and no batch row survives", async () => {
  await withFixture(async (f) => {
    const { programId, blackQrs } = await readyProgram(f);
    const greenQrs = await f.stockIn(f.green, 1);
    const before = f.balanceOf(f.black);

    const refused = await f.saveBatch({ programId, qrIds: [blackQrs[0], blackQrs[1], greenQrs[0]] });
    assert.equal(refused.accepted, false);
    assert.equal(refused.outcome, "SCAN_REFUSED");
    assert.equal(refused.refusedQrId, greenQrs[0]);
    assert.equal(refused.refusedVerdict, "NOT_ON_PROGRAM");

    assert.equal(f.balanceOf(f.black), before, "the two good packets did not leave either");
    assert.equal(f.statusOf(blackQrs[0]), "IN_STORE");
    assert.equal(f.statusOf(blackQrs[1]), "IN_STORE");
    assert.equal(f.lineFor(programId, f.black).consumed, 0);
    assert.equal(f.batchRows().length, 0, "the batch row was rolled back with the rest");

    // Take the bad packet out and the same batch saves.
    const retried = await f.saveBatch({ programId, qrIds: [blackQrs[0], blackQrs[1]] });
    assert.equal(retried.outcome, "SAVED");
    assert.equal(f.balanceOf(f.black), before - 10);
  });
});

test("the same Save Batch sent twice issues the packets once", async () => {
  await withFixture(async (f) => {
    const { programId, blackQrs } = await readyProgram(f);
    const qrIds = blackQrs.slice(0, 3);
    const batchKey = "the-screens-one-key-for-this-batch";

    const first = await f.saveBatch({ programId, qrIds, batchKey });
    assert.equal(first.outcome, "SAVED");
    assert.equal(first.packetCount, 3);

    // The reply was lost and the terminal sent it again. Without the key this would refuse
    // every packet with NOT_IN_STORE; with it, the batch that already committed is reported.
    const replay = await f.saveBatch({ programId, qrIds, batchKey });
    assert.equal(replay.accepted, true, "a retry must not look like a failure");
    assert.equal(replay.outcome, "ALREADY_SAVED");
    assert.equal(replay.batchId, first.batchId, "the same batch, not a second one");
    assert.equal(replay.packetCount, 3);

    assert.equal(f.lineFor(programId, f.black).consumed, 15, "15 DOZEN, not 30");
    assert.equal(f.balanceOf(f.black), 185);
    assert.equal(f.batchRows().length, 1);
  });
});

test("two terminals cannot issue the same packet, and cannot over-issue one program", async () => {
  await withFixture(async (f) => {
    await f.assignBoth(f.machine1.id, f.contractorA, f.contractorB);
    const qrs = await f.stockIn(f.black, 6);
    const saved = await f.program({ itemId: f.black, quantity: 25 });
    const programId = saved.programId!;

    // Two computers in the store, each on its own connection to the one database file. Both
    // storekeepers scanned the SAME packet into their own batch — neither knew about the other.
    // SQLite serialises their BEGIN IMMEDIATE, so one of them is simply second.
    const terminalB = f.secondTerminal();
    try {
      const first = await f.saveBatch({ programId, qrIds: [qrs[0], qrs[1]], batchKey: "terminal-a" });
      assert.equal(first.outcome, "SAVED");

      const second = await terminalB.saveBatch.execute({
        programId,
        batchKey: "terminal-b",
        sessionId: null,
        qrIds: [qrs[1], qrs[2]],
        context: CONTEXT,
        actor: "babar",
        deviceId: "device-2",
      });
      assert.equal(second.accepted, false, "the second terminal cannot have the packet the first took");
      assert.equal(second.outcome, "SCAN_REFUSED");
      assert.equal(second.refusedQrId, qrs[1], "the packet they both scanned is the one that was refused");
      assert.equal(second.refusedVerdict, "NOT_IN_STORE");
    } finally {
      terminalB.close();
    }

    // The first terminal's two packets are out, and the second's other packet never moved —
    // its whole batch rolled back rather than committing the half that was still valid.
    assert.equal(f.balanceOf(f.black), 20, "30 in, 10 out — never 15 or 20 out");
    assert.equal(f.statusOf(qrs[2]), "IN_STORE");
    assert.equal(f.lineFor(programId, f.black).consumed, 10);
    assert.equal(f.batchRows().length, 1, "only the batch that committed exists");

    // And the program's own ceiling holds: 25 DOZEN asked for, 10 taken, so three more packets
    // (15 DOZEN) finish it exactly and the program closes itself.
    const rest = await f.saveBatch({ programId, qrIds: [qrs[2], qrs[3], qrs[4]], batchKey: "the-rest" });
    assert.equal(rest.outcome, "SAVED");
    assert.equal(f.db.getMachineProgram(programId)!.status, MACHINE_PROGRAM_STATUS.COMPLETED);
    assert.equal(f.lineFor(programId, f.black).consumed, 25, "exactly what was authorised");

    const over = await f.saveBatch({ programId, qrIds: [qrs[5]], batchKey: "one-too-many" });
    assert.equal(over.accepted, false, "nothing may be issued beyond the authorised quantity");
    assert.equal(f.balanceOf(f.black), 5);
  });
});

test("the same packet twice in one batch is refused before anything is written", async () => {
  await withFixture(async (f) => {
    const { programId, blackQrs } = await readyProgram(f);
    const refused = await f.saveBatch({ programId, qrIds: [blackQrs[0], blackQrs[0]] });
    assert.equal(refused.accepted, false);
    assert.equal(refused.refusedVerdict, "ALREADY_IN_BATCH");
    assert.equal(f.balanceOf(f.black), 200);
    assert.equal(f.batchRows().length, 0);
  });
});

test("an empty batch is refused rather than saved as nothing", async () => {
  await withFixture(async (f) => {
    const { programId } = await readyProgram(f);
    const refused = await f.saveBatch({ programId, qrIds: [] });
    assert.equal(refused.accepted, false);
    assert.equal(refused.outcome, "NOTHING_TO_SAVE");
    assert.equal(f.batchRows().length, 0);
  });
});

// ─── Traceability ─────────────────────────────────────────────────────────────

test("every issued packet is permanently linked to its allocation, its batch, its operator and its time", async () => {
  await withFixture(async (f) => {
    const { programId, blackQrs, redQrs } = await readyProgram(f);
    const session = f.openSession();

    const batch = await f.saveBatch({ programId, qrIds: [blackQrs[0], redQrs[0]], sessionId: session.id });
    assert.equal(batch.outcome, "SAVED");

    const blackLineId = f.lineFor(programId, f.black).id;
    const redLineId = f.lineFor(programId, f.red).id;

    const blackExit = f.exitStampOf(blackQrs[0])!;
    assert.equal(blackExit.line_id, blackLineId, "which Machine Program allocation authorised it");
    assert.equal(blackExit.batch_id, batch.batchId, "which saved batch recorded it");
    assert.equal(blackExit.session_id, session.id, "so it prints on this terminal's issue slip");
    assert.equal(blackExit.actor, ACTOR, "who issued it");
    assert.equal(blackExit.quantity, 5, "what quantity left, in the line's own unit");
    assert.ok(blackExit.event_ts_local, "when");

    assert.equal(f.exitStampOf(redQrs[0])!.line_id, redLineId, "each packet against its own variant");
    assert.equal(f.exitStampOf(redQrs[0])!.batch_id, batch.batchId, "both in the one batch");

    // "Which Machine Program was this QR issued against?" answered from the line stamp alone.
    const programOfQr = f.raw
      .prepare(
        `SELECT mp.program_number FROM raw_material_qr_events rme
         JOIN machine_program_upper_lines mul ON mul.id = rme.machine_program_upper_line_id
         JOIN machine_program_runs mpr ON mpr.id = mul.run_id
         JOIN machine_programs mp ON mp.id = mpr.program_id
         WHERE rme.qr_id = ? AND rme.event_type = 'STORE_EXIT' LIMIT 1`
      )
      .get(blackQrs[0]) as { program_number: number };
    assert.equal(programOfQr.program_number, 1);

    // And the batch list the screen shows is built from those same events.
    const batches = f.db.listMachineProgramIssueBatches(programId);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].batch.packetCount, 2);
    assert.equal(batches[0].batch.issuedBy, ACTOR);
    assert.deepEqual(
      batches[0].packets.map((packet) => packet.qrId).sort(),
      [blackQrs[0], redQrs[0]].sort()
    );

    // A later batch never rewrites an earlier one.
    const later = await f.saveBatch({ programId, qrIds: [blackQrs[1]] });
    assert.equal(later.outcome, "SAVED");
    assert.equal(f.exitStampOf(blackQrs[0])!.batch_id, batch.batchId, "the first packet keeps its own batch");
    assert.equal(f.db.listMachineProgramIssueBatches(programId).length, 2);
  });
});

test("a packet received back into the store gives its quantity back to the program it was issued for", async () => {
  await withFixture(async (f) => {
    const { programId, blackQrs } = await readyProgram(f);
    const batch = await f.saveBatch({ programId, qrIds: [blackQrs[0], blackQrs[1]] });
    assert.equal(batch.outcome, "SAVED");
    assert.equal(f.lineFor(programId, f.black).consumed, 10);

    // The existing Raw Material Input compensating record — unchanged by this feature.
    const session = f.db.startRawMaterialReceivingSession({ partyId: f.supplierA, deviceId: "device-1", startedBy: ACTOR });
    const back = await f.receive.execute({ rawScan: blackQrs[0], partyId: f.supplierA, sessionId: session.id, context: CONTEXT, actor: ACTOR });
    assert.equal(back.outcome, "RECEIVED");

    assert.equal(f.lineFor(programId, f.black).consumed, 5, "the returned packet is owed again");
    assert.equal(f.lineFor(programId, f.black).outstanding, 95);
    assert.equal(f.balanceOf(f.black), 195);
    assert.equal(f.statusOf(blackQrs[0]), "IN_STORE", "and it can be issued again");
  });
});

// ─── The open program is the only allocation consumed ─────────────────────────

test("a program-restricted batch feeds the program the operator opened, not the oldest one", async () => {
  await withFixture(async (f) => {
    await f.assignBoth(f.machine1.id, f.contractorA, f.contractorB);
    await f.assignBoth(f.machine2.id, f.contractorB, f.contractorA);
    const qrs = await f.stockIn(f.black, 8);

    // MACHINE 1 was programmed first, so a plain scan would feed IT (FIFO).
    const older = await f.program({ machineId: f.machine1.id, itemId: f.black, quantity: 20 });
    const newer = await f.program({ machineId: f.machine2.id, itemId: f.black, quantity: 20 });

    const plain = await f.plainIssue(qrs[0]);
    assert.equal(plain.machineProgram?.programId, older.programId, "the generic scanner is still FIFO");

    // Opening MACHINE 2's program and saving against it feeds that one, and only that one.
    const batch = await f.saveBatch({ programId: newer.programId!, qrIds: [qrs[1], qrs[2]] });
    assert.equal(batch.outcome, "SAVED");
    assert.equal(f.lineFor(newer.programId!, f.black).consumed, 10, "the program the operator opened");
    assert.equal(f.lineFor(older.programId!, f.black).consumed, 5, "the older one still has only its plain scan");
  });
});

// ─── The cartons the machine owes back ────────────────────────────────────────
// Uppers going out of the store ARE cartons coming back: one dozen of slippers is packed into
// two cartons of six pairs. A saved packet therefore reports the finished goods it will become,
// so the store can label them before they arrive — read off the program line it was issued
// against, never typed, and never guessed when any part of the identity is missing.

test("a saved packet says which cartons the machine will send back, and how many", async () => {
  await withFixture(async (f) => {
    const { programId, blackQrs } = await readyProgram(f);

    const batch = await f.saveBatch({ programId, qrIds: [blackQrs[0]] });
    assert.equal(batch.outcome, "SAVED");
    assert.equal(batch.packets?.length, 1);

    const packet = batch.packets![0];
    assert.equal(packet.qrId, blackQrs[0]);
    assert.equal(packet.quantity, 5, "one packet holds 5 DOZEN");
    assert.equal(packet.unitCode, "DOZEN");
    assert.equal(packet.cartonNote, null);
    assert.deepEqual(packet.cartons, {
      // The run's own product: what the sole is being moulded onto.
      articleSizeId: f.sk6_710,
      article: "SK6",
      size: "7/10",
      soleColour: "BLACK",
      // The colour a carton QR is identified by is the UPPER's, not the sole's.
      colour: "BLACK",
      // 5 DOZEN of uppers out is 10 cartons of 6 pairs coming back.
      count: 10,
    });
  });
});

test("the carton colour is the upper's own, so two uppers on one sole are two carton runs", async () => {
  await withFixture(async (f) => {
    const { programId, blackQrs, redQrs } = await readyProgram(f);

    const first = await f.saveBatch({ programId, qrIds: [blackQrs[0]] });
    const second = await f.saveBatch({ programId, qrIds: [redQrs[0]] });

    assert.equal(first.packets![0].cartons?.colour, "BLACK");
    assert.equal(second.packets![0].cartons?.colour, "RED");
    // Same sole, same article and size — only the upper's colour tells the cartons apart.
    assert.equal(first.packets![0].cartons?.soleColour, "BLACK");
    assert.equal(second.packets![0].cartons?.soleColour, "BLACK");
    assert.equal(first.packets![0].cartons?.articleSizeId, second.packets![0].cartons?.articleSizeId);
  });
});

test("an upper with no colour still leaves the store, and says why its cartons cannot be labelled", async () => {
  await withFixture(async (f) => {
    await f.assignBoth(f.machine1.id, f.contractorA, f.contractorB);
    const qrs = await f.stockIn(f.colourless, 2);
    const saved = await f.program({ itemId: f.colourless, quantity: 10 });
    assert.equal(saved.accepted, true, saved.reason);

    const batch = await f.saveBatch({ programId: saved.programId!, qrIds: [qrs[0]] });

    // The movement is the movement: stock is the store's business, carton labels are not.
    assert.equal(batch.outcome, "SAVED");
    assert.equal(f.statusOf(qrs[0]), "ISSUED");
    assert.equal(f.balanceOf(f.colourless), 5);
    assert.equal(f.lineFor(saved.programId!, f.colourless).consumed, 5);

    // But no identity is invented for it.
    const packet = batch.packets![0];
    assert.equal(packet.cartons, null);
    assert.match(packet.cartonNote ?? "", /no colour on it/);
  });
});

// ─── Printing the cartons, exactly once ───────────────────────────────────────
// The carton list is read back from the events, so it outlives the screen, and a print is
// recorded against each packet in the same transaction as the identities it reserves.

test("printing labels the cartons a packet is owed — 1 DOZEN is 2 — and never offers them again", async () => {
  await withFixture(async (f) => {
    const { programId, blackQrs } = await readyProgram(f);
    await f.saveBatch({ programId, qrIds: [blackQrs[0]] });
    await f.saveBatch({ programId, qrIds: [blackQrs[1]] });

    // Read fresh, as a program reopened tomorrow would be: two packets of 5 DOZEN, 10 cartons each.
    const owed = f.db.listMachineProgramCartonPackets(programId);
    assert.equal(owed.length, 2);
    assert.deepEqual(owed.map((packet) => packet.cartons?.count), [10, 10]);
    assert.ok(owed.every((packet) => packet.label === null));

    const printed = f.db.printMachineProgramCartons({
      programId, eventIds: owed.map((packet) => packet.eventId), printedBy: ACTOR, deviceId: "device-1",
    });
    // One run for one product and colour: 10 DOZEN of uppers out is 20 carton QR codes.
    assert.equal(printed.qrCodes.length, 20);
    assert.equal(printed.batch.color, "BLACK");
    assert.equal(printed.batch.requestedBy, "MP-000001");

    const after = f.db.listMachineProgramCartonPackets(programId);
    assert.ok(after.every((packet) => packet.label?.qrBatchId === printed.batch.id));
    assert.equal(after[0].label?.firstQrId, printed.qrCodes[0].id);

    // A second print of the same packets — another terminal, a double click — is refused and
    // reserves nothing.
    const codesBefore = Number(f.raw.prepare("SELECT COUNT(*) AS n FROM qr_codes").get().n);
    assert.throws(
      () => f.db.printMachineProgramCartons({ programId, eventIds: [owed[0].eventId], printedBy: ACTOR, deviceId: "device-1" }),
      /already printed/
    );
    assert.equal(Number(f.raw.prepare("SELECT COUNT(*) AS n FROM qr_codes").get().n), codesBefore);
  });
});

test("a packet issued by the plain store scanner against a program is owed its cartons too", async () => {
  await withFixture(async (f) => {
    const { programId, redQrs } = await readyProgram(f);
    const issued = await f.plainIssue(redQrs[0]);
    assert.equal(issued.accepted, true, issued.reason);

    const owed = f.db.listMachineProgramCartonPackets(programId);
    assert.equal(owed.length, 1);
    assert.equal(owed[0].cartons?.colour, "RED");
    assert.equal(owed[0].cartons?.count, 10);
  });
});

test("cartons that cannot be worked out, or two products at once, are refused without reserving anything", async () => {
  await withFixture(async (f) => {
    const { programId, blackQrs, redQrs } = await readyProgram(f);
    await f.saveBatch({ programId, qrIds: [blackQrs[0], redQrs[0]] });
    const owed = f.db.listMachineProgramCartonPackets(programId);

    assert.throws(
      () => f.db.printMachineProgramCartons({ programId, eventIds: owed.map((packet) => packet.eventId), printedBy: ACTOR, deviceId: "device-1" }),
      /one product and colour at a time/
    );
    assert.throws(
      () => f.db.printMachineProgramCartons({ programId, eventIds: ["not-an-issuance"], printedBy: ACTOR, deviceId: "device-1" }),
      /no longer out for this program/
    );
    assert.equal(Number(f.raw.prepare("SELECT COUNT(*) AS n FROM machine_program_carton_labels").get().n), 0);
    assert.equal(Number(f.raw.prepare("SELECT COUNT(*) AS n FROM qr_batches").get().n), 0);
  });
});

// ─── Store In: the program's cartons coming back ──────────────────────────────
// Each printed carton label is scanned in Store In against the program it was printed for: the
// carton is produced AND stored in, in one transaction, through the same production and Store
// Move In steps the other scanners use.

const cartonIn = (f: Fixture) =>
  new ReceiveMachineProgramCartonUseCase({
    txManager: f.db, duplicateChecker: f.db, qrRegistry: f.db, productCatalog: f.db, qrMasterRepo: f.db,
    productionEventsRepo: f.db, stockProjectionRepo: f.db, outboxRepo: f.db, qrLookupRepo: f.db, gatepassRepo: f.db,
    storeEntryEventsRepo: f.db, cartonOriginRepo: f.db, eventPublisher: new InMemoryEventBus(), idGenerator: new UuidGenerator(),
  });

/** Issues one BLACK packet against the program and prints its 10 carton labels. */
const printedCartons = async (f: Fixture, programId: string, packetQr: string): Promise<string[]> => {
  await f.saveBatch({ programId, qrIds: [packetQr] });
  const owed = f.db.listMachineProgramCartonPackets(programId).filter((packet) => !packet.label);
  return f.db
    .printMachineProgramCartons({ programId, eventIds: owed.map((packet) => packet.eventId), printedBy: ACTOR, deviceId: "device-1" })
    .qrCodes.map((qr) => qr.id);
};

const cartonStatusOf = (f: Fixture, qrId: string): string | null =>
  (f.raw.prepare("SELECT current_status AS s FROM qr_master WHERE qr_id = ?").get(qrId) as { s: string } | undefined)?.s ?? null;

test("Store In scans a program's carton back: produced and stored in at once, and only once", async () => {
  await withFixture(async (f) => {
    const { programId, blackQrs } = await readyProgram(f);
    const cartons = await printedCartons(f, programId, blackQrs[0]);
    assert.equal(cartons.length, 10, "5 DOZEN out is 10 cartons");

    const received = await cartonIn(f).execute({ programId, rawScan: cartons[0], context: CONTEXT, actor: ACTOR });
    assert.equal(received.outcome, "RECEIVED", received.reason);
    assert.equal(received.producedNow, true);
    assert.equal(cartonStatusOf(f, cartons[0]), "WAREHOUSE");
    // Both records exist — the production the reports count, and the store-in.
    const events = f.raw.prepare("SELECT event_type FROM production_events WHERE qr_id = ? ORDER BY rowid").all(cartons[0]) as Array<{ event_type: string }>;
    assert.deepEqual(events.map((event) => event.event_type), ["PRODUCED", "MOVED"]);
    // The program shows how many of its cartons are back.
    assert.equal(f.db.listMachineProgramCartonPackets(programId)[0].label?.receivedInRun, 1);

    const again = await cartonIn(f).execute({ programId, rawScan: cartons[0], context: CONTEXT, actor: ACTOR });
    assert.equal(again.outcome, "ALREADY_IN_STORE");
    assert.equal((f.raw.prepare("SELECT COUNT(*) AS n FROM production_events WHERE qr_id = ?").get(cartons[0]) as { n: number }).n, 2);
  });
});

test("a carton already scanned in Live Production is only stored in", async () => {
  await withFixture(async (f) => {
    const { programId, blackQrs } = await readyProgram(f);
    const [carton] = await printedCartons(f, programId, blackQrs[0]);
    const production = new ProcessScanUseCase({
      txManager: f.db, duplicateChecker: f.db, qrRegistry: f.db, productCatalog: f.db, qrMasterRepo: f.db,
      productionEventsRepo: f.db, stockProjectionRepo: f.db, outboxRepo: f.db,
      eventPublisher: new InMemoryEventBus(), idGenerator: new UuidGenerator(),
    });
    assert.equal((await production.execute({ rawScan: carton, context: CONTEXT })).accepted, true);

    const received = await cartonIn(f).execute({ programId, rawScan: carton, context: CONTEXT, actor: ACTOR });
    assert.equal(received.outcome, "RECEIVED", received.reason);
    assert.equal(received.producedNow, false);
    assert.equal((f.raw.prepare("SELECT COUNT(*) AS n FROM production_events WHERE qr_id = ? AND event_type = 'PRODUCED'").get(carton) as { n: number }).n, 1);
  });
});

test("a carton that is not this program's is refused by name and nothing is written", async () => {
  await withFixture(async (f) => {
    const { programId, blackQrs, redQrs } = await readyProgram(f);

    // Another machine's program, with its own printed cartons.
    await f.assignBoth(f.machine2.id, f.contractorA, f.contractorB);
    const other = await f.program({ machineId: f.machine2.id, itemId: f.red, quantity: 10 });
    assert.ok(other.programId);
    const [otherCarton] = await printedCartons(f, other.programId, redQrs[0]);
    await printedCartons(f, programId, blackQrs[0]);

    const wrongProgram = await cartonIn(f).execute({ programId, rawScan: otherCarton, context: CONTEXT, actor: ACTOR });
    assert.equal(wrongProgram.outcome, "OTHER_PROGRAM");
    assert.match(wrongProgram.reason ?? "", /MP-000002/);
    assert.equal(cartonStatusOf(f, otherCarton), null, "not produced, not stored");

    // An ordinary QR Generator carton belongs to no program.
    const [plain] = f.db.generateQrBatch({ articleSizeId: f.sk6_710, color: "BLACK", quantity: 1 }).qrCodes.map((qr) => qr.id);
    const notOnProgram = await cartonIn(f).execute({ programId, rawScan: plain, context: CONTEXT, actor: ACTOR });
    assert.equal(notOnProgram.outcome, "NOT_ON_PROGRAM");
    assert.equal(cartonStatusOf(f, plain), null);

    const rawMaterial = await cartonIn(f).execute({ programId, rawScan: blackQrs[1], context: CONTEXT, actor: ACTOR });
    assert.equal(rawMaterial.outcome, "RAW_MATERIAL_NOT_SUPPORTED");
  });
});

// ─── Dana Issue: a typed quantity, in the Dana's own unit ─────────────────────
// Reported 2026-10-11: "Set how much one PACKET of DANA — BLUE holds before issuing it" — with no
// screen to set it on. Dana is loose and never labelled, so it has no bag size to set: it goes out
// as a quantity typed in its own unit (KG), or any unit on its ladder (BAG when 1 BAG = 25 KG).

/** A DANA material in one colour, counted in `unitCode`, with `quantity` of it moved in by hand. */
const danaWithStock = (f: Fixture, unitCode: string, quantity: number) => {
  const unit = f.db.createInventoryUnit({ code: unitCode, name: unitCode, unitFamily: "COUNT" });
  const dana = f.db.createInventoryCategory({ name: "DANA" });
  f.db.addInventoryCategoryField({ categoryId: dana, fieldKey: "color", label: "COLOR", fieldType: "TEXT", required: true, sortOrder: 1 });
  const { id } = f.db.createInventoryItem({ categoryId: dana, values: { color: "BLACK" }, unitId: unit });
  const moved = f.db.moveRawMaterialByHand({ itemId: id, direction: "IN", quantity, unitCode, partyId: f.supplierA, actor: ACTOR });
  assert.equal(moved.outcome, "MOVED", moved.reason);
  return { id, unit };
};

const danaOnHand = (f: Fixture, itemId: string) => f.db.getRawMaterialHandMoveOptions(itemId, "OUT")!.quantityOnHand;

test("Dana counted in KG is issued by typing KG — no bag size has to be set first", async () => {
  await withFixture(async (f) => {
    const { programId } = await readyProgram(f);
    const { id } = danaWithStock(f, "KG", 20);

    const option = f.db.listMachineProgramDanaOptions(programId).find((row) => row.itemId === id);
    assert.ok(option, "BLACK Dana is offered to a program with a BLACK sole");
    assert.deepEqual(option.units, ["KG"]);

    const issued = f.db.issueMachineProgramDana({ programId, itemId: id, quantity: 7.5, unitCode: "KG", actor: ACTOR });
    assert.equal(issued.outcome, "MOVED", issued.reason);
    assert.equal(danaOnHand(f, id), 12.5);
    // The program shows what has gone out for it so far.
    assert.equal(f.db.listMachineProgramDanaOptions(programId).find((row) => row.itemId === id)?.issuedQuantity, 7.5);
    // Stamped with the program it went out for.
    assert.equal(f.db.listMachineProgramDanaIssues(programId)[0].quantity, 7.5);
  });
});

test("with 1 BAG = 25 KG on its ladder, Dana can be issued in BAG or in KG", async () => {
  await withFixture(async (f) => {
    const { programId } = await readyProgram(f);
    const { id, unit: kg } = danaWithStock(f, "KG", 100);
    const bag = f.db.createInventoryUnit({ code: "BAG", name: "Bag", unitFamily: "COUNT" });
    f.db.setInventoryItemUnitLadder({ itemId: id, steps: [{ fromUnitId: bag, toUnitId: kg, factor: 25 }] });

    assert.deepEqual(f.db.listMachineProgramDanaOptions(programId).find((row) => row.itemId === id)?.units, ["BAG", "KG"]);
    const bags = f.db.issueMachineProgramDana({ programId, itemId: id, quantity: 2, unitCode: "BAG", actor: ACTOR });
    assert.equal(bags.outcome, "MOVED", bags.reason);
    assert.equal(danaOnHand(f, id), 50, "2 BAG is 50 KG");
    const kgToo = f.db.issueMachineProgramDana({ programId, itemId: id, quantity: 5, unitCode: "KG", actor: ACTOR });
    assert.equal(kgToo.outcome, "MOVED", kgToo.reason);
    // Issued so far adds BAG and KG issues up in the stock unit: 50 + 5 KG.
    assert.equal(f.db.listMachineProgramDanaOptions(programId).find((row) => row.itemId === id)?.issuedQuantity, 55);
  });
});

test("more Dana than the store holds is refused by name, and nothing moves", async () => {
  await withFixture(async (f) => {
    const { programId } = await readyProgram(f);
    const { id } = danaWithStock(f, "KG", 20);

    const refused = f.db.issueMachineProgramDana({ programId, itemId: id, quantity: 25, unitCode: "KG", actor: ACTOR });
    assert.equal(refused.outcome, "NOT_ENOUGH_STOCK");
    assert.match(refused.reason ?? "", /Only 20 KG/);
    assert.equal(danaOnHand(f, id), 20);

    const nothing = f.db.issueMachineProgramDana({ programId, itemId: id, quantity: 0, unitCode: "KG", actor: ACTOR });
    assert.equal(nothing.outcome, "INVALID_QUANTITY");
  });
});

test("Dana is never labelled: generating raw material QR codes for it is refused", async () => {
  await withFixture(async (f) => {
    const dana = f.db.createInventoryCategory({ name: "DANA" });
    f.db.addInventoryCategoryField({ categoryId: dana, fieldKey: "color", label: "COLOR", fieldType: "TEXT", required: true, sortOrder: 1 });
    const { id } = f.db.createInventoryItem({ categoryId: dana, values: { color: "BLACK" }, unitId: f.unitId });

    assert.throws(
      () => f.db.generateRawMaterialQrBatch({ partyId: f.supplierA, itemId: id, quantity: 4, packingQuantity: 25 }),
      /is Dana, and Dana is not labelled/
    );
    const labels = f.raw.prepare("SELECT COUNT(*) AS n FROM raw_material_qrs WHERE item_id = ?").get(id) as { n: number };
    assert.equal(labels.n, 0);
  });
});

test("Store In counts each upper's cartons: due for what was issued, and how many are back", async () => {
  await withFixture(async (f) => {
    const { programId, blackQrs } = await readyProgram(f);
    const cartons = await printedCartons(f, programId, blackQrs[0]);
    for (const carton of cartons.slice(0, 3)) {
      const received = await cartonIn(f).execute({ programId, rawScan: carton, context: CONTEXT, actor: ACTOR });
      assert.equal(received.outcome, "RECEIVED", received.reason);
    }

    const progress = f.db.listMachineProgramCartonProgress(programId);
    const black = progress.find((row) => row.lineId === f.lineFor(programId, f.black).id);
    const red = progress.find((row) => row.lineId === f.lineFor(programId, f.red).id);
    // 5 DOZEN of BLACK went out: 10 cartons are due, 3 of them are back.
    assert.deepEqual({ due: black?.cartonsDue, back: black?.cartonsBack }, { due: 10, back: 3 });
    // Nothing of RED has gone out, so nothing is due and nothing is back.
    assert.deepEqual({ due: red?.cartonsDue, back: red?.cartonsBack }, { due: 0, back: 0 });
  });
});

// ─── Completing a program: complete, or reconciled ────────────────────────────
// 4 DOZEN out is 8 cartons due. All 8 back closes it COMPLETE; 7 back leaves 1 carton = 6 uppers
// that must each be accounted for as cut size, wastage (claimed to the supplier) or lost (claimed
// to the machine or packing contractor), every claim with a reason — and the admins are told.

/** Issues one BLACK packet (5 DOZEN = 10 cartons), prints its labels and stores `back` of them in. */
const programWithCartonsBack = async (f: Fixture, back: number) => {
  const { programId, blackQrs } = await readyProgram(f);
  const cartons = await printedCartons(f, programId, blackQrs[0]);
  for (const carton of cartons.slice(0, back)) {
    const received = await cartonIn(f).execute({ programId, rawScan: carton, context: CONTEXT, actor: ACTOR });
    assert.equal(received.outcome, "RECEIVED", received.reason);
  }
  return { programId, cartons, blackLine: f.lineFor(programId, f.black).id };
};


test("every carton back: the program closes COMPLETE, and what was never issued is released", async () => {
  await withFixture(async (f) => {
    f.db.bootstrapFirstAdmin("owner", "Password123");
    const { programId } = await programWithCartonsBack(f, 10);

    const view = f.db.getMachineProgramReconciliation(programId)!;
    assert.deepEqual({ due: view.cartonsDue, back: view.cartonsBack }, { due: 10, back: 10 });
    assert.ok(view.lines.every((line) => line.shortfallUppers === 0));

    const reservedBlack = () => f.db.listMachineProgramUppers(f.machine1.id, f.sk6_710).find((upper) => upper.itemId === f.black)?.reserved;
    assert.equal(reservedBlack(), 95, "100 DOZEN planned, 5 issued: 95 still held for the program");

    const closed = f.db.completeMachineProgramProduction({ programId, entries: [], closedBy: ACTOR, deviceId: "device-1" });
    assert.equal(closed.outcome, "COMPLETE");
    assert.equal(f.db.getMachineProgram(programId)?.status, "COMPLETED");
    // The 95 DOZEN planned and never issued are free stock again.
    assert.equal(reservedBlack(), 0);
    assert.equal(f.db.isMachineProgramClosed(programId), true);
    // Nothing claimed, so nobody is notified.
    assert.equal(f.raw.prepare("SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'MACHINE_PROGRAM_RECONCILED'").get().n, 0);
    assert.throws(() => f.db.completeMachineProgramProduction({ programId, entries: [], closedBy: ACTOR, deviceId: "device-1" }), /already closed/);
  });
});

test("cartons short: every missing pair is accounted for, claims carry amounts and reasons, and the admins are told", async () => {
  await withFixture(async (f) => {
    f.db.bootstrapFirstAdmin("owner", "Password123");
    const { programId, blackLine, cartons } = await programWithCartonsBack(f, 9);
    const line = f.db.getMachineProgramReconciliation(programId)!.lines.find((row) => row.lineId === blackLine)!;
    assert.equal(line.shortfallUppers, 6, "1 carton short is 6 pairs");
    assert.deepEqual(line.suppliers.map((supplier) => supplier.name), ["ABC UPPER"]);

    const claim = (overrides: Record<string, unknown>) => ({ role: "SUPPLIER", supplierPartyId: f.supplierA, pairs: 1, ratePaisa: 5_000, reason: "torn upper", ...overrides });
    const close = (entry: Record<string, unknown>) =>
      f.db.completeMachineProgramProduction({
        programId, entries: [{ lineId: blackLine, cutSizeUppers: 0, cutSizePairs: 0, claims: [], ...entry }], closedBy: ACTOR, deviceId: "device-1",
      } as Parameters<typeof f.db.completeMachineProgramProduction>[0]);
    assert.throws(() => f.db.completeMachineProgramProduction({ programId, entries: [], closedBy: ACTOR, deviceId: "device-1" }), /Account for the 6 remaining pairs/);
    assert.throws(() => close({ cutSizeUppers: 4 }), /2 of the 6 remaining pairs/);
    assert.throws(() => close({ cutSizeUppers: 4, claims: [claim({ pairs: 2, reason: "" })] }), /needs a reason/);
    assert.throws(() => close({ cutSizeUppers: 4, claims: [claim({ pairs: 2, supplierPartyId: f.contractorA })] }), /supplier whose uppers went out/);
    assert.equal(f.db.isMachineProgramClosed(programId), false, "a refused close writes nothing");

    const closed = close({
      cutSizeUppers: 4,
      claims: [claim({}), claim({ role: "PACKING", supplierPartyId: null, reason: "not found at packing", ratePaisa: 4_000 })],
    });
    assert.equal(closed.outcome, "RECONCILED");
    const saved = f.db.getMachineProgramReconciliation(programId)!.lines.find((row) => row.lineId === blackLine)!.saved!;
    assert.equal(saved.cutSizeUppers, 4);
    assert.deepEqual(
      saved.claims.map((entry) => [entry.claimNumber, entry.partyName, entry.pairs, entry.amountPaisa]),
      [["CL-000001", "ABC UPPER", 1, 5_000], ["CL-000002", "CONTRACTOR B", 1, 4_000]]
    );
    const notice = f.raw.prepare("SELECT title, message FROM user_notifications WHERE kind = 'MACHINE_PROGRAM_RECONCILED'").get() as { title: string; message: string };
    assert.equal(notice.title, "Uppers claimed on MP-000001");
    assert.match(notice.message, /claimed to ABC UPPER for Rs 50.00 — "torn upper"/);
    assert.match(notice.message, /claimed to CONTRACTOR B for Rs 40.00 — "not found at packing"/);

    // Closed means final: the last carton's label is void, and nothing is stored in against it.
    const late = await cartonIn(f).execute({ programId, rawScan: cartons[9], context: CONTEXT, actor: ACTOR });
    assert.equal(late.accepted, false);
    assert.ok(["PROGRAM_CLOSED", "VOIDED"].includes(late.outcome), late.outcome);
  });
});
