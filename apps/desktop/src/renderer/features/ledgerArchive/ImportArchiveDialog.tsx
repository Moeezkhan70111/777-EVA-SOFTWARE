import React from "react";
import { LEDGER_ARCHIVE_COLUMNS, type LedgerArchiveSide } from "@erp/domain";
import { Modal } from "../../components/shared/Modal";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import type { Party } from "../../types/desktopApi";
import { downloadCsv } from "../../utils/exportFile";
import { ArchivePreviewTable } from "./ArchivePreviewTable";
import { useArchiveImport } from "./useArchiveImport";

// Customer Ledger or Supplier Ledger > Import old ledger (docs/50, 53). Choose the CSV (and, if there is one, the
// original PDF), check each party, import. Every step says what it found; nothing is imported until the person
// confirms.

const text = copy.ledgerArchive;

/** A blank file with the import's columns and one example row, to fill in from the old software's ledger. */
const downloadTemplate = (side: LedgerArchiveSide) =>
  downloadCsv(side === "SUPPLIER" ? "supplier-ledger-import-template" : "ledger-import-template", {
    headers: [...LEDGER_ARCHIVE_COLUMNS],
    rows: [[...text.side[side].templateRow]],
  });

const FilePick: React.FC<{ label: string; ariaLabel: string; accept: string; disabled?: boolean; onPick: (file: File) => void }> = ({ label, ariaLabel, accept, disabled, onPick }) => (
  <label className={`customer-ledger-print ledger-import-pick${disabled ? " is-disabled" : ""}`}>
    {label}
    <input
      type="file"
      accept={accept}
      aria-label={ariaLabel}
      disabled={disabled}
      onChange={(event) => {
        const picked = event.target.files?.[0];
        event.target.value = "";
        if (picked) onPick(picked);
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
        <FilePick label={text.chooseCsv} ariaLabel={text.chooseCsvLabel} accept=".csv,.txt,text/csv" disabled={busy} onPick={(file) => void flow.chooseCsv(file)} />
        <FilePick label={text.attachPdf} ariaLabel={text.attachPdfLabel} accept="application/pdf,.pdf" disabled={busy} onPick={(file) => void flow.attachPdf(file)} />
        <button type="button" className="customer-ledger-print" onClick={() => downloadTemplate(side)}>{text.template}</button>
      </div>
      {flow.file && <p className="ledger-import-file">{flow.file.name}</p>}
      {flow.source && <p className="ledger-import-file">{text.pdfAttached(flow.source.name)}</p>}
      {flow.error && <p className="ledger-import-error" role="alert">⚠ {flow.error}</p>}
      {flow.phase === "reading" && <StateView kind="loading" compact message={text.reading} />}
      {flow.preview?.alreadyImported && (
        <p className="ledger-import-error" role="alert">✕ {text.fileAlreadyImported(flow.preview.alreadyImported.fileName, flow.preview.alreadyImported.importedBy)}</p>
      )}
      {flow.preview && flow.phase !== "reading" && flow.phase !== "done" && (
        <>
          <ArchivePreviewTable preview={flow.preview} customers={customers} side={side} choices={flow.choices} onChoose={(index, partyId) => void flow.chooseCustomer(index, partyId)} />
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
