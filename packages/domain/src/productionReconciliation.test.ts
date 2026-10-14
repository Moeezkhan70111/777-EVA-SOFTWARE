import test from "node:test";
import assert from "node:assert/strict";
import { compareUpperOutToProduction } from "./productionReconciliation.js";

test("uppers in DOZEN and cartons compare in dozens: 1 dozen of uppers is 2 cartons back", () => {
  const result = compareUpperOutToProduction({ upperOut: [{ unitCode: "DOZEN", quantity: 20 }], receivedCartons: 23 });
  assert.deepEqual(result, { upperDozens: 20, otherUpper: [], receivedDozens: 11.5, comparable: true, differenceDozens: 8.5 });
});

test("an upper counted in another unit is shown, never converted, and there is no difference", () => {
  const result = compareUpperOutToProduction({
    upperOut: [{ unitCode: "DOZEN", quantity: 10 }, { unitCode: "PAIR", quantity: 24 }],
    receivedCartons: 20,
  });
  assert.equal(result.comparable, false);
  assert.equal(result.differenceDozens, null);
  assert.deepEqual(result.otherUpper, [{ unitCode: "PAIR", quantity: 24 }]);
  assert.equal(result.upperDozens, 10);
});

test("either side empty is zero, and the difference can go either way", () => {
  assert.equal(compareUpperOutToProduction({ upperOut: [], receivedCartons: 0 }).differenceDozens, 0);
  assert.equal(compareUpperOutToProduction({ upperOut: [], receivedCartons: 6 }).differenceDozens, -3);
  assert.equal(compareUpperOutToProduction({ upperOut: [{ unitCode: "dozen", quantity: 5 }], receivedCartons: 0 }).differenceDozens, 5);
});
