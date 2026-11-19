import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ORDER_PROGRESS,
  allocateFifo,
  formatCustomerOrderCode,
  orderProgressOf,
  orderQuantityProblem,
  pendingOrderQuantity,
} from "./customerOrder.js";

test("an order's code is ORD- and six digits", () => {
  assert.equal(formatCustomerOrderCode(14), "ORD-000014");
  assert.equal(formatCustomerOrderCode(200001), "ORD-200001");
});

test("pending is ordered less dispatched, and never below zero", () => {
  assert.equal(pendingOrderQuantity(20, 5), 15);
  assert.equal(pendingOrderQuantity(20, 20), 0);
  assert.equal(pendingOrderQuantity(20, 25), 0);
});

test("progress: pending, partly dispatched, dispatched", () => {
  assert.equal(orderProgressOf(10, 0), ORDER_PROGRESS.PENDING);
  assert.equal(orderProgressOf(10, 4), ORDER_PROGRESS.PARTIAL);
  assert.equal(orderProgressOf(10, 10), ORDER_PROGRESS.DISPATCHED);
});

test("a typed quantity must be a whole number of cartons above 0; an empty box is no line", () => {
  assert.equal(orderQuantityProblem(""), null);
  assert.equal(orderQuantityProblem(" 12 "), null);
  assert.ok(orderQuantityProblem("0"));
  assert.ok(orderQuantityProblem("-3"));
  assert.ok(orderQuantityProblem("2.5"));
  assert.ok(orderQuantityProblem("abc"));
  assert.ok(orderQuantityProblem("100001"));
});

test("FIFO: the oldest order line is covered first, each up to what it still owes", () => {
  const result = allocateFifo(25, [
    { orderLineId: "old", pending: 10 },
    { orderLineId: "middle", pending: 10 },
    { orderLineId: "new", pending: 10 },
  ]);
  assert.deepEqual(result.shares, [
    { orderLineId: "old", quantity: 10 },
    { orderLineId: "middle", quantity: 10 },
    { orderLineId: "new", quantity: 5 },
  ]);
  assert.equal(result.unallocated, 0);
});

test("a partial dispatch takes from the oldest line only", () => {
  const result = allocateFifo(4, [{ orderLineId: "old", pending: 10 }, { orderLineId: "new", pending: 10 }]);
  assert.deepEqual(result.shares, [{ orderLineId: "old", quantity: 4 }]);
  assert.equal(result.unallocated, 0);
});

test("over-dispatch: what no line is owed stays unallocated, and no line is given more than it owes", () => {
  const result = allocateFifo(30, [{ orderLineId: "a", pending: 10 }, { orderLineId: "b", pending: 5 }]);
  assert.deepEqual(result.shares, [{ orderLineId: "a", quantity: 10 }, { orderLineId: "b", quantity: 5 }]);
  assert.equal(result.unallocated, 15);
});

test("a line owed nothing is skipped; nothing is allocated with no candidates", () => {
  assert.deepEqual(allocateFifo(5, [{ orderLineId: "done", pending: 0 }, { orderLineId: "open", pending: 3 }]).shares, [{ orderLineId: "open", quantity: 3 }]);
  assert.deepEqual(allocateFifo(5, []), { shares: [], unallocated: 5 });
  assert.deepEqual(allocateFifo(0, [{ orderLineId: "a", pending: 3 }]), { shares: [], unallocated: 0 });
});

test("a dispatched quantity must be a whole number, 0 or more", () => {
  assert.throws(() => allocateFifo(-1, []), RangeError);
  assert.throws(() => allocateFifo(1.5, []), RangeError);
});
