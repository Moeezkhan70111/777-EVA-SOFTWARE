import { useCallback, useMemo, useRef, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import type { DesktopApi } from "../../types/desktopApi";
import type { SaleVoucher } from "../../types/desktopApi";
import { billTotals, lineFromGatepass, lineFromSavedItem, rateForPriceType, savedLineFollowsRule, withFigures, type BillLine, type DiscountSourceLabel, type EditableLineField, type PriceType } from "./billLines";
import type { VoucherLineFromGatepass } from "./gatepassToVoucher";

// The lines of the bill on screen and every edit the desk can make to them. The party's
// "less" (discount per pair) is resolved by the backend rule stack — the same authority
// that caps it on save — whenever the rate a line is billed at changes, and again whenever
// a saved bill is opened, so the bill always follows the rules as they stand and the less
// is never typed from memory. A figure the clerk types over stays until the rate changes
// again, and is kept when the bill is reopened.

type DiscountResult = Awaited<ReturnType<DesktopApi["resolveProductDiscountWithPrice"]>> | null;

const sourceOf = (result: DiscountResult): DiscountSourceLabel => (result && result.source !== "NONE" ? result.source : "");

const resolveDiscount = (api: DesktopApi, partyId: string, line: Pick<BillLine, "productVariantId" | "pairRate" | "priceType">): Promise<DiscountResult> => {
  if (line.priceType === "B_TYPE" || !partyId || line.pairRate <= 0) return Promise.resolve(null);
  return api.resolveProductDiscountWithPrice(partyId, line.productVariantId, line.pairRate).catch(() => null);
};

/** Each gatepass line priced for the party: the article's NORMAL rate and the discount that rate earns. */
export const priceLinesFromGatepass = async (api: DesktopApi, partyId: string, draftLines: VoucherLineFromGatepass[]): Promise<{ lines: BillLine[]; missingRate: string[] }> => {
  const lines: BillLine[] = [];
  const missingRate: string[] = [];
  for (const draft of draftLines) {
    const variant = await api.getSaleableVariant(draft.productVariantId).catch(() => null);
    const normalRate = variant?.sellingPrice && variant.sellingPrice > 0 ? variant.sellingPrice : null;
    if (normalRate === null) missingRate.push(`${draft.article} ${draft.size}`);
    const discount = await resolveDiscount(api, partyId, { productVariantId: draft.productVariantId, pairRate: normalRate ?? 0, priceType: "NORMAL" });
    lines.push(lineFromGatepass(draft, { normalRate, pairDisc: discount?.discountPerPair ?? 0, discSource: sourceOf(discount) }));
  }
  return { lines, missingRate };
};

/**
 * A saved bill's lines. A line left on the party's rule takes the rule's figure as it stands
 * now (rules set up or changed since the bill was saved apply when it is reopened); a line
 * the clerk typed a figure on keeps it. If the rule cannot be asked, the saved figure stands.
 */
export const priceSavedLines = async (api: DesktopApi, partyId: string, items: SaleVoucher["lineItems"]): Promise<BillLine[]> => {
  const lines: BillLine[] = [];
  for (const item of items) {
    const line = lineFromSavedItem(item);
    const discount = savedLineFollowsRule(item) ? await resolveDiscount(api, partyId, line) : null;
    lines.push(discount ? withFigures({ ...line, pairDisc: discount.discountPerPair, discSource: sourceOf(discount) }) : line);
  }
  return lines;
};

export const useBillLines = (partyId: string) => {
  const api = useDesktopApi();
  const [lines, setLines] = useState<BillLine[]>([]);
  // The latest discount request per row, so a slower, older answer never overwrites a newer one.
  const requestSeq = useRef(0);
  const pendingByRow = useRef(new Map<number, number>());

  const totals = useMemo(() => billTotals(lines), [lines]);

  const replaceLine = useCallback((index: number, patch: Partial<BillLine>) => {
    setLines((prev) => prev.map((line, i) => (i === index ? withFigures({ ...line, ...patch }) : line)));
  }, []);

  const refreshDiscount = useCallback(
    async (index: number, line: BillLine) => {
      const requestId = ++requestSeq.current;
      pendingByRow.current.set(index, requestId);
      const discount = await resolveDiscount(api, partyId, line);
      if (pendingByRow.current.get(index) !== requestId) return;
      pendingByRow.current.delete(index);
      replaceLine(index, { pairDisc: discount?.discountPerPair ?? 0, discSource: sourceOf(discount) });
    },
    [api, partyId, replaceLine]
  );

  const load = useCallback((next: BillLine[]) => {
    pendingByRow.current.clear();
    setLines(next);
  }, []);

  const changeField = useCallback(
    (index: number, field: EditableLineField, value: number) => {
      const current = lines[index];
      if (!current) return;
      // A discount typed by hand is the clerk's own figure; one the rule stack gave is labelled.
      const patch: Partial<BillLine> = field === "pairDisc" ? { pairDisc: value, discSource: "" } : { [field]: value };
      const next = withFigures({ ...current, ...patch });
      replaceLine(index, patch);
      if (field === "pairRate") void refreshDiscount(index, next);
    },
    [lines, replaceLine, refreshDiscount]
  );

  /** Switches a line's price type; false when B-TYPE could not be derived (the rate must then be typed). */
  const changePriceType = useCallback(
    async (index: number, priceType: PriceType): Promise<boolean> => {
      const current = lines[index];
      if (!current || current.priceType === priceType) return true;
      let normalRate = current.normalRate;
      if (normalRate === null) {
        const variant = await api.getSaleableVariant(current.productVariantId).catch(() => null);
        normalRate = variant?.sellingPrice && variant.sellingPrice > 0 ? variant.sellingPrice : null;
      }
      const rate = rateForPriceType(priceType, normalRate);
      const next = withFigures({ ...current, priceType, normalRate, pairRate: rate.ok ? rate.rate : current.pairRate, pairDisc: 0, discSource: "" });
      replaceLine(index, next);
      void refreshDiscount(index, next);
      return rate.ok;
    },
    [api, lines, replaceLine, refreshDiscount]
  );

  /** Removes a line; a saved one is deleted in the database first. False when that was refused. */
  const removeLine = useCallback(
    async (index: number): Promise<{ ok: true } | { ok: false; reason: string }> => {
      const line = lines[index];
      if (!line) return { ok: true };
      if (line.id) {
        const result = await api.deleteVoucherLineItem(line.id).catch(() => ({ accepted: false, reason: "" }));
        if (!result.accepted) return { ok: false, reason: result.reason ?? "" };
      }
      pendingByRow.current.clear();
      setLines((prev) => prev.filter((_, i) => i !== index));
      return { ok: true };
    },
    [api, lines]
  );

  return { lines, totals, load, changeField, changePriceType, removeLine };
};
