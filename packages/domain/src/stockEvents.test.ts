import test from "node:test";
import assert from "node:assert/strict";
import { STOCK_EVENT_TYPE, stockEventBalanceDelta } from "./stockEvents.js";

// The two conventions in inventory_stock_events, read by one rule (stockEvents.ts).

test("a scan-out is stored positive and subtracts; a hand move out is stored negative and subtracts the same", () => {
  assert.equal(stockEventBalanceDelta(STOCK_EVENT_TYPE.TRANSFER_OUT, 12.5), -12.5);
  assert.equal(stockEventBalanceDelta(STOCK_EVENT_TYPE.TRANSFER_OUT, -12.5), -12.5);
});

test("a receipt adds, and an adjustment or correction moves the balance by exactly its signed quantity", () => {
  assert.equal(stockEventBalanceDelta(STOCK_EVENT_TYPE.RECEIVE, 40), 40);
  assert.equal(stockEventBalanceDelta(STOCK_EVENT_TYPE.ADJUST, -3), -3);
  assert.equal(stockEventBalanceDelta(STOCK_EVENT_TYPE.ADJUST, 7), 7);
});
