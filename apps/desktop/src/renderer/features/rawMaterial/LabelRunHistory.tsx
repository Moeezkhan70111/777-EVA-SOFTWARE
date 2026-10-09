import React from "react";
import type { RawMaterialMovementConfigRow, RawMaterialQrBatchRow } from "../../types/desktopApi";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { formatDate, formatTime } from "../../utils/dates";
import { downloadCsv, exportFileName } from "../../utils/exportFile";
import { buildQrBatchSheet } from "./rawMaterialExports";
import { packName, packetContentsLabel } from "./rawMaterial";

// RECENT GENERATIONS — the label runs this store has registered, newest first, each with the
// three things that can be done to it: put it back on the form, print it again, or erase it.
//
// Lifted out of LabelsTab when the generator learned to register several materials at once:
// the form above it grew, and the history is the same list whatever the form does.

interface LabelRunHistoryProps {
  history: RawMaterialQrBatchRow[];
  loading: boolean;
  error: string | null;
  onReload: () => void;
  configByItem: Map<string, RawMaterialMovementConfigRow>;
  /** The stock unit a material is counted in — for "PACKET of 5 DOZEN". */
  unitCodeOf: (itemId: string) => string;
  /** Rebuilds a label identity the same way the generator wrote it. */
  identityAt: (partyCode: string, itemCode: string, sequence: number) => string;
  /** Whether a batch's supplier and material are both still known, so it can be reused. */
  canReuse: (batch: RawMaterialQrBatchRow) => boolean;
  onUseAgain: (batch: RawMaterialQrBatchRow) => void;
  onReprint: (batch: RawMaterialQrBatchRow) => void;
  onErase: (batch: RawMaterialQrBatchRow) => void;
}

export const LabelRunHistory: React.FC<LabelRunHistoryProps> = ({
  history,
  loading,
  error,
  onReload,
  configByItem,
  unitCodeOf,
  identityAt,
  canReuse,
  onUseAgain,
  onReprint,
  onErase,
}) => (
  <div className="card">
    <div className="card-header">
      <h2 className="card-title">Recent generations</h2>
      <div className="qr-history-header-side">
        <span className="qr-history-count">
          {history.length === 0 ? "No batches yet" : `Last ${history.length.toLocaleString()} ${history.length === 1 ? "batch" : "batches"}`}
        </span>
        {history.length > 0 ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => downloadCsv(exportFileName("raw-material-label-batches"), buildQrBatchSheet(history, identityAt))}
          >
            Export batches (Excel)
          </button>
        ) : null}
      </div>
    </div>

    {loading ? (
      <StateView kind="loading" compact message="Loading recent generations…" />
    ) : error ? (
      <StateView kind="error" compact message={error} onRetry={onReload} />
    ) : history.length === 0 ? (
      <StateView
        kind="empty"
        compact
        title="No codes generated yet"
        hint="Pick a supplier and raw material above to register your first batch."
      />
    ) : (
      <div className="table-container">
        <table className="data-table qr-history-table">
          <thead>
            <tr>
              <th scope="col">{copy.columns.supplier}</th>
              <th scope="col">Raw Material</th>
              <th scope="col">Range</th>
              <th scope="col" className="qr-num-col" style={{ textAlign: "center" }}>
                {copy.columns.qty}
              </th>
              <th scope="col">Generated</th>
              <th scope="col" aria-label={copy.columns.actions} />
            </tr>
          </thead>
          <tbody>
            {history.map((batch) => {
              const generatedAt = new Date(batch.createdAt);
              const reusable = canReuse(batch);
              return (
                <tr key={batch.id}>
                  <td>
                    <strong>{batch.partyName}</strong>
                  </td>
                  <td>
                    {batch.itemDisplayName}
                    {batch.packingQuantity != null ? (
                      <span className="qr-generated-time">
                        {" "}· {packName(configByItem.get(batch.itemId))} of {packetContentsLabel(batch.packingQuantity, unitCodeOf(batch.itemId))}
                      </span>
                    ) : null}
                  </td>
                  <td className="qr-range-cell cell-mono">
                    <code>{identityAt(batch.partyCode, batch.itemCode, batch.startSequence)}</code>
                    <span className="qr-range-sep">→</span>
                    <code>{identityAt(batch.partyCode, batch.itemCode, batch.endSequence)}</code>
                  </td>
                  <td className="qr-num-col">{batch.quantity.toLocaleString()}</td>
                  <td>
                    <div className="qr-generated-cell">
                      <span className="qr-generated-date">{formatDate(generatedAt)}</span>
                      <span className="qr-generated-time">
                        {formatTime(generatedAt)}
                        {batch.createdBy ? ` · ${batch.createdBy}` : ""}
                      </span>
                      {batch.requestedBy ? <span className="qr-generated-time">for {batch.requestedBy}</span> : null}
                    </div>
                  </td>
                  <td className="qr-row-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={!reusable}
                      title={reusable ? "Put this combination back on the form" : "This supplier or material is no longer active"}
                      onClick={() => onUseAgain(batch)}
                    >
                      Use again
                    </button>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => onReprint(batch)}>
                      🖨 Print
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm rm-run-erase" title={copy.removal.deleteRun} onClick={() => onErase(batch)}>
                      {copy.actions.delete}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    )}
  </div>
);
