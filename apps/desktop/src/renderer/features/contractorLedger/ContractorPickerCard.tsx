import React, { useMemo } from "react";
import { SearchableCombobox, type SearchableComboboxOption } from "../../components/shared/SearchableCombobox";
import { copy } from "../../config/copy";
import type { ContractorLedgerAccount } from "../../types/desktopApi";
import { roleLabel, thisMonth } from "./contractorLedgerView";
import { RoleBadges } from "./RoleBadges";

// The top card: which contractor, and which period.
//
//   Contractor                         3 contractors    From [01/10/2026]  To [12/10/2026]  [This month]
//   [ ALAMGIR                      ▾ ]
//   ALAMGIR · LAHORE   [Machine Contractor]

const text = copy.contractorLedger;

export interface LedgerPeriod {
  fromDate: string;
  toDate: string;
}

interface ContractorPickerCardProps {
  accounts: ContractorLedgerAccount[];
  /** How many of `accounts` are contractor parties (the printing ledger is not one). */
  contractorCount: number;
  accountId: string;
  onAccountChange: (accountId: string) => void;
  period: LedgerPeriod;
  onPeriodChange: (period: LedgerPeriod) => void;
}

const optionOf = (account: ContractorLedgerAccount): SearchableComboboxOption => {
  const roles = account.roles.map(roleLabel).join(" & ");
  return {
    value: account.id,
    label: account.name,
    detail: account.city ? [roles, account.city].filter(Boolean).join(" · ") : roles || text.printingDetail,
    keywords: roles,
  };
};

export const ContractorPickerCard: React.FC<ContractorPickerCardProps> = (props) => {
  const { accounts, accountId, period } = props;
  const options = useMemo(() => accounts.map(optionOf), [accounts]);
  const picked = accounts.find((account) => account.id === accountId) ?? null;

  return (
    <section className="party-form-card contractor-ledger-picker">
      <div className="contractor-ledger-picker-grid">
        <div className="contractor-ledger-field">
          <div className="contractor-ledger-picker-head">
            <span className="contractor-ledger-label">{text.contractor}</span>
            <span>{text.count(props.contractorCount)}</span>
          </div>
          <SearchableCombobox
            value={accountId}
            options={options}
            placeholder={text.choose}
            emptyLabel={text.noMatch}
            ariaLabel={text.contractor}
            onChange={props.onAccountChange}
            dropdown
          />
        </div>

        <div className="contractor-ledger-period">
          <div className="form-group">
            <label htmlFor="contractor-ledger-from">{text.from}</label>
            <input id="contractor-ledger-from" type="date" className="form-input" value={period.fromDate} max={period.toDate}
              onChange={(event) => event.target.value && props.onPeriodChange({ ...period, fromDate: event.target.value })} />
          </div>
          <div className="form-group">
            <label htmlFor="contractor-ledger-to">{text.to}</label>
            <input id="contractor-ledger-to" type="date" className="form-input" value={period.toDate} min={period.fromDate}
              onChange={(event) => event.target.value && props.onPeriodChange({ ...period, toDate: event.target.value })} />
          </div>
          <button type="button" className="btn btn-secondary" onClick={() => props.onPeriodChange(thisMonth())}>
            {text.thisMonth}
          </button>
        </div>
      </div>

      {picked && (
        <div className="contractor-ledger-identity">
          <strong>{picked.name}</strong>
          {picked.city && (
            <>
              <span aria-hidden="true">·</span>
              <span>{picked.city}</span>
            </>
          )}
          <RoleBadges roles={picked.roles} />
        </div>
      )}
    </section>
  );
};
