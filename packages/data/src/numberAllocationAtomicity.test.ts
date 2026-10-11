import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "./sqliteDatabase.js";

// Phase 1a: the number is now read inside the same transaction that inserts the row.
//
// Before this change six paths read their next number BEFORE opening the write lock, so the
// value that was checked was not necessarily the value that was written. On one machine the
// window was tiny; with a second writer it is a real race, and every one of these columns is
// UNIQUE, so the loser's insert fails.
//
// These tests pin the two things that must not change — the FORMAT of every allocated number,
// and the continuation of an existing series — plus the new atomicity guarantee for
// createParty, which previously had no transaction at all.

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

const makeParty = (db: SqliteDatabase, name: string) =>
  db.createParty({ partyName: name, partyType: "CUSTOMER", city: "Lahore", status: "ACTIVE" });

// ─── formats must not drift ──────────────────────────────────────────────────

test("party codes keep the PTY-000000 format and continue the series", () => {
  const f = createFixture("party-format");
  try {
    assert.equal(f.db.getNextPartyCode(), "PTY-000001");
    const first = makeParty(f.db, "PARTY ONE");
    const second = makeParty(f.db, "PARTY TWO");

    const codes = f.raw.prepare("SELECT party_code FROM parties ORDER BY party_code").all() as Array<{ party_code: string }>;
    assert.deepEqual(codes.map((c) => c.party_code), ["PTY-000001", "PTY-000002"]);
    assert.notEqual(first, second);
    // The preview helper stays public and keeps working — the Party form reads it over IPC.
    assert.equal(f.db.getNextPartyCode(), "PTY-000003");
  } finally {
    f.cleanup();
  }
});

test("an existing party series is continued, never restarted", () => {
  const f = createFixture("party-continue");
  try {
    const now = new Date().toISOString();
    f.raw
      .prepare("INSERT INTO parties (id,party_code,party_name,party_type,status,created_at,updated_at) VALUES ('seed','PTY-000417','SEEDED','CUSTOMER','ACTIVE',?,?)")
      .run(now, now);
    makeParty(f.db, "NEXT ONE");
    const codes = f.raw.prepare("SELECT party_code FROM parties ORDER BY party_code").all() as Array<{ party_code: string }>;
    assert.deepEqual(codes.map((c) => c.party_code), ["PTY-000417", "PTY-000418"]);
  } finally {
    f.cleanup();
  }
});

test("sale voucher numbers stay bare sequential integers", () => {
  const f = createFixture("sale-format");
  try {
    const partyId = makeParty(f.db, "BILL PARTY");
    const a = f.db.createSaleVoucher({ partyId, voucherDate: "2026-01-01", bookNo: "1", lineItems: [] } as never) as { voucherNumber: string };
    const b = f.db.createSaleVoucher({ partyId, voucherDate: "2026-01-02", bookNo: "1", lineItems: [] } as never) as { voucherNumber: string };
    assert.equal(a.voucherNumber, "1");
    assert.equal(b.voucherNumber, "2");
  } finally {
    f.cleanup();
  }
});

test("a bill numbered by hand from the paper book is never renumbered", () => {
  const f = createFixture("sale-manual");
  try {
    const partyId = makeParty(f.db, "MANUAL PARTY");
    const manual = f.db.createSaleVoucher({ partyId, voucherDate: "2026-01-01", bookNo: "7", voucherNumber: "5012", lineItems: [] } as never) as { voucherNumber: string };
    assert.equal(manual.voucherNumber, "5012", "the typed number must survive exactly");

    // The next automatic number continues from the highest, as before.
    const auto = f.db.createSaleVoucher({ partyId, voucherDate: "2026-01-02", bookNo: "7", lineItems: [] } as never) as { voucherNumber: string };
    assert.equal(auto.voucherNumber, "5013");
  } finally {
    f.cleanup();
  }
});

test("purchase voucher numbers keep their format and honour a supplied number", () => {
  const f = createFixture("purchase-format");
  try {
    const partyId = makeParty(f.db, "SUPPLIER");
    assert.equal(f.db.getNextPurchaseVoucherNumber(), "1");

    const auto = f.db.createPurchaseVoucher({ partyId, voucherDate: "2026-01-01", lines: [] });
    assert.equal(auto.voucherNumber, "1");

    const manual = f.db.createPurchaseVoucher({ partyId, voucherDate: "2026-01-02", voucherNumber: "900", lines: [] });
    assert.equal(manual.voucherNumber, "900");

    const next = f.db.createPurchaseVoucher({ partyId, voucherDate: "2026-01-03", lines: [] });
    assert.equal(next.voucherNumber, "901");
  } finally {
    f.cleanup();
  }
});

// ─── createParty atomicity ───────────────────────────────────────────────────

test("createParty rolls back completely when the insert fails", () => {
  const f = createFixture("party-atomic");
  try {
    const before = (f.raw.prepare("SELECT COUNT(*) AS c FROM parties").get() as { c: number }).c;
    assert.equal(before, 0);

    // party_group_id is a foreign key: a group that does not exist fails the INSERT.
    assert.throws(() =>
      f.db.createParty({ partyName: "DOOMED", partyType: "CUSTOMER", city: "Lahore", status: "ACTIVE", partyGroupId: "group-that-does-not-exist" })
    );

    const after = (f.raw.prepare("SELECT COUNT(*) AS c FROM parties").get() as { c: number }).c;
    assert.equal(after, 0, "no party row should survive a failed insert");

    // The failed attempt must not have consumed a code.
    assert.equal(f.db.getNextPartyCode(), "PTY-000001");

    // And the next real create still works, proving the transaction was closed properly.
    makeParty(f.db, "RECOVERED");
    const codes = f.raw.prepare("SELECT party_code FROM parties").all() as Array<{ party_code: string }>;
    assert.deepEqual(codes.map((c) => c.party_code), ["PTY-000001"]);
  } finally {
    f.cleanup();
  }
});

test("createParty leaves no open transaction behind after a failure", () => {
  const f = createFixture("party-txn-state");
  try {
    assert.throws(() =>
      f.db.createParty({ partyName: "DOOMED", partyType: "CUSTOMER", partyGroupId: "missing" })
    );
    // If the transaction were still open this would throw "cannot start a transaction within a
    // transaction" — it is the cheapest proof that ROLLBACK ran.
    f.raw.exec("BEGIN IMMEDIATE TRANSACTION");
    f.raw.exec("COMMIT");
  } finally {
    f.cleanup();
  }
});

// ─── approval codes ──────────────────────────────────────────────────────────
//
// DEL- and SCR- formats are deliberately NOT re-tested here. The existing suites already
// exercise the very functions this phase edited, through the real creators with real
// categories, items and users:
//
//   src/categoryRemoval.test.ts:75   assert.match(request.requestCode, /^DEL-\d{6}$/)
//   src/stockCorrection.test.ts:66   assert.match(request.requestCode, /^SCR-\d{6}$/)
//   src/itemRemoval.test.ts          the item removal path end to end
//
// Those are the regression guard for the two removal paths and the stock-correction path.
// A seeded-row copy of them here would assert less and break on foreign keys.
