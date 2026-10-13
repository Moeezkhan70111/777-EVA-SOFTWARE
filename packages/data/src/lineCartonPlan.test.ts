import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "./sqliteDatabase.js";

// An upper line's cartons follow its PLAN (migration 076), and two things about that are easy to
// get wrong in a way no one notices until carton identities are already printed:
//
//   * a plan that does not come to whole cartons must be REFUSED, never rounded. 4.5 DOZEN is 9
//     cartons; 4.25 DOZEN would be 8.5, and half a carton cannot be labelled.
//   * two terminals printing the same line must not between them print more than the plan. The
//     owed figure is re-read inside the write lock for exactly this reason.
//
// A deliberately small fixture: a program with one upper line, built directly, because these two
// questions are about the plan arithmetic and the write lock — not about scanning. The scan-driven
// harness lives in machineProgramStoreOut.test.ts and is not needed here.

const SCHEMA = path.resolve(process.cwd(), "src/local-schema.sql");
const MIGRATIONS = path.resolve(process.cwd(), "../../migrations/sqlite");

interface Fixture {
  db: SqliteDatabase;
  dbPath: string;
  programId: string;
  lineId: string;
  cleanup: () => void;
}

/** One program, one run, one upper line planned at `dozens` of a GREY upper. */
function createFixture(prefix: string, dozens: number): Fixture {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `erp-${prefix}-`));
  const dbPath = path.join(tempDir, "cartons.db");
  const db = new SqliteDatabase({ dbPath, schemaPath: SCHEMA, migrationsDir: MIGRATIONS });
  const raw = db.db;
  const now = new Date().toISOString();

  const unitId = db.createInventoryUnit({ code: "DOZEN", name: "Dozen" });
  const categoryId = db.createInventoryCategory({ name: "UPPERS" });
  // The carton QR is identified by the UPPER's colour, so the material must carry one.
  db.addInventoryCategoryField({ categoryId, fieldKey: "color", label: "Colour", fieldType: "TEXT" });
  const item = db.createInventoryItem({ categoryId, values: { color: "GREY" }, unitId });

  const contractor = db.createParty({ partyName: "PROBE CONTRACTOR", partyType: "SUPPLIER", city: "Lahore", status: "ACTIVE" });
  const machine = db.createMachine({ name: "PROBE MACHINE" });
  db.createProduct({ article: "SK46", size: "4/6", sellingPrice: 600, status: "ACTIVE" });
  const articleSizeId = (raw.prepare("SELECT id FROM article_sizes WHERE article = 'SK46' LIMIT 1").get() as { id: string }).id;

  raw
    .prepare(
      `INSERT INTO machine_programs (id, program_number, machine_id, contractor_party_id, machine_name_snapshot,
         contractor_name_snapshot, program_date, status, total_bags, created_at, updated_at)
       VALUES ('prog-1', 9201, ?, ?, 'PROBE MACHINE', 'PROBE CONTRACTOR', '2026-10-14', 'PROGRAMMED', 0, ?, ?)`
    )
    .run(machine.id, contractor, now, now);
  raw
    .prepare(
      `INSERT INTO machine_program_runs (id, program_id, injector_no, run_no, sole_colour, article_size_id,
         created_at, updated_at, quantity, unit_id) VALUES ('run-1','prog-1',1,1,'BLACK',?,?,?,?,?)`
    )
    .run(articleSizeId, now, now, dozens, unitId);
  raw
    .prepare(
      `INSERT INTO machine_program_upper_lines (id, run_id, line_no, item_id, quantity, unit_id, created_at, updated_at)
       VALUES ('line-1','run-1',1,?,?,?,?,?)`
    )
    .run(item.id, dozens, unitId, now, now);

  return {
    db,
    dbPath,
    programId: "prog-1",
    lineId: "line-1",
    cleanup: () => {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

const lineOf = (db: SqliteDatabase, programId: string, lineId: string) => {
  const line = db.listMachineProgramCartonLines(programId).find((candidate) => candidate.lineId === lineId);
  assert.ok(line, "the fixture's upper line is on the program");
  return line;
};

const labelledCartons = (db: SqliteDatabase): number =>
  Number(
    (db.db.prepare("SELECT COALESCE(SUM(carton_count), 0) AS total FROM machine_program_line_carton_labels").get() as {
      total: number;
    }).total
  );

// ─── Fractional dozens ───────────────────────────────────────────────────────

test("a line planned at 4.5 DOZEN is owed 9 cartons", () => {
  const f = createFixture("carton-half", 4.5);
  try {
    const line = lineOf(f.db, f.programId, f.lineId);
    assert.equal(line.quantity, 4.5);
    assert.equal(line.unitCode, "DOZEN");
    assert.equal(line.cartonsPlanned, 9, "half a dozen is a whole carton");
    assert.equal(line.cartonsToPrint, 9, "nothing printed yet");
    assert.equal(line.cartonNote, null, "there is nothing to explain away");
  } finally {
    f.cleanup();
  }
});

test("a line that does not come to whole cartons is refused, never rounded", () => {
  const f = createFixture("carton-quarter", 4.25);
  try {
    const line = lineOf(f.db, f.programId, f.lineId);
    assert.equal(line.quantity, 4.25);
    assert.equal(line.cartonsPlanned, null, "8.5 cartons cannot be labelled");
    assert.equal(line.cartonsToPrint, 0, "and nothing is offered");
    assert.match(line.cartonNote ?? "", /whole cartons of DOZEN/);

    // Not merely hidden in the UI: the write refuses too.
    assert.throws(
      () => f.db.printMachineProgramLineCartons({ programId: f.programId, lineId: f.lineId, printedBy: "tester", deviceId: "probe" }),
      /whole cartons of DOZEN/
    );
    assert.equal(labelledCartons(f.db), 0, "no carton identity was created");
  } finally {
    f.cleanup();
  }
});

// ─── Printing never exceeds the plan ─────────────────────────────────────────

test("printing a line's cartons records exactly the plan, and a second print is refused", () => {
  const f = createFixture("carton-once", 4.5);
  try {
    const printed = f.db.printMachineProgramLineCartons({
      programId: f.programId,
      lineId: f.lineId,
      printedBy: "tester",
      deviceId: "probe",
    });
    assert.equal(printed.qrCodes.length, 9, "nine carton labels for 4.5 DOZEN");
    assert.equal(labelledCartons(f.db), 9);
    assert.equal(lineOf(f.db, f.programId, f.lineId).cartonsToPrint, 0, "the line owes nothing more");

    assert.throws(
      () => f.db.printMachineProgramLineCartons({ programId: f.programId, lineId: f.lineId, printedBy: "tester", deviceId: "probe" }),
      /already been labelled/
    );
    assert.equal(labelledCartons(f.db), 9, "the refused second print added nothing");
  } finally {
    f.cleanup();
  }
});

test("raising the plan owes only the difference", () => {
  const f = createFixture("carton-raised", 4.5);
  try {
    f.db.printMachineProgramLineCartons({ programId: f.programId, lineId: f.lineId, printedBy: "tester", deviceId: "probe" });
    assert.equal(labelledCartons(f.db), 9);

    // The floor raises the line to 6 DOZEN — 12 cartons, 3 of them still owed.
    f.db.db.prepare("UPDATE machine_program_upper_lines SET quantity = 6 WHERE id = ?").run(f.lineId);
    assert.equal(lineOf(f.db, f.programId, f.lineId).cartonsPlanned, 12);
    assert.equal(lineOf(f.db, f.programId, f.lineId).cartonsToPrint, 3, "only the difference");

    const more = f.db.printMachineProgramLineCartons({
      programId: f.programId,
      lineId: f.lineId,
      printedBy: "tester",
      deviceId: "probe",
    });
    assert.equal(more.qrCodes.length, 3);
    assert.equal(labelledCartons(f.db), 12, "the plan, not twice the plan");
  } finally {
    f.cleanup();
  }
});

// ─── Two terminals at once ───────────────────────────────────────────────────

test("two terminals printing the same line cannot between them exceed the plan", async () => {
  const f = createFixture("carton-race", 4.5);
  const second = new SqliteDatabase({ dbPath: f.dbPath, schemaPath: SCHEMA, migrationsDir: MIGRATIONS });
  try {
    const attempt = (db: SqliteDatabase, deviceId: string) =>
      Promise.resolve()
        .then(() => db.printMachineProgramLineCartons({ programId: f.programId, lineId: f.lineId, printedBy: "tester", deviceId }))
        .then((printed) => ({ ok: true as const, cartons: printed.qrCodes.length }))
        .catch((error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) }));

    const results = await Promise.all([attempt(f.db, "store-1"), attempt(second, "store-2")]);
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);

    // The owed figure is read inside the write lock, so the second attempt sees the first one's
    // row and has nothing left to print. What must never happen is 18 cartons for a 9 plan.
    assert.equal(winners.length, 1, `exactly one print succeeded: ${JSON.stringify(results)}`);
    assert.equal(losers.length, 1);
    assert.match((losers[0] as { reason: string }).reason, /already been labelled/);
    assert.equal(labelledCartons(f.db), 9, "nine cartons for a nine-carton plan, never eighteen");

    const rows = f.db.db
      .prepare("SELECT upper_line_id, carton_count FROM machine_program_line_carton_labels")
      .all() as Array<{ upper_line_id: string; carton_count: number }>;
    assert.equal(rows.length, 1, "one print, one row");
  } finally {
    second.close();
    f.cleanup();
  }
});
