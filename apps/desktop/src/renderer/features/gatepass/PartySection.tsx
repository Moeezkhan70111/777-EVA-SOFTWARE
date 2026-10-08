import React, { useMemo } from "react";
import { copy } from "../../config/copy";
import type { Party } from "../../types/desktopApi";
import { PartyCard } from "../parties/PartyCard";
import { SearchSelect, type SelectOption } from "./SearchSelect";
import type { PartyBalanceState } from "../parties/usePartyBalance";

// Who the Gatepass is for (بل بنام), with the party's current balance once chosen, and the
// book's optional transport line (Bilty No. / Via / Remarks) kept compact underneath.

export interface TransportFields {
  biltyNumber: string;
  transportVia: string;
  remarks: string;
}

interface PartySectionProps {
  parties: Party[];
  loading: boolean;
  partyId: string;
  party: Party | null;
  balance: PartyBalanceState;
  transport: TransportFields;
  onPartyChange: (id: string) => void;
  onTransportChange: (patch: Partial<TransportFields>) => void;
}

export const PartySection: React.FC<PartySectionProps> = ({ parties, loading, partyId, party, balance, transport, onPartyChange, onTransportChange }) => {
  const options = useMemo<SelectOption[]>(
    () => parties.map((p) => ({ id: p.id, label: p.partyName, sub: [p.partyCode, p.city].filter(Boolean).join(" · ") })),
    [parties]
  );

  return (
    <section className="card gp-card gp-section" data-testid="gatepass-party-section">
      <h2 className="gp-section-title">{copy.gatepass.partySection}</h2>
      <SearchSelect
        id="gp-party"
        label={copy.gatepass.partyLabel}
        hideLabel
        placeholder={copy.gatepass.partyPlaceholder}
        options={options}
        value={partyId}
        onChange={onPartyChange}
        loading={loading}
        emptyText={parties.length === 0 ? copy.gatepass.partyEmpty : copy.gatepass.partyNoMatch}
        autoFocus
      />

      {party && <PartyCard party={party} balance={balance} />}

      <div className="gp-transport">
        <span className="gp-transport-label">{copy.gatepass.transportOptional}</span>
        <input
          className="form-input"
          type="text"
          aria-label={copy.gatepass.biltyNumber}
          placeholder={copy.gatepass.biltyNumber}
          maxLength={60}
          value={transport.biltyNumber}
          onChange={(e) => onTransportChange({ biltyNumber: e.target.value })}
        />
        <input
          className="form-input"
          type="text"
          aria-label={copy.gatepass.transportVia}
          placeholder={copy.gatepass.transportVia}
          maxLength={120}
          value={transport.transportVia}
          onChange={(e) => onTransportChange({ transportVia: e.target.value })}
        />
        <input
          className="form-input gp-transport-remarks"
          type="text"
          aria-label={copy.columns.remarks}
          placeholder={copy.columns.remarks}
          maxLength={240}
          value={transport.remarks}
          onChange={(e) => onTransportChange({ remarks: e.target.value })}
        />
      </div>
    </section>
  );
};
