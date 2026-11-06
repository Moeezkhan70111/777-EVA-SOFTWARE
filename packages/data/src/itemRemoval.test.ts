import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "./sqliteDatabase.js";

// Removing a raw material, with an administrator's approval (production, 2026-11-05).
//
// The rule: a material may be removed only when it holds no stock, and removing it marks it. Its
// movements are facts that have already replicated, so they stay. Anything outside the material
// that names it -- a printed label, a scan, a purchase line -- still blocks it.
//
// What these tests hold in place:
//
//   - a material holding stock is refused, and the refusal names the quantity;
//   - emptied, it can be removed, and every movement stays;
//   - a removed material leaves the lists, cannot be put back, and frees its signature;
//   - a material a printed label or a purchase names cannot be, and says why;
//   - nothing changes while the request is pending, or when it is declined;
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
  const removed = () =>
    Boolean((db.db.prepare("SELECT removed_at FROM inventory_items WHERE id = ?").get(item.id) as { removed_at: string | null }).removed_at);
  /** The operator accounts for what it held, so a movement says where it went. */
  const emptyStock = () => db.adjustInventoryStock({ itemId: item.id, quantity: -25, note: "entered by mistake" });
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

  return { db, admin, clerk, itemId: item.id, categoryId, unitId, exists, removed, emptyStock, movements, printLabel, tempDir };
}

test("a material still holding stock cannot be removed, and the refusal names the quantity", () => {
  const { db, admin, clerk, itemId, exists, removed } = createFixture();

  assert.deepEqual(db.itemRemovalBlockers(itemId), ["25 KG in stock (issue or adjust it to zero first)"]);
  assert.throws(() => db.createItemRemovalRequest({ itemId, requestedBy: clerk.id }), /still holds 25 KG\. Issue or adjust it to zero first/);
  assert.throws(() => db.applyAdminItemRemoval({ itemId, adminId: admin.id }), /still holds 25 KG/);
  assert.equal(exists(), true);
  assert.equal(removed(), false);
});

test("stock that returned while the request waited is refused at approval, naming the quantity", () => {
  const { db, admin, clerk, itemId, removed, emptyStock } = createFixture();
  emptyStock();
  const request = db.createItemRemovalRequest({ itemId, requestedBy: clerk.id });

  db.adjustInventoryStock({ itemId, quantity: 4, note: "found some" });

  assert.throws(
    () => db.reviewRemovalRequest({ requestId: request.id, reviewerId: admin.id, decision: "APPROVED" }),
    /still holds 4 KG/
  );
  assert.equal(removed(), false);
  assert.equal(db.getRemovalRequest(request.id)!.status, "PENDING");
});

test("emptied, a material can be removed, and what happened to it says so", () => {
  const { db, itemId, movements, emptyStock } = createFixture();
  emptyStock();

  assert.equal(movements(), 2, "its opening stock, and the movement that accounted for it");
  assert.deepEqual(db.itemRemovalBlockers(itemId), [], "its own ledger does not block it");
  assert.deepEqual(db.itemRemovalCost(itemId), ["2 stock movements"]);
});

test("approving marks the material removed, and every movement stays", () => {
  const { db, admin, clerk, itemId, exists, removed, emptyStock, movements } = createFixture();
  emptyStock();

  const request = db.createItemRemovalRequest({ itemId, requestedBy: clerk.id, reason: "typed the wrong grade" });
  assert.equal(request.status, "PENDING");
  assert.equal(removed(), false, "nothing changes while it waits");

  db.reviewRemovalRequest({ requestId: request.id, reviewerId: admin.id, decision: "APPROVED" });

  assert.equal(removed(), true);
  assert.equal(exists(), true, "the row stays: its movements name it");
  assert.equal(movements(), 2, "history is not deleted");
  const balance = db.db.prepare("SELECT quantity_on_hand AS q FROM inventory_stock_balances WHERE item_id = ?").get(itemId) as { q: number };
  assert.equal(Number(balance.q), 0);

  const notices = db.getUserNotifications(clerk.id) as Array<{ title: string; message: string }>;
  assert.equal(
    notices.some((notice) => notice.message.includes("has been removed")),
    true,
    "the requester is told either way"
  );
});

test("the audit trail records the removal", () => {
  const { db, admin, itemId, emptyStock } = createFixture();
  emptyStock();
  db.applyAdminItemRemoval({ itemId, adminId: admin.id, reason: "duplicate" });

  const trail = db.db
    .prepare("SELECT COUNT(1) AS n FROM inventory_item_audit WHERE entity_id = ? AND action = 'REMOVE'")
    .get(itemId) as { n: number };
  assert.equal(Number(trail.n), 1);
});

test("a removed material leaves every list, cannot be put back or removed twice, and frees its signature", () => {
  const { db, admin, itemId, categoryId, unitId, emptyStock } = createFixture();
  emptyStock();
  db.applyAdminItemRemoval({ itemId, adminId: admin.id });

  const listed = (status: "ACTIVE" | "INACTIVE" | "ALL") =>
    (db.listInventoryItems({ status }) as unknown as Array<{ id: string }>).map((row) => row.id);
  for (const status of ["ACTIVE", "INACTIVE", "ALL"] as const) assert.equal(listed(status).includes(itemId), false, status);
  assert.throws(() => db.setInventoryItemStatus({ itemId, status: "ACTIVE" }), /has been removed/);
  assert.deepEqual(db.itemRemovalBlockers(itemId), ["This material has already been removed."]);

  const again = db.createInventoryItem({ categoryId, unitId, stockQuantity: 0, values: { grade: "WRONG" } });
  assert.notEqual(again.id, itemId, "the same material can be made again, as a new one");
});

test("a material with a printed label out in the store can never be erased, and says so", () => {
  const { db, clerk, itemId, exists, emptyStock, printLabel } = createFixture();
  emptyStock();
  printLabel(1);

  assert.deepEqual(db.itemRemovalBlockers(itemId), ["1 QR label"]);
  assert.throws(() => db.createItemRemovalRequest({ itemId, requestedBy: clerk.id }), /1 QR label/);
  assert.equal(exists(), true);
});

test("a stock correction stays with the material's history", () => {
  const { db, admin, clerk, itemId, removed, emptyStock } = createFixture();
  db.createStockCorrectionRequest({ itemId, quantity: -2, requestedBy: clerk.id, reason: "counted short" });
  emptyStock();

  assert.deepEqual(db.itemRemovalBlockers(itemId), [], "a correction is not a record kept elsewhere");
  assert.equal(db.itemRemovalCost(itemId).includes("1 stock correction"), true, "and the screen says it stays");

  db.applyAdminItemRemoval({ itemId, adminId: admin.id });
  assert.equal(removed(), true);
  const left = db.db.prepare("SELECT COUNT(1) AS n FROM stock_correction_requests WHERE item_id = ?").get(itemId) as { n: number };
  assert.equal(Number(left.n), 1);
});

test("a material that gained a label while the request waited is refused at approval", () => {
  const { db, admin, clerk, itemId, exists, emptyStock, printLabel } = createFixture();
  emptyStock();
  const request = db.createItemRemovalRequest({ itemId, requestedBy: clerk.id });

  printLabel(1);

  assert.throws(
    () => db.reviewRemovalRequest({ requestId: request.id, reviewerId: admin.id, decision: "APPROVED" }),
    /now has 1 QR label/
  );
  assert.equal(exists(), true);
  assert.equal(db.getRemovalRequest(request.id)!.status, "PENDING");
});

test("declining changes nothing", () => {
  const { db, admin, clerk, itemId, removed, emptyStock } = createFixture();
  emptyStock();
  const request = db.createItemRemovalRequest({ itemId, requestedBy: clerk.id });

  db.reviewRemovalRequest({ requestId: request.id, reviewerId: admin.id, decision: "REJECTED", reviewNotes: "keep it" });

  assert.equal(removed(), false);
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

test("a disabled material can still be removed once it is empty — being hidden is not a blocker", () => {
  const { db, admin, itemId, removed, emptyStock } = createFixture();
  emptyStock();
  db.setInventoryItemStatus({ itemId, status: "INACTIVE" });

  assert.deepEqual(db.itemRemovalBlockers(itemId), []);
  db.applyAdminItemRemoval({ itemId, adminId: admin.id });
  assert.equal(removed(), true);
});

// ─── A STORE OPERATOR REMOVING A MATERIAL, AND MAKING ONE AGAIN (owner, 6 Nov 2026) ────────────

test("someone allowed to remove directly does so at once, under the same rules, with their name on it", () => {
  const { db, clerk, itemId, removed, emptyStock, movements } = createFixture();
  assert.throws(() => db.applyDirectItemRemoval({ itemId, userId: clerk.id }), /25/, "stock still refuses it, naming the quantity");
  assert.equal(removed(), false);

  emptyStock();
  const before = movements();
  const request = db.applyDirectItemRemoval({ itemId, userId: clerk.id, reason: "entered by mistake" });
  assert.equal(request.status, "APPROVED");
  assert.equal(removed(), true);
  assert.equal(movements(), before, "every movement stays");

  const audit = db.db.prepare("SELECT changed_by FROM inventory_item_audit WHERE entity_id = ? AND action = 'REMOVE'").get(itemId) as { changed_by: string };
  assert.equal(audit.changed_by, "aslam", "the removal carries their name");

  const second = createFixture();
  second.emptyStock();
  second.printLabel(1);
  assert.throws(() => second.db.applyDirectItemRemoval({ itemId: second.itemId, userId: second.clerk.id }), /QR label/, "a printed label still refuses it");
});

test("an administrator's approval is still an administrator's: a request cannot be approved by anyone else", () => {
  const { db, clerk, itemId, emptyStock } = createFixture();
  emptyStock();
  const request = db.createItemRemovalRequest({ itemId, requestedBy: clerk.id });
  assert.throws(() => db.reviewRemovalRequest({ requestId: request.id, reviewerId: clerk.id, decision: "APPROVED" }), /Administrator access required/);
});

test("making a removed material again makes a new one, with no constraint error", () => {
  const { db, clerk, itemId, categoryId, unitId, emptyStock } = createFixture();
  emptyStock();
  db.applyDirectItemRemoval({ itemId, userId: clerk.id });
  const again = db.createInventoryItem({ categoryId, unitId, values: { grade: "WRONG" }, enableIfDisabled: true });
  assert.notEqual(again.id, itemId);
  assert.equal(again.duplicate, undefined);
  assert.equal(again.reenabled, undefined);
});

test("making a disabled material again brings the same one back, with its code and history, and no constraint error", () => {
  const { db, itemId, categoryId, unitId, movements } = createFixture();
  db.setInventoryItemStatus({ itemId, status: "INACTIVE" });
  const before = movements();
  const again = db.createInventoryItem({ categoryId, unitId, stockQuantity: 99, values: { grade: "WRONG" }, createdBy: "aslam", enableIfDisabled: true });
  assert.equal(again.id, itemId);
  assert.equal(again.reenabled, true);
  const row = db.db.prepare("SELECT status FROM inventory_items WHERE id = ?").get(itemId) as { status: string };
  assert.equal(row.status, "ACTIVE");
  assert.equal(movements(), before, "the opening stock typed the second time moved nothing");
});

test("an import that names a disabled material reports a duplicate, and leaves it disabled", () => {
  const { db, itemId, categoryId, unitId } = createFixture();
  db.setInventoryItemStatus({ itemId, status: "INACTIVE" });
  const again = db.createInventoryItem({ categoryId, unitId, values: { grade: "WRONG" } });
  assert.equal(again.id, itemId);
  assert.equal(again.duplicate, true);
  const row = db.db.prepare("SELECT status FROM inventory_items WHERE id = ?").get(itemId) as { status: string };
  assert.equal(row.status, "INACTIVE");
});
