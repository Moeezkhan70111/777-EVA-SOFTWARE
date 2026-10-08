import { copy } from "../../config/copy";

// One source of truth for how a product's on-hand stock is labelled on screen
// (list rows, detail popup). Stock is in cartons.
export type StockStatus = "in" | "low" | "out" | "inactive";

export const LOW_STOCK_CARTONS = 10;

export const getStockStatus = (stockCartons: number, productStatus: string): StockStatus => {
  if (productStatus !== "ACTIVE") return "inactive";
  if (stockCartons === 0) return "out";
  if (stockCartons < LOW_STOCK_CARTONS) return "low";
  return "in";
};

export const stockStatusBadgeClass: Record<StockStatus, string> = {
  in: "badge-active",
  low: "badge-warn",
  out: "badge-inactive",
  inactive: "badge-inactive",
};

export const stockStatusLabel = (status: StockStatus): string => copy.products.stockStatus[status];
