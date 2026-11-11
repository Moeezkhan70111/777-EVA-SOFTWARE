import {
  CARTON_ADJUSTMENT_DIRECTION,
  CARTON_ADJUSTMENT_KIND,
  cartonAdjustmentQuantityProblem,
  cartonAdjustmentResult,
  type CartonAdjustmentDirection,
  type CartonAdjustmentKind,
} from "@erp/domain";
import { copy } from "../../config/copy";
import type { AdjustmentChoice } from "./stockAdjustmentReply";

// THE DOCUMENT BEING WRITTEN, before it is posted. Plain functions, so the page only renders (R13). The figures are
// a preview from the main process's answer; the main process checks every line again when it posts, inside its lock.

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
  /** The figure in store when the line was added. */
  readonly inStore: number;
}

export interface DraftHeader {
  readonly kind: CartonAdjustmentKind;
  readonly businessDate: string;
  readonly reason: string;
  readonly remarks: string;
}

export const lineKey = (articleSizeId: string, color: string): string => `${articleSizeId}|${color}`;

/** The figure after the line, as the preview shows it. */
export const resultOf = (line: Pick<DraftLine, "inStore" | "direction" | "cartons">): number => cartonAdjustmentResult(line.inStore, line.direction, line.cartons);

/** Typed cartons as a number, or null while the box is empty. */
export const typedCartons = (typed: string): number | null => (typed.trim() === "" ? null : Number(typed.trim()));

/** Why one typed quantity cannot be added, or null. Empty is not a problem: the size is simply left out. */
export function entryProblem(choice: AdjustmentChoice, kind: CartonAdjustmentKind, direction: CartonAdjustmentDirection, typed: string): string | null {
  const cartons = typedCartons(typed);
  if (cartons === null) return null;
  const problem = cartonAdjustmentQuantityProblem(cartons);
  if (problem) return problem;
  if (kind === CARTON_ADJUSTMENT_KIND.OPENING && choice.hasOpening) return text.alreadyOpened;
  if (resultOf({ inStore: choice.inStore, direction, cartons }) < 0) return text.notEnough(choice.inStore);
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

/** New lines replace the same colour and size already on the document, in place; the rest go at the end. */
export function mergeLines(lines: readonly DraftLine[], added: readonly DraftLine[]): DraftLine[] {
  const byKey = new Map(added.map((line) => [line.key, line]));
  const kept = lines.map((line) => byKey.get(line.key) ?? line);
  const fresh = added.filter((line) => !lines.some((existing) => existing.key === line.key));
  return [...kept, ...fresh];
}

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
