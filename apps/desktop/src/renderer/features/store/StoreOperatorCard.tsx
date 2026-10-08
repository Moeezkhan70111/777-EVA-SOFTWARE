import React from "react";
import { copy } from "../../config/copy";
import type { StoreOperator } from "./storeOperators";
import { ArrowRightIcon, StoreDirectionIcon } from "./StoreIcons";

// One job on Store Station. Laid out like the Machine Program cards: a number badge standing
// proud of the corner (it is also the keyboard shortcut), a big picture, the job in large
// words, one short line, and Start along the bottom.
//
// The whole card is the button, so a new operator has one large target. In and Out differ by
// words and by the arrow in the picture, not by colour alone (R18).

interface StoreOperatorCardProps {
  operator: StoreOperator;
  onSelect: (operator: StoreOperator) => void;
  buttonRef?: (element: HTMLButtonElement | null) => void;
}

export const StoreOperatorCard: React.FC<StoreOperatorCardProps> = ({ operator, onSelect, buttonRef }) => (
  <button
    ref={buttonRef}
    type="button"
    className={`so-card so-card--${operator.direction}`}
    onClick={() => onSelect(operator)}
    data-testid={`store-operator-${operator.direction}`}
    aria-keyshortcuts={operator.key}
  >
    <span className="so-card-badge" aria-hidden="true">
      {operator.key}
    </span>

    <span className="so-card-icon">
      <StoreDirectionIcon direction={operator.direction} />
    </span>

    <span className="so-card-title">{operator.title}</span>
    <span className="so-card-role">{copy.store.operator}</span>
    <span className="so-card-line">{operator.line}</span>

    <span className="so-card-action">
      {copy.store.start}
      <ArrowRightIcon />
    </span>
  </button>
);
