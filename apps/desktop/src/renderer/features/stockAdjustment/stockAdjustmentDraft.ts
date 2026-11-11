import {
  CARTON_ADJUSTMENT_DIRECTION,
  CARTON_ADJUSTMENT_KIND,
  cartonAdjustmentDozens,
  cartonAdjustmentResult,
  cartonsToDozens,
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
  if (resultOf({ inStore: choice.inStore, direction, cartons: quantity.cartons }) < 0) return text.notEnough(dozensText(choice.inStore));
  return null;
}

/** The lines the typed quantities make, for one article and colour. */
export function entriesFrom(
  article: string,
  color: string,
  choices: readonly AdjustmentChoice[],
  typed: Readonly<Record<string, string>>,
  direction: CartonAdjustmentDirection
): DraftLine[] {
  return choices
    .filter((choice) => choice.color === color && typedCartons(typed[choice.articleSizeId] ?? "") !== null)
    .map((choice) => ({
      key: lineKey(choice.articleSizeId, color),
      articleSizeId: choice.articleSizeId,
      article,
      size: choice.size,
      color,
      direction,
      cartons: Number(typedCartons(typed[choice.articleSizeId] ?? "")),
      inStore: choice.inStore,
    }));
}

/** Whether any typed size needs the colour added to it before its line can be posted. */
export const needsColorAdded = (choices: readonly AdjustmentChoice[], color: string, typed: Readonly<Record<string, string>>): boolean =>
  choices.some((choice) => choice.color === color && choice.colorMissing && typedCartons(typed[choice.articleSizeId] ?? "") !== null);

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
  if (lines.some((line) => resultOf(line) < 0)) return text.wouldGoNegative;
  return null;
}
