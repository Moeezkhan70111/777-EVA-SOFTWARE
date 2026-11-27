import { useMemo, useState } from "react";
import { CARTON_ADJUSTMENT_DIRECTION, CARTON_ADJUSTMENT_KIND, type CartonAdjustmentDirection, type CartonAdjustmentKind } from "@erp/domain";
import { useCanAddColour } from "../../hooks/useCanAddColour";
import { entryGrid, gridEntries, gridProblems, type DraftLine } from "./stockAdjustmentDraft";
import { STEP_CARTONS, stepEntries, stepped, type Steps } from "./stepperDraft";
import { useArticleChoices } from "./useStockAdjustment";

// The entry grid's state for one article: the dozens typed in every cell, the movement, and "Add to document". A size
// a colour is not made in takes no quantity; it is added to Product Master from its cell ("+ Add") or a new colour
// from "+ New colour", as on every quantity-by-colour page, under the one rule (useCanAddColour, 25 Nov 2026).
//
// TWO WAYS IN (owner, 27 Nov 2026): typing dozens, or pressing − and + on a Carton Stock card (stepperDraft.ts). Both
// make the same lines for the same "Add to document"; changing the way in clears what the other had.

export const ENTRY_MODE = { TYPE: "TYPE", STEP: "STEP" } as const;
export type EntryMode = (typeof ENTRY_MODE)[keyof typeof ENTRY_MODE];

const NO_STEPS: Steps = {};

export const useArticleGrid = (kind: CartonAdjustmentKind, onAdd: (lines: DraftLine[]) => void) => {
  const [article, setArticle] = useState("");
  const [mode, setModeState] = useState<EntryMode>(ENTRY_MODE.TYPE);
  const [direction, setDirection] = useState<CartonAdjustmentDirection>(CARTON_ADJUSTMENT_DIRECTION.IN);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [steps, setSteps] = useState<Steps>(NO_STEPS);
  const choices = useArticleChoices(article);
  const canAddColor = useCanAddColour();
  const effective = kind === CARTON_ADJUSTMENT_KIND.OPENING ? CARTON_ADJUSTMENT_DIRECTION.IN : direction;
  const stepping = mode === ENTRY_MODE.STEP;

  const grid = useMemo(() => entryGrid(choices.value), [choices.value]);
  const problems = stepping ? new Map<string, string>() : gridProblems(choices.value, kind, effective, typed);
  const entries = stepping ? stepEntries(article, choices.value, steps, kind) : gridEntries(article, choices.value, typed, effective);
  const canAdd = entries.length > 0 && problems.size === 0;

  const clear = () => { setTyped({}); setSteps(NO_STEPS); };
  const add = () => {
    if (!canAdd) return;
    onAdd(entries);
    clear();
  };

  return {
    article,
    chooseArticle: (value: string) => { setArticle(value); clear(); },
    mode,
    setMode: (value: EntryMode) => { if (value !== mode) { setModeState(value); clear(); } },
    direction,
    setDirection,
    effective,
    typed,
    type: (key: string, value: string) => setTyped((current) => ({ ...current, [key]: value })),
    steps,
    up: (key: string) => setSteps((current) => stepped(current, key, STEP_CARTONS)),
    down: (key: string) => setSteps((current) => stepped(current, key, -STEP_CARTONS)),
    choices,
    grid,
    problems,
    entries,
    canAdd,
    add,
    canAddColor,
  };
};
