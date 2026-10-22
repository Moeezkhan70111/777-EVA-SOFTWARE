import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase, NumberRangeError, NUMBER_SITES, rangeForBlock } from "./sqliteDatabase.js";
import type { NumberSiteKey } from "./sqliteDatabase.js";

// RESERVED DOCUMENT-NUMBER RANGES — one block of numbers per computer.
//
// Each computer allocates only inside its own block, so two computers working offline cannot
// compute the same "next" number. These tests pin the four things that must hold:
//
//   * an existing series CONTINUES — nothing is renumbered, and no visible format changes
//   * a computer with no block, an invalid block or a used-up block REFUSES, and writes nothing
//   * gaps stay gaps and a deleted number is never handed out again
//   * a number typed from the paper book still wins over the automatic fallback
//
// Everything here runs against its own throwaway database under the OS temp folder.

function createFixture(prefix: string, block: number | null = 1) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `erp-${prefix}-`));
  const db = new SqliteDatabase({
    dbPath: path.join(tempDir, "x.db"),
    schemaPath: path.resolve(process.cwd(), "src/local-schema.sql"),
  });
  // Nothing assigns a block on its own: a computer is configured deliberately, or it refuses.
  if (block !== null) db.setNumberBlock(block, "test");
  return {
    db,
    raw: db.db,
    cleanup: () => {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

const withFixture = (prefix: string, block: number | null, body: (f: ReturnType<typeof createFixture>) => void) => {
  const f = createFixture(prefix, block);
  try {
    body(f);
  } finally {
    f.cleanup();
  }
};

const party = (db: SqliteDatabase, name: string) =>
  db.createParty({ partyName: name, partyType: "CUSTOMER", city: "Lahore", status: "ACTIVE" });

// ─── block arithmetic ────────────────────────────────────────────────────────

test("each computer's block covers the agreed range, and block 1 starts at 1", () => {
  assert.deepEqual(rangeForBlock(1), { block: 1, lo: 1, hi: 99_999 });
  assert.deepEqual(rangeForBlock(2), { block: 2, lo: 100_000, hi: 199_999 });
  assert.deepEqual(rangeForBlock(3), { block: 3, lo: 200_000, hi: 299_999 });
  assert.deepEqual(rangeForBlock(4), { block: 4, lo: 300_000, hi: 399_999 });
  assert.deepEqual(rangeForBlock(5), { block: 5, lo: 400_000, hi: 499_999 });
});

// ─── the existing-data computer is undisturbed ───────────────────────────────

test("block 1 continues an existing series instead of restarting or renumbering", () => {
  withFixture("range-continue", 1, ({ db }) => {
    const first = party(db, "ONE");
    const second = party(db, "TWO");
    assert.equal(db.getParty(first)?.partyCode, "PTY-000001");
    assert.equal(db.getParty(second)?.partyCode, "PTY-000002");
    assert.equal(db.getNextPartyCode(), "PTY-000003");
  });
});

test("a gap is left as a gap — a deleted number is never handed out again", () => {
  withFixture("range-gap", 1, ({ db, raw }) => {
    party(db, "ONE");
    const middle = party(db, "TWO");
    party(db, "THREE");
    // The middle party is removed the way a correction would remove it.
    raw.prepare("DELETE FROM parties WHERE id = ?").run(middle);
    assert.equal(db.getNextPartyCode(), "PTY-000004", "counts on from the highest, never backfills");
  });
});

// ─── a second computer allocates in its own block ────────────────────────────

test("block 2 starts at its floor and never touches block 1's numbers", () => {
  withFixture("range-block2", 2, ({ db }) => {
    const id = party(db, "SECOND COMPUTER");
    assert.equal(db.getParty(id)?.partyCode, "PTY-100000", "block 2 begins at 100,000");
    assert.equal(db.getNextPartyCode(), "PTY-100001");
  });
});

test("two computers allocating the same document type produce disjoint numbers", () => {
  withFixture("range-a", 1, ({ db: a }) => {
    withFixture("range-b", 3, ({ db: b }) => {
      const codes = [party(a, "A1"), party(a, "A2")].map((id) => a.getParty(id)?.partyCode);
      const other = [party(b, "B1"), party(b, "B2")].map((id) => b.getParty(id)?.partyCode);
      assert.deepEqual(codes, ["PTY-000001", "PTY-000002"]);
      assert.deepEqual(other, ["PTY-200000", "PTY-200001"]);
      assert.equal(new Set([...codes, ...other]).size, 4, "no number appears on both computers");
    });
  });
});

// ─── refusals: never a silent fallback ───────────────────────────────────────

test("an unconfigured computer refuses to allocate, and writes nothing", () => {
  withFixture("range-none", null, ({ db, raw }) => {
    assert.throws(
      () => party(db, "NO BLOCK"),
      (error: unknown) => error instanceof NumberRangeError && error.reason === "NOT_CONFIGURED"
    );
    assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM parties").get() as { n: number }).n, 0);
  });
});

test("an invalid block refuses rather than falling back to a global next number", () => {
  withFixture("range-bad", null, ({ db, raw }) => {
    db.setSettings({ "numbering.block": "9" }, "test");
    assert.throws(
      () => party(db, "BAD BLOCK"),
      (error: unknown) => error instanceof NumberRangeError && error.reason === "INVALID"
    );
    db.setSettings({ "numbering.block": "not a number" }, "test");
    assert.throws(() => db.getNextPartyCode(), /not valid/);
    assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM parties").get() as { n: number }).n, 0);
  });
});

test("setNumberBlock refuses a block outside 1-5 and never guesses one", () => {
  withFixture("range-set", null, ({ db }) => {
    assert.equal(db.getNumberBlock(), null, "nothing assigns a block on its own");
    assert.throws(() => db.setNumberBlock(0), NumberRangeError);
    assert.throws(() => db.setNumberBlock(6), NumberRangeError);
    assert.throws(() => db.setNumberBlock(1.5), NumberRangeError);
    assert.equal(db.isNumberBlockConfirmed(), false);
    assert.deepEqual(db.setNumberBlock(4, "admin"), { block: 4, lo: 300_000, hi: 399_999 });
    assert.equal(db.getNumberBlock(), 4);
    assert.equal(db.isNumberBlockConfirmed(), true, "an administrator confirmed it for this machine");
  });
});

test("data outside the assigned block refuses rather than renumbering it", () => {
  withFixture("range-stray", 1, ({ db, raw }) => {
    party(db, "ONE");
    // The same database, now claiming to be computer 3: its existing codes do not belong there.
    db.setNumberBlock(3, "test");
    assert.throws(
      () => db.getNextPartyCode(),
      (error: unknown) => error instanceof NumberRangeError && error.reason === "OUT_OF_RANGE"
    );
    assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM parties").get() as { n: number }).n, 1, "nothing was changed");
  });
});

test("an exhausted block refuses and writes nothing", () => {
  withFixture("range-full", 1, ({ db, raw }) => {
    const id = party(db, "LAST");
    raw.prepare("UPDATE parties SET party_code = ? WHERE id = ?").run("PTY-099999", id);
    assert.throws(
      () => party(db, "ONE TOO MANY"),
      (error: unknown) => error instanceof NumberRangeError && error.reason === "EXHAUSTED"
    );
    assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM parties").get() as { n: number }).n, 1);
  });
});

// ─── externally numbered documents keep their authority ──────────────────────

test("a sale voucher typed from the paper book is never renumbered by the range", () => {
  withFixture("range-sale", 2, ({ db }) => {
    const partyId = party(db, "MAMA CHAPPAL");
    const typed = db.createSaleVoucher({ partyId, voucherDate: "2026-10-15", bookNo: "A", voucherNumber: "77" });
    assert.equal(typed.voucherNumber, "77", "the office's own number wins");
  });
});

test("the sale voucher FALLBACK uses the block when no number is typed", () => {
  withFixture("range-sale-fallback", 2, ({ db }) => {
    const partyId = party(db, "NO BOOK");
    const auto = db.createSaleVoucher({ partyId, voucherDate: "2026-10-15", bookNo: "A" });
    assert.equal(auto.voucherNumber, "100000", "block 2's first automatic number");
  });
});

test("purchase voucher numbers honour a supplied number and otherwise use the block", () => {
  withFixture("range-purchase", 2, ({ db }) => {
    assert.equal(db.getNextPurchaseVoucherNumber(), "100000");
  });
});

// ─── visible formats must not drift ──────────────────────────────────────────

test("every allocated identifier keeps its exact printed format in a high block", () => {
  withFixture("range-formats", 5, ({ db }) => {
    assert.match(db.getNextPartyCode(), /^PTY-\d{6}$/);
    assert.equal(db.getNextPartyCode(), "PTY-400000");
    assert.match(db.getNextProductCode(), /^PRD-\d{6}$/);
    assert.equal(db.getNextProductCode(), "PRD-400000");
    const section = db.createWorkSection({ name: "PACKING" });
    assert.match(section.sectionCode, /^WS-\d{3,}$/, "WS- keeps its shape even past three digits");
    const machine = db.createMachine({ name: "MACHINE X", sectionId: section.id });
    assert.match(db.listMachines().find((m) => m.id === machine.id)!.machineCode, /^M-\d{3,}$/);
  });
});

test("the preview an operator sees is the number the save allocates", () => {
  withFixture("range-preview", 2, ({ db }) => {
    const preview = db.getNextPartyCode();
    const id = party(db, "PREVIEW MATCHES");
    assert.equal(db.getParty(id)?.partyCode, preview);
  });
});

// ─── concurrency on one computer ─────────────────────────────────────────────

test("many allocations on one computer never repeat a number", () => {
  withFixture("range-concurrent", 2, ({ db }) => {
    const codes = new Set<string>();
    for (let i = 0; i < 25; i += 1) codes.add(db.getParty(party(db, `P${i}`))!.partyCode!);
    assert.equal(codes.size, 25, "every allocation is distinct");
    assert.ok([...codes].every((c) => Number(c.slice(4)) >= 100_000 && Number(c.slice(4)) <= 199_999));
  });
});

// ─── the audited site list ───────────────────────────────────────────────────

test("every audited site is covered, and the excluded ones stay excluded", () => {
  const keys = Object.keys(NUMBER_SITES) as NumberSiteKey[];
  // Parent-scoped sequences and QR serials are deliberately NOT ranged in this phase.
  for (const absent of ["runNo", "lineNo", "qrSerial", "rawMaterialQrSerial", "sortOrder"]) {
    assert.ok(!keys.includes(absent as NumberSiteKey), `${absent} must not be ranged`);
  }
  for (const expected of [
    "cashVoucher", "saleVoucher", "purchaseVoucher", "gatepass", "machineProgram",
    "manualProduction", "partyCode", "productCode", "rmReceivingSession", "rmIssueSession",
    "storeReceivingSession", "storeMoveOutSession", "partyClaim", "removalRequest",
    "stockCorrection", "machineCode", "inventoryItemCode", "workSectionCode",
  ]) {
    assert.ok(keys.includes(expected as NumberSiteKey), `${expected} must be ranged`);
  }
  // Only sale and purchase vouchers may be externally numbered.
  const external = keys.filter((k) => (NUMBER_SITES[k] as { external?: boolean }).external === true);
  assert.deepEqual(external.sort(), ["purchaseVoucher", "saleVoucher"]);
});

// CHANGED 2026-10-22. This test used to assert the opposite — that QR serials were NOT ranged,
// because the scheme covered document numbers only and label printing was restricted to one
// designated workstation. Every computer now prints labels, so serials are ranged too, at
// SERIAL_BLOCK_SIZE. See the block comment at the foot of database/numberRange.ts, and
// serialBlocks.test.ts for the scheme itself.
test("QR serials are allocated inside this computer's block", () => {
  withFixture("range-qr", 3, ({ db, raw }) => {
    db.createProduct({ article: "SK9", size: "7/10", sellingPrice: 500, status: "ACTIVE" });
    const articleSizeId = (raw.prepare("SELECT id FROM article_sizes WHERE article = 'SK9'").get() as { id: string }).id;
    const generated = db.generateQrBatch({ articleSizeId, color: "BLACK", quantity: 3 });

    // Computer 3 owns 2,000,000-2,999,999, so its first label for a new product is 2,000,000 —
    // not 1, which belongs to computer 1 and is very probably already on a carton.
    assert.equal(generated.batch.startSequence, 2_000_000);
    assert.equal(generated.batch.endSequence, 2_000_002);
    assert.match(generated.qrCodes[0].id, /^SK9_BLACK_7\/10_2000000$/, "seven digits above block 1, unpadded");
  });
});
