import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddMachineUseCase, AssignMachineContractorUseCase, InMemoryEventBus } from "@erp/application";
import { B_CARTON_COLOUR, CARTON_GRADE, QR_BATCH_SOURCE, buildQrId, businessDateOf } from "@erp/domain";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { UuidGenerator } from "./idGenerator.js";

// The Machine Program (cartonProgram.ts, migrations 077 + 078): one program per machine per
// business day, opened by the machine's first QR run of the day and made of the carton QRs
// generated for it. Every figure asserted here is what the real generator persisted.

type Raw = import("node:sqlite").DatabaseSync;

const ACTOR = "admin";
const today = () => businessDateOf(new Date().toISOString());

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-carton-program-"));
  const db = new SqliteDatabase({ dbPath: path.join(tempDir, "cp.db"), schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  db.setNumberBlock(1, "test");
  db.ensureOperationalContext({
    factoryId: "factory-1", factoryCode: "F001", factoryName: "Factory",
    workstationId: "workstation-1", workstationCode: "WS001", workstationName: "WS",
    deviceId: "device-1", deviceName: "Device", appVersion: "1.0.0",
  });
  const raw = (db as unknown as { db: Raw }).db;
  const deps = { txManager: db, repo: db, eventPublisher: new InMemoryEventBus(), idGenerator: new UuidGenerator() };
  const addMachine = new AddMachineUseCase(deps);
  const assign = new AssignMachineContractorUseCase(deps);

  const party = (partyName: string, partyType = "CONTRACTOR") =>
    db.createParty({ partyName, partyType, city: "Lahore", mobileNumber: `0300-${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`, status: "ACTIVE" });
  const aslam = party("ASLAM");
  const babar = party("BABAR");

  /** A machine set up the way the Machine Program's Add Machine does it. */
  const machine = async (name: string, contractor = aslam, packing = babar): Promise<string> => {
    const added = await addMachine.execute({ name, contractorPartyId: contractor, packingContractorPartyId: packing, actor: ACTOR });
    assert.equal(added.outcome, "ADDED", added.reason);
    return added.machineId!;
  };

  const product = (article: string, size: string): string => {
    const find = () =>
      raw.prepare("SELECT id FROM article_sizes WHERE article = ? AND size = ? AND deleted_at IS NULL LIMIT 1").get(article, size) as
        | { id: string }
        | undefined;
    if (!find()) db.createProduct({ article, size, sellingPrice: 550, status: "ACTIVE" });
    return find()!.id;
  };

  const programsToday = () => db.listMachineDayPrograms(today());
  const count = (sql: string): number => Number((raw.prepare(sql).get() as { n: number }).n);

  return {
    db, raw, addMachine, assign, party, aslam, babar, machine, product, programsToday, count,
    cleanup: () => {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

type Fixture = ReturnType<typeof createFixture>;
const withFixture = async (work: (f: Fixture) => Promise<void>) => {
  const f = createFixture();
  try {
    await work(f);
  } finally {
    f.cleanup();
  }
};

// ─── Add Machine ──────────────────────────────────────────────────────────────

test("Add Machine sets up the machine with its machine contractor and packing contractor, in one step", async () => {
  await withFixture(async (f) => {
    const id = await f.machine("Machine 1");
    const machine = f.db.listMachines().find((row) => row.id === id);
    assert.equal(machine?.name, "MACHINE 1");
    assert.equal(machine?.contractorName, "ASLAM");
    assert.equal(machine?.packingContractorName, "BABAR");
  });
});

test("Add Machine refuses a name already in use, and a party that is not a contractor — writing nothing", async () => {
  await withFixture(async (f) => {
    await f.machine("Machine 1");
    const again = await f.addMachine.execute({ name: "machine 1", contractorPartyId: f.babar, packingContractorPartyId: f.aslam, actor: ACTOR });
    assert.equal(again.outcome, "MACHINE_EXISTS");
    assert.equal(f.db.listMachines().find((row) => row.name === "MACHINE 1")?.contractorName, "ASLAM", "the existing machine is untouched");

    const supplier = f.party("ABC UPPER", "SUPPLIER");
    const refused = await f.addMachine.execute({ name: "Machine 2", contractorPartyId: f.aslam, packingContractorPartyId: supplier, actor: ACTOR });
    assert.equal(refused.outcome, "NOT_A_CONTRACTOR");
    assert.equal(f.db.listMachines().some((row) => row.name === "MACHINE 2"), false, "no machine without both contractors");

    const nameless = await f.addMachine.execute({ name: "  ", contractorPartyId: f.aslam, packingContractorPartyId: f.babar, actor: ACTOR });
    assert.equal(nameless.outcome, "NAME_REQUIRED");
  });
});

// ─── One program per machine per day ──────────────────────────────────────────

test("A: ten carton QRs for MACHINE 1 open its program for today — 10 cartons, 5 dozen, both contractors", async () => {
  await withFixture(async (f) => {
    const machineId = await f.machine("Machine 1");
    const generated = f.db.generateQrBatch({ articleSizeId: f.product("SK6", "7/10"), color: "BLACKGREY", quantity: 10, createdBy: ACTOR, machineId });

    const [program] = f.programsToday();
    assert.match(program.code, /^MP-\d{6}$/);
    assert.equal(generated.program?.code, program.code, "the generator is told which program the run joined");
    assert.equal(program.machineName, "MACHINE 1");
    assert.equal(program.contractorName, "ASLAM");
    assert.equal(program.packingContractorName, "BABAR");
    assert.equal(program.programDate, today());
    assert.equal(program.cartons, 10);
    assert.equal(program.equivalentDozens, 5);
    assert.deepEqual(
      program.lines.map((line) => [line.article, line.size, line.color, line.cartons, line.equivalentDozens]),
      [["SK6", "7/10", "BLACKGREY", 10, 5]]
    );
  });
});

test("B: later runs that day join the same program; another machine gets its own number", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine("Machine 1");
    const m2 = await f.machine("Machine 2");
    const sk6 = f.product("SK6", "7/10");
    const first = f.db.generateQrBatch({ articleSizeId: sk6, color: "BLACKGREY", quantity: 10, machineId: m1 });
    const second = f.db.generateQrBatch({ articleSizeId: sk6, color: "blackgrey", quantity: 7, machineId: m1 });
    f.db.generateQrBatch({ articleSizeId: sk6, color: "BLACKGREY", quantity: 4, machineId: m2 });

    const programs = f.programsToday();
    assert.equal(programs.length, 2);
    const [one, two] = programs;
    assert.equal(first.program?.id, second.program?.id, "one program per machine per day");
    assert.notEqual(one.code, two.code);
    assert.equal(one.machineName, "MACHINE 1");
    assert.equal(one.lines[0].cartons, 17);
    assert.equal(one.lines[0].equivalentDozens, 8.5);
    assert.equal(one.lines[0].batchCount, 2);
    assert.equal(two.machineName, "MACHINE 2");
    assert.equal(two.cartons, 4, "never merged across machines");

    const runs = f.db.listCartonProgramBatches({ programId: one.programId, articleSizeId: sk6, color: "BLACKGREY", grade: null });
    assert.deepEqual(runs.map((run) => run.id).sort(), [first.batch.id, second.batch.id].sort());
    assert.equal(runs.find((run) => run.id === first.batch.id)?.firstQrId, first.qrCodes[0].id);
  });
});

test("a program keeps the contractors it was opened with; a changed contractor goes on the next day's program", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine("Machine 1");
    f.db.generateQrBatch({ articleSizeId: f.product("SK6", "7/10"), color: "RED", quantity: 2, machineId: m1 });

    const chaudhry = f.party("CHAUDHRY");
    const changed = await f.assign.execute({ machineId: m1, role: "MACHINE", contractorPartyId: chaudhry, actor: ACTOR });
    assert.equal(changed.outcome, "ASSIGNED");
    assert.equal(f.db.listMachines().find((row) => row.id === m1)?.contractorName, "CHAUDHRY", "the machine keeps the new contractor");

    f.db.generateQrBatch({ articleSizeId: f.product("SK6", "7/10"), color: "RED", quantity: 2, machineId: m1 });
    assert.equal(f.programsToday()[0].contractorName, "ASLAM", "today's program keeps the pair it was opened with");

    f.raw.exec("BEGIN IMMEDIATE");
    const tomorrow = f.db.openMachineDayProgramInTransaction({ machineId: m1, createdBy: ACTOR, nowIso: new Date(Date.now() + 86_400_000).toISOString() });
    f.raw.exec("COMMIT");
    const snapshot = f.raw.prepare("SELECT contractor_name_snapshot AS name FROM machine_programs WHERE id = ?").get(tomorrow.id) as { name: string };
    assert.equal(snapshot.name, "CHAUDHRY");
    assert.notEqual(tomorrow.id, f.programsToday()[0].programId);
  });
});

test("B carton runs for a machine join its program as their own B line", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine("Machine 1");
    const evr = f.product("EVR9", "7/10");
    f.db.generateQrBatch({ articleSizeId: evr, color: "BLACK", quantity: 6, machineId: m1 });
    const b = f.db.generateQrBatch({ articleSizeId: evr, color: B_CARTON_COLOUR, quantity: 3, grade: CARTON_GRADE.B, machineId: m1 });

    const [program] = f.programsToday();
    assert.equal(program.cartons, 9);
    const bLine = program.lines.find((line) => line.grade === CARTON_GRADE.B);
    assert.equal(bLine?.color, B_CARTON_COLOUR);
    assert.equal(bLine?.cartons, 3);
    const source = (f.raw.prepare("SELECT source FROM qr_batches WHERE id = ?").get(b.batch.id) as { source: string }).source;
    assert.equal(source, QR_BATCH_SOURCE.B_CARTON);
    assert.equal(f.db.listCartonProgramBatches({ programId: program.programId, articleSizeId: evr, color: B_CARTON_COLOUR, grade: "B" }).length, 1);
  });
});

test("C: reading the programs again and again never changes a figure or registers a code", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine("Machine 1");
    f.db.generateQrBatch({ articleSizeId: f.product("SK6", "7/10"), color: "BLACKGREY", quantity: 10, machineId: m1 });
    const first = f.programsToday();
    for (let i = 0; i < 5; i += 1) assert.deepEqual(f.programsToday(), first);
    assert.equal(f.count("SELECT COUNT(*) AS n FROM qr_codes"), 10);
    assert.equal(f.count("SELECT COUNT(*) AS n FROM machine_programs"), 1);
  });
});

// ─── What is refused, and what is never counted ───────────────────────────────

test("D: a refused generation opens no program and counts nothing", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine("Machine 1");
    const sk6 = f.product("SK6", "7/10");
    assert.throws(() => f.db.generateQrBatch({ articleSizeId: sk6, color: "BLACKGREY", quantity: 0, machineId: m1 }));
    assert.throws(() => f.db.generateQrBatch({ articleSizeId: sk6, color: "BLACKGREY", quantity: 10001, machineId: m1 }));
    assert.throws(() => f.db.generateQrBatch({ articleSizeId: "no-such-product", color: "BLACKGREY", quantity: 10, machineId: m1 }));
    assert.equal(f.count("SELECT COUNT(*) AS n FROM machine_programs"), 0, "the program rolls back with the run");
    assert.deepEqual(f.programsToday(), []);
  });
});

test("D: a run that fails part-way is rolled back whole — program, codes and all", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine("Machine 1");
    const sk6 = f.product("SK6", "7/10");
    // A stray code already holds serial 3, so a run of 5 writes 1 and 2, then fails.
    f.raw
      .prepare(
        `INSERT INTO qr_batches (id, article_size_id, article, color, size, start_sequence, end_sequence, quantity, created_at)
         VALUES ('stray', ?, 'SK6', 'BLACKGREY', '7/10', 3, 3, 1, '2026-01-01T00:00:00.000Z')`
      )
      .run(sk6);
    f.raw
      .prepare(
        `INSERT INTO qr_codes (id, batch_id, article, color, size, sequence, status, created_at, updated_at)
         VALUES (?, 'stray', 'SK6', 'BLACKGREY', '7/10', 3, 'GENERATED', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run(buildQrId({ article: "SK6", color: "BLACKGREY", size: "7/10", sequence: 3 }));

    assert.throws(() => f.db.generateQrBatch({ articleSizeId: sk6, color: "BLACKGREY", quantity: 5, machineId: m1 }));
    assert.equal(f.count("SELECT COUNT(*) AS n FROM machine_programs"), 0);
    assert.equal(f.count("SELECT COUNT(*) AS n FROM qr_codes"), 1, "only the stray code");
    assert.deepEqual(f.programsToday(), []);
  });
});

test("a machine that cannot carry a program refuses the run before a serial is taken", async () => {
  await withFixture(async (f) => {
    const sk6 = f.product("SK6", "7/10");
    assert.throws(() => f.db.generateQrBatch({ articleSizeId: sk6, color: "RED", quantity: 2, machineId: "no-such-machine" }), /no longer set up/);

    const bare = f.db.createMachine({ name: "Machine 9" });
    assert.throws(() => f.db.generateQrBatch({ articleSizeId: sk6, color: "RED", quantity: 2, machineId: bare.id }), /no active machine contractor/);

    const m1 = await f.machine("Machine 1");
    f.raw.prepare("UPDATE parties SET status = 'INACTIVE' WHERE id = ?").run(f.babar);
    assert.throws(() => f.db.generateQrBatch({ articleSizeId: sk6, color: "RED", quantity: 2, machineId: m1 }), /no active packing contractor/);

    f.raw.prepare("UPDATE parties SET status = 'ACTIVE' WHERE id = ?").run(f.babar);
    f.db.setMachineStatus(m1, "INACTIVE");
    assert.throws(() => f.db.generateQrBatch({ articleSizeId: sk6, color: "RED", quantity: 2, machineId: m1 }), /retired/);

    assert.equal(f.count("SELECT COUNT(*) AS n FROM qr_codes"), 0);
    assert.equal(f.count("SELECT COUNT(*) AS n FROM machine_programs"), 0);
    const sequence = f.raw.prepare("SELECT last_sequence FROM qr_sequences WHERE article = 'SK6' AND color = 'RED'").get() as
      | { last_sequence: number }
      | undefined;
    assert.equal(sequence, undefined, "no serial was spent");
  });
});

test("E: articles, sizes and colours stay separate lines of a program", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine("Machine 1");
    f.db.generateQrBatch({ articleSizeId: f.product("SK6", "7/10"), color: "BLACKGREY", quantity: 10, machineId: m1 });
    f.db.generateQrBatch({ articleSizeId: f.product("SK6", "7/10"), color: "RED", quantity: 4, machineId: m1 });
    f.db.generateQrBatch({ articleSizeId: f.product("SK6", "11/13"), color: "BLACKGREY", quantity: 6, machineId: m1 });
    f.db.generateQrBatch({ articleSizeId: f.product("EVR9", "7/10"), color: "BLACKGREY", quantity: 2, machineId: m1 });

    const [program] = f.programsToday();
    assert.deepEqual(
      program.lines.map((line) => [line.article, line.size, line.color, line.cartons]),
      [
        ["EVR9", "7/10", "BLACKGREY", 2],
        ["SK6", "11/13", "BLACKGREY", 6],
        ["SK6", "7/10", "BLACKGREY", 10],
        ["SK6", "7/10", "RED", 4],
      ]
    );
    assert.equal(program.cartons, 22);
    assert.equal(program.equivalentDozens, 11);
  });
});

test("voided codes drop out of a program's cartons and are shown as voided", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine("Machine 1");
    const run = f.db.generateQrBatch({ articleSizeId: f.product("EVR9", "7/10"), color: "BLACK", quantity: 6, machineId: m1 });
    f.db.voidQrCode({ qrId: run.qrCodes[5].id, reason: "Label torn", actor: ACTOR });
    const [program] = f.programsToday();
    assert.equal(program.cartons, 5);
    assert.equal(program.voidedCartons, 1);
    assert.equal(program.lines[0].equivalentDozens, 2.5);
  });
});

test("G: a day program holds carton QRs only — the retired planning workflow runs nothing, and the machine can still be retired", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine("Machine 1");
    f.db.generateQrBatch({ articleSizeId: f.product("SK6", "7/10"), color: "BLACKGREY", quantity: 10, machineId: m1 });
    for (const table of ["machine_program_runs", "machine_program_upper_lines", "machine_program_carton_labels", "machine_program_fix_carton_labels"]) {
      assert.equal(f.count(`SELECT COUNT(*) AS n FROM ${table}`), 0, `${table} stays empty`);
    }
    f.db.setMachineStatus(m1, "INACTIVE");
    assert.equal(f.db.listMachines(true).find((row) => row.id === m1)?.status, "INACTIVE");
  });
});

test("a run generated without a machine (before Phase 1.1) is in no program", () => {
  const f = createFixture();
  try {
    f.db.generateQrBatch({ articleSizeId: f.product("SK6", "7/10"), color: "BLACK", quantity: 3 });
    assert.deepEqual(f.programsToday(), []);
  } finally {
    f.cleanup();
  }
});

// ─── Migration 077 ────────────────────────────────────────────────────────────

test("migration 077 places every existing run by the writer that made it", () => {
  const f = createFixture();
  try {
    const id = f.product("EVR9", "7/10");
    const generator = f.db.generateQrBatch({ articleSizeId: id, color: "BLACK", quantity: 4 });
    const bPage = f.db.generateQrBatch({ articleSizeId: id, color: B_CARTON_COLOUR, quantity: 2, grade: CARTON_GRADE.B });
    const programLabels = f.db.generateQrBatch({ articleSizeId: id, color: "BLACK", quantity: 2, requestedBy: "MP-000001" });
    const programB = f.db.generateQrBatch({ articleSizeId: id, color: B_CARTON_COLOUR, quantity: 1, grade: CARTON_GRADE.B, requestedBy: "MP-000001" });
    const adopted = f.db.generateQrBatch({ articleSizeId: id, color: "BLACK", quantity: 1, requestedBy: "WS001" });

    // The links the retired workflow wrote, without the whole program behind them.
    f.raw.exec("PRAGMA foreign_keys = OFF");
    f.raw
      .prepare(
        `INSERT INTO machine_programs (id, program_number, machine_id, contractor_party_id, machine_name_snapshot,
           contractor_name_snapshot, program_date, created_at, updated_at)
         VALUES ('mp-1', 1, 'm-1', 'p-1', 'M1', 'C1', '2026-10-01', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`
      )
      .run();
    f.raw
      .prepare(
        `INSERT INTO machine_program_carton_labels (store_exit_event_id, program_id, qr_batch_id, carton_count, device_id, created_at)
         VALUES ('exit-1', 'mp-1', ?, 2, 'device-1', '2026-10-01T00:00:00.000Z')`
      )
      .run(programLabels.batch.id);
    // An adopted code is produced in the same instant its one-code run is written.
    f.raw
      .prepare(
        `INSERT INTO qr_master (qr_id, product_variant_id, current_status, current_location_type, created_at, updated_at)
         VALUES (?, ?, 'PRODUCED', 'FACTORY', ?, ?)`
      )
      .run(adopted.qrCodes[0].id, adopted.qrCodes[0].productVariantId!, adopted.batch.createdAt, adopted.batch.createdAt);
    f.raw.exec("PRAGMA foreign_keys = ON");
    f.raw.exec("UPDATE qr_batches SET source = NULL");

    const migration = fs.readFileSync(path.resolve(process.cwd(), "../../migrations/sqlite/077_qr_batch_source.up.sql"), "utf-8");
    const updates = migration
      .split(";")
      .map((statement) => statement.replace(/^\s*--.*$/gm, "").trim())
      .filter((statement) => statement.startsWith("UPDATE"));
    assert.equal(updates.length, 4);
    for (const statement of updates) f.raw.exec(statement);

    const source = (batchId: string) =>
      (f.raw.prepare("SELECT source FROM qr_batches WHERE id = ?").get(batchId) as { source: string | null }).source;
    assert.equal(source(generator.batch.id), QR_BATCH_SOURCE.QR_GENERATOR);
    assert.equal(source(bPage.batch.id), QR_BATCH_SOURCE.B_CARTON);
    assert.equal(source(programLabels.batch.id), QR_BATCH_SOURCE.MACHINE_PROGRAM);
    assert.equal(source(programB.batch.id), QR_BATCH_SOURCE.MACHINE_PROGRAM);
    assert.equal(source(adopted.batch.id), QR_BATCH_SOURCE.SCAN_ADOPTED);
  } finally {
    f.cleanup();
  }
});
