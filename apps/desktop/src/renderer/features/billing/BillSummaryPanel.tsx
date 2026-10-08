import React from "react";
import { formatMoney, formatWholeMoney } from "../../app/format";
import { copy } from "../../config/copy";
import { UrduInput } from "../../components/shared/UrduInput";
import { PartyCard, type PartyFacts } from "../parties/PartyCard";
import type { PartyBalanceState } from "../parties/usePartyBalance";
import type { BillTotals } from "./billLines";
import { projectPartyCredit, type PartyCredit } from "./partyCredit";
import { formatFigure } from "./LineNumberInput";

// The right-hand column of the bill: who it is for and where their credit stands, the
// few header fields the desk fills by hand, the totals, and Save. It stays in view while
// the lines on the left scroll, so nothing on the bill needs scrolling to reach.

export interface BillHeaderFields {
  voucherDate: string;
  bookNo: string;
  subPartyNameUrdu: string;
  remarks: string;
}

interface BillSummaryPanelProps {
  party: PartyFacts | null;
  balance: PartyBalanceState;
  /** null: no credit limit on the party. */
  balanceLimit: number | null;
  totals: BillTotals;
  fields: BillHeaderFields;
  onFieldsChange: (patch: Partial<BillHeaderFields>) => void;
  /** True once the bill exists: the date is fixed, Save updates, Delete is offered. */
  saved: boolean;
  busy: boolean;
  canSave: boolean;
  onSave: () => void;
  onDelete: () => void;
  onCancel: () => void;
}

const rupees = (value: number): string => `Rs ${formatWholeMoney(value)}`;

/** The party's credit position — the same arithmetic as the save-time check. For a saved bill the total is already in the balance. */
const creditFor = (balance: PartyBalanceState, balanceLimit: number | null, billTotal: number, saved: boolean): PartyCredit | null =>
  balance.status === "ready" ? projectPartyCredit({ balance: balance.value, limit: balanceLimit, billTotal: saved ? 0 : billTotal }) : null;

/** Balance limit and the room left under it, on the party card. */
const CreditLine: React.FC<{ credit: PartyCredit | null }> = ({ credit }) => {
  if (!credit) return null;
  if (credit.limit === null || credit.available === null) {
    return <span className="bill-credit bill-credit--none">{copy.billing.noCreditLimit}</span>;
  }
  return (
    <span className={`bill-credit${credit.exceedsBy > 0 ? " bill-credit--over" : ""}`} data-testid="bill-credit">
      <span>{copy.billing.limit} <strong>{rupees(credit.limit)}</strong></span>
      <span>{copy.billing.available} <strong>{rupees(credit.available)}</strong></span>
    </span>
  );
};

/** Where the party lands once this bill is added, under the grand total — only while the bill is still unsaved. */
const ProjectionRow: React.FC<{ credit: PartyCredit | null; show: boolean }> = ({ credit, show }) => {
  if (!show || !credit || credit.limit === null) return null;
  const exceeds = credit.exceedsBy > 0;
  return (
    <div className={`bill-totals-projection${exceeds ? " is-over" : ""}`} data-testid="bill-projection">
      <dt>{exceeds ? "⚠ " : "✓ "}{copy.billing.projected}</dt>
      <dd>{exceeds ? copy.billing.exceedsLimit(rupees(credit.exceedsBy)) : rupees(credit.projected)}</dd>
    </div>
  );
};

export const BillSummaryPanel: React.FC<BillSummaryPanelProps> = ({ party, balance, balanceLimit, totals, fields, onFieldsChange, saved, busy, canSave, onSave, onDelete, onCancel }) => {
  const credit = creditFor(balance, balanceLimit, totals.net, saved);
  return (
  <aside className="card gp-card gp-summary bill-summary" aria-label={copy.billing.voucherDetails} data-testid="bill-summary">
    {party && <PartyCard party={party} balance={balance} detail={<CreditLine credit={credit} />} />}

    <div className="bill-fields">
      <div className="gp-field">
        <label htmlFor="sv-date">{copy.columns.date}</label>
        <input id="sv-date" type="date" className="form-input" value={fields.voucherDate} disabled={saved || busy} onChange={(event) => onFieldsChange({ voucherDate: event.target.value })} />
      </div>
      <div className="gp-field">
        <label htmlFor="sv-book">{copy.billing.bookNo}</label>
        <input id="sv-book" type="text" className="form-input" value={fields.bookNo} disabled={busy} placeholder={copy.billing.optional} onChange={(event) => onFieldsChange({ bookNo: event.target.value })} />
      </div>
      <div className="gp-field">
        <label htmlFor="sv-subparty-urdu">{copy.billing.subPartyUrdu}</label>
        <UrduInput id="sv-subparty-urdu" value={fields.subPartyNameUrdu} disabled={busy} placeholder={copy.billing.optionalUrdu} onChange={(subPartyNameUrdu) => onFieldsChange({ subPartyNameUrdu })} />
      </div>
      <div className="gp-field">
        <label htmlFor="sv-rem">{copy.billing.remarksUrdu}</label>
        <UrduInput id="sv-rem" value={fields.remarks} disabled={busy} placeholder={copy.billing.optionalUrdu} onChange={(remarks) => onFieldsChange({ remarks })} />
      </div>
    </div>

    <dl className="bill-totals" data-testid="bill-totals">
      <div><dt>{copy.billing.totalDozens}</dt><dd>{formatFigure(totals.dzn)}</dd></div>
      <div><dt>{copy.billing.beforeDiscount}</dt><dd>{formatMoney(totals.gross)}</dd></div>
      <div><dt>{copy.billing.discount}</dt><dd className="bill-totals-less">− {formatMoney(totals.disc)}</dd></div>
      <div className="bill-totals-grand"><dt>{copy.billing.grandTotal}</dt><dd>Rs {formatMoney(totals.net)}</dd></div>
      <ProjectionRow credit={credit} show={!saved && totals.net > 0} />
    </dl>

    <div className="bill-actions">
      <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>{copy.common.cancel}</button>
      {saved && (
        <button type="button" className="btn btn-secondary bill-delete" onClick={onDelete} disabled={busy} aria-label={copy.billing.deleteVoucher} title={copy.billing.deleteVoucher}>🗑 Delete</button>
      )}
      <button type="button" className="btn btn-primary bill-save" onClick={onSave} disabled={busy || !canSave} data-testid="bill-save">
        {busy ? copy.billing.saving : saved ? copy.billing.updateVoucher : copy.billing.createVoucher}
      </button>
    </div>
  </aside>
  );
};
