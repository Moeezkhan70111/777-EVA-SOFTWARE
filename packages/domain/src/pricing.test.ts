import test from "node:test";
import assert from "node:assert/strict";
import { computeBTypePrice } from "./pricing.js";

test("computeBTypePrice: known rule matrix", () => {
  const cases: Array<[number, number]> = [
    [400, 250], [500, 350], [501, 331], [550, 380], [599, 429], [600, 400], [630, 430],
  ];
  for (const [normal, expected] of cases) {
    const result = computeBTypePrice(normal);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.price, expected);
  }
});

test("computeBTypePrice: null/undefined not calculable", () => {
  assert.equal(computeBTypePrice(null).ok, false);
  assert.equal(computeBTypePrice(undefined).ok, false);
});

test("computeBTypePrice: non-finite not calculable", () => {
  assert.equal(computeBTypePrice(NaN).ok, false);
  assert.equal(computeBTypePrice(Infinity).ok, false);
  assert.equal(computeBTypePrice(-Infinity).ok, false);
});

test("computeBTypePrice: zero and negative not calculable", () => {
  assert.equal(computeBTypePrice(0).ok, false);
  assert.equal(computeBTypePrice(-50).ok, false);
});
