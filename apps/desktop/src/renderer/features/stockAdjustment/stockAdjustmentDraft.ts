import {
  CARTON_ADJUSTMENT_DIRECTION,
  CARTON_ADJUSTMENT_KIND,
  cartonAdjustmentDozens,
  cartonAdjustmentResult,
  cartonsToDozens,
  compareSizes,
  type CartonAdjustmentDirection,
  type CartonAdjustmentKind,
} from "@erp/domain";
import { copy } from "../../config/copy";
import type { AdjustmentChoice } from "./stockAdjustmentReply";

// THE DOCUMENT BEING WRITTEN, before it is posted. Plain functions, so the page only renders (R13). The figures are
// a preview from the main process's answer; the main process checks every line again when it posts, inside its lock.
//
// DOZENS ON SCREEN, CARTONS UNDERNEATH (owner, 11 Nov 2026). The operator types and reads dozens; a line holds whole
// cartons (1 carton = half a dozen, @erp/domain cartonAdjustmentDozens), which is what the main process stores.

const text = copy.stockAdjustment;

export interface DraftLine {
  /** articleSizeId|colour: one line per colour of one size. */
  readonly key: string;
  readonly articleSizeId: string;
  readonly article: string;
  readonly size: string;
  readonly color: string;
  readonly direction: CartonAdjustmentDirection;
  readonly cartons: number;
  /** The figure in store, in cartons, when the line was added. */
  readonly inStore: number;
}

export interface DraftHeader {
  readonly kind: CartonAdjustmentKind;
  readonly businessDate: string;
  readonly reason: string;
  readonly remarks: string;
}

export const lineKey = (articleSizeId: string, color: string): string => `${articleSizeId}|${color}`;

/** Cartons as the screen shows them: dozens, a half shown as .5. */
export const dozensText = (cartons: number): string => String(cartonsToDozens(cartons));

/** The figure after the line, in cartons. */
export const resultOf = (line: Pick<DraftLine, "inStore" | "direction" | "cartons">): number => cartonAdjustmentResult(line.inStore, line.direction, line.cartons);

/** Typed dozens as whole cartons, or null while the box is empty or not yet a quantity. */
export const typedCartons = (typed: string): number | null => {
  if (typed.trim() === "") return null;
  const quantity = cartonAdjustmentDozens(typed);
  return quantity.ok ? quantity.cartons : null;
};

/**
 * Why one typed quantity cannot be added, or null. Empty is not a problem: the size is simply left out. A size the
 * colour is not on yet can only take a quantity where the colour can be added (master data).
 */
export function entryProblem(
  choice: AdjustmentChoice,
  kind: CartonAdjustmentKind,
  direction: CartonAdjustmentDirection,
  typed: string,
  canAddColor: boolean
): string | null {
  if (typed.trim() === "") return null;
  const quantity = cartonAdjustmentDozens(typed);
  if (!quantity.ok) return quantity.reason;
  if (choice.colorMissing && !canAddColor) return text.colorNotOnSize;
  if (kind === CARTON_ADJUSTMENT_KIND.OPENING && choice.hasOpening) return text.alreadyOpened;
  return null;
}

/**
 * ONE ARTICLE AS A GRID (owner, 13 Nov 2026): sizes down, colours across, a box in every cell, so every colour and
 * size of the article is typed at once instead of one colour at a time. Typed text is keyed by lineKey, one per cell.
 */
export interface EntryGrid {
  /** The article's sizes in store order. */
  readonly sizes: ReadonlyArray<{ readonly articleSizeId: string; readonly size: string }>;
  /** Every colour the article has on any size, A to Z. */
  readonly colours: readonly string[];
  /** The choice behind each cell, by lineKey. A cell with none takes no quantity. */
  readonly cells: ReadonlyMap<string, AdjustmentChoice>;
}

export function entryGrid(choices: readonly AdjustmentChoice[]): EntryGrid {
  const sizes = new Map<string, string>();
  for (const choice of choices) sizes.set(choice.articleSizeId, choice.size);
  return {
    sizes: [...sizes].map(([articleSizeId, size]) => ({ articleSizeId, size })).sort((a, b) => compareSizes(a.size, b.size)),
    colours: [...new Set(choices.map((choice) => choice.color))].sort(),
    cells: new Map(choices.map((choice) => [lineKey(choice.articleSizeId, choice.color), choice])),
  };
}

const typedIn = (typed: Readonly<Record<string, string>>, choice: AdjustmentChoice): string => typed[lineKey(choice.articleSizeId, choice.color)] ?? "";

/** The problem with each typed cell, by lineKey. Cells with nothing typed, or nothing wrong, are left out. */
export function gridProblems(
  choices: readonly AdjustmentChoice[],
  kind: CartonAdjustmentKind,
  direction: CartonAdjustmentDirection,
  typed: Readonly<Record<string, string>>,
  canAddColor: boolean
): Map<string, string> {
  const problems = new Map<string, string>();
  for (const choice of choices) {
    const problem = entryProblem(choice, kind, direction, typedIn(typed, choice), canAddColor);
    if (problem) problems.set(lineKey(choice.articleSizeId, choice.color), problem);
  }
  return problems;
}

/** The lines the typed cells make, colour by colour and size by size, the order the grid reads. */
export function gridEntries(
  article: string,
  choices: readonly AdjustmentChoice[],
  typed: Readonly<Record<string, string>>,
  direction: CartonAdjustmentDirection
): DraftLine[] {
  return choices
    .filter((choice) => typedCartons(typedIn(typed, choice)) !== null)
    .sort((a, b) => a.color.localeCompare(b.color) || compareSizes(a.size, b.size))
    .map((choice) => ({
      key: lineKey(choice.articleSizeId, choice.color),
      articleSizeId: choice.articleSizeId,
      article,
      size: choice.size,
      color: choice.color,
      direction,
      cartons: Number(typedCartons(typedIn(typed, choice))),
      inStore: choice.inStore,
    }));
}

/** The colours that must first be added to a size they are not on yet, because a quantity was typed there. */
export const coloursToAdd = (choices: readonly AdjustmentChoice[], typed: Readonly<Record<string, string>>): string[] =>
  [...new Set(choices.filter((choice) => choice.colorMissing && typedCartons(typedIn(typed, choice)) !== null).map((choice) => choice.color))].sort();

/** New lines replace the same colour and size already on the document, in place; the rest go at the end. */
export function mergeLines(lines: readonly DraftLine[], added: readonly DraftLine[]): DraftLine[] {
  const byKey = new Map(added.map((line) => [line.key, line]));
  const kept = lines.map((line) => byKey.get(line.key) ?? line);
  const fresh = added.filter((line) => !lines.some((existing) => existing.key === line.key));
  return [...kept, ...fresh];
}

/** Totals in cartons; the screen shows them as dozens. */
export const totalsOf = (lines: readonly DraftLine[]): { cartonsIn: number; cartonsOut: number } => ({
  cartonsIn: lines.filter((line) => line.direction === CARTON_ADJUSTMENT_DIRECTION.IN).reduce((sum, line) => sum + line.cartons, 0),
  cartonsOut: lines.filter((line) => line.direction === CARTON_ADJUSTMENT_DIRECTION.OUT).reduce((sum, line) => sum + line.cartons, 0),
});

/** Why the document cannot be posted yet, or null. */
export function documentProblem(header: DraftHeader, lines: readonly DraftLine[]): string | null {
  if (lines.length === 0) return text.noLines;
  if (!header.businessDate) return text.dateRequired;
  if (!header.reason.trim()) return text.reasonRequired;
  return null;
}
