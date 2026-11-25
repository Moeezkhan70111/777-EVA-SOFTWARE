import React from "react";
import type { GridBoxProps } from "../../components/shared/SizeColourGrid";
import { copy } from "../../config/copy";
import { articleWithGroup } from "../../utils/gatepassGrid";
import { dozensText, type DraftArticle, type DraftColour } from "./gatepassDraft";

// ONE BOX OF THE GATEPASS GRID: an article's colour in one size. The dozens going out, and under the box one figure:
// the current stock, in dozens (owner, 25 Nov 2026: "keep it simple, just show current stock"). More than that is
// allowed (owner, 12 Nov 2026): the box says where the store goes, so production knows what it owes. A bad quantity
// is refused in words under the box. Reservations still count where they always did: the main process checks them.

const words = copy.gatepass;

interface GatepassQtyCellProps {
  entry: DraftArticle;
  colour: DraftColour;
  box: GridBoxProps;
  onChange: (productVariantId: string, text: string) => void;
}

const testId = (prefix: string, entry: DraftArticle, colour: DraftColour) => `${prefix}-${entry.article}-${colour.colour}-${entry.size}`;

export const GatepassQtyCell: React.FC<GatepassQtyCellProps> = ({ entry, colour, box, onChange }) => {
  const label = `${articleWithGroup(entry.article, entry.groupName)} ${colour.colour} ${entry.size}`;
  const selected = (colour.check.value ?? 0) > 0;
  const goesBelowZero = selected && colour.after < 0;
  const errorId = `gp-qty-error-${colour.productVariantId}`;
  const warningId = `gp-qty-warning-${colour.productVariantId}`;
  const describedBy = [colour.check.error ? errorId : "", goesBelowZero ? warningId : ""].filter(Boolean).join(" ") || undefined;
  const cellClass = ["gp-grid-cell", selected ? "is-selected" : "", colour.check.error ? "has-error" : "", goesBelowZero ? "is-short" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <td className={cellClass}>
      <input {...box} className="input gp-grid-input" type="text" inputMode="decimal" placeholder="0" autoComplete="off"
        aria-label={words.quantityFor(label)} aria-invalid={Boolean(colour.check.error)} aria-describedby={describedBy}
        value={colour.text} onChange={(event) => onChange(colour.productVariantId, event.target.value)} onFocus={(event) => event.target.select()} />
      <span className="gp-grid-figures">{words.cellInStore} <b data-testid={testId("current", entry, colour)}>{dozensText(colour.currentStock)}</b></span>
      {colour.check.error ? <span id={errorId} className="gp-qty-error" role="alert">⚠ {colour.check.error}</span> : null}
      {goesBelowZero && !colour.check.error ? (
        <span id={warningId} className="gp-qty-warning" data-testid={testId("below-zero", entry, colour)}>⚠ {words.goesBelowZero(dozensText(colour.after))}</span>
      ) : null}
    </td>
  );
};
