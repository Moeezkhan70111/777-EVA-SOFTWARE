import React, { useCallback, useEffect, useRef, useState } from "react";
import { useDesktopApi } from "../hooks/useDesktopApi";
import type { RawMaterialIssueResult, RawMaterialIssueSession, RawMaterialIssueSessionSummary } from "../types/desktopApi";
import type { AppRoute } from "../app/routes";
import { useNotifications } from "../state/NotificationsContext";
import { playScanSound } from "../utils/playScanSound";
import { copy } from "../config/copy";
import { openPrintDocument } from "../platform/print";
import { escapeHtml } from "../utils/html";
import { formatDateTime } from "../utils/dates";
import { isCompleteQr, sanitizeScanInput } from "../utils/qr";
import { isValidRawMaterialQrId } from "@erp/domain";
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
import type { ScanStationFeedback, StationScanRow } from "../features/scanStation/scanStation";

// Raw Material Output — issuing packets out of the store to the section that consumes them.
//
// The mirror of Raw Material Input, on the same station (features/scanStation). The one
// thing that makes it simpler: there is nothing to choose. Where a packet goes is a
// property of its material — rubber uppers to packing, ragzine to the upper maker — so the
// storekeeper only scans, and the session is just this terminal's run.
//
// Finished cartons leave the store on Store Move Out; a carton scanned here is turned away.

const RECENT_LIMIT = 12;

const IDLE: ScanStationFeedback = {
  tone: "idle",
  title: "READY TO SCAN",
  message: "Scan a packet leaving the store",
  result: null,
  seq: 0,
};

/** "1 BAG (25 KILOGRAM)", or nothing when the packing is unknown. */
const packingLabel = (quantity?: number, unitCode?: string | null, packName?: string | null): string =>
  quantity == null ? "" : `1 ${(packName ?? "").trim() || "PACK"} (${quantity} ${unitCode ?? ""})`.trim();

/** Turns the business layer's answer into what the operator reads. Text always, never colour alone. */
const feedbackFor = (result: RawMaterialIssueResult, seq: number): ScanStationFeedback => {
  const packing = packingLabel(result.packingQuantity, result.packingUnitCode, result.packName);
  const base = {
    seq,
    result: {
      qrId: result.qrId,
      product: result.itemDisplayName,
      fromStatus: "In Store",
      toStatus: result.sectionName ? `Issued to ${result.sectionName}` : "Issued",
      currentStatusLabel:
        result.currentStatus === "IN_STORE" ? "In Store" : result.currentStatus === "ISSUED" ? "Issued" : (result.currentStatus ?? null),
      facts: [
        { label: "Raw material", value: result.itemDisplayName },
        { label: "One pack", value: packing },
        { label: "Goes to", value: result.sectionName },
        // Shown only when a machine program was waiting for this bag. The storekeeper chose no
        // program: the packet's own material and supplier found it (see IssueRawMaterialScanUseCase).
        ...(result.machineProgram
          ? [
              {
                label: "Machine program",
                value: `${result.machineProgram.machineName} — ${result.machineProgram.contractorName}`,
              },
            ]
          : []),
      ],
      at: result.issuedAt,
      atLabel: "Issued",
    },
  };

  switch (result.outcome) {
    case "ISSUED": {
      const program = result.machineProgram;
      return {
        ...base,
        tone: "success",
        title: "✓ ISSUED",
        // When a machine program was waiting, the count it is now on is the useful sentence —
        // the storekeeper can see how much of the program is still to come.
        message: program
          ? `${packing || "Pack"} → ${program.machineName} · ${program.lineConsumed} of ${program.lineQuantity}${program.unitCode ? ` ${program.unitCode}` : ""} taken` +
            (program.programCompleted ? " · program finished" : "")
          : `${packing || "Pack"} sent to ${result.sectionName ?? "its section"}`,
      };
    }
    case "NOT_IN_STORE":
      return { ...base, tone: "error", title: "✕ NOT IN STORE", message: result.reason ?? "This packet is not in the store." };
    case "UNKNOWN_QR":
      return { ...base, tone: "error", title: "✕ NOT REGISTERED", message: "This QR has not been generated in the system." };
    case "NOT_CONFIGURED":
      return { ...base, tone: "error", title: "✕ NOT SET UP", message: result.reason ?? "Set this material's packing and destination first." };
    case "INVALID_FORMAT":
      return { ...base, tone: "error", title: "✕ NOT A RAW MATERIAL QR", message: result.reason ?? "This is not a raw material label." };
    case "NOT_AUTHORIZED":
      return { ...base, tone: "error", title: "✕ NOT AUTHORISED", message: result.reason ?? "Your account cannot issue raw material." };
    case "NOT_ELIGIBLE":
      return { ...base, tone: "error", title: "✕ CANNOT ISSUE", message: result.reason ?? "This packet cannot be issued." };
    case "STATUS_CHANGED":
      return { ...base, tone: "warn", title: "⚠ TRY AGAIN", message: result.reason ?? "Another terminal moved this packet." };
    default:
      return { ...base, tone: "error", title: "✕ NOT ISSUED", message: result.reason ?? "The scan could not be saved." };
  }
};

/** The printed issue slip: what left the store, one destination at a time. */
const buildSlipHtml = (summary: RawMaterialIssueSessionSummary): string => {
  const e = escapeHtml;
  const sections = summary.bySection
    .map(
      (section) =>
        `<h3>${e(section.sectionName)} — ${section.packets} packet${section.packets === 1 ? "" : "s"}</h3>` +
        `<table><thead><tr><th>Raw material</th><th class="num">Packets</th><th class="num">Quantity</th></tr></thead><tbody>` +
        section.materials
          .map((m) => `<tr><td>${e(m.itemDisplayName)}</td><td class="num">${m.packets}</td><td class="num">${m.quantity} ${e(m.unitCode)}</td></tr>`)
          .join("") +
        `</tbody></table>`
    )
    .join("");

  const scans = summary.scans
    .map(
      (scan, index) =>
        `<tr><td class="num">${index + 1}</td><td class="code">${e(scan.qrId)}</td><td>${e(scan.itemDisplayName)}</td>` +
        `<td class="num">${scan.quantity} ${e(scan.unitCode)}</td><td>${e(scan.sectionName ?? "—")}</td><td>${e(formatDateTime(scan.issuedAt))}</td></tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" /><title>${e(summary.session.code)} — Raw material issued</title>
<style>
  body { font-family: "Segoe UI", Arial, sans-serif; padding: 28px; color: #111; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h3 { font-size: 13px; margin: 20px 0 6px; }
  .meta { color: #555; font-size: 12px; margin-bottom: 18px; }
  .meta span { margin-right: 18px; }
  h2 { font-size: 14px; margin: 22px 0 8px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { padding: 6px 8px; border-bottom: 1px solid #ddd; text-align: left; }
  th { background: #f3f5f8; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .code { font-family: Consolas, "Courier New", monospace; }
  .actions { text-align: center; margin-bottom: 18px; }
  .actions button { padding: 10px 26px; font-size: 13px; font-weight: 600; background: #17365d; color: #fff; border: none; border-radius: 4px; cursor: pointer; }
  @media print { .actions { display: none; } body { padding: 0; } }
</style></head>
<body>
  <div class="actions"><button onclick="window.print()">${e(copy.reports.printOrSave)}</button></div>
  <h1>Raw Material Issued</h1>
  <div class="meta">
    <span>Session ${e(summary.session.code)}</span>
    <span>Started ${e(formatDateTime(summary.session.startedAt))}</span>
    ${summary.session.closedAt ? `<span>Closed ${e(formatDateTime(summary.session.closedAt))}</span>` : ""}
    <span>Issued by ${e(summary.session.startedBy ?? "—")}</span>
    <span>${summary.totalPackets} packet${summary.totalPackets === 1 ? "" : "s"}</span>
  </div>

  <h2>By destination</h2>
  ${sections || "<p>Nothing was issued in this session.</p>"}

  <h2>Every packet</h2>
  <table><thead><tr><th class="num">#</th><th>QR</th><th>Raw material</th><th class="num">Quantity</th><th>Destination</th><th>Issued</th></tr></thead>
  <tbody>${scans || '<tr><td colspan="6">Nothing was issued in this session.</td></tr>'}</tbody></table>
</body></html>`;
};

interface RawMaterialOutputPageProps {
  /** Session token; the main process authorises every issue call with it. */
  token: string;
  username?: string;
  /** Returns to the Store Station chooser. Hidden when not provided. */
  onBack?: () => void;
  onNavigate?: (route: AppRoute) => void;
}

export const RawMaterialOutputPage: React.FC<RawMaterialOutputPageProps> = ({ token, onBack, onNavigate }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const [session, setSession] = useState<RawMaterialIssueSession | null>(null);
  const [summary, setSummary] = useState<RawMaterialIssueSessionSummary | null>(null);
  const [feedback, setFeedback] = useState<ScanStationFeedback>(IDLE);
  const [inputVal, setInputVal] = useState("");
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [scannerConnected, setScannerConnected] = useState(false);

  const seq = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const queueRef = useRef<string[]>([]);
  const processingRef = useRef(false);
  const focusScanner = useCallback(() => inputRef.current?.focus(), []);

  const refreshSummary = useCallback(
    async (sessionId: string) => setSummary(await api.getRawMaterialIssueSessionSummary(sessionId)),
    [api]
  );

  // The session opens by itself: there is nothing to pick, so making the operator press a
  // button first would only be in the way.
  const openSession = useCallback(
    async (startNew: boolean) => {
      setSessionError(null);
      try {
        const result = await api.startRawMaterialIssueSession({ token, startNew });
        if (!result.accepted || !result.session) {
          setSessionError(result.reason ?? "The session could not be started.");
          setSession(null);
          return;
        }
        setSession(result.session);
        setFeedback(IDLE);
        await refreshSummary(result.session.id);
      } catch (error) {
        setSessionError(error instanceof Error ? error.message : copy.states.loadFailedBody);
        setSession(null);
      }
    },
    [api, refreshSummary, token]
  );

  useEffect(() => {
    void openSession(false);
  }, [openSession]);

  useEffect(() => {
    if (typeof api.getScannerStatus !== "function") return;
    let cancelled = false;
    const poll = async () => {
      try {
        const connected = await api.getScannerStatus();
        if (!cancelled) setScannerConnected(Boolean(connected));
      } catch {
        if (!cancelled) setScannerConnected(false);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api]);

  const scannerReady = session?.status === "OPEN";

  // The scanner types into whichever field has focus, so the scan box keeps it.
  useEffect(() => {
    if (scannerReady) focusScanner();
  }, [scannerReady, feedback.seq, focusScanner]);

  const runScan = useCallback(
    async (code: string) => {
      if (!session || session.status !== "OPEN") return;
      seq.current += 1;
      const result = await api.rawMaterialIssueScan(code, { token, sessionId: session.id });
      setFeedback(feedbackFor(result, seq.current));
      playScanSound(result.accepted ? "success" : "error");
      if (result.accepted) await refreshSummary(session.id);
    },
    [api, refreshSummary, session, token]
  );

  // Scans are serialised: a wedge scanner can fire the next code before the last one has
  // been saved, and two overlapping calls would race on the same session.
  const drainQueue = useCallback(async () => {
    if (processingRef.current) return;
    processingRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        await runScan(queueRef.current.shift()!);
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
    [drainQueue]
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitScan(inputVal);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setInputVal("");
    }
  };

  // Hardware scanners type the whole code in one burst and many are not configured to send
  // a suffix key, so the station submits as soon as the buffer looks complete.
  useEffect(() => {
    if (!inputVal) return;
    const cleaned = sanitizeScanInput(inputVal);
    if (!cleaned) return;
    if (isValidRawMaterialQrId(cleaned) || isCompleteQr(cleaned)) {
      const t = setTimeout(() => submitScan(cleaned), 40);
      return () => clearTimeout(t);
    }
    if (cleaned.length >= 5) {
      const t = setTimeout(() => submitScan(cleaned), 120);
      return () => clearTimeout(t);
    }
  }, [inputVal, submitScan]);

  const endSession = async () => {
    if (!session) return;
    const closed = await api.closeRawMaterialIssueSession(session.id);
    setSession(closed);
    await refreshSummary(session.id);
    push("success", "Session closed", `${summary?.totalPackets ?? 0} packet(s) issued`);
  };

  const print = () => {
    if (!summary) return;
    if (!openPrintDocument(buildSlipHtml(summary)).opened) {
      push("error", copy.toast.popupBlocked, "Allow popups to print the issue slip");
    }
  };

  const scanRows: StationScanRow[] = (summary?.scans ?? [])
    .slice(-RECENT_LIMIT)
    .reverse()
    .map((scan) => ({
      key: `${scan.qrId}|${scan.issuedAt}`,
      qrId: scan.qrId,
      product: `${scan.itemDisplayName} · ${scan.quantity} ${scan.unitCode}`.trim(),
      at: scan.issuedAt,
      badge: scan.sectionName ?? "Issued",
    }));

  const blocked = !session && Boolean(sessionError);

  return (
    <div
      className="ssn"
      onClick={(e) => {
        // Clicking empty space is never an action; it just hands focus back to the scanner.
        const target = e.target as HTMLElement | null;
        if (target && !target.closest("button, a, input, select, textarea, [role='dialog'], tr.ssn-recent-row")) {
          focusScanner();
        }
      }}
    >
      <style>{SCAN_STATION_CSS}</style>

      <StationToolbar
        eyebrow="Store Station · Raw Material"
        title="Raw Material Output"
        onBack={onBack}
        scannerPill={scannerConnected ? { text: "Scanner ready", color: "#16a34a" } : { text: "Keyboard input", color: "#94a3b8" }}
      >
        <button type="button" className="ssn-btn" onClick={() => void openSession(true)} disabled={!session}>
          <PlusIcon />
          New session
        </button>
        <button type="button" className="ssn-btn" onClick={() => void endSession()} disabled={session?.status !== "OPEN"}>
          End session
        </button>
        <button type="button" className="ssn-btn" onClick={print} disabled={!summary || summary.totalPackets === 0}>
          Print slip
        </button>
        {onNavigate ? (
          <button
            type="button"
            className="ssn-btn ssn-btn--ghost"
            onClick={() => onNavigate("raw-material")}
            title="Set where each material goes when it leaves the store"
          >
            Raw Material
          </button>
        ) : null}
      </StationToolbar>

      <div className="ssn-workspace">
        {blocked ? (
          <StationBlocked
            title="Raw Material Output is not available"
            message={sessionError ?? ""}
            onRetry={() => void openSession(false)}
          />
        ) : (
          <>
            <ScanPanel
              feedback={feedback}
              inputRef={inputRef}
              inputVal={inputVal}
              onInputChange={setInputVal}
              onKeyDown={handleKeyDown}
              onFocusScanner={focusScanner}
              disabled={!scannerReady}
              disabledHint={session ? "Session closed — start a new one" : "Starting session…"}
            />
            <aside className="ssn-side">
              <SessionCard
                code={session?.code ?? null}
                meta={
                  session
                    ? `Started ${formatDateTime(session.startedAt)}${session.startedBy ? ` · ${session.startedBy}` : ""}`
                    : (sessionError ?? "Starting…")
                }
                tallies={(summary?.bySection ?? []).map((section) => ({
                  key: section.sectionName,
                  label: section.sectionName,
                  count: section.packets,
                }))}
                total={summary?.totalPackets ?? 0}
                totalNoun="packets"
                totalLabel="Issued"
                groupNoun="Destinations"
                subhead="By destination"
                emptyLabel="Nothing issued yet."
              />
              <LastScanCard title="Last issued" row={scanRows[0] ?? null} />
            </aside>
          </>
        )}
      </div>

      {!blocked && (
        <RecentScansCard
          title="Recently issued"
          note={`Last ${RECENT_LIMIT} in this session`}
          emptyLabel="No packets issued in this session yet."
          rows={scanRows}
        />
      )}
    </div>
  );
};
