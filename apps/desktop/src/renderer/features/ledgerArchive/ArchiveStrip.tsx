import React, { useState } from "react";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useOptionalNotifications } from "../../state/NotificationsContext";
import { formatDate, formatDateTime } from "../../utils/dates";
import { readPlainReply, type ArchiveStatement } from "./archiveReplies";
import { archiveAmount } from "./ArchivedLedgerRow";
import type { ArchiveState } from "./useLedgerArchive";
import type { ArchiveSummary } from "./unifiedLedger";
import { useSession } from "../auth/SessionContext";
import { WithdrawArchiveDialog } from "./WithdrawArchiveDialog";

// The old software's figures for the period, beside the live ones and plainly not part of them (docs/50): what its
// rows add up to, the last balance it printed, and the files they came from. Shown only when there is an archive.
// An administrator may withdraw an import from here (docs/53): every statement it wrote, kept but out of the ledgers.

const text = copy.ledgerArchive;

const Figure: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="ledger-archive-figure">
    <span>{label}</span>
    <strong>{value}</strong>
  </div>
);

const SourceLink: React.FC<{ statement: ArchiveStatement }> = ({ statement }) => {
  const api = useDesktopApi();
  const notices = useOptionalNotifications();
  const name = statement.sourceDocumentName;
  const hash = statement.sourceDocumentHash;
  if (!name || !hash) return <span>{text.sourceFile(statement.sourceFileName)}</span>;
  const open = async () => {
    const reply = readPlainReply(await api.openLedgerArchiveSource(hash));
    if (!reply.ok) notices?.push("warning", text.openPdf(name), reply.reason ?? text.failed);
  };
  return (
    <button type="button" className="ledger-archive-source" onClick={() => void open()}>
      {text.openPdf(name)}
    </button>
  );
};

export const ArchiveStrip: React.FC<{ state: ArchiveState; summary: ArchiveSummary; statements: readonly ArchiveStatement[]; onRetry: () => void }> = ({
  state,
  summary,
  statements,
  onRetry,
}) => {
  if (state.status === "loading") return <p className="ledger-archive-strip ledger-archive-note" role="status">{text.loading}</p>;
  if (state.status === "error") {
    return (
      <div className="ledger-archive-strip ledger-archive-note" role="alert">
        <span>⚠ {state.reason ?? text.failed}</span>
        <button type="button" className="customer-ledger-print" onClick={onRetry}>{text.retry}</button>
      </div>
    );
  }
  if (statements.length === 0) return null;
  return <ArchiveFigures summary={summary} statements={statements} onWithdrawn={onRetry} />;
};

/** One button per import the shown statements came from: an import is withdrawn whole. */
const WithdrawButtons: React.FC<{ statements: readonly ArchiveStatement[]; onWithdrawn: () => void }> = ({ statements, onWithdrawn }) => {
  const { isAdmin } = useSession();
  const [batchId, setBatchId] = useState<string | null>(null);
  if (!isAdmin) return null;
  // The first statement shown from each import names it: its file and when it came in.
  const batches = [...new Map(statements.map((statement) => [statement.batchId, statement])).values()];
  return (
    <>
      {batches.map((first) => (
        <button key={first.batchId} type="button" className="customer-ledger-print" onClick={() => setBatchId(first.batchId)}>
          {text.withdrawOpen(first.sourceFileName, formatDateTime(first.importedAt))}
        </button>
      ))}
      {batchId && <WithdrawArchiveDialog batchId={batchId} onWithdrawn={onWithdrawn} onClose={() => setBatchId(null)} />}
    </>
  );
};

const ArchiveFigures: React.FC<{ summary: ArchiveSummary; statements: readonly ArchiveStatement[]; onWithdrawn: () => void }> = ({ summary, statements, onWithdrawn }) => {
  return (
    <section className="ledger-archive-strip" aria-label={text.stripTitle}>
      <div className="ledger-archive-heading">
        <strong>{text.stripTitle}</strong>
        <span>{text.statementCount(statements.length)} · {text.stripNote}</span>
      </div>
      <div className="ledger-archive-figures">
        <Figure label={text.debit} value={`Rs. ${archiveAmount(summary.debitPaisa)}`} />
        <Figure label={text.credit} value={`Rs. ${archiveAmount(summary.creditPaisa)}`} />
        <Figure label={text.quantity} value={summary.quantity.toLocaleString("en-US")} />
        {summary.lastBalancePaisa !== null && summary.lastDate !== null && (
          <Figure label={text.lastBalance(formatDate(summary.lastDate, summary.lastDate))} value={`Rs. ${archiveAmount(summary.lastBalancePaisa)}`} />
        )}
      </div>
      <div className="ledger-archive-sources">
        {statements.map((statement) => <SourceLink key={statement.id} statement={statement} />)}
        <WithdrawButtons statements={statements} onWithdrawn={onWithdrawn} />
      </div>
    </section>
  );
};
