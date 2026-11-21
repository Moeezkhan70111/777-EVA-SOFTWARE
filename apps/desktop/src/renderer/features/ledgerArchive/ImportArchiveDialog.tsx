import React from "react";
import { LEDGER_ARCHIVE_COLUMNS, type LedgerArchiveSide } from "@erp/domain";
import { Modal } from "../../components/shared/Modal";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import type { Party } from "../../types/desktopApi";
import { downloadCsv } from "../../utils/exportFile";
import { ArchivePreviewTable } from "./ArchivePreviewTable";
import { useArchiveImport } from "./useArchiveImport";
import { useImportParties } from "./useImportParties";

// Customer Ledger or Supplier Ledger > Import old ledger (docs/50, 53). Choose the files (the previous software's .xls
// reports, several at once, customers and suppliers mixed; or a template CSV), and, for a lone file, the original PDF.
// Check each party, import. Every step says what it found; nothing is imported until the person
// confirms.

const text = copy.ledgerArchive;

/** A blank file with the import's columns and one example row, to fill in from the old software's ledger. */
const downloadTemplate = (side: LedgerArchiveSide) =>
  downloadCsv(side === "SUPPLIER" ? "supplier-ledger-import-template" : "ledger-import-template", {
    headers: [...LEDGER_ARCHIVE_COLUMNS],
    rows: [[...text.side[side].templateRow]],
  });

const FilePick: React.FC<{ label: string; ariaLabel: string; accept: string; multiple?: boolean; disabled?: boolean; onPick: (files: File[]) => void }> = ({ label, ariaLabel, accept, multiple, disabled, onPick }) => (
  <label className={`customer-ledger-print ledger-import-pick${disabled ? " is-disabled" : ""}`}>
    {label}
    <input
      type="file"
      accept={accept}
      aria-label={ariaLabel}
      multiple={multiple}
      disabled={disabled}
      onChange={(event) => {
        const picked = Array.from(event.target.files ?? []);
        event.target.value = "";
        if (picked.length > 0) onPick(picked);
      }}
    />
  </label>
);

interface Props {
  /** The parties a statement can be matched to: the ledger's own customers or suppliers. */
  customers: readonly Party[];
  side?: LedgerArchiveSide;
  onClose: () => void;
}

export const ImportArchiveDialog: React.FC<Props> = ({ customers, side = "CUSTOMER", onClose }) => {
  const flow = useArchiveImport(side);
  const needsOther = flow.session?.statements.some((statement) => statement.side !== side) ?? false;
  const { parties, failed } = useImportParties(customers, side, needsOther);
  const files = flow.session?.files ?? [];
  const busy = flow.phase === "reading" || flow.phase === "importing";
  const footer =
    flow.phase === "done" ? null : (
      <button type="button" className="customer-ledger-action" disabled={busy || flow.readyCount === 0} onClick={() => void flow.confirm()}>
        {flow.phase === "importing" ? text.importing : text.confirm(flow.readyCount)}
      </button>
    );

  return (
    <Modal title={text.importTitle} subtitle={text.side[side].importIntro} onClose={onClose} footer={footer} wide="xl">
      <div className="ledger-import-actions">
        <FilePick label={text.chooseCsv} ariaLabel={text.chooseCsvLabel} accept=".xls,.xlsx,.csv,.txt" multiple disabled={busy} onPick={(picked) => void flow.chooseFiles(picked)} />
        <FilePick label={text.attachPdf} ariaLabel={text.attachPdfLabel} accept="application/pdf,.pdf" disabled={busy || files.length > 1} onPick={([picked]) => { if (picked) void flow.attachPdf(picked); }} />
        <button type="button" className="customer-ledger-print" onClick={() => downloadTemplate(side)}>{text.template}</button>
      </div>
      {files.length === 1 && <p className="ledger-import-file">{files[0]?.name}</p>}
      {files.length > 1 && <p className="ledger-import-file">{text.filesChosen(files.length)} · {text.pdfOneFileOnly}</p>}
      {(flow.session?.problems.length ?? 0) > 0 && (
        <ul className="ledger-import-error" role="alert">{flow.session?.problems.map((problem) => <li key={problem}>⚠ {problem}</li>)}</ul>
      )}
      {failed && <p className="ledger-import-error" role="alert">⚠ {text.otherPartiesFailed}</p>}
      {flow.source && <p className="ledger-import-file">{text.pdfAttached(flow.source.name)}</p>}
      {flow.error && <p className="ledger-import-error" role="alert">⚠ {flow.error}</p>}
      {flow.phase === "reading" && <StateView kind="loading" compact message={text.reading} />}
      {flow.preview?.alreadyImported && (
        <p className="ledger-import-error" role="alert">✕ {text.fileAlreadyImported(flow.preview.alreadyImported.fileName, flow.preview.alreadyImported.importedBy)}</p>
      )}
      {flow.preview && flow.phase !== "reading" && flow.phase !== "done" && (
        <>
          <ArchivePreviewTable preview={flow.preview} customers={parties} side={side} sources={flow.session?.statements ?? []} showFile={files.length > 1} choices={flow.choices} onChoose={(index, partyId) => void flow.chooseCustomer(index, partyId)} />
          {flow.readyCount === 0 && <p className="ledger-import-note">{text.nothingReady}</p>}
          {flow.readyCount > 0 && flow.readyCount < flow.preview.statements.length && (
            <p className="ledger-import-note">{text.skipped(flow.preview.statements.length - flow.readyCount)}</p>
          )}
        </>
      )}
      {flow.phase === "done" && flow.outcome && (
        <div className="ledger-import-done" role="status">
          <strong>{text.doneTitle}</strong>
          <p>{flow.outcome.duplicate ? text.duplicateBody : text.doneBody(flow.outcome.statements, flow.outcome.rows)}</p>
        </div>
      )}
    </Modal>
  );
};
