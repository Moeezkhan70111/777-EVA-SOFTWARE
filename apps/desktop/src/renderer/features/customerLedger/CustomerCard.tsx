import React, { useMemo } from "react";
import { SearchableCombobox, type SearchableComboboxOption } from "../../components/shared/SearchableCombobox";
import { copy } from "../../config/copy";
import { formatWholeMoney } from "../../app/format";
import type { Party } from "../../types/desktopApi";
import { limitUse } from "./ledgerFigures";

// Who the ledger is for: the shared party picker (R1; it opens from where it sits, with its own search box) and the
// customer's balance limit as a meter that fills toward it (goal gradient), with what is left said in words.

const text = copy.customerLedger;
const ACTIVE = "ACTIVE";

const optionOf = (party: Party): SearchableComboboxOption => ({
  value: party.id,
  label: party.partyName,
  detail: [party.city, party.mobileNumber].filter(Boolean).join(" · ") || undefined,
  keywords: party.partyCode,
  badge: party.status === ACTIVE ? undefined : text.inactive,
});

const LimitMeter: React.FC<{ limit: number | null; closingBalance: number }> = ({ limit, closingBalance }) => {
  const use = limitUse(limit, closingBalance);
  if (limit === null || !use) return <div className="cl-limit"><span className="cl-limit-label">{text.limit}</span><strong>{text.noLimit}</strong></div>;
  const over = use.leftRupees < 0;
  const left = over ? text.limitOver(formatWholeMoney(-use.leftRupees)) : text.limitLeft(formatWholeMoney(use.leftRupees));
  return (
    <div className="cl-limit" data-over={over || undefined}>
      <span className="cl-limit-label">{text.limit}</span>
      <strong>Rs. {formatWholeMoney(limit)}</strong>
      <div className="cl-limit-meter" role="meter" aria-label={text.limit} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(use.percent, 100)} aria-valuetext={`${text.limitUsed(use.percent)}, ${left}`}>
        <span style={{ inlineSize: `${String(Math.min(use.percent, 100))}%` }} />
      </div>
      <small><b>{text.limitUsed(use.percent)}</b> · {left}</small>
    </div>
  );
};

interface CustomerCardProps {
  customers: readonly Party[];
  value: string;
  onChange: (partyId: string) => void;
  limit: number | null;
  closingBalance: number;
}

export const CustomerCard: React.FC<CustomerCardProps> = ({ customers, value, onChange, limit, closingBalance }) => {
  const options = useMemo(() => customers.map(optionOf), [customers]);
  return (
    <section className="cl-customer card" aria-label={text.customer}>
      <label className="mpr-field cl-customer-field">
        <span className="input-label">{text.customer}</span>
        <SearchableCombobox ariaLabel={text.customer} placeholder={text.customerPlaceholder} searchPlaceholder={text.customerSearch}
          emptyLabel={text.noCustomers} value={value} options={options} onChange={onChange} />
      </label>
      {value && <LimitMeter limit={limit} closingBalance={closingBalance} />}
    </section>
  );
};
