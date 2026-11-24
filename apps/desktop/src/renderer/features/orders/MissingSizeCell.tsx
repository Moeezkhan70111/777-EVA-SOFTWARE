import React, { useState } from "react";
import { addArticleColor } from "../../components/shared/articleColor";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";

// A SIZE A COLOUR IS NOT MADE IN (owner, 24 Nov 2026: "how would they enter their order there"). An order line names a
// product (article + colour + size), and this one is not in Product Master, so there is no box until it is.
//
//   An administrator where Product Master is written: "+ Add" adds the colour to every size it is missing from (the
//   same addColorToArticle as "+ New colour", one transaction), and the box appears for the dozens.
//   Anyone else: the cell says so in words, and who can add it. The main process refuses the write anywhere else.

const words = copy.orders;

interface MissingSizeCellProps {
  article: string;
  colour: string;
  size: string;
  /** Every size this colour is missing from on this article: what "+ Add" will add. */
  missingSizes: readonly string[];
  canAdd: boolean;
  disabled: boolean;
  onAdded: (colour: string) => void;
}

export const MissingSizeCell: React.FC<MissingSizeCellProps> = ({ article, colour, size, missingSizes, canAdd, disabled, onAdded }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const [busy, setBusy] = useState(false);

  if (!canAdd) {
    return (
      <td className="ord-cell ord-cell--none">
        <span className="ord-missing" title={words.notInMasterHint(colour, size)} aria-label={words.notInMasterHint(colour, size)}>{words.notInMaster}</span>
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
    <td className="ord-cell ord-cell--none">
      <button type="button" className="ord-missing-add" disabled={disabled || busy} aria-label={words.addMissingLabel(colour, size)}
        title={words.addMissingTitle(colour, missingSizes.join(", "))} onClick={() => void add()}>
        {busy ? words.addingMissing : words.addMissing}
      </button>
    </td>
  );
};
