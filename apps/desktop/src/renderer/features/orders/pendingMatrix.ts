import { compareSizes, orderProgressOf } from "@erp/domain";
import type { GridSize } from "../../components/shared/SizeColourGrid";
import type { CustomerOrder, PendingOrderLine } from "../../types/desktopApi";
import { cellKey } from "./orderDraft";

// ONE PARTY'S PENDING ORDERS AS THE STORE READS THEM: an article at a time, sizes down (the store's size order, as on
// Carton Stock) and colours across.
//
//   SK6     RED   BLUE   BLACK
//   7/10     10     4      —
//   4/6       6     0      2
//
// Pure: it only regroups the lines the main process sent. Every figure is the main process's. One stored order on
// Enter Orders is read the same way (orderAsPendingLines), so an article and its sizes are found at a glance there
// too (owner, 25 Nov 2026).

/** A box's line; `requested` only on one order's lines, when a gatepass had already sent more than was last typed. */
export type MatrixLine = PendingOrderLine & { readonly requested?: number };

export interface PendingArticle {
  readonly article: string;
  readonly sizes: readonly GridSize[];
  readonly colours: readonly string[];
  /** The line in each box, by cellKey(size, colour). A missing box was not ordered. */
  readonly cells: ReadonlyMap<string, MatrixLine>;
  readonly pending: number;
  /** Pending cartons per colour, for the matrix's last row. */
  readonly pendingByColour: ReadonlyMap<string, number>;
  /** The orders behind this article, oldest first. */
  readonly orderCodes: readonly string[];
}

/** The party's lines grouped by article, articles by name. */
export function pendingMatrix(lines: readonly MatrixLine[]): PendingArticle[] {
  const byArticle = new Map<string, MatrixLine[]>();
  for (const line of lines) byArticle.set(line.article, [...(byArticle.get(line.article) ?? []), line]);
  return [...byArticle.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([article, own]) => {
      const pendingByColour = new Map<string, number>();
      for (const line of own) pendingByColour.set(line.color, (pendingByColour.get(line.color) ?? 0) + line.pending);
      return {
        article,
        sizes: [...new Set(own.map((line) => line.size))].sort(compareSizes).map((size) => ({ id: size, size })),
        colours: [...new Set(own.map((line) => line.color))].sort(),
        cells: new Map(own.map((line) => [cellKey(line.size, line.color), line])),
        pending: own.reduce((sum, line) => sum + line.pending, 0),
        pendingByColour,
        orderCodes: [...new Set(own.flatMap((line) => line.orderCodes))].sort(),
      };
    });
}

/** One stored order's lines as matrix lines. No order codes: the order's own code is already its heading. */
export const orderAsPendingLines = (order: CustomerOrder): MatrixLine[] =>
  order.lines.map((line) => ({
    productVariantId: line.productVariantId,
    article: line.article,
    color: line.color,
    size: line.size,
    ordered: line.quantity,
    dispatched: line.dispatched,
    pending: line.pending,
    progress: orderProgressOf(line.quantity, line.dispatched),
    orderCodes: [],
    requested: line.requested,
  }));
