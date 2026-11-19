import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CancelGatepassUseCase, CreateGatepassUseCase } from "@erp/application";
import { PENDING_ORDER_FILTER, type PendingOrderFilter } from "@erp/domain";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { UuidGenerator } from "./idGenerator.js";

// CUSTOMER ORDERS AND PENDING ORDERS against the real database and the real gatepass use cases (docs/52). Gatepasses are
// made the way the desktop makes them, with carton QR on hold (so a gatepass may take the store below zero and needs no
// scanning), and every pending figure is read back from the records.

type Raw = import("node:sqlite").DatabaseSync;
const FACTORY = "factory-777";

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-orders-"));
  const db = new SqliteDatabase({ dbPath: path.join(tempDir, "orders.db"), schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  db.setNumberBlock(1, "test");
  db.ensureOperationalContext({
    factoryId: FACTORY, factoryCode: "777", factoryName: "777", workstationId: "ws-01", workstationCode: "WS-01",
    workstationName: "WS", deviceId: "desktop-main", deviceName: "Desktop", appVersion: "1.0.0",
  });
  db.cartonQrOnHold = true;
  const raw = (db as unknown as { db: Raw }).db;
  const party = (name: string, mobile: string) => db.createParty({ partyName: name, partyType: "CUSTOMER", city: "Lahore", mobileNumber: mobile, status: "ACTIVE" });
  const behraam = party("BEHRAAM SHOES", "0300-1111111");
  const mama = party("MAMA CHAPPAL", "0300-2222222");
  for (const size of ["6", "7", "8"]) {
    db.createProduct({ article: "SK6", size, sellingPrice: 550, machineRate: 70, packingRate: 30, colors: ["RED", "BLUE", "BLACK"], status: "ACTIVE" });
  }
  db.createProduct({ article: "SK9", size: "7", sellingPrice: 600, machineRate: 70, packingRate: 30, colors: ["RED"], status: "ACTIVE" });
  const variant = (article: string, color: string, size: string) =>
    (raw.prepare("SELECT id FROM product_variants WHERE article = ? AND color = ? AND size = ?").get(article, color, size) as { id: string }).id;
  return {
    db, raw, behraam, mama, variant,
    cleanup: () => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); },
  };
}
type Fixture = ReturnType<typeof createFixture>;

const ids = () => new UuidGenerator();

const saveOrder = (f: Fixture, partyId: string, lines: Array<[string, number]>, requestId: string = crypto.randomUUID()) =>
  f.db.saveCustomerOrder({ requestId, partyId, lines: lines.map(([productVariantId, quantity]) => ({ productVariantId, quantity })), actor: "clerk" }).order;

const gatepass = async (f: Fixture, partyId: string, lines: Array<[string, number]>, requestId: string = crypto.randomUUID()) => {
  const result = await new CreateGatepassUseCase({ txManager: f.db, repo: f.db, idGenerator: ids() }).execute({
    partyId, lines: lines.map(([productVariantId, quantity]) => ({ productVariantId, quantity })), actor: "clerk", requestId, storeLocationId: FACTORY,
  });
  assert.equal(result.accepted, true, result.reason);
  return String(result.gatepassId);
};

const cancelGatepass = (f: Fixture, gatepassId: string) =>
  new CancelGatepassUseCase({ txManager: f.db, repo: f.db, idGenerator: ids() }).execute({ gatepassId, reason: "wrong party", actor: "clerk" });

/** Pending per product for one party, as the Pending Orders screen lists it. */
const pendingOf = (f: Fixture, partyId: string, filter: PendingOrderFilter = PENDING_ORDER_FILTER.ALL) =>
  Object.fromEntries(f.db.pendingOrderPartyLines(partyId, { filter }).map((line) => [`${line.article}/${line.color}/${line.size}`, [line.ordered, line.dispatched, line.pending]]));

/** Everything an order or an allocation must never change: stock, vouchers, money. */
const untouchables = (f: Fixture) => ({
  cartonEvents: Number((f.raw.prepare("SELECT COUNT(*) AS n FROM carton_stock_events").get() as { n: number }).n),
  cartonBalance: Number((f.raw.prepare("SELECT COALESCE(SUM(balance_delta), 0) AS n FROM carton_stock_events").get() as { n: number }).n),
  saleVouchers: Number((f.raw.prepare("SELECT COUNT(*) AS n FROM sale_vouchers").get() as { n: number }).n),
  saleTotal: Number((f.raw.prepare("SELECT COALESCE(SUM(total_amount_paisa), 0) AS n FROM sale_vouchers").get() as { n: number }).n),
  cashVouchers: Number((f.raw.prepare("SELECT COUNT(*) AS n FROM cash_vouchers").get() as { n: number }).n),
  gatepasses: Number((f.raw.prepare("SELECT COUNT(*) AS n FROM gatepasses").get() as { n: number }).n),
});

test("an order with two articles and three colours, then a partial gatepass and a second one: pending goes down by exactly what left", async () => {
  const f = createFixture();
  try {
    const before = untouchables(f);
    const order = saveOrder(f, f.behraam, [
      [f.variant("SK6", "RED", "6"), 10], [f.variant("SK6", "BLUE", "6"), 15], [f.variant("SK6", "BLACK", "7"), 8], [f.variant("SK9", "RED", "7"), 12],
    ]);
    assert.equal(order.code, "ORD-000001");
    assert.deepEqual(order.totals, { ordered: 45, dispatched: 0, pending: 45 });
    assert.deepEqual(untouchables(f), before, "an order moves no stock, makes no voucher, touches no money");

    const parties = f.db.pendingOrderParties();
    assert.deepEqual(parties.rows.map((row) => [row.partyName, row.pending, row.lineCount, row.progress]), [["BEHRAAM SHOES", 45, 4, "PENDING"]]);

    await gatepass(f, f.behraam, [[f.variant("SK6", "RED", "6"), 4], [f.variant("SK9", "RED", "7"), 12]]);
    assert.deepEqual(pendingOf(f, f.behraam), {
      "SK6/BLACK/7": [8, 0, 8], "SK6/BLUE/6": [15, 0, 15], "SK6/RED/6": [10, 4, 6], "SK9/RED/7": [12, 12, 0],
    });
    await gatepass(f, f.behraam, [[f.variant("SK6", "RED", "6"), 6], [f.variant("SK6", "BLUE", "6"), 5]]);
    assert.deepEqual(pendingOf(f, f.behraam), {
      "SK6/BLACK/7": [8, 0, 8], "SK6/BLUE/6": [15, 5, 10], "SK6/RED/6": [10, 10, 0], "SK9/RED/7": [12, 12, 0],
    });
    assert.deepEqual(Object.keys(pendingOf(f, f.behraam, PENDING_ORDER_FILTER.OUTSTANDING)), ["SK6/BLACK/7", "SK6/BLUE/6"], "outstanding lists only what is still owed");
    assert.deepEqual(Object.keys(pendingOf(f, f.behraam, PENDING_ORDER_FILTER.DISPATCHED)), ["SK6/RED/6", "SK9/RED/7"], "dispatched lists only what is done");
    assert.equal(f.db.pendingOrderParties().rows[0]?.progress, "PARTIAL");
    assert.equal(f.db.pendingOrderParties().totalPending, 18);
  } finally {
    f.cleanup();
  }
});

test("FIFO: when two orders want the same product, the older order is covered first", async () => {
  const f = createFixture();
  try {
    const red = f.variant("SK6", "RED", "7");
    const older = saveOrder(f, f.behraam, [[red, 10]]);
    const newer = saveOrder(f, f.behraam, [[red, 10]]);
    await gatepass(f, f.behraam, [[red, 14]]);
    assert.deepEqual([f.db.requireCustomerOrder(older.id).totals, f.db.requireCustomerOrder(newer.id).totals], [
      { ordered: 10, dispatched: 10, pending: 0 },
      { ordered: 10, dispatched: 4, pending: 6 },
    ]);
    const line = f.db.pendingOrderPartyLines(f.behraam, { filter: PENDING_ORDER_FILTER.ALL })[0];
    assert.deepEqual(line?.orderCodes, [older.code, newer.code]);
  } finally {
    f.cleanup();
  }
});

test("an order is only reduced by its own party's gatepasses for the same article, colour and size", async () => {
  const f = createFixture();
  try {
    const order = saveOrder(f, f.behraam, [[f.variant("SK6", "RED", "7"), 10]]);
    await gatepass(f, f.mama, [[f.variant("SK6", "RED", "7"), 5]]);
    await gatepass(f, f.behraam, [[f.variant("SK6", "BLUE", "7"), 5], [f.variant("SK6", "RED", "8"), 5]]);
    assert.deepEqual(f.db.requireCustomerOrder(order.id).totals, { ordered: 10, dispatched: 0, pending: 10 });
    assert.equal(Number((f.raw.prepare("SELECT COUNT(*) AS n FROM gatepass_order_allocations").get() as { n: number }).n), 0, "nothing matched, nothing written");
  } finally {
    f.cleanup();
  }
});

test("over-dispatch: the excess stays unallocated and pending never goes below zero", async () => {
  const f = createFixture();
  try {
    const red = f.variant("SK6", "RED", "7");
    const order = saveOrder(f, f.behraam, [[red, 10]]);
    const gatepassId = await gatepass(f, f.behraam, [[red, 25]]);
    assert.deepEqual(f.db.requireCustomerOrder(order.id).totals, { ordered: 10, dispatched: 10, pending: 0 });
    const allocation = f.raw.prepare("SELECT allocated_quantity, unallocated_quantity FROM gatepass_order_allocations WHERE gatepass_id = ?").get(gatepassId);
    assert.deepEqual({ ...allocation }, { allocated_quantity: 10, unallocated_quantity: 15 });
    await gatepass(f, f.behraam, [[red, 5]]);
    assert.deepEqual(f.db.requireCustomerOrder(order.id).totals, { ordered: 10, dispatched: 10, pending: 0 }, "a later gatepass finds nothing owed");
  } finally {
    f.cleanup();
  }
});

test("a cancelled gatepass gives back exactly what it allocated, once; another gatepass's share stays", async () => {
  const f = createFixture();
  try {
    const red = f.variant("SK6", "RED", "7");
    const older = saveOrder(f, f.behraam, [[red, 10]]);
    const newer = saveOrder(f, f.behraam, [[red, 10]]);
    const first = await gatepass(f, f.behraam, [[red, 6]]);
    const second = await gatepass(f, f.behraam, [[red, 8]]);
    assert.deepEqual([f.db.requireCustomerOrder(older.id).totals.pending, f.db.requireCustomerOrder(newer.id).totals.pending], [0, 6]);

    assert.equal((await cancelGatepass(f, first)).accepted, true);
    assert.deepEqual(
      [f.db.requireCustomerOrder(older.id).totals, f.db.requireCustomerOrder(newer.id).totals],
      [{ ordered: 10, dispatched: 4, pending: 6 }, { ordered: 10, dispatched: 4, pending: 6 }],
      "the first gatepass's 6 go back to the older order; the second gatepass's 4 + 4 stay where they were"
    );
    assert.equal((await cancelGatepass(f, first)).outcome, "ALREADY_CANCELLED");
    assert.equal(f.db.requireCustomerOrder(older.id).totals.pending, 6, "a second cancel gives back nothing more");
    const reversed = f.raw.prepare("SELECT status, reverse_reason FROM gatepass_order_allocations WHERE gatepass_id = ?").get(first);
    assert.deepEqual({ ...reversed }, { status: "REVERSED", reverse_reason: "wrong party" });
    assert.equal(Number((f.raw.prepare("SELECT COUNT(*) AS n FROM gatepass_order_allocation_lines").get() as { n: number }).n), 3, "reversed lines are kept, with when");
    assert.equal((f.raw.prepare("SELECT status FROM gatepass_order_allocations WHERE gatepass_id = ?").get(second) as { status: string }).status, "ACTIVE");
  } finally {
    f.cleanup();
  }
});

test("a gatepass whose lines change is reallocated in one transaction: old share reversed, new share made", async () => {
  const f = createFixture();
  try {
    const red = f.variant("SK6", "RED", "7");
    const order = saveOrder(f, f.behraam, [[red, 10]]);
    const gatepassId = await gatepass(f, f.behraam, [[red, 4]]);

    await f.db.runInTransaction(async (tx) => {
      f.raw.prepare("UPDATE gatepass_lines SET quantity = 7 WHERE gatepass_id = ?").run(gatepassId);
      await f.db.reallocateGatepassOrders({ gatepassId, actor: "admin", reason: "line changed" }, tx);
    });
    assert.deepEqual(f.db.requireCustomerOrder(order.id).totals, { ordered: 10, dispatched: 7, pending: 3 });

    await assert.rejects(
      f.db.runInTransaction(async (tx) => {
        f.raw.prepare("UPDATE gatepass_lines SET quantity = 2 WHERE gatepass_id = ?").run(gatepassId);
        await f.db.reallocateGatepassOrders({ gatepassId, actor: "admin", reason: "line changed" }, tx);
        throw new Error("the edit failed after reallocating");
      }),
      /edit failed/
    );
    assert.deepEqual(f.db.requireCustomerOrder(order.id).totals, { ordered: 10, dispatched: 7, pending: 3 }, "a failed edit leaves the allocation as it was");

    await f.db.runInTransaction(async (tx) => {
      f.raw.prepare("UPDATE gatepasses SET status = 'CANCELLED' WHERE id = ?").run(gatepassId);
      await f.db.reallocateGatepassOrders({ gatepassId, actor: "admin", reason: "voided" }, tx);
    });
    assert.deepEqual(f.db.requireCustomerOrder(order.id).totals, { ordered: 10, dispatched: 0, pending: 10 }, "a cancelled gatepass is only reversed");
  } finally {
    f.cleanup();
  }
});

test("a retried Create, and allocating the same gatepass again, never count a dispatch twice", async () => {
  const f = createFixture();
  try {
    const red = f.variant("SK6", "RED", "7");
    const order = saveOrder(f, f.behraam, [[red, 10]]);
    const requestId = crypto.randomUUID();
    const gatepassId = await gatepass(f, f.behraam, [[red, 4]], requestId);
    const again = await new CreateGatepassUseCase({ txManager: f.db, repo: f.db, idGenerator: ids() }).execute({
      partyId: f.behraam, lines: [{ productVariantId: red, quantity: 4 }], actor: "clerk", requestId, storeLocationId: FACTORY,
    });
    assert.equal(again.outcome, "ALREADY_SAVED");
    const line = f.raw.prepare("SELECT id FROM gatepass_lines WHERE gatepass_id = ?").get(gatepassId) as { id: string };
    await f.db.runInTransaction((tx) =>
      f.db.allocateGatepassToOrders({ gatepassId, partyId: f.behraam, actor: "clerk", lines: [{ gatepassLineId: line.id, productVariantId: red, quantity: 4 }] }, tx)
    );
    assert.deepEqual(f.db.requireCustomerOrder(order.id).totals, { ordered: 10, dispatched: 4, pending: 6 });
  } finally {
    f.cleanup();
  }
});

test("editing an order: quantities and products change, but never below what was dispatched, and never from a stale screen", async () => {
  const f = createFixture();
  try {
    const [red, blue, black] = [f.variant("SK6", "RED", "7"), f.variant("SK6", "BLUE", "7"), f.variant("SK6", "BLACK", "7")];
    const order = saveOrder(f, f.behraam, [[red, 10], [blue, 5]]);
    await gatepass(f, f.behraam, [[red, 6]]);
    const edit = (revision: number, lines: Array<[string, number]>, partyId = f.behraam) =>
      f.db.editCustomerOrder({ orderId: order.id, revision, partyId, lines: lines.map(([productVariantId, quantity]) => ({ productVariantId, quantity })), actor: "admin" });

    assert.throws(() => edit(1, [[red, 5], [blue, 5]]), /cannot be lowered below/);
    assert.throws(() => edit(1, [[blue, 5]]), /cannot be taken off/);
    assert.throws(() => edit(1, [[red, 10], [blue, 5]], f.mama), /party cannot change/);
    const edited = edit(1, [[red, 6], [black, 3]]);
    assert.equal(edited.changed, true);
    assert.deepEqual(edited.order.lines.map((line) => [line.color, line.quantity, line.pending]), [["RED", 6, 0], ["BLACK", 3, 3]], "blue taken off, black added");
    assert.throws(() => edit(1, [[red, 8]]), /since you opened it/, "a stale revision is refused");
    assert.equal(edit(2, [[red, 6], [black, 3]]).changed, false, "the same order said again writes nothing");
    const audit = f.raw.prepare("SELECT event_type FROM audit_log WHERE entity_id = ? ORDER BY created_at").all(order.id) as Array<{ event_type: string }>;
    assert.deepEqual(audit.map((row) => row.event_type), ["ORDER_CREATED", "ORDER_EDITED"]);
  } finally {
    f.cleanup();
  }
});

test("cancelling an order: it owes nothing, leaves the Pending list, and a gatepass then allocates to the next order", async () => {
  const f = createFixture();
  try {
    const red = f.variant("SK6", "RED", "7");
    const first = saveOrder(f, f.behraam, [[red, 10]]);
    const second = saveOrder(f, f.behraam, [[red, 10]]);
    assert.throws(() => f.db.cancelCustomerOrder({ orderId: first.id, revision: 1, reason: " ", actor: "admin" }), /reason/);
    const cancelled = f.db.cancelCustomerOrder({ orderId: first.id, revision: 1, reason: "party changed its mind", actor: "admin" });
    assert.deepEqual([cancelled.status, cancelled.totals.pending], ["CANCELLED", 0]);
    assert.throws(() => f.db.cancelCustomerOrder({ orderId: first.id, revision: 2, reason: "again", actor: "admin" }), /has been cancelled/);
    await gatepass(f, f.behraam, [[red, 4]]);
    assert.equal(f.db.requireCustomerOrder(second.id).totals.dispatched, 4);
    assert.deepEqual(f.db.pendingOrderPartyLines(f.behraam)[0]?.orderCodes, [second.code]);
  } finally {
    f.cleanup();
  }
});

test("an order may only name live products of an active party; a retried Save is the same order", async () => {
  const f = createFixture();
  try {
    const red = f.variant("SK6", "RED", "7");
    assert.throws(() => saveOrder(f, f.behraam, [["no-such-variant", 3]]), /not an active product/);
    assert.throws(() => saveOrder(f, f.behraam, [[red, 0]]), /whole number of cartons/);
    assert.throws(() => saveOrder(f, f.behraam, [[red, 2.5]]), /whole number of cartons/);
    assert.throws(() => saveOrder(f, f.behraam, [[red, 1], [red, 2]]), /entered twice/);
    f.raw.prepare("UPDATE parties SET status = 'INACTIVE' WHERE id = ?").run(f.mama);
    assert.throws(() => saveOrder(f, f.mama, [[red, 1]]), /inactive/);
    f.raw.prepare("UPDATE product_variants SET status = 'DISABLED' WHERE id = ?").run(f.variant("SK6", "BLUE", "7"));
    assert.throws(() => saveOrder(f, f.behraam, [[f.variant("SK6", "BLUE", "7"), 1]]), /not an active product/);
    assert.equal(f.db.customerOrderArticle("SK6").some((product) => product.color === "BLUE" && product.size === "7"), false, "the grid offers no disabled cell");

    const requestId = crypto.randomUUID();
    const once = saveOrder(f, f.behraam, [[red, 5]], requestId);
    const twice = f.db.saveCustomerOrder({ requestId, partyId: f.behraam, lines: [{ productVariantId: red, quantity: 5 }], actor: "clerk" });
    assert.deepEqual([twice.duplicate, twice.order.id, twice.order.code], [true, once.id, once.code]);
    assert.throws(() => saveOrder(f, f.behraam, [[red, 6]], requestId), /already recorded/);
    assert.equal(Number((f.raw.prepare("SELECT COUNT(*) AS n FROM customer_orders").get() as { n: number }).n), 1);
  } finally {
    f.cleanup();
  }
});

test("allocating moves no stock, money or voucher beyond what the gatepass itself always did", async () => {
  const f = createFixture();
  try {
    const red = f.variant("SK6", "RED", "7");
    const start = untouchables(f);
    await gatepass(f, f.mama, [[red, 5]]);
    const noOrders = untouchables(f);
    saveOrder(f, f.behraam, [[red, 10]]);
    await gatepass(f, f.behraam, [[red, 5]]);
    const withOrders = untouchables(f);
    const step = (a: ReturnType<typeof untouchables>, b: ReturnType<typeof untouchables>) =>
      Object.fromEntries(Object.entries(b).map(([key, value]) => [key, value - a[key as keyof typeof a]]));
    assert.deepEqual(step(noOrders, withOrders), step(start, noOrders), "a gatepass against an order changes stock, bills and cash exactly as one with no order");
    assert.equal(withOrders.cashVouchers, 0);
    assert.equal(withOrders.saleTotal, 0, "no money");
  } finally {
    f.cleanup();
  }
});

test("search by party or article, and every order and allocation travels as its own record", async () => {
  const f = createFixture();
  try {
    saveOrder(f, f.behraam, [[f.variant("SK6", "RED", "7"), 5]]);
    saveOrder(f, f.mama, [[f.variant("SK9", "RED", "7"), 5]]);
    assert.deepEqual(f.db.pendingOrderParties({ search: "mama" }).rows.map((row) => row.partyName), ["MAMA CHAPPAL"]);
    assert.deepEqual(f.db.pendingOrderParties({ search: "sk9" }).rows.map((row) => row.partyName), ["MAMA CHAPPAL"]);
    assert.deepEqual(f.db.pendingOrderParties({ search: "%" }).rows, [], "a typed % is matched as itself");
    await gatepass(f, f.behraam, [[f.variant("SK6", "RED", "7"), 2]]);
    const dirty = (type: string) => Number((f.raw.prepare("SELECT COUNT(DISTINCT record_id) AS n FROM sync_dirty_records WHERE aggregate_type = ?").get(type) as { n: number }).n);
    assert.equal(dirty("CUSTOMER_ORDER"), 2);
    assert.equal(dirty("GATEPASS_ORDER_ALLOCATION"), 1);
  } finally {
    f.cleanup();
  }
});
