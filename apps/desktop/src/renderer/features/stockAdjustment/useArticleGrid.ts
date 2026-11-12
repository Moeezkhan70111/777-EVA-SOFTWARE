import { useMemo, useState } from "react";
import { CARTON_ADJUSTMENT_DIRECTION, CARTON_ADJUSTMENT_KIND, LEASE_DOMAIN, type CartonAdjustmentDirection, type CartonAdjustmentKind } from "@erp/domain";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { leaseRefusalText } from "../../../shared/leaseRefusal";
import { useWriteLease } from "../sync/useWriteLease";
import { coloursToAdd, entryGrid, gridEntries, gridProblems, type DraftLine } from "./stockAdjustmentDraft";
import { useArticleChoices } from "./useStockAdjustment";

// The entry grid's state for one article: the dozens typed in every cell, the movement, and "Add to document". Adding
// first puts each colour on any size it is not on yet where a quantity was typed (master data, where MASTER_DATA is
// written), one colour at a time; if any of that fails, nothing is added to the document and the typing is kept.

const text = copy.stockAdjustment;

type Added = { ok: true } | { ok: false; reason: string };

export const useArticleGrid = (kind: CartonAdjustmentKind, onAdd: (lines: DraftLine[]) => void) => {
  const api = useDesktopApi();
  const [article, setArticle] = useState("");
  const [direction, setDirection] = useState<CartonAdjustmentDirection>(CARTON_ADJUSTMENT_DIRECTION.IN);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [addProblem, setAddProblem] = useState<string | null>(null);
  const choices = useArticleChoices(article);
  // A new colour is product master data: offered only where MASTER_DATA is written.
  const masterData = useWriteLease(LEASE_DOMAIN.MASTER_DATA);
  const effective = kind === CARTON_ADJUSTMENT_KIND.OPENING ? CARTON_ADJUSTMENT_DIRECTION.IN : direction;

  const grid = useMemo(() => entryGrid(choices.value), [choices.value]);
  const problems = gridProblems(choices.value, kind, effective, typed, masterData.canWrite);
  const entries = gridEntries(article, choices.value, typed, effective);
  const canAdd = entries.length > 0 && problems.size === 0 && !adding;

  const addColours = async (colours: readonly string[]): Promise<Added> => {
    for (const color of colours) {
      try {
        const reply = (await api.addArticleColor({ article, color })) as { accepted?: unknown; reason?: unknown };
        if (reply?.accepted !== true) return { ok: false, reason: typeof reply?.reason === "string" ? reply.reason : text.colorNotAdded };
      } catch (error) {
        return { ok: false, reason: leaseRefusalText(error) ?? text.colorNotAdded };
      }
    }
    return { ok: true };
  };

  const add = async () => {
    if (!canAdd) return;
    setAddProblem(null);
    const missing = coloursToAdd(choices.value, typed);
    if (missing.length > 0) {
      setAdding(true);
      const added = await addColours(missing);
      setAdding(false);
      if (!added.ok) { setAddProblem(added.reason); return; }
      await choices.reload();
    }
    onAdd(entries);
    setTyped({});
  };

  return {
    article,
    chooseArticle: (value: string) => { setArticle(value); setTyped({}); setAddProblem(null); },
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
    adding,
    addProblem,
    add,
    canAddColor: masterData.canWrite,
  };
};
