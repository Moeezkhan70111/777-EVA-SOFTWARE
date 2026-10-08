// B-TYPE price is derived from the authoritative NORMAL price (article_sizes.selling_price_paisa).
// This is the single reusable source for the rule — do not duplicate it elsewhere.

export const PRICE_RULE_UNDEFINED_FOR_500 = "PRICE_RULE_UNDEFINED_FOR_500" as const;

export type BTypePriceResult =
  | { ok: true; price: number }
  | { ok: false; reason: "NOT_CALCULABLE" };

/**
 * Computes the B-TYPE selling price from a NORMAL selling price.
 *
 * Rule (final, authoritative):
 *   normal <= 500          → normal - 150
 *   501 <= normal <= 599    → normal - 170
 *   normal >= 600           → normal - 200
 *
 * Returns { ok: false } for null/undefined/non-finite/zero/negative NORMAL prices —
 * B-TYPE must never be invented from a missing or invalid master price.
 */
export function computeBTypePrice(normalPrice: number | null | undefined): BTypePriceResult {
  if (normalPrice === null || normalPrice === undefined) return { ok: false, reason: "NOT_CALCULABLE" };
  if (!Number.isFinite(normalPrice)) return { ok: false, reason: "NOT_CALCULABLE" };
  if (normalPrice <= 0) return { ok: false, reason: "NOT_CALCULABLE" };

  if (normalPrice <= 500) return { ok: true, price: normalPrice - 150 };
  if (normalPrice <= 599) return { ok: true, price: normalPrice - 170 };
  return { ok: true, price: normalPrice - 200 };
}
