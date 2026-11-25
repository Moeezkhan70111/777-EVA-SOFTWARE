// The Customer Ledger's period presets: four common ranges ending today, so the dates are picked, not typed
// (Hick's law, recognition over recall). Plain YYYY-MM-DD arithmetic on today's Karachi date: no time zone enters.

export const LEDGER_PERIOD = { MONTH: "MONTH", QUARTER: "QUARTER", YEAR: "YEAR", ALL: "ALL" } as const;
export type LedgerPeriod = (typeof LEDGER_PERIOD)[keyof typeof LEDGER_PERIOD];

/** Before any record the ERP or the old software holds (the oldest archive begins in 2024). */
export const LEDGER_BEGINNING = "2000-01-01";

/**
 * The ledger opens on All time (owner, 24 Nov 2026): the old software's history is part of the customer's ledger,
 * so it is shown from the start.
 */
export const DEFAULT_LEDGER_PERIOD: LedgerPeriod = LEDGER_PERIOD.ALL;

const pad = (value: number) => String(value).padStart(2, "0");

/** The first day of the month `back` months before today's. */
const monthStart = (today: string, back: number): string => {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7)) - back;
  const shifted = year * 12 + (month - 1);
  return `${String(Math.floor(shifted / 12))}-${pad((shifted % 12) + 1)}-01`;
};

export const periodStart = (period: LedgerPeriod, today: string): string => {
  if (period === LEDGER_PERIOD.MONTH) return monthStart(today, 0);
  if (period === LEDGER_PERIOD.QUARTER) return monthStart(today, 2);
  if (period === LEDGER_PERIOD.YEAR) return `${today.slice(0, 4)}-01-01`;
  return LEDGER_BEGINNING;
};

/** Which preset the dates on screen are, or null when they were typed. */
export const periodOf = (fromDate: string, toDate: string, today: string): LedgerPeriod | null => {
  if (toDate !== today) return null;
  return Object.values(LEDGER_PERIOD).find((period) => periodStart(period, today) === fromDate) ?? null;
};
