import test from "node:test";
import assert from "node:assert/strict";
import {
  CLAIM_PARTY_ROLE,
  accountedPairs,
  claimAmountPaisa,
  shortfallUppers,
  upperBConversionProblem,
  upperReconciliationProblem,
  type UpperClaim,
  type UpperReconciliation,
} from "./machineProgramReconciliation.js";

// Reconciling an upper line: the cartons that did not come back, as pairs, and every pair given
// exactly one fate — cut size upper, cut size pairs, or a claim at an amount against a party.

const claim = (overrides: Partial<UpperClaim> = {}): UpperClaim => ({
  role: CLAIM_PARTY_ROLE.SUPPLIER,
  supplierPartyId: "s-1",
  pairs: 1,
  ratePaisa: 5_000,
  reason: "torn upper",
  ...overrides,
});

const entry = (overrides: Partial<UpperReconciliation> = {}): UpperReconciliation => ({
  cutSizeUppers: 0,
  cutSizePairs: 0,
  claims: [],
  ...overrides,
});

test("one carton short is six pairs to account for; nothing short is none", () => {
  assert.equal(shortfallUppers(8, 7), 6);
  assert.equal(shortfallUppers(8, 8), 0);
  assert.equal(shortfallUppers(8, 9), 0, "more back than due never makes a negative shortfall");
  // The owner's case: 12 cartons due, 6 back, then a 2-DOZEN packet returned (4 cartons fewer due).
  assert.equal(shortfallUppers(12, 6), 36);
  assert.equal(shortfallUppers(12 - 4, 6), 12);
});

test("the ways must add up to the remaining pairs exactly", () => {
  // 7 pairs left after a B carton: 5 cut size pairs + 1 cut size upper + 1 claimed.
  const sound = entry({ cutSizePairs: 5, cutSizeUppers: 1, claims: [claim()] });
  assert.equal(accountedPairs(sound), 7);
  assert.equal(upperReconciliationProblem(7, sound), null);
  assert.match(upperReconciliationProblem(12, entry({ cutSizePairs: 5, claims: [claim()] })) ?? "", /6 of the 12 remaining pairs/);
  assert.match(upperReconciliationProblem(6, entry({ cutSizePairs: 7 })) ?? "", /only 6 remain/);
  assert.match(upperReconciliationProblem(6, entry({ cutSizePairs: 5.5 })) ?? "", /whole numbers/);
  assert.match(upperReconciliationProblem(6, entry({ cutSizeUppers: -1, cutSizePairs: 7 })) ?? "", /whole numbers/);
});

test("a claim needs its party, a whole number of pairs, an amount and a reason", () => {
  const problem = (overrides: Partial<UpperClaim>) => upperReconciliationProblem(1, entry({ claims: [claim(overrides)] }));
  assert.equal(problem({}), null);
  assert.match(problem({ supplierPartyId: null }) ?? "", /supplier/);
  assert.equal(problem({ role: CLAIM_PARTY_ROLE.PACKING, supplierPartyId: null }), null, "a contractor is the program's own");
  assert.match(problem({ pairs: 0 }) ?? "", /whole pairs/);
  assert.match(problem({ pairs: 0.5 }) ?? "", /whole pairs/);
  assert.match(problem({ ratePaisa: 0 }) ?? "", /amount/);
  assert.match(problem({ ratePaisa: 12.5 }) ?? "", /amount/);
  assert.match(problem({ reason: "  " }) ?? "", /reason/);
});

test("a claim's amount is pairs × the amount a pair, exactly", () => {
  assert.equal(claimAmountPaisa({ pairs: 3, ratePaisa: 4_550 }), 13_650);
});

test("B cartons stand for whole missing cartons, never more than are missing", () => {
  assert.equal(upperBConversionProblem(1, 2), null);
  assert.match(upperBConversionProblem(3, 2) ?? "", /at most 2/);
  assert.match(upperBConversionProblem(0, 2) ?? "", /at least 1/);
  assert.match(upperBConversionProblem(1.5, 2) ?? "", /whole number/);
  assert.match(upperBConversionProblem(1, 0) ?? "", /nothing to make B/);
});
