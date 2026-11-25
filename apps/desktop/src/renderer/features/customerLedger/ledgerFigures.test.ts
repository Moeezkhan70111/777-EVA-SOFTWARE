import { describe, expect, it } from "vitest";
import { balancePosition, periodSum, ledgerTotals, limitUse } from "./ledgerFigures";
import { periodOf, periodStart } from "./ledgerPeriods";
import type { LedgerEntry } from "./ledgerTypes";

describe("periodSum: one ledger, imported rows and ERP entries together (owner, 25 Nov 2026)", () => {
  const erp = (debit: number, credit: number) => ledgerTotals([
    ...(debit ? [{ voucherType: "SALE", debitAmount: debit, creditAmount: 0 }] : []),
    ...(credit ? [{ voucherType: "CASH_RECEIPT", debitAmount: 0, creditAmount: credit }] : []),
  ] as LedgerEntry[]);

  it("adds up to the closing balance: imported 35,000 + a 5,000 bill = 40,000", () => {
    const imported = { rows: 2, debitPaisa: 50_000_00, creditPaisa: 15_000_00, debitRows: 1, creditRows: 1 };
    expect(periodSum(40_000, erp(5_000, 0), imported)).toEqual({ broughtForward: 0, debit: 55_000, credit: 15_000, debitCount: 2, creditCount: 1 });
  });

  it("an imported ledger opening on a printed balance brings it forward", () => {
    const imported = { rows: 1, debitPaisa: 0, creditPaisa: 0, debitRows: 0, creditRows: 0 };
    expect(periodSum(200_000, erp(0, 0), imported).broughtForward).toBe(200_000);
  });
});

describe("the ledger's other figures", () => {
  it("counts only what is owed against the limit", () => {
    expect(limitUse(500_000, 350_000)).toEqual({ usedRupees: 350_000, percent: 70, leftRupees: 150_000 });
    expect(limitUse(100_000, 120_000)).toEqual({ usedRupees: 120_000, percent: 120, leftRupees: -20_000 });
    expect(limitUse(100_000, -5_000)).toEqual({ usedRupees: 0, percent: 0, leftRupees: 100_000 });
    expect(limitUse(null, 1)).toBeNull();
  });

  it("names the position in words", () => {
    expect([balancePosition(1), balancePosition(-1), balancePosition(0)]).toEqual(["RECEIVABLE", "ADVANCE", "SETTLED"]);
  });

  it("adds what is listed by type, returns included, without rupee fractions drifting", () => {
    const entry = (voucherType: LedgerEntry["voucherType"], debitAmount: number, creditAmount: number): LedgerEntry => ({ voucherId: voucherType, voucherNumber: "1", voucherDate: "2026-11-24", voucherType, description: "", debitAmount, creditAmount, balance: 0 });
    const totals = ledgerTotals([entry("SALE", 0.1, 0), entry("SALE", 0.2, 0), entry("SALE_RETURN", 0, 50), entry("CASH_RECEIPT", 0, 100)]);
    expect(totals.debit).toBe(0.3);
    expect(totals.credit).toBe(150);
    expect(totals.count).toMatchObject({ SALE: 2, SALE_RETURN: 1, CASH_RECEIPT: 1, CASH_PAYMENT: 0 });
    expect(totals.amount.SALE).toBe(0.3);
  });
});

describe("period presets", () => {
  it("starts each preset on the right day, across a year end", () => {
    expect(periodStart("MONTH", "2026-11-24")).toBe("2026-11-01");
    expect(periodStart("QUARTER", "2026-11-24")).toBe("2026-09-01");
    expect(periodStart("QUARTER", "2026-01-15")).toBe("2025-11-01");
    expect(periodStart("YEAR", "2026-11-24")).toBe("2026-01-01");
    expect(periodStart("ALL", "2026-11-24")).toBe("2000-01-01");
  });

  it("recognises a preset only when the period ends today", () => {
    expect(periodOf("2026-09-01", "2026-11-24", "2026-11-24")).toBe("QUARTER");
    expect(periodOf("2026-09-01", "2026-11-20", "2026-11-24")).toBeNull();
    expect(periodOf("2026-09-02", "2026-11-24", "2026-11-24")).toBeNull();
  });
});
