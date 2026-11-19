import React from "react";
import { fromPaisa } from "@erp/domain";
import { copy } from "../../config/copy";
import { formatMoney, formatWholeMoney } from "../../app/format";
import { formatDate } from "../../utils/dates";
import type { ArchiveEntry } from "./archiveReplies";
import { archiveTypeLabel } from "./unifiedLedger";

// One archived row of the old software's ledger, in the ledger's own table and columns (docs/50, 53): the Customer
// Ledger's twelve, or the Supplier Ledger's seven (compact). Marked "Archived" in words, not by colour alone, and its
// balance is the one the old software printed.

const text = copy.ledgerArchive;

/** Whole rupees, as the ledger shows them, unless the old software printed paisa. */
export const archiveAmount = (paisa: number): string => (paisa % 100 === 0 ? formatWholeMoney(fromPaisa(paisa)) : formatMoney(fromPaisa(paisa)));

const orDash = (paisa: number): string => (paisa === 0 ? "-" : archiveAmount(paisa));

export const ArchivedTag: React.FC = () => (
  <span className="ledger-archived-tag" title={text.archivedTitle}>
    {text.archived}
  </span>
);

const TypeCell: React.FC<{ entry: ArchiveEntry }> = ({ entry }) => (
  <span className="customer-ledger-type customer-ledger-type-archived">
    <span className="customer-ledger-type-dot" />
    {entry.transactionType ? archiveTypeLabel(entry.transactionType) : "-"}
  </span>
);

/** The Supplier Ledger's columns: date, number, type, description (with the bill number), debit, credit, balance. */
const CompactArchivedRow: React.FC<{ entry: ArchiveEntry }> = ({ entry }) => (
  <tr className="customer-ledger-row ledger-archived-row" aria-label={`${text.archived}: ${entry.description}`}>
    <td>{formatDate(entry.entryDate, entry.originalDateText)}</td>
    <td>{entry.voucherNumber || "-"}</td>
    <td><TypeCell entry={entry} /> <ArchivedTag /></td>
    <td className="ledger-archived-desc">{entry.billNumber ? `${text.billNo} ${entry.billNumber} · ` : ""}{entry.description}</td>
    <td className="amount">{orDash(entry.debitPaisa)}</td>
    <td className="amount">{orDash(entry.creditPaisa)}</td>
    <td className="amount balance ledger-archived-balance" title={text.archivedBalanceNote}>{archiveAmount(entry.balancePaisa)}</td>
  </tr>
);

export const ArchivedLedgerRow: React.FC<{ entry: ArchiveEntry; compact?: boolean }> = ({ entry, compact = false }) => compact ? <CompactArchivedRow entry={entry} /> : (
  <tr className="customer-ledger-row ledger-archived-row" aria-label={`${text.archived}: ${entry.description}`}>
    <td>{formatDate(entry.entryDate, entry.originalDateText)}</td>
    <td>{entry.voucherNumber || "-"}</td>
    <td>
      <span className="customer-ledger-type customer-ledger-type-archived">
        <span className="customer-ledger-type-dot" />
        {entry.transactionType ? archiveTypeLabel(entry.transactionType) : "-"}
      </span>
    </td>
    <td>{entry.billNumber || "-"}</td>
    <td className="ledger-archived-desc">{entry.description}</td>
    <td className="amount">{entry.quantityText || "-"}</td>
    <td className="amount">-</td>
    <td className="amount">-</td>
    <td className="amount debit">{orDash(entry.debitPaisa)}</td>
    <td className="amount credit">{orDash(entry.creditPaisa)}</td>
    <td className="amount balance ledger-archived-balance" title={text.archivedBalanceNote}>
      {archiveAmount(entry.balancePaisa)}
    </td>
    <td>
      <ArchivedTag />
    </td>
  </tr>
);
