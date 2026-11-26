import React, { useState } from "react";
import { PERMISSION, type LedgerSide } from "@erp/domain";
import { ActionMenu, type ActionMenuGroup } from "../../components/shared/ActionMenu";
import { copy } from "../../config/copy";
import { useSession } from "../auth/SessionContext";
import type { Party } from "../../types/desktopApi";
import { BulkOpeningBalanceDialog } from "./BulkOpeningBalanceDialog";
import { ImportArchiveDialog } from "./ImportArchiveDialog";
import { ReconciliationDialog } from "./ReconciliationDialog";

// The ledger header's history actions, the same on the Customer and the Supplier Ledger (docs/50, 53): download the
// ledger as a spreadsheet or a PDF, import an old ledger (accounts users), open the reconciliation, and post every
// party's opening balance at a cutover date (administrators).
//
// GROUPED (the Customer Ledger, 24 Nov 2026, Hick's law): the same actions as two menus, Download and Old software,
// so the header offers two choices instead of five. The dialogs are the same either way. It offers no bulk opening
// balance: on the Customer Ledger the imported old ledger is already in the balance (owner, 25 Nov 2026: old + new).

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
  /** Two menus instead of five buttons. */
  grouped?: boolean;
  /** Opens the imported ledgers' files, from the Old ledgers menu (owner, 26 Nov 2026); its hint says how many. */
  onShowImported?: () => void;
  importedHint?: string;
}

export const LedgerHistoryActions: React.FC<Props> = ({ side, parties, noParty, making, onDownloadExcel, onDownloadPdf, onImported, grouped = false, onShowImported, importedHint }) => {
  const { can, isAdmin } = useSession();
  const [bulk, setBulk] = useState(false);
  const [importing, setImporting] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const dialogs = (
    <>
      {bulk && <BulkOpeningBalanceDialog side={side} onPosted={onImported} onClose={() => setBulk(false)} />}
      {importing && <ImportArchiveDialog customers={parties} side={side} onClose={() => { setImporting(false); onImported(); }} />}
      {reconciling && <ReconciliationDialog side={side} onClose={() => setReconciling(false)} />}
    </>
  );
  if (grouped) {
    const words = copy.customerLedger;
    const downloads: ActionMenuGroup[] = [{ label: words.downloadGroup, items: [
      { id: "excel", label: text.downloadExcel, onSelect: onDownloadExcel, disabled: noParty },
      { id: "pdf", label: text.downloadPdf, onSelect: onDownloadPdf, disabled: noParty || making },
    ] }];
    const history: ActionMenuGroup[] = [{ label: words.historyGroup, items: [
      ...(onShowImported ? [{ id: "imported", label: words.historyTitle, hint: importedHint, onSelect: onShowImported, disabled: noParty }] : []),
      ...(can(PERMISSION.CASH_VOUCHER_FORM) ? [{ id: "import", label: text.importOld, onSelect: () => setImporting(true) }] : []),
      { id: "reconcile", label: copy.openingBalance.reconciliation, onSelect: () => setReconciling(true) },
    ] }];
    return (
      <>
        <ActionMenu label={words.historyMenu} groups={history} />
        <ActionMenu label={words.downloadMenu} groups={downloads} />
        {dialogs}
      </>
    );
  }
  return (
    <>
      <div className="ledger-download-actions" role="group" aria-label={text.downloadsLabel}>
        <button type="button" className="customer-ledger-action" onClick={onDownloadExcel} disabled={noParty}>⇩ <span>{text.downloadExcel}</span></button>
        <button type="button" className="customer-ledger-action" onClick={onDownloadPdf} disabled={noParty || making}>⇩ <span>{text.downloadPdf}</span></button>
      </div>
      {can(PERMISSION.CASH_VOUCHER_FORM) && <button type="button" className="customer-ledger-print" onClick={() => setImporting(true)}>{text.importOld}</button>}
      <button type="button" className="customer-ledger-print" onClick={() => setReconciling(true)}>{copy.openingBalance.reconciliation}</button>
      {isAdmin && <button type="button" className="customer-ledger-print" onClick={() => setBulk(true)}>{copy.openingBalance.bulkOpen}</button>}
      {dialogs}
    </>
  );
};
