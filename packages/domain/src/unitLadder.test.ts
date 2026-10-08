import test from "node:test";
import assert from "node:assert/strict";
import {
  baseToCompound,
  quantityInBaseUnit,
  compoundToBase,
  describeCompound,
  describeLadderStep,
  ladderBaseUnit,
  ladderMultipliers,
  ladderProblems,
  ladderUnits,
  type UnitLadderStep,
} from "./unitLadder.js";

// The real case this was built for: NAWAAR — 5 SOOTAR — BLACK — NAAKI SOOTI.
// A roll is 975 metres, and the shop floor measures a metre as 40 inches.
const NAWAAR: UnitLadderStep[] = [
  { fromUnit: "ROLL", toUnit: "METRE", factor: 975 },
  { fromUnit: "METRE", toUnit: "INCH", factor: 40 },
];

test("the ladder runs biggest to smallest, and stock is held in the bottom unit", () => {
  assert.deepEqual(ladderUnits(NAWAAR), ["ROLL", "METRE", "INCH"]);
  assert.equal(ladderBaseUnit(NAWAAR), "INCH");
  assert.deepEqual(ladderUnits([]), []);
  assert.equal(ladderBaseUnit([]), null);
});

test("one of each unit is worth the product of everything below it", () => {
  const worth = ladderMultipliers(NAWAAR);
  assert.equal(worth.get("INCH"), 1);
  assert.equal(worth.get("METRE"), 40);
  assert.equal(worth.get("ROLL"), 39_000, "975 metres of 40 inches");
});

test("62 rolls is 2,418,000 inches", () => {
  assert.equal(compoundToBase(NAWAAR, [{ unit: "ROLL", quantity: 62 }]), 2_418_000);
});

test("a compound count adds up — 2 ROLL and 37 INCH", () => {
  const total = compoundToBase(NAWAAR, [
    { unit: "ROLL", quantity: 2 },
    { unit: "INCH", quantity: 37 },
  ]);
  assert.equal(total, 78_037);
});

test("a count can be typed in any unit on the ladder", () => {
  assert.equal(compoundToBase(NAWAAR, [{ unit: "METRE", quantity: 975 }]), 39_000);
  assert.equal(compoundToBase(NAWAAR, [{ unit: "INCH", quantity: 39_000 }]), 39_000);
});

test("a unit that is not on this material's ladder counts for nothing", () => {
  assert.equal(compoundToBase(NAWAAR, [{ unit: "DOZEN", quantity: 5 }]), 0);
});

test("a total breaks back down the ladder, and comes back the same", () => {
  const parts = baseToCompound(NAWAAR, 78_037);
  assert.deepEqual(parts, [
    { unit: "ROLL", quantity: 2 },
    { unit: "METRE", quantity: 0 },
    { unit: "INCH", quantity: 37 },
  ]);
  assert.equal(compoundToBase(NAWAAR, parts), 78_037);
});

test("the remainder sits on the base unit, never half a roll", () => {
  const parts = baseToCompound(NAWAAR, 39_041);
  assert.deepEqual(parts, [
    { unit: "ROLL", quantity: 1 },
    { unit: "METRE", quantity: 1 },
    { unit: "INCH", quantity: 1 },
  ]);
});

test("taking stock away keeps its sign on every rung", () => {
  assert.deepEqual(baseToCompound(NAWAAR, -78_037), [
    { unit: "ROLL", quantity: -2 },
    { unit: "METRE", quantity: -0 },
    { unit: "INCH", quantity: -37 },
  ]);
  assert.equal(compoundToBase(NAWAAR, baseToCompound(NAWAAR, -78_037)), -78_037);
});

test("it reads the way the store says it", () => {
  assert.equal(describeCompound(baseToCompound(NAWAAR, 78_037)), "2 ROLL 37 INCH");
  assert.equal(describeCompound(baseToCompound(NAWAAR, 2_418_000)), "62 ROLL");
  assert.equal(describeCompound(baseToCompound(NAWAAR, 0)), "0 INCH");
  assert.equal(describeLadderStep(NAWAAR[0]!), "1 ROLL = 975 METRE");
});

// The owner's case: a nawaar counted in RULE, where one rule is 975 inches of it. The shelf
// holds 16 rules, and the total quantity is 15,600 inches.
test("a balance is also said in the smallest unit on the ladder", () => {
  const SIMPLE = [{ fromUnit: "RULE", toUnit: "INCH", factor: 975 }];
  assert.deepEqual(quantityInBaseUnit(SIMPLE, "RULE", 16), { quantity: 15_600, unit: "INCH" });

  // Another nawaar whose rule is twice as long.
  const LONGER = [{ fromUnit: "RULE", toUnit: "INCH", factor: 1950 }];
  assert.deepEqual(quantityInBaseUnit(LONGER, "RULE", 16), { quantity: 31_200, unit: "INCH" });

  // A longer chain works the same way: 2 ROLL of the NAWAAR ladder.
  assert.deepEqual(quantityInBaseUnit(NAWAAR, "ROLL", 2), { quantity: 78_000, unit: "INCH" });
  assert.deepEqual(quantityInBaseUnit(NAWAAR, "METRE", 3), { quantity: 120, unit: "INCH" });
});

test("there is no total to show when the ladder cannot say it", () => {
  assert.equal(quantityInBaseUnit([], "RULE", 16), null, "no ladder");
  assert.equal(quantityInBaseUnit(NAWAAR, "INCH", 16), null, "already the smallest unit");
  assert.equal(quantityInBaseUnit(NAWAAR, "DOZEN", 16), null, "a unit that is not on the ladder");
});

test("a sound ladder has nothing against it; a broken chain says where it breaks", () => {
  assert.deepEqual(ladderProblems(NAWAAR), []);
  assert.deepEqual(ladderProblems([]), [], "a material need not have a ladder at all");

  const broken = ladderProblems([
    { fromUnit: "ROLL", toUnit: "METRE", factor: 975 },
    { fromUnit: "YARD", toUnit: "INCH", factor: 36 },
  ]);
  assert.equal(broken.some((problem) => /starts at YARD, but step 1 ended at METRE/.test(problem)), true);
});

test("a rung needs two different units and a number above zero", () => {
  assert.equal(ladderProblems([{ fromUnit: "ROLL", toUnit: "ROLL", factor: 2 }]).some((p) => /into itself/.test(p)), true);
  assert.equal(ladderProblems([{ fromUnit: "ROLL", toUnit: "METRE", factor: 0 }]).some((p) => /greater than zero/.test(p)), true);
  assert.equal(ladderProblems([{ fromUnit: "", toUnit: "METRE", factor: 2 }]).some((p) => /needs both units/.test(p)), true);
});

test("a ladder cannot loop back on itself", () => {
  const looped = ladderProblems([
    { fromUnit: "ROLL", toUnit: "METRE", factor: 975 },
    { fromUnit: "METRE", toUnit: "ROLL", factor: 40 },
  ]);
  assert.equal(looped.some((problem) => /appears twice/.test(problem)), true);
});
