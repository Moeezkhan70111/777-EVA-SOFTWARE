import { calculateSaleLine, computeBTypePrice, discountPerPairFromTotal, dozensToPairs, multiplyMoney, toPaisa } from "@erp/domain";
import type { SaleVoucher } from "../../types/desktopApi";
import type { VoucherLineFromGatepass } from "./gatepassToVoucher";

// One line of a bill as the screen holds it: what the clerk may type (dozens, rate per pair,
// discount per pair) beside the figures every line derives from them. The figures come from
// the one formula in @erp/domain (money.ts) — the same one the database applies on save, so
// the screen never disagrees with the ledger. A line is an article + size; colour is not
// part of a bill.

export type PriceType = "NORMAL" | "B_TYPE";

/** What the clerk may type on a line; everything else is derived. */
export type EditableLineField = "dznQty" | "pairRate" | "pairDisc";

/** Where the discount per pair came from, for the small label beside it; "" when typed by hand or none. */
export type DiscountSourceLabel = "ARTICLE" | "ARTICLE_SERIES" | "PRICE_RANGE" | "PRODUCT_GROUP" | "";

export interface BillLineInput {
  /** Database id once saved. */
  id?: string;
  /** The variant the line is priced and stored under (any colour of the article + size). */
  productVariantId: string;
  article: string;
  size: string;
  priceType: PriceType;
  /** The article's NORMAL selling price per pair, when known — B-TYPE is derived from it. */
  normalRate: number | null;
  dznQty: number;
  pairRate: number;
  pairDisc: number;
  discSource: DiscountSourceLabel;
}

export interface BillLineFigures {
  /** Cartons: dozens × 2. */
  unitQty: number;
  dznRate: number;
  amount: number;
  dznDisc: number;
  totalDisc: number;
  total: number;
}

export type BillLine = BillLineInput & BillLineFigures;

export interface BillTotals {
  dzn: number;
  gross: number;
  disc: number;
  net: number;
}

/** B-TYPE never carries a discount, whatever the party's rules say. */
export const effectiveDiscount = (priceType: PriceType, pairDisc: number): number => (priceType === "B_TYPE" ? 0 : pairDisc);

export const withFigures = (input: BillLineInput): BillLine => {
  const pairDisc = effectiveDiscount(input.priceType, input.pairDisc);
  const line = calculateSaleLine({ dozens: input.dznQty, pairRate: input.pairRate, pairDiscount: pairDisc });
  return {
    ...input,
    pairDisc,
    unitQty: line.cartons,
    dznRate: line.dozenRate,
    amount: line.amount,
    dznDisc: line.dozenDiscount,
    totalDisc: line.totalDiscount,
    total: line.total,
  };
};

export const billTotals = (lines: readonly BillLine[]): BillTotals =>
  lines.reduce(
    (acc, line) => ({ dzn: acc.dzn + line.dznQty, gross: acc.gross + line.amount, disc: acc.disc + line.totalDisc, net: acc.net + line.total }),
    { dzn: 0, gross: 0, disc: 0, net: 0 }
  );

/** A gatepass line with the party's rate and discount resolved for it. */
export const lineFromGatepass = (line: VoucherLineFromGatepass, pricing: { normalRate: number | null; pairDisc: number; discSource: DiscountSourceLabel }): BillLine =>
  withFigures({
    productVariantId: line.productVariantId,
    article: line.article,
    size: line.size,
    priceType: "NORMAL",
    normalRate: pricing.normalRate,
    dznQty: line.dozens,
    pairRate: pricing.normalRate ?? 0,
    pairDisc: pricing.pairDisc,
    discSource: pricing.discSource,
  });

type SavedLineItem = SaleVoucher["lineItems"][number];

/**
 * Whether a saved line carries exactly the discount the party's rule gave it when it was
 * saved (also true for "no rule, no discount"). A line the clerk typed a different figure
 * on does not, and that figure is theirs to keep.
 */
export const savedLineFollowsRule = (item: SavedLineItem): boolean =>
  toPaisa(item.discount) === toPaisa(multiplyMoney(item.discountPerPair, dozensToPairs(item.quantity)));

/**
 * A saved line as the database returns it: the saved rate is the historical, authoritative
 * figure. The discount label stays only while the line still carries the rule's figure.
 */
export const lineFromSavedItem = (item: SavedLineItem): BillLine =>
  withFigures({
    id: item.id,
    productVariantId: item.productVariantId,
    article: item.article,
    size: item.size,
    priceType: item.priceType,
    normalRate: null,
    dznQty: item.quantity,
    pairRate: item.unitPrice,
    pairDisc: discountPerPairFromTotal({ dozens: item.quantity, totalDiscount: item.discount }),
    discSource: savedLineFollowsRule(item) && item.discountSource !== "NONE" ? item.discountSource : "",
  });

/**
 * The rate a line takes when its price type changes: NORMAL restores the article's price,
 * B-TYPE derives from it (never invented when the NORMAL price is missing — the line keeps
 * its rate and the caller says so).
 */
export const rateForPriceType = (priceType: PriceType, normalRate: number | null): { ok: true; rate: number } | { ok: false } => {
  if (normalRate === null || normalRate <= 0) return { ok: false };
  if (priceType === "NORMAL") return { ok: true, rate: normalRate };
  const bType = computeBTypePrice(normalRate);
  return bType.ok ? { ok: true, rate: bType.price } : { ok: false };
};
