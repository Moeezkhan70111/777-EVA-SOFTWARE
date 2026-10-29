import React from "react";
import { copy } from "../../../config/copy";
import type { StationScanRow } from "../../scanStation/scanStation";
import type { ScanOutcome } from "./scanOutcome";

// Under the scan zone (0.3.9): the batch's count as ONE compact row — the number, what it counts,
// and the quantity total on the right — and the packets scanned before the one in the zone, which is
// how an operator catches a double scan two packets back.

interface CountRowProps {
  count: number;
  /** "50 KG", or "—" before anything is in the batch. */
  quantity: string;
  /** The last scan was refused: the number greys and the row says it did not move. */
  unchanged: boolean;
}

export const CountRow: React.FC<CountRowProps> = ({ count, quantity, unchanged }) => {
  const label = copy.storeScan.inThisBatch(count);
  return (
    <div className={`sz-count${unchanged ? " sz-count--unchanged" : ""}`} data-testid="scan-count">
      <span className="sz-count-number">{count.toLocaleString()}</span>
      <span className="sz-count-label">{unchanged ? copy.storeScan.unchanged(label) : label}</span>
      <span className="sz-count-quantity">{quantity}</span>
    </div>
  );
};

/**
 * BEFORE THAT — up to three scans before the one the zone shows. After an accepted scan the newest
 * row IS that scan, so it is left out; after a refusal nothing new was added, so the list starts at
 * the newest.
 */
export const beforeThat = (rows: readonly StationScanRow[], outcome: ScanOutcome): StationScanRow[] => {
  const showing = outcome.kind === "accepted" && rows[0]?.qrId === outcome.code ? 1 : 0;
  return rows.slice(showing, showing + 3);
};

export const BeforeThat: React.FC<{ rows: readonly StationScanRow[] }> = ({ rows }) =>
  rows.length === 0 ? null : (
    <section className="sz-before" aria-label={copy.storeScan.beforeThat}>
      <h3 className="sp-marker">{copy.storeScan.beforeThat}</h3>
      <ol className="sz-before-list">
        {rows.map((row) => (
          <li key={row.key} className="sz-before-row">
            <span className="sz-before-code">{row.qrId}</span>
            <span className="sz-before-what">{row.product}</span>
          </li>
        ))}
      </ol>
    </section>
  );
