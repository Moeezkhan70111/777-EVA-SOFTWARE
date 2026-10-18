import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "./sqliteDatabase.js";

// A cash voucher is a header plus its lines, and the customer ledger sums the LINES
// (see getCustomerLedgerWithCash / the UNION in database/sales.ts). Before Phase 0 the header
// and the lines were written outside any transaction, so a failure between them could leave:
//
//   on create — a voucher header with no lines, and a party balance that silently disagrees
//               with the voucher the office can see;
//   on update — the DELETE of the old lines already committed and the replacements missing,
//               which destroys financial detail that was previously correct.
//
// cash_voucher_lines.party_id is a foreign key to parties(id) and the connection runs with
// PRAGMA foreign_keys = ON, so a line naming a party that does not exist is a real, reachable
// failure. Every test below uses that as the injection point rather than a mock.

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-cash-atomicity-"));
  const db = new SqliteDatabase({
    dbPath: path.join(tempDir, "cash.db"),
    schemaPath: path.resolve(process.cwd(), "src/local-schema.sql"),
  });
  db.setNumberBlock(1, "test");
  const partyId = db.createParty({ partyName: "ATOMIC TEST PARTY", partyType: "CUSTOMER", city: "Lahore", status: "ACTIVE" });
  return {
    db,
    partyId,
    countVouchers: () => (db.db.prepare("SELECT COUNT(*) AS c FROM cash_vouchers").get() as { c: number }).c,
    countLines: () => (db.db.prepare("SELECT COUNT(*) AS c FROM cash_voucher_lines").get() as { c: number }).c,
    linesOf: (voucherId: string) =>
      db.db.prepare("SELECT description, receipt_amount_paisa FROM cash_voucher_lines WHERE voucher_id = ? ORDER BY description").all(voucherId),
    cleanup: () => {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

const goodLine = (partyId: string, description: string, receipt: number) => ({
  partyId,
  description,
  modeOfTransfer: "Cash",
  receiptAmount: receipt,
  paymentAmount: 0,
});

/** A line whose party does not exist: the FK fires on INSERT, part way through the loop. */
const brokenLine = (description: string) => ({
  partyId: "party-that-does-not-exist",
  description,
  modeOfTransfer: "Cash",
  receiptAmount: 10,
  paymentAmount: 0,
});

test("create: a failing line rolls the whole voucher back, header included", () => {
  const f = createFixture();
  try {
    assert.equal(f.countVouchers(), 0);

    assert.throws(() =>
      f.db.createCashVoucher({
        partyId: f.partyId,
        voucherDate: "2026-01-01",
        description: "Receipt with a bad second line",
        receiptAmount: 110,
        lines: [goodLine(f.partyId, "line one", 100), brokenLine("line two")],
      })
    );

    // The header must not survive its own lines failing.
    assert.equal(f.countVouchers(), 0, "voucher header should have been rolled back");
    assert.equal(f.countLines(), 0, "the first line should have been rolled back too");
  } finally {
    f.cleanup();
  }
});

test("create: a rolled-back voucher does not consume its voucher number", () => {
  const f = createFixture();
  try {
    assert.throws(() =>
      f.db.createCashVoucher({
        partyId: f.partyId,
        voucherDate: "2026-01-01",
        description: "Doomed",
        receiptAmount: 10,
        lines: [brokenLine("bad")],
      })
    );

    const id = f.db.createCashVoucher({
      partyId: f.partyId,
      voucherDate: "2026-01-02",
      description: "Good one",
      receiptAmount: 50,
      lines: [goodLine(f.partyId, "line one", 50)],
    });

    const voucher = f.db.getCashVoucher(id);
    assert.ok(voucher);
    assert.equal(voucher.voucherNumber, 1, "the first successful voucher should still be number 1");
  } finally {
    f.cleanup();
  }
});

test("update: a failing replacement leaves the original lines untouched", () => {
  const f = createFixture();
  try {
    const id = f.db.createCashVoucher({
      partyId: f.partyId,
      voucherDate: "2026-01-01",
      description: "Original",
      receiptAmount: 300,
      lines: [goodLine(f.partyId, "original a", 100), goodLine(f.partyId, "original b", 200)],
    });
    const before = f.linesOf(id);
    assert.equal(before.length, 2);

    assert.throws(() =>
      f.db.updateCashVoucher(id, {
        description: "Edited",
        lines: [goodLine(f.partyId, "replacement a", 300), brokenLine("replacement b")],
      })
    );

    // The DELETE must not outlive the failed re-insert.
    const after = f.linesOf(id);
    assert.deepEqual(after, before, "the original lines must survive a failed edit");
    assert.equal(f.countLines(), 2);

    const voucher = f.db.getCashVoucher(id);
    assert.ok(voucher);
    assert.equal(voucher.description, "Original", "the header edit must roll back with the lines");
  } finally {
    f.cleanup();
  }
});

test("create and update still behave normally when nothing fails", () => {
  const f = createFixture();
  try {
    const id = f.db.createCashVoucher({
      partyId: f.partyId,
      voucherDate: "2026-01-01",
      description: "Receipt",
      receiptAmount: 350,
      lines: [goodLine(f.partyId, "line one", 100), goodLine(f.partyId, "line two", 250)],
    });

    let voucher = f.db.getCashVoucher(id);
    assert.ok(voucher);
    assert.equal(voucher.voucherNumber, 1);
    assert.equal(f.linesOf(id).length, 2);

    f.db.updateCashVoucher(id, {
      description: "Receipt (edited)",
      lines: [goodLine(f.partyId, "only line", 400)],
    });

    voucher = f.db.getCashVoucher(id);
    assert.ok(voucher);
    assert.equal(voucher.description, "Receipt (edited)");
    const lines = f.linesOf(id) as Array<{ description: string; receipt_amount_paisa: number }>;
    assert.equal(lines.length, 1);
    assert.equal(lines[0].description, "only line");
    // Money stays integer paisa (CLAUDE.md R15).
    assert.equal(lines[0].receipt_amount_paisa, 40000);
  } finally {
    f.cleanup();
  }
});

test("a voucher created with no explicit lines still gets its single derived line", () => {
  const f = createFixture();
  try {
    const id = f.db.createCashVoucher({
      partyId: f.partyId,
      voucherDate: "2026-01-01",
      description: "Simple receipt",
      receiptAmount: 75.5,
    });
    const lines = f.linesOf(id) as Array<{ description: string; receipt_amount_paisa: number }>;
    assert.equal(lines.length, 1);
    assert.equal(lines[0].receipt_amount_paisa, 7550);
  } finally {
    f.cleanup();
  }
});
