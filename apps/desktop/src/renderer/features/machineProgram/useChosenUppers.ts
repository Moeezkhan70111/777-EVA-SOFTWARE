import { useCallback, useState } from "react";
import type { MachineShift } from "@erp/domain";
import type {
  MachineProgramArticle,
  MachineProgramArticleRate,
  MachineProgramMaterial,
  MachineProgramRunRecord,
} from "../../types/desktopApi";
import { copy } from "../../config/copy";
import {
  EMPTY_RATE_DRAFT,
  isEmptyRateDraft,
  rateDraftOf,
  rateDraftProblem,
  rateDraftToPaisa,
  rateDraftToRupees,
  sameRates,
  type RateDraft,
} from "./ContractorRateFields";
import { articleDefaultRates, quantityProblem, runForArticleSize, upperKind } from "./machineProgram";
import type { ProgramWrites } from "./useProgramWrites";

// The uppers chosen in the Add Article dialog but not yet on the program — the "Selected
// Articles" list under the three panels, and what happens when Add to Program is pressed.
//
// Nothing here is a second rule about stock. A row carries the figure the data layer gave for
// that upper, the quantity is measured against it with the shared wording (machineProgram
// quantityProblem), and the save is checked again by the backend inside its write lock. This
// only collects the answers and sends them one at a time.

/** One upper waiting to go on the program. */
export interface ChosenUpper {
  itemId: string;
  soleColour: string;
  articleSizeId: string;
  article: string;
  size: string;
  upperColour: string;
  /** "RAGZINE UPPER · SILAI" — what kind of upper it is. */
  kind: string;
  unitCode: string | null;
  /** What the store had free for it when it was chosen. The quantity may not go above this. */
  available: number;
  /** As typed, so a half-typed number is never read as one. */
  quantity: string;
}

/** Where a chosen upper is going: the sole run it describes. */
export interface ChosenFor {
  soleColour: string;
  articleSizeId: string;
  article: string;
  size: string;
}

interface AddToProgram {
  machineId: string;
  programDate: string;
  /** The shift to give the date's program when this is the first thing saved on it. */
  shift: MachineShift;
  /** Null in the Fix Articles section, which has no injector and never adds uppers. */
  injectorNo: number | null;
  /** The runs already on the injector — a repeated article + size joins its run, never rivals it. */
  runs: MachineProgramRunRecord[];
  /** What the program's articles are priced at already, so a rate box opens on what is agreed. */
  articleRates: MachineProgramArticleRate[];
  /** The Product Master list, for an article the program has not priced yet — its standard rates. */
  articles: MachineProgramArticle[];
  writes: ProgramWrites;
}

export const useChosenUppers = (target: AddToProgram) => {
  const [rows, setRows] = useState<ChosenUpper[]>([]);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Contractor pricing, per article, as typed. An article not in here has not been touched: its
  // boxes show what the program already pays for it, and saving leaves that exactly as it was.
  const [rateDrafts, setRateDrafts] = useState<Record<string, RateDraft>>({});

  /** The rates showing for an article: what was typed, or what the program already pays. */
  /**
   * The rates showing for an article, in order of authority:
   *
   *   1. what the operator has typed on this screen
   *   2. what THIS program already pays for the article
   *   3. the PRODUCT's standard rates, from the Product Master (migration 064)
   *
   * The product is only ever a starting point: whatever is showing is what gets saved onto the
   * program, so the program always ends up owning its own figure — the same relationship a sale
   * voucher line has with a product's selling price.
   */
  const rateFor = useCallback(
    (articleSizeId: string | null): RateDraft => {
      if (!articleSizeId) return EMPTY_RATE_DRAFT;
      const typed = rateDrafts[articleSizeId];
      if (typed) return typed;
      const onProgram = target.articleRates.find((row) => row.articleSizeId === articleSizeId);
      if (onProgram) return rateDraftOf(onProgram);
      return rateDraftOf(articleDefaultRates(target.articles, articleSizeId));
    },
    [rateDrafts, target.articleRates, target.articles]
  );

  const setRate = useCallback(
    (articleSizeId: string, next: RateDraft) => {
      setProblem(null);
      setRateDrafts((previous) => ({ ...previous, [articleSizeId]: next }));
    },
    []
  );

  const add = useCallback((where: ChosenFor, material: MachineProgramMaterial) => {
    setProblem(null);
    setRows((previous) =>
      previous.some((row) => row.itemId === material.itemId)
        ? previous
        : [
            ...previous,
            {
              itemId: material.itemId,
              soleColour: where.soleColour,
              articleSizeId: where.articleSizeId,
              article: where.article,
              size: where.size,
              upperColour: material.colour,
              kind: upperKind(material),
              unitCode: material.unitCode,
              available: material.available,
              quantity: "",
            },
          ]
    );
  }, []);

  const remove = useCallback((itemId: string) => {
    setProblem(null);
    setRows((previous) => previous.filter((row) => row.itemId !== itemId));
  }, []);

  const setQuantity = useCallback((itemId: string, quantity: string) => {
    setProblem(null);
    setRows((previous) => previous.map((row) => (row.itemId === itemId ? { ...row, quantity } : row)));
  }, []);

  /**
   * Saves what each article's work is paid at onto the program, once the article is on it.
   *
   * Answers with the sentence for the first refusal, or null. Used after the uppers are saved,
   * and after a FIX run is saved — a fix article's work is paid for just the same.
   */
  const saveRates = useCallback(
    async (programId: string, articleSizeIds: string[]): Promise<string | null> => {
      for (const articleSizeId of [...new Set(articleSizeIds)]) {
        const draft = rateFor(articleSizeId);
        const stored = target.articleRates.find((row) => row.articleSizeId === articleSizeId);
        // Nothing showing and nothing stored: the article stays unpriced, which is not an error.
        // (A draft prefilled from the product is not empty, so the product's standard rates DO
        // go onto the program — which is the point of them being a default.)
        if (!stored && isEmptyRateDraft(draft)) continue;
        // Unchanged from what the program already pays: no write, and no audit row saying so.
        if (stored && sameRates(rateDraftToPaisa(draft), stored)) continue;

        const answer = await target.writes.saveArticleRates({ programId, articleSizeId, ...rateDraftToRupees(draft) });
        if (!answer.ok) {
          const article = target.articles.find((entry) => entry.sizes.some((size) => size.articleSizeId === articleSizeId));
          const size = article?.sizes.find((entry) => entry.articleSizeId === articleSizeId);
          return copy.machineProgram.pricingSaveFailed(article?.article ?? "", size?.size ?? "", answer.reason);
        }
      }
      return null;
    },
    [rateFor, target]
  );

  /**
   * Saves every chosen upper, one transaction each.
   *
   * A sole run IS the colour, the article and the size, so rows describing the same one must
   * join a single run: the first of them creates it and the rest are saved onto the id it came
   * back with. The backend has no "save them all" of its own, so the first refusal stops the
   * rest — what went through before it stays on the program and is taken off the list, so
   * pressing Add again never saves it twice.
   */
  const addToProgram = useCallback(async (): Promise<boolean> => {
    const injectorNo = target.injectorNo;
    if (rows.length === 0 || saving || injectorNo === null) return false;
    setSaving(true);
    setProblem(null);
    const runIds = new Map<string, string>();
    /** The program the lines went on — made by the first save when the date had none. */
    let programId: string | null = null;

    for (const [index, row] of rows.entries()) {
      const key = `${row.soleColour}|${row.articleSizeId}`;
      const runId = runIds.get(key) ?? runForArticleSize(target.runs, row.soleColour, row.articleSizeId)?.id ?? null;
      const answer = await target.writes.saveLine({
        machineId: target.machineId,
        programDate: target.programDate,
        shift: target.shift,
        injectorNo,
        runId,
        run: runId ? null : { soleColour: row.soleColour, articleSizeId: row.articleSizeId },
        itemId: row.itemId,
        quantity: Number(row.quantity),
      });
      if (!answer.ok) {
        setRows(rows.slice(index));
        setProblem(copy.machineProgram.addRefused(row.upperColour, row.article, row.size, answer.reason));
        setSaving(false);
        return false;
      }
      if (answer.result.runId) runIds.set(key, answer.result.runId);
      programId = answer.result.programId ?? programId;
    }

    // The pricing goes on AFTER the uppers, because an article can only be priced once it is on
    // the program — that is the backend's rule, and it is the right way round: the uppers are the
    // program, the rates are what its work is paid at.
    //
    // A refusal here is reported differently from a refused line: the uppers ARE on the program,
    // and only the pricing is missing, so the operator is told to set it from Program Summary
    // rather than left thinking nothing was saved.
    const pricingRefused = programId ? await saveRates(programId, rows.map((row) => row.articleSizeId)) : null;
    if (pricingRefused) {
      setProblem(pricingRefused);
      setRows([]);
      setSaving(false);
      return false;
    }

    setSaving(false);
    return true;
  }, [rows, saveRates, saving, target]);

  const problems = rows.map((row) => rowProblem(row));
  const rateProblem = (articleSizeId: string | null): string | null =>
    articleSizeId ? rateDraftProblem(rateFor(articleSizeId)) : null;
  const articlesChosen = [...new Set(rows.map((row) => row.articleSizeId))];
  const ready =
    rows.length > 0 &&
    problems.every((why) => why === null) &&
    articlesChosen.every((articleSizeId) => rateProblem(articleSizeId) === null);

  return { rows, problems, ready, saving, problem, add, remove, setQuantity, addToProgram, saveRates, rateFor, setRate, rateProblem };
};

/** Why a chosen row cannot be saved yet, or null when it is ready. */
export const rowProblem = (row: ChosenUpper): string | null => {
  if (row.quantity.trim() === "") return copy.machineProgram.typeQuantity;
  return quantityProblem(Number(row.quantity), row.available, 0, row.unitCode);
};
