import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "./sqliteDatabase.js";

// Correcting a raw material's count is a claim that the shelf disagrees with the system, so
// it is reviewed before it is applied. What these tests hold in place:
//
//   - nothing moves while a correction is pending;
//   - approving is what applies it, and the request and the stock event agree;
//   - declining changes no stock at all;
//   - both outcomes tell the person who asked.

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-stock-correction-"));
  const db = new SqliteDatabase({
    dbPath: path.join(tempDir, "corrections.db"),
    schemaPath: path.resolve(process.cwd(), "src/local-schema.sql"),
  });

  const admin = db.bootstrapFirstAdmin("owner", "password1");
  const storekeeper = db.createUserAccount("aslam", "password1");
  db.db.prepare("UPDATE app_users SET access_status = 'APPROVED' WHERE id = ?").run(storekeeper.id);

  db.createInventoryUnit({ code: "DZN", name: "Dozen" });
  const unitId = (db.listInventoryUnits() as Array<{ id: string; code: string }>).find((u) => u.code === "DZN")!.id;
  const categoryId = db.createInventoryCategory({ name: "Rubber Upper" });
  db.addInventoryCategoryField({ categoryId, fieldKey: "article", label: "Article", fieldType: "TEXT", required: true });
  const item = db.createInventoryItem({ categoryId, unitId, stockQuantity: 100, values: { article: "SK6" } });

  const onHand = () =>
    Number(
      (db.db.prepare("SELECT quantity_on_hand FROM inventory_stock_balances WHERE item_id = ?").get(item.id) as
        | { quantity_on_hand: number }
        | undefined)?.quantity_on_hand ?? 0
    );
  const noticesFor = (userId: string) => db.getUserNotifications(userId);

  return {
    db,
    admin,
    storekeeper,
    itemId: item.id,
    onHand,
    noticesFor,
    cleanup: () => {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

test("a correction waits for approval: nothing moves, and the administrator is told", () => {
  const f = createFixture();
  try {
    const request = f.db.createStockCorrectionRequest({
      itemId: f.itemId,
      quantity: -3,
      reason: "3 packets damaged in handling",
      requestedBy: f.storekeeper.id,
    });

    assert.equal(request.status, "PENDING");
    assert.match(request.requestCode, /^SCR-\d{6}$/);
    assert.equal(f.onHand(), 100, "stock must not move until the correction is approved");
    assert.equal(f.db.listInventoryStockEvents(f.itemId).length, 1, "only the opening stock event exists");

    const adminNotices = f.noticesFor(f.admin.id);
    assert.equal(adminNotices.length, 1);
    assert.equal(adminNotices[0].kind, "STOCK_CORRECTION_REQUESTED");
    assert.equal(adminNotices[0].entityId, f.itemId, "the notice points at the material, so it can be opened");
    assert.match(adminNotices[0].message, /damaged in handling/);
    assert.match(adminNotices[0].message, /-3 DZN/);
  } finally {
    f.cleanup();
  }
});

test("approving applies it: the balance, the ledger and the request all agree, and the requester is told", () => {
  const f = createFixture();
  try {
    const request = f.db.createStockCorrectionRequest({
      itemId: f.itemId,
      quantity: -3,
      reason: "3 packets damaged in handling",
      requestedBy: f.storekeeper.id,
    });

    const decided = f.db.reviewStockCorrectionRequest({
      requestId: request.id,
      reviewerId: f.admin.id,
      decision: "APPROVED",
    });

    assert.equal(decided.status, "APPROVED");
    assert.equal(decided.reviewedByName, "owner");
    assert.equal(f.onHand(), 97);

    const events = f.db.listInventoryStockEvents(f.itemId);
    assert.equal(events.length, 2);
    assert.equal(events[0].quantity, -3);
    assert.equal(events[0].eventType, "ADJUST");
    assert.match(events[0].note ?? "", /damaged in handling/);
    assert.match(events[0].note ?? "", new RegExp(request.requestCode), "the ledger points back at the decision");

    const notices = f.noticesFor(f.storekeeper.id);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].kind, "STOCK_CORRECTION_APPROVED");
    assert.equal(notices[0].entityId, f.itemId);
  } finally {
    f.cleanup();
  }
});

test("declining changes no stock, and says why", () => {
  const f = createFixture();
  try {
    const request = f.db.createStockCorrectionRequest({
      itemId: f.itemId,
      quantity: 50,
      reason: "Found an extra pallet",
      requestedBy: f.storekeeper.id,
    });

    const decided = f.db.reviewStockCorrectionRequest({
      requestId: request.id,
      reviewerId: f.admin.id,
      decision: "REJECTED",
      reviewNotes: "Recount first — the last delivery was not scanned yet",
    });

    assert.equal(decided.status, "REJECTED");
    assert.equal(f.onHand(), 100);
    assert.equal(f.db.listInventoryStockEvents(f.itemId).length, 1);

    const notices = f.noticesFor(f.storekeeper.id);
    assert.equal(notices[0].kind, "STOCK_CORRECTION_REJECTED");
    assert.match(notices[0].message, /Recount first/);
    assert.match(notices[0].message, /Nothing changed/);
  } finally {
    f.cleanup();
  }
});

test("a decided correction cannot be applied twice", () => {
  const f = createFixture();
  try {
    const request = f.db.createStockCorrectionRequest({
      itemId: f.itemId,
      quantity: -5,
      reason: "Shrinkage found at stocktake",
      requestedBy: f.storekeeper.id,
    });
    f.db.reviewStockCorrectionRequest({ requestId: request.id, reviewerId: f.admin.id, decision: "APPROVED" });

    assert.throws(
      () => f.db.reviewStockCorrectionRequest({ requestId: request.id, reviewerId: f.admin.id, decision: "APPROVED" }),
      /already been decided/
    );
    assert.equal(f.onHand(), 95, "the second approval must not move stock again");
  } finally {
    f.cleanup();
  }
});

test("only one correction may be open against a material at a time", () => {
  const f = createFixture();
  try {
    f.db.createStockCorrectionRequest({
      itemId: f.itemId,
      quantity: -3,
      reason: "Damaged in handling",
      requestedBy: f.storekeeper.id,
    });

    assert.throws(
      () =>
        f.db.createStockCorrectionRequest({
          itemId: f.itemId,
          quantity: -2,
          reason: "Another count difference",
          requestedBy: f.admin.id,
        }),
      /already has a correction waiting/
    );
  } finally {
    f.cleanup();
  }
});

test("a correction needs a real reason and a non-zero amount", () => {
  const f = createFixture();
  try {
    assert.throws(
      () => f.db.createStockCorrectionRequest({ itemId: f.itemId, quantity: -3, reason: "  ", requestedBy: f.storekeeper.id }),
      /Say why/
    );
    assert.throws(
      () => f.db.createStockCorrectionRequest({ itemId: f.itemId, quantity: -3, reason: "up", requestedBy: f.storekeeper.id }),
      /Say why/
    );
    assert.throws(
      () => f.db.createStockCorrectionRequest({ itemId: f.itemId, quantity: 0, reason: "No change at all", requestedBy: f.storekeeper.id }),
      /how much the count is out by/
    );
    assert.equal(f.onHand(), 100);
  } finally {
    f.cleanup();
  }
});

test("only an administrator may decide", () => {
  const f = createFixture();
  try {
    const request = f.db.createStockCorrectionRequest({
      itemId: f.itemId,
      quantity: -3,
      reason: "Damaged in handling",
      requestedBy: f.storekeeper.id,
    });

    assert.throws(
      () => f.db.reviewStockCorrectionRequest({ requestId: request.id, reviewerId: f.storekeeper.id, decision: "APPROVED" }),
      /Administrator access required/
    );
    assert.equal(f.onHand(), 100);
    assert.equal(f.db.getStockCorrectionRequest(request.id)!.status, "PENDING");
  } finally {
    f.cleanup();
  }
});

test("an administrator's own correction applies at once, and is still recorded as approved", () => {
  const f = createFixture();
  try {
    const applied = f.db.applyAdminStockCorrection({
      itemId: f.itemId,
      quantity: -4,
      reason: "Counted short at stocktake",
      adminId: f.admin.id,
    });

    assert.equal(applied.status, "APPROVED");
    assert.equal(applied.requestedByName, "owner");
    assert.equal(applied.reviewedByName, "owner");
    assert.equal(f.onHand(), 96);
    assert.equal(f.db.listStockCorrectionRequests({ status: "PENDING" }).length, 0);

    const events = f.db.listInventoryStockEvents(f.itemId);
    assert.match(events[0].note ?? "", /Counted short at stocktake/);
  } finally {
    f.cleanup();
  }
});
