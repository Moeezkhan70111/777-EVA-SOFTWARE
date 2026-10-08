import { PAIRS_PER_DOZEN, cartonsToDozens, dozensToCartons, dozensToPairs } from "./units.js";

// Money — exact arithmetic for Pakistani Rupees.
//
// The financial tables are mid-migration from REAL rupees to INTEGER paisa storage (see
// migrations/sqlite/029_money_paisa_columns): every monetary column now has a `*_paisa`
// sibling, dual-written on every save, with the REAL column still authoritative for readers
// not yet switched over. Regardless of storage, every calculation in the application has to
// be exact, so these helpers convert to integer paisa, do the arithmetic there, and convert
// back. Nothing outside this file should add, subtract or multiply money with plain floating
// point.

export const PAISA_PER_RUPEE = 100;

/**
 * Rupees → integer paisa (rounded to the nearest paisa). The decimal shift is done on the
 * number's decimal text (`1.005e2` → 100.5) rather than by `* 100`, which would already
 * have lost precision (`1.005 * 100 === 100.49999999999999`).
 */
export const toPaisa = (rupees: number): number => {
  if (!Number.isFinite(rupees)) return 0;
  const shifted = Number(`${rupees}e2`);
  return Math.round(Number.isFinite(shifted) ? shifted : rupees * PAISA_PER_RUPEE);
};

/** Integer paisa → rupees. */
export const fromPaisa = (paisa: number): number => paisa / PAISA_PER_RUPEE;

/**
 * Nullable-safe `toPaisa`, for dual-writing an optional/nullable rupee column (e.g. a
 * discount, a cost price, a party's balance limit) into its `*_paisa` sibling column
 * without inventing a value where the source was absent.
 */
export const toPaisaOrNull = (rupees: number | null | undefined): number | null =>
  rupees === null || rupees === undefined ? null : toPaisa(rupees);

/** Nullable-safe `fromPaisa` — the inverse of {@link toPaisaOrNull}. */
export const fromPaisaOrNull = (paisa: number | null | undefined): number | null =>
  paisa === null || paisa === undefined ? null : fromPaisa(paisa);

/** Rounds a rupee amount to paisa precision. */
export const roundMoney = (rupees: number): number => fromPaisa(toPaisa(rupees));

export const addMoney = (...amounts: number[]): number =>
  fromPaisa(amounts.reduce((sum, amount) => sum + toPaisa(amount), 0));

export const subtractMoney = (amount: number, deduction: number): number =>
  fromPaisa(toPaisa(amount) - toPaisa(deduction));

/** Multiplies a rupee amount by a quantity (which may be fractional, e.g. 0.5 dozen). */
export const multiplyMoney = (rupees: number, quantity: number): number =>
  fromPaisa(Math.round(toPaisa(rupees) * (Number.isFinite(quantity) ? quantity : 0)));

/** Divides a rupee amount by a quantity, returning 0 for a zero/invalid divisor. */
export const divideMoney = (rupees: number, divisor: number): number =>
  Number.isFinite(divisor) && divisor !== 0 ? fromPaisa(Math.round(toPaisa(rupees) / divisor)) : 0;

// ─── Sale voucher line ───────────────────────────────────────────────────────
// A sale line is entered in dozens, priced per pair, and discounted per pair.
// This is the ONE formula for a line; the Sale Voucher form, the ledger and the
// database all derive their figures from it.

export interface SaleLineInput {
  /** Quantity in dozens (may be fractional). */
  dozens: number;
  /** Selling price per pair. */
  pairRate: number;
  /** Discount per pair. */
  pairDiscount: number;
}

export interface SaleLineFigures {
  /** Cartons = dozens × 2. */
  cartons: number;
  /** Pairs = dozens × 12. */
  pairs: number;
  /** Rate per dozen = pair rate × 12. */
  dozenRate: number;
  /** Gross = dozens × dozen rate. */
  amount: number;
  /** Discount per dozen = pair discount × 12. */
  dozenDiscount: number;
  /** Total discount = dozens × dozen discount. */
  totalDiscount: number;
  /** Net = gross − total discount. */
  total: number;
}

export function calculateSaleLine(input: SaleLineInput): SaleLineFigures {
  const dozenRate = multiplyMoney(input.pairRate, PAIRS_PER_DOZEN);
  const amount = multiplyMoney(dozenRate, input.dozens);
  const dozenDiscount = multiplyMoney(input.pairDiscount, PAIRS_PER_DOZEN);
  const totalDiscount = multiplyMoney(dozenDiscount, input.dozens);
  return {
    cartons: dozensToCartons(input.dozens),
    pairs: dozensToPairs(input.dozens),
    dozenRate,
    amount,
    dozenDiscount,
    totalDiscount,
    total: subtractMoney(amount, totalDiscount),
  };
}

/**
 * Net price of a line when the total discount is already known (the persisted form of a
 * line). Equivalent to `calculateSaleLine` when `totalDiscount = pairDiscount × pairs`.
 */
export function saleLineTotal(input: { dozens: number; pairRate: number; totalDiscount: number }): number {
  const gross = multiplyMoney(input.pairRate, dozensToPairs(input.dozens));
  return subtractMoney(gross, input.totalDiscount);
}

/** Discount per pair implied by a total line discount. */
export function discountPerPairFromTotal(input: { dozens: number; totalDiscount: number }): number {
  return divideMoney(input.totalDiscount, dozensToPairs(input.dozens));
}

// ─── Carton return credit ────────────────────────────────────────────────────
// A returned carton is credited at exactly the rate its own sale voucher line was billed
// at, so the credit can never disagree with the paper bill. One scanned QR is one carton
// and one carton is half a dozen, so this is `calculateSaleLine` over that half dozen —
// the same single formula the bill itself used, never a separate calculation.

/** What one returned carton is worth against the line it was sold on. */
export function cartonReturnCredit(line: { pairRate: number; pairDiscount: number }): number {
  return calculateSaleLine({
    dozens: cartonsToDozens(1),
    pairRate: line.pairRate,
    pairDiscount: line.pairDiscount,
  }).total;
}
