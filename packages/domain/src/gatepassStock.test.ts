import test from "node:test";
import assert from "node:assert/strict";
import { maxNewGatepassQuantity, outstandingQuantity, reflectedStock } from "./gatepassStock.js";

test("reflected stock is current stock minus reserved, and may go negative when over-committed", () => {
  assert.equal(reflectedStock(5, 0), 5);
  assert.equal(reflectedStock(5, 3), 2);
  assert.equal(reflectedStock(5, 4), 1);
  assert.equal(reflectedStock(2, 1), 1);
  assert.equal(reflectedStock(1, 0), 1);
  assert.equal(reflectedStock(2, 3), -1);
});

test("outstanding is requested minus dispatched from store", () => {
  assert.equal(outstandingQuantity(3, 0), 3);
  assert.equal(outstandingQuantity(3, 2), 1);
  assert.equal(outstandingQuantity(3, 3), 0);
});

test("a new gatepass may never ask for more than reflected stock, and never a negative amount", () => {
  assert.equal(maxNewGatepassQuantity(5, 4), 1);
  assert.equal(maxNewGatepassQuantity(5, 5), 0);
  assert.equal(maxNewGatepassQuantity(2, 3), 0);
});
