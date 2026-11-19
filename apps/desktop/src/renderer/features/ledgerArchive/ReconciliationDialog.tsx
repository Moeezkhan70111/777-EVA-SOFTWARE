import React, { useCallback, useEffect, useState } from "react";
import { fromPaisa, type LedgerSide, type ReconciliationStatus } from "@erp/domain";
import { Modal } from "../../components/shared/Modal";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { formatDate, formatDateTime } from "../../utils/dates";
import { downloadCsv } from "../../utils/exportFile";
import { archiveAmount } from "./ArchivedLedgerRow";
import { readReconciliation, type ReconciliationRow } from "./openingBalanceReplies";

// THE LEDGER RECONCILIATION (docs/53): every customer's or supplier's archived ledger beside the opening balance
// posted in the ERP, and the difference. Read only: nothing here changes either figure. A status is said in words
// with a mark (✓ ⚠ ✕), never by colour alone.

const text = copy.openingBalance;
const columns = text.columns;
const TONE: Record<ReconciliationStatus, "ok" | "warn" | "err"> = { MATCHED: "ok", DIFFERENT: "warn", NO_OPENING_BALANCE: "warn", NO_ARCHIVE: "warn", ARCHIVE_BROKEN: "err" };

type State = { status: "loading" } | { status: "error"; reason: string | null } | { status: "ready"; rows: ReconciliationRow[] };

const amount = (paisa: number | null): string => (paisa === null ? "-" : archiveAmount(paisa));
const rupees = (paisa: number | null): number | null => (paisa === null ? null : fromPaisa(paisa));

function download(side: LedgerSide, rows: readonly ReconciliationRow[]): void {
  const name = side === "CUSTOMER" ? "Customer" : "Supplier";
  downloadCsv(text.fileName(name), {
    preamble: [text.sheetTitle(name), `${formatDateTime(new Date())}`, text.signNote],
    headers: [columns.party, columns.oldCode, columns.statements, columns.archiveOpening, columns.debit, columns.credit, columns.archiveClosing, columns.opening, text.dateLabel, columns.difference, columns.live, columns.status, "Notes"],
    rows: rows.map((row) => [
      row.partyName, row.originalPartyCode, row.statementCount, rupees(row.archiveOpeningPaisa), fromPaisa(row.archiveDebitPaisa), fromPaisa(row.archiveCreditPaisa),
      rupees(row.archiveClosingPaisa), rupees(row.openingPaisa), row.openingEffectiveDate ?? "", rupees(row.differencePaisa), rupees(row.liveBalancePaisa), text.status[row.status], row.notes.join(" "),
    ]),
  });
}

const Row: React.FC<{ row: ReconciliationRow }> = ({ row }) => (
  <tr>
    <td><strong>{row.partyName}</strong>{row.partyCode && <small className="ledger-import-code">{row.partyCode}</small>}</td>
    <td>{row.originalPartyCode || "-"}</td>
    <td className="amount">{row.statementCount}</td>
    <td className="amount">{amount(row.archiveOpeningPaisa)}</td>
    <td className="amount debit">{archiveAmount(row.archiveDebitPaisa)}</td>
    <td className="amount credit">{archiveAmount(row.archiveCreditPaisa)}</td>
    <td className="amount balance">{amount(row.archiveClosingPaisa)}{row.archiveTo && <small className="ledger-import-code">{formatDate(row.archiveTo, row.archiveTo)}</small>}</td>
    <td className="amount">{amount(row.openingPaisa)}{row.openingEffectiveDate && <small className="ledger-import-code">{formatDate(row.openingEffectiveDate, row.openingEffectiveDate)}</small>}</td>
    <td className={`amount${row.differencePaisa ? " reconciliation-difference" : ""}`}>{amount(row.differencePaisa)}</td>
    <td className="amount">{amount(row.liveBalancePaisa)}</td>
    <td>
      <span className={`ledger-import-status ledger-import-status--${TONE[row.status]}`}>{text.status[row.status]}</span>
      {row.notes.length > 0 && <details className="ledger-import-details"><summary>{row.notes.length}</summary><ul>{row.notes.map((note) => <li key={note}>{note}</li>)}</ul></details>}
    </td>
  </tr>
);

export const ReconciliationDialog: React.FC<{ side: LedgerSide; onClose: () => void }> = ({ side, onClose }) => {
  const api = useDesktopApi();
  const [state, setState] = useState<State>({ status: "loading" });
  const load = useCallback(() => {
    setState({ status: "loading" });
    api.getLedgerReconciliation(side)
      .then((raw) => {
        const reply = readReconciliation(raw);
        setState(reply.ok ? { status: "ready", rows: reply.value } : { status: "error", reason: reply.reason });
      })
      .catch(() => setState({ status: "error", reason: null }));
  }, [api, side]);
  useEffect(load, [load]);

  const footer = state.status === "ready" && state.rows.length > 0 ? <button type="button" className="customer-ledger-action" onClick={() => download(side, state.rows)}>⇩ {text.download}</button> : null;
  return (
    <Modal title={text.reportTitle[side]} subtitle={`${text.reportIntro} ${text.signNote}`} onClose={onClose} footer={footer} wide="xl">
      {state.status === "loading" && <StateView kind="loading" compact message={copy.common.loading} />}
      {state.status === "error" && <StateView kind="error" compact title={text.reportFailed} message={state.reason ?? undefined} onRetry={load} />}
      {state.status === "ready" && state.rows.length === 0 && <StateView kind="empty" compact title={text.reportEmpty} hint={text.reportEmptyHint} />}
      {state.status === "ready" && state.rows.length > 0 && (
        <div className="ledger-import-table-wrap">
          <table className="customer-ledger-table ledger-import-table">
            <thead>
              <tr>
                <th>{columns.party}</th><th>{columns.oldCode}</th><th className="amount">{columns.statements}</th><th className="amount">{columns.archiveOpening}</th>
                <th className="amount">{columns.debit}</th><th className="amount">{columns.credit}</th><th className="amount">{columns.archiveClosing}</th>
                <th className="amount">{columns.opening}</th><th className="amount">{columns.difference}</th><th className="amount">{columns.live}</th><th>{columns.status}</th>
              </tr>
            </thead>
            <tbody>{state.rows.map((row) => <Row key={row.partyId} row={row} />)}</tbody>
          </table>
        </div>
      )}
    </Modal>
  );
};
