import test from "node:test";
import assert from "node:assert/strict";
import {
  areValidContractorRates,
  contractorChargeFor,
  hasAnyRate,
  isValidContractorRatePaisa,
  programContractorPricing,
  toPaisa,
} from "./index.js";

// Contractor pricing arithmetic. Every figure here is integer paisa: these tests exist to pin
// down that a piece rate times a fractional dozen never drifts, and that an article nobody has
// priced is never read as an article priced at zero.

const rates = (machine: number, packing: number, printing: number) => ({
  machineRatePaisa: toPaisa(machine),
  packingRatePaisa: toPaisa(packing),
  printingRatePaisa: toPaisa(printing),
});

test("a charge is rate x dozens, per job, in exact paisa", () => {
  const charge = contractorChargeFor(rates(45, 18, 12), 10);
  assert.deepEqual(charge, { machinePaisa: 45000, packingPaisa: 18000, printingPaisa: 12000, totalPaisa: 75000 });
});

test("the three jobs always add up to the total shown under them", () => {
  // 0.5 dozen at 45.55 is 2277.5 paisa — a figure that cannot be held exactly in paisa, so it
  // is rounded ONCE, per job, and the total is the sum of what was shown.
  const charge = contractorChargeFor(rates(45.55, 18.33, 0), 0.5);
  assert.equal(charge.machinePaisa, 2278);
  assert.equal(charge.packingPaisa, 917);
  assert.equal(charge.printingPaisa, 0);
  assert.equal(charge.totalPaisa, charge.machinePaisa + charge.packingPaisa + charge.printingPaisa);
});

test("a rate of zero is a real answer: that job is not paid for this article", () => {
  const charge = contractorChargeFor(rates(45, 18, 0), 10);
  assert.equal(charge.printingPaisa, 0);
  assert.equal(charge.totalPaisa, 63000);
  assert.equal(hasAnyRate(rates(0, 0, 0)), false, "all three at zero is nothing priced");
  assert.equal(hasAnyRate(rates(0, 0, 12)), true, "printing alone is still priced");
});

test("no quantity, no rates, no charge — and never a negative one", () => {
  assert.equal(contractorChargeFor(rates(45, 18, 12), 0).totalPaisa, 0);
  assert.equal(contractorChargeFor(rates(45, 18, 12), -5).totalPaisa, 0);
  assert.equal(contractorChargeFor(null, 10).totalPaisa, 0);
  assert.equal(contractorChargeFor(rates(45, 18, 12), Number.NaN).totalPaisa, 0);
});

test("a rate must be whole paisa, not negative and not absurd", () => {
  assert.equal(isValidContractorRatePaisa(4500), true);
  assert.equal(isValidContractorRatePaisa(0), true);
  assert.equal(isValidContractorRatePaisa(-1), false);
  assert.equal(isValidContractorRatePaisa(45.5), false, "paisa are whole");
  assert.equal(isValidContractorRatePaisa(100_000 * 100 + 1), false);
  assert.equal(areValidContractorRates(rates(45, 18, 12)), true);
  assert.equal(areValidContractorRates({ ...rates(45, 18, 12), packingRatePaisa: -1 }), false);
});

// ─── One program's pricing table ──────────────────────────────────────────────

const run = (articleSizeId: string, article: string, size: string, totalQuantity: number) => ({
  articleSizeId,
  article,
  size,
  totalQuantity,
  unitCode: "DOZEN",
});

test("the same article on two runs is ONE priced row at one rate", () => {
  const pricing = programContractorPricing({
    // SK6 7/10 on a black sole and again on a brown one: two runs, one article.
    runs: [run("as-sk6", "SK6", "7/10", 60), run("as-sk6", "SK6", "7/10", 40), run("as-sk12", "SK12", "1/6", 50)],
    rates: [
      { articleSizeId: "as-sk6", ...rates(45, 18, 12) },
      { articleSizeId: "as-sk12", ...rates(52, 20, 0) },
    ],
  });

  assert.equal(pricing.articles.length, 2);
  const sk6 = pricing.articles[0];
  assert.equal(sk6.quantity, 100, "both runs of the article are one quantity");
  assert.deepEqual(sk6.committed, { machinePaisa: 450000, packingPaisa: 180000, printingPaisa: 120000, totalPaisa: 750000 });

  // 100 DOZEN of SK6 at 75.00 and 50 DOZEN of SK12 at 72.00.
  assert.equal(pricing.committed.totalPaisa, 750000 + 360000);
  assert.equal(pricing.committed.machinePaisa, 450000 + 260000);
  assert.equal(pricing.fullyPriced, true);
  assert.equal(pricing.unpricedArticles, 0);
});

test("an article nobody has priced adds NOTHING and is reported, not treated as free", () => {
  const pricing = programContractorPricing({
    runs: [run("as-sk6", "SK6", "7/10", 100), run("as-sk12", "SK12", "1/6", 50)],
    rates: [{ articleSizeId: "as-sk6", ...rates(45, 18, 12) }],
  });

  const sk12 = pricing.articles.find((article) => article.articleSizeId === "as-sk12");
  assert.equal(sk12?.rates, null, "no rates, not zero rates");
  assert.equal(sk12?.committed, null);
  assert.equal(pricing.unpricedArticles, 1);
  assert.equal(pricing.fullyPriced, false);
  // The total is what IS priced — it never includes a guess at the unpriced article.
  assert.equal(pricing.committed.totalPaisa, 750000);
});

test("a program with nothing on it is not 'fully priced'", () => {
  const pricing = programContractorPricing({ runs: [], rates: [] });
  assert.deepEqual(pricing.articles, []);
  assert.equal(pricing.committed.totalPaisa, 0);
  assert.equal(pricing.fullyPriced, false);
  assert.equal(pricing.unpricedArticles, 0);
});
