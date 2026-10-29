import React from "react";
import { copy } from "../../../config/copy";
import { PartyTypeBadge } from "../../parties/PartyTypeBadge";
import { quantityTotalLine, type StoreVoucherMaterial } from "../../rawMaterial/storeVoucher";

// The open session on a scan rail: who it is with and what kind of party, its number, and what it
// holds — packets, and quantity per unit, totalled the same way the printed slip totals them.

interface RailSessionCardProps {
  /** Who the session is with. Left out where the rail already names the party (Scan out's lock). */
  party?: { name: string | null; type: string | undefined };
  code: string;
  packets: number;
  byMaterial: StoreVoucherMaterial[];
  /** "Received" / "Issued". */
  countLabel: string;
}

export const RailSessionCard: React.FC<RailSessionCardProps> = ({ party, code, packets, byMaterial, countLabel }) => (
  <div className="sp-session" data-testid="rail-session">
    <span className="sp-session-party">{party ? (party.name ?? "—") : null}</span>
    <span className="sp-session-code" data-testid="session-code">
      {code}
    </span>
    {party ? (
      <span>
        <PartyTypeBadge partyType={party.type} />
      </span>
    ) : null}
    <dl className="sp-session-figures">
      <div>
        <dt>{countLabel}</dt>
        <dd data-testid="received-count">{copy.storeStation.packets(packets)}</dd>
      </div>
      <div>
        <dt>{copy.storePage.quantity}</dt>
        <dd>{byMaterial.length > 0 ? quantityTotalLine(byMaterial) : "—"}</dd>
      </div>
    </dl>
  </div>
);
