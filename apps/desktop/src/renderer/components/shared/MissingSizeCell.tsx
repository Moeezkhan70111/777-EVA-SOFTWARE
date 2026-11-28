import React, { useState } from "react";
import { addArticleColor } from "./articleColor";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";

// A SIZE A COLOUR IS NOT MADE IN, in a size × colour grid (owner, 24 Nov 2026: "how would they enter their order
// there"). A line names a product (article + colour + size), and this one is not in Product Master, so there is no box
// until it is.
//
//   An administrator where Product Master is written: "+ Add" adds the colour to every size it is missing from (the
//   same addColorToArticle as "+ New colour", one transaction), and the box appears.
//   Anyone else: the cell says so in words, and who can add it. The main process refuses the write anywhere else.
//
// Written for Enter Orders; shared when the Gatepass grid needed the same cell (25 Nov 2026, R1). The button is a small
// round "+" (owner, 25 Nov 2026: "+ Add" in every gap was clutter); its full name is its label and its tooltip.

const words = copy.missingSize;

interface MissingSizeCellProps {
  article: string;
  colour: string;
  size: string;
  /** Every size this colour is missing from on this article: what "+ Add" will add. */
  missingSizes: readonly string[];
  canAdd: boolean;
  disabled: boolean;
  onAdded: (colour: string) => void;
  /** The page's own cell class, beside the shared one. */
  className?: string;
  /** The page is adding this colour by itself (Gatepass, 28 Nov 2026): the cell says so instead of offering "+". */
  pending?: boolean;
}

export const MissingSizeCell: React.FC<MissingSizeCellProps> = ({ article, colour, size, missingSizes, canAdd, disabled, onAdded, className, pending = false }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const [busy, setBusy] = useState(false);
  const cellClass = ["size-missing-cell", className].filter(Boolean).join(" ");

  if (pending) {
    return (
      <td className={cellClass} aria-busy="true">
        <span className="size-missing">{words.opening}</span>
      </td>
    );
  }

  if (!canAdd) {
    return (
      <td className={cellClass}>
        <span className="size-missing" title={words.notInMasterHint(colour, size)} aria-label={words.notInMasterHint(colour, size)}>{words.notInMaster}</span>
      </td>
    );
  }

  const add = async () => {
    setBusy(true);
    const reply = await addArticleColor(api, article, colour, words.addMissingFailed);
    setBusy(false);
    if (reply.ok) onAdded(reply.color);
    else push("error", words.notInMaster, reply.reason);
  };

  return (
    <td className={cellClass}>
      <button type="button" className="size-missing-add" disabled={disabled || busy} aria-label={words.addMissingLabel(colour, size)}
        title={words.addMissingTitle(colour, missingSizes.join(", "))} onClick={() => void add()}>
        <span aria-hidden="true">{busy ? "…" : "+"}</span>
      </button>
    </td>
  );
};
