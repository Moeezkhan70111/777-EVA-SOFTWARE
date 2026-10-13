import React from "react";
import { copy } from "../../../config/copy";
import { formatDateTime } from "../../../utils/dates";
import type { MachineProgramIssueBatchRow } from "../../../types/desktopApi";
import { cartonsFor, formatQuantity } from "./programOut";

// Already issued — every packet that has left the store for this program:
//
//   Already issued                   every packet that has left for this program
//     RM_6_558_1   SK12 BLACK RED    2 DOZEN   4 cartons
//
// The cartons owed back for them are labelled in Cartons to label (CartonLabels.tsx).

/**
 * Every packet that has left the store for this program, flattened out of the saved batches.
 *
 * Read back from the event log, so it is the same list whoever opens the program and whenever —
 * not just what this sitting happened to scan.
 */
export const IssuedPacketList: React.FC<{ history: MachineProgramIssueBatchRow[] }> = ({ history }) => {
  const rows = history.flatMap((row) =>
    row.packets.map((packet) => ({ ...packet, by: row.batch.issuedBy ?? "—", batchId: row.batch.id }))
  );

  return (
    <section className="mpo-history" aria-label={copy.programOut.historyTitle}>
      <header className="mpo-batch-head">
        <h3 className="mpo-batch-title">{copy.programOut.historyTitle}</h3>
      </header>
      <p className="mpo-batch-note mpo-batch-note--plain">{copy.programOut.historyNote}</p>
      {rows.length === 0 ? (
        <p className="mpo-batch-empty">{copy.programOut.historyEmpty}</p>
      ) : (
        <ul className="mpo-history-list">
          {rows.map((row) => {
            const cartons = cartonsFor(row.quantity, row.unitCode);
            return (
              <li className="mpo-history-row" key={`${row.batchId}:${row.qrId}`}>
                <span className="mpo-mono">{row.qrId}</span>
                <span className="mpo-batch-material">{row.itemDisplayName}</span>
                <span className="mpo-batch-qty">{formatQuantity(row.quantity, row.unitCode)}</span>
                <span className="mpo-history-cartons">{cartons == null ? "" : copy.programOut.cartonCount(cartons)}</span>
                <span className="mpo-history-meta">{copy.programOut.historyPacket(row.by, formatDateTime(row.issuedAt))}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};
