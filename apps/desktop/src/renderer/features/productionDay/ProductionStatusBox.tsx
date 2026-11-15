import React from "react";
import type { ProductionDayMark } from "@erp/domain";
import { copy } from "../../config/copy";
import { formatTime } from "../../utils/dates";

// TODAY'S PRODUCTION, AT A GLANCE (owner, 14 Nov 2026): grey "Production not added" until someone presses
// "Complete today's production", then green "Production added", with when and by whom. Said in words and with a
// mark (○ / ✓), never by colour alone (R18). A live region, so a change while the page is open is read out.
//
// One box, shown on Carton Stock and on the Manual Production page (R1). It shows; useTodayMark reads.
// A quiet one-line pill (owner, 15 Nov 2026): it is there to check, not to catch the eye. The long
// "waiting for…" hint is the tooltip and the screen reader's, not a line on screen. Collapsed to its mark and
// words ("Production added") until hovered or focused, when the when-and-who slides open (owner, 16 Nov 2026).
// Carton Stock shows it as a card instead (variant "card"): never collapsed, the when-and-who always under the words.

const text = copy.productionDay;

interface ProductionStatusBoxProps {
  mark: ProductionDayMark | null;
  /** True until the first read answers. */
  loading: boolean;
  /** The first read failed: the status is not known. */
  error: string | null;
  /** Another day's pill: "Production on 13 Nov 2026", said when it opens, with who completed it. */
  eyebrow?: string;
  /** "pill" (default): small, opens on hover. "card": a steady card beside Carton Stock's total. */
  variant?: "pill" | "card";
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

export const ProductionStatusBox: React.FC<ProductionStatusBoxProps> = ({ mark, loading, error, eyebrow, variant = "pill" }) => {
  const added = mark !== null;
  const unknown = !added && (loading || error !== null);
  const state = stateOf(added, unknown);
  const title = titleOf(added, loading, error);
  const note = added ? text.addedBy(formatTime(mark.completedAt), mark.completedBy) : unknown ? null : text.notAddedHint;
  // What slides open: today, when and who; another day, that day and who (or the day alone, when not added).
  const more = eyebrow ? (added ? text.dayAddedBy(eyebrow, mark.completedBy) : eyebrow) : added ? note : null;
  if (variant === "card") {
    return (
      <div className={`pd-status pd-status--card ${state}`} role="status" aria-live="polite">
        <span className="pd-status-mark" aria-hidden="true">{added ? "✓" : "○"}</span>
        <span className="pd-status-text">
          <span className="pd-status-eyebrow">{text.statusCardLabel}</span>
          <strong className="pd-status-title">{title}</strong>
          {/* Only when added: when and by whom. Not added says nothing more (owner, 16 Nov 2026). */}
          {added && note ? <span className="pd-status-note">{note}</span> : null}
        </span>
      </div>
    );
  }
  return (
    <div className={`pd-status ${state}`} role="status" aria-live="polite" tabIndex={0} title={added ? undefined : (note ?? undefined)}>
      <span className="pd-status-mark" aria-hidden="true">{added ? "✓" : "○"}</span>
      <strong className="pd-status-title">{title}</strong>
      {more ? <span className="pd-status-body"><span className="pd-status-note">{more}</span></span> : null}
      {!added && note ? <span className="sr-only">{note}</span> : null}
    </div>
  );
};
