import React from "react";
import { SizeColourGrid } from "../../components/shared/SizeColourGrid";
import { ColourName } from "../colorTranslation/ColourName";
import { copy } from "../../config/copy";
import { OrderCheckIcon } from "./OrderIcons";
import { cellKey } from "./orderDraft";
import type { PendingArticle } from "./pendingMatrix";
import { orderDozens } from "./orderUnits";

// One article of a party's pending orders, as a compact card: its name and orders on the left of the head, its pending
// total on the right; then sizes down and colours across (the same grid as Enter Orders).
//
// ONE FIGURE PER BOX: what is still pending. Ordered and dispatched are on hover and read out to screen readers, so the
// grid stays a grid of the numbers that matter. A fully dispatched box shows a small tick (an SVG, optically centred); a size and colour that was never
// ordered is left empty. The last row is each colour's total.

const words = copy.pendingOrders;
const figure = orderDozens;

/** span: the bento columns this card takes (bentoLayout.ts). */
export const PendingArticleMatrix: React.FC<{ group: PendingArticle; span: number }> = ({ group, span }) => (
  <section className="ord-matrix" aria-label={group.article} style={{ gridColumn: `span ${String(span)}` }}>
    <header className="ord-matrix-head">
      <div className="ord-matrix-name">
        <h4 className="ord-matrix-title">{group.article}</h4>
        <span className="ord-codes">{group.orderCodes.join(", ")}</span>
      </div>
      <span className="ord-matrix-total"><strong>{figure(group.pending)}</strong> {words.pendingShort}</span>
    </header>
    <SizeColourGrid
      renderColourName={(colour) => <ColourName colour={colour} />}
      label={words.matrixLabel(group.article)}
      sizeHeader={words.size}
      sizes={group.sizes}
      colours={group.colours}
      onEnter={() => undefined}
      renderCell={(size, colour) => {
        const line = group.cells.get(cellKey(size.size, colour));
        if (!line) return <td className="ord-mcell is-none" aria-label={words.notOrdered(colour, size.size)} />;
        const done = line.pending === 0;
        const summary = words.cellSummary(group.article, colour, size.size, figure(line.pending), figure(line.ordered), figure(line.dispatched));
        return (
          <td className={done ? "ord-mcell is-done" : "ord-mcell"} aria-label={summary} title={words.cellFigures(figure(line.ordered), figure(line.dispatched))}>
            <span className="ord-mcell-pending">{done ? <OrderCheckIcon /> : figure(line.pending)}</span>
          </td>
        );
      }}
      footer={{ label: words.total, renderCell: (colour) => <td className="ord-num ord-foot">{figure(group.pendingByColour.get(colour) ?? 0)}</td> }}
    />
  </section>
);
