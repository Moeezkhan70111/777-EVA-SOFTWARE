import React from "react";
import { CUSTOMER_ORDER_STATUS, orderProgressOf } from "@erp/domain";
import { copy } from "../../config/copy";
import { formatDate } from "../../utils/dates";
import type { CustomerOrder } from "../../types/desktopApi";
import { OrderLinesTable } from "./OrderLinesTable";
import { OrderProgressBadge } from "./OrderProgressBadge";

// A STORED ORDER: who for, when, and each product's ordered, dispatched and pending, from the main process. Edit and
// Cancel are offered while it is open and the operator may; a cancelled order says who cancelled it and why.

const words = copy.orders;
const figures = copy.pendingOrders;

interface OrderDetailsProps {
  order: CustomerOrder;
  busy: boolean;
  canEdit: boolean;
  canCancel: boolean;
  onEdit: () => void;
  onCancel: () => void;
}

export const OrderDetails: React.FC<OrderDetailsProps> = ({ order, busy, canEdit, canCancel, onEdit, onCancel }) => {
  const open = order.status === CUSTOMER_ORDER_STATUS.OPEN;
  const { ordered, dispatched, pending } = order.totals;
  return (
    <div className="ord-form">
      <div className="card ord-summary">
        <div className="ord-summary-main">
          <h3 className="ord-block-title">{order.code} · {order.partyName}</h3>
          <span className="ord-muted">{words.date} {formatDate(order.businessDate)}{order.note ? ` · ${order.note}` : ""}</span>
          {open ? <OrderProgressBadge progress={orderProgressOf(ordered, dispatched)} /> : <span className="badge badge-muted">✕ {words.statusCancelled}</span>}
        </div>
        <dl className="ord-figures">
          <div><dt>{figures.ordered}</dt><dd>{ordered.toLocaleString("en-US")}</dd></div>
          <div><dt>{figures.dispatched}</dt><dd>{dispatched.toLocaleString("en-US")}</dd></div>
          <div className="ord-figure-pending"><dt>{figures.pending}</dt><dd>{pending.toLocaleString("en-US")}</dd></div>
        </dl>
        {open ? (
          <div className="ord-actions">
            {canEdit ? <button type="button" className="btn btn-secondary" disabled={busy} onClick={onEdit}>{words.edit}</button> : null}
            {canCancel ? <button type="button" className="btn btn-danger" disabled={busy} onClick={onCancel}>{words.cancelOrder}</button> : null}
          </div>
        ) : null}
      </div>
      {!open && order.cancelledBy ? <p className="ord-cancelled" role="note">{words.cancelledBy(order.cancelledBy, order.cancelReason ?? "")}</p> : null}
      <OrderLinesTable
        label={words.linesTitle}
        rows={order.lines.map((line) => ({ key: line.id, article: line.article, color: line.color, size: line.size, ordered: line.quantity, dispatched: line.dispatched, pending: line.pending }))}
      />
    </div>
  );
};
