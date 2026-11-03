import React, { useCallback, useEffect, useRef, useState } from "react";
import { GATEPASS_JOURNEY, formatQuantityInDozens } from "@erp/domain";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import type { GatepassScanLine, GatepassScanProgress } from "../../types/desktopApi";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { playScanSound } from "../../utils/playScanSound";
import { isCompleteQr, sanitizeScanInput } from "../../utils/qr";
import {
  LastScanCard,
  RecentScansCard,
  SCAN_STATION_CSS,
  ScanPanel,
  StationBlocked,
  StationToolbar,
  type ScanStationFeedback,
  type StationScanRow,
} from "../scanStation/scanStation";
import { openGatepassSlipPrintWindow } from "../../utils/gatepassSlip";
import { deskDoneMessage, deskIdleMessage, type CartonFigures } from "./gatepassProgress";

// The two gatepass-locked scanning desks, which are the same screen twice.
//
//   Store    the cartons this document asks for leave the store      BILLED  → AT_GATE
//   Dispatch those same cartons go onto the vehicle for the party    AT_GATE → DISPATCHED
//
// Only QR cartons are scanned. Cartons with no QR (Manual Production) were issued directly when the
// gatepass was made (docs/42): each desk shows them as issued, asks only for the QR cartons, and
// never counts an issued carton as scanned (gatepassProgress.ts words it).
//
// The operator opens one document and scans. They never pick an article, a colour, a size or a
// carton: the Gatepass already says what may be scanned and the backend holds them to it, so
// every rejection below is the backend's answer shown as it came, not a decision made here.
//
// Quantities are shown in dozens because that is what the floor says, through the one domain
// conversion — the figures underneath are cartons, which is what the database counts.

const RECENT_LIMIT = 12;

export type GatepassScanDesk = "STORE" | "DISPATCH";

const IDLE: ScanStationFeedback = { tone: "idle", title: "READY TO SCAN", message: copy.gatepass.scanPrompt, result: null, seq: 0 };

/** The desk's figures, in the shape the one wording rule reads. */
const deskFigures = (progress: GatepassScanProgress, totals: { scanned: number; remaining: number }): CartonFigures => ({
  total: progress.requiredCartons,
  issuedDirectly: progress.issuedDirectlyCartons,
  scanned: totals.scanned,
  remaining: totals.remaining,
});

/** What the scan panel shows: the done banner, the opening prompt, or the last scan's answer. */
const panelFeedback = (feedback: ScanStationFeedback, figures: CartonFigures | null, desk: GatepassScanDesk, complete: boolean): ScanStationFeedback => {
  if (!figures) return feedback;
  if (complete) return { ...IDLE, ...deskDoneMessage(desk, figures) };
  if (feedback.seq === 0) return { ...IDLE, message: deskIdleMessage(figures) };
  return feedback;
};

/** Required / scanned / remaining for a line, at whichever desk is open. */
const atDesk = (line: GatepassScanLine, desk: GatepassScanDesk) =>
  desk === "STORE"
    ? { scanned: line.storeScannedCartons, remaining: line.storeRemainingCartons }
    : { scanned: line.dispatchedCartons, remaining: line.dispatchRemainingCartons };

const totalsAtDesk = (progress: GatepassScanProgress, desk: GatepassScanDesk) =>
  desk === "STORE"
    ? { scanned: progress.storeScannedCartons, remaining: progress.storeRemainingCartons }
    : { scanned: progress.dispatchedCartons, remaining: progress.dispatchRemainingCartons };

interface GatepassScanPageProps {
  gatepassId: string;
  desk: GatepassScanDesk;
  token: string;
  username: string;
  onBack: () => void;
}

export const GatepassScanPage: React.FC<GatepassScanPageProps> = ({ gatepassId, desk, token, username, onBack }) => {
  const api = useDesktopApi();

  const [progress, setProgress] = useState<GatepassScanProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<ScanStationFeedback>(IDLE);
  const [rows, setRows] = useState<StationScanRow[]>([]);
  const [inputVal, setInputVal] = useState("");

  const seq = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const queueRef = useRef<string[]>([]);
  const busyRef = useRef(false);
  const focusScanner = useCallback(() => inputRef.current?.focus(), []);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const next = await api.getGatepassScanProgress(gatepassId, { token });
      if (!next) setLoadError("This Gatepass could not be found.");
      setProgress(next);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : copy.states.loadFailedBody);
    } finally {
      setLoading(false);
    }
  }, [api, gatepassId, token]);

  useEffect(() => {
    void load();
  }, [load]);

  // The scanner types into whichever field has focus, so the scan box takes it the moment the
  // desk opens and takes it back after every scan. Opening the Gatepass IS starting: the
  // operator came here to scan, and a button in between is one thing to forget while holding
  // a carton in each hand.
  useEffect(() => {
    focusScanner();
  }, [feedback.seq, loading, focusScanner]);

  // Which desk this document is standing at.
  //
  // The last carton moves the document on, so the moment the operator finishes, the status is
  // already the next one. Checking only for the waiting status would answer their final scan
  // with "this Gatepass is not waiting here" — so a desk also stays open to a document that
  // has moved PAST it, which is what lets them read the finished figures and print the slip.
  const expectedStatus = desk === "STORE" ? "BILLED" : "AT_GATE";
  const position = progress ? GATEPASS_JOURNEY.indexOf(progress.status as (typeof GATEPASS_JOURNEY)[number]) : -1;
  const deskPosition = GATEPASS_JOURNEY.indexOf(expectedStatus as (typeof GATEPASS_JOURNEY)[number]);
  const waitingHere = progress?.status === expectedStatus;
  const movedPast = position > deskPosition;
  const ready = waitingHere || movedPast;
  const totals = progress ? totalsAtDesk(progress, desk) : { scanned: 0, remaining: 0 };
  const complete = Boolean(progress) && totals.remaining === 0;
  const figures = progress ? deskFigures(progress, totals) : null;

  const runScan = useCallback(
    async (code: string) => {
      seq.current += 1;
      const result =
        desk === "STORE"
          ? await api.storeExitScan(code, { token, gatepassId })
          : await api.dispatchScan(code, progress?.dispatchSessionId ?? undefined, gatepassId);

      const accepted = Boolean(result.accepted);
      const reason = "reason" in result ? result.reason : undefined;
      playScanSound(accepted ? "success" : "error");

      const article = "article" in result ? result.article : undefined;
      const color = "color" in result ? result.color : undefined;
      const size = "size" in result ? result.size : undefined;
      const product = [article, color, size].filter(Boolean).join(" · ");

      setFeedback({
        seq: seq.current,
        tone: accepted ? "success" : "error",
        title: accepted ? "✓ ACCEPTED" : "✕ REJECTED",
        message: accepted ? (product || "Carton accepted") : reason || "This carton was not accepted.",
        result: { qrId: result.qrId ?? code, product: product || undefined },
      });

      if (accepted) {
        setRows((previous) =>
          [{ key: `${result.qrId ?? code}|${seq.current}`, qrId: result.qrId ?? code, product: product || "—", at: new Date().toISOString(), badge: desk === "STORE" ? "To Gate" : "Dispatched" }, ...previous].slice(0, RECENT_LIMIT)
        );
        await load();
      }
    },
    [api, desk, gatepassId, load, progress?.dispatchSessionId, token]
  );

  const drain = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      while (queueRef.current.length > 0) await runScan(queueRef.current.shift()!);
    } finally {
      busyRef.current = false;
      focusScanner();
    }
  }, [runScan, focusScanner]);


  const submit = useCallback(
    (raw: string) => {
      const cleaned = sanitizeScanInput(raw);
      if (!cleaned || cleaned.length < 3) return;
      setInputVal("");
      queueRef.current.push(cleaned);
      void drain();
    },
    [drain]
  );

  // Hardware scanners type the whole code in one burst and many are not configured to send a
  // suffix key, so the station submits as soon as the buffer looks like a whole code rather
  // than waiting for Enter. Anything it cannot recognise falls back to a short quiet period
  // after the last keystroke, so a hand-typed code still goes through. Enter still works.
  useEffect(() => {
    if (!inputVal) return;
    const cleaned = sanitizeScanInput(inputVal);
    if (!cleaned) return;
    if (isCompleteQr(cleaned)) {
      const timer = setTimeout(() => submit(cleaned), 40);
      return () => clearTimeout(timer);
    }
    if (cleaned.length >= 5) {
      const timer = setTimeout(() => submit(cleaned), 120);
      return () => clearTimeout(timer);
    }
  }, [inputVal, submit]);

  const printSlip = () => {
    if (!progress) return;
    openGatepassSlipPrintWindow({ desk, progress, operator: username });
  };

  if (loading) return <StateView kind="loading" message={copy.common.loading} />;
  if (loadError || !progress) {
    return (
      <div className="ssn">
        <style>{SCAN_STATION_CSS}</style>
        <StationBlocked title="This Gatepass cannot be scanned" message={loadError ?? copy.states.loadFailedBody} onRetry={() => void load()} />
      </div>
    );
  }

  const deskName = desk === "STORE" ? "Store" : "Dispatch";

  return (
    <div
      className="ssn"
      onClick={(event) => {
        const target = event.target as HTMLElement | null;
        if (!complete && target && !target.closest("button, a, input, select, textarea")) focusScanner();
      }}
    >
      <style>{SCAN_STATION_CSS}</style>

      <StationToolbar eyebrow={`${deskName} · Gatepass`} title={`${progress.code} · ${progress.partyName}`} onBack={onBack} backLabel="Gatepass">
        {progress.voucherNumber ? <span className="ssn-pill">Bill #{progress.voucherNumber}</span> : null}
        {waitingHere && !complete ? (
          <span className="ssn-pill" data-testid="gatepass-scanning">
            Scanning — just scan
          </span>
        ) : null}
        {complete ? (
          <button type="button" className="ssn-btn" onClick={printSlip} data-testid="gatepass-print-slip">
            🖨 Print {deskName} Slip
          </button>
        ) : null}
      </StationToolbar>

      <div className="ssn-workspace">
        {!ready ? (
          <StationBlocked
            title={`This Gatepass has not reached ${deskName} yet`}
            message={
              desk === "STORE"
                ? "Only a billed Gatepass can be taken out of the store. Billing must make its bill first."
                : "Only a Gatepass standing at the gate can be dispatched. The store must finish with it first."
            }
            onRetry={() => void load()}
          />
        ) : (
          <>
            <ScanPanel
              feedback={panelFeedback(feedback, figures, desk, complete)}
              inputRef={inputRef}
              inputVal={inputVal}
              onInputChange={setInputVal}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submit(inputVal);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setInputVal("");
                }
              }}
              onFocusScanner={focusScanner}
              disabled={complete}
              disabledHint="Nothing left to scan"
            />

            <aside className="ssn-side">
              <section className="ssn-card" aria-label="What this Gatepass needs">
                <div className="ssn-card-head">
                  <span className="ssn-card-title">{deskName} progress</span>
                  <span className="ssn-card-note">{progress.lines.length} line(s)</span>
                </div>

                <div className="ssn-kpis">
                  {progress.issuedDirectlyCartons > 0 ? (
                    <div className="ssn-kpi">
                      <span className="ssn-kpi-label">{copy.gatepass.issuedDirectly}</span>
                      <span className="ssn-kpi-value" data-testid="gatepass-issued-directly">{formatQuantityInDozens(progress.issuedDirectlyCartons)}</span>
                      <span className="ssn-kpi-sub">{copy.gatepass.issuedDirectlySub}</span>
                    </div>
                  ) : null}
                  <div className="ssn-kpi">
                    <span className="ssn-kpi-label">Scanned</span>
                    <span className="ssn-kpi-value" data-testid="gatepass-scanned">{formatQuantityInDozens(totals.scanned)}</span>
                    {/* Of the QR cartons only: an issued carton is never one to scan. */}
                    <span className="ssn-kpi-sub">of {formatQuantityInDozens(progress.requiredCartons - progress.issuedDirectlyCartons)}</span>
                  </div>
                  <div className="ssn-kpi">
                    <span className="ssn-kpi-label">Remaining</span>
                    <span className="ssn-kpi-value" data-testid="gatepass-remaining">{formatQuantityInDozens(totals.remaining)}</span>
                    <span className="ssn-kpi-sub">{complete ? "complete" : "still to scan"}</span>
                  </div>
                </div>

                <div className="ssn-subhead"><span>By item</span></div>
                <div className="ssn-summary">
                  {progress.lines.map((line) => {
                    const line_ = atDesk(line, desk);
                    return (
                      <div className="gp-scan-line" key={line.productVariantId} data-testid={`gatepass-line-${line.productVariantId}`}>
                        <div className="gp-scan-line-name">
                          {line.article} · {line.color} · {line.size}
                        </div>
                        <div className="gp-scan-line-figures">
                          <span>Required <strong>{formatQuantityInDozens(line.requiredCartons)}</strong></span>
                          {line.issuedDirectlyCartons > 0 ? (
                            <span>{copy.gatepass.issuedDirectly} <strong>{formatQuantityInDozens(line.issuedDirectlyCartons)}</strong></span>
                          ) : null}
                          <span>Scanned <strong>{formatQuantityInDozens(line_.scanned)}</strong></span>
                          <span className={line_.remaining === 0 ? "is-done" : ""}>
                            Remaining <strong>{formatQuantityInDozens(line_.remaining)}</strong>
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              <LastScanCard title="Last accepted" row={rows[0] ?? null} />
            </aside>
          </>
        )}
      </div>

      {ready ? (
        <RecentScansCard
          title={`Scanned at ${deskName}`}
          note={`Last ${RECENT_LIMIT} in this session`}
          emptyLabel="Nothing scanned yet."
          rows={rows}
        />
      ) : null}
    </div>
  );
};
