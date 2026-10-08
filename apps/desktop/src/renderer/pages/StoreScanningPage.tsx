import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useDesktopApi } from "../hooks/useDesktopApi";
import type {
  QrDetail,
  StoreEntryScanResult,
  StoreReceivedRow,
  StoreReceivingSession,
  StoreReceivingSessionSummary,
} from "../types/desktopApi";
import { useNotifications } from "../state/NotificationsContext";
import { playScanSound } from "../utils/playScanSound";
import {
  formatDateTime,
  formatTime,
  isCompleteQr,
  productLabel,
  sanitizeScanInput,
  statusLabel,
} from "../utils/storeScanner";
import { QrDetailDrawer } from "./QrManagementPage";
import { copy } from "../config/copy";
import {
  LastScanCard,
  PlusIcon,
  RecentScansCard,
  SCAN_STATION_CSS,
  ScanPanel,
  SessionCard,
  StationBlocked,
  StationToolbar,
} from "../features/scanStation/scanStation";
import type { ScanStationResult, StationScanRow } from "../features/scanStation/scanStation";

// Store Scanning — the store operator's receiving station.
//
//   open the screen → scanner is focused → scan carton → ✓ RECEIVED → ready for the next
//
// Every scan goes straight to the main process (erp:store-entry-scan), which owns the
// PRODUCTION / STOCK → IN STORE transition, the STORE_ENTRY event and the stock move.
// This page never decides anything about a QR; it only shows what the business layer
// answered and keeps the scanner ready. The scanner-input conventions and status
// vocabulary are shared with Store Move Out (../utils/storeScanner).

const RECENT_LIMIT = 12;
/** How long a result stays on screen before the station returns to READY (a new scan overrides it at once). */
const RESULT_HOLD_MS = 2500;

// ─── Feedback model ──────────────────────────────────────────────────────────

type FeedbackTone = "idle" | "success" | "warn" | "error";

interface Feedback {
  tone: FeedbackTone;
  title: string;
  message: string;
  result: StoreEntryScanResult | null;
  /** Monotonic counter so an identical repeat scan still restarts the hold timer. */
  seq: number;
}

const IDLE: Feedback = {
  tone: "idle",
  title: "READY TO SCAN",
  message: "Scan the production carton",
  result: null,
  seq: 0,
};


/** Turns the business layer's answer into what the operator reads. Text always, never colour alone. */
const feedbackFor = (result: StoreEntryScanResult, seq: number): Feedback => {
  switch (result.outcome) {
    case "RECEIVED":
      return {
        tone: "success",
        title: "✓ RECEIVED",
        message: "Carton received into the store",
        result,
        seq,
      };
    case "ALREADY_IN_STORE":
      return {
        tone: "warn",
        title: "⚠ ALREADY IN STORE",
        message: "This carton has already been received.",
        result,
        seq,
      };
    case "UNKNOWN_QR":
      return {
        tone: "error",
        title: "✕ UNKNOWN QR",
        message: "This QR is not registered.",
        result,
        seq,
      };
    case "NOT_PRODUCED":
    case "NOT_ELIGIBLE":
    case "STATUS_CHANGED":
      return {
        tone: "error",
        title: "✕ CANNOT RECEIVE",
        message: result.reason ?? "This carton cannot be received.",
        result,
        seq,
      };
    case "RAW_MATERIAL_NOT_SUPPORTED":
      return {
        tone: "error",
        title: "✕ RAW MATERIAL QR",
        message: result.reason ?? "Raw materials cannot be moved from this screen yet.",
        result,
        seq,
      };
    case "INVALID_FORMAT":
      return {
        tone: "error",
        title: "✕ INVALID QR",
        message: result.reason ?? "This is not a valid carton QR.",
        result,
        seq,
      };
    case "NOT_AUTHORIZED":
      return {
        tone: "error",
        title: "✕ NOT AUTHORISED",
        message: result.reason ?? "Your account cannot receive cartons.",
        result,
        seq,
      };
    default:
      return {
        tone: "error",
        title: "✕ SCAN FAILED",
        message: result.reason ?? "The scan could not be saved.",
        result,
        seq,
      };
  }
};

// ─── Styles ────────────────────────────────────────────────────────────────
// A light sky-blue / white design system (the Store Station's "Move In" accent), scoped
// entirely under `.ssn` so it never leaks into (or is affected by) the app's shared theme.
//
// Layout is three zones in one flex column:
//
//   toolbar
//   workspace ─ scan panel (fills the left)  │  session sidebar (fixed width, right)
//   recent activity (full width, anchored to the bottom)
//
// The workspace takes all remaining height; the scan stage, the by-product list and the
// recent table each scroll internally, so nothing relies on a magic min-height.

// ─── Station chrome ──────────────────────────────────────────────────────────
// The stylesheet, icons and panels are shared with every other scanning terminal; the
// adapters below turn this screen's carton data into what those panels display.

const stationResult = (r: StoreEntryScanResult): ScanStationResult => ({
  qrId: r.qrId,
  product: r.article || r.color || r.size ? productLabel(r) : undefined,
  fromStatus: statusLabel(r.previousStatus),
  toStatus: statusLabel(r.currentStatus),
  currentStatusLabel: r.currentStatus || r.registryStatus ? statusLabel(r.currentStatus ?? r.registryStatus) : null,
  facts: [
    { label: "Article", value: r.article },
    { label: "Color", value: r.color },
    { label: "Size", value: r.size },
    { label: "Serial", value: r.serial },
  ],
  at: r.receivedAt,
});

const stationRow = (row: StoreReceivedRow): StationScanRow => ({
  key: row.eventId,
  qrId: row.qrId,
  product: productLabel(row),
  at: row.receivedAt,
  badge: "In Store",
});

// ─── Page ────────────────────────────────────────────────────────────────────

interface StoreScanningPageProps {
  /** Session token; the main process authorises every store-entry call with it. */
  token: string;
  username?: string;
  /** Returns to the Store Station chooser (Move In / Move Out). Hidden when not provided. */
  onBack?: () => void;
}

export const StoreScanningPage: React.FC<StoreScanningPageProps> = ({
  token,
  username,
  onBack,
}) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const [session, setSession] = useState<StoreReceivingSession | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [summary, setSummary] = useState<StoreReceivingSessionSummary | null>(
    null,
  );
  const [feedback, setFeedback] = useState<Feedback>(IDLE);
  const [inputVal, setInputVal] = useState("");
  const [scannerConnected, setScannerConnected] = useState<boolean | null>(
    null,
  );
  const [detailQrId, setDetailQrId] = useState<string | null>(null);
  const [detail, setDetail] = useState<QrDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const processingRef = useRef(false);
  const queueRef = useRef<string[]>([]);
  const seqRef = useRef(0);
  const sessionRef = useRef<StoreReceivingSession | null>(null);
  sessionRef.current = session;

  const focusScanner = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  // ── Session + summary (targeted reads; never the whole event log) ─────────
  const loadSummary = useCallback(
    async (sessionId: string) => {
      try {
        const next = await api.getStoreReceivingSessionSummary(sessionId, {
          token,
          recentLimit: RECENT_LIMIT,
        });
        if (next) setSummary(next);
      } catch (err) {
        console.error("Failed to load receiving session summary:", err);
      }
    },
    [api, token],
  );

  const openSession = useCallback(
    async (startNew: boolean) => {
      try {
        const res = await api.getStoreReceivingSession({ token, startNew });
        if (!res.accepted || !res.session) {
          setSession(null);
          setSessionError(res.reason ?? "Could not start a receiving session.");
          return;
        }
        setSessionError(null);
        setSession(res.session);
        setSummary(null);
        await loadSummary(res.session.id);
        if (startNew)
          push("success", "New receiving session", res.session.code);
      } catch (err) {
        setSession(null);
        setSessionError(
          err instanceof Error
            ? err.message
            : "Could not start a receiving session.",
        );
      }
    },
    [api, token, loadSummary, push],
  );

  useEffect(() => {
    void openSession(false);
  }, [openSession]);

  // ── Scanner hardware presence (same check Live Production uses) ───────────
  useEffect(() => {
    if (typeof api.getScannerStatus !== "function") return;
    let cancelled = false;
    const check = async () => {
      try {
        const connected = await api.getScannerStatus();
        if (!cancelled) setScannerConnected(connected);
      } catch {
        if (!cancelled) setScannerConnected(false);
      }
    };
    void check();
    const iv = setInterval(check, 10000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [api]);

  // ── Focus: on mount, after every result, and whenever the operator strays ─
  useEffect(() => {
    focusScanner();
  }, [focusScanner, session]);

  useEffect(() => {
    const onWindowKeyDown = (e: KeyboardEvent) => {
      if (detailQrId) return; // the QR detail drawer owns the keyboard while open
      if (e.key === "Escape") {
        setInputVal("");
        focusScanner();
        return;
      }
      const target = e.target as HTMLElement | null;
      const inField =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        Boolean(target?.isContentEditable);
      // A scanner burst arriving while focus is elsewhere is redirected to the scanner input.
      if (
        !inField &&
        e.key.length === 1 &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        focusScanner();
      }
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [detailQrId, focusScanner]);

  // ── Auto-return to READY (a new scan simply replaces the result) ──────────
  useEffect(() => {
    if (feedback.tone === "idle") return;
    const t = setTimeout(() => setFeedback(IDLE), RESULT_HOLD_MS);
    return () => clearTimeout(t);
  }, [feedback]);

  // ── Apply a result to the on-screen session immediately, then reconcile ───
  const applyAccepted = useCallback(
    (result: StoreEntryScanResult) => {
      setSummary((current) => {
        if (!current || !result.qrId || !result.receivedAt) return current;
        const row: StoreReceivedRow = {
          eventId: result.eventId ?? `${result.qrId}:${result.receivedAt}`,
          qrId: result.qrId,
          article: result.article ?? "",
          color: result.color ?? "",
          size: result.size ?? "",
          serial: result.serial ?? "",
          receivedAt: result.receivedAt,
          actor: username ?? null,
        };
        const key = (p: { article: string; color: string; size: string }) =>
          `${p.article}|${p.color}|${p.size}`;
        const byProduct = current.byProduct.some((p) => key(p) === key(row))
          ? current.byProduct.map((p) =>
              key(p) === key(row) ? { ...p, count: p.count + 1 } : p,
            )
          : [
              ...current.byProduct,
              {
                article: row.article,
                color: row.color,
                size: row.size,
                count: 1,
              },
            ];
        byProduct.sort(
          (a, b) => b.count - a.count || key(a).localeCompare(key(b)),
        );
        return {
          ...current,
          receivedCount: current.receivedCount + 1,
          byProduct,
          recent: [row, ...current.recent].slice(0, RECENT_LIMIT),
          lastReceived: row,
        };
      });
    },
    [username],
  );

  // ── The scan itself ───────────────────────────────────────────────────────
  const runScan = useCallback(
    async (cleaned: string) => {
      const activeSession = sessionRef.current;
      seqRef.current += 1;
      const seq = seqRef.current;
      try {
        const result = await api.storeEntryScan(cleaned, {
          token,
          sessionId: activeSession?.id,
        });
        if (result.accepted) {
          playScanSound("success");
          applyAccepted(result);
          if (activeSession) void loadSummary(activeSession.id);
        } else {
          playScanSound("error");
        }
        setFeedback(feedbackFor(result, seq));
      } catch (err) {
        playScanSound("error");
        const message =
          err instanceof Error
            ? err.message
            : "The scan could not be processed.";
        setFeedback({
          tone: "error",
          title: "✕ SCAN FAILED",
          message,
          result: {
            accepted: false,
            outcome: "ERROR",
            qrId: cleaned,
            reason: message,
          },
          seq,
        });
      }
    },
    [api, token, applyAccepted, loadSummary],
  );

  // Scans are processed strictly one at a time, in the order they arrived. A burst of
  // scans while one is in flight is queued, never dropped.
  const drainQueue = useCallback(async () => {
    if (processingRef.current) return;
    processingRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        const next = queueRef.current.shift()!;
        await runScan(next);
      }
    } finally {
      processingRef.current = false;
      focusScanner();
    }
  }, [runScan, focusScanner]);

  const submitScan = useCallback(
    (raw: string) => {
      const cleaned = sanitizeScanInput(raw);
      if (!cleaned || cleaned.length < 3) return;
      setInputVal("");
      queueRef.current.push(cleaned);
      void drainQueue();
    },
    [drainQueue],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitScan(inputVal);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setInputVal("");
    }
  };

  // Hardware scanners type the whole code in one burst; submit as soon as it is complete
  // rather than waiting for a suffix key the scanner may not be configured to send.
  useEffect(() => {
    if (!inputVal) return;
    const cleaned = sanitizeScanInput(inputVal);
    if (!cleaned) return;
    if (isCompleteQr(cleaned)) {
      const t = setTimeout(() => submitScan(cleaned), 40);
      return () => clearTimeout(t);
    }
    if (cleaned.length >= 5) {
      const t = setTimeout(() => submitScan(cleaned), 120);
      return () => clearTimeout(t);
    }
  }, [inputVal, submitScan]);

  // ── QR detail (the existing QR Management drawer, read-only here) ─────────
  const openDetail = useCallback(
    async (qrId: string) => {
      setDetailQrId(qrId);
      setDetail(null);
      setDetailLoading(true);
      try {
        setDetail(await api.getQrDetail(qrId));
      } catch {
        setDetail(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [api],
  );

  const closeDetail = useCallback(() => {
    setDetailQrId(null);
    setDetail(null);
    focusScanner();
  }, [focusScanner]);

  const lastReceived = summary?.lastReceived ?? null;
  const scannerReady = Boolean(session) && !sessionError;
  const blocked = Boolean(sessionError) && !session;
  const scannerPill = useMemo(() => {
    if (scannerConnected === null)
      return { color: "var(--ink-3)", text: "Checking scanner…" };
    return scannerConnected
      ? { color: "var(--ok)", text: "Hardware scanner ready" }
      : { color: "var(--warn)", text: "No hardware scanner — keyboard active" };
  }, [scannerConnected]);

  return (
    <div
      className="ssn"
      onClick={(e) => {
        // Clicking empty space is never an action; it just hands focus back to the scanner.
        const target = e.target as HTMLElement | null;
        if (
          target &&
          !target.closest(
            "button, a, input, select, textarea, [role='dialog'], tr.ssn-recent-row",
          )
        ) {
          focusScanner();
        }
      }}
    >
      <style>{SCAN_STATION_CSS}</style>

      <StationToolbar
        eyebrow="Store Station · Move In"
        title="Store Receiving"
        onBack={onBack}
        scannerPill={scannerPill}
      >
        <button
          type="button"
          className="ssn-btn"
          onClick={() => void openSession(true)}
          disabled={!session}
          title="Close this receiving session and start a new one"
        >
          <PlusIcon />
          New session
        </button>
      </StationToolbar>

      <div className="ssn-workspace">
        {blocked ? (
          <StationBlocked
            title="Store Scanning is not available"
            message={sessionError ?? ""}
            onRetry={() => void openSession(false)}
          />
        ) : (
          <>
            <ScanPanel
              feedback={{
                tone: feedback.tone,
                title: feedback.title,
                message: feedback.message,
                seq: feedback.seq,
                result: feedback.result ? stationResult(feedback.result) : null,
              }}
              inputRef={inputRef}
              inputVal={inputVal}
              onInputChange={setInputVal}
              onKeyDown={handleKeyDown}
              onFocusScanner={focusScanner}
              disabled={!scannerReady}
            />
            <aside className="ssn-side">
              <SessionCard
                code={session?.code ?? null}
                meta={
                  session
                    ? `Started ${formatDateTime(session.startedAt)}${session.startedBy ? ` · ${session.startedBy}` : ""}`
                    : (sessionError ?? "Starting…")
                }
                tallies={(summary?.byProduct ?? []).map((row) => ({
                  key: `${row.article}|${row.color}|${row.size}`,
                  label: productLabel(row),
                  count: row.count,
                }))}
                total={summary?.receivedCount ?? 0}
                totalNoun="cartons"
                groupNoun="Products"
                subhead="By product"
                emptyLabel="Nothing received yet."
              />
              <LastScanCard title="Last received" row={lastReceived ? stationRow(lastReceived) : null} />
            </aside>
          </>
        )}
      </div>

      {!blocked && (
        <RecentScansCard
          title="Recently received"
          note={`Last ${RECENT_LIMIT} · click a row for details`}
          emptyLabel="No cartons received in this session yet."
          rows={(summary?.recent ?? []).map(stationRow)}
          onOpen={(qrId) => void openDetail(qrId)}
        />
      )}

      {detailQrId && (
        <QrDetailDrawer
          qrId={detailQrId}
          detail={detail}
          loading={detailLoading}
          username={username}
          readOnly
          onClose={closeDetail}
          onChanged={async () => {
            await openDetail(detailQrId);
          }}
        />
      )}
    </div>
  );
};
