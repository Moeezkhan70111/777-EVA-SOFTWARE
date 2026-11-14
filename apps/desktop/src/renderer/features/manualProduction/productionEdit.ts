import { cartonsToDozens, manualProductionCartons } from "@erp/domain";
import { cellKey, type ProductionGrid } from "./manualProductionDraft";

// EDITING TODAY'S PRODUCTION of one article on one machine, before it is saved. Plain functions, so the dialog only
// renders (R13). The boxes start at what was saved today; what the person changes becomes a list of changes, each
// "7/10 BLACKRED 5 -> 3 dozen". The main process records each as a reversal and a new entry
// (database/manualProductionEdit.ts) and checks every figure again.

/** One size and colour of the article on that machine today, as the main process answered it. */
export interface SavedCell {
  readonly articleSizeId: string;
  readonly size: string;
  readonly color: string;
  readonly cartons: number;
}

export interface ArticleToday {
  readonly date: string;
  /** The machine the article was saved on; null when it has nothing of it today. */
  readonly machineId: string | null;
  readonly machineName: string;
  readonly article: string;
  readonly cells: readonly SavedCell[];
}

export type Reply<T> = { ok: true; value: T } | { ok: false; reason: string };

const asRecord = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
const isText = (value: unknown): value is string => typeof value === "string";
const isCartons = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

const readCell = (value: unknown): SavedCell | null => {
  const cell = asRecord(value);
  return isText(cell.articleSizeId) && isText(cell.size) && isText(cell.color) && isCartons(cell.cartons)
    ? { articleSizeId: cell.articleSizeId, size: cell.size, color: cell.color, cartons: cell.cartons }
    : null;
};

/** The main process's answer for today's figures, checked (R25). Anything malformed is a failure. */
export function parseArticleTodayReply(reply: unknown, failed: string): Reply<ArticleToday> {
  const record = asRecord(reply);
  if (record.accepted !== true) return { ok: false, reason: isText(record.reason) && record.reason ? record.reason : failed };
  const article = asRecord(record.article);
  const cells = Array.isArray(article.cells) ? article.cells.map(readCell) : null;
  const machineId = article.machineId === null || isText(article.machineId) ? article.machineId : undefined;
  if (!isText(article.date) || !isText(article.machineName) || !isText(article.article) || machineId === undefined || !cells || cells.some((cell) => cell === null)) {
    return { ok: false, reason: failed };
  }
  return { ok: true, value: { date: article.date, machineId, machineName: article.machineName, article: article.article, cells: cells as SavedCell[] } };
}

/** The main process's answer to Save changes: how many figures changed, or why it refused. */
export function parseEditReply(reply: unknown, failed: string): Reply<number> {
  const record = asRecord(reply);
  if (record.accepted !== true) return { ok: false, reason: isText(record.reason) && record.reason ? record.reason : failed };
  return Array.isArray(record.changes) ? { ok: true, value: record.changes.length } : { ok: false, reason: failed };
}

/** What each box held today, in cartons, by cellKey. */
export const savedByCell = (today: ArticleToday): Map<string, number> =>
  new Map(today.cells.map((cell) => [cellKey(cell.articleSizeId, cell.color), cell.cartons]));

/** Cartons as typed dozens: "2.5", never "2.50". */
export const dozensTyped = (cartons: number): string => String(cartonsToDozens(cartons));

/** The boxes as the dialog opens: today's dozens, nothing where nothing was saved. */
export const startingTyped = (today: ArticleToday): Record<string, string> =>
  Object.fromEntries(today.cells.map((cell) => [cellKey(cell.articleSizeId, cell.color), dozensTyped(cell.cartons)]));

/** The cartons a box asks for: 0 when it is empty or 0, null while it is not yet a quantity. */
export function boxCartons(typed: string): number | null {
  const value = typed.trim();
  if (value === "" || Number(value) === 0) return 0;
  const quantity = manualProductionCartons(value);
  return quantity.ok ? quantity.cartons : null;
}

/** Why each box cannot be saved, by cellKey. Empty and 0 are not problems: they mean none. */
export function editProblems(typed: Readonly<Record<string, string>>): Map<string, string> {
  const problems = new Map<string, string>();
  for (const [key, value] of Object.entries(typed)) {
    if (value.trim() === "" || Number(value.trim()) === 0) continue;
    const quantity = manualProductionCartons(value);
    if (!quantity.ok) problems.set(key, quantity.reason);
  }
  return problems;
}

/** One box whose figure changes. */
export interface EditChange {
  readonly articleSizeId: string;
  readonly size: string;
  readonly color: string;
  readonly fromCartons: number;
  readonly toCartons: number;
}

/**
 * Every box whose figure the person changed, size by size and colour by colour. A box still being typed (not yet a
 * quantity) is left out; editProblems says why. Only boxes the product is made in can change.
 */
export function editChanges(grid: ProductionGrid, saved: ReadonlyMap<string, number>, typed: Readonly<Record<string, string>>): EditChange[] {
  const changes: EditChange[] = [];
  for (const size of grid.sizes) {
    for (const colour of grid.colours) {
      if (!grid.made.get(size.id)?.has(colour)) continue;
      const key = cellKey(size.id, colour);
      const from = saved.get(key) ?? 0;
      const to = boxCartons(typed[key] ?? "");
      if (to === null || to === from) continue;
      changes.push({ articleSizeId: size.id, size: size.size, color: colour, fromCartons: from, toCartons: to });
    }
  }
  return changes;
}

/** The changes as the main process takes them: the figure each box should be, in dozens. */
export const editCells = (changes: readonly EditChange[]) =>
  changes.map((change) => ({ articleSizeId: change.articleSizeId, color: change.color, dozens: dozensTyped(change.toCartons) }));
