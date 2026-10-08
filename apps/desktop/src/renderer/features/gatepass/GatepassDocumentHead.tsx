import React from "react";
import { copy } from "../../config/copy";
import type { Gatepass } from "../../types/desktopApi";
import { formatGatepassDate, formatGatepassDateTime } from "../../utils/gatepassPrint";
import { PartyCard } from "../parties/PartyCard";
import type { PartyBalanceState } from "../parties/usePartyBalance";

// The top of a stored Gatepass, read-only: the party (with today's balance), the book's
// header facts, how much of it Store Move Out has taken so far, and — when it was
// cancelled — who did it, when and why.

interface GatepassDocumentHeadProps {
  document: Gatepass;
  balance: PartyBalanceState;
}

/** "2 of 3 moved out" / "All moved out" — the store's progress on this document. */
export const describeMoveOutProgress = (document: Pick<Gatepass, "totalQuantity" | "dispatchedFromStoreQuantity" | "outstandingQuantity">): string =>
  document.outstandingQuantity <= 0 && document.totalQuantity > 0
    ? copy.gatepass.allMovedOut
    : copy.gatepass.movedOutOf(document.dispatchedFromStoreQuantity, document.totalQuantity);

export const GatepassDocumentHead: React.FC<GatepassDocumentHeadProps> = ({ document, balance }) => {
  const facts: Array<[string, string]> = [
    [copy.columns.date, formatGatepassDate(document.gatepassDate)],
    [copy.gatepass.preparedBy, document.createdBy ?? copy.common.none],
    [copy.gatepass.biltyNumber, document.biltyNumber ?? copy.common.none],
    [copy.gatepass.transportVia, document.transportVia ?? copy.common.none],
    [copy.gatepass.movedOut, describeMoveOutProgress(document)],
  ];
  if (document.remarks) facts.push([copy.columns.remarks, document.remarks]);

  return (
    <section className="card gp-card gp-section" data-testid="gatepass-document-head">
      {document.status === "CANCELLED" && (
        <div className="gp-alert gp-alert--warn" role="status" data-testid="gatepass-cancelled-banner">
          <strong>{copy.gatepass.cancelled}</strong> {formatGatepassDateTime(document.cancelledAt)} {copy.gatepass.by} {document.cancelledBy ?? copy.common.none}
          {document.cancelReason ? ` — ${document.cancelReason}` : ""}. {copy.gatepass.cancelledNote}
        </div>
      )}
      <PartyCard party={{ partyName: document.partyName, partyCode: document.partyCode, city: document.partyCity }} balance={balance} />
      <dl className="gp-doc-facts" data-testid="gatepass-document-facts">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt className="card-eyebrow">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
};
