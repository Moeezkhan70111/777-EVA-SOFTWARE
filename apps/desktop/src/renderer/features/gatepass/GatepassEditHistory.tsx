import React from "react";
import { copy } from "../../config/copy";
import type { Gatepass } from "../../types/desktopApi";
import { formatGatepassDateTime } from "../../utils/gatepassPrint";
import { dozensText } from "./gatepassDraft";

// What an edited gatepass was before each edit (local migration 118), newest first, read-only: who replaced it, when,
// why, and what it carried. Quantities are kept in cartons and read in dozens, like everything on the gatepass.

export const GatepassEditHistory: React.FC<{ document: Gatepass }> = ({ document }) => {
  if (document.versions.length === 0) return null;
  const versions = [...document.versions].reverse();
  return (
    <section className="card gp-card gp-history" data-testid="gatepass-edit-history" aria-label={copy.gatepass.historyTitle}>
      <span className="card-eyebrow">{copy.gatepass.historyTitle}</span>
      {document.editedBy && document.editedAt ? (
        <p className="gp-party-meta">{copy.gatepass.editedLine(document.versions.length, document.editedBy, formatGatepassDateTime(document.editedAt))}</p>
      ) : null}
      <ol className="gp-history-list">
        {versions.map((version) => (
          <li key={version.versionNo} className="gp-history-item" data-testid={`gatepass-version-${version.versionNo}`}>
            <div className="gp-history-head">
              <strong>{copy.gatepass.historyVersion(version.versionNo)}</strong>
              <span>{copy.gatepass.historyTotal(dozensText(version.totalQuantity))}</span>
            </div>
            <p className="gp-party-meta">{copy.gatepass.historyReplaced(version.replacedBy, formatGatepassDateTime(version.replacedAt), version.reason)}</p>
            <p className="gp-party-meta">{version.partyName}</p>
            <ul className="gp-history-lines">
              {version.lines.map((line) => (
                <li key={line.productVariantId}>
                  {line.article} · {line.size} · {line.color} — {dozensText(line.quantity)} DZN
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </section>
  );
};
