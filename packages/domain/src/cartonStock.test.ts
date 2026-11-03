import test from "node:test";
import assert from "node:assert/strict";
import { CARTON_STOCK_EVENT_TYPE, cartonStockDelta, isCartonStockEventType } from "./cartonStock.js";

test("production and a cancel put cartons in; a gatepass and a void take them out", () => {
  assert.equal(cartonStockDelta(CARTON_STOCK_EVENT_TYPE.MANUAL_PRODUCE, 20), 20);
  assert.equal(cartonStockDelta(CARTON_STOCK_EVENT_TYPE.GATEPASS_CANCEL, 5), 5);
  assert.equal(cartonStockDelta(CARTON_STOCK_EVENT_TYPE.GATEPASS_ISSUE, 5), -5);
  assert.equal(cartonStockDelta(CARTON_STOCK_EVENT_TYPE.MANUAL_PRODUCTION_VOID, 20), -20);
});

test("only the four movements are carton stock movements", () => {
  for (const type of Object.values(CARTON_STOCK_EVENT_TYPE)) assert.ok(isCartonStockEventType(type));
  for (const other of ["RECEIVE", "MANUAL_PRODUCTION", "", null, 3]) assert.equal(isCartonStockEventType(other), false);
});
