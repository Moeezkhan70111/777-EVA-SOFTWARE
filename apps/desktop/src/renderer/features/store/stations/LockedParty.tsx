import React from "react";
import { copy } from "../../../config/copy";
import type { Party } from "../../../types/desktopApi";
import { PartyTypeBadge } from "../../parties/PartyTypeBadge";

/** The party a running issue session is locked to (0.3.8): its name and type, and why it cannot be changed. */
export const LockedParty: React.FC<{ party: Party | undefined }> = ({ party }) => (
  <div className="mo-locked-party" data-testid="locked-party">
    <strong>{party ? `${party.partyCode} — ${party.partyName}` : "—"}</strong>
    <PartyTypeBadge partyType={party?.partyType} />
    <p className="field-help">🔒 {copy.moveOut.scanPartyLocked}</p>
  </div>
);
