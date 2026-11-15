import { STORE_DIRECTION, convertOnLadder, handQuantityProblem, handVoucherNeedsNote, type StoreDirection, type UnitLadderStep } from "@erp/domain";
import { copy } from "../../../config/copy";
import type { RawMaterialHandMoveOptions, HandVoucher, HandVoucherBodyInput } from "../../../types/desktopApi";

// THE VOUCHER BEING WRITTEN: party, lines, note, as the form holds them. Pure.
//
// The screen shows each line's figure in the stock unit and its problem before Save; the data layer checks every
// line again and refuses the whole voucher on any one, so nothing here is the rule — it only saves a round trip.

export interface DraftLine {
  /** React's key for the row; never sent. */
  key: string;
  itemId: string;
  quantity: string;
  unitCode: string;
}

export interface VoucherDraft {
  partyId: string;
  note: string;
  lines: DraftLine[];
}

let nextKey = 0;
const newKey = (): string => {
  nextKey += 1;
  return `line-${nextKey}`;
};

export const blankLine = (): DraftLine => ({ key: newKey(), itemId: "", quantity: "", unitCode: "" });

export const emptyDraft = (): VoucherDraft => ({ partyId: "", note: "", lines: [blankLine()] });

/** A stored voucher as a draft to edit. */
export const draftOf = (voucher: HandVoucher): VoucherDraft => ({
  partyId: voucher.partyId,
  note: voucher.note ?? "",
  lines: [
    ...voucher.lines.map((line) => ({ key: newKey(), itemId: line.itemId, quantity: String(line.typedQuantity), unitCode: line.typedUnitCode })),
    blankLine(),
  ],
});

/** A line with nothing chosen and nothing typed: left out of the voucher. */
export const isBlankLine = (line: DraftLine): boolean => line.itemId === "" && line.quantity.trim() === "";

/** The unit a line starts on: the one the balance is kept in, so what is read and typed mean the same. */
export const startingUnit = (options: RawMaterialHandMoveOptions): string => {
  const stock = options.stockUnitCode ?? "";
  return options.units.includes(stock) ? stock : (options.units[0] ?? "");
};

/** What a line's typed figure comes to in the unit the balance is kept in, or null when it cannot be said yet. */
export const inStockUnit = (options: RawMaterialHandMoveOptions | undefined, line: DraftLine): number | null => {
  if (!options || !line.unitCode || handQuantityProblem(line.quantity) !== null || line.quantity.trim() === "") return null;
  const typed = Number(line.quantity);
  const stockUnit = options.stockUnitCode ?? "";
  if (line.unitCode === stockUnit) return typed;
  const steps: UnitLadderStep[] = options.steps.map((step) => ({ fromUnit: step.fromUnit, toUnit: step.toUnit, factor: step.factor }));
  return convertOnLadder(steps, typed, line.unitCode, stockUnit);
};

/**
 * What a line is checked against: the voucher's direction, and — while a Move Out voucher is edited — what it
 * already took out of each material, which the data layer puts back before it checks the new lines.
 */
export interface LineContext {
  direction: StoreDirection;
  /** Item id → quantity (stock unit) this voucher already took out. Empty for a new voucher or a Move In one. */
  heldBack: ReadonlyMap<string, number>;
}

/** What the store can give for a line moving out: what is in it, plus what this voucher already took. */
export const availableFor = (options: RawMaterialHandMoveOptions, context: LineContext): number =>
  Number((options.quantityOnHand + (context.heldBack.get(options.itemId) ?? 0)).toFixed(3));

/** A voucher's lines as what it took out of each material, for editing a Move Out voucher. */
export const heldBackOf = (voucher: HandVoucher): Map<string, number> =>
  new Map(voucher.direction === STORE_DIRECTION.OUT ? voucher.lines.map((line) => [line.itemId, line.quantity]) : []);

/** Why one line cannot be saved yet, or null. A blank line is never a problem. */
export const lineProblem = (line: DraftLine, options: RawMaterialHandMoveOptions | undefined, duplicate: boolean, context: LineContext): string | null => {
  if (isBlankLine(line)) return null;
  if (duplicate) return copy.handVoucher.duplicateLine;
  if (options?.blockedReason) return options.blockedReason;
  const typed = handQuantityProblem(line.quantity, context.direction);
  if (typed) return typed;
  if (!line.itemId || line.quantity.trim() === "" || !options) return null;
  const moving = inStockUnit(options, line);
  if (moving == null) return copy.moveOut.cannotConvert;
  const available = availableFor(options, context);
  if (context.direction === STORE_DIRECTION.OUT && Number(moving.toFixed(3)) > available) {
    return copy.moveOut.notEnough(String(available), options.stockUnitCode ?? "", String(Number(moving.toFixed(3))));
  }
  return null;
};

/** Item ids that appear on more than one line. */
export const duplicateItems = (lines: readonly DraftLine[]): Set<string> => {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const line of lines) {
    if (!line.itemId) continue;
    if (seen.has(line.itemId)) twice.add(line.itemId);
    seen.add(line.itemId);
  }
  return twice;
};

/** A party, the note a Move Out voucher needs, every non-blank line complete and sound, and at least one. */
export const draftReady = (draft: VoucherDraft, optionsFor: (itemId: string) => RawMaterialHandMoveOptions | undefined, context: LineContext): boolean => {
  const filled = draft.lines.filter((line) => !isBlankLine(line));
  if (!draft.partyId || filled.length === 0) return false;
  if (handVoucherNeedsNote(context.direction) && draft.note.trim() === "") return false;
  const twice = duplicateItems(filled);
  return filled.every((line) => {
    const options = optionsFor(line.itemId);
    return line.itemId !== "" && line.quantity.trim() !== "" && lineProblem(line, options, twice.has(line.itemId), context) === null && inStockUnit(options, line) !== null;
  });
};

/** What is sent: the party, the note, and the non-blank lines as typed. */
export const bodyOf = (draft: VoucherDraft): HandVoucherBodyInput => ({
  partyId: draft.partyId,
  note: draft.note.trim() || null,
  lines: draft.lines.filter((line) => !isBlankLine(line)).map((line) => ({ itemId: line.itemId, quantity: line.quantity.trim(), unitCode: line.unitCode })),
});
