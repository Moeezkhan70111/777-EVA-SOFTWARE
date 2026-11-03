import test from "node:test";
import assert from "node:assert/strict";
import { maxNewGatepassQuantity, outstandingQuantity, reflectedStock, splitGatepassLine } from "./gatepassStock.js";

test("reflected stock is current stock minus reserved, and may go negative when over-committed", () => {
  assert.equal(reflectedStock(5, 0), 5);
  assert.equal(reflectedStock(5, 3), 2);
  assert.equal(reflectedStock(5, 4), 1);
  assert.equal(reflectedStock(2, 1), 1);
  assert.equal(reflectedStock(1, 0), 1);
  assert.equal(reflectedStock(2, 3), -1);
});

test("outstanding is requested minus dispatched from store minus issued directly", () => {
  assert.equal(outstandingQuantity(3, 0, 0), 3);
  assert.equal(outstandingQuantity(3, 2, 0), 1);
  assert.equal(outstandingQuantity(3, 3, 0), 0);
  assert.equal(outstandingQuantity(5, 1, 2), 2, "a mixed line: 2 issued directly, 1 scanned, 2 still to scan");
  assert.equal(outstandingQuantity(5, 0, 5), 0, "a line issued whole owes the scanners nothing");
});

test("a new line reserves what QR cartons can cover and issues only the shortfall", () => {
  assert.deepEqual(splitGatepassLine(5, 3), { issueNow: 2, reserved: 3 }, "3 QR + manual cartons: 2 go at once");
  assert.deepEqual(splitGatepassLine(5, 0), { issueNow: 5, reserved: 0 }, "no QR: the whole line goes at once");
  assert.deepEqual(splitGatepassLine(5, 8), { issueNow: 0, reserved: 5 }, "enough QR: today's scan behaviour");
  assert.deepEqual(splitGatepassLine(5, -2), { issueNow: 5, reserved: 0 }, "an over-claimed store has no QR to offer");
});

test("a new gatepass may never ask for more than reflected stock, and never a negative amount", () => {
  assert.equal(maxNewGatepassQuantity(5, 4), 1);
  assert.equal(maxNewGatepassQuantity(5, 5), 0);
  assert.equal(maxNewGatepassQuantity(2, 3), 0);
});
