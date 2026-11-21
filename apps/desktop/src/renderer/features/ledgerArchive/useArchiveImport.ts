import { useCallback, useState } from "react";
import type { LedgerArchiveSide } from "@erp/domain";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import {
  readImportOutcome,
  readImportPreview,
  readSourceDocument,
  type ImportOutcome,
  type ImportPreview,
  type SourceDocument,
} from "./archiveReplies";
import { batchFileOf, readImportSession, statementInput, statementReady, withReadNotes, type ImportSession } from "./importSession";

// THE IMPORT, STEP BY STEP (docs/50, 53): choose one or several files (the previous software's .xls reports, customers
// and suppliers mixed, or template CSVs) → each is read, split by party and checked by the main process → each party
// is matched (or chosen) → only statements with no problem are imported, all in one go, under one batch id that a
// retry reuses. Nothing here decides whether a row is valid: the domain rules do, again, in the main process.

export { statementReady } from "./importSession";

export type ImportPhase = "choose" | "reading" | "preview" | "importing" | "done";

const readAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read."));
    reader.readAsDataURL(file);
  });

const errorText = (caught: unknown, fallback: string): string => (caught instanceof Error ? caught.message : fallback);

/** The ready statements, as the import sends them. One PDF belongs to one file: attached only to a lone file's import. */
function readyStatements(session: ImportSession, preview: ImportPreview, source: SourceDocument | null) {
  const pdf = session.files.length === 1 ? source : null;
  return preview.statements.flatMap((statement, index) => {
    const chosen = session.statements[index];
    return chosen && statementReady(statement) ? [{ ...statementInput(chosen, statement.match?.partyId), sourceDocument: pdf }] : [];
  });
}

/** One import, opened from a ledger: customers or suppliers. `side` is used only for a template CSV. */
export function useArchiveImport(side: LedgerArchiveSide = "CUSTOMER") {
  const api = useDesktopApi();
  const [phase, setPhase] = useState<ImportPhase>("choose");
  const [session, setSession] = useState<ImportSession | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [choices, setChoices] = useState<Record<number, string>>({});
  const [source, setSource] = useState<SourceDocument | null>(null);
  const [batchId, setBatchId] = useState<string>(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);

  const runPreview = useCallback(
    async (chosen: ImportSession, partyIds: Record<number, string>) => {
      // The batch-level "already imported" check is for a single file; with several, each statement says its own.
      const fileHash = chosen.files.length === 1 ? (chosen.files[0]?.hash ?? "") : "";
      const statements = chosen.statements.map((statement, index) => statementInput(statement, partyIds[index]));
      const reply = readImportPreview(await api.previewLedgerArchive({ side, fileHash, statements }));
      if (!reply.ok) throw new Error(reply.reason ?? "The files could not be checked.");
      setPreview(withReadNotes(reply.value, chosen));
    },
    [api, side]
  );

  const chooseFiles = useCallback(
    async (picked: readonly File[]) => {
      if (picked.length === 0) return;
      setPhase("reading");
      setError(null);
      setPreview(null);
      try {
        const chosen = await readImportSession(picked, side);
        setSession(chosen);
        setChoices({});
        setSource(null);
        setBatchId(crypto.randomUUID());
        if (chosen.statements.length > 0) await runPreview(chosen, {});
        setPhase(chosen.statements.length > 0 ? "preview" : "choose");
      } catch (caught) {
        setError(errorText(caught, "The files could not be read."));
        setPhase("choose");
      }
    },
    [runPreview, side]
  );

  const chooseCustomer = useCallback(
    async (index: number, partyId: string) => {
      if (!session) return;
      const next = { ...choices, [index]: partyId };
      setChoices(next);
      try {
        await runPreview(session, next);
      } catch (caught) {
        setError(errorText(caught, "The files could not be checked."));
      }
    },
    [choices, session, runPreview]
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
    if (!session || !preview) return;
    setPhase("importing");
    setError(null);
    const file = batchFileOf(session);
    const statements = readyStatements(session, preview, source);
    const reply = readImportOutcome(await api.importLedgerArchive({ side, batchId, fileName: file.name, fileHash: file.hash, statements }).catch(() => null));
    if (reply.ok) {
      setOutcome(reply.value);
      setPhase("done");
    } else {
      setError(reply.reason ?? "Nothing was imported. Try again.");
      setPhase("preview");
    }
  }, [api, batchId, session, preview, side, source]);

  const readyCount = preview && !preview.alreadyImported ? preview.statements.filter(statementReady).length : 0;
  return { phase, session, preview, choices, source, error, outcome, readyCount, chooseFiles, chooseCustomer, attachPdf, confirm };
}

export type ArchiveImport = ReturnType<typeof useArchiveImport>;
