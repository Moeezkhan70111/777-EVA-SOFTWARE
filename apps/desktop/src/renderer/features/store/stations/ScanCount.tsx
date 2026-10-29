import React from "react";
import { copy } from "../../../config/copy";
import type { StationScanRow } from "../../scanStation/scanStation";

// Under the scan zone: how many packets the session holds, big — and the last three scans, which is
// how an operator catches a double scan two packets back.

interface ScanCountProps {
  count: number;
  /** "packets received" / "packets issued". */
  label: string;
  /** The last scan was refused: the number greys out and says it did not move. */
  unchanged: boolean;
}

export const ScanCount: React.FC<ScanCountProps> = ({ count, label, unchanged }) => (
  <div className={`sz-count${unchanged ? " sz-count--unchanged" : ""}`} data-testid="scan-count">
    <span className="sz-count-number">{count.toLocaleString()}</span>
    <span className="sz-count-label">{unchanged ? copy.storeScan.unchanged(label) : label}</span>
  </div>
);

export const LastScans: React.FC<{ rows: readonly StationScanRow[] }> = ({ rows }) =>
  rows.length === 0 ? null : (
    <section className="sz-last" aria-label={copy.storeScan.lastScans}>
      <h3 className="sz-last-title">{copy.storeScan.lastScans}</h3>
      <ol className="sz-last-list">
        {rows.slice(0, 3).map((row) => (
          <li key={row.key} className="sz-last-row">
            <span className="sz-last-code">{row.qrId}</span>
            <span className="sz-last-what">{row.product}</span>
          </li>
        ))}
      </ol>
    </section>
  );
