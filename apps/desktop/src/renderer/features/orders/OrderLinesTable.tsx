import React from "react";
import { orderProgressOf, type OrderProgress } from "@erp/domain";
import { ColourName } from "../colorTranslation/ColourName";
import { ColorSwatch } from "../../components/shared/ColorSwatch";
import { copy } from "../../config/copy";
import { OrderProgressBadge } from "./OrderProgressBadge";
import { orderDozens } from "./orderUnits";

// Ordered, dispatched and pending, one row per product: a party's products on Pending Orders, an order's lines on
// Enter Orders (R1). Pending is the figure that matters, so it is the strongest. Every figure is the main process's.

export interface OrderLinesRow {
  readonly key: string;
  readonly article: string;
  readonly color: string;
  readonly size: string;
  readonly ordered: number;
  readonly dispatched: number;
  readonly pending: number;
  /** As last typed on the order, when a gatepass on another computer had already sent more (24 Nov 2026). */
  readonly requested?: number;
  readonly progress?: OrderProgress;
  readonly orderCodes?: readonly string[];
}

interface OrderLinesTableProps {
  label: string;
  rows: readonly OrderLinesRow[];
  /** Show which orders each row is on (Pending Orders). */
  showOrders?: boolean;
}

const words = copy.pendingOrders;
const figure = orderDozens;

export const OrderLinesTable: React.FC<OrderLinesTableProps> = ({ label, rows, showOrders = false }) => (
  <div className="ord-table-wrap">
    <table className="data-table ord-table" aria-label={label}>
      <thead>
        <tr>
          <th scope="col">{words.article}</th>
          <th scope="col">{words.colour}</th>
          <th scope="col">{words.size}</th>
          <th scope="col" className="ord-num">{words.ordered}</th>
          <th scope="col" className="ord-num">{words.dispatched}</th>
          <th scope="col" className="ord-num">{words.pending}</th>
          <th scope="col"><span className="sr-only">{words.filterLabel}</span></th>
          {showOrders ? <th scope="col">{words.orders}</th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <td className="ord-article">{row.article}</td>
            <td><span className="ord-colour"><ColorSwatch color={row.color} /><ColourName colour={row.color} /></span></td>
            <td>{row.size}</td>
            <td className="ord-num">
              {figure(row.ordered)}
              {row.requested !== undefined && row.requested < row.ordered ? (
                <span className="ord-asked" title={words.askedTitle}>{words.asked(figure(row.requested))}</span>
              ) : null}
            </td>
            <td className="ord-num">{figure(row.dispatched)}</td>
            <td className="ord-num ord-pending">{figure(row.pending)}</td>
            <td><OrderProgressBadge progress={row.progress ?? orderProgressOf(row.ordered, row.dispatched)} /></td>
            {showOrders ? <td className="ord-codes">{(row.orderCodes ?? []).join(", ")}</td> : null}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);
