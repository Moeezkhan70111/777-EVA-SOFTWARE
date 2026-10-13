import { PRINTING_CONTRACTOR_ACCOUNT_ID, CONTRACTOR_ROLE } from "@erp/domain";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useLoaded, type Loaded } from "../../hooks/useLoaded";
import { copy } from "../../config/copy";
import type { ContractorLedgerAccount, ContractorLedgerReport } from "../../types/desktopApi";

// The Contractor Ledger's two reads. Both go through the desktop API to the main process, which
// works the ledger out from the cartons, rates and cash vouchers — nothing is added up here.

/**
 * The printing ledger, listed after the contractors. Printing has no contractor yet, so its work
 * is kept under this one name until a printing contractor party exists.
 */
const PRINTING_ACCOUNT: ContractorLedgerAccount = {
  id: PRINTING_CONTRACTOR_ACCOUNT_ID,
  name: copy.contractorLedger.printingName,
  city: null,
  active: true,
  roles: [CONTRACTOR_ROLE.PRINTING],
};

/** Every contractor a ledger can be opened for, then the printing ledger. */
export const useContractorAccounts = (): Loaded<ContractorLedgerAccount[]> => {
  const api = useDesktopApi();
  return useLoaded(
    "contractor-accounts",
    () => api.listContractorLedgerAccounts(),
    (answer) => [...(answer.accounts ?? []), PRINTING_ACCOUNT],
    []
  );
};

/** One account's ledger for the period. With no account chosen it reads nothing. */
export const useContractorLedger = (
  accountId: string,
  fromDate: string,
  toDate: string
): Loaded<ContractorLedgerReport | null> => {
  const api = useDesktopApi();
  return useLoaded(
    `contractor-ledger:${accountId}:${fromDate}:${toDate}`,
    accountId ? () => api.getContractorLedger(accountId, { fromDate, toDate }) : null,
    (answer) => answer.ledger ?? null,
    null
  );
};
