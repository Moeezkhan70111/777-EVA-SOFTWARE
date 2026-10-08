import test from "node:test";
import assert from "node:assert/strict";
import {
  addMoney,
  calculateSaleLine,
  discountPerPairFromTotal,
  divideMoney,
  fromPaisa,
  fromPaisaOrNull,
  multiplyMoney,
  roundMoney,
  saleLineTotal,
  subtractMoney,
  toPaisa,
  toPaisaOrNull,
} from "./money.js";

test("paisa conversion is exact and round-trips", () => {
  assert.equal(toPaisa(60000), 6_000_000);
  assert.equal(fromPaisa(6_000_000), 60000);
  assert.equal(toPaisa(0.1), 10);
  assert.equal(toPaisa(Number.NaN), 0);
  assert.equal(roundMoney(1.005), 1.01);
});

test("toPaisaOrNull/fromPaisaOrNull preserve null and undefined instead of inventing 0", () => {
  assert.equal(toPaisaOrNull(650), 65000);
  assert.equal(toPaisaOrNull(240), 24000);
  assert.equal(toPaisaOrNull(null), null);
  assert.equal(toPaisaOrNull(undefined), null);
  assert.equal(fromPaisaOrNull(65000), 650);
  assert.equal(fromPaisaOrNull(null), null);
  assert.equal(fromPaisaOrNull(undefined), null);
  // Round-trip is lossless for whole-rupee values (the only values seen in the live database).
  assert.equal(fromPaisaOrNull(toPaisaOrNull(650)), 650);
  assert.equal(fromPaisaOrNull(toPaisaOrNull(null)), null);
});

test("arithmetic never accumulates floating-point error", () => {
  // 0.1 + 0.2 is 0.30000000000000004 in plain JS.
  assert.equal(addMoney(0.1, 0.2), 0.3);
  assert.equal(subtractMoney(1, 0.9), 0.1);
  assert.equal(multiplyMoney(650, 12), 7800);
  assert.equal(multiplyMoney(7800, 0.5), 3900);
  assert.equal(multiplyMoney(7800, 0.1), 780);
  assert.equal(divideMoney(2880, 12), 240);
  assert.equal(divideMoney(100, 0), 0);
});

test("calculateSaleLine matches the established voucher formula", () => {
  // The PROJECT_CONTEXT example: SK6, qty 0.5 dozen, rate 650, discount 240 per pair.
  const line = calculateSaleLine({ dozens: 0.5, pairRate: 650, pairDiscount: 240 });
  assert.deepEqual(line, {
    cartons: 1,
    pairs: 6,
    dozenRate: 7800,
    amount: 3900,
    dozenDiscount: 2880,
    totalDiscount: 1440,
    total: 2460,
  });
});

test("saleLineTotal and discountPerPairFromTotal are the inverse of calculateSaleLine", () => {
  const line = calculateSaleLine({ dozens: 3, pairRate: 520, pairDiscount: 35 });
  assert.equal(saleLineTotal({ dozens: 3, pairRate: 520, totalDiscount: line.totalDiscount }), line.total);
  assert.equal(discountPerPairFromTotal({ dozens: 3, totalDiscount: line.totalDiscount }), 35);
  assert.equal(discountPerPairFromTotal({ dozens: 0, totalDiscount: 100 }), 0);
});
