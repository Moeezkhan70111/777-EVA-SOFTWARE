import React from "react";
import { formatWholeMoney } from "../../app/format";
import { copy } from "../../config/copy";
import type { PartyBalanceState } from "./usePartyBalance";

// Who a document is for, with their current balance. Shared by the documents of the
// gatepass → bill flow (the `gp-party-*` styles are theirs); the bill adds its credit line.

/** What a document screen needs to know about a party — a Party Master row or the document's snapshot. */
export interface PartyFacts {
  partyName: string;
  partyCode: string;
  city?: string | null;
}

export const partyLine = (party: PartyFacts): string => [party.partyName, party.city].filter(Boolean).join(" · ");

const PartyIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <path d="M4 20h16M6 20V6l6-3 6 3v14M9 9h1M14 9h1M9 12h1M14 12h1M9 15h1M14 15h1" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Rupees, whole — a credit balance (the party has paid ahead) is marked as such. */
const formatBalance = (state: PartyBalanceState): string => {
  if (state.status === "loading" || state.status === "idle" || state.status === "hidden") return "…";
  if (state.status === "error") return copy.parties.balanceUnavailable;
  const amount = `Rs ${formatWholeMoney(Math.abs(state.value))}`;
  return state.value < 0 ? `${amount} Cr` : amount;
};

interface PartyCardProps {
  party: PartyFacts;
  balance: PartyBalanceState;
  /** A second row under the name and balance — the bill's credit position, for instance. */
  detail?: React.ReactNode;
}

export const PartyCard: React.FC<PartyCardProps> = ({ party, balance, detail }) => (
  <div className="gp-party-card" data-testid="party-card">
    <span className="gp-party-icon">
      <PartyIcon />
    </span>
    <div className="gp-party-who">
      <span className="gp-party-name">{party.partyName}</span>
      <span className="gp-party-meta">{[party.partyCode, party.city].filter(Boolean).join(" · ")}</span>
    </div>
    {/* Not shown at all off the Accounts holder: a balance there would be wrong (ledgerVisibility.ts). */}
    {balance.status !== "hidden" && (
      <div className="gp-party-balance">
        <span className="gp-party-meta">{copy.parties.currentBalance}</span>
        <strong data-testid="party-balance">{formatBalance(balance)}</strong>
      </div>
    )}
    {detail && <div className="gp-party-detail">{detail}</div>}
  </div>
);
