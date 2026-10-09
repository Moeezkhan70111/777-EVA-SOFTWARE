import { useCallback, useState } from "react";
import type { MachineShift } from "@erp/domain";
import type { MachineProgramMaterial, MachineProgramRunRecord } from "../../types/desktopApi";
import { copy } from "../../config/copy";
import { quantityProblem, runForArticleSize, upperKind } from "./machineProgram";
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
  injectorNo: number;
  /** The runs already on the injector — a repeated article + size joins its run, never rivals it. */
  runs: MachineProgramRunRecord[];
  writes: ProgramWrites;
}

export const useChosenUppers = (target: AddToProgram) => {
  const [rows, setRows] = useState<ChosenUpper[]>([]);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

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
   * Saves every chosen upper, one transaction each.
   *
   * A sole run IS the colour, the article and the size, so rows describing the same one must
   * join a single run: the first of them creates it and the rest are saved onto the id it came
   * back with. The backend has no "save them all" of its own, so the first refusal stops the
   * rest — what went through before it stays on the program and is taken off the list, so
   * pressing Add again never saves it twice.
   */
  const addToProgram = useCallback(async (): Promise<boolean> => {
    if (rows.length === 0 || saving) return false;
    setSaving(true);
    setProblem(null);
    const runIds = new Map<string, string>();

    for (const [index, row] of rows.entries()) {
      const key = `${row.soleColour}|${row.articleSizeId}`;
      const runId = runIds.get(key) ?? runForArticleSize(target.runs, row.soleColour, row.articleSizeId)?.id ?? null;
      const answer = await target.writes.saveLine({
        machineId: target.machineId,
        programDate: target.programDate,
        shift: target.shift,
        injectorNo: target.injectorNo,
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
    }

    setSaving(false);
    return true;
  }, [rows, saving, target]);

  const problems = rows.map((row) => rowProblem(row));
  const ready = rows.length > 0 && problems.every((why) => why === null);

  return { rows, problems, ready, saving, problem, add, remove, setQuantity, addToProgram };
};

/** Why a chosen row cannot be saved yet, or null when it is ready. */
export const rowProblem = (row: ChosenUpper): string | null => {
  if (row.quantity.trim() === "") return copy.machineProgram.typeQuantity;
  return quantityProblem(Number(row.quantity), row.available, 0, row.unitCode);
};
