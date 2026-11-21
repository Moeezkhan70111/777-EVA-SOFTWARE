import type { LedgerArchiveSide } from "@erp/domain";
import { copy } from "../../config/copy";
import type { ImportPreview, PreviewStatement } from "./archiveReplies";
import { readChosenFile, type ChosenFile, type ChosenStatement } from "./legacyImport";

// ONE IMPORT SESSION (docs/53): every file chosen together, customers and suppliers mixed, read into one list of
// statements. Each statement keeps its own file, side and report, so the main process checks each one on its own
// terms. The same file chosen twice is read once.

const text = copy.ledgerArchive;

export interface ImportSession {
  readonly files: readonly ChosenFile[];
  readonly statements: readonly ChosenStatement[];
  /** What could not be read, file by file: shown, never imported. */
  readonly problems: readonly string[];
}

/** Reads every chosen file. A file that cannot be read is reported and the others are still read. */
export async function readImportSession(picked: readonly File[], side: LedgerArchiveSide): Promise<ImportSession> {
  const files: ChosenFile[] = [];
  const problems: string[] = [];
  for (const file of picked) {
    try {
      const chosen = await readChosenFile(file, side);
      if (files.some((earlier) => earlier.hash === chosen.hash)) {
        problems.push(text.fileChosenTwice(file.name));
        continue;
      }
      files.push(chosen);
      problems.push(...chosen.problems.map((problem) => text.fileNotRead(file.name, problem)));
    } catch (error) {
      problems.push(text.fileNotRead(file.name, error instanceof Error ? error.message : text.failed));
    }
  }
  return { files, statements: files.flatMap((file) => file.statements), problems };
}

/** One statement as the main process is sent it. */
export const statementInput = (statement: ChosenStatement, partyId: string | undefined) => ({
  partyId,
  rows: statement.rows,
  side: statement.side,
  sourceFile: { name: statement.fileName, hash: statement.fileHash },
  report: statement.report,
});

/** The batch's own name and hash: the file itself when there is one, else the first, named with how many more. */
export const batchFileOf = (session: ImportSession): { name: string; hash: string } => {
  const [first] = session.files;
  return { name: text.batchFileName(first?.name ?? "", session.files.length - 1).slice(0, 200), hash: first?.hash ?? "" };
};

const unique = (items: readonly string[]): string[] => [...new Set(items)];

/** The main process's preview with what reading each file found added to its statement: a read problem blocks it. */
export const withReadNotes = (preview: ImportPreview, session: ImportSession): ImportPreview => ({
  ...preview,
  statements: preview.statements.map((statement, index): PreviewStatement => {
    const read = session.statements[index];
    return { ...statement, problems: unique([...(read?.readProblems ?? []), ...statement.problems]), warnings: unique([...(read?.readWarnings ?? []), ...statement.warnings]) };
  }),
});

/** Whether a statement may be imported as it stands. */
export const statementReady = (statement: PreviewStatement): boolean =>
  statement.match !== null && statement.problems.length === 0 && statement.alreadyStored === null && statement.repeatedRows === 0 && statement.fileAlreadyImported === null;
