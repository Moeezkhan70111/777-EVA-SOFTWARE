import type { AppRoute } from "../../../app/routes";
import { copy } from "../../../config/copy";

// THE STORE PAGE'S MODES AND TABS (0.3.9).
//
// Each mode is a route, so a notification or a Back can open the page on one. Both render the same
// page, unkeyed, so switching mode keeps it — and both scan stations — mounted. The tabs are the
// page's own state: the sidebar has one Store entry and points at no tab.
//
// Each tab carries the permission it has always needed. The page itself needs store scanning, so a
// tab that needs nothing more is open to everyone who can see the page.

export type StoreMode = "receiving" | "issuing";

export const STORE_MODE_ROUTE: Record<StoreMode, AppRoute> = {
  receiving: "store-receiving",
  issuing: "store-issuing",
};

export const storeModeOfRoute = (route: AppRoute): StoreMode => (route === "store-issuing" ? "issuing" : "receiving");

/** Either of the Store page's two routes. */
export const isStoreRoute = (route: AppRoute): boolean => route === STORE_MODE_ROUTE.receiving || route === STORE_MODE_ROUTE.issuing;

/** What this account may open beyond the page itself. */
export interface StoreAccess {
  /** Add material, Stock and Receipts. */
  stock: boolean;
  /** Printing packet labels. */
  labels: boolean;
  /** Raw material setup. */
  settings: boolean;
}

type Needs = keyof StoreAccess | null;

// The Daily report is a tab in each mode (0.4.1), last, for everyone who can see the page.
export type ReceivingTab = "material" | "labels" | "stock" | "receipts" | "byHand" | "setup" | "report";
export type IssuingTab = "byHand" | "issuedToday" | "stock" | "report";

interface TabDef<T extends string> {
  id: T;
  label: string;
  needs: Needs;
}

const t = copy.storePage.tabs;

export const RECEIVING_TABS: readonly TabDef<ReceivingTab>[] = [
  { id: "material", label: t.addMaterial, needs: "stock" },
  { id: "labels", label: t.labels, needs: "labels" },
  { id: "stock", label: t.stock, needs: "stock" },
  { id: "receipts", label: t.receipts, needs: "stock" },
  { id: "byHand", label: t.byHand, needs: null },
  { id: "setup", label: t.setup, needs: "settings" },
  { id: "report", label: t.dailyReport, needs: null },
];

export const ISSUING_TABS: readonly TabDef<IssuingTab>[] = [
  { id: "byHand", label: t.byHand, needs: null },
  { id: "issuedToday", label: t.issuedToday, needs: null },
  { id: "stock", label: t.stock, needs: "stock" },
  { id: "report", label: t.dailyReport, needs: null },
];

/** The tabs this account may open, in order. */
export const allowedTabs = <T extends string>(tabs: readonly TabDef<T>[], access: StoreAccess): TabDef<T>[] =>
  tabs.filter((tab) => tab.needs === null || access[tab.needs]);

/** The tab to show: the one chosen if it may be opened, else the first that may. Null when none may. */
export const shownTab = <T extends string>(chosen: T, allowed: readonly TabDef<T>[]): T | null =>
  allowed.some((tab) => tab.id === chosen) ? chosen : (allowed[0]?.id ?? null);
