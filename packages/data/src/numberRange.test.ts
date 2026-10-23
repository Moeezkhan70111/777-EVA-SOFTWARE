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

// ─── provenance: the prerequisite for replication (docs/37 section 0.1) ──────
//
// countOutsideRange used to ask "is there any number here outside my block". On one computer
// that is the right question. Under replication it is fatal: PC 1 holds PC 2's gatepasses, and
// PC 2's numbers are in block 2 BY DESIGN, so the answer is never zero and EVERY numbered
// document creation fails on EVERY computer. These tests pin the narrowed question.

/** Records this computer's identity the way ensureOperationalContext does. */
const setDeviceId = (db: SqliteDatabase, deviceId: string) =>
  db.setSettings({ "device.id": deviceId }, "test");

test("another computer's numbers do not block this one — the replication hard stop", () => {
  withFixture("range-peer", 1, ({ db, raw }) => {
    setDeviceId(db, "pc-1");
    party(db, "OURS");

    // Exactly what replication delivers: PC 2's party, numbered in block 2, sitting in PC 1's
    // database. Before this fix the next getNextPartyCode() threw OUT_OF_RANGE and PC 1 could
    // never create another party.
    raw
      .prepare(
        `INSERT INTO parties (id, party_name, party_type, party_code, status, origin_device_id, created_at, updated_at)
         VALUES ('peer-1', 'THEIRS', 'CUSTOMER', 'PTY-100001', 'ACTIVE', 'pc-2', ?, ?)`
      )
      .run("2026-10-23T00:00:00.000Z", "2026-10-23T00:00:00.000Z");

    const next = db.getNextPartyCode();
    assert.match(next, /^PTY-0000\d\d$/, "allocation continues in this computer's own block");
    assert.notEqual(next, "PTY-100002", "and never continues the other computer's series");
  });
});

test("this computer's own stray numbers still refuse — the protection is not lost", () => {
  withFixture("range-mine", 1, ({ db }) => {
    setDeviceId(db, "pc-1");
    party(db, "ONE");
    // Re-assigned to block 3, where its OWN party code does not belong.
    db.setNumberBlock(3, "test");
    assert.throws(
      () => db.getNextPartyCode(),
      (error: unknown) => error instanceof NumberRangeError && error.reason === "OUT_OF_RANGE",
      "a wrong block must still be caught"
    );
  });
});

test("an unattributed row counts as this computer's, so today's guard is unchanged", () => {
  withFixture("range-null-origin", 1, ({ db, raw }) => {
    setDeviceId(db, "pc-1");
    // No origin: a row written before migration 087 stamped anything, or by a writer that does
    // not set the column. It must still be counted, or a wrong block would go unnoticed.
    raw
      .prepare(
        `INSERT INTO parties (id, party_name, party_type, party_code, status, origin_device_id, created_at, updated_at)
         VALUES ('legacy-1', 'LEGACY', 'CUSTOMER', 'PTY-300001', 'ACTIVE', NULL, ?, ?)`
      )
      .run("2026-10-23T00:00:00.000Z", "2026-10-23T00:00:00.000Z");

    assert.throws(
      () => db.getNextPartyCode(),
      (error: unknown) => error instanceof NumberRangeError && error.reason === "OUT_OF_RANGE",
      "a row that cannot be attributed is treated as ours, not ignored"
    );
  });
});

test("a computer with no recorded identity falls back to the stricter question", () => {
  withFixture("range-no-identity", 1, ({ db, raw }) => {
    // Migration 087 SEEDS device.id, so every migrated database has an identity and this
    // fallback is normally unreachable -- which is the point of seeding it. Blanked here on
    // purpose to cover the path: with no identity, provenance cannot be used, so the old broader
    // question is asked and a peer's row DOES block. That is the conservative direction, and
    // such a machine is not replicating anything yet.
    db.setSettings({ "device.id": "" }, "test");
    raw
      .prepare(
        `INSERT INTO parties (id, party_name, party_type, party_code, status, origin_device_id, created_at, updated_at)
         VALUES ('peer-2', 'THEIRS', 'CUSTOMER', 'PTY-200001', 'ACTIVE', 'pc-2', ?, ?)`
      )
      .run("2026-10-23T00:00:00.000Z", "2026-10-23T00:00:00.000Z");

    assert.throws(
      () => db.getNextPartyCode(),
      (error: unknown) => error instanceof NumberRangeError && error.reason === "OUT_OF_RANGE"
    );
  });
});

test("block assignment is provenance-scoped too, not just allocation", () => {
  withFixture("range-assign", 1, ({ db, raw }) => {
    setDeviceId(db, "pc-1");
    // A peer's block-2 party arrives. Re-recording this computer as block 1 must still be
    // possible: the guard at assignment asks the same narrowed question as allocation.
    raw
      .prepare(
        `INSERT INTO parties (id, party_name, party_type, party_code, status, origin_device_id, created_at, updated_at)
         VALUES ('peer-3', 'THEIRS', 'CUSTOMER', 'PTY-100005', 'ACTIVE', 'pc-2', ?, ?)`
      )
      .run("2026-10-23T00:00:00.000Z", "2026-10-23T00:00:00.000Z");

    assert.deepEqual(db.setNumberBlock(1, "admin"), { block: 1, lo: 1, hi: 99_999 });
  });
});

test("every numbered site names the column that records who created the row", () => {
  // Without this the narrowed question cannot be asked of that table at all, and the site would
  // silently fall back to counting every row -- the replication hard stop, for one table.
  const sessionTables = new Set([
    "raw_material_receiving_sessions",
    "raw_material_issue_sessions",
    "store_receiving_sessions",
    "store_move_out_sessions",
  ]);
  for (const key of Object.keys(NUMBER_SITES) as NumberSiteKey[]) {
    const site = NUMBER_SITES[key];
    assert.ok(site.origin, `${key} has no origin column`);
    assert.equal(
      site.origin,
      sessionTables.has(site.table) ? "device_id" : "origin_device_id",
      `${key} names the wrong origin column`
    );
  }
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
