import React, { useState } from "react";
import { PERMISSION, type LedgerSide } from "@erp/domain";
import { copy } from "../../config/copy";
import { useSession } from "../auth/SessionContext";
import type { Party } from "../../types/desktopApi";
import { BulkOpeningBalanceDialog } from "./BulkOpeningBalanceDialog";
import { ImportArchiveDialog } from "./ImportArchiveDialog";
import { ReconciliationDialog } from "./ReconciliationDialog";

// The ledger header's history actions, the same on the Customer and the Supplier Ledger (docs/50, 53): download the
// ledger as a spreadsheet or a PDF, import an old ledger (accounts users), open the reconciliation, and post every
// party's opening balance at a cutover date (administrators).

const text = copy.ledgerArchive;

interface Props {
  side: LedgerSide;
  /** The parties an import can match: this ledger's customers or suppliers. */
  parties: readonly Party[];
  /** No party chosen yet: nothing to download. */
  noParty: boolean;
  making: boolean;
  onDownloadExcel: () => void;
  onDownloadPdf: () => void;
  /** After an import or a bulk posting closes: reload the archive and the opening balance. */
  onImported: () => void;
}

export const LedgerHistoryActions: React.FC<Props> = ({ side, parties, noParty, making, onDownloadExcel, onDownloadPdf, onImported }) => {
  const { can, isAdmin } = useSession();
  const [bulk, setBulk] = useState(false);
  const [importing, setImporting] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  return (
    <>
      <div className="ledger-download-actions" role="group" aria-label={text.downloadsLabel}>
        <button type="button" className="customer-ledger-action" onClick={onDownloadExcel} disabled={noParty}>⇩ <span>{text.downloadExcel}</span></button>
        <button type="button" className="customer-ledger-action" onClick={onDownloadPdf} disabled={noParty || making}>⇩ <span>{text.downloadPdf}</span></button>
      </div>
      {can(PERMISSION.CASH_VOUCHER_FORM) && <button type="button" className="customer-ledger-print" onClick={() => setImporting(true)}>{text.importOld}</button>}
      <button type="button" className="customer-ledger-print" onClick={() => setReconciling(true)}>{copy.openingBalance.reconciliation}</button>
      {isAdmin && <button type="button" className="customer-ledger-print" onClick={() => setBulk(true)}>{copy.openingBalance.bulkOpen}</button>}
      {bulk && <BulkOpeningBalanceDialog side={side} onPosted={onImported} onClose={() => setBulk(false)} />}
      {importing && <ImportArchiveDialog customers={parties} side={side} onClose={() => { setImporting(false); onImported(); }} />}
      {reconciling && <ReconciliationDialog side={side} onClose={() => setReconciling(false)} />}
    </>
  );
};
