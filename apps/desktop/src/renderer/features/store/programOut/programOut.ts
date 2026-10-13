import { MACHINE_PROGRAM_DISPLAY_STATUS, cartonsExpectedFromUppers, formatShiftRange, isFixRun, roundQuantity } from "@erp/domain";
import type {
  MachineProgramCartonPacket,
  MachineProgramFixCartonRun,
  MachineProgramLineCartonRun,
  MachineProgramLineCartons,
  MachineProgramRecord,
  MachineProgramScanVerdict,
  SaveMachineProgramBatchResult,
} from "../../../types/desktopApi";
import type { ScanStationFeedback } from "../../scanStation/scanStation";
import { copy } from "../../../config/copy";

// Shared vocabulary for Machine Move Out: the row shape the authorised-uppers table reads, the
// carton runs waiting to be labelled, and the handful of formatters the panel needs.
//
// Nothing here decides a business figure. Authorised, issued and remaining arrive already
// computed from the data layer, and so does every carton count — `cartonsFor` below only reads
// back the same domain rule for packets that come from the saved history, which carry a quantity
// and a unit but no carton plan of their own.

/** One authorised upper, flattened out of the program's runs for a flat table. */
export interface ProgramOutRow {
  key: string;
  article: string;
  size: string;
  soleColour: string;
  upper: string;
  upperColour: string;
  authorized: number;
  issued: number;
  remaining: number;
  unitCode: string | null;
}

/** Every upper the program authorises, in the order the program sheet prints them. */
export const programOutRows = (program: MachineProgramRecord): ProgramOutRow[] =>
  program.runs.flatMap((run) =>
    run.lines.map((line) => ({
      key: line.id,
      article: run.article,
      size: run.size,
      soleColour: run.soleColour,
      upper: line.itemDisplayName,
      upperColour: line.upperColour,
      authorized: line.quantity,
      issued: line.consumed,
      remaining: line.outstanding,
      unitCode: line.unitCode,
    }))
  );

// ─── The screen's own grouping: injector → sole colour → article card ───────

/** One upper line on an article card. */
export interface ProgramCardLine {
  key: string;
  upperColour: string;
  planned: number;
  issued: number;
  remaining: number;
  unitCode: string | null;
  /** Cartons owed back for what was issued of this upper (3 DOZEN = 6), or null when not in whole cartons. */
  cartonsDue: number | null;
  /** Of those, how many are back in the store. */
  cartonsBack: number;
}

/** One article + size being made in a sole colour, and how far through it the store is. */
export interface ProgramCard {
  key: string;
  article: string;
  size: string;
  planned: number;
  issued: number;
  unitCode: string | null;
  /** 0–1, for the bar. Always derived from the two figures beside it, never stored. */
  progress: number;
  /** PENDING before anything is taken, DONE once nothing is outstanding. */
  state: "PENDING" | "IN_PROGRESS" | "DONE";
  /** Store In's figures for the card: cartons due back and cartons back, summed over its lines. */
  cartonsDue: number;
  cartonsBack: number;
  /** PENDING until a carton is back, DONE once every carton due is back. */
  cartonState: "PENDING" | "IN_PROGRESS" | "DONE";
  lines: ProgramCardLine[];
}

/** One band: an injector running one sole colour, and the articles under it. */
export interface ProgramBand {
  key: string;
  injectorNo: number;
  soleColour: string;
  cards: ProgramCard[];
}

/** Store In's word for a card: nothing back yet, some back, or every carton due is back. */
const cartonStateOf = (due: number, back: number): ProgramCard["cartonState"] => {
  if (due > 0 && back >= due) return "DONE";
  return back > 0 ? "IN_PROGRESS" : "PENDING";
};

const sum = (values: number[]): number => roundQuantity(values.reduce((total, value) => total + value, 0));

/**
 * The program as the Machine Program Issue screen reads it: a band per injector + SOLE COLOUR,
 * then a card per article and size, then a line per upper colour.
 *
 * An injector can be given more than one sole colour, so it gets a band per colour rather than
 * one band naming a colour it cannot honestly claim — the same grouping the printed sheet uses,
 * so the paper on the machine and this screen can never be read differently.
 *
 * `cartons` is Store In's per-line carton figures from the data layer; a line it does not name has
 * nothing due and nothing back.
 */
export const programBands = (program: MachineProgramRecord, cartons: readonly MachineProgramLineCartons[] = []): ProgramBand[] => {
  const bands = new Map<string, ProgramBand>();
  const cartonsOf = new Map(cartons.map((row) => [row.lineId, row]));
  for (const run of program.runs) {
    // Only runs with uppers are issued here. A FIX run has neither uppers nor an injector.
    if (run.injectorNo === null || run.lines.length === 0) continue;
    const bandKey = `${run.injectorNo}|${run.soleColour}`;
    let band = bands.get(bandKey);
    if (!band) {
      band = { key: bandKey, injectorNo: run.injectorNo, soleColour: run.soleColour, cards: [] };
      bands.set(bandKey, band);
    }
    const cardKey = `${bandKey}|${run.article}|${run.size}`;
    let card = band.cards.find((candidate) => candidate.key === cardKey);
    if (!card) {
      card = { key: cardKey, article: run.article, size: run.size, planned: 0, issued: 0, unitCode: null, progress: 0, state: "PENDING", cartonsDue: 0, cartonsBack: 0, cartonState: "PENDING", lines: [] };
      band.cards.push(card);
    }
    for (const line of run.lines) {
      card.lines.push({
        key: line.id,
        upperColour: line.upperColour,
        planned: line.quantity,
        issued: line.consumed,
        remaining: line.outstanding,
        unitCode: line.unitCode,
        cartonsDue: cartonsOf.get(line.id)?.cartonsDue ?? 0,
        cartonsBack: cartonsOf.get(line.id)?.cartonsBack ?? 0,
      });
    }
  }

  for (const band of bands.values()) {
    for (const card of band.cards) {
      card.planned = sum(card.lines.map((line) => line.planned));
      card.issued = sum(card.lines.map((line) => line.issued));
      card.unitCode = card.lines[0]?.unitCode ?? null;
      card.progress = card.planned > 0 ? Math.min(1, card.issued / card.planned) : 0;
      // Judged on what is still OUTSTANDING, not on issued >= planned: a packet is indivisible,
      // so the last one can overshoot, and an overshot card is finished, not 120% done.
      const outstanding = sum(card.lines.map((line) => line.remaining));
      card.state = outstanding <= 0 ? "DONE" : card.issued > 0 ? "IN_PROGRESS" : "PENDING";
      card.cartonsDue = card.lines.reduce((total, line) => total + (line.cartonsDue ?? 0), 0);
      card.cartonsBack = card.lines.reduce((total, line) => total + line.cartonsBack, 0);
      card.cartonState = cartonStateOf(card.cartonsDue, card.cartonsBack);
    }
  }
  return [...bands.values()];
};

/** `30 DOZEN`, or just `30` where the upper is counted in no named unit. */
export const formatQuantity = (value: number, unitCode: string | null | undefined): string =>
  `${roundQuantity(value)}${unitCode ? ` ${unitCode}` : ""}`;

/**
 * How many cartons a quantity of uppers will come back as, for rows that carry no carton plan —
 * the saved history, which is read back from the event log. The rule itself is the domain's.
 */
export const cartonsFor = (quantity: number, unitCode: string | null): number | null =>
  cartonsExpectedFromUppers(quantity, unitCode);

/** The program's status in words, never by colour alone (R18). */
export const programStatusLabel = (displayStatus: string): string =>
  copy.machineProgram.statusLabels[displayStatus] ?? displayStatus;

/** "06:00 AM – 06:00 PM" for a program's own shift. */
export const programShift = (program: MachineProgramRecord): string =>
  formatShiftRange({ startMinute: program.shiftStartMinute, endMinute: program.shiftEndMinute });

/** The tone a status is drawn in. Always paired with the status WORD, never used alone (R18). */
export const programStatusTone = (displayStatus: string): "ok" | "warn" | "muted" => {
  if (displayStatus === MACHINE_PROGRAM_DISPLAY_STATUS.CANCELLED) return "muted";
  if (displayStatus === MACHINE_PROGRAM_DISPLAY_STATUS.PARTIALLY_USED) return "warn";
  return "ok";
};

/**
 * An EVR FIX program: every article on it is a FIX article — two soles, no upper — so it has no
 * upper to issue, count or wait for. Only such a program drops the upper sections (Upper Out, the
 * upper cards and their "no uppers yet" notice, "(Upper)" on the total). A program that mixes
 * fix and upper articles keeps every one of them, because its uppers still go out.
 */
export const isFixOnlyProgram = (program: MachineProgramRecord): boolean =>
  program.runs.length > 0 && program.runs.every(isFixRun);

/** How many injectors this program actually puts work on. */
export const injectorsOnProgram = (program: MachineProgramRecord): number =>
  new Set(program.runs.filter((run) => run.lines.length > 0).map((run) => run.injectorNo)).size;

/** Whether more may still be issued against the program as it stands right now. */
export const canIssueMore = (program: MachineProgramRecord): boolean =>
  program.displayStatus !== MACHINE_PROGRAM_DISPLAY_STATUS.CANCELLED &&
  program.displayStatus !== MACHINE_PROGRAM_DISPLAY_STATUS.COMPLETED &&
  program.outstandingQuantity > 0;

// ─── Cartons waiting to be labelled ──────────────────────────────────────────

/**
 * The cartons one product's worth of issued uppers needs labelled.
 *
 * Grouped by product and colour because that is what one carton QR run is: one article/size and
 * one colour, that many identities. Two packets of the same upper are therefore one run of eight,
 * not two of four.
 */
export interface CartonRun {
  key: string;
  articleSizeId: string;
  article: string;
  size: string;
  soleColour: string;
  colour: string;
  cartons: number;
  /**
   * What the cartons are owed to, which is also what the print is recorded against.
   *
   * An ordinary article's are owed to the upper LINE and come from its plan (migration 076); a
   * FIX article's to the RUN itself, which has no upper at all. The plan is the authority either
   * way — the packets the store issued no longer decide the count.
   */
  source: { kind: "UPPER_LINE"; lineId: string } | { kind: "FIX_RUN"; runId: string };
}

/** `SK12 / 7/10 / BLACK RED` — one carton run in the words the labels will carry. */
export const cartonRunLabel = (run: Pick<CartonRun, "article" | "size" | "colour">): string =>
  `${run.article} / ${run.size} / ${run.colour}`;

/**
 * The carton runs still waiting to be labelled: one per upper LINE, from what it PLANS.
 *
 * A line of 4.5 DOZEN is 9 cartons, offered from the moment the line is on the program and
 * whether the store has issued one packet, two or none — uppers leave in whole packets, so what
 * was issued could never add up to the plan (owner, 2026-10-14). The figures come from the main
 * process, so the list is the same whoever opens the program and whenever. A line whose cartons
 * cannot be worked out is left out here and reported by blockedCartonLines instead.
 */
export const pendingCartonRuns = (lines: readonly MachineProgramLineCartonRun[]): CartonRun[] =>
  lines
    .filter((line) => line.cartonNote == null && line.cartonsToPrint > 0)
    .map((line) => ({
      key: `line:${line.lineId}`,
      articleSizeId: line.articleSizeId,
      article: line.article,
      size: line.size,
      soleColour: line.soleColour,
      colour: line.upperColour,
      cartons: line.cartonsToPrint,
      source: { kind: "UPPER_LINE", lineId: line.lineId },
    }));

/**
 * The carton runs a program's FIX articles still owe — one per run, from its plan.
 *
 * Nothing is issued for a fix article, so these are ready from the moment the run is saved and
 * do not wait on a scan. A run whose cartons cannot be worked out is left out and reported by
 * blockedFixCartonRuns, exactly as a packet's are.
 */
export const fixCartonRuns = (runs: readonly MachineProgramFixCartonRun[]): CartonRun[] =>
  runs
    .filter((run) => run.cartonNote == null && run.cartonsToPrint > 0)
    .map((run) => ({
      key: `fix:${run.runId}`,
      articleSizeId: run.articleSizeId,
      article: run.article,
      size: run.size,
      soleColour: run.outerSoleColour,
      colour: run.outerSoleColour,
      cartons: run.cartonsToPrint,
      source: { kind: "FIX_RUN", runId: run.runId },
    }));

/** The fix runs whose cartons cannot be labelled here, with the reason to show. */
export const blockedFixCartonRuns = (runs: readonly MachineProgramFixCartonRun[]): MachineProgramFixCartonRun[] =>
  runs.filter((run) => run.cartonNote != null);

/** Every carton run already printed for a program's FIX articles, for the record on screen. */
export const printedFixCartonRuns = (runs: readonly MachineProgramFixCartonRun[]): PrintedCartonRun[] =>
  runs.flatMap((run) =>
    run.labels.map((label) => ({
      key: label.qrBatchId,
      qrBatchId: label.qrBatchId,
      // A B run carries MIX, not the outer sole: its cartons came back in mixed colours.
      label: cartonRunLabel({ article: run.article, size: run.size, colour: label.grade === "B" ? label.colour : run.outerSoleColour }),
      cartons: label.cartonCount,
      range: label.firstQrId === label.lastQrId ? label.firstQrId : `${label.firstQrId} → ${label.lastQrId}`,
      received: label.receivedInRun,
      at: label.printedAt,
      grade: label.grade,
      voided: label.voidedInRun,
    }))
  );

/**
 * What the Cartons to label banner says in one line: how many labels are still owed, how many are
 * printed, and how many of those cartons are back. Counts of labels on screen, never stock.
 */
export const cartonLabelTotals = (
  runs: readonly CartonRun[],
  printed: ReadonlyArray<{ cartons: number; received: number }>
): { owed: number; printed: number; back: number } => ({
  owed: runs.reduce((sum, run) => sum + run.cartons, 0),
  printed: printed.reduce((sum, run) => sum + run.cartons, 0),
  back: printed.reduce((sum, run) => sum + run.received, 0),
});

/** A carton run that has been generated, for the record on screen. */
export interface PrintedCartonRun {
  key: string;
  /** The carton QR run the labels were generated in — what a reprint reads the codes back from. */
  qrBatchId: string;
  label: string;
  cartons: number;
  /** The identity range the run holds, e.g. `SK12_BLACKRED_7/10_000001 → …_000004`. */
  range: string;
  /** How many of the run's cartons have come back and been stored in. */
  received: number;
  at: string;
  /** "B" for a run of B carton labels (EVR FIX, MIX). Absent on an ordinary run. */
  grade?: "B" | null;
  /** Labels of the run voided since — on a FIX run, the ones turned into B cartons. */
  voided?: number;
}

/**
 * Every carton run already printed for the program's uppers, newest first — one row per QR run.
 *
 * A run printed before migration 076 was recorded against a packet rather than the line; the
 * main process resolves those to their line, so the history reads as one list either way.
 */
export const printedCartonRuns = (lines: readonly MachineProgramLineCartonRun[]): PrintedCartonRun[] => {
  const runs = new Map<string, PrintedCartonRun>();
  for (const line of lines) {
    for (const label of line.labels) {
      const existing = runs.get(label.qrBatchId);
      if (existing) {
        existing.cartons += label.cartonCount;
        continue;
      }
      runs.set(label.qrBatchId, {
        key: label.qrBatchId,
        qrBatchId: label.qrBatchId,
        label: cartonRunLabel({ article: line.article, size: line.size, colour: label.colour || line.upperColour }),
        cartons: label.cartonCount,
        range: label.firstQrId === label.lastQrId ? label.firstQrId : `${label.firstQrId} → ${label.lastQrId}`,
        received: label.receivedInRun,
        at: label.printedAt,
        grade: label.grade,
        voided: label.voidedInRun,
      });
    }
  }
  return [...runs.values()].sort((a, b) => b.at.localeCompare(a.at));
};

/**
 * Lines whose cartons cannot be worked out, one per upper: the same colourless upper on three
 * runs is one thing to fix, not three warnings to read.
 */
export const blockedCartonLines = (lines: readonly MachineProgramLineCartonRun[]): MachineProgramLineCartonRun[] => {
  const byItem = new Map<string, MachineProgramLineCartonRun>();
  for (const line of lines) {
    if (line.cartonNote != null && !byItem.has(line.itemDisplayName)) byItem.set(line.itemDisplayName, line);
  }
  return [...byItem.values()];
};

// ─── What the operator reads after a scan ────────────────────────────────────

/** A refusal's short heading. The reason the main process gave is always the sentence shown. */
const REFUSAL_TITLES: Record<MachineProgramScanVerdict, string> = {
  ACCEPTED: copy.programOut.scanAcceptedTitle,
  INVALID_FORMAT: "✕ NOT A RAW MATERIAL QR",
  UNKNOWN_QR: "✕ NOT REGISTERED",
  NOT_IN_STORE: "✕ NOT IN STORE",
  NOT_ELIGIBLE: "✕ CANNOT ISSUE",
  NOT_CONFIGURED: "✕ NOT SET UP",
  NOT_ON_PROGRAM: "✕ NOT ON THIS PROGRAM",
  VARIANT_FULFILLED: "✕ ALREADY FULFILLED",
  ALREADY_IN_BATCH: "✕ ALREADY SCANNED",
  PROGRAM_NOT_FOUND: "✕ PROGRAM GONE",
  PROGRAM_CLOSED: "✕ PROGRAM CLOSED",
  NOT_AUTHORIZED: "✕ NOT AUTHORISED",
};

/**
 * Turns the main process's answer to one scan into what the operator reads — text always, never
 * colour alone. A refusal never ends the session: the box stays armed for the next packet.
 */
export const feedbackForIssue = (
  result: SaveMachineProgramBatchResult,
  qrId: string,
  seq: number
): ScanStationFeedback => {
  const packet = result.packets?.[0];
  const quantity = packet ? formatQuantity(packet.quantity, packet.unitCode) : "";
  const pack = packet?.packName ? `1 ${packet.packName}` : "";

  const base = {
    seq,
    result: {
      qrId: packet?.qrId ?? qrId,
      product: packet?.itemDisplayName,
      fromStatus: "In Store",
      toStatus: "Issued",
      currentStatusLabel: result.accepted ? null : (packet?.itemDisplayName ?? null),
      facts: [
        { label: "Raw material", value: packet?.itemDisplayName },
        { label: "Moved out", value: pack ? `${pack} · ${quantity}` : quantity },
        { label: "Supplier", value: packet?.partyName ?? undefined },
        {
          label: "Cartons coming back",
          value: packet?.cartons ? copy.programOut.cartonCount(packet.cartons.count) : undefined,
        },
      ],
      at: result.accepted ? new Date().toISOString() : undefined,
      atLabel: "Issued",
    },
  };

  if (result.accepted) {
    return {
      ...base,
      tone: result.outcome === "ALREADY_SAVED" ? ("warn" as const) : ("success" as const),
      title: result.outcome === "ALREADY_SAVED" ? copy.programOut.alreadySavedTitle : copy.programOut.scanAcceptedTitle,
      message:
        packet?.cartonNote ??
        (packet?.cartons
          ? `${quantity} out — ${copy.programOut.cartonCount(packet.cartons.count)} to label.`
          : copy.programOut.alreadySavedBody),
    };
  }

  const verdict = result.refusedVerdict;
  return {
    ...base,
    tone: "error" as const,
    title: (verdict ? REFUSAL_TITLES[verdict] : undefined) ?? copy.programOut.scanRefusedTitle,
    message: result.reason ?? "This packet was not issued.",
  };
};

/** The panel's resting state between scans. */
export const IDLE_FEEDBACK: ScanStationFeedback = {
  tone: "idle",
  title: copy.programOut.scanIdleTitle,
  message: copy.programOut.scanIdleMessage,
  result: null,
  seq: 0,
};
