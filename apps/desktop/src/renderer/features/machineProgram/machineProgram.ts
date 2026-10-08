import {
  MACHINE_PROGRAM_DISPLAY_STATUS,
  MACHINE_SHIFTS,
  checkMachineShift,
  roundQuantity,
  sameMachineShift,
  type MachineShift,
} from "@erp/domain";
import type { MachineProgramMaterial, MachineProgramRecord, MachineProgramRunRecord } from "../../types/desktopApi";
import { copy } from "../../config/copy";
import { shiftIsoDate } from "../../utils/dates";

// Shared vocabulary for the Machine Program screens: the shapes the steps pass around, and the
// handful of derivations that must read the same on every one of them.
//
// Nothing here calculates a stock figure or decides what may be reserved. Physical, reserved and
// available all arrive already computed from the data layer (database/machineProgramStock.ts and
// @erp/domain machineProgram.ts). These functions only format and group.

/** The answers a new sole run is built from, before its first upper saves it. */
export interface RunDraft {
  soleColour: string | null;
  article: string | null;
  articleSizeId: string | null;
  size: string | null;
}

export const EMPTY_DRAFT: RunDraft = {
  soleColour: null,
  article: null,
  articleSizeId: null,
  size: null,
};

/** The questions of a sole run, in the order they are asked. */
export const RUN_STEPS = ["colour", "article", "size"] as const;
export type RunStep = (typeof RUN_STEPS)[number];

/** The first question the draft has not answered yet, or null when the run is fully described. */
export const firstOpenStep = (draft: RunDraft): RunStep | null => {
  if (!draft.soleColour) return "colour";
  if (!draft.articleSizeId && !draft.article) return "article";
  if (!draft.articleSizeId) return "size";
  return null;
};

/** The draft a saved run starts from when the operator changes it. */
export const draftFromRun = (run: MachineProgramRunRecord): RunDraft => ({
  soleColour: run.soleColour,
  article: run.article,
  articleSizeId: run.articleSizeId,
  size: run.size,
});

/** `30`, `12.5` — a quantity without floating-point dust. */
export const formatNumber = (value: number): string => String(roundQuantity(value));

/** `30 DOZEN` — a quantity with the unit it is counted in. */
export const formatAmount = (value: number, unitCode: string | null | undefined): string =>
  `${formatNumber(value)}${unitCode ? ` ${unitCode}` : ""}`;

/**
 * "ABC UPPER", or the plain words for stock that carries no supplier.
 *
 * Only the Dana panel names a supplier now: it is showing what is physically on the shelf. A
 * program itself no longer names one — an upper line is against the upper, not against a pile.
 */
export const supplierLabel = (supplierName: string | null | undefined): string => supplierName || copy.machineProgram.supplierUnknown;

/**
 * The short tag on a machine's badge: the trailing number of "MACHINE 12", or the first two
 * letters of a machine the floor named something else. The card prints the full name beside it.
 */
export const machineTag = (name: string): string => {
  const trimmed = String(name ?? "").trim();
  const trailingNumber = /(\d+)\s*$/.exec(trimmed);
  if (trailingNumber) return trailingNumber[1].replace(/^0+(?=\d)/, "");
  return (trimmed.replace(/[^A-Za-z0-9]/g, "").slice(0, 2) || "?").toUpperCase();
};

/** "Today" / "Tomorrow" / "Yesterday" for those three days, otherwise null. */
export const relativeDayLabel = (ymd: string, today: string): string | null => {
  if (ymd === today) return copy.machineProgram.today;
  if (ymd === shiftIsoDate(today, 1)) return copy.machineProgram.tomorrow;
  if (ymd === shiftIsoDate(today, -1)) return copy.machineProgram.yesterday;
  return null;
};

/** What a program's status is called, in words — never signalled by colour alone (R18). */
export const statusLabel = (displayStatus: string): string => copy.machineProgram.statusLabels[displayStatus] ?? displayStatus;

/** The tone a status is drawn in. Always paired with `statusLabel`, never used on its own. */
export const statusTone = (displayStatus: string): "ok" | "warn" | "muted" => {
  if (displayStatus === MACHINE_PROGRAM_DISPLAY_STATUS.CANCELLED) return "muted";
  if (displayStatus === MACHINE_PROGRAM_DISPLAY_STATUS.PARTIALLY_USED) return "warn";
  return "ok";
};

/** The mark beside a status word. */
export const statusMark = (displayStatus: string): string =>
  displayStatus === MACHINE_PROGRAM_DISPLAY_STATUS.PARTIALLY_USED ? "◐" : "✓";

/** A program with nothing on it is, to the operator, no program at all. */
export const hasContent = (program: MachineProgramRecord | null | undefined): program is MachineProgramRecord =>
  program != null && program.runs.some((run) => run.lines.length > 0);

/** The sole runs on one injector, in order. */
export const injectorRuns = (program: MachineProgramRecord | null | undefined, injectorNo: number): MachineProgramRunRecord[] =>
  (program?.runs ?? []).filter((run) => run.injectorNo === injectorNo);

/** The sole colours on a set of runs, in the order they were first programmed. */
export const runColours = (runs: readonly MachineProgramRunRecord[]): string[] => [...new Set(runs.map((run) => run.soleColour))];

/** The runs of one sole colour, in order. */
export const colourRuns = (runs: readonly MachineProgramRunRecord[], colour: string): MachineProgramRunRecord[] =>
  runs.filter((run) => run.soleColour === colour);

/**
 * The run a new article + size belongs on: the one already programmed for it in this colour, or
 * null for a new one. A sole run IS the colour, the article and the size, so a second article of
 * the same description must change that run rather than stand beside it as a rival.
 */
export const runForArticleSize = (
  runs: readonly MachineProgramRunRecord[],
  colour: string,
  articleSizeId: string
): MachineProgramRunRecord | null =>
  runs.find((run) => run.soleColour === colour && run.articleSizeId === articleSizeId) ?? null;

/** What one injector adds up to, and in which unit (null when its runs are in different ones). */
export const injectorTotal = (runs: readonly MachineProgramRunRecord[]): { quantity: number; unitCode: string | null } => {
  const units = new Set(runs.map((run) => run.unitCode ?? ""));
  return {
    quantity: roundQuantity(runs.reduce((sum, run) => sum + run.totalQuantity, 0)),
    unitCode: units.size === 1 ? [...units][0] || null : null,
  };
};

/** How many injectors have anything on them — "2 injectors" on the machine card. */
export const injectorsInUse = (program: MachineProgramRecord | null | undefined): number =>
  new Set((program?.runs ?? []).filter((run) => run.lines.length > 0).map((run) => run.injectorNo)).size;

/** What kind of upper a card is, under its colour: "RAGZINE UPPER · SILAI". */
export const upperKind = (material: MachineProgramMaterial): string =>
  material.type ? `${material.subCategoryName} · ${material.type}` : material.subCategoryName;

/** `4 BAGS`, `1 BAG`, `3 BOXES` — a count of packs, pluralised the way the Stock tab does it. */
export const packCount = (count: number, packName: string): string => {
  const name = (packName || "PACK").toUpperCase();
  if (count === 1) return `1 ${name}`;
  return `${count} ${/(S|X|Z|CH|SH)$/.test(name) ? `${name}ES` : `${name}S`}`;
};

// ─── The shift a program runs ────────────────────────────────────────────────
//
// The shift is minutes from midnight of the program's own date (@erp/domain machineProgram.ts).
// These turn it into something a dropdown can carry and a person can read; the minutes
// themselves, and the rule for what is a valid shift, stay in the domain.

/** A shift as one string, so a <select> can carry it: "360-1080". */
export const shiftId = (shift: MachineShift): string => `${shift.startMinute}-${shift.endMinute}`;

/** The shift behind a dropdown's value, or null when the text is not one. */
export const shiftFromId = (id: string): MachineShift | null => {
  const [start, end] = String(id ?? "").split("-");
  const shift = { startMinute: Number(start), endMinute: Number(end) };
  return checkMachineShift(shift) ? shift : null;
};

/** The shift a saved program runs, or the one the header is offering for a program not yet made. */
export const shiftOf = (program: MachineProgramRecord | null | undefined, chosen: MachineShift): MachineShift =>
  program ? { startMinute: program.shiftStartMinute, endMinute: program.shiftEndMinute } : chosen;

/**
 * The shifts the header offers: the two the floor works, plus the saved program's own when it
 * runs something else — a program made before the shift was a choice, or by another terminal,
 * must still be able to say what it runs.
 */
export const shiftChoices = (current: MachineShift): MachineShift[] =>
  MACHINE_SHIFTS.some((shift) => sameMachineShift(shift, current)) ? [...MACHINE_SHIFTS] : [...MACHINE_SHIFTS, current];
