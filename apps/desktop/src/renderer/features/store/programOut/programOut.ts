import { MACHINE_PROGRAM_DISPLAY_STATUS, cartonsExpectedFromUppers, formatShiftRange, roundQuantity } from "@erp/domain";
import type {
  MachineProgramCartonPacket,
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
  lines: ProgramCardLine[];
}

/** One band: an injector running one sole colour, and the articles under it. */
export interface ProgramBand {
  key: string;
  injectorNo: number;
  soleColour: string;
  cards: ProgramCard[];
}

const sum = (values: number[]): number => roundQuantity(values.reduce((total, value) => total + value, 0));

/**
 * The program as the Machine Program Issue screen reads it: a band per injector + SOLE COLOUR,
 * then a card per article and size, then a line per upper colour.
 *
 * An injector can be given more than one sole colour, so it gets a band per colour rather than
 * one band naming a colour it cannot honestly claim — the same grouping the printed sheet uses,
 * so the paper on the machine and this screen can never be read differently.
 */
export const programBands = (program: MachineProgramRecord): ProgramBand[] => {
  const bands = new Map<string, ProgramBand>();
  for (const run of program.runs) {
    if (run.lines.length === 0) continue;
    const bandKey = `${run.injectorNo}|${run.soleColour}`;
    let band = bands.get(bandKey);
    if (!band) {
      band = { key: bandKey, injectorNo: run.injectorNo, soleColour: run.soleColour, cards: [] };
      bands.set(bandKey, band);
    }
    const cardKey = `${bandKey}|${run.article}|${run.size}`;
    let card = band.cards.find((candidate) => candidate.key === cardKey);
    if (!card) {
      card = { key: cardKey, article: run.article, size: run.size, planned: 0, issued: 0, unitCode: null, progress: 0, state: "PENDING", lines: [] };
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
  /** The issuances these cartons are owed to — what the print is recorded against. */
  eventIds: string[];
}

/** `SK12 / 7/10 / BLACK RED` — one carton run in the words the labels will carry. */
export const cartonRunLabel = (run: Pick<CartonRun, "article" | "size" | "colour">): string =>
  `${run.article} / ${run.size} / ${run.colour}`;

/**
 * The carton runs still waiting to be labelled, from every packet the program has taken out.
 *
 * The packets and their carton counts come from the main process, read from the events, so this
 * list is the same whoever opens the program and whenever. Packets whose cartons cannot be worked
 * out are left out here and reported by blockedCartonPackets instead.
 */
export const pendingCartonRuns = (packets: readonly MachineProgramCartonPacket[]): CartonRun[] => {
  const runs = new Map<string, CartonRun>();
  for (const packet of packets) {
    if (!packet.cartons || packet.label) continue;
    const { articleSizeId, article, size, soleColour, colour, count } = packet.cartons;
    const key = `${articleSizeId}:${colour}`;
    const existing = runs.get(key);
    if (existing) {
      existing.cartons += count;
      existing.eventIds.push(packet.eventId);
    } else {
      runs.set(key, { key, articleSizeId, article, size, soleColour, colour, cartons: count, eventIds: [packet.eventId] });
    }
  }
  return [...runs.values()];
};

/** A carton run that has been generated, for the record on screen. */
export interface PrintedCartonRun {
  key: string;
  label: string;
  cartons: number;
  /** The identity range the run holds, e.g. `SK12_BLACKRED_7/10_000001 → …_000004`. */
  range: string;
  /** How many of the run's cartons have come back and been stored in. */
  received: number;
  at: string;
}

/** Every carton run already printed for the program, newest first — one row per QR run. */
export const printedCartonRuns = (packets: readonly MachineProgramCartonPacket[]): PrintedCartonRun[] => {
  const runs = new Map<string, PrintedCartonRun>();
  for (const packet of packets) {
    const label = packet.label;
    if (!label) continue;
    const existing = runs.get(label.qrBatchId);
    if (existing) {
      existing.cartons += label.cartonCount;
      continue;
    }
    runs.set(label.qrBatchId, {
      key: label.qrBatchId,
      label: packet.cartons ? cartonRunLabel(packet.cartons) : packet.itemDisplayName,
      cartons: label.cartonCount,
      range: label.firstQrId === label.lastQrId ? label.firstQrId : `${label.firstQrId} → ${label.lastQrId}`,
      received: label.receivedInRun,
      at: label.printedAt,
    });
  }
  return [...runs.values()].sort((a, b) => b.at.localeCompare(a.at));
};

/**
 * Unlabelled packets whose cartons cannot be worked out, one per upper: twenty packets of the
 * same colourless upper are one thing to fix, not twenty warnings to read.
 */
export const blockedCartonPackets = (packets: readonly MachineProgramCartonPacket[]): MachineProgramCartonPacket[] => {
  const byItem = new Map<string, MachineProgramCartonPacket>();
  for (const packet of packets) {
    if (!packet.cartons && !packet.label && !byItem.has(packet.itemDisplayName)) byItem.set(packet.itemDisplayName, packet);
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
