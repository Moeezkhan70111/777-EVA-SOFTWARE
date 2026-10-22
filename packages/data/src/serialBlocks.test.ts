// PER-COMPUTER QR SERIAL BLOCKS.
//
// Every computer in the factory prints labels. None may print another's serials, because two
// cartons carrying one identity is two physical boxes the system cannot tell apart — and the
// same for two raw-material packets moving in and out of the store.
//
// The scheme: each computer owns a block of a million serials, the same block number it already
// uses for document numbers. Block 1 is 1-999,999 and holds every serial 777 has ever printed,
// so nothing is renumbered and no printed label changes meaning.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatQrSerial, parseQrCode } from "@erp/domain";
import { SqliteDatabase } from "./sqliteDatabase.js";
import {
  SERIAL_BLOCK_SIZE,
  isWithinSerialRange,
  reserveSerialRange,
  serialRangeForBlock,
} from "./database/numberRange.js";

// ─── The ranges themselves ───────────────────────────────────────────────────

test("each computer owns a million serials, and block 1 holds every serial already printed", () => {
  assert.deepEqual(serialRangeForBlock(1), { block: 1, lo: 1, hi: 999_999 });
  assert.deepEqual(serialRangeForBlock(2), { block: 2, lo: 1_000_000, hi: 1_999_999 });
  assert.deepEqual(serialRangeForBlock(3), { block: 3, lo: 2_000_000, hi: 2_999_999 });
  assert.deepEqual(serialRangeForBlock(4), { block: 4, lo: 3_000_000, hi: 3_999_999 });
  assert.deepEqual(serialRangeForBlock(5), { block: 5, lo: 4_000_000, hi: 4_999_999 });
});

test("no two blocks overlap", () => {
  for (let block = 1; block < 5; block += 1) {
    assert.ok(
      serialRangeForBlock(block).hi < serialRangeForBlock(block + 1).lo,
      `block ${String(block)} runs into block ${String(block + 1)}`
    );
  }
});

test("the printed serial stays six digits in block 1 and becomes seven above it", () => {
  // THE PROPERTY THAT KEEPS OLD LABELS VALID. padStart(6) is a no-op from 1,000,000 up, so one
  // number can never be written two ways — `000500` and `0000500` would be two identities.
  assert.equal(formatQrSerial(1), "000001");
  assert.equal(formatQrSerial(113), "000113");
  assert.equal(formatQrSerial(999_999), "999999");
  assert.equal(formatQrSerial(1_000_000), "1000000");
  assert.equal(formatQrSerial(4_999_999), "4999999");
});

test("a seven-digit serial still scans", () => {
  const parsed = parseQrCode(`SK46_BLACKRED_7/10_${formatQrSerial(1_000_000)}`);
  assert.equal(parsed.payload.serial, "1000000");
  assert.equal(parsed.payload.article, "SK46");
  assert.equal(parsed.payload.size, "7/10");
});

// ─── Reservation ─────────────────────────────────────────────────────────────

test("a combination this computer has not printed before starts at its own block floor", () => {
  // The bug this prevents: a counter that starts at 0 on every computer, so computer 3's first
  // label for a new article collides with computer 1's first.
  assert.deepEqual(reserveSerialRange(serialRangeForBlock(1), null, 5, "x"), { startSequence: 1, endSequence: 5 });
  assert.deepEqual(reserveSerialRange(serialRangeForBlock(3), null, 5, "x"), {
    startSequence: 2_000_000,
    endSequence: 2_000_004,
  });
});

test("an existing counter carries on from where it was", () => {
  assert.deepEqual(reserveSerialRange(serialRangeForBlock(1), 113, 10, "x"), { startSequence: 114, endSequence: 123 });
});

test("a run that would cross into the next computer's block is refused whole", () => {
  const range = serialRangeForBlock(1);
  // 50 left, 100 asked for. Handing out 50 would be worse than refusing: the operator asked for
  // 100 stickers, and a short run nobody noticed is a physical count that stops matching.
  assert.throws(
    () => reserveSerialRange(range, 999_949, 100, "carton QR serials"),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : "";
      assert.match(message, /used up/i);
      assert.match(message, /50 remain and 100 were asked for/);
      assert.match(message, /Nothing has been saved/);
      return true;
    }
  );
});

test("the last serial in a block is usable — the boundary is inclusive", () => {
  assert.deepEqual(reserveSerialRange(serialRangeForBlock(1), 999_998, 1, "x"), {
    startSequence: 999_999,
    endSequence: 999_999,
  });
  assert.throws(() => reserveSerialRange(serialRangeForBlock(1), 999_999, 1, "x"));
});

test("block 1 approaching its ceiling never silently becomes block 2", () => {
  const range = serialRangeForBlock(1);
  assert.throws(() => reserveSerialRange(range, 999_999, 1, "x"));
  // And the value that would have been handed out is block 2's first serial, which is the whole
  // point of refusing.
  assert.equal(range.hi + 1, serialRangeForBlock(2).lo);
  assert.equal(SERIAL_BLOCK_SIZE, 1_000_000);
});

// ─── Which serials belong to a computer ──────────────────────────────────────

test("a serial is recognised as this computer's own, or not", () => {
  const block2 = serialRangeForBlock(2);
  assert.equal(isWithinSerialRange(block2, 1_000_000), true);
  assert.equal(isWithinSerialRange(block2, 1_999_999), true);
  assert.equal(isWithinSerialRange(block2, 999_999), false, "block 1's serial is not block 2's");
  assert.equal(isWithinSerialRange(block2, 2_000_000), false, "block 3's serial is not block 2's");
  assert.equal(isWithinSerialRange(block2, 1_500_000.5), false, "a serial is a whole number");
});

// ─── Against the real database ───────────────────────────────────────────────

const SCHEMA_PATH = path.resolve(process.cwd(), "src/local-schema.sql");

function createDb(label: string, block: number | null): SqliteDatabase {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `erp-serials-${label}-`));
  const db = new SqliteDatabase({ dbPath: path.join(tempDir, "erp.db"), schemaPath: SCHEMA_PATH });
  if (block !== null) db.setNumberBlock(block, "test");
  db.ensureOperationalContext({
    factoryId: "factory-1", factoryCode: "F001", factoryName: "Factory",
    workstationId: "workstation-1", workstationCode: "WS001", workstationName: "WS",
    deviceId: "device-1", deviceName: "Device", appVersion: "1.0.0",
  });
  return db;
}

const ARTICLE = "SK46";
const SIZE = "7/10";
const COLOR = "BLACKRED";

/** The article_sizes id the QR generator takes, creating the product if it is not there. */
function productId(db: SqliteDatabase): string {
  const find = () =>
    db.db
      .prepare("SELECT id FROM article_sizes WHERE article = ? AND size = ? AND deleted_at IS NULL LIMIT 1")
      .get(ARTICLE, SIZE) as { id: string } | undefined;
  if (!find()) db.createProduct({ article: ARTICLE, size: SIZE, sellingPrice: 550, status: "ACTIVE" } as never);
  return find()!.id;
}

test("two computers generating the same article produce serials that cannot collide", () => {
  const first = createDb("pc1", 1);
  const second = createDb("pc2", 2);
  try {
    const runA = first.generateQrBatch({ articleSizeId: productId(first), color: COLOR, quantity: 3 } as never);
    const runB = second.generateQrBatch({ articleSizeId: productId(second), color: COLOR, quantity: 3 } as never);

    const idsA = runA.qrCodes.map((code) => code.id);
    const idsB = runB.qrCodes.map((code) => code.id);

    assert.deepEqual(idsA, ["SK46_BLACKRED_7/10_000001", "SK46_BLACKRED_7/10_000002", "SK46_BLACKRED_7/10_000003"]);
    assert.deepEqual(idsB, ["SK46_BLACKRED_7/10_1000000", "SK46_BLACKRED_7/10_1000001", "SK46_BLACKRED_7/10_1000002"]);

    // The assertion the whole scheme is for.
    for (const id of idsA) assert.ok(!idsB.includes(id), `${id} was issued by both computers`);
  } finally {
    first.close();
    second.close();
  }
});

test("a computer with no range assigned refuses to print labels, and says why", () => {
  const db = createDb("unprovisioned", null);
  try {
    // createProduct needs a number block too, so insert the product rows directly: the point
    // here is the GENERATOR's refusal, not the product form's.
    db.setNumberBlock(1, "test");
    const article = productId(db);
    // Now take the range away again, as an unprovisioned second computer would be.
    db.db.prepare("DELETE FROM app_settings WHERE setting_key = 'numbering.block'").run();

    assert.throws(
      () => db.generateQrBatch({ articleSizeId: article, color: COLOR, quantity: 1 } as never),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : "";
        assert.match(message, /cannot print QR labels/i);
        // It must be clear that the rest of the ERP still works, or somebody will panic.
        assert.match(message, /Scanning, production, dispatch and store work are unaffected/i);
        return true;
      }
    );
    // Nothing was written: no batch, no counter.
    assert.equal(db.db.prepare("SELECT COUNT(1) AS n FROM qr_batches").get()?.n, 0);
    assert.equal(db.db.prepare("SELECT COUNT(1) AS n FROM qr_sequences").get()?.n, 0);
  } finally {
    db.close();
  }
});

// ─── Raw material packets ────────────────────────────────────────────────────
//
// The same scheme, on the labels that matter most to the store: a packet is scanned moving in
// and scanned moving out, so two packets sharing an identity is a stock figure that cannot be
// reconciled against anything.

/** A supplier and a material, enough to print packet labels. */
function rawMaterialFixture(db: SqliteDatabase): { partyId: string; itemId: string } {
  const dozen = db.createInventoryUnit({ code: "DOZ", name: "Dozen", unitFamily: "COUNT" }) as unknown as string;
  const partyId = db.createParty({
    partyName: "ABID", partyType: "SUPPLIER", city: "Lahore", mobileNumber: "0300-1111111", status: "ACTIVE",
  }) as unknown as string;
  const categoryId = db.createInventoryCategory({ name: "UPPER" });
  db.addInventoryCategoryField({ categoryId, fieldKey: "colour", label: "COLOUR", fieldType: "TEXT", required: true, sortOrder: 1 });
  const itemId = db.createInventoryItem({ categoryId, values: { colour: "BLACK" }, unitId: dozen }).id;
  return { partyId, itemId };
}

test("two computers printing packet labels for the same material cannot collide", () => {
  const first = createDb("rm1", 1);
  const second = createDb("rm2", 2);
  try {
    const a = rawMaterialFixture(first);
    const b = rawMaterialFixture(second);

    const runA = first.generateRawMaterialQrBatch({ partyId: a.partyId, itemId: a.itemId, quantity: 3, packingQuantity: 5 });
    const runB = second.generateRawMaterialQrBatch({ partyId: b.partyId, itemId: b.itemId, quantity: 3, packingQuantity: 5 });

    assert.equal(runA.batch.startSequence, 1, "computer 1 keeps the serials it always had");
    assert.equal(runB.batch.startSequence, 1_000_000, "computer 2 starts in its own block");

    const idsA = runA.qrCodes.map((code) => code.id);
    const idsB = runB.qrCodes.map((code) => code.id);
    for (const id of idsA) assert.ok(!idsB.includes(id), `${id} was issued by both computers`);

    // The v2 raw-material identity leaves the serial unpadded, so it simply gets longer.
    assert.match(idsB[0], /_1000000$/);
  } finally {
    first.close();
    second.close();
  }
});

test("a computer with no range assigned refuses to print packet labels too", () => {
  const db = createDb("rm-unprovisioned", 1);
  try {
    const { partyId, itemId } = rawMaterialFixture(db);
    db.db.prepare("DELETE FROM app_settings WHERE setting_key = 'numbering.block'").run();

    assert.throws(
      () => db.generateRawMaterialQrBatch({ partyId, itemId, quantity: 1, packingQuantity: 5 }),
      /cannot print QR labels/i
    );
    assert.equal(db.db.prepare("SELECT COUNT(1) AS n FROM raw_material_qr_batches").get()?.n, 0);
    assert.equal(db.db.prepare("SELECT COUNT(1) AS n FROM raw_material_qr_sequences").get()?.n, 0);
  } finally {
    db.close();
  }
});

test("a refused run leaves the counter untouched, not sitting in the next block", () => {
  const db = createDb("exhausted", 1);
  try {
    const article = productId(db);
    // Walk the counter to the top of block 1 by hand.
    db.db
      .prepare("INSERT INTO qr_sequences (id, article, color, size, last_sequence, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("seq-1", ARTICLE, COLOR, SIZE, 999_990, new Date().toISOString());

    assert.throws(
      () => db.generateQrBatch({ articleSizeId: article, color: COLOR, quantity: 50 } as never),
      /used up/i
    );

    const after = db.db
      .prepare("SELECT last_sequence FROM qr_sequences WHERE article = ? AND color = ? AND size = ?")
      .get(ARTICLE, COLOR, SIZE) as { last_sequence: number };
    assert.equal(Number(after.last_sequence), 999_990, "the counter moved despite the refusal");
  } finally {
    db.close();
  }
});
