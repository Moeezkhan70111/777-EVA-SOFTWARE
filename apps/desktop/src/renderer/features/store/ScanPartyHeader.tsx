import React from "react";
import { PartyTypeBadge } from "../parties/PartyTypeBadge";

// The top of a scan panel while a session is open (1 Nov 2026): who the session is with, in large
// type, and what kind of party it is, so the operator sees whose packets they are scanning at a
// glance.

interface ScanPartyHeaderProps {
  /** A few words above the name: "Receiving from". */
  eyebrow: string;
  name: string;
  /** The party's type as stored (SUPPLIER, CONTRACTOR, ...), when known. */
  partyType: string | undefined;
}

export const ScanPartyHeader: React.FC<ScanPartyHeaderProps> = ({ eyebrow, name, partyType }) => (
  <div className="ssn-scan-party" data-testid="scan-party">
    <div className="ssn-scan-party-text">
      <span className="ssn-scan-party-eyebrow">{eyebrow}</span>
      <strong className="ssn-scan-party-name">{name}</strong>
    </div>
    <PartyTypeBadge partyType={partyType} />
  </div>
);
