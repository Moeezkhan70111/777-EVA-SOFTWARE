import React from "react";
import { copy } from "../../config/copy";
import { formatWholeMoney } from "../../app/format";
import { formatDate } from "../../utils/dates";
import { balancePosition, limitUse } from "./ledgerFigures";

// THE CURRENT BALANCE: the one figure the page is for, alone in the blue (von Restorff, serial position). Its position
// is said in words beside an icon, never by colour alone (R18). It is the whole balance: the imported ledger and the
// ERP's entries as one (owner, 25 Nov 2026: "there is no old and new"). Over the balance limit it carries a badge.

const text = copy.customerLedger;
const day = (iso: string) => formatDate(iso, iso);

const PositionIcon: React.FC<{ position: string }> = ({ position }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {position === "RECEIVABLE" && <path d="M12 5v14M6 13l6 6 6-6" />}
    {position === "ADVANCE" && <path d="M12 19V5M6 11l6-6 6 6" />}
    {position === "SETTLED" && <path d="M6 12.5l4 4 8-9" />}
  </svg>
);

interface BalanceHeroProps {
  closingBalance: number;
  toDate: string;
  refreshing: boolean;
  limit: number | null;
}

export const BalanceHero: React.FC<BalanceHeroProps> = ({ closingBalance, toDate, refreshing, limit }) => {
  const position = balancePosition(closingBalance);
  const over = (limitUse(limit, closingBalance)?.leftRupees ?? 0) < 0;
  return (
    <section className="cl-hero" data-position={position} aria-label={text.balanceLabel} aria-busy={refreshing || undefined}>
      <span className="cl-hero-label">{text.balanceLabel} <small>{text.asOf(day(toDate))}</small></span>
      {over && <span className="cl-hero-badge">⚠ {text.overLimit}</span>}
      <strong className="cl-hero-figure">Rs. {formatWholeMoney(Math.abs(closingBalance))}</strong>
      <span className="cl-hero-position"><PositionIcon position={position} /> {text.position[position]} · {text.positionHint[position]}</span>
    </section>
  );
};
