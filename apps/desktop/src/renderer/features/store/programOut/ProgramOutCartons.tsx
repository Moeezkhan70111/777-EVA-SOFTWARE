import React from "react";
import { copy } from "../../../config/copy";
import { formatDateTime } from "../../../utils/dates";
import type { IssuedProgramPacket, MachineProgramIssueBatchRow } from "../../../types/desktopApi";
import { cartonRunLabel, cartonsFor, formatQuantity, type CartonRun, type PrintedCartonRun } from "./programOut";

// The two lists beside the scanner: the cartons the machine owes back, and what has left.
//
//   Cartons to label                 1 DOZEN out is 2 cartons of 6 pairs
//     SK12 / 7/10 / BLACK RED        8 cartons   [Print Carton QR]
//     ✓ Printed · SK12_BLACKRED_7/10_000001 → …_000008
//
//   Already issued                   every packet that has left for this program
//     RM_6_558_1   SK12 BLACK RED    2 DOZEN   4 cartons
//
// Uppers going out ARE cartons coming back, so the carton list is built from what was issued and
// never typed. A packet whose cartons cannot be worked out — an upper with no colour on it — says
// so in its own words instead of being folded into a run that would print the wrong identity.

interface CartonRunListProps {
  runs: CartonRun[];
  printed: PrintedCartonRun[];
  /** The run being generated right now, by key, so only its own button says so. */
  printingKey: string | null;
  onPrint: (run: CartonRun) => void;
  /** Packets whose cartons the main process could not work out, with its reason. */
  blocked: IssuedProgramPacket[];
}

export const CartonRunList: React.FC<CartonRunListProps> = ({ runs, printed, printingKey, onPrint, blocked }) => (
  <section className="mpo-batch" aria-label={copy.programOut.cartonTitle}>
    <header className="mpo-batch-head">
      <h3 className="mpo-batch-title">{copy.programOut.cartonTitle}</h3>
    </header>
    <p className="mpo-batch-note mpo-batch-note--plain">{copy.programOut.cartonNote}</p>

    {runs.length === 0 && printed.length === 0 && blocked.length === 0 ? (
      <p className="mpo-batch-empty">{copy.programOut.cartonEmpty}</p>
    ) : null}

    {runs.length > 0 ? (
      <ul className="mpo-batch-list">
        {runs.map((run) => (
          <li className="mpo-carton-row" key={run.key}>
            <span className="mpo-carton-what">{cartonRunLabel(run)}</span>
            <span className="mpo-batch-qty">{copy.programOut.cartonCount(run.cartons)}</span>
            <button
              type="button"
              className="btn btn-primary mpo-carton-print"
              onClick={() => onPrint(run)}
              disabled={printingKey !== null}
              aria-label={copy.programOut.cartonPrintLabel(run.cartons, cartonRunLabel(run))}
            >
              {printingKey === run.key ? copy.programOut.cartonPrinting : copy.programOut.cartonPrint}
            </button>
          </li>
        ))}
      </ul>
    ) : null}

    {blocked.length > 0 ? (
      <ul className="mpo-carton-blocked">
        {blocked.map((packet) => (
          <li key={packet.qrId} role="alert">
            ⚠ {packet.cartonNote}
          </li>
        ))}
      </ul>
    ) : null}

    {printed.length > 0 ? (
      <ul className="mpo-carton-printed">
        {printed.map((run) => (
          <li key={run.key}>
            <span className="mpo-carton-what">{run.label}</span>
            <span className="mpo-carton-range">{copy.programOut.cartonPrinted(run.range)}</span>
          </li>
        ))}
      </ul>
    ) : null}
  </section>
);

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
