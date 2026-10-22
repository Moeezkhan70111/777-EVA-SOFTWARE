import { APP_TIMEZONE } from "./constants.js";
import { jobChargePaisa } from "./contractorPricing.js";
import { cartonsToDozens } from "./units.js";

// Contractor Ledger — what a contractor earned for the work a machine program produced, and what
// they were paid against it.
//
//   12 Oct   Work   MP-000011 · SK6 7/10   10 DZN × Rs 70.00 = Rs 700.00     Cr 700.00   Bal 700.00
//   14 Oct   Paid   CV-000045 cash                                           Dr 500.00   Bal 200.00
//
// WHAT COUNTS AS WORK: a carton printed for a machine program and stored in by Store In. That is
// the program's production (docs/27, machine_program_carton_labels), dated by the day it came in.
// Two cartons are one dozen, and every rate is per dozen. A B CARTON IS NOT WORK: no contractor is
// paid for one (owner, 2026-10-12), so B labels (EVR FIX, MIX, migration 074) never reach a ledger.
//
// WHO EARNS IT: the contractors the program was made with — its machine contractor earns the
// machine rate, its packing contractor the packing rate. Printing has no contractor yet, so its
// work is kept under one "Printing Contractor" ledger until one exists.
//
// THE RATE: what THIS program agreed for the article (machine_program_article_rates), or — when the
// program was never priced — the product's standard rate. Which one was used is carried on every
// line, so nobody has to guess. With neither, the line is NOT PRICED: it is shown, counted in
// dozens, and adds nothing — never silently treated as free work.
//
// Nothing here is stored: the ledger is worked out from the cartons, the rates and the cash
// vouchers every time it is read, so it can never disagree with them. Money is integer paisa.

export const CONTRACTOR_ROLE = {
  MACHINE: "MACHINE",
  PACKING: "PACKING",
  PRINTING: "PRINTING",
} as const;
export type ContractorRole = (typeof CONTRACTOR_ROLE)[keyof typeof CONTRACTOR_ROLE];

/** The one ledger printing work is kept under until a printing contractor exists. */
export const PRINTING_CONTRACTOR_ACCOUNT_ID = "PRINTING";

export const RATE_SOURCE = {
  /** What the machine program agreed for this article. */
  PROGRAM: "PROGRAM",
  /** The product's standard rate — the program itself was never priced for the article. */
  PRODUCT: "PRODUCT",
} as const;
export type RateSource = (typeof RATE_SOURCE)[keyof typeof RATE_SOURCE];

/**
 * `YYYY-MM-DD` of a timestamp in the business timezone (Asia/Karachi).
 * A zone-less local timestamp is already business-local, so its own date is used.
 */
export const businessDateOf = (timestamp: string): string => {
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp);
  if (!zoned) return timestamp.slice(0, 10);
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp.slice(0, 10);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: APP_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
};

/**
 * TODAY, as the company reckons it: the `YYYY-MM-DD` Karachi calendar date.
 *
 * USE THIS FOR EVERY DATE-ONLY DEFAULT. Never `new Date().toISOString().slice(0, 10)`, which is
 * the UTC date -- and Karachi is UTC+5, so for the five hours after local midnight the UTC date
 * is still YESTERDAY. The factory works those hours; the operational day runs 06:00 to 06:00.
 *
 * Six places got this wrong, found 2026-10-23 at 00:50 Karachi while the window was open:
 *
 *   * listSupplierBalances and listCustomerBalances defaulted `asOfDate` to the UTC date, and
 *     every filter is `voucher_date <= asOfDate`. Between 00:00 and 05:00 every voucher, payment
 *     and claim dated today was silently excluded -- a supplier balance read 0 where the ledger
 *     said -50, with no error anywhere and both numbers looking real.
 *
 *   * getCustomerLedger defaulted its `toDate` the same way, so the newest entries vanished.
 *
 *   * The purchase and sale voucher handlers STAMPED a new voucher with it, filing work entered
 *     at 01:00 under the previous day, permanently, and feeding the ledgers that way. Those two
 *     wrote wrong data rather than merely showing it.
 *
 *   * The daily-login check compared a stored login_date against it.
 *
 * NOT THE OPERATIONAL DAY. This rolls at MIDNIGHT and answers "what would a person in Karachi
 * write on this voucher". `operationalDayBounds` (units.ts) is the production shift, 06:00 to
 * 06:00, and answers "which shift made this". A carton produced at 01:00 belongs to the shift
 * that began the previous morning, but a voucher written at 01:00 is dated today. Mixing the two
 * is how the above happened.
 */
export const businessToday = (): string => businessDateOf(new Date().toISOString());

/**
 * The hour (0-23) of a timestamp in the business timezone (Asia/Karachi).
 *
 * WHY THIS EXISTS. `new Date(t).getHours()` is the HOST computer's hour, so two machines in
 * different Windows timezones record different hours for the same instant and their hourly
 * production breakdowns stop being comparable -- including after one pulls the other's events.
 * The hour a factory means is the hour on its own clock, which is this.
 *
 * Zone-less input follows businessDateOf: a local timestamp is already business-local, so its
 * own hour is used. An unparseable one yields NaN rather than a quietly wrong number, because
 * a stored hour nobody can trust is worse than one that fails a check constraint loudly.
 *
 * hourCycle "h23" is required: with the default, midnight formats as 24 in some ICU builds,
 * and 24 would fail the cloud's `check (event_hour between 0 and 23)`.
 */
export const businessHourOf = (timestamp: string): number => {
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp);
  if (!zoned) return Number(String(timestamp).slice(11, 13));
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return Number.NaN;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: APP_TIMEZONE, hourCycle: "h23", hour: "2-digit" }).formatToParts(date);
  return Number(parts.find((part) => part.type === "hour")?.value ?? Number.NaN);
};

/**
 * The UTC instant a business day (`YYYY-MM-DD`, Asia/Karachi) starts, `dayOffset` days on — the
 * inverse of businessDateOf, for reading a day's window out of UTC timestamps. Null for a bad date.
 * It does not depend on the computer's own timezone.
 */
export const businessDayStartIso = (ymd: string, dayOffset = 0): string | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? "").trim());
  if (!match) return null;
  const utcMidnight = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + dayOffset);
  if (Number.isNaN(utcMidnight)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIMEZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMidnight));
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  // How far the zone's clock is ahead of UTC at that moment, then midnight on the zone's clock.
  const zoneClockAsUtc = Date.UTC(pick("year"), pick("month") - 1, pick("day"), pick("hour"), pick("minute"), pick("second"));
  return new Date(utcMidnight - (zoneClockAsUtc - utcMidnight)).toISOString();
};

// ─── Work: cartons → dated days ──────────────────────────────────────────────

/** One produced carton, for one job on it, as the data layer reads it. */
export interface ContractorWorkCarton {
  receivedAt: string;
  programId: string;
  programCode: string;
  machineName: string;
  role: ContractorRole;
  articleSizeId: string;
  article: string;
  size: string;
  /** Per DOZEN, in paisa. Null when neither the program nor the product has a rate for this job. */
  ratePaisa: number | null;
  rateSource: RateSource | null;
  /**
   * How many cartons this row stands for: 1 for a carton QR (the default), the entry's cartons for
   * Manual Production, which records a quantity with no QR per carton.
   */
  cartons?: number;
}

/** How many cartons a work row stands for. */
const cartonCount = (carton: ContractorWorkCarton): number => carton.cartons ?? 1;

/** One program's work on one article, for one job, on one day. */
export interface ContractorWorkLine {
  programId: string;
  programCode: string;
  machineName: string;
  role: ContractorRole;
  articleSizeId: string;
  article: string;
  size: string;
  cartons: number;
  dozens: number;
  ratePaisa: number | null;
  rateSource: RateSource | null;
  /** dozens × rate, rounded to the paisa. 0 when not priced. */
  amountPaisa: number;
}

/** Everything a contractor produced on one business day. */
export interface ContractorWorkDay {
  date: string;
  cartons: number;
  dozens: number;
  amountPaisa: number;
  /** Dozens on this day that have no rate, so are not in amountPaisa. */
  unpricedDozens: number;
  lines: ContractorWorkLine[];
}

const lineKey = (carton: ContractorWorkCarton): string =>
  [carton.programId, carton.role, carton.articleSizeId].join("|");

/** One line per program × job × article, with its cartons counted. */
const linesOf = (cartons: readonly ContractorWorkCarton[]): ContractorWorkLine[] => {
  const counted = new Map<string, { carton: ContractorWorkCarton; count: number }>();
  for (const carton of cartons) {
    const key = lineKey(carton);
    const entry = counted.get(key);
    if (entry) entry.count += cartonCount(carton);
    else counted.set(key, { carton, count: cartonCount(carton) });
  }
  return [...counted.values()].map(({ carton, count }) => {
    const dozens = cartonsToDozens(count);
    const { receivedAt: _receivedAt, cartons: _cartons, ...identity } = carton;
    return { ...identity, cartons: count, dozens, amountPaisa: carton.ratePaisa == null ? 0 : jobChargePaisa(carton.ratePaisa, dozens) };
  });
};

const byProgramThenArticle = (a: ContractorWorkLine, b: ContractorWorkLine): number =>
  a.programCode.localeCompare(b.programCode) || a.role.localeCompare(b.role) || `${a.article} ${a.size}`.localeCompare(`${b.article} ${b.size}`);

/** The cartons, grouped into the business days they came in on, oldest first. */
export const groupContractorWork = (cartons: readonly ContractorWorkCarton[]): ContractorWorkDay[] => {
  const byDate = new Map<string, ContractorWorkCarton[]>();
  for (const carton of cartons) {
    const date = businessDateOf(carton.receivedAt);
    byDate.set(date, [...(byDate.get(date) ?? []), carton]);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, dayCartons]) => {
      const lines = linesOf(dayCartons).sort(byProgramThenArticle);
      const cartons = dayCartons.reduce((total, carton) => total + cartonCount(carton), 0);
      return {
        date,
        cartons,
        dozens: cartonsToDozens(cartons),
        amountPaisa: lines.reduce((sum, line) => sum + line.amountPaisa, 0),
        unpricedDozens: lines.filter((line) => line.ratePaisa == null).reduce((sum, line) => sum + line.dozens, 0),
        lines,
      };
    });
};

// ─── The ledger: work and payments, with a running balance ──────────────────

export const CONTRACTOR_PAYMENT_KIND = {
  /** Money paid TO the contractor — reduces what is owed. */
  PAYMENT: "PAYMENT",
  /** Money received FROM the contractor (an advance returned) — adds back to what is owed. */
  RECEIPT: "RECEIPT",
  /** A claim for uppers damaged or lost in their work — deducted from what is owed. */
  CLAIM: "CLAIM",
} as const;
export type ContractorPaymentKind = (typeof CONTRACTOR_PAYMENT_KIND)[keyof typeof CONTRACTOR_PAYMENT_KIND];

/** One cash voucher line naming the contractor. */
export interface ContractorPayment {
  date: string;
  voucherId: string;
  voucherNumber: string;
  description: string;
  modeOfTransfer: string | null;
  kind: ContractorPaymentKind;
  amountPaisa: number;
}

export type ContractorLedgerEntry =
  | { kind: "WORK"; date: string; creditPaisa: number; debitPaisa: number; balancePaisa: number; work: ContractorWorkDay }
  | { kind: ContractorPaymentKind; date: string; creditPaisa: number; debitPaisa: number; balancePaisa: number; payment: ContractorPayment };

export interface ContractorLedger {
  /** Positive: owed TO the contractor at the start of the period. */
  openingBalancePaisa: number;
  closingBalancePaisa: number;
  /** Work done in the period. */
  earnedPaisa: number;
  /** Paid to the contractor in the period, less anything they returned. */
  paidPaisa: number;
  /** Claimed from the contractor in the period for damaged or lost uppers. */
  claimedPaisa: number;
  /** The Cr and Dr columns summed, for the ledger's total row (work + money returned; payments). */
  totalCreditPaisa: number;
  totalDebitPaisa: number;
  dozens: number;
  unpricedDozens: number;
  entries: ContractorLedgerEntry[];
}

type Unbalanced = Omit<Extract<ContractorLedgerEntry, { kind: "WORK" }>, "balancePaisa"> | Omit<Extract<ContractorLedgerEntry, { kind: ContractorPaymentKind }>, "balancePaisa">;

const workEntry = (work: ContractorWorkDay): Unbalanced => ({ kind: "WORK", date: work.date, creditPaisa: work.amountPaisa, debitPaisa: 0, work });

/** A payment and a claim both reduce what is owed; only money handed back adds to it. */
const paymentEntry = (payment: ContractorPayment): Unbalanced =>
  payment.kind === CONTRACTOR_PAYMENT_KIND.RECEIPT
    ? { kind: payment.kind, date: payment.date, creditPaisa: payment.amountPaisa, debitPaisa: 0, payment }
    : { kind: payment.kind, date: payment.date, creditPaisa: 0, debitPaisa: payment.amountPaisa, payment };

/** Within a day, the work comes before what was paid or claimed against it. */
const ENTRY_ORDER: Record<ContractorLedgerEntry["kind"], number> = { WORK: 0, PAYMENT: 1, RECEIPT: 2, CLAIM: 3 };

const isMoney = (entry: Unbalanced): boolean => entry.kind === CONTRACTOR_PAYMENT_KIND.PAYMENT || entry.kind === CONTRACTOR_PAYMENT_KIND.RECEIPT;

/**
 * The ledger for `fromDate`…`toDate` (inclusive, `YYYY-MM-DD`), given ALL of the contractor's
 * work and payments. Everything before the period is its opening balance.
 */
export const buildContractorLedger = (input: {
  work: readonly ContractorWorkDay[];
  payments: readonly ContractorPayment[];
  fromDate: string;
  toDate: string;
}): ContractorLedger => {
  const all = [...input.work.map(workEntry), ...input.payments.map(paymentEntry)].sort(
    (a, b) => a.date.localeCompare(b.date) || ENTRY_ORDER[a.kind] - ENTRY_ORDER[b.kind]
  );
  const before = all.filter((entry) => entry.date < input.fromDate);
  const during = all.filter((entry) => entry.date >= input.fromDate && entry.date <= input.toDate);

  const openingBalancePaisa = before.reduce((sum, entry) => sum + entry.creditPaisa - entry.debitPaisa, 0);
  let running = openingBalancePaisa;
  const entries = during.map((entry) => {
    running += entry.creditPaisa - entry.debitPaisa;
    return { ...entry, balancePaisa: running } as ContractorLedgerEntry;
  });

  const workDays = during.flatMap((entry) => (entry.kind === "WORK" ? [entry.work] : []));
  return {
    openingBalancePaisa,
    closingBalancePaisa: running,
    earnedPaisa: workDays.reduce((sum, day) => sum + day.amountPaisa, 0),
    paidPaisa: during.reduce((sum, entry) => (isMoney(entry) ? sum + entry.debitPaisa - entry.creditPaisa : sum), 0),
    claimedPaisa: during.reduce((sum, entry) => (entry.kind === CONTRACTOR_PAYMENT_KIND.CLAIM ? sum + entry.debitPaisa : sum), 0),
    totalCreditPaisa: during.reduce((sum, entry) => sum + entry.creditPaisa, 0),
    totalDebitPaisa: during.reduce((sum, entry) => sum + entry.debitPaisa, 0),
    dozens: workDays.reduce((sum, day) => sum + day.dozens, 0),
    unpricedDozens: workDays.reduce((sum, day) => sum + day.unpricedDozens, 0),
    entries,
  };
};
