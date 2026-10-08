import React from "react";
import { ArrowRightIcon } from "./StoreIcons";

// One action on an operator's screen: a wide rectangle with a picture on the left, what it
// does in big words, one short line, and an arrow. The whole card is the button.
//
// When the operator may not use it, the card stays visible but disabled and says why in words
// (`lockedNote`), so nobody wonders where a button went.

interface StoreActionCardProps {
  icon: React.ReactNode;
  title: string;
  line: string;
  onSelect: () => void;
  /** Why this action is unavailable to this operator. Set → the card is disabled. */
  lockedNote?: string | null;
  testId?: string;
}

export const StoreActionCard: React.FC<StoreActionCardProps> = ({ icon, title, line, onSelect, lockedNote, testId }) => (
  <button
    type="button"
    className={`so-action${lockedNote ? " so-action--locked" : ""}`}
    onClick={onSelect}
    disabled={Boolean(lockedNote)}
    data-testid={testId}
  >
    <span className="so-action-icon">{icon}</span>
    <span className="so-action-text">
      <span className="so-action-title">{title}</span>
      <span className="so-action-line">{lockedNote ?? line}</span>
    </span>
    {lockedNote ? null : (
      <span className="so-action-arrow" aria-hidden="true">
        <ArrowRightIcon />
      </span>
    )}
  </button>
);
