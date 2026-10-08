import React from "react";
import { ColorSwatch } from "../../components/shared/ColorSwatch";
import { copy } from "../../config/copy";
import { articleWithGroup } from "../../utils/gatepassGrid";
import type { DraftArticle, DraftColour } from "./gatepassDraft";

// One colour of an article + size on the Gatepass card.
//
//   Writing:  Colour │ Current Stock │ Reserved │ Reflected Stock │ [ qty ] /reflected
//   Reading:  Colour │ In Store at creation │ Gatepass Qty │ Moved out │ Outstanding
//
// The quantity box is capped at Reflected Stock — Current Stock is shown so the operator
// understands "5 are in the store, 4 are already promised, 1 can go on this Gatepass".

interface ColourRowProps {
  article: DraftArticle;
  colour: DraftColour;
  inputRef: (el: HTMLInputElement | null) => void;
  onMove: (step: 1 | -1) => void;
  readOnly?: boolean;
  onQuantityChange?: (productVariantId: string, text: string) => void;
  onStep?: (productVariantId: string, delta: 1 | -1) => void;
}

const testId = (prefix: string, article: DraftArticle, colour: DraftColour) => `${prefix}-${article.article}-${colour.colour}-${article.size}`;

const ColourCell: React.FC<{ colour: string }> = ({ colour }) => (
  <td className="gp-colour-cell">
    <span className="gp-colour-name">
      <ColorSwatch color={colour} />
      {colour}
    </span>
  </td>
);

/** A stored document: the creation snapshot, the quantity, and what Store Move Out has taken. */
const DocumentRow: React.FC<{ article: DraftArticle; colour: DraftColour }> = ({ article, colour }) => {
  const progress = colour.progress ?? { dispatchedFromStore: 0, outstanding: colour.check.value ?? 0 };
  const done = progress.outstanding <= 0;
  return (
    <tr className={done ? "is-done" : undefined}>
      <ColourCell colour={colour.colour} />
      <td className="num gp-colour-avail" data-testid={testId("available", article, colour)}>
        {colour.currentStock}
      </td>
      <td className="num gp-colour-qty">
        <strong className="gp-qty-value" data-testid={testId("qty", article, colour)}>
          {colour.check.value}
        </strong>
      </td>
      <td className="num" data-testid={testId("moved-out", article, colour)}>
        {progress.dispatchedFromStore}
      </td>
      <td className="num" data-testid={testId("outstanding", article, colour)}>
        {done ? <span className="badge badge-ok">{copy.gatepass.allMovedOut}</span> : progress.outstanding}
      </td>
    </tr>
  );
};

export const ColourRow: React.FC<ColourRowProps> = ({ article, colour, inputRef, onMove, readOnly, onQuantityChange, onStep }) => {
  if (readOnly) return <DocumentRow article={article} colour={colour} />;

  const label = `${articleWithGroup(article.article, article.groupName)} ${colour.colour} ${article.size}`;
  const value = colour.check.value;
  const selected = (value ?? 0) > 0;
  const fullyReserved = colour.available === 0;
  const errorId = `gp-qty-error-${colour.productVariantId}`;
  const rowClass = [selected ? "is-selected" : "", colour.check.error ? "has-error" : "", fullyReserved ? "is-reserved" : ""].filter(Boolean).join(" ");

  return (
    <tr className={rowClass || undefined}>
      <ColourCell colour={colour.colour} />
      <td className="num gp-colour-avail" data-testid={testId("current", article, colour)}>
        {colour.currentStock}
      </td>
      <td className="num gp-colour-reserved" data-testid={testId("reserved", article, colour)}>
        {colour.reserved}
      </td>
      <td className="num gp-colour-reflected" data-testid={testId("available", article, colour)}>
        <strong>{colour.reflected}</strong>
        {fullyReserved && <span className="gp-reserved-note">{copy.gatepass.fullyReserved}</span>}
      </td>
      <td className="gp-colour-qty">
        <div className="gp-qty">
          <div className="gp-qty-stepper">
            <button type="button" aria-label={copy.gatepass.decrease(label)} disabled={value === 0} onClick={() => onStep?.(colour.productVariantId, -1)}>
              −
            </button>
            <input
              ref={inputRef}
              type="text"
              inputMode="numeric"
              placeholder="0"
              aria-label={copy.gatepass.quantityFor(label)}
              aria-invalid={Boolean(colour.check.error)}
              aria-describedby={colour.check.error ? errorId : undefined}
              value={colour.text}
              onChange={(e) => onQuantityChange?.(colour.productVariantId, e.target.value)}
              onFocus={(e) => e.target.select()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "ArrowDown") {
                  e.preventDefault();
                  onMove(e.key === "Enter" && e.shiftKey ? -1 : 1);
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  onMove(-1);
                }
              }}
            />
            <button
              type="button"
              aria-label={copy.gatepass.increase(label)}
              disabled={value !== null && value >= colour.available}
              onClick={() => onStep?.(colour.productVariantId, 1)}
            >
              +
            </button>
          </div>
          <span className="gp-qty-max" aria-hidden="true">
            /{colour.available}
          </span>
        </div>
        {colour.check.error && (
          <div id={errorId} className="gp-qty-error" role="alert">
            ⚠ {colour.check.error}
          </div>
        )}
      </td>
    </tr>
  );
};
