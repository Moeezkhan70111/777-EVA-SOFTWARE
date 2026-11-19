import { useCallback, useState } from "react";
import { groupArchiveRows, ledgerArchiveRowsOf, type LedgerArchiveRowInput, type LedgerArchiveSide } from "@erp/domain";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { readSheetFile } from "../../utils/importFile";
import {
  readImportOutcome,
  readImportPreview,
  readSourceDocument,
  type ImportOutcome,
  type ImportPreview,
  type PreviewStatement,
  type SourceDocument,
} from "./archiveReplies";

// THE IMPORT, STEP BY STEP (docs/50): choose a CSV → it is read, grouped by customer and checked by the main process
// → each customer is matched (or chosen) → only statements with no problem are imported, all in one go, under one
// batch id that a retry reuses. Nothing here decides whether a row is valid: the domain rules do, again, in the main
// process.

export type ImportPhase = "choose" | "reading" | "preview" | "importing" | "done";

export interface ChosenFile {
  name: string;
  hash: string;
  /** One customer's rows per statement, in the order the preview lists them. */
  statements: LedgerArchiveRowInput[][];
}

const sha256Hex = async (file: File): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const readAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read."));
    reader.readAsDataURL(file);
  });

/** Whether a statement may be imported as it stands. */
export const statementReady = (statement: PreviewStatement): boolean =>
  statement.match !== null && statement.problems.length === 0 && statement.alreadyStored === null && statement.repeatedRows === 0;

/** One import, for the ledger it was opened from: customers or suppliers. */
export function useArchiveImport(side: LedgerArchiveSide = "CUSTOMER") {
  const api = useDesktopApi();
  const [phase, setPhase] = useState<ImportPhase>("choose");
  const [file, setFile] = useState<ChosenFile | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [choices, setChoices] = useState<Record<number, string>>({});
  const [source, setSource] = useState<SourceDocument | null>(null);
  const [batchId, setBatchId] = useState<string>(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);

  const runPreview = useCallback(
    async (chosen: ChosenFile, partyIds: Record<number, string>) => {
      const reply = readImportPreview(
        await api.previewLedgerArchive({ side, fileHash: chosen.hash, statements: chosen.statements.map((rows, index) => ({ rows, partyId: partyIds[index] })) })
      );
      if (!reply.ok) throw new Error(reply.reason ?? "The file could not be checked.");
      setPreview(reply.value);
    },
    [api, side]
  );

  const chooseCsv = useCallback(
    async (picked: File) => {
      setPhase("reading");
      setError(null);
      try {
        const sheet = await readSheetFile(picked);
        const chosen = { name: picked.name, hash: await sha256Hex(picked), statements: groupArchiveRows(ledgerArchiveRowsOf(sheet.headers, sheet.rows)) };
        setFile(chosen);
        setChoices({});
        setBatchId(crypto.randomUUID());
        await runPreview(chosen, {});
        setPhase("preview");
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "The file could not be read.");
        setPhase("choose");
      }
    },
    [runPreview]
  );

  const chooseCustomer = useCallback(
    async (index: number, partyId: string) => {
      if (!file) return;
      const next = { ...choices, [index]: partyId };
      setChoices(next);
      try {
        await runPreview(file, next);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "The file could not be checked.");
      }
    },
    [choices, file, runPreview]
  );

  const attachPdf = useCallback(
    async (picked: File) => {
      setError(null);
      const reply = readSourceDocument(await api.attachLedgerArchiveSource({ name: picked.name, dataUrl: await readAsDataUrl(picked) }));
      if (reply.ok) setSource(reply.value);
      else setError(reply.reason ?? "The PDF could not be kept.");
    },
    [api]
  );

  const confirm = useCallback(async () => {
    if (!file || !preview) return;
    const ready = preview.statements.map((statement, index) => ({ statement, index })).filter(({ statement }) => statementReady(statement));
    setPhase("importing");
    setError(null);
    const statements = ready.map(({ statement, index }) => ({ partyId: statement.match?.partyId, rows: file.statements[index], sourceDocument: source }));
    const reply = readImportOutcome(await api.importLedgerArchive({ side, batchId, fileName: file.name, fileHash: file.hash, statements }).catch(() => null));
    if (reply.ok) {
      setOutcome(reply.value);
      setPhase("done");
    } else {
      setError(reply.reason ?? "Nothing was imported. Try again.");
      setPhase("preview");
    }
  }, [api, batchId, file, preview, side, source]);

  const readyCount = preview && !preview.alreadyImported ? preview.statements.filter(statementReady).length : 0;
  return { phase, file, preview, choices, source, error, outcome, readyCount, chooseCsv, chooseCustomer, attachPdf, confirm };
}

export type ArchiveImport = ReturnType<typeof useArchiveImport>;
