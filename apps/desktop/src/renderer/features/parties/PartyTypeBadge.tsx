import React from "react";
import { copy } from "../../config/copy";
import { partyTypeLabel } from "./partyOption";
import { partyTypeLook } from "./partyTypeLook";

// What kind of party this is -- a supplier, a contractor -- shown beside a party wherever one is
// chosen for a store movement (Move In, Move Out, Manual Entry). Said in words, never by colour
// alone (R18): the blue box or green hard hat (1 Nov 2026, as in the party pickers' rows) only
// repeats the word. Nothing is shown for a party not chosen yet.

interface PartyTypeBadgeProps {
  /** The party's type as stored (SUPPLIER, CONTRACTOR, ...), or undefined when none is chosen. */
  partyType: string | undefined;
}

export const PartyTypeBadge: React.FC<PartyTypeBadgeProps> = ({ partyType }) => {
  if (!partyType) return null;
  const label = partyTypeLabel(partyType);
  const look = partyTypeLook(partyType);
  return (
    <span
      className={`badge badge-${look.badgeTone ?? "info"} party-type-badge`}
      aria-label={copy.parties.typeBadgeName(label)}
      data-testid="party-type-badge"
    >
      {look.badgeIcon ? <span className="party-type-badge-icon" aria-hidden="true">{look.badgeIcon}</span> : null}
      {label}
    </span>
  );
};
