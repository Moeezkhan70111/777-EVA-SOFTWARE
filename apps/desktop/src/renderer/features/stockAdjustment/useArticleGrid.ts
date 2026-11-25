import { useMemo, useState } from "react";
import { CARTON_ADJUSTMENT_DIRECTION, CARTON_ADJUSTMENT_KIND, type CartonAdjustmentDirection, type CartonAdjustmentKind } from "@erp/domain";
import { useCanAddColour } from "../../hooks/useCanAddColour";
import { entryGrid, gridEntries, gridProblems, type DraftLine } from "./stockAdjustmentDraft";
import { useArticleChoices } from "./useStockAdjustment";

// The entry grid's state for one article: the dozens typed in every cell, the movement, and "Add to document". A size
// a colour is not made in takes no quantity; it is added to Product Master from its cell ("+ Add") or a new colour
// from "+ New colour", as on every quantity-by-colour page, under the one rule (useCanAddColour, 25 Nov 2026).

export const useArticleGrid = (kind: CartonAdjustmentKind, onAdd: (lines: DraftLine[]) => void) => {
  const [article, setArticle] = useState("");
  const [direction, setDirection] = useState<CartonAdjustmentDirection>(CARTON_ADJUSTMENT_DIRECTION.IN);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const choices = useArticleChoices(article);
  const canAddColor = useCanAddColour();
  const effective = kind === CARTON_ADJUSTMENT_KIND.OPENING ? CARTON_ADJUSTMENT_DIRECTION.IN : direction;

  const grid = useMemo(() => entryGrid(choices.value), [choices.value]);
  const problems = gridProblems(choices.value, kind, effective, typed);
  const entries = gridEntries(article, choices.value, typed, effective);
  const canAdd = entries.length > 0 && problems.size === 0;

  const add = () => {
    if (!canAdd) return;
    onAdd(entries);
    setTyped({});
  };

  return {
    article,
    chooseArticle: (value: string) => { setArticle(value); setTyped({}); },
    direction,
    setDirection,
    effective,
    typed,
    type: (key: string, value: string) => setTyped((current) => ({ ...current, [key]: value })),
    choices,
    grid,
    problems,
    entries,
    canAdd,
    add,
    canAddColor,
  };
};
