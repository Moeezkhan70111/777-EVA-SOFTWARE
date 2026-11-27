import { CARTON_ADJUSTMENT_DIRECTION, CARTON_ADJUSTMENT_KIND, compareSizes, type CartonAdjustmentKind } from "@erp/domain";
import { lineKey, type DraftLine, type EntryGrid } from "./stockAdjustmentDraft";
import type { AdjustmentChoice } from "./stockAdjustmentReply";

// THE + / − VIEW (owner, 27 Nov 2026): the article as Carton Stock shows it, with − and + in every cell, so a count
// is corrected by pressing instead of typing. Plain functions, so the view only renders (R13).
//
// Each press is ONE CARTON (half a dozen), the smallest amount the store holds, so every figure can be reached.
// A cell's change is signed: above zero it becomes an Increase line, below zero a Decrease line, exactly the lines
// the typed grid makes. The main process checks every line again when the document is posted.

/** Cartons per press: one carton, half a dozen. */
export const STEP_CARTONS = 1;

/** The signed change in cartons per cell, by lineKey. A cell with no change is left out. */
export type Steps = Readonly<Record<string, number>>;

const changeIn = (steps: Steps, choice: AdjustmentChoice): number => steps[lineKey(choice.articleSizeId, choice.color)] ?? 0;

/** A cell takes presses when the colour is made in the size and, on Opening Stock, has no opening yet. */
export const isSteppable = (choice: AdjustmentChoice | undefined, kind: CartonAdjustmentKind): choice is AdjustmentChoice =>
  choice !== undefined && !choice.colorMissing && !(kind === CARTON_ADJUSTMENT_KIND.OPENING && choice.hasOpening);

/** Opening Stock only adds: − only takes back what + added. A Stock Adjustment goes either way, below zero too. */
export const canStepDown = (kind: CartonAdjustmentKind, change: number): boolean =>
  kind !== CARTON_ADJUSTMENT_KIND.OPENING || change > 0;

/** The steps after one press on a cell; a change back to nothing leaves the cell out. */
export function stepped(steps: Steps, key: string, delta: number): Steps {
  const next = { ...steps };
  const change = (steps[key] ?? 0) + delta;
  if (change === 0) delete next[key];
  else next[key] = change;
  return next;
}

/** The lines the changed cells make, colour by colour and size by size, as the typed grid makes them. */
export function stepEntries(article: string, choices: readonly AdjustmentChoice[], steps: Steps, kind: CartonAdjustmentKind): DraftLine[] {
  return choices
    .filter((choice) => isSteppable(choice, kind) && changeIn(steps, choice) !== 0)
    .sort((a, b) => a.color.localeCompare(b.color) || compareSizes(a.size, b.size))
    .map((choice) => {
      const change = changeIn(steps, choice);
      return {
        key: lineKey(choice.articleSizeId, choice.color),
        articleSizeId: choice.articleSizeId,
        article,
        size: choice.size,
        color: choice.color,
        direction: change > 0 ? CARTON_ADJUSTMENT_DIRECTION.IN : CARTON_ADJUSTMENT_DIRECTION.OUT,
        cartons: Math.abs(change),
        inStore: choice.inStore,
      };
    });
}

/** What a cell will hold, in cartons: the store's figure and its change. */
export const heldAfter = (choice: AdjustmentChoice | undefined, steps: Steps): number =>
  choice ? choice.inStore + changeIn(steps, choice) : 0;

export interface StepTotals {
  /** Each size's total after the changes, in the grid's size order. */
  readonly bySize: readonly number[];
  /** Each colour's total after the changes, in the grid's colour order. */
  readonly byColour: readonly number[];
  readonly grand: number;
}

/** The card's totals after the changes, in cartons, as Carton Stock adds them up. */
export function stepTotals(grid: EntryGrid, steps: Steps): StepTotals {
  const held = (articleSizeId: string, colour: string) => heldAfter(grid.cells.get(lineKey(articleSizeId, colour)), steps);
  const bySize = grid.sizes.map((size) => grid.colours.reduce((sum, colour) => sum + held(size.articleSizeId, colour), 0));
  const byColour = grid.colours.map((colour) => grid.sizes.reduce((sum, size) => sum + held(size.articleSizeId, colour), 0));
  return { bySize, byColour, grand: bySize.reduce((sum, total) => sum + total, 0) };
}
