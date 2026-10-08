import React from "react";
import { copy } from "../../config/copy";
import { BRAND_LOGO_URL } from "../../config/branding";
import { ArrowLeftIcon } from "./StoreIcons";

// The top of every store screen, in two rows:
//
//   [777 SEVEN logo]                                                   (profile menu)
//   [← Change job]              MOVE IN
//                               OPERATOR
//
// The logo row is the same everywhere. The page head sits on the same width as the cards
// below it: the way back on the left, the page's name centred and large, in the job's colour.
// Store Station passes no title — its own big "Store" heading is the head there.

export type StoreTone = "in" | "out";

interface StoreTopBarProps {
  title?: string;
  /** A small line under the title, e.g. "Operator". */
  subtitle?: string;
  /** Colours the title: blue for Move In, amber for Move Out. */
  tone?: StoreTone;
  back?: { label: string; onClick: () => void };
  /** Controls placed in the logo row itself — used by the split desk, which has no room for a big title. */
  toolbar?: React.ReactNode;
}

export const StoreTopBar: React.FC<StoreTopBarProps> = ({ title, subtitle, tone = "in", back, toolbar }) => (
  <>
    <header className="so-top">
      <img src={BRAND_LOGO_URL} alt={copy.app.brandLine} className="so-logo-img" />
      {toolbar}
    </header>

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
