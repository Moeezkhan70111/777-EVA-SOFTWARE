import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase, NumberRangeError, PROTECTED_NUMBER_SETTING_KEYS } from "./sqliteDatabase.js";
import { NUMBER_BLOCK_SETTING_KEY, NUMBER_BLOCK_CONFIRMED_KEY } from "./sqliteDatabase.js";

// PROVISIONING A COMPUTER'S DOCUMENT-NUMBER RANGE.
//
// There is no server issuing blocks, so a computer may record a block for itself in exactly one
// case: it is the installation that ALREADY holds the company's numbered documents, which can only
// be block 1. These tests pin that boundary from both sides:
//
//   * the existing-data computer can adopt block 1, once, and the series continues unchanged
//   * a NEW installation is refused, because nothing on it can work out which block it should hold
//   * a computer whose numbers do not fit block 1 is refused, and nothing is recorded
//   * a block already recorded is never reassigned
//   * reading the status never writes anything
//
// Every case runs against its own throwaway database under the OS temp folder. The real database
// is never opened.

function createFixture(prefix: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `erp-${prefix}-`));
  const db = new SqliteDatabase({
    dbPath: path.join(tempDir, "x.db"),
    schemaPath: path.resolve(process.cwd(), "src/local-schema.sql"),
  });
  return {
    db,
    raw: db.db,
    cleanup: () => {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

const withFixture = (prefix: string, body: (f: ReturnType<typeof createFixture>) => void) => {
  const f = createFixture(prefix);
  try {
    body(f);
  } finally {
    f.cleanup();
  }
};

const party = (db: SqliteDatabase, name: string) =>
  db.createParty({ partyName: name, partyType: "CUSTOMER", city: "Lahore", status: "ACTIVE" });

/** Forgets the recorded block, leaving the data exactly as an un-provisioned installation holds it. */
const forgetBlock = (db: SqliteDatabase) => {
  db.db
    .prepare(`DELETE FROM app_settings WHERE setting_key IN (?, ?)`)
    .run(NUMBER_BLOCK_SETTING_KEY, NUMBER_BLOCK_CONFIRMED_KEY);
};

const settingRows = (db: SqliteDatabase): number => {
  const row = db.db
    .prepare(`SELECT COUNT(*) AS n FROM app_settings WHERE setting_key IN (?, ?)`)
    .get(NUMBER_BLOCK_SETTING_KEY, NUMBER_BLOCK_CONFIRMED_KEY) as { n: number };
  return Number(row.n);
};

// ─── a new installation ──────────────────────────────────────────────────────

test("a new installation reports that it has no range, and cannot give itself one", () => {
  withFixture("provision-fresh", ({ db }) => {
    const status = db.getNumberBlockStatus();
    assert.equal(status.block, null);
    assert.equal(status.range, null);
    assert.equal(status.confirmed, false);
    assert.equal(status.problem, "NOT_CONFIGURED");
    assert.equal(status.adoption.allowed, false);
    assert.equal(status.adoption.refusal, "NO_EXISTING_DATA");
    assert.match(status.adoption.detail, /new installation/i);

    assert.throws(
      () => db.adoptExistingDataNumberBlock("admin"),
      (error: unknown) => error instanceof NumberRangeError && error.reason === "NO_EXISTING_DATA"
    );

    // Refused means nothing was written: the computer is still unconfigured.
    assert.equal(settingRows(db), 0);
    assert.equal(db.getNumberBlock(), null);
    assert.equal(db.isNumberBlockConfirmed(), false);
  });
});

// WHAT A NEW COMPUTER IS TOLD. The refusal is shown in Settings directly above the control that
// records a range, so it must not claim the application cannot do it -- that sentence was true
// only until assignNumberBlock existed, and a stale one sends an administrator looking for a
// workaround they do not need.
test("a new installation is pointed at the assignment, not told it is impossible", () => {
  withFixture("provision-refusal-text", ({ db }) => {
    const { adoption } = db.getNumberBlockStatus();
    assert.equal(adoption.refusal, "NO_EXISTING_DATA");
    assert.doesNotMatch(adoption.detail, /no way to do that|not possible|cannot be done/i);
    assert.match(adoption.detail, /assigned deliberately/i);
    // And it still says where the authority is, because nothing here can check it.
    assert.match(adoption.detail, /factory's record/i);
  });
});

// WHAT A SECOND COMPUTER IS OFFERED. Carried in the status so no screen works a range out for
// itself: the Settings panel shows these numbers and the assignment records exactly them.
test("the status offers a second computer the four ranges that are not block 1", () => {
  withFixture("provision-assignable", ({ db }) => {
    assert.deepEqual(db.getNumberBlockStatus().assignable, [
      { block: 2, lo: 100_000, hi: 199_999 },
      { block: 3, lo: 200_000, hi: 299_999 },
      { block: 4, lo: 300_000, hi: 399_999 },
      { block: 5, lo: 400_000, hi: 499_999 },
    ]);
  });
});

test("the status offers nothing once a range is recorded here, valid or not", () => {
  withFixture("provision-assignable-none", ({ db }) => {
    db.setNumberBlock(3, "test");
    assert.deepEqual(db.getNumberBlockStatus().assignable, []);

    // An unusable stored value is corrected at the database by an administrator, never
    // reassigned from the application: documents may already carry numbers from it. Written
    // through setSettings because setNumberBlock refuses it, which is the point.
    db.setSettings({ [NUMBER_BLOCK_SETTING_KEY]: "42" }, "test");
    const status = db.getNumberBlockStatus();
    assert.equal(status.problem, "INVALID");
    assert.deepEqual(status.assignable, []);
  });
});

test("reading the status writes nothing, however often it is read", () => {
  withFixture("provision-readonly", ({ db }) => {
    db.getNumberBlockStatus();
    db.getNumberBlockStatus();
    db.getNumberBlockStatus();
    assert.equal(settingRows(db), 0);
  });
});

// ─── the computer that already holds the company's documents ─────────────────

test("the existing-data computer adopts block 1, and its series continues unchanged", () => {
  withFixture("provision-existing", ({ db }) => {
    // Build the state the development computer is actually in: real documents, numbered in
    // block 1, and no block recorded yet.
    db.setNumberBlock(1, "test");
    const firstCode = db.getParty(party(db, "Al-Madina Traders"))?.partyCode;
    assert.equal(firstCode, "PTY-000001");
    forgetBlock(db);

    const before = db.getNumberBlockStatus();
    assert.equal(before.problem, "NOT_CONFIGURED");
    assert.equal(before.adoption.allowed, true);
    assert.equal(before.adoption.refusal, null);

    const range = db.adoptExistingDataNumberBlock("admin");
    assert.deepEqual(range, { block: 1, lo: 1, hi: 99_999 });

    const after = db.getNumberBlockStatus();
    assert.equal(after.block, 1);
    assert.deepEqual(after.range, { block: 1, lo: 1, hi: 99_999 });
    assert.equal(after.confirmed, true);
    assert.equal(after.problem, null);
    assert.equal(after.storedValue, null);

    // Nothing was renumbered, and the next number simply continues the series.
    const unchanged = db.db
      .prepare("SELECT party_code FROM parties WHERE party_name = ?")
      .get("Al-Madina Traders") as { party_code: string };
    assert.equal(unchanged.party_code, "PTY-000001");
    assert.equal(db.getParty(party(db, "Chenab Shoe House"))?.partyCode, "PTY-000002");
  });
});

test("a number typed from a paper book does not stop the existing-data computer provisioning", () => {
  withFixture("provision-external", ({ db, raw }) => {
    db.setNumberBlock(1, "test");
    const customerId = party(db, "Ravi Footwear");
    // Sale and purchase voucher numbers come off a paper book, so they may be any value at all —
    // including one no block could have produced. That must not be read as the wrong block.
    const now = new Date().toISOString();
    raw
      .prepare(
        `INSERT INTO sale_vouchers (id, voucher_number, party_id, voucher_date, book_no, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run("sv-paper", "900000", customerId, now, "B-1", now, now);
    forgetBlock(db);

    const status = db.getNumberBlockStatus();
    assert.equal(status.adoption.allowed, true);
    assert.deepEqual(db.adoptExistingDataNumberBlock("admin"), { block: 1, lo: 1, hi: 99_999 });
  });
});

// ─── refusals that protect another computer's numbers ────────────────────────

test("a computer whose numbers do not fit block 1 is refused, and nothing is recorded", () => {
  withFixture("provision-outside", ({ db }) => {
    // Numbers from block 2 — this computer is not the block 1 machine, whatever it was told.
    db.setNumberBlock(2, "test");
    assert.equal(db.getParty(party(db, "Shalimar Sales"))?.partyCode, "PTY-100000");
    forgetBlock(db);

    const status = db.getNumberBlockStatus();
    assert.equal(status.adoption.allowed, false);
    assert.equal(status.adoption.refusal, "OUT_OF_RANGE");
    assert.match(status.adoption.detail, /party codes \(highest 100000\)/);

    assert.throws(
      () => db.adoptExistingDataNumberBlock("admin"),
      (error: unknown) => error instanceof NumberRangeError && error.reason === "OUT_OF_RANGE"
    );
    assert.equal(settingRows(db), 0);
  });
});

test("a range already recorded is never reassigned", () => {
  withFixture("provision-once", ({ db }) => {
    db.setNumberBlock(3, "test");
    party(db, "Kohinoor Traders");

    const status = db.getNumberBlockStatus();
    assert.equal(status.block, 3);
    assert.equal(status.adoption.allowed, false);
    assert.equal(status.adoption.refusal, "ALREADY_CONFIGURED");

    assert.throws(
      () => db.adoptExistingDataNumberBlock("admin"),
      (error: unknown) => error instanceof NumberRangeError && error.reason === "ALREADY_CONFIGURED"
    );
    // Still block 3. A refused reassignment leaves the computer exactly as it was.
    assert.equal(db.getNumberBlock(), 3);
  });
});

test("adopting twice is refused the second time, and the first assignment stands", () => {
  withFixture("provision-twice", ({ db }) => {
    db.setNumberBlock(1, "test");
    party(db, "Jhelum Shoe Mart");
    forgetBlock(db);

    db.adoptExistingDataNumberBlock("admin");
    assert.throws(
      () => db.adoptExistingDataNumberBlock("admin"),
      (error: unknown) => error instanceof NumberRangeError && error.reason === "ALREADY_CONFIGURED"
    );
    assert.equal(db.getNumberBlock(), 1);
    assert.equal(db.isNumberBlockConfirmed(), true);
  });
});

// ─── a stored value that is not a block at all ───────────────────────────────

test("an unusable stored range is reported as invalid, with what is stored, and is not quietly fixed", () => {
  withFixture("provision-invalid", ({ db }) => {
    db.setSettings({ [NUMBER_BLOCK_SETTING_KEY]: "99" }, "test");

    const status = db.getNumberBlockStatus();
    assert.equal(status.block, null);
    assert.equal(status.range, null);
    assert.equal(status.problem, "INVALID");
    assert.equal(status.storedValue, "99");
    // Provisioning does not treat a bad value as "unconfigured" and overwrite it: a wrong range
    // is a mistake to look at, not one to paper over.
    assert.equal(status.adoption.refusal, "ALREADY_CONFIGURED");
    assert.throws(() => db.adoptExistingDataNumberBlock("admin"), NumberRangeError);
    assert.equal(db.getNumberBlockStatus().storedValue, "99");
  });
});

// ─── an ordinary settings save cannot change the range ──────────────────────

// ─── a second computer ───────────────────────────────────────────────────────
//
// Until now a second computer could not be provisioned at all: block 1 is the only one a machine
// can work out for itself, and nothing could record any other. That left every numbered document
// unavailable on a second machine -- no product, no party, no gatepass -- which is the gap that
// stopped a two-computer pilot. assignNumberBlock closes it, under the same two rules adoption
// already enforces: block 1 is not handed out, and a recorded range is never reassigned.

test("an unconfigured second computer is given a range from the factory's record", () => {
  withFixture("assign-fresh", ({ db }) => {
    assert.equal(db.getNumberBlock(), null);

    const range = db.assignNumberBlock(2, "owner");
    assert.deepEqual(range, { block: 2, lo: 100_000, hi: 199_999 });

    const status = db.getNumberBlockStatus();
    assert.equal(status.block, 2);
    assert.deepEqual(status.range, { block: 2, lo: 100_000, hi: 199_999 });
    assert.equal(status.confirmed, true);
    assert.equal(status.problem, null);

    // And the series now issues numbers from inside that block, so the two computers cannot
    // collide: computer 1 is still handing out PTY-000001 upwards.
    assert.equal(db.getParty(party(db, "Second Computer Traders"))?.partyCode, "PTY-100000");
  });
});

test("every assignable block is accepted, and each gets its own hundred thousand", () => {
  for (const [block, lo, hi] of [
    [2, 100_000, 199_999],
    [3, 200_000, 299_999],
    [4, 300_000, 399_999],
    [5, 400_000, 499_999],
  ] as const) {
    withFixture(`assign-block-${String(block)}`, ({ db }) => {
      assert.deepEqual(db.assignNumberBlock(block, "owner"), { block, lo, hi });
    });
  }
});

test("block 1 is never handed to a second computer, whatever an administrator asks for", () => {
  withFixture("assign-block-one", ({ db }) => {
    assert.throws(
      () => db.assignNumberBlock(1, "owner"),
      (error: unknown) =>
        error instanceof NumberRangeError &&
        error.reason === "INVALID" &&
        /already holds the company's numbered documents/i.test(error.message)
    );
    // Refused means nothing was written.
    assert.equal(settingRows(db), 0);
    assert.equal(db.getNumberBlock(), null);
  });
});

test("a block outside 2-5 is refused, and nothing is recorded", () => {
  withFixture("assign-bounds", ({ db }) => {
    for (const bad of [0, -1, 6, 99, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => db.assignNumberBlock(bad, "owner"),
        (error: unknown) => error instanceof NumberRangeError && error.reason === "INVALID",
        `block ${String(bad)} must be refused`
      );
    }
    assert.equal(settingRows(db), 0);
  });
});

test("a computer that already has a range is never reassigned", () => {
  withFixture("assign-already", ({ db }) => {
    db.assignNumberBlock(3, "owner");

    assert.throws(
      () => db.assignNumberBlock(4, "owner"),
      (error: unknown) => error instanceof NumberRangeError && error.reason === "ALREADY_CONFIGURED"
    );
    // The first assignment stands, untouched.
    assert.equal(db.getNumberBlock(), 3);
    assert.deepEqual(db.getNumberBlockStatus().range, { block: 3, lo: 200_000, hi: 299_999 });

    // And the existing-data route is refused for the same reason, so neither path can overwrite.
    assert.throws(
      () => db.adoptExistingDataNumberBlock("owner"),
      (error: unknown) => error instanceof NumberRangeError && error.reason === "ALREADY_CONFIGURED"
    );
    assert.equal(db.getNumberBlock(), 3);
  });
});

test("a computer holding documents from another block is refused, and told which", () => {
  withFixture("assign-conflict", ({ db }) => {
    // This machine already issued PTY-000001 -- a block 1 number. Recording block 2 here would
    // mean it holds documents it could not have issued, so the assignment is wrong.
    db.setNumberBlock(1, "test");
    assert.equal(db.getParty(party(db, "Al-Madina Traders"))?.partyCode, "PTY-000001");
    forgetBlock(db);

    assert.throws(
      () => db.assignNumberBlock(2, "owner"),
      (error: unknown) =>
        error instanceof NumberRangeError &&
        error.reason === "OUT_OF_RANGE" &&
        /party codes/i.test(error.message) &&
        /100000-199999/.test(error.message)
    );
    assert.equal(settingRows(db), 0, "a refused assignment records nothing");
  });
});

test("an assignment is one transaction: a refusal leaves no half-written range", () => {
  withFixture("assign-atomic", ({ db }) => {
    db.setNumberBlock(1, "test");
    party(db, "Al-Madina Traders");
    forgetBlock(db);

    assert.throws(() => db.assignNumberBlock(5, "owner"), NumberRangeError);
    // Neither key, not one of the two.
    assert.equal(settingRows(db), 0);
    assert.equal(db.getNumberBlock(), null);
    assert.equal(db.isNumberBlockConfirmed(), false);
    assert.equal(db.getNumberBlockStatus().problem, "NOT_CONFIGURED");
  });
});

test("an operator's settings save writes everything except this computer's range", () => {
  withFixture("provision-settings", ({ db }) => {
    db.setNumberBlock(1, "test");

    const { dropped } = db.setOperatorSettings(
      {
        "backup.folder": "D:/backups",
        theme: "dark",
        [NUMBER_BLOCK_SETTING_KEY]: "4",
        [NUMBER_BLOCK_CONFIRMED_KEY]: "1",
      },
      "desktop-ui"
    );

    assert.deepEqual(dropped.sort(), [NUMBER_BLOCK_SETTING_KEY, NUMBER_BLOCK_CONFIRMED_KEY].sort());
    const saved = db.getSettings();
    assert.equal(saved["backup.folder"], "D:/backups");
    assert.equal(saved.theme, "dark");
    // The range is untouched: a settings field is not a way to take another computer's numbers.
    assert.equal(db.getNumberBlock(), 1);
  });
});

test("an ordinary settings save is unaffected", () => {
  withFixture("provision-settings-plain", ({ db }) => {
    const { dropped } = db.setOperatorSettings({ "backup.auto.time": "22:00" }, "desktop-ui");
    assert.deepEqual(dropped, []);
    assert.equal(db.getSettings()["backup.auto.time"], "22:00");
  });
});

// ─── the keys the process boundary has to protect ────────────────────────────

test("the protected settings keys are exactly the two that decide this computer's range", () => {
  assert.deepEqual([...PROTECTED_NUMBER_SETTING_KEYS].sort(), [
    "numbering.block",
    "numbering.block.confirmed",
  ]);
});
