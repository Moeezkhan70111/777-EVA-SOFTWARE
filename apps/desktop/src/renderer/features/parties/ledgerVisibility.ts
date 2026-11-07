import { LEASE_DOMAIN } from "@erp/domain";
import type { AppRoute } from "../../app/routes";
import { useHeldLease } from "../sync/useHeldLease";

// Customer and contractor ledgers show on every computer: their bills, payments and production entries now
// travel (docs/43). Supplier ledgers show only on the computer holding the Accounts lease, because purchase vouchers
// do not travel: anywhere else the figure would be computed from vouchers that are not there, and a wrong
// balance on screen is worse than none. The balance on a party card or a cash voucher line can be any party's, so
// it stays on the holder too.

/** The screens whose figures are right only where the purchase vouchers are. */
export const LEDGER_ROUTES: ReadonlySet<AppRoute> = new Set<AppRoute>([
  "supplier-ledger",
  "supplier-balance",
]);

const NO_ROUTES: ReadonlySet<AppRoute> = new Set<AppRoute>();

/** True only on the Accounts holder. Hidden while still asking, and when the answer cannot be read. */
export const useLedgersShown = (): boolean => useHeldLease(LEASE_DOMAIN.ACCOUNTS).held;

/** The routes not offered on this computer. */
export const hiddenLedgerRoutes = (ledgersShown: boolean): ReadonlySet<AppRoute> => (ledgersShown ? NO_ROUTES : LEDGER_ROUTES);
