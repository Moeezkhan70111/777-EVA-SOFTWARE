import React from "react";
import { PartyTypeBadge } from "../parties/PartyTypeBadge";

// The party a running scan session is locked to: its name and type, and why it cannot be changed.
// The same on Move In and Move Out.

interface LockedPartyProps {
  name: string | undefined;
  partyType: string | undefined;
  note: string;
}

export const LockedParty: React.FC<LockedPartyProps> = ({ name, partyType, note }) => (
  <div className="mo-locked-party" data-testid="locked-party">
    <strong>{name ?? "—"}</strong>
    <PartyTypeBadge partyType={partyType} />
    <p className="field-help">🔒 {note}</p>
  </div>
);
