import React from "react";
import { copy } from "../../config/copy";
import { formatWholeMoney } from "../../app/format";
import type { PeriodSum } from "./ledgerFigures";

// The period as one sum the eye reads left to right (Prägnanz, common region): brought forward + debit − credit =
// balance, over the whole ledger: the ERP's entries and the imported ledger's rows as one (owner, 25 Nov 2026). The
// balance is the main process's; the four line up in tabular figures so a digit never jumps when they change.

const text = copy.customerLedger;

interface LedgerEquationProps {
  sum: PeriodSum;
  closingBalance: number;
}

const Term: React.FC<{ sign?: string; label: string; value: number; note?: string; total?: boolean }> = ({ sign, label, value, note, total }) => (
  <div className={total ? "cl-eq-term is-total" : "cl-eq-term"}>
    {sign && <span className="cl-eq-sign" aria-hidden="true">{sign}</span>}
    <span className="cl-eq-label">{label}</span>
    <strong className="cl-eq-value">{value < 0 ? "−" : ""}{formatWholeMoney(Math.abs(value))}</strong>
    {note && <small>{note}</small>}
  </div>
);

export const LedgerEquation: React.FC<LedgerEquationProps> = ({ sum, closingBalance }) => (
  <section className="cl-equation" aria-label={text.equationLabel}>
    <Term label={text.broughtForward} value={sum.broughtForward} />
    <Term sign="+" label={text.debit} value={sum.debit} note={text.entryCount(sum.debitCount)} />
    <Term sign="−" label={text.credit} value={sum.credit} note={text.entryCount(sum.creditCount)} />
    <Term sign="=" label={text.balance} value={closingBalance} total />
  </section>
);
