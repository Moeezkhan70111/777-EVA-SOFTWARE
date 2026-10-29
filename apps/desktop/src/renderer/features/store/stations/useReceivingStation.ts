import { useCallback, useEffect, useMemo, useState } from "react";
import { isRawMaterialReceiptPartyType } from "@erp/domain";
import { useDesktopApi } from "../../../hooks/useDesktopApi";
import { useNotifications } from "../../../state/NotificationsContext";
import { copy } from "../../../config/copy";
import { playScanSound } from "../../../utils/playScanSound";
import { partyOption } from "../../parties/partyOption";
import { openReceivingReceiptPrintWindow } from "../../rawMaterial/receivingReceipt";
import { useScanBox, type ScanBox } from "../../scanStation/useScanBox";
import type { ScanStationFeedback, StationScanRow } from "../../scanStation/scanStation";
import type { SearchableComboboxOption } from "../../../components/shared/SearchableCombobox";
import type { Party, RawMaterialReceivingSession, RawMaterialReceivingSessionSummary } from "../../../types/desktopApi";
import { RECEIVING_IDLE, receivingFeedbackFor } from "./receivingFeedback";
import { receivingScanState, type ScanState } from "./scanState";

// THE RECEIVING STATION — everything Move In does, without how it looks: the supplier, the session,
// the scans and the slip. The full-screen Raw Material Input page and the Store page's Scan in rail
// both draw it, so there is one set of rules for receiving (0.3.9).
//
// Receiving is supplier-at-a-time: the session is opened for a supplier and every packet is checked
// against it by the main process. A session open on this computer is picked up again on arrival,
// whatever day it was started.
//
// The scan box is armed only while the station is ACTIVE (its mode is the one on screen) and a
// session is open, so a station waiting behind the other mode never takes the scanner's focus.

export interface ReceivingStation {
  suppliers: Party[];
  supplierOptions: SearchableComboboxOption[];
  partyId: string;
  setPartyId: (partyId: string) => void;
  session: RawMaterialReceivingSession | null;
  summary: RawMaterialReceivingSessionSummary | null;
  /** The session's supplier, for its type badge. */
  sessionSupplier: Party | undefined;
  open: boolean;
  busy: boolean;
  loadError: string | null;
  reload: () => Promise<void>;
  startSession: () => Promise<void>;
  endSession: () => Promise<void>;
  print: () => void;
  /** The last scan's answer; idle until the first scan. */
  feedback: ScanStationFeedback;
  /** The scan panel's headline: the scan state while nothing has been scanned, the answer after. */
  panelFeedback: ScanStationFeedback;
  state: ScanState;
  scanBox: ScanBox;
  rows: StationScanRow[];
}

const RECENT_LIMIT = 12;

const rowsOf = (summary: RawMaterialReceivingSessionSummary | null): StationScanRow[] =>
  (summary?.scans ?? [])
    .slice(-RECENT_LIMIT)
    .reverse()
    .map((scan) => ({
      key: `${scan.qrId}|${scan.receivedAt}`,
      qrId: scan.qrId,
      product: `${scan.itemDisplayName} · ${scan.quantity} ${scan.unitCode}`.trim(),
      at: scan.receivedAt,
      badge: "In Store",
    }));

export const useReceivingStation = ({ token, username, active }: { token: string; username?: string; active: boolean }): ReceivingStation => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const [suppliers, setSuppliers] = useState<Party[]>([]);
  const [partyId, setPartyId] = useState("");
  const [session, setSession] = useState<RawMaterialReceivingSession | null>(null);
  const [summary, setSummary] = useState<RawMaterialReceivingSessionSummary | null>(null);
  const [feedback, setFeedback] = useState<ScanStationFeedback>(RECEIVING_IDLE);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const open = session?.status === "OPEN";

  const refreshSummary = useCallback(async (sessionId: string) => setSummary(await api.getRawMaterialReceivingSessionSummary(sessionId)), [api]);

  const reload = useCallback(async () => {
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
    void reload();
  }, [reload]);

  const startSession = useCallback(async () => {
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
      setFeedback(RECEIVING_IDLE);
      await refreshSummary(result.session.id);
    } finally {
      setBusy(false);
    }
  }, [api, partyId, push, refreshSummary, token]);

  const endSession = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    try {
      setSession(await api.closeRawMaterialReceivingSession(session.id));
      await refreshSummary(session.id);
      push("success", copy.storeStation.sessionClosed, copy.storeStation.receivedCount(summary?.totalPackets ?? 0));
    } finally {
      setBusy(false);
    }
  }, [api, push, refreshSummary, session, summary]);

  const runScan = useCallback(
    async (code: string): Promise<boolean> => {
      if (!session || session.status !== "OPEN") return false;
      const result = await api.rawMaterialReceiptScan(code, { token, sessionId: session.id });
      setFeedback((previous) => receivingFeedbackFor(result, previous.seq + 1));
      playScanSound(result.accepted ? "success" : "error");
      if (result.accepted) await refreshSummary(session.id);
      return result.accepted;
    },
    [api, refreshSummary, session, token]
  );

  const scanBox = useScanBox({ armed: active && open, onScan: runScan, refocusKey: feedback.seq });

  const print = useCallback(() => {
    if (summary && !openReceivingReceiptPrintWindow(summary, username)) push("error", copy.toast.popupBlocked, copy.storeStation.popupBlocked);
  }, [push, summary, username]);

  const state = receivingScanState({ canScan: open, partyName: session?.partyName ?? null, packets: open ? (summary?.totalPackets ?? 0) : 0 });
  const panelFeedback = feedback.tone === "idle" ? { ...feedback, title: state.title, message: state.line } : feedback;
  const supplierOptions = useMemo(() => suppliers.map(partyOption), [suppliers]);
  const sessionSupplier = suppliers.find((party) => party.id === session?.partyId);

  return {
    suppliers, supplierOptions, partyId, setPartyId, session, summary, sessionSupplier, open, busy, loadError,
    reload, startSession, endSession, print, feedback, panelFeedback, state, scanBox, rows: rowsOf(summary),
  };
};
