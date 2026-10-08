import { cartonsToDozens } from "@erp/domain";
import type { Gatepass } from "../../types/desktopApi";

// From a gatepass to a sale voucher draft. The gatepass is in cartons per colour; the bill
// is per article + size in dozens (2 cartons = 1 dozen, @erp/domain units.ts) — colour is a
// store concern and never appears on a bill. Rates and discounts are not on the gatepass;
// the form resolves them for each line from the party's pricing.

export interface VoucherLineFromGatepass {
  /**
   * One variant of the article + size, kept only so the line can be priced and stored —
   * price and discount rules live on the article + size, so any colour gives the same
   * figures, and dispatch counts voucher lines by article + size too.
   */
  productVariantId: string;
  article: string;
  size: string;
  dozens: number;
}

export interface VoucherDraftFromGatepass {
  partyId: string;
  voucherDate: string;
  lines: VoucherLineFromGatepass[];
}

const articleSizeKey = (line: { article: string; size: string }): string => `${line.article}|||${line.size}`;

/** Every colour of an article + size folded into one line, in the order the gatepass lists them. */
export const billLinesFromGatepass = (lines: Gatepass["lines"]): VoucherLineFromGatepass[] => {
  const cartonsByArticleSize = new Map<string, { productVariantId: string; article: string; size: string; cartons: number }>();
  for (const line of lines) {
    const key = articleSizeKey(line);
    const existing = cartonsByArticleSize.get(key);
    if (existing) {
      existing.cartons += line.quantity;
    } else {
      cartonsByArticleSize.set(key, { productVariantId: line.productVariantId, article: line.article, size: line.size, cartons: line.quantity });
    }
  }
  return Array.from(cartonsByArticleSize.values()).map(({ cartons, ...line }) => ({ ...line, dozens: cartonsToDozens(cartons) }));
};

// Remarks are never filled in for the desk: the line is theirs to write, in Urdu, for the
// sub party it is going to. Where the bill came from is already on it — the gatepass code
// is stored on the voucher and printed on it.
export const voucherDraftFromGatepass = (gatepass: Gatepass): VoucherDraftFromGatepass => ({
  partyId: gatepass.partyId,
  voucherDate: gatepass.gatepassDate,
  lines: billLinesFromGatepass(gatepass.lines),
});
