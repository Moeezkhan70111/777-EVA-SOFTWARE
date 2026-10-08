import React, { useCallback, useEffect, useState } from "react";
import { useDesktopApi } from "../hooks/useDesktopApi";
import type { SaleReturnRow } from "../types/desktopApi";
import { useNotifications } from "../state/NotificationsContext";
import { playScanSound } from "../utils/playScanSound";
import { formatWholeMoney } from "../app/format";
import { formatTime, toIsoDate } from "../utils/dates";
import { copy } from "../config/copy";
import { IDLE_OVERLAY, ReturnScanOverlay } from "../features/returns/ReturnScanOverlay";
import type { ReturnOverlayState } from "../features/returns/ReturnScanOverlay";

// The Return station.
//
// A carton is returned in TWO steps, and this screen only performs the first:
//
//   1. scan  → look the carton up and show who it went out to (nothing is written)
//      confirm → credit that customer, carton becomes ON GATE
//   2. later, the carton physically reaches the store and ordinary Store Scanning
//      receives it. Only then does it count as stock again.
//
// The operator never selects a party: it comes from the carton's own dispatch event.

export const LiveReturnPage = () => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const [overlay, setOverlay] = useState<ReturnOverlayState>(IDLE_OVERLAY);
  const [showOverlay, setShowOverlay] = useState(true);
  const [returns, setReturns] = useState<SaleReturnRow[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [loading, setLoading] = useState(true);

  /** Today's recorded returns, read back from the database rather than kept in the page. */
  const loadReturns = useCallback(async () => {
    try {
      const today = toIsoDate();
      const rows = await api.listSaleReturns({ fromDate: today, toDate: today });
      setReturns(Array.isArray(rows) ? rows : []);
      setLoadError(false);
    } catch (error) {
      console.error("[Return] failed to load today's returns", error);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void loadReturns(); }, [loadReturns]);

  const reject = (state: ReturnOverlayState, title: string) => {
    playScanSound("error");
    setOverlay(state);
    push("error", title, state.result?.reason ?? copy.returns.error);
  };

  /** Step one: look the carton up. Read-only — a mis-scan costs nothing. */
  const handleScan = async (raw: string) => {
    playScanSound("beep");
    setOverlay({ phase: "busy", rawScan: raw, result: null });

    try {
      const result = await api.returnLookup(raw);

      if (!result.accepted) {
        reject({ phase: "error", rawScan: raw, result }, copy.returns.error);
        return;
      }

      // Accepted means "this carton can be returned" — not that it has been.
      setOverlay({ phase: "confirm", rawScan: raw, result });
    } catch (error) {
      console.error("[Return] lookup failed", error);
      push("error", copy.toast.error, error instanceof Error ? error.message : copy.common.unknownError);
      setOverlay(IDLE_OVERLAY);
    }
  };

  /** Step two: the operator agrees with what is on screen. This is what credits the party. */
  const handleConfirm = async () => {
    const raw = overlay.rawScan;
    if (!raw) return;
    setOverlay((current) => ({ ...current, phase: "busy" }));

    try {
      const result = await api.returnScan(raw);

      if (!result.accepted) {
        reject({ phase: "error", rawScan: raw, result }, copy.returns.alreadyRecorded);
        return;
      }

      playScanSound("success");
      setOverlay({ phase: "success", rawScan: raw, result });
      push(
        "success",
        copy.returns.recorded,
        `${copy.returns.creditedToast(result.attribution?.partyName ?? "")} · ${copy.returns.awaitingStoreInShort}`
      );
      await loadReturns();
    } catch (error) {
      console.error("[Return] confirm failed", error);
      push("error", copy.toast.error, error instanceof Error ? error.message : copy.common.unknownError);
      setOverlay(IDLE_OVERLAY);
    }
  };

  // A decided outcome clears itself so the next carton can be scanned straight away.
  useEffect(() => {
    if (overlay.phase !== "success" && overlay.phase !== "error") return;
    const timer = setTimeout(() => setOverlay(IDLE_OVERLAY), overlay.phase === "success" ? 2500 : 4000);
    return () => clearTimeout(timer);
  }, [overlay.phase, overlay.rawScan]);

  const awaiting = returns.filter((row) => row.awaitingStoreIn).length;

  return (
    <div className="page-content">
      {showOverlay && (
        <ReturnScanOverlay
          state={overlay}
          onScan={handleScan}
          onConfirm={handleConfirm}
          onCancel={() => setOverlay(IDLE_OVERLAY)}
          onClose={() => setShowOverlay(false)}
        />
      )}

      <h1 className="page-title">{copy.returns.title}</h1>

      <div className="kpi-grid">
        <div className="kpi-card accent">
          <div className="kpi-label">{copy.returns.todaysReturns}</div>
          <div className="kpi-value">{returns.length}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">{copy.returns.awaitingCount}</div>
          <div className="kpi-value">{awaiting}</div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <div className="card-title">{copy.returns.feedTitle}</div>
          {!showOverlay && (
            <button type="button" className="btn" onClick={() => setShowOverlay(true)}>
              {copy.returns.title}
            </button>
          )}
        </div>

        <ReturnsFeed loading={loading} error={loadError} rows={returns} onRetry={() => void loadReturns()} />
      </div>
    </div>
  );
};

/** The four states every asynchronous list has to answer for (R12). */
const ReturnsFeed = ({
  loading,
  error,
  rows,
  onRetry,
}: {
  loading: boolean;
  error: boolean;
  rows: SaleReturnRow[];
  onRetry: () => void;
}) => {
  if (loading) return <div className="empty-state">{copy.common.loading}</div>;

  if (error) {
    return (
      <div className="empty-state">
        <p>{copy.states.loadFailedBody}</p>
        <button type="button" className="btn" onClick={onRetry}>{copy.common.retry}</button>
      </div>
    );
  }

  if (rows.length === 0) return <div className="empty-state">{copy.returns.feedEmpty}</div>;

  return (
    <div className="live-feed-list">
      {rows.map((row) => (
        <div key={row.id} className="live-feed-item">
          <div className={row.awaitingStoreIn ? "live-feed-dot warn" : "live-feed-dot ok"} aria-hidden="true" />
          <div>
            <strong>{row.article}</strong> · {row.color} · {row.size}
            <div className="live-feed-sub">
              {row.partyName}
              {row.saleVoucherNumber ? ` · SV-${row.saleVoucherNumber}` : ""}
              {` · Rs. ${formatWholeMoney(row.creditAmount)}`}
              {/* Never colour alone: the waiting state is spelled out (R18). */}
              {row.awaitingStoreIn ? ` · ${copy.returns.awaitingStoreInShort}` : ""}
            </div>
          </div>
          <div className="live-feed-meta">
            {row.returnNumber} · {formatTime(row.recordedAt)}
          </div>
        </div>
      ))}
    </div>
  );
};
