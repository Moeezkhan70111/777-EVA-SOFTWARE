import React from "react";
import { copy } from "../../config/copy";

// What kind of party this is -- a supplier, a contractor -- shown beside a party wherever one is
// chosen for a store movement (Move In, Move Out, Manual Entry). Said in words, never by colour
// alone (R18). Nothing is shown for a party not chosen yet.

interface PartyTypeBadgeProps {
  /** The party's type as stored (SUPPLIER, CONTRACTOR, ...), or undefined when none is chosen. */
  partyType: string | undefined;
}

export const PartyTypeBadge: React.FC<PartyTypeBadgeProps> = ({ partyType }) => {
  if (!partyType) return null;
  const label = copy.parties.typeLabel[partyType] ?? partyType;
  return (
    <span className="badge badge-info party-type-badge" aria-label={copy.parties.typeBadgeName(label)} data-testid="party-type-badge">
      {label}
    </span>
  );
};
