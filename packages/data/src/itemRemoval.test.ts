import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "./sqliteDatabase.js";

// Erasing a raw material for good, with an administrator's approval.
//
// The line this draws: a material's OWN stock ledger goes with it, because that ledger
// describes nothing else. Anything outside the material that names it — a printed label, a
// scan, a purchase line — can never go, and the answer there stays "disable it".
//
// What these tests hold in place:
//
//   - a material with only its own movements can be erased, and its ledger goes too;
//   - a material a printed label or a purchase names cannot be, and says why;
//   - nothing is erased while the request is pending, or when it is declined;
//   - a disabled material can be switched back on.

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-item-removal-"));
  const db = new SqliteDatabase({
    dbPath: path.join(tempDir, "items.db"),
    schemaPath: path.resolve(process.cwd(), "src/local-schema.sql"),
  });
  db.setNumberBlock(1, "test");

  const admin = db.bootstrapFirstAdmin("owner", "password1");
  const clerk = db.createUserAccount("aslam", "password1");
  db.db.prepare("UPDATE app_users SET access_status = 'APPROVED' WHERE id = ?").run(clerk.id);

  db.createInventoryUnit({ code: "KG", name: "Kilogram" });
  const unitId = (db.listInventoryUnits() as Array<{ id: string; code: string }>).find((u) => u.code === "KG")!.id;
  const categoryId = db.createInventoryCategory({ name: "DANA" });
  db.addInventoryCategoryField({ categoryId, fieldKey: "grade", label: "GRADE", fieldType: "TEXT", required: true });

  // Entered by mistake: it has an opening stock movement and nothing else.
  const item = db.createInventoryItem({ categoryId, unitId, stockQuantity: 25, values: { grade: "WRONG" } });

  const exists = () => Boolean(db.db.prepare("SELECT 1 AS ok FROM inventory_items WHERE id = ?").get(item.id));
  const movements = () =>
    Number(
      (db.db.prepare("SELECT COUNT(1) AS n FROM inventory_stock_events WHERE item_id = ?").get(item.id) as { n: number }).n
    );

  /** Prints one QR label against the material — a sticker that exists out in the store. */
  const printLabel = (serial: number) => {
    const partyId = db.createParty({ partyName: "SUPPLIER " + serial, partyType: "SUPPLIER" }) as unknown as string;
    const now = new Date().toISOString();
    const batchId = crypto.randomUUID();
    db.db
      .prepare(
        `INSERT INTO raw_material_qr_batches (id, party_id, item_id, start_sequence, end_sequence, quantity, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`
      )
      .run(batchId, String(partyId), item.id, serial, serial, now);
    db.db
      .prepare(
        `INSERT INTO raw_material_qrs (id, batch_id, party_id, item_id, sequence, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'GENERATED', ?, ?)`
      )
      .run(crypto.randomUUID(), batchId, String(partyId), item.id, serial, now, now);
  };

  return { db, admin, clerk, itemId: item.id, categoryId, unitId, exists, movements, printLabel, tempDir };
}

test("a material entered by mistake can be erased even though it has movements of its own", () => {
  const { db, itemId, movements } = createFixture();

  assert.equal(movements(), 1, "its opening stock is a movement");
  assert.deepEqual(db.itemRemovalBlockers(itemId), [], "its own ledger does not block it");
  assert.deepEqual(db.itemRemovalCost(itemId), ["25 KG still in stock", "1 stock movement"]);
});

test("approving erases the material and the ledger that describes only it", () => {
  const { db, admin, clerk, itemId, exists, movements } = createFixture();

  const request = db.createItemRemovalRequest({ itemId, requestedBy: clerk.id, reason: "typed the wrong grade" });
  assert.equal(request.status, "PENDING");
  assert.equal(exists(), true, "nothing goes while it waits");

  db.reviewRemovalRequest({ requestId: request.id, reviewerId: admin.id, decision: "APPROVED" });

  assert.equal(exists(), false);
  assert.equal(movements(), 0, "its movements go with it, not left pointing at nothing");
  const balance = db.db.prepare("SELECT COUNT(1) AS n FROM inventory_stock_balances WHERE item_id = ?").get(itemId) as { n: number };
  assert.equal(Number(balance.n), 0);

  const notices = db.getUserNotifications(clerk.id) as Array<{ title: string; message: string }>;
  assert.equal(
    notices.some((notice) => notice.message.includes("has been removed")),
    true,
    "the requester is told either way"
  );
});

test("the audit trail outlives the material", () => {
  const { db, admin, itemId } = createFixture();
  db.applyAdminItemRemoval({ itemId, adminId: admin.id, reason: "duplicate" });

  const trail = db.db
    .prepare("SELECT COUNT(1) AS n FROM inventory_item_audit WHERE entity_id = ? AND action = 'DELETE'")
    .get(itemId) as { n: number };
  assert.equal(Number(trail.n) > 0, true);
});

test("a material with a printed label out in the store can never be erased, and says so", () => {
  const { db, clerk, itemId, exists, printLabel } = createFixture();
  printLabel(1);

  assert.deepEqual(db.itemRemovalBlockers(itemId), ["1 QR label"]);
  assert.throws(() => db.createItemRemovalRequest({ itemId, requestedBy: clerk.id }), /1 QR label/);
  assert.equal(exists(), true);
});

test("a stock correction goes WITH the material — it only counts what the material held", () => {
  const { db, admin, clerk, itemId, exists } = createFixture();
  db.createStockCorrectionRequest({ itemId, quantity: -2, requestedBy: clerk.id, reason: "counted short" });

  assert.deepEqual(db.itemRemovalBlockers(itemId), [], "a correction is not a record kept elsewhere");
  assert.equal(db.itemRemovalCost(itemId).includes("1 stock correction"), true, "but the screen says it will go");

  db.applyAdminItemRemoval({ itemId, adminId: admin.id });
  assert.equal(exists(), false);
  const left = db.db.prepare("SELECT COUNT(1) AS n FROM stock_correction_requests WHERE item_id = ?").get(itemId) as { n: number };
  assert.equal(Number(left.n), 0);
});

test("a material that gained a label while the request waited is refused at approval", () => {
  const { db, admin, clerk, itemId, exists, printLabel } = createFixture();
  const request = db.createItemRemovalRequest({ itemId, requestedBy: clerk.id });

  printLabel(1);

  assert.throws(
    () => db.reviewRemovalRequest({ requestId: request.id, reviewerId: admin.id, decision: "APPROVED" }),
    /now has 1 QR label/
  );
  assert.equal(exists(), true);
  assert.equal(db.getRemovalRequest(request.id)!.status, "PENDING");
});

test("declining erases nothing", () => {
  const { db, admin, clerk, itemId, exists } = createFixture();
  const request = db.createItemRemovalRequest({ itemId, requestedBy: clerk.id });

  db.reviewRemovalRequest({ requestId: request.id, reviewerId: admin.id, decision: "REJECTED", reviewNotes: "keep it" });

  assert.equal(exists(), true);
  assert.equal(db.getRemovalRequest(request.id)!.status, "REJECTED");
});

test("a disabled material can be switched back on", () => {
  const { db, itemId } = createFixture();
  const status = () =>
    String((db.db.prepare("SELECT status FROM inventory_items WHERE id = ?").get(itemId) as { status: string }).status);

  db.setInventoryItemStatus({ itemId, status: "INACTIVE" });
  assert.equal(status(), "INACTIVE");

  db.setInventoryItemStatus({ itemId, status: "ACTIVE" });
  assert.equal(status(), "ACTIVE");
});

test("a disabled material can still be erased — being hidden is not a blocker", () => {
  const { db, admin, itemId, exists } = createFixture();
  db.setInventoryItemStatus({ itemId, status: "INACTIVE" });

  assert.deepEqual(db.itemRemovalBlockers(itemId), []);
  db.applyAdminItemRemoval({ itemId, adminId: admin.id });
  assert.equal(exists(), false);
});
