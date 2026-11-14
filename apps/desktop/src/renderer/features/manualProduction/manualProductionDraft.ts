import { cartonsToDozens, compareSizes, manualProductionCartons } from "@erp/domain";
import type { ProductChoice } from "./productChoices";

// THE PRODUCTION BEING ENTERED, before it is saved (docs/48). Plain functions, so the page only renders (R13).
//
//   GRID    one article: its sizes down, every colour it has on any size across. A cell exists only where that
//           size is made in that colour (Product Master): production is never recorded for a colour a size lacks.
//   LINES   what "Add to list" puts on the list: one per machine, size and colour, in whole cartons. The same
//           machine, size and colour added again replaces the line already there.
//
// DOZENS ON SCREEN, CARTONS UNDERNEATH. The operator types and reads dozens; a line holds whole cartons by the
// domain's own rule (manualProductionCartons), which the main process applies again before writing any stock.

export interface DraftLine {
  /** machineId|articleSizeId|colour: one line per machine, size and colour. */
  readonly key: string;
  /** The Save's id for this line, kept until the line is saved, so a retried Save adds nothing twice. */
  readonly requestId: string;
  readonly machineId: string;
  readonly machineName: string;
  readonly articleSizeId: string;
  readonly article: string;
  readonly size: string;
  readonly color: string;
  readonly cartons: number;
}

export interface ProductionGrid {
  readonly sizes: ReadonlyArray<{ readonly id: string; readonly size: string }>;
  readonly colours: readonly string[];
  /** Which colours each size is made in, by articleSizeId. */
  readonly made: ReadonlyMap<string, ReadonlySet<string>>;
}

export const cellKey = (articleSizeId: string, color: string): string => `${articleSizeId}|${color}`;
export const lineKey = (machineId: string, articleSizeId: string, color: string): string => `${machineId}|${cellKey(articleSizeId, color)}`;

/** Cartons as the screen shows them: dozens, a half shown as .5. */
export const dozensText = (cartons: number): string => cartonsToDozens(cartons).toLocaleString();

export function productionGrid(choices: readonly ProductChoice[], article: string): ProductionGrid {
  const sizes = choices.filter((choice) => choice.article === article).sort((a, b) => compareSizes(a.size, b.size));
  return {
    sizes: sizes.map((choice) => ({ id: choice.articleSizeId, size: choice.size })),
    colours: [...new Set(sizes.flatMap((choice) => choice.colors))].sort(),
    made: new Map(sizes.map((choice) => [choice.articleSizeId, new Set(choice.colors)])),
  };
}

/** Typed dozens as whole cartons, or null while the box is empty or not yet a quantity. */
export const typedCartons = (typed: string): number | null => {
  if (typed.trim() === "") return null;
  const quantity = manualProductionCartons(typed);
  return quantity.ok ? quantity.cartons : null;
};

/** Why each typed box cannot be added, by cellKey. Empty boxes are not a problem: they are left out. */
export function gridProblems(typed: Readonly<Record<string, string>>): Map<string, string> {
  const problems = new Map<string, string>();
  for (const [key, value] of Object.entries(typed)) {
    if (value.trim() === "") continue;
    const quantity = manualProductionCartons(value);
    if (!quantity.ok) problems.set(key, quantity.reason);
  }
  return problems;
}

export interface LineMachine {
  readonly id: string;
  readonly name: string;
}

/** The lines the typed boxes make for one machine, colour by colour and size by size. */
export function gridLines(
  machine: LineMachine,
  article: string,
  grid: ProductionGrid,
  typed: Readonly<Record<string, string>>,
  newId: () => string
): DraftLine[] {
  const lines: DraftLine[] = [];
  for (const colour of grid.colours) {
    for (const size of grid.sizes) {
      if (!grid.made.get(size.id)?.has(colour)) continue;
      const cartons = typedCartons(typed[cellKey(size.id, colour)] ?? "");
      if (cartons === null) continue;
      lines.push({
        key: lineKey(machine.id, size.id, colour),
        requestId: newId(),
        machineId: machine.id,
        machineName: machine.name,
        articleSizeId: size.id,
        article,
        size: size.size,
        color: colour,
        cartons,
      });
    }
  }
  return lines;
}

/** New lines replace the same machine, size and colour already listed, in place; the rest go at the end. */
export function mergeLines(lines: readonly DraftLine[], added: readonly DraftLine[]): DraftLine[] {
  const byKey = new Map(added.map((line) => [line.key, line]));
  const kept = lines.map((line) => byKey.get(line.key) ?? line);
  const fresh = added.filter((line) => !lines.some((existing) => existing.key === line.key));
  return [...kept, ...fresh];
}

export const cartonsOf = (lines: readonly DraftLine[]): number => lines.reduce((sum, line) => sum + line.cartons, 0);

export interface MachineGroup {
  readonly machineId: string;
  readonly machineName: string;
  readonly cartons: number;
  readonly lines: readonly DraftLine[];
}

/** The list as the page shows it: one group per machine, in the order the machines were first added. */
export function byMachine(lines: readonly DraftLine[]): MachineGroup[] {
  const ids = [...new Set(lines.map((line) => line.machineId))];
  return ids.map((machineId) => {
    const own = lines.filter((line) => line.machineId === machineId);
    return { machineId, machineName: own[0]?.machineName ?? "", cartons: cartonsOf(own), lines: own };
  });
}

/** In the list for this machine, by cellKey: what the grid shows under each box. */
export function listedFor(lines: readonly DraftLine[], machineId: string): Map<string, number> {
  const listed = new Map<string, number>();
  for (const line of lines) if (line.machineId === machineId) listed.set(cellKey(line.articleSizeId, line.color), line.cartons);
  return listed;
}

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** A list read back from this computer's storage, checked (R25): anything malformed is dropped. */
export function readStoredLines(value: unknown): DraftLine[] {
  if (!Array.isArray(value)) return [];
  return value.filter((line): line is DraftLine => {
    if (typeof line !== "object" || line === null) return false;
    const fields = line as Record<string, unknown>;
    const texts = [fields.key, fields.requestId, fields.machineId, fields.machineName, fields.articleSizeId, fields.article, fields.size, fields.color];
    return texts.every(isText) && typeof fields.cartons === "number" && Number.isInteger(fields.cartons) && fields.cartons > 0;
  });
}
