import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTRACTOR_PAYMENT_KIND,
  CONTRACTOR_ROLE,
  RATE_SOURCE,
  businessDateOf,
  buildContractorLedger,
  groupContractorWork,
  toPaisa,
  type ContractorPaymentKind,
  type ContractorWorkCarton,
} from "./index.js";

// The Contractor Ledger's arithmetic: cartons → dozens → rate × dozens, grouped by the business
// day they came in, and a running balance against what was paid.

const carton = (receivedAt: string, overrides: Partial<ContractorWorkCarton> = {}): ContractorWorkCarton => ({
  receivedAt,
  programId: "p1",
  programCode: "MP-000011",
  machineName: "MACHINE 1",
  role: CONTRACTOR_ROLE.MACHINE,
  articleSizeId: "sk6",
  article: "SK6",
  size: "7/10",
  ratePaisa: toPaisa(70),
  rateSource: RATE_SOURCE.PROGRAM,
  ...overrides,
});

const cartons = (count: number, receivedAt: string, overrides: Partial<ContractorWorkCarton> = {}) =>
  Array.from({ length: count }, () => carton(receivedAt, overrides));

test("10 DOZEN at Rs 70 the dozen is Rs 700 — two cartons to the dozen", () => {
  const [day] = groupContractorWork(cartons(20, "2026-10-12T06:00:00.000Z"));
  assert.equal(day.date, "2026-10-12");
  assert.equal(day.cartons, 20);
  assert.equal(day.dozens, 10);
  assert.equal(day.amountPaisa, toPaisa(700));
  assert.equal(day.lines.length, 1);
  assert.equal(day.lines[0].dozens, 10);
});

test("a half dozen is paid as half a dozen, rounded to the paisa once", () => {
  const [day] = groupContractorWork(cartons(1, "2026-10-12T06:00:00.000Z", { ratePaisa: toPaisa(45.55) }));
  assert.equal(day.dozens, 0.5);
  assert.equal(day.amountPaisa, 2278, "4555 × 0.5 = 2277.5 → 2278");
});

test("work is dated by the day in Pakistan, not the UTC date", () => {
  // 20:30 UTC on the 12th is 01:30 on the 13th in Karachi.
  assert.equal(businessDateOf("2026-10-12T20:30:00.000Z"), "2026-10-13");
  assert.equal(businessDateOf("2026-10-12T18:30:00.000Z"), "2026-10-12");
  assert.equal(businessDateOf("2026-10-12T23:30:00.000"), "2026-10-12", "a zone-less timestamp is already local");
});

test("one line per program, job and article; days come oldest first", () => {
  const days = groupContractorWork([
    ...cartons(4, "2026-10-13T06:00:00.000Z"),
    ...cartons(2, "2026-10-12T06:00:00.000Z", { articleSizeId: "sk12", article: "SK12", size: "1/6", ratePaisa: toPaisa(52) }),
    ...cartons(2, "2026-10-12T07:00:00.000Z"),
  ]);
  assert.deepEqual(days.map((day) => day.date), ["2026-10-12", "2026-10-13"]);
  assert.deepEqual(days[0].lines.map((line) => [line.article, line.dozens, line.amountPaisa]), [
    ["SK12", 1, 5200],
    ["SK6", 1, 7000],
  ]);
  assert.equal(days[0].amountPaisa, 12200);
});

test("work with no rate is shown and counted in dozens, but adds nothing", () => {
  const [day] = groupContractorWork([
    ...cartons(4, "2026-10-12T06:00:00.000Z"),
    ...cartons(6, "2026-10-12T06:00:00.000Z", { articleSizeId: "x", article: "X1", ratePaisa: null, rateSource: null }),
  ]);
  assert.equal(day.dozens, 5);
  assert.equal(day.unpricedDozens, 3);
  assert.equal(day.amountPaisa, toPaisa(140), "only the priced 2 DOZEN × 70");
});

test("a stored rate of 0 is priced — that job is just not paid", () => {
  const [day] = groupContractorWork(cartons(2, "2026-10-12T06:00:00.000Z", { ratePaisa: 0 }));
  assert.equal(day.amountPaisa, 0);
  assert.equal(day.unpricedDozens, 0);
});

test("the ledger: work is a credit, a payment a debit, with a running balance and an opening balance", () => {
  const work = groupContractorWork([
    ...cartons(20, "2026-09-30T06:00:00.000Z"), // before the period: 700
    ...cartons(20, "2026-10-12T06:00:00.000Z"), // 700
    ...cartons(10, "2026-10-14T06:00:00.000Z"), // 350
  ]);
  const payment = (date: string, rupees: number, kind: ContractorPaymentKind = CONTRACTOR_PAYMENT_KIND.PAYMENT) => ({
    date, voucherId: date, voucherNumber: `CV-${date}`, description: "", modeOfTransfer: "Cash", kind, amountPaisa: toPaisa(rupees),
  });
  const ledger = buildContractorLedger({
    work,
    payments: [payment("2026-10-01", 200), payment("2026-10-12", 500), payment("2026-10-20", 50, CONTRACTOR_PAYMENT_KIND.RECEIPT)],
    fromDate: "2026-10-01",
    toDate: "2026-10-31",
  });

  assert.equal(ledger.openingBalancePaisa, toPaisa(700));
  // Same day: the work comes before the payment against it.
  assert.deepEqual(ledger.entries.map((entry) => [entry.date, entry.kind, entry.balancePaisa]), [
    ["2026-10-01", "PAYMENT", toPaisa(500)],
    ["2026-10-12", "WORK", toPaisa(1200)],
    ["2026-10-12", "PAYMENT", toPaisa(700)],
    ["2026-10-14", "WORK", toPaisa(1050)],
    ["2026-10-20", "RECEIPT", toPaisa(1100)],
  ]);
  assert.equal(ledger.closingBalancePaisa, toPaisa(1100));
  assert.equal(ledger.earnedPaisa, toPaisa(1050));
  assert.equal(ledger.paidPaisa, toPaisa(650), "700 paid less 50 returned");
  assert.equal(ledger.totalCreditPaisa, toPaisa(1100), "the Cr column: 1050 work + 50 returned");
  assert.equal(ledger.totalDebitPaisa, toPaisa(700));
  assert.equal(ledger.dozens, 15);
});

test("a claim for damaged uppers is deducted from what is owed, and is not counted as paid", () => {
  const claim = { date: "2026-10-15", voucherId: "c1", voucherNumber: "CL-000001", description: "1 pair torn", modeOfTransfer: null, kind: CONTRACTOR_PAYMENT_KIND.CLAIM, amountPaisa: toPaisa(50) };
  const pay = { ...claim, voucherId: "p1", voucherNumber: "CV-1", kind: CONTRACTOR_PAYMENT_KIND.PAYMENT, amountPaisa: toPaisa(100), date: "2026-10-15" };
  const ledger = buildContractorLedger({ work: [], payments: [claim, pay], fromDate: "2026-10-01", toDate: "2026-10-31" });

  assert.deepEqual(ledger.entries.map((entry) => [entry.kind, entry.debitPaisa, entry.balancePaisa]), [
    ["PAYMENT", toPaisa(100), toPaisa(-100)],
    ["CLAIM", toPaisa(50), toPaisa(-150)],
  ]);
  assert.equal(ledger.paidPaisa, toPaisa(100));
  assert.equal(ledger.claimedPaisa, toPaisa(50));
});
