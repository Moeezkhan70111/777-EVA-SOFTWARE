import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDesktopApi } from "../hooks/useDesktopApi";
import type { Party, RawMaterialIssueResult, RawMaterialIssueSession, RawMaterialIssueSessionSummary } from "../types/desktopApi";
import { PartyTypeBadge } from "../features/parties/PartyTypeBadge";
import { partyOption } from "../features/parties/partyOption";
import { SearchableCombobox } from "../components/shared/SearchableCombobox";
import { StateView } from "../components/shared/StateView";
import { StepHeading } from "../components/shared/StepHeading";
import type { AppRoute } from "../app/routes";
import { useNotifications } from "../state/NotificationsContext";
import { playScanSound } from "../utils/playScanSound";
import { copy } from "../config/copy";
import { openIssueSlipPrintWindow } from "../features/rawMaterial/issueSlip";
import { formatDateTime } from "../utils/dates";
import { isCompleteQr, sanitizeScanInput } from "../utils/qr";
import { LEASE_DOMAIN, isMachineProgramCodeScan, isRawMaterialIssuePartyType, isValidRawMaterialQrId } from "@erp/domain";
import { LeasedStation } from "../features/store/LeasedStation";
import { ReaderStation } from "../features/store/ReaderStation";
import type { StationStatus } from "../features/store/page/stationStatus";
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
// The mirror of Raw Material Input, on the same station (features/scanStation). Since 0.3.6 the
// storekeeper first chooses WHO the packets are going to — a supplier or a contractor — the way
// Raw Material Input names its supplier, and every scan goes to that party until another is
// chosen. The session still opens by itself: it is just this terminal's run.
//
// A packet scanned before a party is chosen is turned away here, without a call, and the main
// process refuses it again if it ever arrives without one. The scan box itself stays live, so a
// machine program sheet scanned into it still reaches the program lookup above.
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

/** Where a packet went: the party chosen on Scan Out, else its material's section. */
const destinationOf = (result: RawMaterialIssueResult): string | null =>
  result.issuedToPartyName || result.sectionName || null;

/** Shown when a packet is scanned before a party is chosen. Nothing was sent or moved. */
const choosePartyFirst = (seq: number): ScanStationFeedback => ({
  tone: "warn",
  title: copy.moveOut.scanPartyFirstTitle,
  message: copy.moveOut.scanPartyFirstBody,
  result: null,
  seq,
});

/** Turns the business layer's answer into what the operator reads. Text always, never colour alone. */
const feedbackFor = (result: RawMaterialIssueResult, seq: number): ScanStationFeedback => {
  const packing = packingLabel(result.packingQuantity, result.packingUnitCode, result.packName);
  const base = {
    seq,
    result: {
      qrId: result.qrId,
      product: result.itemDisplayName,
      fromStatus: "In Store",
      toStatus: destinationOf(result) ? `Issued to ${destinationOf(result)}` : "Issued",
      currentStatusLabel:
        result.currentStatus === "IN_STORE" ? "In Store" : result.currentStatus === "ISSUED" ? "Issued" : (result.currentStatus ?? null),
      facts: [
        { label: "Raw material", value: result.itemDisplayName },
        { label: "One pack", value: packing },
        { label: copy.moveOut.movedOutTo, value: result.issuedToPartyName },
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
          : `${packing || "Pack"} sent to ${destinationOf(result) ?? "its section"}`,
      };
    }
    case "NO_PARTY":
      return { ...base, tone: "warn", title: copy.moveOut.scanPartyRefusedTitle, message: result.reason ?? copy.moveOut.scanPartyFirstBody };
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

/** What the scan box says while it is waiting: the next step of choose party, New session, scan. */
function scanHintFor(partyId: string, session: RawMaterialIssueSession | null): string {
  if (!partyId) return copy.moveOut.scanStartHint;
  if (session?.status === "CLOSED") return copy.moveOut.scanSessionClosed;
  return copy.moveOut.scanPressNew;
}

/** The party a running session is locked to: its name and type, and why it cannot be changed. */
const LockedParty: React.FC<{ party: Party | undefined }> = ({ party }) => (
  <div className="mo-locked-party" data-testid="locked-party">
    <strong>{party ? `${party.partyCode} — ${party.partyName}` : "—"}</strong>
    <PartyTypeBadge partyType={party?.partyType} />
    <p className="field-help">🔒 {copy.moveOut.scanPartyLocked}</p>
  </div>
);

interface RawMaterialOutputPageProps {
  /** Session token; the main process authorises every issue call with it. */
  token: string;
  username?: string;
  /** Returns to the Store Station chooser. Hidden when not provided. */
  onBack?: () => void;
  onNavigate?: (route: AppRoute) => void;
  /** Set when the station is a pane of the Store Out page rather than the whole screen. */
  embedded?: boolean;
  /**
   * Reports this terminal's open issue session as it opens or closes, so Store Out can put a
   * Machine Program batch on the same session — and therefore the same printed issue slip — as
   * everything else that left the store here.
   */
  onSessionChange?: (sessionId: string | null) => void;
  /**
   * Handed a MACHINE PROGRAM code scanned into this station's box — MP-000012.
   *
   * This station keeps the keyboard focus whenever its session is open, so the program sheet's
   * QR lands here however carefully the page above arms its own lookup. Rather than refusing it
   * as "not a raw material QR", the station passes it up to whoever owns the program lookup.
   * Only the unmistakable MP form is passed on; a bare number is a mis-scan, not a program.
   */
  onMachineProgramScan?: (code: string) => void;
  /**
   * False while this panel's mode is not the one on the Store page (or a machine program has the
   * page): it then never takes the scanner's focus, so a scan can only land in the mode on screen.
   */
  active?: boolean;
  /** Where this panel's session stands, for the Store page's mode switch. */
  onStatus?: (status: StationStatus) => void;
}

const RawMaterialOutputStation: React.FC<RawMaterialOutputPageProps> = ({
  token,
  username,
  onBack,
  onNavigate,
  embedded = false,
  onSessionChange,
  onMachineProgramScan,
  active = true,
  onStatus,
}) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const [session, setSession] = useState<RawMaterialIssueSession | null>(null);
  const [summary, setSummary] = useState<RawMaterialIssueSessionSummary | null>(null);
  const [feedback, setFeedback] = useState<ScanStationFeedback>(IDLE);
  const [inputVal, setInputVal] = useState("");
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [scannerConnected, setScannerConnected] = useState(false);
  // ONE SESSION, ONE PARTY (0.3.8): choose the party, New session, scan, End session. partyId is
  // the choice; sessionPartyId is the party the open session was started for, and while it is set
  // the choice is locked. The main process holds the same rule on every scan.
  const [parties, setParties] = useState<Party[]>([]);
  const [partyId, setPartyId] = useState("");
  const [sessionPartyId, setSessionPartyId] = useState<string | null>(null);
  const [partiesError, setPartiesError] = useState<string | null>(null);

  const seq = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const queueRef = useRef<string[]>([]);
  const processingRef = useRef(false);
  const focusScanner = useCallback(() => inputRef.current?.focus(), []);
  // Read when a scan finishes: the Store page may have switched mode while it was being saved.
  const activeRef = useRef(active);
  activeRef.current = active;

  const refreshSummary = useCallback(
    async (sessionId: string) => setSummary(await api.getRawMaterialIssueSessionSummary(sessionId)),
    [api]
  );

  // On arrival: today's open session, if this terminal has one, never a new one. A session with
  // packets in it is locked to their party again, so a restart mid-session picks up where it was.
  const loadOpenSession = useCallback(async () => {
    setSessionError(null);
    try {
      const open = await api.getOpenRawMaterialIssueSession();
      setSession(open);
      if (!open) return;
      const current = await api.getRawMaterialIssueSessionSummary(open.id);
      setSummary(current);
      if (current?.partyId) {
        setPartyId(current.partyId);
        setSessionPartyId(current.partyId);
      }
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : copy.states.loadFailedBody);
    }
  }, [api]);

  useEffect(() => {
    void loadOpenSession();
  }, [loadOpenSession]);

  // New session, for the chosen party. Any session still open on this terminal is closed first by
  // the main process, so one terminal has one session at a time.
  const startSession = useCallback(async () => {
    if (!partyId) return;
    setSessionError(null);
    try {
      const result = await api.startRawMaterialIssueSession({ token, startNew: true });
      if (!result.accepted || !result.session) {
        setSessionError(result.reason ?? "The session could not be started.");
        return;
      }
      setSession(result.session);
      setSessionPartyId(partyId);
      setFeedback(IDLE);
      await refreshSummary(result.session.id);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : copy.states.loadFailedBody);
    }
  }, [api, partyId, refreshSummary, token]);

  // Only active suppliers and contractors may receive packets — the same domain rule the main
  // process enforces, so the list cannot offer a party the scan would be refused for.
  const loadParties = useCallback(async () => {
    setPartiesError(null);
    try {
      const result = await api.listParties({ pageSize: 1000 });
      setParties(result.rows.filter((party) => party.status === "ACTIVE" && isRawMaterialIssuePartyType(party.partyType)));
    } catch (error) {
      setPartiesError(error instanceof Error ? error.message : copy.states.loadFailedBody);
    }
  }, [api]);

  useEffect(() => {
    void loadParties();
  }, [loadParties]);

  const partyOptions = useMemo(
    () => parties.map(partyOption),
    [parties]
  );
  const chosenParty = parties.find((party) => party.id === partyId);

  // The session is a database row, not this component's state, so the page above is told
  // which one is open rather than being handed a copy of it.
  useEffect(() => {
    onSessionChange?.(session?.status === "OPEN" ? session.id : null);
  }, [onSessionChange, session]);

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

  // Scanning only in a session started for a party.
  const locked = session?.status === "OPEN" && sessionPartyId !== null;
  const scannerReady = locked;

  // The scanner types into whichever field has focus, so the scan box keeps it.
  useEffect(() => {
    if (scannerReady && active) focusScanner();
  }, [scannerReady, active, feedback.seq, focusScanner]);

  // The Store page's mode switch shows this panel's session state, even while it is hidden.
  useEffect(() => {
    onStatus?.({ sessionId: session?.status === "OPEN" ? (session?.id ?? null) : null, open: session?.status === "OPEN", packets: summary?.totalPackets ?? 0 });
  }, [onStatus, session, summary]);


  const runScan = useCallback(
    async (code: string) => {
      if (!session || session.status !== "OPEN") return;
      seq.current += 1;
      // No party, no move: turned away here without a call. The main process refuses it too.
      if (!sessionPartyId) {
        setFeedback(choosePartyFirst(seq.current));
        playScanSound("error");
        return;
      }
      const result = await api.rawMaterialIssueScan(code, { token, sessionId: session.id, issuedToPartyId: sessionPartyId });
      setFeedback(feedbackFor(result, seq.current));
      playScanSound(result.accepted ? "success" : "error");
      if (result.accepted) await refreshSummary(session.id);
    },
    [api, refreshSummary, session, sessionPartyId, token]
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
      if (activeRef.current) focusScanner();
    }
  }, [runScan, focusScanner]);

  const submitScan = useCallback(
    (raw: string) => {
      const cleaned = sanitizeScanInput(raw);
      if (!cleaned || cleaned.length < 3) return;
      setInputVal("");
      // A machine program sheet scanned into the station belongs to the program lookup above it,
      // not to this station. Passed up rather than refused as "not a raw material QR".
      if (onMachineProgramScan && isMachineProgramCodeScan(cleaned)) {
        onMachineProgramScan(cleaned);
        return;
      }
      queueRef.current.push(cleaned);
      void drainQueue();
    },
    [drainQueue, onMachineProgramScan]
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
    // The party is free again: the next session can be for anyone.
    setSessionPartyId(null);
    await refreshSummary(session.id);
    push("success", "Session closed", `${summary?.totalPackets ?? 0} packet(s) issued`);
  };

  const print = () => {
    if (!summary) return;
    if (!openIssueSlipPrintWindow(summary, username)) {
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

  const blocked = Boolean(sessionError);
  const scanHint = scanHintFor(partyId, session);

  return (
    <div
      className={`ssn${embedded ? " ssn--embedded" : ""}`}
      onClick={(e) => {
        // Clicking empty space is never an action; it just hands focus back to the scanner.
        const target = e.target as HTMLElement | null;
        if (target && !target.closest("button, a, input, select, textarea, [role='dialog'], tr.ssn-recent-row")) {
          focusScanner();
        }
      }}
    >
      <style>{SCAN_STATION_CSS}</style>

      {/* Embedded on the Store Out page the pane above already names the station. */}
      <StationToolbar
        eyebrow={embedded ? undefined : "Store Station · Raw Material"}
        title={embedded ? undefined : "Raw Material Output"}
        onBack={onBack}
        scannerPill={scannerConnected ? { text: "Scanner ready", color: "#16a34a" } : { text: "Keyboard input", color: "#94a3b8" }}
      >
        <button type="button" className="ssn-btn" onClick={() => void startSession()} disabled={locked || !partyId}>
          <PlusIcon />
          New session
        </button>
        <button type="button" className="ssn-btn" onClick={() => void endSession()} disabled={!locked}>
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

      {!blocked && (
        <section className="qr-step">
          <StepHeading index={1} done={Boolean(partyId)} title={copy.moveOut.scanPartyStep} />
          <div className="qr-step-body">
            {partiesError ? (
              <StateView kind="error" compact message={partiesError} onRetry={() => void loadParties()} />
            ) : locked ? (
              <LockedParty party={parties.find((party) => party.id === sessionPartyId)} />
            ) : (
              <>
                <SearchableCombobox
                  dropdown
                  value={partyId}
                  options={partyOptions}
                  placeholder={partyOptions.length === 0 ? copy.moveOut.noScanParties : copy.moveOut.chooseScanParty}
                  emptyLabel={copy.moveOut.noScanPartyMatch}
                  ariaLabel={copy.moveOut.scanPartyStep}
                  onChange={(next) => {
                    setPartyId(next);
                    setFeedback(IDLE);
                    // Hand the keyboard straight back to the scanner once the party is chosen.
                    setTimeout(focusScanner, 0);
                  }}
                />
                <PartyTypeBadge partyType={chosenParty?.partyType} />
                <p className="field-help">{copy.moveOut.scanPartyHelp}</p>
              </>
            )}
          </div>
        </section>
      )}

      <div className="ssn-workspace">
        {blocked ? (
          <StationBlocked
            title="Raw Material Output is not available"
            message={sessionError ?? ""}
            onRetry={() => void loadOpenSession()}
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
              disabledHint={scanHint}
            />
            <aside className="ssn-side">
              <SessionCard
                code={session?.code ?? null}
                meta={
                  session
                    ? `Started ${formatDateTime(session.startedAt)}${session.startedBy ? ` · ${session.startedBy}` : ""}`
                    : copy.moveOut.scanStartHint
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

/**
 * Raw Material Output: the station where this computer writes the raw material store, and a packet lookup
 * where another computer does (docs/37 section W). The station itself is unchanged.
 */
export const RawMaterialOutputPage: React.FC<RawMaterialOutputPageProps> = (props) => (
  <LeasedStation
    domain={LEASE_DOMAIN.RAW_MATERIAL_STORE}
    reader={(status) => (
      <ReaderStation
        status={status}
        embedded={props.embedded}
        onBack={props.onBack}
        eyebrow={props.embedded ? undefined : "Store Station · Raw Material"}
        title={props.embedded ? undefined : "Raw Material Output"}
      />
    )}
  >
    <RawMaterialOutputStation {...props} />
  </LeasedStation>
);
