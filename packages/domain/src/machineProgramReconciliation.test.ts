import test from "node:test";
import assert from "node:assert/strict";
import { reconciliationEntryProblem, shortfallUppers, type ReconciliationEntry } from "./machineProgramReconciliation.js";

const entry = (overrides: Partial<ReconciliationEntry> = {}): ReconciliationEntry => ({
  cutSize: 0,
  wastage: 0,
  wastagePartyId: null,
  wastageReason: "",
  lost: 0,
  lostParty: null,
  lostReason: "",
  ...overrides,
});

test("one carton short is six uppers to account for; nothing short is none", () => {
  assert.equal(shortfallUppers(8, 7), 6);
  assert.equal(shortfallUppers(8, 8), 0);
  assert.equal(shortfallUppers(8, 9), 0, "more back than due never makes a negative shortfall");
});

test("the three ways must add up to the shortfall exactly", () => {
  assert.equal(reconciliationEntryProblem(6, entry({ cutSize: 4, wastage: 1, wastagePartyId: "s", wastageReason: "torn", lost: 1, lostParty: "PACKING", lostReason: "missing" })), null);
  assert.match(reconciliationEntryProblem(6, entry({ cutSize: 4 })) ?? "", /2 of the 6 missing uppers/);
  assert.match(reconciliationEntryProblem(6, entry({ cutSize: 7 })) ?? "", /only 6 are missing/);
  assert.match(reconciliationEntryProblem(6, entry({ cutSize: 5.5, lost: 0.5 })) ?? "", /whole numbers/);
});

test("a claim needs its party and its reason", () => {
  assert.match(reconciliationEntryProblem(6, entry({ wastage: 6, wastageReason: "torn" })) ?? "", /supplier/);
  assert.match(reconciliationEntryProblem(6, entry({ wastage: 6, wastagePartyId: "s" })) ?? "", /why the uppers were wasted/);
  assert.match(reconciliationEntryProblem(6, entry({ lost: 6, lostReason: "gone" })) ?? "", /machine or the packing/);
  assert.match(reconciliationEntryProblem(6, entry({ lost: 6, lostParty: "MACHINE", lostReason: "  " })) ?? "", /how the uppers were lost/);
  assert.equal(reconciliationEntryProblem(6, entry({ cutSize: 6 })), null, "cut size alone needs no claim");
});
