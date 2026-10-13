import {
  MAX_PACKING_ITEM_NAME_LENGTH,
  areValidPackingRateItems,
  fromPaisa,
  isValidContractorRatePaisa,
  packingRateTotalPaisa,
  toPaisa,
  type PackingRateItem,
} from "@erp/domain";
import { copy } from "../../config/copy";

// A product's packing rate entered as named attributes that add up to it:
//
//   BOX 50 + TAPE 30 + POLY BAG 50 + LABOUR 20  =  packing rate 150 per DOZEN
//
// The form holds the attributes in integer paisa, exactly as the domain adds them up. The sum
// itself is the domain's (packingRateTotalPaisa); the main process works it out again from the
// attributes on save, so what is stored never depends on what the screen added up.

export type { PackingRateItem };

/** The packing rate the attributes add up to, in rupees — what the packing box shows. */
export const packingTotalRupees = (items: readonly PackingRateItem[]): number =>
  fromPaisa(packingRateTotalPaisa(items));

/** What the save sends: each attribute's name and its price in rupees, like the other rates. */
export const packingItemsToSend = (items: readonly PackingRateItem[]): Array<{ name: string; rate: number }> =>
  items.map((item) => ({ name: item.name, rate: fromPaisa(item.ratePaisa) }));

/** Why the attributes as a whole cannot be saved, or null. */
export const packingItemsError = (items: readonly PackingRateItem[]): string | null =>
  areValidPackingRateItems(items) ? null : copy.products.packingItems.totalOutOfRange;

/** What the popup's two boxes hold, as typed. */
export interface PackingItemDraft {
  name: string;
  price: string;
}

export type PackingItemResult = { item: PackingRateItem; error: null } | { item: null; error: string };

/** Turns the popup's boxes into an attribute, or says what to fix. */
export const parsePackingItem = (draft: PackingItemDraft): PackingItemResult => {
  const name = draft.name.trim().toUpperCase();
  if (!name) return { item: null, error: copy.products.packingItems.nameRequired };
  if (name.length > MAX_PACKING_ITEM_NAME_LENGTH) {
    return { item: null, error: copy.products.packingItems.nameTooLong(MAX_PACKING_ITEM_NAME_LENGTH) };
  }
  const priceText = draft.price.trim();
  const price = Number(priceText);
  if (priceText === "" || !Number.isFinite(price)) return { item: null, error: copy.products.packingItems.priceRequired };
  const ratePaisa = toPaisa(price);
  if (!isValidContractorRatePaisa(ratePaisa)) return { item: null, error: copy.products.packingItems.priceOutOfRange };
  return { item: { name, ratePaisa }, error: null };
};

/** The popup's boxes for an attribute being edited, or empty ones for a new attribute. */
export const draftFor = (item: PackingRateItem | null): PackingItemDraft =>
  item ? { name: item.name, price: String(fromPaisa(item.ratePaisa)) } : { name: "", price: "" };
