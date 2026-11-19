import React from "react";
import { ORDER_PROGRESS, type OrderProgress } from "@erp/domain";
import { copy } from "../../config/copy";

// Pending, part dispatched or fully dispatched: said in words with a mark, never by colour alone (R18). One badge for
// both order pages (R1).

const BADGE: Readonly<Record<OrderProgress, { tone: string; mark: string }>> = {
  [ORDER_PROGRESS.PENDING]: { tone: "badge-warn", mark: "○" },
  [ORDER_PROGRESS.PARTIAL]: { tone: "badge-info", mark: "◐" },
  [ORDER_PROGRESS.DISPATCHED]: { tone: "badge-ok", mark: "✓" },
};

export const OrderProgressBadge: React.FC<{ progress: OrderProgress }> = ({ progress }) => (
  <span className={`badge ${BADGE[progress].tone} ord-progress`}>
    <span aria-hidden="true">{BADGE[progress].mark}</span> {copy.pendingOrders.progress[progress]}
  </span>
);
