import type { AppRoute } from "../../app/routes";
import { copy } from "../../config/copy";

// The two jobs in the store. An operator picks one on Store Station and works only that side:
// everything that comes IN to the store, or everything that goes OUT of it.

export type StoreDirection = "in" | "out";

export interface StoreOperator {
  direction: StoreDirection;
  route: AppRoute;
  /** The digit that picks this card from the keyboard, printed on the card's badge. */
  key: "1" | "2";
  title: string;
  line: string;
}

export const STORE_OPERATORS: readonly StoreOperator[] = [
  {
    direction: "in",
    route: "store-in-operator",
    key: "1",
    title: copy.store.moveInTitle,
    line: copy.store.moveInLine,
  },
  {
    direction: "out",
    route: "store-out-operator",
    key: "2",
    title: copy.store.moveOutTitle,
    line: copy.store.moveOutLine,
  },
];

export const storeOperator = (direction: StoreDirection): StoreOperator =>
  STORE_OPERATORS.find((operator) => operator.direction === direction) ?? STORE_OPERATORS[0];

/** One page of a job — a card on the job's screen and a row in the sidebar while that job is open. */
export interface StoreJobPage {
  id: string;
  route: AppRoute;
  title: string;
  line: string;
}

/**
 * The Move In job's pages, in the order the job screen shows them. Who may open each one is
 * the route's own permission (canOpenRoute), the same check the main process enforces.
 */
export const MOVE_IN_PAGES: readonly StoreJobPage[] = [
  { id: "new-material", route: "store-in-new-material", title: copy.store.addMaterialTitle, line: copy.store.addMaterialLine },
  { id: "qr-generator", route: "store-in-qr-generator", title: copy.store.qrTitle, line: copy.store.qrLine },
  { id: "scanner", route: "store-in-scanner", title: copy.store.scannerTitle, line: copy.store.scannerLine },
  { id: "stock", route: "store-in-stock", title: copy.store.stockTitle, line: copy.store.stockLine },
  { id: "receipts", route: "store-in-receipts", title: copy.store.receiptsTitle, line: copy.store.receiptsLine },
  { id: "setup", route: "store-in-setup", title: copy.store.setupTitle, line: copy.store.setupLine },
];

/** Each job's pages. Move Out's steps are not built yet, so it has none. */
export const STORE_JOB_PAGES: Record<StoreDirection, readonly StoreJobPage[]> = {
  in: MOVE_IN_PAGES,
  out: [],
};

/** Which job a screen belongs to — its home or one of its pages — or null for any other screen. */
export const storeJobOfRoute = (route: AppRoute): StoreDirection | null => {
  for (const operator of STORE_OPERATORS) {
    if (operator.route === route) return operator.direction;
    if (STORE_JOB_PAGES[operator.direction].some((page) => page.route === route)) return operator.direction;
  }
  return null;
};
