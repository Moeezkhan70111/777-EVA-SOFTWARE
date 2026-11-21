import React from "react";
import type { LedgerSide, OpeningBalanceDirection } from "@erp/domain";
import { Modal } from "../../components/shared/Modal";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { formatDate } from "../../utils/dates";
import { archiveAmount } from "./ArchivedLedgerRow";
import type { BulkProposal } from "./bulkOpeningReplies";
import { useBulkOpeningBalances, type BulkOpeningFlow } from "./useBulkOpeningBalances";

// Ledger > Reconciliation > Post opening balances (docs/53). An administrator's. Every party with an archive, its
// balance at the cutover in the ledger's own words, a box to choose it, and the reason any party is left out. Nothing
// is posted until the person confirms, and then all the chosen ones together.

const text = copy.openingBalance;
const columns = text.bulkColumns;

const ProposalRow: React.FC<{ side: LedgerSide; proposal: BulkProposal; chosen: boolean; onToggle: () => void }> = ({ side, proposal, chosen, onToggle }) => {
  const ready = proposal.status === "READY";
  const short: Record<OpeningBalanceDirection, string> = text.short[side];
  const notes = ready ? proposal.warnings : [proposal.skipReason ?? "", ...proposal.warnings].filter(Boolean);
  return (
    <tr>
      <td>{ready && <input type="checkbox" checked={chosen} aria-label={text.bulkChoose(proposal.partyName)} onChange={onToggle} />}</td>
      <td><strong>{proposal.partyName}</strong>{proposal.partyCode && <small className="ledger-import-code">{proposal.partyCode}</small>}</td>
      <td>{proposal.originalPartyCode || "-"}</td>
      <td>{proposal.balanceAsOf ? formatDate(proposal.balanceAsOf, proposal.balanceAsOf) : "-"}</td>
      <td>{proposal.direction ? short[proposal.direction] : "-"}</td>
      <td className="amount balance">{proposal.amountPaisa === null ? "-" : archiveAmount(proposal.amountPaisa)}</td>
      <td>
        <span className={`ledger-import-status ledger-import-status--${ready ? (proposal.warnings.length > 0 ? "warn" : "ok") : "warn"}`}>{ready ? text.bulkReady : text.bulkSkip}</span>
        {notes.length > 0 && <ul className="ledger-import-notes">{notes.map((note) => <li key={note}>{note}</li>)}</ul>}
      </td>
    </tr>
  );
};

const ProposalTable: React.FC<{ side: LedgerSide; flow: BulkOpeningFlow; proposals: readonly BulkProposal[] }> = ({ side, flow, proposals }) => (
  <div className="ledger-import-table-wrap">
    <table className="customer-ledger-table ledger-import-table">
      <thead>
        <tr>
          <th>{columns.choose}</th><th>{columns.party}</th><th>{columns.oldCode}</th><th>{columns.asOf}</th>
          <th>{columns.direction}</th><th className="amount">{columns.amount}</th><th>{columns.status}</th>
        </tr>
      </thead>
      <tbody>
        {proposals.map((proposal) => (
          <ProposalRow key={proposal.partyId} side={side} proposal={proposal} chosen={flow.chosen.has(proposal.partyId)} onToggle={() => flow.toggle(proposal.partyId)} />
        ))}
      </tbody>
    </table>
  </div>
);

/** After Modal's own Cancel: post, then confirm. Nothing once posted. */
function Footer({ flow }: { flow: BulkOpeningFlow }) {
  const ready = flow.state.status === "ready" ? flow.state.preview.proposals.filter((proposal) => proposal.status === "READY" && flow.chosen.has(proposal.partyId)).length : 0;
  if (flow.outcome) return null;
  const date = flow.state.status === "ready" ? formatDate(flow.state.preview.cutoverDate, flow.state.preview.cutoverDate) : "";
  return (
    <>
      {!flow.confirming && <button type="button" className="customer-ledger-action" disabled={ready === 0} onClick={() => flow.setConfirming(true)}>{text.bulkPost(ready)}</button>}
      {flow.confirming && (
        <>
          <span className="ledger-import-note" role="status">{text.bulkConfirm(ready, date)}</span>
          <button type="button" className="customer-ledger-action" disabled={flow.posting || ready === 0} onClick={() => void flow.post()}>{flow.posting ? text.bulkPosting : text.bulkPost(ready)}</button>
        </>
      )}
    </>
  );
}

export const BulkOpeningBalanceDialog: React.FC<{ side: LedgerSide; onPosted: () => void; onClose: () => void }> = ({ side, onPosted, onClose }) => {
  const flow = useBulkOpeningBalances(side);
  const close = () => {
    if (flow.outcome) onPosted();
    onClose();
  };
  const { state } = flow;
  return (
    <Modal title={text.bulkTitle[side]} subtitle={text.bulkIntro} onClose={close} footer={<Footer flow={flow} />} wide="xl">
      <div className="opening-balance-form">
        <div className="opening-balance-field">
          <label htmlFor="bulk-cutover">{text.cutoverLabel}</label>
          <input id="bulk-cutover" type="date" value={flow.cutoverDate} aria-describedby="bulk-cutover-hint" disabled={flow.posting || flow.outcome !== null} onChange={(event) => flow.changeCutover(event.target.value)} />
          <small id="bulk-cutover-hint">{text.cutoverHint}</small>
        </div>
        <button type="button" className="customer-ledger-print" disabled={state.status === "loading" || flow.outcome !== null} onClick={() => void flow.runPreview()}>{text.bulkPreview}</button>
      </div>
      {state.status === "loading" && <StateView kind="loading" compact message={text.bulkWorking} />}
      {state.status === "error" && <StateView kind="error" compact title={text.bulkFailed} message={state.reason ?? undefined} onRetry={() => void flow.runPreview()} />}
      {state.status === "ready" && state.preview.proposals.length === 0 && <StateView kind="empty" compact title={text.bulkEmpty} hint={text.reportEmptyHint} />}
      {state.status === "ready" && state.preview.proposals.length > 0 && !flow.outcome && <ProposalTable side={side} flow={flow} proposals={state.preview.proposals} />}
      {flow.refusal && <p className="ledger-import-error" role="alert">✕ {flow.refusal}</p>}
      {flow.outcome && (
        <div className="ledger-import-done" role="status">
          <strong>{text.bulkPostedTitle}</strong>
          <p>{flow.outcome.duplicate ? text.bulkDuplicateBody : text.bulkPostedBody(flow.outcome.posted)}</p>
        </div>
      )}
    </Modal>
  );
};
