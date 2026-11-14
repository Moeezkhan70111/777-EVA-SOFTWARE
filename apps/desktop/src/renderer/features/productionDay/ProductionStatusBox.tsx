import React from "react";
import type { ProductionDayMark } from "@erp/domain";
import { copy } from "../../config/copy";
import { formatTime } from "../../utils/dates";

// TODAY'S PRODUCTION, AT A GLANCE (owner, 14 Nov 2026): grey "Production not added" until someone presses
// "Complete today's production", then green "Production added", with when and by whom. Said in words and with a
// mark (○ / ✓), never by colour alone (R18). A live region, so a change while the page is open is read out.
//
// One box, shown on Carton Stock and on the Manual Production page (R1). It shows; useTodayMark reads.

const text = copy.productionDay;

interface ProductionStatusBoxProps {
  mark: ProductionDayMark | null;
  /** True until the first read answers. */
  loading: boolean;
  /** The first read failed: the status is not known. */
  error: string | null;
  compact?: boolean;
  /** The small line above: "Today's production" unless the box is about another day. */
  eyebrow?: string;
}

const stateOf = (added: boolean, unknown: boolean): string => {
  if (added) return "is-added";
  return unknown ? "is-unknown" : "is-pending";
};

const titleOf = (added: boolean, loading: boolean, error: string | null): string => {
  if (added) return text.added;
  if (loading) return text.checking;
  return error ? text.unknown : text.notAdded;
};

export const ProductionStatusBox: React.FC<ProductionStatusBoxProps> = ({ mark, loading, error, compact = false, eyebrow = text.statusLabel }) => {
  const added = mark !== null;
  const unknown = !added && (loading || error !== null);
  const state = stateOf(added, unknown);
  const title = titleOf(added, loading, error);
  const note = added ? text.addedBy(formatTime(mark.completedAt), mark.completedBy) : unknown ? null : text.notAddedHint;
  return (
    <div className={`pd-status ${state}${compact ? " pd-status--compact" : ""}`} role="status" aria-live="polite">
      <span className="pd-status-mark" aria-hidden="true">{added ? "✓" : "○"}</span>
      <span className="pd-status-text">
        <span className="pd-status-eyebrow">{eyebrow}</span>
        <strong className="pd-status-title">{title}</strong>
        {note && !compact ? <span className="pd-status-note">{note}</span> : null}
      </span>
    </div>
  );
};
