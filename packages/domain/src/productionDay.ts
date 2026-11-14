// A DAY OF PRODUCTION, as the Daily Production page reads it, and the mark that says the day is all entered (docs/48).
//
//   THE DAY     every live Manual Production entry of one business day (Asia/Karachi), added up: per machine, and
//               every machine together, each as the same Size x Colour matrix Carton Stock draws (cartonStockMatrix).
//   THE MARK    "Complete today's production" writes one record for the day (local 109). It moves no stock. It says
//               the day's figures are in, which Carton Stock shows as Production added on every computer.
//
// Pure: the data layer reads the rows, this arranges them. Voided entries are never among the rows.

import { buildCartonStockMatrix, CARTON_STOCK_MOST_SHOWN, type CartonMatrixArticle } from "./cartonStockMatrix.js";
import { roundQuantity } from "./machineProgram.js";

/** The most lines one Save of the Manual Production page may carry. */
export const MANUAL_PRODUCTION_MOST_LINES = 300;

/** The same day is the same record on every computer. */
export const productionDayId = (date: string): string => `production-day:${date}`;

/** The day, marked complete: when, by whom, and what it held then. */
export interface ProductionDayMark {
  date: string;
  completedAt: string;
  completedBy: string;
  cartons: number;
  entries: number;
}

/** One machine, article, size and colour of the day, added up. */
export interface ProductionDayLine {
  machineName: string;
  article: string;
  size: string;
  color: string;
  cartons: number;
  entries: number;
}

export interface ProductionDayMachine {
  machineName: string;
  cartons: number;
  entries: number;
  articles: CartonMatrixArticle[];
}

export interface ProductionDayView {
  date: string;
  /** Null until the day is marked complete. */
  completed: ProductionDayMark | null;
  totalCartons: number;
  entries: number;
  machines: ProductionDayMachine[];
  /** Every machine together: one matrix per article. */
  articles: CartonMatrixArticle[];
}

const naturally = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });

const matricesOf = (lines: readonly ProductionDayLine[]): CartonMatrixArticle[] =>
  buildCartonStockMatrix(
    lines.map((line) => ({ article: line.article, size: line.size, color: line.color, series: "", quantity: line.cartons })),
    { pageSize: CARTON_STOCK_MOST_SHOWN }
  ).articles;

const sum = (lines: readonly ProductionDayLine[], pick: (line: ProductionDayLine) => number): number =>
  roundQuantity(lines.reduce((total, line) => total + pick(line), 0));

export function buildProductionDay(date: string, lines: readonly ProductionDayLine[], completed: ProductionDayMark | null): ProductionDayView {
  const names = [...new Set(lines.map((line) => line.machineName))].sort(naturally);
  const machines = names.map((machineName) => {
    const own = lines.filter((line) => line.machineName === machineName);
    return { machineName, cartons: sum(own, (line) => line.cartons), entries: sum(own, (line) => line.entries), articles: matricesOf(own) };
  });
  return {
    date,
    completed,
    totalCartons: sum(lines, (line) => line.cartons),
    entries: sum(lines, (line) => line.entries),
    machines,
    articles: matricesOf(lines),
  };
}
