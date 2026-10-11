import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDesktopApi } from "../../../hooks/useDesktopApi";
import { useNotifications } from "../../../state/NotificationsContext";
import { copy } from "../../../config/copy";
import { playScanSound } from "../../../utils/playScanSound";
import { openCartonLabelPrintWindow } from "../../../utils/qrLabels";
import type {
  IssuedProgramPacket,
  MachineProgramIssueBatchRow,
  MachineProgramRecord,
  SaveMachineProgramBatchResult,
} from "../../../types/desktopApi";
import type { ScanStationFeedback } from "../../scanStation/scanStation";
import {
  IDLE_FEEDBACK,
  cartonRunLabel,
  feedbackForIssue,
  formatQuantity,
  pendingCartonRuns,
  type CartonRun,
  type PrintedCartonRun,
} from "./programOut";

// MACHINE MOVE OUT — the state of Store Out working through one open Machine Program.
//
//   open(lookup)   →  program          the backend resolves it and says whether it may be issued
//   scan(code)     →  issued           the packet leaves the store THERE AND THEN, or is refused
//   printCartons() →  carton QR run    the labels for what the machine will send back
//
// One scan is one movement. There is no staging list and nothing to press afterwards: if the
// program authorises the packet, it is out of the store before the operator's hand is off the
// scanner, and if it does not, nothing moved and the reason is on the screen.
//
// Every rule is the main process's. This hook asks, shows the answer, and decides nothing about
// whether a packet may be issued or how many cartons it will come back as.
//
// The write it calls is the same program-restricted, idempotent batch commit the screen has
// always used — a batch of exactly one packet, with its own key, so a reply lost on the way back
// can never issue a packet twice.

export interface ProgramOutState {
  /** The open program, re-read after every write. Null when none is open. */
  program: MachineProgramRecord | null;
  loading: boolean;
  /** Why the last lookup or scan failed, for the error state. Cleared by the next action. */
  error: string | null;
  /** True while a scan is being committed. */
  issuing: boolean;
  feedback: ScanStationFeedback;
  /** What this sitting has taken out, newest first. */
  issued: IssuedProgramPacket[];
  /** Cartons from those packets that still have no labels. */
  cartonRuns: CartonRun[];
  /** Carton runs already generated, for the record on screen. */
  printedRuns: PrintedCartonRun[];
  /** The run being generated right now, by key. */
  printingKey: string | null;
  /** Every packet ever issued against this program, read back from the event log. */
  history: MachineProgramIssueBatchRow[];
  /** The session token, so a child section can authorise its own calls with the same one. */
  token: string;
  open: (lookup: string) => Promise<boolean>;
  close: () => void;
  scan: (rawScan: string) => Promise<void>;
  printCartons: (run: CartonRun) => Promise<void>;
  reload: () => Promise<void>;
}

interface UseProgramOutInput {
  token: string;
  /** The terminal's open Raw Material Output session, so the packets print on its issue slip. */
  sessionId: string | null;
  /** The logged-in operator, recorded as who generated a carton QR run. */
  username?: string;
}

export const useProgramOut = ({ token, sessionId, username }: UseProgramOutInput): ProgramOutState => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const [program, setProgram] = useState<MachineProgramRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [feedback, setFeedback] = useState<ScanStationFeedback>(IDLE_FEEDBACK);
  const [issued, setIssued] = useState<IssuedProgramPacket[]>([]);
  const [printedQrIds, setPrintedQrIds] = useState<ReadonlySet<string>>(new Set());
  const [printedRuns, setPrintedRuns] = useState<PrintedCartonRun[]>([]);
  const [printingKey, setPrintingKey] = useState<string | null>(null);
  const [history, setHistory] = useState<MachineProgramIssueBatchRow[]>([]);

  const seq = useRef(0);
  // A wedge scanner can fire the next code before React has re-rendered, so "is a scan already
  // being committed" is read through a ref rather than from state.
  const inFlight = useRef(false);

  const loadHistory = useCallback(
    async (programId: string) => {
      const result = await api.listMachineProgramIssueBatches(programId, { token });
      setHistory(result.accepted ? result.rows : []);
    },
    [api, token]
  );

  const open = useCallback(
    async (lookup: string): Promise<boolean> => {
      const text = lookup.trim();
      if (!text) return false;
      setLoading(true);
      setError(null);
      try {
        const result = await api.openMachineProgramStoreOut(text, { token });
        if (!result.accepted || !result.program) {
          setError(result.reason ?? copy.states.loadFailedBody);
          return false;
        }
        setProgram(result.program);
        setIssued([]);
        setPrintedQrIds(new Set());
        setPrintedRuns([]);
        setFeedback(IDLE_FEEDBACK);
        await loadHistory(result.program.id);
        return true;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : copy.states.loadFailedBody);
        return false;
      } finally {
        setLoading(false);
      }
    },
    [api, loadHistory, token]
  );

  const reload = useCallback(async () => {
    if (!program) return;
    const result = await api.openMachineProgramStoreOut(program.id, { token });
    // A program that has become ineligible while it was open — finished by another terminal,
    // deleted by production — still has to be SHOWN, with the reason, rather than vanishing.
    if (result.program) setProgram(result.program);
    if (!result.accepted) setError(result.reason ?? null);
    await loadHistory(program.id);
  }, [api, loadHistory, program, token]);

  const close = useCallback(() => {
    setProgram(null);
    setIssued([]);
    setPrintedQrIds(new Set());
    setPrintedRuns([]);
    setError(null);
    setFeedback(IDLE_FEEDBACK);
    setHistory([]);
  }, []);

  /**
   * One scan: the packet leaves the store now, or nothing happens and the operator is told why.
   *
   * The batch key is made here, per scan, and the commit is idempotent on it — so a reply that
   * never arrives leaves exactly one issuance behind, not two.
   */
  const scan = useCallback(
    async (rawScan: string) => {
      const qrId = String(rawScan ?? "").trim().toUpperCase();
      if (!program || !qrId || inFlight.current) return;
      inFlight.current = true;
      setIssuing(true);
      seq.current += 1;

      let result: SaveMachineProgramBatchResult;
      try {
        result = await api.machineProgramStoreOutSaveBatch(
          { programId: program.id, batchKey: crypto.randomUUID(), sessionId, qrIds: [qrId] },
          { token }
        );
      } catch {
        result = { accepted: false, outcome: "ERROR", reason: copy.states.loadFailedBody, refusedQrId: qrId };
      } finally {
        inFlight.current = false;
        setIssuing(false);
      }

      setFeedback(feedbackForIssue(result, qrId, seq.current));
      playScanSound(result.accepted ? "success" : "error");

      if (!result.accepted) {
        setError(result.reason ?? copy.states.loadFailedBody);
        if (result.program) setProgram(result.program);
        return;
      }

      setError(null);
      const packet = result.packets?.[0];
      if (packet) setIssued((previous) => [packet, ...previous]);
      // Issued and remaining come back from the event log this scan just added to; they are
      // never patched on screen.
      if (result.program) setProgram(result.program);
      if (result.programCompleted) {
        push("info", copy.programOut.completedTitle, copy.programOut.completedBody(program.code));
      }
      await loadHistory(program.id);
    },
    [api, loadHistory, program, push, sessionId, token]
  );

  /**
   * Generates and prints the carton QR labels for one run of what has gone out.
   *
   * The identities are reserved by the QR Generator's own call — the one place carton codes are
   * created — so these labels are ordinary carton QRs and behave like any other from the moment
   * they are printed. A blocked print window does not undo them: they are already registered and
   * can be reprinted from QR Management, which is what the operator is told.
   */
  const printCartons = useCallback(
    async (run: CartonRun) => {
      if (printingKey) return;
      setPrintingKey(run.key);
      const what = cartonRunLabel(run);
      try {
        const result = await api.generateQrBatch({
          articleSizeId: run.articleSizeId,
          color: run.colour,
          quantity: run.cartons,
          createdBy: username?.trim() || undefined,
          requestedBy: program ? program.code : undefined,
        });
        if (!result.accepted || !result.batch || !result.qrCodes || result.qrCodes.length === 0) {
          push("error", copy.programOut.cartonFailedTitle, result.reason ?? copy.states.loadFailedBody);
          return;
        }

        const ids = result.qrCodes.map((code) => code.id);
        const range = ids.length === 1 ? ids[0] : `${ids[0]} → ${ids[ids.length - 1]}`;
        setPrintedQrIds((previous) => new Set([...previous, ...run.qrIds]));
        setPrintedRuns((previous) => [
          { key: `${run.key}:${result.batch!.id}`, label: what, cartons: ids.length, range, at: new Date().toISOString() },
          ...previous,
        ]);

        const opened = openCartonLabelPrintWindow({
          title: `Carton QR — ${what}`,
          heading: what,
          subheading: `${range} · ${copy.programOut.cartonCount(ids.length)} · ${program?.code ?? ""}`.trim(),
          identity: { article: result.batch.article, color: result.batch.color, size: result.batch.size },
          ids,
        });
        if (!opened) push("error", copy.toast.popupBlocked, copy.programOut.cartonBlocked);
        else push("success", copy.programOut.cartonPrintedTitle, copy.programOut.cartonPrintedBody(ids.length, what));
      } catch (caught) {
        push(
          "error",
          copy.programOut.cartonFailedTitle,
          caught instanceof Error ? caught.message : copy.states.loadFailedBody
        );
      } finally {
        setPrintingKey(null);
      }
    },
    [api, printingKey, program, push, username]
  );

  const cartonRuns = useMemo(() => pendingCartonRuns(issued, printedQrIds), [issued, printedQrIds]);

  // A packet that left is worth announcing once, in words, for an operator watching the toast
  // area rather than the scan card.
  const lastIssued = issued[0];
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (!lastIssued || !program || announced.current === lastIssued.qrId) return;
    announced.current = lastIssued.qrId;
    push(
      "success",
      copy.programOut.issuedTitle,
      copy.programOut.issuedBody(
        lastIssued.itemDisplayName,
        formatQuantity(lastIssued.quantity, lastIssued.unitCode),
        program.code
      )
    );
  }, [lastIssued, program, push]);

  return {
    token,
    program,
    loading,
    error,
    issuing,
    feedback,
    issued,
    cartonRuns,
    printedRuns,
    printingKey,
    history,
    open,
    close,
    scan,
    printCartons,
    reload,
  };
};
