import React, { useRef, useEffect } from "react";
import { copy } from "../../config/copy";
import { formatTime } from "../../utils/dates";

export interface ScanState {
  status: "idle" | "success" | "error";
  message: string;
  qrId?: string;
  article?: string;
  color?: string;
  size?: string;
  ts?: string;
  productionCount?: number;
}

export const ProductionScannerPanel = ({
  scanState,
  scanInput,
  onChange,
  onSubmit,
}: {
  scanState: ScanState;
  scanInput: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  // Re-focus after each scan
  useEffect(() => {
    if (scanState.status !== "idle") {
      inputRef.current?.focus();
    }
  }, [scanState.status]);

  const statusLabel =
    scanState.status === "idle"    ? "Ready to Scan" :
    scanState.status === "success" ? "✓  Accepted"    :
                                     "✗  Rejected";

  return (
    <div className="scanner-wrap">
      {/* Counter */}
      <div className="scan-counter">
        <div className="scan-counter-label">Today's Production</div>
        <div className="scan-counter-value">{scanState.productionCount ?? 0}</div>
      </div>

      {/* Status indicator */}
      <div className={`scan-status-bar ${scanState.status}`}>
        {statusLabel}
      </div>

      {/* Input */}
      <div className="scan-input-row">
        <input
          ref={inputRef}
          autoFocus
          value={scanInput}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); onSubmit(); }
          }}
          placeholder="Scan QR code or type ARTICLE_COLOR_SIZE_SERIAL"
          aria-label={copy.scanning.scannerInput}
        />
        <button type="button" className="btn btn-primary btn-lg" onClick={onSubmit}>
          Process
        </button>
      </div>

      {/* Result detail */}
      {scanState.status !== "idle" && (
        <div className="scan-result-card">
          <p className="scan-result-message">{scanState.message}</p>
          <div className="scan-detail-grid">
            {[
              { label: copy.columns.article,   value: scanState.article },
              { label: copy.columns.color,     value: scanState.color },
              { label: copy.columns.size,      value: scanState.size },
              { label: "QR ID",     value: scanState.qrId },
              { label: copy.columns.timestamp, value: scanState.ts ? formatTime(scanState.ts) : undefined },
            ].map(({ label, value }) => (
              <div className="scan-detail-item" key={label}>
                <div className="scan-detail-label">{label}</div>
                <div className="scan-detail-value">{value ?? "—"}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
