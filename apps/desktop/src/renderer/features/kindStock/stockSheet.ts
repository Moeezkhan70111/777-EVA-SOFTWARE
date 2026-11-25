import { colorToUrdu, type ColorDictionary } from "@erp/domain";
import { copy } from "../../config/copy";

// THE DANA STOCK SHEET's figures: the whole of one kind, laid out like the paper sheet the store kept
// by hand (a banner per compound, a small table per kind under it, colour / size / quantity, a total
// per table and one at the foot). This file checks the reply (R25) and groups it; stockSheetPrint.ts
// draws it. The balances are the data layer's; nothing here works one out, it only adds them up per unit.

export interface StockSheetRow {
  id: string;
  path: string[];
  colour: string;
  colourUrdu: string;
  size: string;
  quantity: number;
  unitCode: string;
}

export interface SheetTotal {
  unitCode: string;
  quantity: number;
}

/** One small table: "EVA" under its banner. */
export interface SheetTable {
  title: string;
  rows: StockSheetRow[];
  totals: SheetTotal[];
}

/** A banner ("SPECIAL EVA/EVR COMPOUND") and the tables under it; no banner for kinds filed one level down. */
export interface SheetSection {
  banner: string | null;
  tables: SheetTable[];
}

export interface StockSheet {
  sections: SheetSection[];
  totals: SheetTotal[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const isRow = (value: unknown): value is StockSheetRow =>
  isRecord(value) &&
  typeof value.id === "string" &&
  Array.isArray(value.path) &&
  value.path.every((name) => typeof name === "string") &&
  typeof value.colour === "string" &&
  typeof value.colourUrdu === "string" &&
  typeof value.size === "string" &&
  typeof value.quantity === "number" &&
  Number.isFinite(value.quantity) &&
  typeof value.unitCode === "string";

export type SheetReply = { ok: true; rows: StockSheetRow[] } | { ok: false; reason: string };

/** The main process's answer. Anything malformed is a failure: a sheet with rows missing would be printed and believed. */
export const parseStockSheetReply = (reply: unknown): SheetReply => {
  if (!isRecord(reply)) return { ok: false, reason: copy.kindStock.unreadable };
  if (reply.accepted !== true) return { ok: false, reason: typeof reply.reason === "string" ? reply.reason : copy.kindStock.unreadable };
  const { rows } = reply;
  return Array.isArray(rows) && rows.every(isRow) ? { ok: true, rows } : { ok: false, reason: copy.kindStock.unreadable };
};

/** Adds quantities up per unit, never across units, in the order the units first appear. */
export const totalsByUnit = (rows: readonly StockSheetRow[]): SheetTotal[] => {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.unitCode, (totals.get(row.unitCode) ?? 0) + row.quantity);
  return Array.from(totals, ([unitCode, quantity]) => ({ unitCode, quantity }));
};

/** Where a row goes: its banner is the first category under DANA when there is a second one under that. */
const placeOf = (row: StockSheetRow, kindName: string): { banner: string | null; table: string } => {
  if (row.path.length >= 2) return { banner: row.path[0] ?? null, table: row.path.slice(1).join(" — ") };
  return { banner: null, table: row.path[0] ?? kindName };
};

/** Groups the store into banners and tables, keeping the order the store lists them in. */
export const buildStockSheet = (rows: readonly StockSheetRow[], kindName: string): StockSheet => {
  const sections = new Map<string | null, Map<string, StockSheetRow[]>>();
  for (const row of rows) {
    const { banner, table } = placeOf(row, kindName);
    const tables = sections.get(banner) ?? new Map<string, StockSheetRow[]>();
    tables.set(table, [...(tables.get(table) ?? []), row]);
    sections.set(banner, tables);
  }
  return {
    sections: Array.from(sections, ([banner, tables]) => ({
      banner,
      tables: Array.from(tables, ([title, tableRows]) => ({ title, rows: tableRows, totals: totalsByUnit(tableRows) })),
    })),
    totals: totalsByUnit(rows),
  };
};

/** The colour as the store writes it on the sheet: the Urdu typed on the material, else the shared colour list's, else English. */
export const sheetColourName = (row: StockSheetRow, colours: ColorDictionary): string =>
  row.colourUrdu || colorToUrdu(row.colour, colours) || row.colour;
