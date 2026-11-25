import { toPaisa } from "@erp/domain";
import type { ArchiveEntry } from "../ledgerArchive/archiveReplies";
import { LEDGER_TYPE, type LedgerEntry, type LedgerType } from "./ledgerTypes";

// The Customer Ledger's figures, read from what the main process sent. Nothing here decides a balance: the
// balance is the main process's closingBalance. These only say how it stands and what it is made of.

export const BALANCE_POSITION = { RECEIVABLE: "RECEIVABLE", ADVANCE: "ADVANCE", SETTLED: "SETTLED" } as const;
export type BalancePosition = (typeof BALANCE_POSITION)[keyof typeof BALANCE_POSITION];

/** Positive: the customer owes us. Negative: they paid ahead. */
export const balancePosition = (rupees: number): BalancePosition => {
  if (rupees > 0) return BALANCE_POSITION.RECEIVABLE;
  if (rupees < 0) return BALANCE_POSITION.ADVANCE;
  return BALANCE_POSITION.SETTLED;
};

/** The imported ledger's rows in the period, summed (summarizeArchive). */
export interface ImportedSums {
  rows: number;
  debitPaisa: number;
  creditPaisa: number;
  debitRows: number;
  creditRows: number;
}

export const importedSums = (entries: readonly ArchiveEntry[]): ImportedSums => ({
  rows: entries.length,
  debitPaisa: entries.reduce((sum, entry) => sum + entry.debitPaisa, 0),
  creditPaisa: entries.reduce((sum, entry) => sum + entry.creditPaisa, 0),
  debitRows: entries.filter((entry) => entry.debitPaisa > 0).length,
  creditRows: entries.filter((entry) => entry.creditPaisa > 0).length,
});

export interface PeriodSum {
  broughtForward: number;
  debit: number;
  credit: number;
  debitCount: number;
  creditCount: number;
}

/**
 * The period as one sum, the ERP's entries and the imported ledger's rows together (owner, 25 Nov 2026: "there is no
 * old and new"): brought forward + debit − credit = the main process's closing balance. Brought forward is what the
 * sum leaves before the first row, so it also carries an imported ledger's own opening line. Worked in paisa.
 */
export function periodSum(closingBalance: number, erp: LedgerTotals, imported: ImportedSums): PeriodSum {
  const debitPaisa = toPaisa(erp.debit) + imported.debitPaisa;
  const creditPaisa = toPaisa(erp.credit) + imported.creditPaisa;
  return {
    broughtForward: (toPaisa(closingBalance) - debitPaisa + creditPaisa) / 100,
    debit: debitPaisa / 100,
    credit: creditPaisa / 100,
    debitCount: erp.count.SALE + erp.count.CASH_PAYMENT + erp.count.OPENING_BALANCE + imported.debitRows,
    creditCount: erp.count.CASH_RECEIPT + erp.count.SALE_RETURN + imported.creditRows,
  };
}

export interface LimitUse {
  /** What counts against the limit: what the customer owes. An advance uses none of it. */
  usedRupees: number;
  /** Whole percent, above 100 when over the limit. */
  percent: number;
  /** Left before the limit; negative when over it. */
  leftRupees: number;
}

export const limitUse = (limit: number | null, closingBalance: number): LimitUse | null => {
  if (limit === null || limit <= 0) return null;
  const usedRupees = Math.max(0, closingBalance);
  return { usedRupees, percent: Math.round((usedRupees / limit) * 100), leftRupees: limit - usedRupees };
};

export interface LedgerTotals {
  debit: number;
  credit: number;
  count: Record<LedgerType, number>;
  amount: Record<LedgerType, number>;
}

/** Sums of what is listed, for the period's figures. Amounts are added as paisa so no rupee fraction drifts. */
export function ledgerTotals(entries: readonly LedgerEntry[]): LedgerTotals {
  const zero = (): Record<LedgerType, number> => ({ SALE: 0, SALE_RETURN: 0, CASH_RECEIPT: 0, CASH_PAYMENT: 0, OPENING_BALANCE: 0 });
  const count = zero();
  const amountPaisa = zero();
  let debitPaisa = 0;
  let creditPaisa = 0;
  for (const entry of entries) {
    count[entry.voucherType] += 1;
    amountPaisa[entry.voucherType] += toPaisa(entry.debitAmount) + toPaisa(entry.creditAmount);
    debitPaisa += toPaisa(entry.debitAmount);
    creditPaisa += toPaisa(entry.creditAmount);
  }
  const amount = zero();
  for (const type of Object.values(LEDGER_TYPE)) amount[type] = amountPaisa[type] / 100;
  return { debit: debitPaisa / 100, credit: creditPaisa / 100, count, amount };
}
