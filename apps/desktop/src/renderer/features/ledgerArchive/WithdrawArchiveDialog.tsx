import React from "react";
import { Modal } from "../../components/shared/Modal";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { formatDate, formatDateTime } from "../../utils/dates";
import type { ArchiveStatement } from "./archiveReplies";
import { archiveAmount } from "./ArchivedLedgerRow";
import { useWithdrawArchive } from "./useWithdrawArchive";

// Customer Ledger or Supplier Ledger > the old software's figures > Withdraw import (docs/53). An administrator's:
// every statement one import wrote is listed, a reason is required, and nothing is erased.

const text = copy.ledgerArchive;

const BatchRow: React.FC<{ statement: ArchiveStatement }> = ({ statement }) => (
  <tr>
    <td><strong>{statement.originalPartyName || "-"}</strong><small className="ledger-import-code">{statement.originalPartyCode}</small></td>
    <td>{statement.sourceFileName}</td>
    <td className="amount">{statement.rowCount.toLocaleString("en-US")}</td>
    <td>{formatDate(statement.periodFrom, statement.periodFrom)} – {formatDate(statement.periodTo, statement.periodTo)}</td>
    <td className="amount balance">{archiveAmount(statement.closingBalancePaisa)}</td>
    <td>
      {statement.withdrawnAt && statement.withdrawnBy
        ? <span className="ledger-import-status ledger-import-status--warn">{text.withdrawnAlready(statement.withdrawnBy, formatDateTime(statement.withdrawnAt))}</span>
        : <small>{statement.importedBy} · {formatDateTime(statement.importedAt)}</small>}
    </td>
  </tr>
);

const BatchTable: React.FC<{ statements: readonly ArchiveStatement[] }> = ({ statements }) => (
  <div className="ledger-import-table-wrap">
    <table className="customer-ledger-table ledger-import-table" aria-label={text.withdrawBatch}>
      <thead>
        <tr>
          <th>{text.side.CUSTOMER.reportParty} / {text.side.SUPPLIER.reportParty}</th><th>{text.fileColumn}</th><th className="amount">{text.rowsColumn}</th>
          <th>{text.periodColumn}</th><th className="amount">{text.closingColumn}</th><th>{text.statusColumn}</th>
        </tr>
      </thead>
      <tbody>{statements.map((statement) => <BatchRow key={statement.id} statement={statement} />)}</tbody>
    </table>
  </div>
);

export const WithdrawArchiveDialog: React.FC<{ batchId: string; onWithdrawn: () => void; onClose: () => void }> = ({ batchId, onWithdrawn, onClose }) => {
  const flow = useWithdrawArchive(batchId);
  // The ledger reloads once the dialog closes, so the result stays on screen until then.
  const close = () => {
    if (flow.outcome) onWithdrawn();
    onClose();
  };
  const ready = flow.batch.status === "ready" && flow.batch.statements.length > 0 && !flow.outcome;
  // After Modal's own Cancel. Nothing once withdrawn.
  const footer = flow.outcome ? null : (
    <button type="button" className="customer-ledger-action" disabled={!ready || flow.saving} onClick={() => void flow.submit()}>{flow.saving ? text.withdrawing : text.withdrawConfirm}</button>
  );
  return (
    <Modal title={text.withdrawTitle} subtitle={text.withdrawIntro} footer={footer} wide="xl" onClose={close}>
      {flow.batch.status === "loading" && <StateView kind="loading" compact message={text.batchLoading} />}
      {flow.batch.status === "error" && <StateView kind="error" compact title={text.batchFailed} message={flow.batch.reason ?? undefined} onRetry={flow.reload} />}
      {flow.batch.status === "ready" && flow.batch.statements.length === 0 && <StateView kind="empty" compact title={text.batchFailed} />}
      {flow.batch.status === "ready" && flow.batch.statements.length > 0 && <BatchTable statements={flow.batch.statements} />}
      {ready && (
        <div className="opening-balance-field">
          <label htmlFor="withdraw-reason">{text.withdrawReasonLabel}</label>
          <input id="withdraw-reason" value={flow.reason} maxLength={500} placeholder={text.withdrawReasonPlaceholder} onChange={(event) => flow.setReason(event.target.value)} />
        </div>
      )}
      {flow.refusal && <p className="ledger-import-error" role="alert">✕ {flow.refusal}</p>}
      {flow.outcome && (
        <div className="ledger-import-done" role="status">
          <strong>{text.withdrawnTitle}</strong>
          <p>{text.withdrawnBody(flow.outcome.statements)}</p>
        </div>
      )}
    </Modal>
  );
};
