import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDesktopApi } from "../hooks/useDesktopApi";
import type {
  Party,
  RawMaterialReceiptResult,
  RawMaterialReceivingSession,
  RawMaterialReceivingSessionSummary,
} from "../types/desktopApi";
import type { AppRoute } from "../app/routes";
import { SearchableCombobox } from "../components/shared/SearchableCombobox";
import { PartyTypeBadge } from "../features/parties/PartyTypeBadge";
import { partyOption } from "../features/parties/partyOption";
import { useNotifications } from "../state/NotificationsContext";
import { playScanSound } from "../utils/playScanSound";
import { copy } from "../config/copy";
import { formatDateTime } from "../utils/dates";
import { openReceivingReceiptPrintWindow } from "../features/rawMaterial/receivingReceipt";
import { isCompleteQr, sanitizeScanInput } from "../utils/qr";
import { LEASE_DOMAIN, isRawMaterialReceiptPartyType, isValidRawMaterialQrId } from "@erp/domain";
import { LeasedStation } from "../features/store/LeasedStation";
import { ReaderStation } from "../features/store/ReaderStation";
import { PersonIcon } from "../features/store/StoreIcons";
import { ScanPartyHeader } from "../features/store/ScanPartyHeader";
import { ScanSessionButton } from "../features/store/ScanSessionButton";
import { materialScanRow, sessionGroups } from "../features/rawMaterial/sessionGroups";
import { quantityTotalLine } from "../features/rawMaterial/storeVoucher";
import type { StationStatus } from "../features/store/page/stationStatus";
import {
  LastScanCard,
  RecentScansCard,
  RecentScansList,
  SCAN_STATION_CSS,
  ScanPanel,
  SessionCard,
  SessionGroupsCard,
  StationBlocked,
  StationToolbar,
} from "../features/scanStation/scanStation";
import type { ScanStationFeedback, StationScanRow } from "../features/scanStation/scanStation";

// Raw Material Input — receiving a supplier's delivery into the store.
//
// The same station as Store Move In and Move Out: same chrome, same scan panel, same
// session card, same recent table (features/scanStation). What differs is the identity it
// handles and the one rule that comes with it — receiving is a supplier-at-a-time job, so
// the session is opened against a party and every packet is checked against it.
//
// A carton and a raw material packet never share a scanner: this screen turns a carton
// away, and the carton screens turn a packet away with a pointer here.

const RECENT_LIMIT = 12;

const IDLE: ScanStationFeedback = {
  tone: "idle",
  title: copy.store.readyToScan,
  message: "Scan a raw material packet",
  result: null,
  seq: 0,
};

/** "1 BAG (25 KILOGRAM)", or nothing when the packing is unknown. */
const packingLabel = (quantity?: number, unitCode?: string | null, packName?: string | null): string =>
  quantity == null ? "" : `1 ${(packName ?? "").trim() || "PACK"} (${quantity} ${unitCode ?? ""})`.trim();

/** Turns the business layer's answer into what the operator reads. Text always, never colour alone. */
const feedbackFor = (result: RawMaterialReceiptResult, seq: number): ScanStationFeedback => {
  const packing = packingLabel(result.packingQuantity, result.packingUnitCode, result.packName);
  const base = {
    seq,
    result: {
      qrId: result.qrId,
      product: result.itemDisplayName,
      fromStatus: "Generated",
      toStatus: "In Store",
      currentStatusLabel: result.currentStatus === "IN_STORE" ? "In Store" : (result.currentStatus ?? null),
      facts: [
        { label: "Raw material", value: result.itemDisplayName },
        { label: "Supplier", value: result.partyName },
        { label: "One pack", value: packing },
      ],
      at: result.receivedAt,
    },
  };

  switch (result.outcome) {
    case "RECEIVED":
      return { ...base, tone: "success", title: "✓ RECEIVED", message: `${packing || "Pack"} added to stock` };
    case "ALREADY_IN_STORE":
      return { ...base, tone: "warn", title: "⚠ ALREADY RECEIVED", message: result.reason ?? "This packet has already been received." };
    case "WRONG_PARTY":
      return { ...base, tone: "error", title: "✕ WRONG SUPPLIER", message: result.reason ?? "This packet belongs to another supplier." };
    case "UNKNOWN_QR":
      return { ...base, tone: "error", title: "✕ NOT REGISTERED", message: "This QR has not been generated in the system." };
    case "NOT_CONFIGURED":
      return { ...base, tone: "error", title: "✕ PACK NOT SET", message: result.reason ?? "Set what one pack of this material holds first." };
    case "INVALID_FORMAT":
      return { ...base, tone: "error", title: "✕ NOT A RAW MATERIAL QR", message: result.reason ?? "This is not a raw material label." };
    case "NOT_AUTHORIZED":
      return { ...base, tone: "error", title: "✕ NOT AUTHORISED", message: result.reason ?? "Your account cannot receive raw material." };
    case "NOT_ELIGIBLE":
      return { ...base, tone: "error", title: "✕ CANNOT RECEIVE", message: result.reason ?? "This packet cannot be received." };
    case "STATUS_CHANGED":
      return { ...base, tone: "warn", title: "⚠ TRY AGAIN", message: result.reason ?? "Another terminal moved this packet." };
    default:
      return { ...base, tone: "error", title: "✕ NOT RECEIVED", message: result.reason ?? "The scan could not be saved." };
  }
};

interface RawMaterialInputPageProps {
  /** Session token; the main process authorises every receipt call with it. */
  token: string;
  username?: string;
  /** Returns to where the station was opened from. Hidden when not provided. */
  onBack?: () => void;
  onNavigate?: (route: AppRoute) => void;
  /**
   * Shown as the right half of the Move In desk, beside the new-material form or the label
   * generator. Same station and the same session — only the layout stacks to fit the pane.
   */
  embedded?: boolean;
  /**
   * False while this panel's mode is not the one on the Store page (or a machine program has the
   * page): it then never takes the scanner's focus, so a scan can only land in the mode on screen.
   */
  active?: boolean;
  /** Where this panel's session stands, for the Store page's mode switch. */
  onStatus?: (status: StationStatus) => void;
  /**
   * Given where the screen around the station shows Print receipt (the Store page's rail head): the
   * station hands it the print action while a session is open, and leaves its own button out.
   */
  onPrintReceipt?: (print: (() => void) | null) => void;
}

const RawMaterialInputStation: React.FC<RawMaterialInputPageProps> = ({ token, username, onBack, onNavigate, embedded = false, active = true, onStatus, onPrintReceipt }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const [suppliers, setSuppliers] = useState<Party[]>([]);
  const [partyId, setPartyId] = useState("");
  const [session, setSession] = useState<RawMaterialReceivingSession | null>(null);
  const [summary, setSummary] = useState<RawMaterialReceivingSessionSummary | null>(null);
  const [feedback, setFeedback] = useState<ScanStationFeedback>(IDLE);
  const [inputVal, setInputVal] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scannerConnected, setScannerConnected] = useState(false);

  const seq = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const queueRef = useRef<string[]>([]);
  const processingRef = useRef(false);
  const focusScanner = useCallback(() => inputRef.current?.focus(), []);
  // Read when a scan finishes: the Store page may have switched mode while it was being saved.
  const activeRef = useRef(active);
  activeRef.current = active;

  const open = session?.status === "OPEN";
  const scannerReady = Boolean(open);
  // On the desk there is no room for empty cards: the session tally and the recent list
  // appear once there is a session to show. The full-screen station keeps its fixed layout.
  const showSessionDetails = !embedded || session !== null;

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [parties, openSession] = await Promise.all([
        api.listParties({ search: "", status: "ACTIVE", page: 1, pageSize: 500 }),
        api.getOpenRawMaterialReceivingSession(),
      ]);
      setSuppliers(parties.rows.filter((party) => isRawMaterialReceiptPartyType(party.partyType)));
      setSession(openSession);
      if (openSession) {
        setPartyId(openSession.partyId);
        setSummary(await api.getRawMaterialReceivingSessionSummary(openSession.id));
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : copy.states.loadFailedBody);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

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

  // The scanner types into whichever field has focus, so the scan box keeps it.
  useEffect(() => {
    if (scannerReady && active) focusScanner();
  }, [scannerReady, active, feedback.seq, focusScanner]);

  // The Store page's mode switch shows this panel's session state, even while it is hidden.
  useEffect(() => {
    onStatus?.({ sessionId: open ? (session?.id ?? null) : null, open: open, packets: summary?.totalPackets ?? 0 });
  }, [onStatus, session, summary]);


  const supplierOptions = useMemo(
    () => suppliers.map(partyOption),
    [suppliers]
  );

  const scannerPill = scannerConnected
    ? { text: "Scanner ready", color: "#16a34a" }
    : { text: "Keyboard input", color: "#94a3b8" };

  const refreshSummary = useCallback(
    async (sessionId: string) => setSummary(await api.getRawMaterialReceivingSessionSummary(sessionId)),
    [api]
  );

  const startSession = async () => {
    if (!partyId) {
      push("error", "Choose a supplier", "Pick the supplier whose delivery you are receiving.");
      return;
    }
    setBusy(true);
    try {
      const result = await api.startRawMaterialReceivingSession(partyId, { token });
      if (!result.accepted || !result.session) {
        push("error", "Not started", result.reason ?? "The session could not be started.");
        return;
      }
      setSession(result.session);
      setFeedback(IDLE);
      await refreshSummary(result.session.id);
    } finally {
      setBusy(false);
    }
  };

  const endSession = async () => {
    if (!session) return;
    setBusy(true);
    try {
      const closed = await api.closeRawMaterialReceivingSession(session.id);
      setSession(closed);
      await refreshSummary(session.id);
      push("success", "Session closed", `${summary?.totalPackets ?? 0} packet(s) received`);
    } finally {
      setBusy(false);
    }
  };

  const runScan = useCallback(
    async (code: string) => {
      if (!session || session.status !== "OPEN") return;
      seq.current += 1;
      const result = await api.rawMaterialReceiptScan(code, { token, sessionId: session.id });
      setFeedback(feedbackFor(result, seq.current));
      playScanSound(result.accepted ? "success" : "error");
      if (result.accepted) await refreshSummary(session.id);
    },
    [api, refreshSummary, session, token]
  );

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
  // a suffix key, so the station submits as soon as the buffer looks complete rather than
  // waiting for Enter. A raw material label is complete the moment it parses; anything else
  // falls back to a short quiet period after the last keystroke.
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

  const print = useCallback(() => {
    if (!summary) return;
    if (!openReceivingReceiptPrintWindow(summary, username)) {
      push("error", copy.toast.popupBlocked, "Allow popups to print the receipt");
    }
  }, [summary, username, push]);

  // Print receipt in the screen around the station, for as long as there is a session to print.
  useEffect(() => {
    if (!onPrintReceipt) return undefined;
    onPrintReceipt(open && summary ? print : null);
    return () => onPrintReceipt(null);
  }, [onPrintReceipt, open, summary, print]);

  const scanRows: StationScanRow[] = (summary?.scans ?? [])
    .slice(-RECENT_LIMIT)
    .reverse()
    .map((scan) => materialScanRow(scan, scan.receivedAt, "In Store"));
  const sessionMeta = session
    ? `${session.partyName} · started ${formatDateTime(session.startedAt)}${session.startedBy ? ` · ${session.startedBy}` : ""}`
    : "No session open. Choose a supplier above.";

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

      {/* Embedded on the Store page the rail above already says what this is, so the
          station drops its own title rather than saying it twice. */}
      <StationToolbar
        eyebrow={embedded ? undefined : copy.storePage.stationEyebrow}
        title={embedded ? undefined : "Raw Material Input"}
        onBack={onBack}
        // On the Store page the rail's head says Ready / Not Ready, so the scanner pill is left out.
        scannerPill={embedded ? undefined : scannerPill}
      >
        {/* While a session is open the party and End session are in the scan panel itself. */}
        {open ? (
          onPrintReceipt ? null : (
            <button type="button" className="ssn-btn" onClick={print} disabled={!summary}>
              Print receipt
            </button>
          )
        ) : (
          <>
            <div className="ssn-supplier-pick">
              <SearchableCombobox
                value={partyId}
                options={supplierOptions}
                onChange={setPartyId}
                ariaLabel={copy.columns.supplier}
                placeholder={supplierOptions.length === 0 ? "No suppliers yet" : copy.store.selectSupplier}
                icon={<PersonIcon />}
                searchPlaceholder={copy.store.searchParty}
                emptyLabel={copy.store.noPartyMatch}
              />
            </div>
            <PartyTypeBadge partyType={suppliers.find((party) => party.id === partyId)?.partyType} />
            {summary && summary.totalPackets > 0 ? (
              <button type="button" className="ssn-btn ssn-btn--ghost" onClick={print}>
                Print last receipt
              </button>
            ) : null}
          </>
        )}
        {onNavigate ? (
          <button
            type="button"
            className="ssn-btn ssn-btn--ghost"
            onClick={() => onNavigate("raw-material")}
            title="Set what one packet of each material holds"
          >
            Raw Material
          </button>
        ) : null}
      </StationToolbar>

      <div className="ssn-workspace">
        {loadError ? (
          <StationBlocked title="Raw Material Input is not available" message={loadError} onRetry={() => void load()} />
        ) : (
          <>
            {/* The panel carries the session's own controls: Start session until one is open (there
                is nothing a scan could land in yet), then who it is with across the top and End
                session under the scan. */}
            <ScanPanel
              feedback={open ? feedback : { ...IDLE, message: copy.store.scanToBegin }}
              header={
                open && session ? (
                  <ScanPartyHeader
                    eyebrow={copy.store.receivingFrom}
                    name={session.partyName}
                    partyType={suppliers.find((party) => party.id === session.partyId)?.partyType}
                  />
                ) : undefined
              }
              action={<ScanSessionButton open={open} busy={busy} onStart={() => void startSession()} onEnd={() => void endSession()} />}
              // The rail leaves the box out until it could take a scan; the full screen keeps its layout.
              showDock={open || !embedded}
              inputRef={inputRef}
              inputVal={inputVal}
              onInputChange={setInputVal}
              onKeyDown={handleKeyDown}
              onFocusScanner={focusScanner}
              disabled={!scannerReady}
              disabledHint="Start a session first"
            />
            {showSessionDetails && (
              <aside className="ssn-side">
                {/* The Store page's rail groups the session by category, like the recent list;
                    the full-screen station keeps its card. */}
                {embedded ? (
                  <SessionGroupsCard
                    title={copy.store.thisSession}
                    code={session?.code ?? null}
                    meta={sessionMeta}
                    groups={sessionGroups(summary?.byMaterial ?? [], copy.store.noCategory)}
                    total={summary?.totalPackets ?? 0}
                    // Per unit, as the printed receipt totals it, so the two can never disagree.
                    totalAmount={quantityTotalLine(summary?.byMaterial ?? [])}
                    countLabel={copy.storeStation.packets}
                    totalLabel={copy.columns.total}
                    emptyLabel={copy.store.nothingReceivedYet}
                  />
                ) : (
                  <SessionCard
                    code={session?.code ?? null}
                    meta={sessionMeta}
                    tallies={(summary?.byMaterial ?? []).map((row) => ({
                      key: row.itemDisplayName,
                      label: row.itemDisplayName,
                      count: row.packets,
                      // "1 packet · 1 BUNDLE", not "1 · 1 BUNDLE", which reads as a decimal.
                      countLabel: `${copy.storeStation.packets(row.packets)} · ${row.quantity} ${row.unitCode}`,
                    }))}
                    total={summary?.totalPackets ?? 0}
                    totalNoun="packets"
                    groupNoun="Materials"
                    subhead="By material"
                    emptyLabel="Nothing received yet."
                  />
                )}
                {/* On the desk the scan panel and the recent list already show the last packet. */}
                {embedded ? null : <LastScanCard title="Last received" row={scanRows[0] ?? null} />}
              </aside>
            )}
          </>
        )}
      </div>

      {!loadError && showSessionDetails && (
        // The Store page's rail lists them line by line; the full-screen station keeps its table.
        embedded ? (
          <RecentScansList
            title={copy.store.recentlyReceived}
            note={copy.store.lastInSession(RECENT_LIMIT)}
            emptyLabel={copy.store.nothingReceivedYet}
            rows={scanRows}
          />
        ) : (
          <RecentScansCard
            title={copy.store.recentlyReceived}
            note={copy.store.lastInSession(RECENT_LIMIT)}
            emptyLabel={copy.store.nothingReceivedYet}
            rows={scanRows}
          />
        )
      )}
    </div>
  );
};

/**
 * Raw Material Input: the station where this computer writes the raw material store, and a packet lookup
 * where another computer does (docs/37 section W). The station itself is unchanged.
 */
export const RawMaterialInputPage: React.FC<RawMaterialInputPageProps> = (props) => (
  <LeasedStation
    domain={LEASE_DOMAIN.RAW_MATERIAL_STORE}
    reader={(status) => (
      <ReaderStation
        status={status}
        embedded={props.embedded}
        onBack={props.onBack}
        eyebrow={props.embedded ? undefined : copy.storePage.stationEyebrow}
        title={props.embedded ? undefined : "Raw Material Input"}
      />
    )}
  >
    <RawMaterialInputStation {...props} />
  </LeasedStation>
);
