import { useMemo, useState } from "react";
import type { Loaded } from "../../hooks/useLoaded";
import type { MachineRecord } from "../../types/desktopApi";
import { gridLines, gridProblems, productionGrid, type DraftLine } from "./manualProductionDraft";
import type { ProductChoice } from "./productChoices";

// One article being typed in for the chosen machine: the dozens in every box, and "Add to list". Choosing another
// article clears the boxes; choosing another machine keeps them, so a mistaken machine is fixed before adding.

export const useArticleEntry = (products: Loaded<ProductChoice[]>, machine: MachineRecord | null, onAdd: (lines: DraftLine[]) => void) => {
  const [article, setArticle] = useState("");
  const [typed, setTyped] = useState<Record<string, string>>({});
  const grid = useMemo(() => productionGrid(products.value, article), [products.value, article]);
  const problems = gridProblems(typed);
  const lines = machine ? gridLines({ id: machine.id, name: machine.name }, article, grid, typed, () => crypto.randomUUID()) : [];
  const canAdd = machine !== null && lines.length > 0 && problems.size === 0;

  const add = () => {
    if (!canAdd) return;
    onAdd(lines);
    setTyped({});
  };

  return {
    article,
    chooseArticle: (value: string) => { setArticle(value); setTyped({}); },
    grid,
    typed,
    type: (key: string, value: string) => setTyped((current) => ({ ...current, [key]: value })),
    clearTyping: () => setTyped({}),
    problems,
    lines,
    canAdd,
    add,
  };
};
