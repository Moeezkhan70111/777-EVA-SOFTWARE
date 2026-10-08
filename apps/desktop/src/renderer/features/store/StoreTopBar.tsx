import React from "react";
import { ArrowLeftIcon } from "./StoreIcons";

// The top of every store screen:
//
//   [← Change job]              MOVE IN
//                               OPERATOR
//
// No logo: the sidebar beside every screen already carries it. The page head sits on the same
// width as the cards below it: the way back on the left, the page's name centred and large, in
// the job's colour. Store Station passes no title — its own big "Store" heading is the head
// there. A screen with controls of its own (the split desk) gets them in a toolbar row above.

export type StoreTone = "in" | "out";

interface StoreTopBarProps {
  title?: string;
  /** A small line under the title, e.g. "Operator". */
  subtitle?: string;
  /** Colours the title: blue for Move In, amber for Move Out. */
  tone?: StoreTone;
  back?: { label: string; onClick: () => void };
  /** Controls in a row above the head — used by the split desk, which has no room for a big title. */
  toolbar?: React.ReactNode;
}

export const StoreTopBar: React.FC<StoreTopBarProps> = ({ title, subtitle, tone = "in", back, toolbar }) => (
  <>
    {toolbar ? <header className="so-top">{toolbar}</header> : null}

    {title ? (
      <div className={`so-head so-head--${tone}`}>
        <div className="so-head-side">
          {back ? (
            <button type="button" className="so-back" onClick={back.onClick}>
              <ArrowLeftIcon />
              {back.label}
            </button>
          ) : null}
        </div>
        <div className="so-head-title">
          <h1 className="so-head-name">{title}</h1>
          {subtitle ? <span className="so-head-sub">{subtitle}</span> : null}
        </div>
        {/* Balances the back button so the title stays exactly centred. */}
        <div className="so-head-side" aria-hidden="true" />
      </div>
    ) : null}
  </>
);
