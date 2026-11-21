import {
  groupArchiveRows,
  ledgerArchiveRowsOf,
  looksLikeLegacyLedgerReport,
  parseLegacyLedgerReport,
  type LedgerArchiveRowInput,
  type LedgerArchiveSide,
  type LegacyCell,
  type LegacyReportInfo,
} from "@erp/domain";
import { readSheetFile } from "../../utils/importFile";
import { fileSha256, readSpreadsheetGrids } from "./legacyReportReader";

// ONE CHOSEN FILE AS IMPORT STATEMENTS (docs/53). A previous-software ledger report (.xls, .xlsx, or the same report
// saved as CSV) becomes one statement per party it names, each carrying the report's own title, code, period and Total
// line for the main process to check again. A CSV in the archive template (docs/50) becomes one statement per party in
// it, on the ledger the import was opened from. Nothing here decides what is valid: the domain rules do, again, in the
// main process.

export interface ChosenStatement {
  readonly fileName: string;
  readonly fileHash: string;
  readonly side: LedgerArchiveSide;
  readonly rows: LedgerArchiveRowInput[];
  /** Set for a statement read from the previous software's report. */
  readonly report: LegacyReportInfo | null;
  /** What reading the file found wrong: a statement with any is never imported. */
  readonly readProblems: readonly string[];
  readonly readWarnings: readonly string[];
}

export interface ChosenFile {
  readonly name: string;
  readonly hash: string;
  readonly statements: ChosenStatement[];
  /** Problems that belong to the file, not to one party (an unrecognised file, a stray row). */
  readonly problems: readonly string[];
}

function reportStatements(name: string, hash: string, grid: LegacyCell[][]): { statements: ChosenStatement[]; problems: string[] } {
  const report = parseLegacyLedgerReport(grid);
  const statements = report.statements.map((s): ChosenStatement => {
    const { side, periodFrom, periodTo, printedTotals } = s;
    const info: LegacyReportInfo | null =
      side && periodFrom && periodTo && printedTotals ? { title: s.title, side, partyCode: s.partyCode, partyName: s.partyName, periodFrom, periodTo, printedTotals } : null;
    return {
      fileName: name, fileHash: hash, side: side ?? "CUSTOMER", rows: [...s.rows], report: info,
      readProblems: info ? s.problems : [...s.problems, "The report is incomplete, so it cannot be checked against its own totals."],
      readWarnings: s.warnings,
    };
  });
  return { statements, problems: [...report.problems] };
}

/** A CSV in the archive template, read by the app's own CSV reader (utils/importFile.ts), exactly as before. */
async function templateStatements(file: File, hash: string, side: LedgerArchiveSide): Promise<ChosenStatement[]> {
  const sheet = await readSheetFile(file);
  return groupArchiveRows(ledgerArchiveRowsOf(sheet.headers, sheet.rows)).map((rows) => ({ fileName: file.name, fileHash: hash, side, rows, report: null, readProblems: [], readWarnings: [] }));
}

/** Reads one chosen file. `side` is the ledger the import was opened from: used only for a template CSV. */
export async function readChosenFile(file: File, side: LedgerArchiveSide): Promise<ChosenFile> {
  const [sheets, hash] = await Promise.all([readSpreadsheetGrids(file), fileSha256(file)]);
  const statements: ChosenStatement[] = [];
  const problems: string[] = [];
  for (const sheet of sheets) {
    if (sheet.grid.every((row) => row.every((cell) => cell === null || cell === ""))) continue;
    if (looksLikeLegacyLedgerReport(sheet.grid)) {
      const read = reportStatements(file.name, hash, sheet.grid);
      statements.push(...read.statements);
      problems.push(...read.problems.map((problem) => (sheets.length > 1 ? `${sheet.sheetName}: ${problem}` : problem)));
    } else if (/\.(csv|txt)$/i.test(file.name)) {
      statements.push(...(await templateStatements(file, hash, side)));
    } else {
      problems.push(`${sheets.length > 1 ? `${sheet.sheetName}: ` : ""}This sheet is not a Customer or Supplier Ledger Report from the previous software.`);
    }
  }
  if (statements.length === 0 && problems.length === 0) problems.push("The file holds no ledger.");
  return { name: file.name, hash, statements, problems };
}
