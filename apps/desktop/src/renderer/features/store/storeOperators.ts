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
 * The sections of the one Store In page, in the order its tab strip shows them.
 *
 * Each is also a route, so the sidebar can point straight at a tab and a tab can be come back
 * to. The scan station is not among them: it is the pane down the right of every tab.
 */
export type StoreInTab = "material" | "labels" | "stock" | "receipts" | "setup" | "manual" | "report";

export interface StoreInSection extends StoreJobPage {
  id: StoreInTab;
}

export const STORE_IN_TABS: readonly StoreInSection[] = [
  { id: "material", route: "store-in-new-material", title: copy.store.addMaterialTitle, line: copy.store.addMaterialLine },
  { id: "labels", route: "store-in-qr-generator", title: copy.store.qrTabTitle, line: copy.store.qrLine },
  { id: "stock", route: "store-in-stock", title: copy.store.stockTitle, line: copy.store.stockLine },
  { id: "receipts", route: "store-in-receipts", title: copy.store.receiptsTitle, line: copy.store.receiptsLine },
  { id: "setup", route: "store-in-setup", title: copy.store.setupTitle, line: copy.store.setupLine },
  // Manual Entry was a button under the scanner until 0.3.8: material that came without labels is
  // typed in here, beside the Daily Report that lists it.
  { id: "manual", route: "store-in-manual-entry", title: copy.store.manualEntry, line: copy.store.manualEntryLine },
  { id: "report", route: "store-in-daily-report", title: copy.storeDailyReport.inTitle, line: copy.storeDailyReport.inLine },
];

/** The route that opens one tab of the Store In page. */
export const storeInTabRoute = (tab: StoreInTab): AppRoute =>
  STORE_IN_TABS.find((entry) => entry.id === tab)?.route ?? "store-in-new-material";

/** The tab a route opens on. Store In's own home opens on the first thing receiving needs. */
export const storeInTabOfRoute = (route: AppRoute): StoreInTab =>
  STORE_IN_TABS.find((entry) => entry.route === route)?.id ?? "material";

/**
 * The Move In job's rows in the sidebar: the page's own tabs, plus the full-screen scan
 * station, which is still its own page for a terminal that does nothing but scan.
 */
export const MOVE_IN_PAGES: readonly StoreJobPage[] = [
  ...STORE_IN_TABS,
  { id: "scanner", route: "store-in-scanner", title: copy.store.scannerTitle, line: copy.store.scannerLine },
];

/**
 * The Move Out job's rows in the sidebar: everything else on Move Out is one page.
 *
 * The carton QR Generator (Setup → QR Generator) is here too since 0.3.6, so a store operator
 * working Move Out reaches it without leaving the job, and the sidebar keeps the job while they
 * are on it. It is the same page as under Setup, not a copy.
 */
export const MOVE_OUT_PAGES: readonly StoreJobPage[] = [
  { id: "report", route: "store-out-daily-report", title: copy.storeDailyReport.outTitle, line: copy.storeDailyReport.outLine },
  { id: "qr-generator", route: "qr-generator", title: copy.nav.items.qrGenerator.label, line: copy.nav.items.qrGenerator.line },
];

/** Each job's pages. */
export const STORE_JOB_PAGES: Record<StoreDirection, readonly StoreJobPage[]> = {
  in: MOVE_IN_PAGES,
  out: MOVE_OUT_PAGES,
};

/** Which job a screen belongs to — its home or one of its pages — or null for any other screen. */
export const storeJobOfRoute = (route: AppRoute): StoreDirection | null => {
  for (const operator of STORE_OPERATORS) {
    if (operator.route === route) return operator.direction;
    if (STORE_JOB_PAGES[operator.direction].some((page) => page.route === route)) return operator.direction;
  }
  return null;
};
