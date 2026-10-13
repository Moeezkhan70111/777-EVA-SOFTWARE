import type { AppRoute } from "../../app/routes";
import { CREATE_GATEPASS_ARTWORK_URL, GATEPASS_LIST_ARTWORK_URL, MACHINE_ARTWORK_URL } from "../../config/artwork";
import { copy } from "../../config/copy";
import type { AuthUser } from "../../types/desktopApi";
import { canOpenRoute } from "../auth/session";

// The pages a role can be given, grouped the way they appear on Home and in the sidebar.
//
// This is the one list of destinations. Home draws a tile per entry and the sidebar draws a
// row per entry, both filtered through canOpenRoute — the same check the route guard in App
// uses — so a user sees a card exactly when the page behind it would open for them, and an
// administrator assigns what a role sees by assigning permissions (Profile & Roles).
//
// Screens reached only from inside another screen (a store sub-step, a scanning desk, a
// form opened for one record) are not listed; `activeFor` keeps their card highlighted.
//
// A `standalone` section is one page that stands on its own: the sidebar shows it as a single
// top-level row, like Home, instead of a heading with rows under it.
//
// A page with a `feature` card is drawn on Home as a large dashboard card (FeatureCard.tsx) —
// the design every card moves to as its artwork is made. Pages without one keep the compact
// tile until then.

export type NavSectionId = keyof typeof copy.nav.sections;

/** Colour family of a large dashboard card. Mapped to theme tokens in theme.css (R3). */
export type FeatureTheme = "blue" | "green";

/** What a page needs to be drawn as a large dashboard card. */
export interface FeatureCardSpec {
  artwork: string;
  theme: FeatureTheme;
  /** The artwork already includes its own cloud and sparks, so the card does not draw them. */
  artworkHasScene?: boolean;
}

/** Decorative colour family of a section's tiles. Mapped to theme tokens in theme.css (R3). */
export type NavTone = "action" | "ok" | "warn" | "info" | "neutral";

/** Which picture a tile shows. Drawn in NavIcons.tsx. */
export type NavIconId =
  | "dashboard" | "workspace" | "scan" | "dispatch" | "return" | "store" | "voucher"
  | "stock" | "history" | "daily" | "party" | "product" | "qr" | "cash" | "ledger"
  | "balance" | "purchase" | "settings" | "health" | "logs" | "machine";

export interface NavItem {
  route: AppRoute;
  label: string;
  line: string;
  icon: NavIconId;
  /** Large dashboard card. Without it the page shows on Home as a compact tile. */
  feature?: FeatureCardSpec;
  /** Inner screens of this page, so its card stays highlighted while one is open. */
  activeFor?: readonly AppRoute[];
}

export interface NavSection {
  id: NavSectionId;
  label: string;
  tone: NavTone;
  /** One page shown as its own top-level sidebar row rather than under a heading. */
  standalone?: boolean;
  items: readonly NavItem[];
}

const item = (
  route: AppRoute,
  text: { label: string; line: string },
  icon: NavIconId,
  activeFor?: readonly AppRoute[]
): NavItem => ({ route, label: text.label, line: text.line, icon, activeFor });

const { items: t, sections: s } = copy.nav;

export const NAV_SECTIONS: readonly NavSection[] = [
  {
    id: "overview",
    label: s.overview,
    tone: "action",
    items: [item("dashboard", t.dashboard, "dashboard"), item("workspace", t.workspace, "workspace")],
  },
  {
    id: "scanning",
    label: s.scanning,
    tone: "ok",
    items: [
      item("live-production", t.liveProduction, "scan"),
      item("live-dispatch", t.liveDispatch, "dispatch"),
      item("live-return", t.liveReturn, "return"),
    ],
  },
  {
    id: "store",
    label: s.store,
    tone: "action",
    items: [
      item("store-home", t.storeHome, "store", [
        "store-in-operator", "store-in-new-material", "store-in-qr-generator", "store-in-scanner",
        "store-in-stock", "store-in-receipts", "store-in-setup", "store-in-daily-report",
        "store-out-operator", "store-out-daily-report",
      ]),
      item("store-scanning", t.storeMoveIn, "scan"),
      item("store-move-out", t.storeMoveOut, "dispatch"),
      item("raw-material-input", t.rawMaterialInput, "scan"),
      item("raw-material-output", t.rawMaterialOutput, "dispatch"),
    ],
  },
  {
    id: "munshi",
    label: s.munshi,
    tone: "warn",
    items: [item("munshi-home", t.munshiHome, "voucher", ["munshi-stock"])],
  },
  {
    id: "machineProgram",
    label: s.machineProgram,
    tone: "info",
    standalone: true,
    items: [
      { ...item("machine-program", t.machineProgram, "machine"), feature: { artwork: MACHINE_ARTWORK_URL, theme: "blue" } },
    ],
  },
  {
    id: "gatepass",
    label: s.gatepass,
    tone: "warn",
    items: [
      {
        ...item("gatepass", t.gatepassCreate, "voucher"),
        feature: { artwork: CREATE_GATEPASS_ARTWORK_URL, theme: "green", artworkHasScene: true },
      },
      {
        ...item("gatepass-list", t.gatepassList, "history", ["gatepass-store-scan", "gatepass-dispatch-scan"]),
        feature: { artwork: GATEPASS_LIST_ARTWORK_URL, theme: "green" },
      },
    ],
  },
  {
    id: "inventory",
    label: s.inventory,
    tone: "info",
    items: [
      item("stock", t.stock, "stock"),
      item("raw-material", t.rawMaterial, "stock", ["raw-material-qr-generator"]),
      item("history", t.stockHistory, "history", ["stock-history"]),
      item("daily-production", t.dailyProduction, "daily"),
      item("daily-dispatch", t.dailyDispatch, "daily"),
      item("production-history", t.productionHistory, "history"),
      item("dispatch-history", t.dispatchHistory, "history"),
      item("return-history", t.returnHistory, "history"),
    ],
  },
  {
    id: "masters",
    label: s.masters,
    tone: "neutral",
    items: [
      item("party-list", t.partyList, "party"),
      item("party-form", t.partyForm, "party"),
      item("product-list", t.productList, "product"),
      item("product-form", t.productForm, "product"),
      item("product-lists", t.productLists, "settings"),
      item("qr-generator", t.qrGenerator, "qr"),
      item("qr-management", t.qrManagement, "qr"),
      item("qr-journey", t.qrJourney, "qr"),
      item("discount-policy", t.discountPolicy, "balance"),
    ],
  },
  {
    id: "billing",
    label: s.billing,
    tone: "ok",
    items: [
      item("sale-voucher-form", t.saleVoucherForm, "voucher"),
      item("sale-voucher-list", t.saleVoucherList, "history"),
      item("cash-voucher-form", t.cashVoucherForm, "cash"),
      item("cash-voucher-list", t.cashVoucherList, "history"),
      item("customer-ledger", t.customerLedger, "ledger"),
      item("customer-balance", t.customerBalance, "balance"),
      item("purchase-voucher-form", t.purchaseVoucherForm, "purchase"),
      item("purchase-voucher-list", t.purchaseVoucherList, "history"),
      item("supplier-ledger", t.supplierLedger, "ledger"),
      item("supplier-balance", t.supplierBalance, "balance"),
      item("contractor-ledger", t.contractorLedger, "ledger"),
    ],
  },
  {
    id: "system",
    label: s.system,
    tone: "neutral",
    items: [
      item("settings", t.settings, "settings"),
      item("raw-material-setup", t.rawMaterialSetup, "settings"),
      item("health", t.health, "health"),
      item("logs", t.logs, "logs"),
    ],
  },
];

/** The sections this user has at least one page in, each holding only those pages. */
export const visibleNavSections = (user: AuthUser | null | undefined): NavSection[] =>
  NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((entry) => canOpenRoute(user, entry.route)),
  })).filter((section) => section.items.length > 0);

/** Whether a card is the one for the screen currently open. */
export const isNavItemActive = (entry: NavItem, current: AppRoute): boolean =>
  entry.route === current || (entry.activeFor?.includes(current) ?? false);
