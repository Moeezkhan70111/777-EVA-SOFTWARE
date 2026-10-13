import React, { useState } from "react";
import { PRINTING_CONTRACTOR_ACCOUNT_ID } from "@erp/domain";
import type { AppRoute } from "../../app/routes";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { ContractorLedgerTable } from "./ContractorLedgerTable";
import { ContractorPickerCard, type LedgerPeriod } from "./ContractorPickerCard";
import { LedgerSummary } from "./LedgerSummary";
import { thisMonth } from "./contractorLedgerView";
import { useContractorAccounts, useContractorLedger } from "./useContractorLedgerData";

// Contractor Ledger — what each contractor earned for the production of the machine programs
// they worked on, and what they were paid.
//
//   [ Contractor ▾ ]  From … To …
//   Opening · Work Done · Paid · Balance Payable
//   Date · Particulars · Qty · Earned · Paid · Balance     (a production day opens to its detail)
//
// Work is a carton a machine program printed and Store In received; its machine contractor earns
// the machine rate, its packing contractor the packing rate, and printing goes to the printing
// ledger. The main process works all of it out (@erp/domain contractorLedger.ts).

const text = copy.contractorLedger;

interface ContractorLedgerPageProps {
  onNavigate: (route: AppRoute) => void;
}

/** The chosen account's ledger in its four states. */
const LedgerBody: React.FC<{ accountId: string; period: LedgerPeriod }> = ({ accountId, period }) => {
  const ledger = useContractorLedger(accountId, period.fromDate, period.toDate);
  if (ledger.loading) return <StateView kind="loading" message={text.loadingLedger} />;
  if (ledger.error || !ledger.value) {
    return <StateView kind="error" title={text.ledgerFailed} message={ledger.error ?? undefined} onRetry={() => void ledger.reload()} />;
  }
  return (
    <>
      <LedgerSummary ledger={ledger.value} />
      {ledger.value.entries.length === 0 && ledger.value.openingBalancePaisa === 0 ? (
        <StateView kind="empty" title={text.noEntries} hint={text.noEntriesHint} />
      ) : (
        <ContractorLedgerTable ledger={ledger.value} />
      )}
    </>
  );
};

export const ContractorLedgerPage: React.FC<ContractorLedgerPageProps> = ({ onNavigate }) => {
  const accounts = useContractorAccounts();
  const [accountId, setAccountId] = useState("");
  const [period, setPeriod] = useState<LedgerPeriod>(thisMonth);
  const contractorCount = accounts.value.filter((account) => account.id !== PRINTING_CONTRACTOR_ACCOUNT_ID).length;

  /** Loading or failed — or null once there is a list to pick from. */
  const listState = (): React.ReactNode => {
    if (accounts.loading) return <StateView kind="loading" message={text.loading} />;
    if (accounts.error) {
      return <StateView kind="error" title={text.loadFailed} message={accounts.error} onRetry={() => void accounts.reload()} />;
    }
    return null;
  };

  return (
    <div className="page contractor-ledger-page">
      <div className="page-header contractor-ledger-header">
        <div>
          <h1>{text.title}</h1>
          <p className="contractor-ledger-subtitle">{text.subtitle}</p>
        </div>
      </div>

      {listState() ?? (
        <>
          <ContractorPickerCard
            accounts={accounts.value}
            contractorCount={contractorCount}
            accountId={accountId}
            onAccountChange={setAccountId}
            period={period}
            onPeriodChange={setPeriod}
          />
          {contractorCount === 0 && !accountId && (
            <StateView
              kind="empty"
              compact
              title={text.emptyTitle}
              hint={text.emptyHint}
              action={{ label: text.addContractor, onClick: () => onNavigate("party-form") }}
            />
          )}
          {accountId ? <LedgerBody accountId={accountId} period={period} /> : <StateView kind="empty" title={text.nothingPicked} />}
        </>
      )}
    </div>
  );
};
