import { useCallback, useEffect, useMemo, useState } from "react";
import { isMachineProgramCodeScan, isRawMaterialIssuePartyType } from "@erp/domain";
import { useDesktopApi } from "../../../hooks/useDesktopApi";
import { useNotifications } from "../../../state/NotificationsContext";
import { copy } from "../../../config/copy";
import { playScanSound } from "../../../utils/playScanSound";
import { partyOption } from "../../parties/partyOption";
import { openIssueSlipPrintWindow } from "../../rawMaterial/issueSlip";
import { useScanBox, type ScanBox } from "../../scanStation/useScanBox";
import type { ScanStationFeedback, StationScanRow } from "../../scanStation/scanStation";
import type { SearchableComboboxOption } from "../../../components/shared/SearchableCombobox";
import type { Party, RawMaterialIssueSession, RawMaterialIssueSessionRow, RawMaterialIssueSessionSummary } from "../../../types/desktopApi";
import { ISSUING_IDLE, choosePartyFirst, issuingFeedbackFor } from "./issuingFeedback";
import { issuingScanState, type ScanState } from "./scanState";
import { useIssueSession } from "./useIssueSession";

// THE ISSUING STATION — everything Scan Out does, without how it looks. The full-screen Raw
// Material Output page and the Store page's Scan out rail both draw it (0.3.9).
//
// ONE SESSION, ONE PARTY (0.3.8): choose the party, Start issuing, scan, End session. The session is
// locked to its party while it runs, and the main process holds the same rule on every scan.
//
// The scan box is armed only while the station is ACTIVE and its session is locked to a party. A
// machine program sheet scanned into it is handed up (onMachineProgramScan), not refused.

export interface IssuingStation {
  parties: Party[];
  partyOptions: SearchableComboboxOption[];
  partiesError: string | null;
  reloadParties: () => Promise<void>;
  partyId: string;
  choosePartyId: (partyId: string) => void;
  chosenParty: Party | undefined;
  /** The party the running session is locked to. */
  lockedParty: Party | undefined;
  locked: boolean;
  session: RawMaterialIssueSession | null;
  summary: RawMaterialIssueSessionSummary | null;
  sessionError: string | null;
  reloadSession: () => Promise<void>;
  startSession: () => Promise<void>;
  endSession: () => Promise<void>;
  print: () => void;
  /** The last session this computer closed, to reprint its slip. */
  lastSession: RawMaterialIssueSessionRow | null;
  /** Prints any session's slip again — the last one, or one from Issued today. */
  reprint: (sessionId: string) => Promise<void>;
  reprintLast: () => Promise<void>;
  feedback: ScanStationFeedback;
  panelFeedback: ScanStationFeedback;
  state: ScanState;
  scanBox: ScanBox;
  rows: StationScanRow[];
}

interface IssuingInput {
  token: string;
  username?: string;
  active: boolean;
  /** Told which session is open, so a machine program batch can ride it onto the same slip. */
  onSessionChange?: (sessionId: string | null) => void;
  onMachineProgramScan?: (code: string) => void;
}

const RECENT_LIMIT = 12;

const rowsOf = (summary: RawMaterialIssueSessionSummary | null): StationScanRow[] =>
  (summary?.scans ?? [])
    .slice(-RECENT_LIMIT)
    .reverse()
    .map((scan) => ({
      key: `${scan.qrId}|${scan.issuedAt}`,
      qrId: scan.qrId,
      product: `${scan.itemDisplayName} · ${scan.quantity} ${scan.unitCode}`.trim(),
      at: scan.issuedAt,
      badge: scan.sectionName ?? "Issued",
    }));

/** Only active suppliers and contractors may be moved out to — the rule the main process enforces. */
const useIssueParties = () => {
  const api = useDesktopApi();
  const [parties, setParties] = useState<Party[]>([]);
  const [partiesError, setPartiesError] = useState<string | null>(null);
  const reloadParties = useCallback(async () => {
    setPartiesError(null);
    try {
      const result = await api.listParties({ pageSize: 1000 });
      setParties(result.rows.filter((party) => party.status === "ACTIVE" && isRawMaterialIssuePartyType(party.partyType)));
    } catch (error) {
      setPartiesError(error instanceof Error ? error.message : copy.states.loadFailedBody);
    }
  }, [api]);
  useEffect(() => {
    void reloadParties();
  }, [reloadParties]);
  return { parties, partiesError, reloadParties };
};

export const useIssuingStation = ({ token, username, active, onSessionChange, onMachineProgramScan }: IssuingInput): IssuingStation => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const { parties, partiesError, reloadParties } = useIssueParties();
  const [feedback, setFeedback] = useState<ScanStationFeedback>(ISSUING_IDLE);
  const run = useIssueSession({ token, onStarted: () => setFeedback(ISSUING_IDLE) });
  const { session, summary, sessionPartyId, partyId, setPartyId, locked } = run;

  useEffect(() => {
    onSessionChange?.(session?.status === "OPEN" ? session.id : null);
  }, [onSessionChange, session]);

  const runScan = useCallback(
    async (code: string): Promise<boolean> => {
      // A program sheet belongs to the machine programs, not to this station.
      if (onMachineProgramScan && isMachineProgramCodeScan(code)) {
        onMachineProgramScan(code);
        return true;
      }
      if (!session || session.status !== "OPEN") return false;
      // No party, no move: turned away here without a call. The main process refuses it too.
      if (!sessionPartyId) {
        setFeedback((previous) => choosePartyFirst(previous.seq + 1));
        playScanSound("error");
        return false;
      }
      const result = await api.rawMaterialIssueScan(code, { token, sessionId: session.id, issuedToPartyId: sessionPartyId });
      setFeedback((previous) => issuingFeedbackFor(result, previous.seq + 1));
      playScanSound(result.accepted ? "success" : "error");
      if (result.accepted) await run.refreshSummary(session.id);
      return result.accepted;
    },
    [api, onMachineProgramScan, run, session, sessionPartyId, token]
  );

  const scanBox = useScanBox({ armed: active && locked, onScan: runScan, refocusKey: feedback.seq });
  const { focusScanner } = scanBox;

  const choosePartyId = useCallback(
    (next: string) => {
      setPartyId(next);
      setFeedback(ISSUING_IDLE);
      // Hand the keyboard straight back to the scanner once the party is chosen.
      setTimeout(focusScanner, 0);
    },
    [focusScanner, setPartyId]
  );

  const endSession = useCallback(async () => {
    const packets = summary?.totalPackets ?? 0;
    if (await run.endSession()) push("success", copy.storeStation.sessionClosed, copy.storeStation.issuedCount(packets));
  }, [push, run, summary]);

  const print = useCallback(() => {
    if (summary && !openIssueSlipPrintWindow(summary, username)) push("error", copy.toast.popupBlocked, copy.storeStation.popupBlocked);
  }, [push, summary, username]);

  const reprint = useCallback(
    async (sessionId: string) => {
      const past = await api.getRawMaterialIssueSessionSummary(sessionId);
      if (past && !openIssueSlipPrintWindow(past, username)) push("error", copy.toast.popupBlocked, copy.storeStation.popupBlocked);
    },
    [api, push, username]
  );
  const lastId = run.lastSession?.session.id;
  const reprintLast = useCallback(async () => {
    if (lastId) await reprint(lastId);
  }, [lastId, reprint]);

  const lockedParty = parties.find((party) => party.id === sessionPartyId);
  const state = issuingScanState({ canScan: locked, partyName: lockedParty?.partyName ?? null, packets: locked ? (summary?.totalPackets ?? 0) : 0 });
  const partyOptions = useMemo(() => parties.map(partyOption), [parties]);

  return {
    parties, partyOptions, partiesError, reloadParties, partyId, choosePartyId,
    chosenParty: parties.find((party) => party.id === partyId), lockedParty, locked,
    session, summary, sessionError: run.sessionError, reloadSession: run.reload, startSession: run.startSession, endSession, print,
    lastSession: run.lastSession, reprint, reprintLast, feedback,
    panelFeedback: feedback.tone === "idle" ? { ...feedback, title: state.title, message: state.line } : feedback,
    state, scanBox, rows: rowsOf(summary),
  };
};
