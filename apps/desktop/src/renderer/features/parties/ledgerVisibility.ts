import { LEASE_DOMAIN } from "@erp/domain";
import type { AppRoute } from "../../app/routes";
import { useHeldLease } from "../sync/useHeldLease";

// Party ledgers and balances show only on the computer holding the Accounts lease, where the
// vouchers are. Anywhere else the figure would be computed from vouchers that are not there, and a
// wrong balance on screen is worse than none. The ledgers are out of use until they are restarted,
// so this hides them rather than guarding them: the pages, their entries in the sidebar and on Home,
// and the balance on a party card or a cash voucher line.

/** Every screen that shows a party's ledger or balance. */
export const LEDGER_ROUTES: ReadonlySet<AppRoute> = new Set<AppRoute>([
  "customer-ledger",
  "customer-balance",
  "supplier-ledger",
  "supplier-balance",
  "contractor-ledger",
]);

const NO_ROUTES: ReadonlySet<AppRoute> = new Set<AppRoute>();

/** True only on the Accounts holder. Hidden while still asking, and when the answer cannot be read. */
export const useLedgersShown = (): boolean => useHeldLease(LEASE_DOMAIN.ACCOUNTS).held;

/** The routes not offered on this computer. */
export const hiddenLedgerRoutes = (ledgersShown: boolean): ReadonlySet<AppRoute> => (ledgersShown ? NO_ROUTES : LEDGER_ROUTES);
