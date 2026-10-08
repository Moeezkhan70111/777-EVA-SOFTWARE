import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "./sqliteDatabase.js";

// Removing a raw material category is irreversible — its attributes go with it — so it takes
// the same path a stock correction takes: a request an administrator decides. What these
// tests hold in place:
//
//   - only an EMPTY category can be asked for, and emptiness counts inactive materials;
//   - nothing is deleted while a request is pending;
//   - approving is what deletes, and it re-checks emptiness first;
//   - declining deletes nothing;
//   - both outcomes tell the person who asked;
//   - only an administrator decides.

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-category-removal-"));
  const db = new SqliteDatabase({
    dbPath: path.join(tempDir, "removals.db"),
    schemaPath: path.resolve(process.cwd(), "src/local-schema.sql"),
  });

  const admin = db.bootstrapFirstAdmin("owner", "password1");
  const clerk = db.createUserAccount("aslam", "password1");
  db.db.prepare("UPDATE app_users SET access_status = 'APPROVED' WHERE id = ?").run(clerk.id);

  db.createInventoryUnit({ code: "DZN", name: "Dozen" });
  const unitId = (db.listInventoryUnits() as Array<{ id: string; code: string }>).find((u) => u.code === "DZN")!.id;

  const emptyId = db.createInventoryCategory({ name: "Spare Kind" });
  const usedId = db.createInventoryCategory({ name: "Rubber Upper" });
  db.addInventoryCategoryField({ categoryId: usedId, fieldKey: "article", label: "Article", fieldType: "TEXT", required: true });
  const item = db.createInventoryItem({ categoryId: usedId, unitId, stockQuantity: 10, values: { article: "SK6" } });

  const exists = (categoryId: string) =>
    Boolean(db.db.prepare("SELECT 1 AS ok FROM inventory_categories WHERE id = ?").get(categoryId));

  return { db, admin, clerk, emptyId, usedId, itemId: item.id, unitId, exists, tempDir };
}

test("an empty category can be asked for; one holding materials cannot", () => {
  const { db, clerk, emptyId, usedId } = createFixture();

  assert.deepEqual(db.categoryRemovalBlockers(emptyId), []);
  assert.deepEqual(db.categoryRemovalBlockers(usedId), ["1 raw material"]);

  assert.throws(
    () => db.createCategoryRemovalRequest({ categoryId: usedId, requestedBy: clerk.id }),
    /still holds 1 raw material/
  );
});

test("a category with sub-categories cannot go either, and says so", () => {
  const { db, clerk, emptyId } = createFixture();
  db.createInventoryCategory({ name: "A Kind Of It", parentId: emptyId });

  assert.deepEqual(db.categoryRemovalBlockers(emptyId), ["1 sub-category"]);
  assert.throws(() => db.createCategoryRemovalRequest({ categoryId: emptyId, requestedBy: clerk.id }), /sub-categor/);
});

test("an inactive material still blocks it — it is filed here", () => {
  const { db, usedId, itemId } = createFixture();
  db.setInventoryItemStatus({ itemId, status: "INACTIVE" });
  assert.deepEqual(db.categoryRemovalBlockers(usedId), ["1 raw material"]);
});

test("nothing is deleted while the request is pending, and the administrator is told", () => {
  const { db, admin, clerk, emptyId, exists } = createFixture();

  const request = db.createCategoryRemovalRequest({ categoryId: emptyId, requestedBy: clerk.id, reason: "made by mistake" });
  assert.equal(request.status, "PENDING");
  assert.match(request.requestCode, /^DEL-\d{6}$/);
  assert.equal(request.targetName, "SPARE KIND");
  assert.equal(exists(emptyId), true, "the category must still be there while it waits");

  const notices = db.getUserNotifications(admin.id) as Array<{ title: string; message: string }>;
  assert.equal(notices.some((n) => n.title === "Category removal to approve" && n.message.includes("made by mistake")), true);
});

test("one open request per category", () => {
  const { db, clerk, emptyId } = createFixture();
  db.createCategoryRemovalRequest({ categoryId: emptyId, requestedBy: clerk.id });
  assert.throws(() => db.createCategoryRemovalRequest({ categoryId: emptyId, requestedBy: clerk.id }), /already asked/);
});

test("approving is what deletes it, and the requester is told", () => {
  const { db, admin, clerk, emptyId, exists } = createFixture();

  const request = db.createCategoryRemovalRequest({ categoryId: emptyId, requestedBy: clerk.id });
  const decided = db.reviewRemovalRequest({ requestId: request.id, reviewerId: admin.id, decision: "APPROVED" });

  assert.equal(decided.status, "APPROVED");
  assert.equal(exists(emptyId), false, "approval must actually remove the category");

  const notices = db.getUserNotifications(clerk.id) as Array<{ title: string }>;
  assert.equal(notices.some((n) => n.title === "Category removed"), true);
});

test("the category's own attributes and their options go with it", () => {
  const { db, admin, emptyId } = createFixture();
  const fieldId = db.addInventoryCategoryField({
    categoryId: emptyId,
    fieldKey: "colour",
    label: "Colour",
    fieldType: "DROPDOWN",
  });
  db.addInventoryFieldOption({ fieldId, value: "BLACK" });

  db.applyAdminCategoryRemoval({ categoryId: emptyId, adminId: admin.id });

  const fields = db.db.prepare("SELECT COUNT(*) AS n FROM inventory_category_fields WHERE category_id = ?").get(emptyId) as { n: number };
  const options = db.db.prepare("SELECT COUNT(*) AS n FROM inventory_category_field_options WHERE field_id = ?").get(fieldId) as { n: number };
  assert.equal(Number(fields.n), 0);
  assert.equal(Number(options.n), 0);
});

test("a category that stopped being empty while it waited is refused, and nothing is deleted", () => {
  const { db, admin, clerk, emptyId, unitId, exists } = createFixture();

  const request = db.createCategoryRemovalRequest({ categoryId: emptyId, requestedBy: clerk.id });
  // Someone files a material under it while the request waits.
  db.addInventoryCategoryField({ categoryId: emptyId, fieldKey: "article", label: "Article", fieldType: "TEXT", required: true });
  db.createInventoryItem({ categoryId: emptyId, unitId, stockQuantity: 1, values: { article: "LATE" } });

  assert.throws(
    () => db.reviewRemovalRequest({ requestId: request.id, reviewerId: admin.id, decision: "APPROVED" }),
    /no longer empty/
  );
  assert.equal(exists(emptyId), true);
  // The refusal rolled back, so the request is still open for a fresh decision.
  assert.equal(db.getRemovalRequest(request.id)!.status, "PENDING");
});

test("declining deletes nothing and tells the requester why", () => {
  const { db, admin, clerk, emptyId, exists } = createFixture();

  const request = db.createCategoryRemovalRequest({ categoryId: emptyId, requestedBy: clerk.id });
  const decided = db.reviewRemovalRequest({
    requestId: request.id,
    reviewerId: admin.id,
    decision: "REJECTED",
    reviewNotes: "we will use it next season",
  });

  assert.equal(decided.status, "REJECTED");
  assert.equal(decided.reviewNotes, "we will use it next season");
  assert.equal(exists(emptyId), true);

  const notices = db.getUserNotifications(clerk.id) as Array<{ title: string; message: string }>;
  const notice = notices.find((n) => n.title === "Category removal declined");
  assert.notEqual(notice, undefined);
  assert.equal(notice!.message.includes("we will use it next season"), true);
});

test("only an administrator decides, and a decided request cannot be decided twice", () => {
  const { db, admin, clerk, emptyId } = createFixture();

  const request = db.createCategoryRemovalRequest({ categoryId: emptyId, requestedBy: clerk.id });
  assert.throws(
    () => db.reviewRemovalRequest({ requestId: request.id, reviewerId: clerk.id, decision: "APPROVED" }),
    /Administrator access required/
  );

  db.reviewRemovalRequest({ requestId: request.id, reviewerId: admin.id, decision: "REJECTED" });
  assert.throws(
    () => db.reviewRemovalRequest({ requestId: request.id, reviewerId: admin.id, decision: "APPROVED" }),
    /already been decided/
  );
});

test("an administrator's own removal is carried out at once, through the same record", () => {
  const { db, admin, emptyId, exists } = createFixture();

  const request = db.applyAdminCategoryRemoval({ categoryId: emptyId, adminId: admin.id, reason: "duplicate" });

  assert.equal(request.status, "APPROVED");
  assert.equal(request.reviewedBy, admin.id);
  assert.equal(exists(emptyId), false);
  // One audit trail: the removal is on the same list every request is on.
  assert.equal(db.listRemovalRequests({ status: "APPROVED" }).some((r) => r.id === request.id), true);
});
