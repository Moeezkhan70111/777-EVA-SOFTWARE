import { cartonsToDozens } from "@erp/domain";

// ORDERS ARE READ IN DOZENS (owner, 24 Nov 2026: "the order is dozen, not carton"). Every order figure arrives in
// cartons, as it is stored (1 dozen = 2 cartons); this is the one place Enter Orders and Pending Orders turn one into
// the dozens the floor orders in, to at most one decimal: 7 cartons read "3.5".

export const orderDozens = (cartons: number): string =>
  cartonsToDozens(cartons).toLocaleString("en-US", { maximumFractionDigits: 1 });
