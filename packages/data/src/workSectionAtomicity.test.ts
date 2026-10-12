import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteDatabase } from "./sqliteDatabase.js";

// 1b-1: createWorkSection allocates a WS- code and inserts the row as ONE unit, in both of the
// contexts it is actually called from.
//
//   standalone — the Raw Material IPC handler (apps/desktop/src/main/ipc/rawMaterials.ts), with
//                no transaction of its own
//   nested     — machinePrograms.ts createMachine, which has already opened BEGIN IMMEDIATE and
//                reaches this through defaultMachineSectionId when a machine is added on a floor
//                that has no section yet
//
// A BEGIN would have been wrong: correct standalone, but a nested transaction — an error — in
// createMachine. A SAVEPOINT is correct in both, and these tests pin the part that is easy to
// get subtly wrong: the savepoint must never commit or end the CALLER's transaction. If RELEASE
// ended the outer transaction, test 4 would see the section survive a ROLLBACK that was supposed
// to discard it, and createMachine's own ROLLBACK would fail on a transaction already gone.
//
// Test 5 pins the numbering, which has not changed: WS- plus a 3-digit MAX+1, continuing an
// existing series, and still idempotent on name.

const SCHEMA = path.resolve(process.cwd(), "src/local-schema.sql");

function createFixture(prefix: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `erp-${prefix}-`));
  const dbPath = path.join(tempDir, "x.db");
  const db = new SqliteDatabase({ dbPath, schemaPath: SCHEMA });
  return {
    db,
    raw: db.db,
    dbPath,
    cleanup: () => {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

/**
 * What a SECOND connection can see is what was really committed. Rows are copied into plain
 * objects because node:sqlite returns them with a null prototype, which deepEqual rejects.
 */
function committedSections(dbPath: string): Array<{ sectionCode: string; name: string }> {
  const reader = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = reader.prepare("SELECT section_code, name FROM work_sections ORDER BY section_code").all() as Array<{
      section_code: string;
      name: string;
    }>;
    return rows.map((r) => ({ sectionCode: String(r.section_code), name: String(r.name) }));
  } finally {
    reader.close();
  }
}

/**
 * The generated WS- code can never collide by construction (it is MAX+1 of the codes already
 * there), and status is a fixed literal, so the only honest way to fail the insert mid-call is
 * to make the table itself refuse it.
 */
function blockSectionInserts(raw: DatabaseSync): () => void {
  raw.exec(
    `CREATE TRIGGER block_section_insert BEFORE INSERT ON work_sections
     BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`
  );
  return () => raw.exec("DROP TRIGGER block_section_insert");
}

const sectionCount = (raw: DatabaseSync) =>
  (raw.prepare("SELECT COUNT(*) AS c FROM work_sections").get() as { c: number }).c;

/**
 * Forces a real UNIQUE failure on work_sections.section_code — the one uniqueness failure the
 * generated code can never produce by itself, since it is always MAX+1 of the codes present.
 * The trigger takes the code first, under a DIFFERENT name, so the insert that follows collides
 * on the code alone. Recursive triggers are off by default, so the trigger's own insert is not
 * re-entered.
 */
function stealNextSectionCode(raw: DatabaseSync): () => void {
  raw.exec(
    `CREATE TRIGGER steal_section_code BEFORE INSERT ON work_sections
     BEGIN
       INSERT INTO work_sections (id, section_code, name, status, created_at, updated_at)
       VALUES ('stolen-' || NEW.section_code, NEW.section_code, 'STOLEN ' || NEW.name, 'ACTIVE', NEW.created_at, NEW.updated_at);
     END`
  );
  return () => raw.exec("DROP TRIGGER steal_section_code");
}

/**
 * Proves no transaction and no savepoint were left open. BEGIN throws inside a transaction, so
 * if it succeeds the connection was clean — a leaked savepoint would also still hold the
 * implicit transaction open and be caught here.
 */
function assertConnectionIsClean(raw: DatabaseSync, message: string) {
  raw.exec("BEGIN IMMEDIATE TRANSACTION");
  raw.exec("ROLLBACK");
  assert.ok(true, message);
}

// ─── 1. Standalone success ───────────────────────────────────────────────────

test("standalone: a section is committed on its own and leaves no open transaction", () => {
  const f = createFixture("ws-standalone-ok");
  try {
    const section = f.db.createWorkSection({ name: " cutting  floor " });

    assert.equal(section.sectionCode, "WS-001");
    assert.equal(section.name, "CUTTING FLOOR");
    assert.equal(section.status, "ACTIVE");

    // RELEASE on a savepoint started outside a transaction commits it, so a second connection
    // must see the row. This is the assertion that would fail if the savepoint were never
    // released and the implicit transaction stayed open.
    assert.deepEqual(committedSections(f.dbPath), [{ sectionCode: "WS-001", name: "CUTTING FLOOR" }]);
    assertConnectionIsClean(f.raw, "savepoint released");
  } finally {
    f.cleanup();
  }
});

// ─── 2. Standalone failure ───────────────────────────────────────────────────

test("standalone: a failed insert writes nothing and leaves the connection usable", () => {
  const f = createFixture("ws-standalone-fail");
  try {
    const unblock = blockSectionInserts(f.raw);

    assert.throws(() => f.db.createWorkSection({ name: "PACKING" }), /simulated write failure/);

    assert.deepEqual(committedSections(f.dbPath), []);
    assert.equal(sectionCount(f.raw), 0);

    // The point of the test: the implicit transaction was rolled back AND the savepoint popped,
    // so the connection is not wedged. Before the fix there was no transaction to leak, but a
    // half-done savepoint here would break every later write on this connection.
    assertConnectionIsClean(f.raw, "no transaction left open by the failure");

    unblock();
    const recovered = f.db.createWorkSection({ name: "PACKING" });
    assert.equal(recovered.sectionCode, "WS-001");
    assert.deepEqual(committedSections(f.dbPath), [{ sectionCode: "WS-001", name: "PACKING" }]);
  } finally {
    f.cleanup();
  }
});

// ─── 3. Nested success ───────────────────────────────────────────────────────

test("nested: createMachine makes its default section inside its own transaction", () => {
  const f = createFixture("ws-nested-ok");
  try {
    assert.equal(sectionCount(f.raw), 0);

    // The real nested path: no section exists, so defaultMachineSectionId calls
    // createWorkSection while createMachine already holds BEGIN IMMEDIATE.
    const machine = f.db.createMachine({ name: "machine 1" });

    assert.equal(machine.name, "MACHINE 1");
    const sections = committedSections(f.dbPath);
    assert.deepEqual(sections, [{ sectionCode: "WS-001", name: "MACHINES" }]);

    // Machine and section committed together, by the OUTER transaction's COMMIT.
    const reader = new DatabaseSync(f.dbPath, { readOnly: true });
    try {
      const row = reader
        .prepare("SELECT m.name AS machine, s.name AS section FROM machines m JOIN work_sections s ON s.id = m.section_id")
        .get() as { machine: string; section: string } | undefined;
      assert.ok(row, "machine and section were committed together");
      assert.equal(row.machine, "MACHINE 1");
      assert.equal(row.section, "MACHINES");
    } finally {
      reader.close();
    }
    assertConnectionIsClean(f.raw, "createMachine closed its transaction");
  } finally {
    f.cleanup();
  }
});

// ─── 4. Outer rollback keeps control of the outer transaction ────────────────

test("nested: the caller's ROLLBACK still discards the section", () => {
  const f = createFixture("ws-outer-rollback");
  try {
    f.raw.exec("BEGIN IMMEDIATE TRANSACTION");
    const section = f.db.createWorkSection({ name: "DISPATCH" });
    assert.equal(section.sectionCode, "WS-001");
    // Visible to this connection, but NOT yet committed — RELEASE only popped the savepoint.
    assert.deepEqual(committedSections(f.dbPath), []);
    f.raw.exec("ROLLBACK");

    // If RELEASE had committed, the section would have survived this rollback.
    assert.equal(sectionCount(f.raw), 0);
    assert.deepEqual(committedSections(f.dbPath), []);
  } finally {
    f.cleanup();
  }
});

test("nested: a failed section leaves the outer transaction open and the caller's work intact", () => {
  const f = createFixture("ws-outer-survives");
  try {
    const packing = f.db.createWorkSection({ name: "PACKING" });
    const unblock = blockSectionInserts(f.raw);
    const now = new Date().toISOString();

    f.raw.exec("BEGIN IMMEDIATE TRANSACTION");
    f.raw
      .prepare("INSERT INTO machines (id, machine_code, name, section_id, sort_order, status, created_at, updated_at) VALUES ('m1','M-900','OUTER WORK', ?, 900, 'ACTIVE', ?, ?)")
      .run(packing.id, now, now);

    assert.throws(() => f.db.createWorkSection({ name: "DISPATCH" }), /simulated write failure/);

    // ROLLBACK TO rewound only the section. The outer transaction is still open and still the
    // caller's to finish — so its own earlier row is still there and can still be committed.
    assert.equal((f.raw.prepare("SELECT COUNT(*) AS c FROM machines WHERE id = 'm1'").get() as { c: number }).c, 1);
    f.raw.exec("COMMIT");
    assert.deepEqual(committedSections(f.dbPath), [{ sectionCode: "WS-001", name: "PACKING" }]);
    assert.equal((f.raw.prepare("SELECT COUNT(*) AS c FROM machines WHERE id = 'm1'").get() as { c: number }).c, 1);

    unblock();
    assertConnectionIsClean(f.raw, "outer COMMIT was accepted");
  } finally {
    f.cleanup();
  }
});

test("nested: createMachine rolls back cleanly when its default section cannot be written", () => {
  const f = createFixture("ws-nested-fail");
  try {
    const unblock = blockSectionInserts(f.raw);

    // createMachine's catch does a bare ROLLBACK. That only works if the savepoint left the
    // outer transaction alone — otherwise this throws "no transaction is active" and hides the
    // real error.
    assert.throws(() => f.db.createMachine({ name: "MACHINE 1" }), /simulated write failure/);

    assert.equal((f.raw.prepare("SELECT COUNT(*) AS c FROM machines").get() as { c: number }).c, 0);
    assert.equal(sectionCount(f.raw), 0);
    assertConnectionIsClean(f.raw, "createMachine's ROLLBACK found its transaction");

    unblock();
    const machine = f.db.createMachine({ name: "MACHINE 1" });
    assert.equal(machine.name, "MACHINE 1");
  } finally {
    f.cleanup();
  }
});

// ─── 5. Numbering regression ─────────────────────────────────────────────────

test("section codes keep the WS-000 format and continue the series", () => {
  const f = createFixture("ws-numbering");
  try {
    assert.equal(f.db.createWorkSection({ name: "FIRST" }).sectionCode, "WS-001");
    assert.equal(f.db.createWorkSection({ name: "SECOND" }).sectionCode, "WS-002");
    assert.equal(f.db.createWorkSection({ name: "THIRD" }).sectionCode, "WS-003");

    // Still idempotent on name: an existing section is returned, not renumbered.
    const again = f.db.createWorkSection({ name: "  second  " });
    assert.equal(again.sectionCode, "WS-002");
    assert.equal(again.name, "SECOND");
    assert.equal(sectionCount(f.raw), 3);
  } finally {
    f.cleanup();
  }
});

test("an existing section series is continued, never restarted", () => {
  const f = createFixture("ws-continue");
  try {
    const now = new Date().toISOString();
    f.raw
      .prepare("INSERT INTO work_sections (id, section_code, name, status, created_at, updated_at) VALUES (?, ?, ?, 'ACTIVE', ?, ?)")
      .run("s-old", "WS-007", "LEGACY SECTION", now, now);

    assert.equal(f.db.createWorkSection({ name: "NEXT ONE" }).sectionCode, "WS-008");
  } finally {
    f.cleanup();
  }
});

// ─── 6. The existing-name contract ───────────────────────────────────────────
//
// The name check now runs inside the savepoint, so these pin that moving it changed nothing a
// caller can see: an existing section still comes back as it stands, and the read-only path
// still leaves the transaction state exactly as it found it.

test("an existing section is returned as it stands, not created again", () => {
  const f = createFixture("ws-existing");
  try {
    const first = f.db.createWorkSection({ name: "CUTTING FLOOR" });
    const again = f.db.createWorkSection({ name: "  cutting   floor  " });

    assert.equal(again.id, first.id, "the same row, not a second one");
    assert.equal(again.sectionCode, "WS-001");
    assert.equal(again.name, "CUTTING FLOOR");
    assert.equal(again.status, "ACTIVE");
    assert.equal(sectionCount(f.raw), 1);
    assertConnectionIsClean(f.raw, "the lookup path leaves no savepoint behind");

    // Reported as stored: a retired section comes back retired rather than being revived or
    // replaced by a second row under the same name.
    f.db.setWorkSectionStatus(first.id, "INACTIVE");
    const retired = f.db.createWorkSection({ name: "CUTTING FLOOR" });
    assert.equal(retired.id, first.id);
    assert.equal(retired.status, "INACTIVE");
    assert.equal(sectionCount(f.raw), 1);
  } finally {
    f.cleanup();
  }
});

test("the existing-name path inside an outer transaction leaves it open", () => {
  const f = createFixture("ws-existing-nested");
  try {
    const first = f.db.createWorkSection({ name: "PACKING" });

    f.raw.exec("BEGIN IMMEDIATE TRANSACTION");
    assert.equal(f.db.createWorkSection({ name: "PACKING" }).id, first.id);
    // RELEASE popped the savepoint only — the transaction is still the caller's to finish.
    f.raw.exec("ROLLBACK");

    assert.equal(sectionCount(f.raw), 1, "the rollback discarded nothing that was already there");
  } finally {
    f.cleanup();
  }
});

// ─── 7. An unrelated uniqueness failure is not a duplicate name ──────────────

test("a section_code collision is raised, never reported as an existing section", () => {
  const f = createFixture("ws-code-collision");
  try {
    const restore = stealNextSectionCode(f.raw);

    // A code collision is a numbering fault, not a section that already exists. It has to
    // surface: answering it with some other row would hand back a section nobody asked for.
    assert.throws(
      () => f.db.createWorkSection({ name: "DISPATCH" }),
      /UNIQUE constraint failed: work_sections\.section_code/,
      "the numbering fault must surface"
    );

    // The statement rollback took the trigger's row with it, and ROLLBACK TO took the rest.
    assert.equal(sectionCount(f.raw), 0);
    assert.deepEqual(committedSections(f.dbPath), []);
    assertConnectionIsClean(f.raw, "no transaction or savepoint left open by the collision");

    restore();
    assert.equal(f.db.createWorkSection({ name: "DISPATCH" }).sectionCode, "WS-001");
  } finally {
    f.cleanup();
  }
});
