import type { LegacyCell } from "@erp/domain";

// A SPREADSHEET AS A GRID OF CELLS (docs/53), for the previous software's ledger reports: Excel 97-2003 (.xls), .xlsx,
// or CSV. Read here, in the screen's sandbox, so an untrusted file is parsed with no privileges; the main process then
// checks every row again.
//
// DATES. Excel stores a date as a day number with a date format. It is turned into YYYY-MM-DD by UTC arithmetic, never
// through a local Date, which in Pakistan (UTC+5) would land on the day before. A date typed as text stays text.
//
// Numbers stay numbers and text stays text: the report reader (@erp/domain legacyLedgerReport.ts) decides what each one is.

/** The largest file read: far above a party's ledger (the largest sample is 0.6 MB). */
export const LEGACY_REPORT_MAX_BYTES = 15 * 1024 * 1024;

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const serialToIsoDay = (serial: number): string => new Date(EXCEL_EPOCH_MS + Math.round(serial) * 86_400_000).toISOString().slice(0, 10);

export class SpreadsheetReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpreadsheetReadError";
  }
}

export interface SheetGrid {
  readonly sheetName: string;
  readonly grid: LegacyCell[][];
}

type XlsxModule = typeof import("xlsx");
type WorkSheet = import("xlsx").WorkSheet;

/** One sheet's used range as rows of cells. */
function gridOf(xlsx: XlsxModule, sheet: WorkSheet, dates: boolean): LegacyCell[][] {
  const ref = sheet["!ref"];
  if (!ref) return [];
  const range = xlsx.utils.decode_range(ref);
  const rows: LegacyCell[][] = [];
  for (let r = 0; r <= range.e.r; r += 1) {
    const row: LegacyCell[] = [];
    for (let c = 0; c <= range.e.c; c += 1) {
      const cell = sheet[xlsx.utils.encode_cell({ r, c })];
      if (!cell || cell.v === undefined || cell.v === null || cell.t === "e" || cell.t === "z") row.push(null);
      else if (cell.t === "n" && dates && typeof cell.z === "string" && xlsx.SSF.is_date(cell.z)) row.push(serialToIsoDay(Number(cell.v)));
      else if (cell.t === "n") row.push(Number(cell.v));
      else row.push(String(cell.v));
    }
    rows.push(row);
  }
  return rows;
}

const isText = (name: string): boolean => /\.(csv|txt)$/i.test(name);

/** Every sheet of a spreadsheet file as grids. CSV is read as text, so nothing is turned into a number on the way. */
export async function readSpreadsheetGrids(file: File): Promise<SheetGrid[]> {
  if (file.size > LEGACY_REPORT_MAX_BYTES) throw new SpreadsheetReadError(`${file.name} is larger than 15 MB.`);
  if (!/\.(xls|xlsx|csv|txt)$/i.test(file.name)) throw new SpreadsheetReadError(`${file.name} is not an Excel (.xls, .xlsx) or CSV file.`);
  const xlsx = await import("xlsx");
  let book: import("xlsx").WorkBook;
  try {
    book = isText(file.name)
      ? xlsx.read(await file.text(), { type: "string", raw: true, dense: false })
      : xlsx.read(new Uint8Array(await file.arrayBuffer()), { type: "array", cellNF: true, cellDates: false, cellFormula: false, cellHTML: false, dense: false });
  } catch {
    throw new SpreadsheetReadError(`${file.name} could not be read as a spreadsheet.`);
  }
  return book.SheetNames.map((name) => ({ sheetName: name, grid: gridOf(xlsx, book.Sheets[name] as WorkSheet, !isText(file.name)) }));
}

/** SHA-256 of a file's bytes, as hex: what makes "this file was already imported" exact. */
export async function fileSha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
