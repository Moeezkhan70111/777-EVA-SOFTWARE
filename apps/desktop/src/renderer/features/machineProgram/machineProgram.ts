import {
  MACHINE_PROGRAM_DISPLAY_STATUS,
  checkFixQuantity,
  isFixRun,
  MACHINE_SHIFTS,
  checkMachineShift,
  checkProgramQuantity,
  roundQuantity,
  sameMachineShift,
  type ContractorRates,
  type MachineShift,
} from "@erp/domain";
import type {
  MachineProgramArticle,
  MachineProgramMaterial,
  MachineProgramRecord,
  MachineProgramRunRecord,
  MachineRecord,
  SoleColourOption,
} from "../../types/desktopApi";
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

/**
 * Why a FIX run's quantity cannot be saved, or null.
 *
 * The same shape rule a line quantity follows, minus the stock ceiling: a fix run reserves
 * nothing, so there is nothing it could ask for more of than the store holds.
 */
export const fixQuantityProblem = (text: string): string | null => {
  if (text.trim() === "") return null;
  const quantity = Number(text);
  return checkFixQuantity(quantity) ? null : copy.machineProgram.quantityInvalid;
};

/** `30`, `12.5` — a quantity without floating-point dust. */
export const formatNumber = (value: number): string => String(roundQuantity(value));

/** `30 DOZEN` — a quantity with the unit it is counted in. */
export const formatAmount = (value: number, unitCode: string | null | undefined): string =>
  `${formatNumber(value)}${unitCode ? ` ${unitCode}` : ""}`;

/**
 * What the store holds to mould a sole in one colour, said beside the colour itself: `DANA 120
 * BAGS`, or `No DANA` for a colour it has none of.
 *
 * Information only — a program reserves uppers, never Dana. Null where the colour's Dana is
 * counted in more than one unit and the data layer could not total it, which is the one case
 * where there is no honest single figure to print.
 */
export const danaLabel = (option: SoleColourOption): string | undefined => {
  if (!option.hasDana) return copy.machineProgram.danaNoneShort;
  if (option.danaQuantity == null) return undefined;
  return copy.machineProgram.danaOf(formatAmount(option.danaQuantity, option.danaUnitCode));
};

/**
 * Why a typed quantity cannot be saved, in the operator's words — or null when it can.
 *
 * The rule itself is the backend's (@erp/domain checkProgramQuantity); this only says it out
 * loud, in one wording, wherever a quantity is typed: the big box in a dialog, the box in a
 * saved row, the box in the selection being added. It is a courtesy — every save is checked
 * again inside the write lock.
 *
 * `limit` is the whole ceiling the line may hold, `consumed` what has already been scanned out
 * of it and can never be given back.
 */
export const quantityProblem = (quantity: number, limit: number, consumed: number, unitCode: string | null): string | null => {
  const problem = checkProgramQuantity(quantity, { available: limit - consumed, consumed });
  if (problem === "INVALID_QUANTITY") return copy.machineProgram.quantityInvalid;
  if (problem === "BELOW_CONSUMED") return copy.machineProgram.quantityBelowTaken(formatAmount(consumed, unitCode));
  if (problem === "NOT_ENOUGH_STOCK") return copy.machineProgram.quantityTooMany(formatAmount(limit, unitCode));
  return null;
};

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

/**
 * Whether a machine still needs somebody assigned before it can be programmed.
 *
 * A machine is worked by TWO contractors — the one who runs it and the one who packs what it
 * makes — and the backend refuses to create a program without both, so the screens ask for both
 * rather than letting the operator walk into that refusal.
 */
export const needsContractors = (machine: MachineRecord): boolean =>
  !machine.contractorPartyId || !machine.packingContractorPartyId;

/**
 * Whether a run is actually making something.
 *
 * A normal run is its upper lines, and a run with none of them left is a shell the backend is
 * about to remove. A FIX run has no lines and never will — the article has no upper — so the run
 * itself is the work. Anything counting what a program holds has to ask this, or a day of fix
 * articles reads as an empty program.
 */
export const runHasWork = (run: MachineProgramRunRecord): boolean => run.lines.length > 0 || isFixRun(run);

/** A program with nothing on it is, to the operator, no program at all. */
export const hasContent = (program: MachineProgramRecord | null | undefined): program is MachineProgramRecord =>
  program != null && program.runs.some(runHasWork);

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

/**
 * What a set of runs adds up to, and in which unit (null when they are counted in different ones).
 *
 * Everything the machine is to MAKE, which is the question a total on screen is answering: the
 * uppers promised on normal runs plus what the FIX runs plan. A fix run keeps its figure on the
 * run itself, because it has no upper line to put it on, so a total that only added up lines
 * read 0 against a sole that is making hundreds.
 *
 * It is deliberately not the same figure as the program's `totalQuantity`, which is what is
 * RESERVED and therefore counts uppers only (see mapProgram in the data layer).
 */
export const injectorTotal = (runs: readonly MachineProgramRunRecord[]): { quantity: number; unitCode: string | null } => {
  const units = new Set(runs.map((run) => run.unitCode ?? ""));
  return {
    quantity: roundQuantity(runs.reduce((sum, run) => sum + run.totalQuantity + run.fixQuantity, 0)),
    unitCode: units.size === 1 ? [...units][0] || null : null,
  };
};

/** How many injectors have anything on them — "2 injectors" on the machine card. Fix runs have none. */
export const injectorsInUse = (program: MachineProgramRecord | null | undefined): number =>
  new Set((program?.runs ?? []).filter((run) => run.injectorNo !== null && runHasWork(run)).map((run) => run.injectorNo)).size;

/**
 * The program's FIX runs, in order. EVR FIX is not moulded on the injectors, so these belong to
 * the program itself and have no injector (migration 073).
 */
export const programFixRuns = (program: MachineProgramRecord | null | undefined): MachineProgramRunRecord[] =>
  (program?.runs ?? []).filter((run) => run.injectorNo === null);

/**
 * The injector of a run that carries uppers. Only a FIX run has none, and a fix run never has an
 * upper line — so this is never NaN in practice, and if it were the backend would refuse it.
 */
export const upperRunInjector = (run: MachineProgramRunRecord): number => run.injectorNo ?? Number.NaN;

/** Which articles a picker offers: FIX ones (no upper, no injector) or those made with uppers. */
export type ArticleKind = "FIX" | "UPPER";

/** The sizes of one kind. With no kind, every size. */
export const sizesOfKind = <T extends { hasNoUpper: boolean }>(sizes: readonly T[], kind?: ArticleKind): T[] =>
  // Boolean(): a size read without the flag is one made with uppers, never a fix article.
  kind ? sizes.filter((size) => Boolean(size.hasNoUpper) === (kind === "FIX")) : [...sizes];

/** The articles with at least one size of that kind. With no kind, every article. */
export const articlesOfKind = <T extends { sizes: ReadonlyArray<{ hasNoUpper: boolean }> }>(articles: readonly T[], kind?: ArticleKind): T[] =>
  kind ? articles.filter((article) => sizesOfKind(article.sizes, kind).length > 0) : [...articles];

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

/**
 * The STANDARD contractor rates of an article, from the Product Master.
 *
 * This is what the pricing boxes open on for an article the program has not priced yet — the
 * same relationship a sale voucher line has with a product's selling price: the master holds the
 * standard, the document records what was actually agreed.
 *
 * Null when the product has no rates at all, so an unpriced product can never arrive at a
 * program looking like free work. A product with some rates set and others not is answered with
 * zeros for the missing ones, because the operator is about to see and confirm all three.
 */
export const articleDefaultRates = (
  articles: readonly MachineProgramArticle[],
  articleSizeId: string | null | undefined
): ContractorRates | null => {
  if (!articleSizeId) return null;
  const size = articles.flatMap((entry) => entry.sizes).find((entry) => entry.articleSizeId === articleSizeId);
  if (!size) return null;
  const anySet = size.machineRatePaisa != null || size.packingRatePaisa != null || size.printingRatePaisa != null;
  return anySet
    ? {
        machineRatePaisa: size.machineRatePaisa ?? 0,
        packingRatePaisa: size.packingRatePaisa ?? 0,
        printingRatePaisa: size.printingRatePaisa ?? 0,
      }
    : null;
};
