import React, { useEffect, useRef, useState } from "react";
import type { ReturnScanResult } from "../../types/desktopApi";
import { copy } from "../../config/copy";
import { statusLabel } from "../../utils/storeScanner";
import { formatWholeMoney } from "../../app/format";

// The Return station's scanner overlay. It has one job the other scanners do not: a carton
// is never returned on the scan alone. The scan only LOOKS the carton up and shows who it
// went out to; the operator then confirms, and only that confirmation credits the customer.
//
// The four states a screen like this must handle (loading / empty / error / success) map here
// onto: scanning (idle), looking up (busy), a rejection, and a confirmed return.

export type ReturnPhase = "idle" | "busy" | "confirm" | "success" | "error";

export interface ReturnOverlayState {
  phase: ReturnPhase;
  /** The scanned value, kept so the confirmation sends exactly what was scanned. */
  rawScan: string;
  result: ReturnScanResult | null;
}

export const IDLE_OVERLAY: ReturnOverlayState = { phase: "idle", rawScan: "", result: null };

/** Big headline for each phase — the one place a return's wording is decided. */
const headline = (state: ReturnOverlayState): string => {
  if (state.phase === "idle") return copy.returns.readyToScan;
  if (state.phase === "busy") return copy.common.loading;
  if (state.phase === "confirm") return copy.returns.confirmTitle;
  if (state.phase === "success") return copy.returns.recorded;

  switch (state.result?.outcome) {
    case "ALREADY_RETURNED": return copy.returns.alreadyRecorded;
    case "NOT_DISPATCHED":   return copy.returns.notDispatched;
    case "NO_ATTRIBUTION":   return copy.returns.noAttribution;
    case "UNKNOWN_QR":       return copy.returns.neverProduced;
    case "INVALID_FORMAT":   return copy.returns.invalidFormat;
    default:                 return copy.returns.error;
  }
};

/**
 * Status is never carried by colour alone: every phase gets a symbol and a word, so the
 * screen still reads correctly in monochrome or to a screen reader (R18).
 */
const symbol = (phase: ReturnPhase): string =>
  phase === "success" ? "✓" : phase === "error" ? "⚠" : phase === "confirm" ? "?" : "▣";

/** idle/busy/confirm share the neutral skin; only a decided outcome is coloured. */
const skin = (phase: ReturnPhase): string => (phase === "success" ? "success" : phase === "error" ? "error" : "idle");

const Cell = ({ label, value, wide }: { label: string; value: string; wide?: boolean }) => (
  <div className={wide ? "scan-overlay-cell wide" : "scan-overlay-cell"}>
    <div className="scan-overlay-cell-label">{label}</div>
    <div className="scan-overlay-cell-value">{value || copy.common.none}</div>
  </div>
);

/** The carton itself — shown for every outcome that identified one. */
const CartonCells = ({ result }: { result: ReturnScanResult }) => (
  <div className="scan-overlay-result">
    <Cell label={copy.columns.article} value={result.article ?? ""} />
    <Cell label={copy.columns.color} value={result.color ?? ""} />
    <Cell label={copy.columns.size} value={result.size ?? ""} />
  </div>
);

/**
 * Who the carton went out to, read from its own dispatch. The operator never picks a party;
 * this panel is the whole of what they are asked to agree with.
 */
const AttributionPanel = ({ result }: { result: ReturnScanResult }) => {
  const a = result.attribution;
  if (!a) return null;
  return (
    <div className="scan-overlay-result">
      <Cell label={copy.returns.dispatchedTo} value={a.partyName} wide />
      <Cell label={copy.returns.saleVoucher} value={a.saleVoucherNumber ? `SV-${a.saleVoucherNumber}` : copy.common.none} />
      <Cell label={copy.returns.creditAmount} value={`Rs. ${formatWholeMoney(a.creditAmount)}`} />
      <Cell label={copy.returns.status} value={statusLabel(result.currentStatus)} />
    </div>
  );
};

/** After a return is recorded, and when one is scanned twice: what is still outstanding. */
const AwaitingStoreNote = () => (
  <p className="scan-overlay-note" role="status">
    {copy.returns.awaitingStoreIn}
  </p>
);

interface Props {
  state: ReturnOverlayState;
  onScan: (raw: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  onClose: () => void;
}

export const ReturnScanOverlay = ({ state, onScan, onConfirm, onCancel, onClose }: Props) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [typed, setTyped] = useState("");

  // While the operator is deciding, the keyboard belongs to the confirm button — a wedge
  // scanner firing mid-decision must not silently replace the carton being confirmed.
  const awaitingDecision = state.phase === "confirm";

  useEffect(() => {
    if (awaitingDecision) {
      confirmRef.current?.focus();
      return;
    }
    inputRef.current?.focus();
    const keepFocus = setInterval(() => {
      if (document.activeElement !== inputRef.current) inputRef.current?.focus();
    }, 150);
    return () => clearInterval(keepFocus);
  }, [awaitingDecision, state.phase]);

  const submit = (value: string) => {
    const raw = value.trim().toUpperCase();
    if (raw.length < 5) return;
    setTyped("");
    onScan(raw);
  };

  // Keyboard-wedge scanners do not all send Enter, so a complete-looking value is submitted
  // once the keystrokes stop. Same convention as the other scanning stations.
  useEffect(() => {
    if (awaitingDecision || typed.trim().length < 5) return;
    const timer = setTimeout(() => submit(typed), 150);
    return () => clearTimeout(timer);
  }, [typed, awaitingDecision]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key === "Enter") { event.preventDefault(); submit(typed); }
  };

  return (
    <div className={`scan-overlay ${skin(state.phase)}`} role="region" aria-label={copy.returns.title}>
      <button type="button" className="scan-overlay-close" onClick={onClose} aria-label={copy.common.close}>✕</button>

      <div className="scan-overlay-icon" aria-hidden="true">{symbol(state.phase)}</div>
      <div className="scan-overlay-status" role="status" aria-live="polite">{headline(state)}</div>

      {state.result && state.phase !== "idle" && <CartonCells result={state.result} />}
      {state.result && (state.phase === "confirm" || state.phase === "success") && <AttributionPanel result={state.result} />}

      {state.phase === "error" && state.result?.reason && (
        <p className="scan-overlay-note" role="alert">{state.result.reason}</p>
      )}
      {(state.phase === "success" || state.result?.outcome === "ALREADY_RETURNED") && <AwaitingStoreNote />}

      {awaitingDecision ? (
        <div className="scan-overlay-actions">
          <button ref={confirmRef} type="button" className="btn btn-primary btn-lg" onClick={onConfirm}>
            {copy.returns.confirm}
          </button>
          <button type="button" className="btn btn-lg" onClick={onCancel}>{copy.common.cancel}</button>
          <div className="scan-overlay-hint">{copy.returns.confirmHint}</div>
        </div>
      ) : (
        <div className="scan-overlay-input-area">
          <label className="sr-only" htmlFor="return-scan-input">{copy.scanning.scannerInput}</label>
          <input
            id="return-scan-input"
            ref={inputRef}
            className="scan-overlay-input"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={copy.scanning.scanNext}
            autoComplete="off"
            spellCheck={false}
            disabled={state.phase === "busy"}
          />
          <div className="scan-overlay-hint">{copy.scanning.refocus} · Esc</div>
        </div>
      )}
    </div>
  );
};
