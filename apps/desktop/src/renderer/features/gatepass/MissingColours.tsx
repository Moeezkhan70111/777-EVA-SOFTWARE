import React, { useState } from "react";
import { addArticleColor } from "../../components/shared/articleColor";
import { ColorSwatch } from "../../components/shared/ColorSwatch";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";

// UNDER AN ARTICLE + SIZE ON THE GATEPASS: the article's colours that this size is not made in (colourGaps.ts).
// A gatepass line needs the product, so these cannot take a quantity until Product Master has them:
//
//   An administrator where Product Master is written: "+ Add BLACKRED" adds the colour to every size it is missing from
//   (the same addColorToArticle as Enter Orders and Stock Adjustment, one transaction), and the colour's row appears
//   above as the store is read again.
//   Anyone else: the colours are named, with who can add them. The main process refuses the write anywhere else.

const words = copy.gatepass;

interface MissingColoursProps {
  article: string;
  size: string;
  colours: readonly string[];
  /** Every size of the article not made in a colour: what adding it adds. */
  sizesMissing: (colour: string) => readonly string[];
  canAdd: boolean;
  onAdded: () => void;
}

export const MissingColours: React.FC<MissingColoursProps> = ({ article, size, colours, sizesMissing, canAdd, onAdded }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const [adding, setAdding] = useState<string | null>(null);
  if (colours.length === 0) return null;

  const add = async (colour: string) => {
    setAdding(colour);
    const reply = await addArticleColor(api, article, colour, words.addMissingFailed);
    setAdding(null);
    if (reply.ok) onAdded();
    else push("error", words.missingTitle(size), reply.reason);
  };

  return (
    <div className="gp-missing" role="group" aria-label={words.missingTitle(size)}>
      <span className="gp-missing-title">{words.missingTitle(size)}</span>
      <ul className="gp-missing-list">
        {colours.map((colour) => (
          <li key={colour}>
            {canAdd ? (
              <button type="button" className="gp-missing-add" disabled={adding !== null} aria-label={words.addMissingLabel(colour, size)}
                title={words.addMissingTitle(colour, sizesMissing(colour).join(", "))} onClick={() => void add(colour)}>
                <ColorSwatch color={colour} />
                {adding === colour ? words.addingMissing : `+ ${colour}`}
              </button>
            ) : (
              <span className="gp-missing-colour"><ColorSwatch color={colour} />{colour}</span>
            )}
          </li>
        ))}
      </ul>
      {canAdd ? null : <span className="gp-missing-hint">{words.missingHint}</span>}
    </div>
  );
};
