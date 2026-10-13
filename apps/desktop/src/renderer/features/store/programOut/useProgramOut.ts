import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDesktopApi } from "../../../hooks/useDesktopApi";
import { useNotifications } from "../../../state/NotificationsContext";
import { copy } from "../../../config/copy";
import { playScanSound } from "../../../utils/playScanSound";
import { openCartonLabelPrintWindow } from "../../../utils/qrLabels";
import type {
  IssuedProgramPacket,
  MachineProgramCartonPacket,
  MachineProgramFixCartonRun,
  MachineProgramIssueBatchRow,
  MachineProgramLineCartons,
  MachineProgramRecord,
  QrCodeRow,
  SaveMachineProgramBatchResult,
} from "../../../types/desktopApi";
import type { ScanStationFeedback } from "../../scanStation/scanStation";
import {
  IDLE_FEEDBACK,
  blockedCartonPackets,
  blockedFixCartonRuns,
  cartonRunLabel,
  fixCartonRuns,
  feedbackForIssue,
  formatQuantity,
  pendingCartonRuns,
  printedCartonRuns,
  printedFixCartonRuns,
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
  /** Why the open program cannot be issued against (fully issued, deleted, not planned), or null. */
  issueBlockedReason: string | null;
  /** True while a scan is being committed. */
  issuing: boolean;
  feedback: ScanStationFeedback;
  /** What this sitting has taken out, newest first. */
  issued: IssuedProgramPacket[];
  /** Cartons owed for every packet the program has taken out, still without labels. */
  cartonRuns: CartonRun[];
  /** Carton runs already generated for the program, for the record on screen. */
  printedRuns: PrintedCartonRun[];
  /** Unlabelled packets whose cartons cannot be worked out, with the reason. */
  blockedCartons: MachineProgramCartonPacket[];
  /** FIX runs whose cartons cannot be worked out, with the reason. */
  blockedFixCartons: MachineProgramFixCartonRun[];
  /** Per upper line: cartons due back for what was issued, and how many are back (Store In). */
  cartonProgress: MachineProgramLineCartons[];
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
  /** Prints an already-printed run's labels again, with the same QR codes. */
  reprintCartons: (run: PrintedCartonRun) => Promise<void>;
  reload: () => Promise<void>;
}

interface UseProgramOutInput {
  token: string;
  /** The terminal's open Raw Material Output session, so the packets print on its issue slip. */
  sessionId: string | null;
}

/**
 * Opens the print window for one carton run's labels — the first print and every reprint alike,
 * so a reprinted label can never look different from the one it replaces.
 */
export const openCartonRunLabels = (
  what: string,
  codes: Pick<QrCodeRow, "id" | "article" | "color" | "size">[],
  programCode: string,
  /** A FIX article's second sole, so the sticker names both. Null for an ordinary carton. */
  innerColor: string | null = null,
  /** "B" for a run of B carton labels: a B in the corner, COLOUR MIX (migration 074). */
  grade: "B" | null = null
): boolean => {
  const ids = codes.map((code) => code.id);
  const range = ids.length === 1 ? ids[0] : `${ids[0]} → ${ids[ids.length - 1]}`;
  return openCartonLabelPrintWindow({
    title: `Carton QR — ${what}`,
    heading: what,
    subheading: `${range} · ${copy.programOut.cartonCount(ids.length)} · ${programCode}`,
    identity: { article: codes[0].article, color: codes[0].color, size: codes[0].size, innerColor, grade },
    ids,
  });
};

export const useProgramOut = ({ token, sessionId }: UseProgramOutInput): ProgramOutState => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const [program, setProgram] = useState<MachineProgramRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issueBlockedReason, setIssueBlockedReason] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [feedback, setFeedback] = useState<ScanStationFeedback>(IDLE_FEEDBACK);
  const [issued, setIssued] = useState<IssuedProgramPacket[]>([]);
  const [cartonPackets, setCartonPackets] = useState<MachineProgramCartonPacket[]>([]);
  // A FIX article issues nothing, so its cartons are owed by the plan rather than by a packet
  // and arrive as their own list (migration 071).
  const [fixCartons, setFixCartons] = useState<MachineProgramFixCartonRun[]>([]);
  const [cartonProgress, setCartonProgress] = useState<MachineProgramLineCartons[]>([]);
  const [printingKey, setPrintingKey] = useState<string | null>(null);
  const [history, setHistory] = useState<MachineProgramIssueBatchRow[]>([]);

  const seq = useRef(0);
  // A wedge scanner can fire the next code before React has re-rendered, so "is a scan already
  // being committed" is read through a ref rather than from state.
  const inFlight = useRef(false);

  // The issued history and the cartons owed for it are both read back from the events, so they
  // are the same whoever opens the program, whenever — not just what this sitting scanned.
  const loadHistory = useCallback(
    async (programId: string) => {
      const [batches, cartons] = await Promise.all([
        api.listMachineProgramIssueBatches(programId, { token }),
        api.listMachineProgramCartonPackets(programId, { token }),
      ]);
      setHistory(batches.accepted ? batches.rows : []);
      setCartonPackets(cartons.accepted ? cartons.rows : []);
      setCartonProgress(cartons.accepted ? (cartons.progress ?? []) : []);
      setFixCartons(cartons.accepted ? (cartons.fixRuns ?? []) : []);
      if (!cartons.accepted) setError(cartons.reason ?? copy.states.loadFailedBody);
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
        // A program that exists is always opened, issuable or not: a fully issued one is still
        // read, and still owed its carton labels. The screen shows its status in place of the
        // scanner, so a refusal to ISSUE is not an error here.
        if (!result.program) {
          setError(result.reason ?? copy.states.loadFailedBody);
          return false;
        }
        setProgram(result.program);
        setIssueBlockedReason(result.accepted ? null : (result.reason ?? null));
        setIssued([]);
        setCartonPackets([]);
        setCartonProgress([]);
        setFixCartons([]);
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
    if (result.program) {
      setProgram(result.program);
      setIssueBlockedReason(result.accepted ? null : (result.reason ?? null));
    } else if (!result.accepted) setError(result.reason ?? null);
    await loadHistory(program.id);
  }, [api, loadHistory, program, token]);

  const close = useCallback(() => {
    setProgram(null);
    setIssueBlockedReason(null);
    setIssued([]);
    setCartonPackets([]);
    setCartonProgress([]);
    setFixCartons([]);
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
   * The main process works out the count from the packets themselves (1 DOZEN = 2 cartons),
   * reserves the identities and records the packets as labelled in one transaction — so the same
   * uppers can never be labelled twice, from this terminal or another. A blocked print window
   * does not undo them: they are registered and can be reprinted from QR Management.
   */
  const printCartons = useCallback(
    async (run: CartonRun) => {
      if (printingKey || !program) return;
      setPrintingKey(run.key);
      const what = cartonRunLabel(run);
      try {
        // The same call either way: the packets a run is owed to, or the FIX run itself.
        const result = await api.printMachineProgramCartons(
          run.source.kind === "FIX_RUN"
            ? { programId: program.id, runId: run.source.runId }
            : { programId: program.id, eventIds: run.source.eventIds },
          { token }
        );
        if (!result.accepted || !result.batch || !result.qrCodes || result.qrCodes.length === 0) {
          push("error", copy.programOut.cartonFailedTitle, result.reason ?? copy.states.loadFailedBody);
          return;
        }

        const source = run.source;
        const innerSole =
          source.kind === "FIX_RUN"
            ? (fixCartons.find((candidate) => candidate.runId === source.runId)?.innerSoleColour ?? null)
            : null;
        const opened = openCartonRunLabels(what, result.qrCodes, program.code, innerSole);
        if (!opened) push("error", copy.toast.popupBlocked, copy.programOut.cartonBlocked);
        else push("success", copy.programOut.cartonPrintedTitle, copy.programOut.cartonPrintedBody(result.qrCodes.length, what));
      } catch (caught) {
        push("error", copy.programOut.cartonFailedTitle, caught instanceof Error ? caught.message : copy.states.loadFailedBody);
      } finally {
        setPrintingKey(null);
        // Re-read either way: a refusal may mean another terminal printed these first.
        await loadHistory(program.id);
      }
    },
    [api, fixCartons, loadHistory, printingKey, program, push, token]
  );

  /**
   * Prints a run's carton labels AGAIN — a label torn, smudged or lost before the carton came back.
   *
   * The same QR codes, read back from the run they were generated in: nothing is generated and
   * nothing is recorded, so a reprinted label IS the carton it always was, and scanning the
   * original and the reprint can only ever store that one carton in once. A code voided in QR
   * Management is left out — it no longer names a carton.
   */
  const reprintCartons = useCallback(
    async (run: PrintedCartonRun) => {
      if (printingKey || !program) return;
      setPrintingKey(run.key);
      try {
        const codes = (await api.listQrCodesForBatch(run.qrBatchId)).filter((code) => code.status !== "VOID");
        if (codes.length === 0) {
          push("error", copy.programOut.cartonFailedTitle, copy.programOut.cartonReprintNone);
          return;
        }
        // Which fix run this batch was printed for, so a reprint says the same two soles — or, for
        // a B run, the same B and MIX (a B carton has mixed colours, so no inner sole is named).
        const fixRun = fixCartons.find((candidate) => candidate.labels.some((label) => label.qrBatchId === run.qrBatchId));
        const grade = run.grade === "B" ? "B" : null;
        const innerSole = grade ? null : (fixRun?.innerSoleColour ?? null);
        const opened = openCartonRunLabels(run.label, codes, program.code, innerSole, grade);
        if (!opened) push("error", copy.toast.popupBlocked, copy.programOut.cartonBlocked);
        else push("success", copy.programOut.cartonReprintedTitle, copy.programOut.cartonReprintedBody(codes.length, run.label));
      } catch (caught) {
        push("error", copy.programOut.cartonFailedTitle, caught instanceof Error ? caught.message : copy.states.loadFailedBody);
      } finally {
        setPrintingKey(null);
      }
    },
    [api, fixCartons, printingKey, program, push]
  );

  // Both kinds of carton stand in one list, because the operator is printing cartons for a
  // program and should not have to know which of its articles has an upper.
  const cartonRuns = useMemo(
    () => [...pendingCartonRuns(cartonPackets), ...fixCartonRuns(fixCartons)],
    [cartonPackets, fixCartons]
  );
  const printedRuns = useMemo(
    () => [...printedCartonRuns(cartonPackets), ...printedFixCartonRuns(fixCartons)],
    [cartonPackets, fixCartons]
  );
  const blockedCartons = useMemo(() => blockedCartonPackets(cartonPackets), [cartonPackets]);
  const blockedFixCartons = useMemo(() => blockedFixCartonRuns(fixCartons), [fixCartons]);

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
    issueBlockedReason,
    issuing,
    feedback,
    issued,
    cartonRuns,
    blockedFixCartons,
    printedRuns,
    blockedCartons,
    cartonProgress,
    printingKey,
    history,
    open,
    close,
    scan,
    printCartons,
    reprintCartons,
    reload,
  };
};
