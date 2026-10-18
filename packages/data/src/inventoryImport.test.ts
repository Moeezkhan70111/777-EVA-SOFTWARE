import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "./sqliteDatabase.js";

// Bulk creation of raw materials from a spreadsheet. What these tests hold in place:
//
//   - a preview writes nothing, and says exactly what the real run would do;
//   - a bad row is named and left out, never silently skipped;
//   - a material that already exists is reported and left untouched, never duplicated;
//   - a file that fails part way through leaves NO materials behind;
//   - the import can create nothing the single-material form could not.

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-rm-import-"));
  const db = new SqliteDatabase({
    dbPath: path.join(tempDir, "import.db"),
    schemaPath: path.resolve(process.cwd(), "src/local-schema.sql"),
  });
  db.setNumberBlock(1, "test");

  db.createInventoryUnit({ code: "DZN", name: "Dozen" });
  db.createInventoryUnit({ code: "MTR", name: "Meter" });
  const categoryId = db.createInventoryCategory({ name: "Rubber Upper" });
  db.addInventoryCategoryField({ categoryId, fieldKey: "article", label: "ARTICLE", fieldType: "TEXT", required: true });
  db.addInventoryCategoryField({ categoryId, fieldKey: "color", label: "COLOR", fieldType: "DROPDOWN", required: true });
  db.addInventoryCategoryField({ categoryId, fieldKey: "size", label: "SIZE", fieldType: "TEXT", required: false });

  const itemCount = () =>
    Number((db.db.prepare("SELECT COUNT(1) AS n FROM inventory_items").get() as { n: number }).n);

  return {
    db,
    categoryId,
    itemCount,
    cleanup: () => {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

const row = (article: string, color: string, extra: Record<string, string> = {}) => ({
  ARTICLE: article,
  COLOR: color,
  SIZE: "7/10",
  Unit: "DZN",
  ...extra,
});

test("the template columns come from the category, not a fixed list", () => {
  const f = createFixture();
  try {
    const columns = f.db.getInventoryImportColumns(f.categoryId);
    const headers = columns.map((column) => column.header);

    assert.deepEqual(headers.slice(0, 3), ["ARTICLE", "COLOR", "SIZE"]);
    assert.ok(headers.includes("Unit"));
    assert.ok(headers.includes("Pack name"));
    assert.ok(headers.includes("One pack holds"));
    assert.equal(columns.find((column) => column.header === "ARTICLE")!.required, true);
    assert.equal(columns.find((column) => column.header === "SIZE")!.required, false);
  } finally {
    f.cleanup();
  }
});

test("a preview writes nothing and reports what the real run would do", () => {
  const f = createFixture();
  try {
    const preview = f.db.importInventoryItems({
      categoryId: f.categoryId,
      rows: [row("SK6", "RED"), row("SK6", "BLACK")],
      dryRun: true,
    });

    assert.equal(preview.applied, false);
    assert.equal(preview.created, 0);
    assert.equal(preview.rows.filter((r) => r.outcome === "CREATE").length, 2);
    assert.equal(f.itemCount(), 0, "a preview must not create anything");
  } finally {
    f.cleanup();
  }
});

test("valid rows are created and the invalid ones are named, never silently skipped", () => {
  const f = createFixture();
  try {
    const result = f.db.importInventoryItems({
      categoryId: f.categoryId,
      rows: [
        row("SK6", "RED"),
        row("", "BLUE"), // missing a required attribute
        row("SK44", "BROWN", { Unit: "TONNE" }), // a unit that does not exist
        row("SK12", "GREEN", { "Cost price": "four hundred" }), // not a number
        row("SK9", "BLACK"),
      ],
      createdBy: "owner",
    });

    assert.equal(result.applied, true);
    assert.equal(result.created, 2);
    assert.equal(result.rejected, 3);
    assert.equal(f.itemCount(), 2);

    const rejected = result.rows.filter((r) => r.outcome === "REJECTED");
    assert.match(rejected[0].problems.join(" "), /ARTICLE is required/);
    assert.match(rejected[1].problems.join(" "), /no unit "TONNE"/);
    assert.match(rejected[2].problems.join(" "), /Cost price must be a number/);
    for (const bad of rejected) assert.ok(bad.problems.length > 0, "every rejection states its reason");
  } finally {
    f.cleanup();
  }
});

test("a material already in the system is reported, not duplicated", () => {
  const f = createFixture();
  try {
    f.db.createInventoryItem({ categoryId: f.categoryId, values: { article: "SK6", color: "RED", size: "7/10" } });

    const result = f.db.importInventoryItems({
      categoryId: f.categoryId,
      rows: [row("SK6", "RED"), row("SK6", "BLACK")],
      createdBy: "owner",
    });

    assert.equal(result.duplicates, 1);
    assert.equal(result.created, 1);
    assert.equal(f.itemCount(), 2, "the existing material must not be created a second time");

    const duplicate = result.rows.find((r) => r.outcome === "DUPLICATE")!;
    assert.match(duplicate.problems.join(" "), /Already in the system/);
    assert.ok(duplicate.itemCode, "the row points at the material it duplicates");
  } finally {
    f.cleanup();
  }
});

test("the same material twice in one file is caught, with the row it repeats", () => {
  const f = createFixture();
  try {
    const result = f.db.importInventoryItems({
      categoryId: f.categoryId,
      rows: [row("SK6", "RED"), row("SK6", "BLACK"), row("SK6", "RED")],
      createdBy: "owner",
    });

    assert.equal(result.created, 2);
    assert.equal(result.rejected, 1);
    assert.match(result.rows[2].problems.join(" "), /already on row 1 of this file/);
    assert.equal(f.itemCount(), 2);
  } finally {
    f.cleanup();
  }
});

test("a file missing a required column is refused whole, not row by row", () => {
  const f = createFixture();
  try {
    const result = f.db.importInventoryItems({
      categoryId: f.categoryId,
      rows: [{ ARTICLE: "SK6", SIZE: "7/10" }, { ARTICLE: "SK9", SIZE: "4/6" }],
      createdBy: "owner",
    });

    assert.deepEqual(result.missingColumns, ["COLOR"]);
    assert.equal(result.applied, false);
    assert.equal(result.rows.length, 0, "no point listing every row for one missing heading");
    assert.equal(f.itemCount(), 0);
  } finally {
    f.cleanup();
  }
});

test("opening stock, cost price and packing come across; the route deliberately does not", () => {
  const f = createFixture();
  try {
    f.db.importInventoryItems({
      categoryId: f.categoryId,
      rows: [row("SK6", "RED", { "Opening stock": "120", "Cost price": "420", "Pack name": "PACKET", "One pack holds": "2", "Packing unit": "DZN" })],
      createdBy: "owner",
    });

    const item = f.db.listInventoryItems({})[0];
    assert.equal(Number(item.quantity_on_hand), 120);
    assert.equal(Number(item.cost_price), 420);

    const config = f.db.listRawMaterialMovementConfig("").find((c) => c.itemCode === String(item.item_code))!;
    assert.equal(config.packingQuantity, 2);
    assert.equal(config.packingUnitCode, "DZN");
    assert.equal(config.packName, "PACKET", "the store's word for the container comes across too");
    assert.equal(config.hops.length, 0, "a route has real destinations behind it and is never imported");

    // Opening stock enters the same ledger every other movement does.
    const events = f.db.listInventoryStockEvents(String(item.id));
    assert.equal(events.length, 1);
    assert.equal(events[0].quantity, 120);
  } finally {
    f.cleanup();
  }
});

test("opening stock without a unit is rejected rather than counted in nothing", () => {
  const f = createFixture();
  try {
    const result = f.db.importInventoryItems({
      categoryId: f.categoryId,
      rows: [{ ARTICLE: "SK6", COLOR: "RED", SIZE: "7/10", "Opening stock": "120" }],
      createdBy: "owner",
    });

    assert.equal(result.created, 0);
    assert.match(result.rows[0].problems.join(" "), /Opening stock needs a Unit/);
    assert.equal(f.itemCount(), 0);
  } finally {
    f.cleanup();
  }
});

test("a file that fails part way through leaves no materials behind", () => {
  const f = createFixture();
  try {
    // The category is retired after validation passes, so the insert throws on the second
    // row — the transaction must take the first one back out with it.
    const rows = [row("SK6", "RED"), row("SK9", "BLACK")];
    const original = f.db.insertInventoryItem.bind(f.db);
    let calls = 0;
    (f.db as unknown as { insertInventoryItem: typeof original }).insertInventoryItem = (input) => {
      calls += 1;
      if (calls === 2) throw new Error("disk gave up");
      return original(input);
    };

    assert.throws(() => f.db.importInventoryItems({ categoryId: f.categoryId, rows, createdBy: "owner" }), /disk gave up/);
    assert.equal(f.itemCount(), 0, "the whole file rolls back, not just the row that failed");
  } finally {
    f.cleanup();
  }
});

test("every imported material is audited exactly as a hand-created one is", () => {
  const f = createFixture();
  try {
    f.db.importInventoryItems({ categoryId: f.categoryId, rows: [row("SK6", "RED")], createdBy: "owner" });

    const audits = f.db.db
      .prepare("SELECT entity_type, action, changed_by FROM inventory_item_audit WHERE entity_type = 'ITEM'")
      .all() as Array<{ entity_type: string; action: string; changed_by: string | null }>;
    assert.equal(audits.length, 1);
    assert.equal(audits[0].entity_type, "ITEM");
    assert.equal(audits[0].action, "CREATE");
    assert.equal(audits[0].changed_by, "owner");
  } finally {
    f.cleanup();
  }
});
