/** "1 BAG (25 KILOGRAM)", or nothing when the packing is unknown. Both store stations print it. */
export const packingLabel = (quantity?: number, unitCode?: string | null, packName?: string | null): string =>
  quantity == null ? "" : `1 ${(packName ?? "").trim() || "PACK"} (${quantity} ${unitCode ?? ""})`.trim();
