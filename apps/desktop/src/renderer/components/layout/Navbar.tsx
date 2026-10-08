import { BRAND_LOGO_URL } from "../../config/branding";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AppRoute } from "../../app/routes";
import { isRouteActive } from "../../app/visibleSections";

/**
 * Grace period between the pointer leaving a section (or its flyout) and the flyout closing.
 * It has to cover the diagonal travel from a rail row across to the rows beside it.
 */
const MENU_CLOSE_DELAY_MS = 320;

/* ── Icon helpers ─────────────────────────────────────── */
const ChevronDown = () => (
  <svg className="chevron" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const UserIcon = () => (
  <svg
    className="profile-menu-user-icon"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <circle cx="12" cy="8" r="3.25" stroke="currentColor" strokeWidth="1.8" />
    <path
      d="M5.5 19c.7-3.15 3.05-4.75 6.5-4.75s5.8 1.6 6.5 4.75"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    />
  </svg>
);

/** One picture per sidebar section. Decorative — the label beside it is what is read (R18). */
const SectionIcons: Record<string, React.ReactNode> = {
  dashboard: (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M2 3a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H3a1 1 0 01-1-1V3zm9 0a1 1 0 011-1h5a1 1 0 011 1v2a1 1 0 01-1 1h-5a1 1 0 01-1-1V3zm0 6a1 1 0 011-1h5a1 1 0 011 1v8a1 1 0 01-1 1h-5a1 1 0 01-1-1V9zM2 11a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H3a1 1 0 01-1-1v-6z" />
    </svg>
  ),
  /* Scanning: a barcode under a beam. */
  scanning: (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <path d="M7 8v8M10.5 8v8M14 8v8M17 8v8" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  ),
  /* Store: a building with a shutter. */
  store: (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3.5 9.5L12 3.5l8.5 6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 9.8V20h14V9.8" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
      <path d="M9 20v-5.5h6V20" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
    </svg>
  ),
  /* Munshi: a ledger book. */
  munshi: (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 4.5h11a2.5 2.5 0 012.5 2.5v12.5H7.5A2.5 2.5 0 015 17V4.5z" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
      <path d="M5 17a2.5 2.5 0 012.5-2.5h11M9 8.5h6M9 11.5h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  ),
  /* Gatepass: a document with a tick. */
  gatepass: (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 3.5h8l4.5 4.5v12.5H6V3.5z" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
      <path d="M13.8 3.7V8.3h4.6M9 14l2.2 2.2L15.4 12" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  /* Inventory: stacked cartons. */
  inventory: (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 2.8l8.4 4.4v9.6L12 21.2 3.6 16.8V7.2L12 2.8z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M3.6 7.2L12 11.6l8.4-4.4M12 11.6v9.6" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  ),
  /* Setup: a card index. */
  masters: (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.3" y="5" width="17.4" height="14" rx="2.2" stroke="currentColor" strokeWidth="1.9" />
      <path d="M3.3 9.4h17.4M8 13h3.5M8 16h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  ),
  /* Billing: a bill with a rupee. */
  billing: (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5.5 3.5h13v17l-2.2-1.6-2.2 1.6-2.2-1.6-2.2 1.6-2.2-1.6-1.8 1.3V3.5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M9 7.6h6M9 10.4h6M9 7.6c3 0 3 2.8 0 2.8l4.4 4.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
    </svg>
  ),
  /* Health: a pulse line. */
  health: (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3 12.5h4l2-5 3.5 10.5 3-8 1.8 2.5H21" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  /* Logs: lines on a page. */
  logs: (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="3.5" width="16" height="17" rx="2.2" stroke="currentColor" strokeWidth="1.9" />
      <path d="M8 8h8M8 12h8M8 16h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  ),
  /* Workspace: panes. */
  workspace: (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.3" y="4" width="17.4" height="16" rx="2.2" stroke="currentColor" strokeWidth="1.9" />
      <path d="M3.3 9h17.4M9.5 9v11" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  ),
};

/**
 * A section's rows, beside the section rather than under it.
 *
 * Portalled to <body>: .navbar-nav scrolls, and a scroll container clips its children on both
 * axes, so an absolutely positioned panel inside it is cut off at the rail's edge. Placed from
 * the section's own rect and nudged up when it would run off the bottom of the window.
 *
 * It carries the pointer handlers itself because, being outside the section in the DOM, the
 * section's own mouseleave fires as soon as the pointer travels onto it.
 */
const NavFlyout: React.FC<{
  anchor: DOMRect | null;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  children: React.ReactNode;
}> = ({ anchor, onPointerEnter, onPointerLeave, children }) => {
  const [height, setHeight] = useState(0);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setHeight(panel.current?.offsetHeight ?? 0);
  }, [children, anchor]);

  if (!anchor) return null;
  const margin = 8;
  const top = height > 0 ? Math.max(margin, Math.min(anchor.top, window.innerHeight - height - margin)) : anchor.top;

  return createPortal(
    <>
      {/* Transparent strip over the gap between the rail and the panel. Without it the pointer
          crosses plain background on its way across and the flyout starts closing mid-move. */}
      <div
        className="nav-flyout-bridge"
        style={{ top: anchor.top, left: anchor.right, height: anchor.height }}
        onMouseEnter={onPointerEnter}
        onMouseLeave={onPointerLeave}
        aria-hidden="true"
      />
      <div
        ref={panel}
        className="nav-dropdown"
        style={{ top, left: anchor.right + 6 }}
        onMouseEnter={onPointerEnter}
        onMouseLeave={onPointerLeave}
      >
        {children}
      </div>
    </>,
    document.body
  );
};

const Icons: Record<string, React.ReactNode> = {
  dashboard: (
    <svg viewBox="0 0 20 20" fill="currentColor">
      <path d="M2 3a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H3a1 1 0 01-1-1V3zm9 0a1 1 0 011-1h5a1 1 0 011 1v2a1 1 0 01-1 1h-5a1 1 0 01-1-1V3zm0 6a1 1 0 011-1h5a1 1 0 011 1v8a1 1 0 01-1 1h-5a1 1 0 01-1-1V9zM2 11a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H3a1 1 0 01-1-1v-6z" />
    </svg>
  ),
  stock: (
    <svg viewBox="0 0 20 20" fill="currentColor">
      <path d="M4 3a2 2 0 100 4h12a2 2 0 100-4H4zm-2 6a1 1 0 011-1h14a1 1 0 011 1v7a2 2 0 01-2 2H5a2 2 0 01-2-2V9zm5 2a1 1 0 100 2h4a1 1 0 100-2H7z" />
    </svg>
  ),
  history: (
    <svg viewBox="0 0 20 20" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z"
        clipRule="evenodd"
      />
    </svg>
  ),
  live: (
    <svg viewBox="0 0 20 20" fill="currentColor">
      <circle cx="10" cy="10" r="3" />
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 100-16 8 8 0 000 16zm0-2a6 6 0 100-12 6 6 0 000 12z"
        clipRule="evenodd"
      />
    </svg>
  ),
  daily: (
    <svg viewBox="0 0 20 20" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z"
        clipRule="evenodd"
      />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 20 20" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z"
        clipRule="evenodd"
      />
    </svg>
  ),
  health: (
    <svg viewBox="0 0 20 20" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z"
        clipRule="evenodd"
      />
    </svg>
  ),
  logs: (
    <svg viewBox="0 0 20 20" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z"
        clipRule="evenodd"
      />
    </svg>
  ),
};

export const NAV_PERMISSION_MODULES = [
  {
    id: "dashboard",
    label: "Dashboard",
    children: [],
  },
  {
    id: "workspace",
    label: "Workspace",
    children: [],
  },
  {
    id: "scanning",
    label: "Scanning",
    children: [
      ["live-production", "Live Production"],
      ["live-dispatch", "Live Dispatch"],
      ["live-return", "Return Scanning"],
    ],
  },
  {
    id: "store-scanning",
    label: "Store Scanning",
    children: [],
  },
  {
    // The Munshi's station screen. What they may DO there comes from Gatepass and Stock.
    id: "munshi",
    label: "Munshi Station",
    children: [],
  },
  {
    // "gatepass" covers viewing, creating and printing; cancelling is granted separately.
    id: "gatepass",
    label: "Gatepass",
    children: [
      ["gatepass", "Gatepass (view / create / print)"],
      ["gatepass-cancel", "Cancel Gatepass"],
    ],
  },
  {
    id: "inventory",
    label: "Inventory",
    children: [
      ["stock", "Current Stock"],
      ["history", "Stock History"],
      ["daily-production", "Daily Production"],
      ["daily-dispatch", "Daily Dispatch"],
      ["production-history", "Production History"],
      ["dispatch-history", "Dispatch History"],
      ["return-history", "Return History"],
      ["raw-material-qr-generator", "Raw Material Labels"],
      ["raw-material-setup", "Raw Material Setup"],
      ["raw-material-input", "Raw Material Input"],
      ["raw-material-output", "Raw Material Output"],
      ["machine-program", "Machine Program"],
    ],
  },
  {
    id: "masters",
    label: "Setup",
    children: [
      ["party-list", "Party List"],
      ["party-form", "Add / Edit Party"],
      ["product-list", "Product List"],
      ["product-form", "Add / Edit Product"],
      ["product-lists", "Fields Management"],
      ["qr-generator", "QR Generator"],
      ["qr-management", "QR Management"],
      ["qr-journey", "QR Journey"],
      ["discount-policy", "Discount Policy"],
    ],
  },
  {
    id: "billing",
    label: "Billing",
    children: [
      ["sale-voucher-form", "Sale Vouchers"],
      ["sale-voucher-list", "Voucher List"],
      ["cash-voucher-form", "Cash Voucher"],
      ["cash-voucher-list", "Cash Voucher List"],
      ["customer-ledger", "Customer Ledger"],
      ["customer-balance", "Customer Balance"],
      ["purchase-voucher-form", "Purchase Bill"],
      ["purchase-voucher-list", "Purchase Bill List"],
    ],
  },
  {
    id: "settings",
    label: "Settings",
    children: [],
  },
  {
    id: "health",
    label: "Health",
    children: [],
  },
  {
    id: "logs",
    label: "Logs",
    children: [],
  },
  {
    id: "navbar",
    label: "Show Navigation Bar (Navbar)",
    children: [],
  },
] as const;

interface DropdownItem {
  id: AppRoute;
  label: string;
  icon: string;
}
interface NestedDropdownItem {
  id: AppRoute;
  label: string;
  icon: string;
  /**
   * Permission codes that should reveal this item's parent menu, for a row whose route id is
   * not itself a permission code. Used by the Raw Material workspace, which replaced several
   * pages that were permissioned separately.
   */
  permissionIds?: string[];
}
interface NavEntry {
  id: string; // used as "active" key for the top-level btn
  label: string;
  route?: AppRoute; // direct route (no dropdown)
  children?: DropdownItem[]; // flat dropdown items
  nestedChildren?: { label: string; items: NestedDropdownItem[] }[]; // nested dropdowns
}

const NAV: NavEntry[] = [
  { id: "dashboard", label: "Dashboard", route: "dashboard" },
  {
    id: "scanning",
    label: "Scanning",
    children: [
      { id: "live-production", label: "Live Production", icon: "live" },
      { id: "live-dispatch", label: "Live Dispatch", icon: "live" },
      { id: "live-return", label: "Return Scanning", icon: "live" },
    ],
  },
  // The store is an operational station in its own right, so it gets its own top-level
  // entry rather than living under Inventory. The id stays "store-scanning" because that
  // is the single permission code the whole station is gated on.
  {
    id: "store-scanning",
    label: "Store",
    children: [
      { id: "store-home", label: "Store Station", icon: "dashboard" },
      { id: "store-scanning", label: "Move In", icon: "live" },
      { id: "store-move-out", label: "Move Out", icon: "live" },
      { id: "raw-material-input", label: "Raw Material Input", icon: "live" },
      { id: "raw-material-output", label: "Raw Material Output", icon: "live" },
    ],
  },
  // The Munshi's station, beside the store's. The Munshi themself never sees this bar — the
  // station replaces it — so this row is for an administrator or a supervisor who wants to
  // look at the screen the Munshi works from.
  {
    id: "munshi",
    label: "Munshi",
    children: [{ id: "munshi-home", label: "Munshi Station", icon: "dashboard" }],
  },
  // Gatepass is a document, not a scanner and not a bill, so it stands on its own between
  // the Store station and Inventory. Gated on the single "gatepass" permission code.
  {
    id: "gatepass",
    label: "Gatepass",
    children: [
      { id: "gatepass", label: "Create Gatepass", icon: "stock" },
      { id: "gatepass-list", label: "Gatepass List", icon: "history" },
    ],
  },
  {
    id: "inventory",
    label: "Inventory",
    nestedChildren: [
      {
        label: "Stock",
        items: [
          { id: "stock",   label: "Current Stock", icon: "stock" },
          // One row for the whole raw material module. `permissionIds` keeps it visible to a
          // user whose only raw-material permission is label generation, exactly as the QR
          // Generator row used to be.
          {
            id: "raw-material",
            label: "Raw Material",
            icon: "stock",
            permissionIds: ["stock", "raw-material-qr-generator", "raw-material-setup"],
          },
          { id: "history", label: "Stock History", icon: "history" },
        ],
      },
      {
        label: "Operations",
        items: [
          // Planning a machine's shift against raw material in the store. It sits with the
          // other daily operations rather than in the store station, because the person who
          // writes it is a planner, not the storekeeper who scans the bags out.
          { id: "machine-program", label: "Machine Program", icon: "daily" },
          { id: "daily-production", label: "Daily Production", icon: "daily" },
          { id: "daily-dispatch", label: "Daily Dispatch", icon: "daily" },
        ],
      },
      {
        label: "Activity History",
        items: [
          {
            id: "production-history",
            label: "Production History",
            icon: "history",
          },
          {
            id: "dispatch-history",
            label: "Dispatch History",
            icon: "history",
          },
          {
            id: "return-history",
            label: "Return History",
            icon: "history",
          },
        ],
      },
    ],
  },
  {
    id: "masters",
    label: "Setup",
    nestedChildren: [
      {
        label: "Parties",
        items: [
          { id: "party-list", label: "Party List", icon: "stock" },
          { id: "party-form", label: "Add / Edit Party", icon: "stock" },
        ],
      },
      {
        label: "Products",
        items: [
          { id: "product-list", label: "Product List", icon: "stock" },
          { id: "product-form", label: "Add / Edit Product", icon: "stock" },
          { id: "product-lists", label: "Fields Management", icon: "settings" },
          { id: "qr-generator", label: "QR Generator", icon: "stock" },
          { id: "qr-management", label: "QR Management", icon: "history" },
          { id: "qr-journey", label: "QR Journey", icon: "live" },
          { id: "discount-policy", label: "Discount Policy", icon: "settings" },
        ],
      },
    ],
  },
  {
    id: "billing",
    label: "Billing",
    nestedChildren: [
      {
        label: "Sales",
        items: [
          { id: "sale-voucher-form", label: "Sale Vouchers", icon: "stock" },
          { id: "sale-voucher-list", label: "Voucher List", icon: "history" },
        ],
      },
      {
        label: "Cash",
        items: [
          { id: "cash-voucher-form", label: "Cash Voucher", icon: "stock" },
          {
            id: "cash-voucher-list",
            label: "Cash Voucher List",
            icon: "history",
          },
        ],
      },
      {
        label: "Customer Accounts",
        items: [
          { id: "customer-ledger", label: "Customer Ledger", icon: "history" },
          { id: "customer-balance", label: "Customer Balance", icon: "stock" },
        ],
      },
      {
        label: "Purchases",
        items: [
          { id: "purchase-voucher-form", label: "Purchase Bill", icon: "stock" },
          { id: "purchase-voucher-list", label: "Bill List", icon: "history" },
        ],
      },
      {
        label: "Supplier Accounts",
        items: [
          { id: "supplier-ledger", label: "Supplier Ledger", icon: "history" },
          { id: "supplier-balance", label: "Supplier Balance", icon: "stock" },
        ],
      },
    ],
  },
  { id: "settings", label: "Settings", children: [
    { id: "settings", label: "System Settings", icon: "settings" },
    { id: "raw-material-setup", label: "Raw Material Setup", icon: "settings" },
  ] },
  { id: "health", label: "Health", route: "health" },
  { id: "logs", label: "Logs", route: "logs" },
  { id: "workspace", label: "Workspace", route: "workspace" },
];

/* Which top entry is "active" for a given route */
const routeToTop: Partial<Record<AppRoute, string>> = {
  dashboard: "dashboard",
  "live-production": "scanning",
  "live-dispatch": "scanning",
  "live-return": "scanning",
  "store-home": "store-scanning",
  "munshi-home": "munshi",
  "munshi-stock": "munshi",
  "store-in-operator": "store-scanning",
  "store-in-new-material": "store-scanning",
  "store-in-qr-generator": "store-scanning",
  "store-in-scanner": "store-scanning",
  "store-in-stock": "store-scanning",
  "store-in-receipts": "store-scanning",
  "store-in-setup": "store-scanning",
  "store-out-operator": "store-scanning",
  "store-scanning": "store-scanning",
  "store-move-out": "store-scanning",
  gatepass: "gatepass",
  "gatepass-list": "gatepass",
  stock: "inventory",
  "raw-material": "inventory",
  "raw-material-qr-generator": "inventory",
  "raw-material-input": "store-scanning",
  "raw-material-output": "store-scanning",
  history: "inventory",
  "stock-history": "inventory",
  "daily-production": "inventory",
  "daily-dispatch": "inventory",
  "production-history": "inventory",
  "dispatch-history": "inventory",
  "return-history": "inventory",
  "party-list": "masters",
  "party-form": "masters",
  "customer-ledger": "billing",
  "customer-balance": "billing",
  "product-list": "masters",
  "product-form": "masters",
  "product-lists": "masters",
  "qr-generator": "masters",
  "qr-management": "masters",
  "qr-journey": "masters",
  "discount-policy": "masters",
  "sale-voucher-form": "billing",
  "sale-voucher-list": "billing",
  "purchase-voucher-form": "billing",
  "purchase-voucher-list": "billing",
  "supplier-ledger": "billing",
  "supplier-balance": "billing",
  "cash-voucher-form": "billing",
  "cash-voucher-list": "billing",
  settings: "settings",
  "raw-material-setup": "settings",
  health: "health",
  logs: "logs",
  workspace: "workspace",
};

interface NavbarUser {
  id: string;
  username: string;
  role: "USER" | "ADMIN";
}

interface NavbarProps {
  current: AppRoute;
  onSelect: (route: AppRoute) => void;
  appVersion: string;
  onBackup: () => void;
  user: NavbarUser | null;
  onProfile: () => void;
  onChangePassword: () => void;
  onLogout: () => void;
  permissions?: string[];
  limited?: boolean;
  accessRequests?: Array<{
    id: string;
    username: string;
    status: "PENDING" | "APPROVED" | "REJECTED";
  }>;
  roleOptions?: Array<{ code: string; name: string; permissions: string[] }>;
  onReviewAccessRequest?: (
    requestId: string,
    decision: "APPROVED" | "REJECTED",
    permissions?: string[],
    roleCode?: string,
  ) => void;
  permissionRequests?: Array<{
    id: string;
    userId: string;
    username: string;
    permissionCode: string;
    reason: string | null;
    status: "PENDING" | "APPROVED" | "REJECTED";
  }>;
  onReviewPermissionRequest?: (
    requestId: string,
    decision: "APPROVED" | "REJECTED",
  ) => void;
  notifications?: Array<{
    id: string;
    title: string;
    message: string;
    createdAt: string;
    readAt: string | null;
    kind?: string | null;
    entityId?: string | null;
    severity?: "INFO" | "WARNING" | "CRITICAL";
  }>;
  onNotificationClick?: (notification: {
    id: string;
    title: string;
    message: string;
    createdAt: string;
    readAt: string | null;
    kind?: string | null;
    entityId?: string | null;
    severity?: "INFO" | "WARNING" | "CRITICAL";
  }) => void;
  savedProfiles?: Array<{
    id: string;
    username: string;
    token: string;
    role: "USER" | "ADMIN";
    lastUsedAt?: string;
  }>;
  onSwitchProfile?: (token: string) => Promise<void> | void;
  onAddAccount?: () => void;
}

const permLabelMap: Record<string, string> = {};
for (const module of NAV_PERMISSION_MODULES) {
  permLabelMap[module.id] = module.label;
  for (const [childId, childLabel] of module.children) {
    permLabelMap[childId] = childLabel;
  }
}
const describePermission = (code: string) => permLabelMap[code] ?? code;

export const Navbar = ({
  current,
  onSelect,
  appVersion,
  onBackup,
  user,
  onProfile,
  onChangePassword,
  onLogout,
  permissions = [],
  limited = false,
  accessRequests = [],
  roleOptions = [],
  onReviewAccessRequest,
  permissionRequests = [],
  onReviewPermissionRequest,
  notifications = [],
  onNotificationClick,
  savedProfiles = [],
  onSwitchProfile,
  onAddAccount,
}: NavbarProps) => {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  /** The section the open flyout hangs off, so the portalled panel can be placed beside it. */
  const [menuAnchor, setMenuAnchor] = useState<DOMRect | null>(null);
  const [openProfile, setOpenProfile] = useState(false);
  const [openNotifications, setOpenNotifications] = useState(false);
  const [requestPermissions, setRequestPermissions] = useState<
    Record<string, string[]>
  >({});
  const [requestRoleCodes, setRequestRoleCodes] = useState<
    Record<string, string>
  >({});
  const [expandedRequests, setExpandedRequests] = useState<
    Record<string, boolean>
  >({});
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);
  const profileRef = useRef<HTMLDivElement | null>(null);
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const cancelMenuClose = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
  }, []);

  /**
   * One timer for every close, and scheduling cancels the pending one first.
   * A section and its portalled flyout both schedule closes as the pointer travels between
   * them; when two timers were live at once the overwritten id could never be cancelled, so
   * the flyout kept closing out from under the pointer.
   */
  const scheduleMenuClose = useCallback(() => {
    cancelMenuClose();
    hoverTimeoutRef.current = setTimeout(() => {
      hoverTimeoutRef.current = null;
      setOpenMenu(null);
      setOpenSubmenu(null);
    }, MENU_CLOSE_DELAY_MS);
  }, [cancelMenuClose]);

  /* Close dropdown when clicking outside. The flyout is portalled to <body>, so it is not
     inside the rail: without the .nav-dropdown check, pressing one of its rows unmounted the
     button on mousedown and the click never landed. */
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const insideFlyout =
        target instanceof Element && target.closest(".nav-dropdown") !== null;
      if (ref.current && !ref.current.contains(target) && !insideFlyout) {
        cancelMenuClose();
        setOpenMenu(null);
        setOpenSubmenu(null);
      }
      if (profileRef.current && !profileRef.current.contains(target)) {
        setOpenProfile(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [cancelMenuClose]);

  useEffect(() => cancelMenuClose, [cancelMenuClose]);

  const activeTop = routeToTop[current] ?? current;

  // Prune the nav tree down to routes the UI rebuild switchboard
  // (./visibleSections) currently has turned on, keeping only entries —
  // and dropdown items within them — that lead somewhere active.
  const activeNav: NavEntry[] = NAV.map((entry) => {
    const children = entry.children?.filter((child) => isRouteActive(child.id));
    const nestedChildren = entry.nestedChildren
      ?.map((group) => ({
        ...group,
        items: group.items.filter((item) => isRouteActive(item.id)),
      }))
      .filter((group) => group.items.length > 0);
    return { ...entry, children, nestedChildren };
  }).filter((entry) => {
    if (entry.route) return isRouteActive(entry.route);
    if (entry.children) return entry.children.length > 0;
    if (entry.nestedChildren) return entry.nestedChildren.length > 0;
    return false;
  });

  return (
    <nav className="navbar" ref={ref}>
      {/* Brand */}
      <div className="navbar-brand">
        <img
          src={BRAND_LOGO_URL}
          alt="777 Seven Logo"
          className="navbar-logo-img"
        />
        <button
          type="button"
          className={`navbar-grid-btn${current === "nav-page" ? " active" : ""}`}
          title="Navigation Home"
          aria-label="Navigation Home"
          onClick={() => onSelect("nav-page")}
        >
          <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="M5 3a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2V5a2 2 0 00-2-2H5zm0 8a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2v-2a2 2 0 00-2-2H5zm6-8a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2V5a2 2 0 00-2-2h-2zm0 8a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2v-2a2 2 0 00-2-2h-2z" />
          </svg>
        </button>
      </div>

      {/* Nav items */}
      <div className="navbar-nav">
        {!limited &&
          activeNav.filter((entry) => {
            if (user?.role === "ADMIN") return true;

            if (permissions.includes(entry.id)) return true;

            if (
              entry.children?.some((child) => permissions.includes(child.id))
            ) {
              return true;
            }

            if (
              entry.nestedChildren?.some((group) =>
                group.items.some(
                  (child) =>
                    permissions.includes(child.id) ||
                    child.permissionIds?.some((code) => permissions.includes(code)),
                ),
              )
            ) {
              return true;
            }

            return false;
          }).map((entry) => {
            const isActive = activeTop === entry.id;
            const isOpen = openMenu === entry.id;

            if (entry.route) {
              /* Direct link */
              return (
                <div className="nav-top-item" key={entry.id}>
                  <button
                    type="button"
                    className={`nav-top-btn${isActive ? " active" : ""}`}
                    onClick={() => {
                      onSelect(entry.route!);
                      setOpenMenu(null);
                    }}
                  >
                    <span className="nav-top-icon" aria-hidden="true">{SectionIcons[entry.id]}</span>
                    <span className="nav-top-label">{entry.label}</span>
                  </button>
                </div>
              );
            }

            /* Flat dropdown */
            if (entry.children) {
              return (
                <div
                  className={`nav-top-item${isOpen ? " open" : ""}`}
                  key={entry.id}
                  onMouseEnter={(event) => {
                    cancelMenuClose();
                    setMenuAnchor(event.currentTarget.getBoundingClientRect());
                    setOpenMenu(entry.id);
                  }}
                  onMouseLeave={scheduleMenuClose}
                >
                  <button
                    type="button"
                    className={`nav-top-btn${isActive ? " active" : ""}`}
                    onClick={(event) => {
                      setMenuAnchor(event.currentTarget.parentElement!.getBoundingClientRect());
                      setOpenMenu(isOpen ? null : entry.id);
                    }}
                  >
                    <span className="nav-top-icon" aria-hidden="true">{SectionIcons[entry.id]}</span>
                    <span className="nav-top-label">{entry.label}</span>
                    <ChevronDown />
                  </button>

                  {isOpen && (
                    <NavFlyout
                      anchor={menuAnchor}
                      onPointerEnter={cancelMenuClose}
                      onPointerLeave={scheduleMenuClose}
                    >
                      {entry.children!.map((child) => (
                        <button
                          key={child.id}
                          type="button"
                          className={`nav-dd-item${current === child.id ? " active" : ""}`}
                          onClick={() => {
                            onSelect(child.id as AppRoute);
                            setOpenMenu(null);
                          }}
                        >
                          {Icons[child.icon]}
                          {child.label}
                        </button>
                      ))}
                    </NavFlyout>
                  )}
                </div>
              );
            }

            /* Nested dropdown (Scanning) */
            if (entry.nestedChildren) {
              return (
                <div
                  className={`nav-top-item${isOpen ? " open" : ""}`}
                  key={entry.id}
                  onMouseEnter={(event) => {
                    cancelMenuClose();
                    setMenuAnchor(event.currentTarget.getBoundingClientRect());
                    setOpenMenu(entry.id);
                  }}
                  onMouseLeave={scheduleMenuClose}
                >
                  <button
                    type="button"
                    className={`nav-top-btn${isActive ? " active" : ""}`}
                    onClick={(event) => {
                      setMenuAnchor(event.currentTarget.parentElement!.getBoundingClientRect());
                      setOpenMenu(isOpen ? null : entry.id);
                    }}
                  >
                    <span className="nav-top-icon" aria-hidden="true">{SectionIcons[entry.id]}</span>
                    <span className="nav-top-label">{entry.label}</span>
                    <ChevronDown />
                  </button>

                  {isOpen && (
                    <NavFlyout
                      anchor={menuAnchor}
                      onPointerEnter={cancelMenuClose}
                      onPointerLeave={scheduleMenuClose}
                    >
                      {entry.nestedChildren.map((group, idx) => (
                        <div key={idx} className="nav-submenu-group">
                          <div className="nav-submenu-header">
                            {group.label}
                          </div>
                          <div className="nav-submenu">
                            {group.items.map((item) => (
                              <button
                                key={item.id}
                                type="button"
                                className={`nav-dd-item${current === item.id ? " active" : ""}`}
                                onClick={() => {
                                  onSelect(item.id as AppRoute);
                                  setOpenMenu(null);
                                  setOpenSubmenu(null);
                                }}
                              >
                                {Icons[item.icon]}
                                {item.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </NavFlyout>
                  )}
                </div>
              );
            }

            return null;
          })}
      </div>

      {/* Right side */}
      <div className="navbar-right">
        <span className="navbar-version">{appVersion}</span>
        {user && (
          <div className="notification-menu-wrap">
            <button
              type="button"
              className="notification-trigger"
              aria-label="Access requests"
              title="Access requests"
              aria-expanded={openNotifications}
              onClick={() => setOpenNotifications((value) => !value)}
            >
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Zm-8 12h4"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
              {accessRequests.filter((request) => request.status === "PENDING")
                .length +
                permissionRequests.filter((pr) => pr.status === "PENDING").length +
                notifications.filter((notification) => !notification.readAt)
                  .length >
                0 && (
                <span className="notification-badge">
                  {accessRequests.filter(
                    (request) => request.status === "PENDING",
                  ).length +
                    permissionRequests.filter((pr) => pr.status === "PENDING").length +
                    notifications.filter((notification) => !notification.readAt)
                      .length}
                </span>
              )}
            </button>
            {openNotifications && (
              <div className="notification-panel">
                <div className="notification-panel-title">Notifications</div>
                {notifications.map((notification) => (
                  <div
                    className={`user-notification${notification.readAt ? " read" : ""}${notification.severity === "CRITICAL" ? " is-critical" : notification.severity === "WARNING" ? " is-warning" : ""}`}
                    key={notification.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onNotificationClick?.(notification)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onNotificationClick?.(notification);
                      }
                    }}
                  >
                    <strong>
                      {notification.severity === "CRITICAL" ? "⚠ " : ""}
                      {notification.title}
                    </strong>
                    <span>{notification.message}</span>
                  </div>
                ))}{" "}
                {user.role === "ADMIN" && (accessRequests.length > 0 || permissionRequests.length > 0) && (
                  <div className="notification-panel-title notification-panel-subtitle">
                    Access Requests
                  </div>
                )}
                {accessRequests.map((request) => (
                  <div className="access-request" key={request.id}>
                    <div className="access-request-head">
                      <strong>{request.username}</strong>
                      <span
                        className={`access-request-status ${request.status.toLowerCase()}`}
                      >
                        {request.status}
                      </span>
                    </div>
                    {request.status === "PENDING" && onReviewAccessRequest && (
                      <>
                        <label className="member-role-field" style={{ margin: "8px 0", display: "block" }}>
                          <span style={{ fontSize: "12px", color: "var(--text-3)", display: "block", marginBottom: "4px" }}>Role</span>
                          <select
                            value={requestRoleCodes[request.id] ?? ""}
                            onChange={(event) => {
                              const nextCode = event.target.value;
                              setRequestRoleCodes((current) => ({
                                ...current,
                                [request.id]: nextCode,
                              }));
                              const nextRole = roleOptions.find((role) => role.code === nextCode);
                              if (nextRole) {
                                setRequestPermissions((current) => ({
                                  ...current,
                                  [request.id]: [...nextRole.permissions],
                                }));
                              }
                            }}
                            style={{
                              width: "100%",
                              padding: "6px 10px",
                              borderRadius: "8px",
                              border: "1px solid #e5e7eb",
                              fontSize: "13px",
                              background: "var(--white)",
                            }}
                          >
                            <option value="">Select a role…</option>
                            {roleOptions.map((role) => (
                              <option value={role.code} key={role.code}>
                                {role.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          style={{
                            width: "100%",
                            marginBottom: "8px",
                            fontSize: "12px",
                            color: "#4b5563",
                          }}
                          onClick={() =>
                            setExpandedRequests((current) => ({
                              ...current,
                              [request.id]: !current[request.id],
                            }))
                          }
                        >
                          {expandedRequests[request.id]
                            ? "▾ Additional Access (override)"
                            : "▸ Additional Access (override)"}
                        </button>
                        {expandedRequests[request.id] && (
                          <div
                            className="permission-selector"
                            style={{
                              background: "var(--surface-faint)",
                              padding: "10px",
                              borderRadius: "8px",
                              marginBottom: "8px",
                            }}
                          >
                            {NAV_PERMISSION_MODULES.map((module) => {
                              const hasChildren = module.children.length > 0;
                              const moduleEnabled =
                                (requestPermissions[request.id] ?? []).includes(
                                  module.id,
                                ) ||
                                module.children.some(([childId]) =>
                                  (requestPermissions[request.id] ?? []).includes(
                                    childId,
                                  ),
                                );
                              return (
                                <div
                                  key={module.id}
                                  style={{ marginBottom: "4px" }}
                                >
                                  <label
                                    style={{
                                      display: "flex",
                                      alignItems: "center",
                                      gap: "6px",
                                      fontSize: "12px",
                                    }}
                                  >
                                    <span
                                      style={{
                                        fontWeight: hasChildren
                                          ? 600
                                          : 400,
                                      }}
                                    >
                                      {module.label}
                                    </span>
                                    {!hasChildren && (
                                      <input
                                        type="checkbox"
                                        checked={(
                                          requestPermissions[request.id] ?? []
                                        ).includes(module.id)}
                                        onChange={(event) =>
                                          setRequestPermissions(
                                            (current) => ({
                                              ...current,
                                              [request.id]: event.target.checked
                                                ? [
                                                    ...new Set([
                                                      ...(current[
                                                        request.id
                                                      ] ?? []),
                                                      module.id,
                                                    ]),
                                                  ]
                                                : (current[request.id] ??
                                                    []
                                                  ).filter(
                                                    (item) =>
                                                      item !== module.id,
                                                  ),
                                            }),
                                          )
                                        }
                                      />
                                    )}
                                  </label>
                                  {hasChildren && (
                                    <div
                                      style={{
                                        paddingLeft: "16px",
                                        display: "grid",
                                        gridTemplateColumns: "1fr 1fr",
                                        gap: "2px 12px",
                                      }}
                                    >
                                      {module.children.map(
                                        ([childId, childLabel]) => (
                                          <label
                                            key={childId}
                                            style={{
                                              display: "flex",
                                              alignItems: "center",
                                              gap: "4px",
                                              fontSize: "11px",
                                              color: "#4b5563",
                                            }}
                                          >
                                            <input
                                              type="checkbox"
                                              checked={(
                                                requestPermissions[
                                                  request.id
                                                ] ?? []
                                              ).includes(childId)}
                                              onChange={(event) =>
                                                setRequestPermissions(
                                                  (current) => ({
                                                    ...current,
                                                    [request.id]: event.target
                                                      .checked
                                                      ? [
                                                          ...new Set([
                                                            ...(current[
                                                              request.id
                                                            ] ?? []),
                                                            childId,
                                                          ]),
                                                        ]
                                                      : (current[
                                                          request.id
                                                        ] ?? []
                                                      ).filter(
                                                        (item) =>
                                                          item !== childId,
                                                      ),
                                                  }),
                                                )
                                              }
                                            />
                                            {childLabel}
                                          </label>
                                        ),
                                      )}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                        <div className="access-request-actions">
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            onClick={() =>
                              onReviewAccessRequest(
                                request.id,
                                "APPROVED",
                                requestPermissions[request.id] ?? [],
                                requestRoleCodes[request.id] || undefined,
                              )
                            }
                          >
                            Approve Access
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() =>
                              onReviewAccessRequest(
                                request.id,
                                "REJECTED",
                                requestPermissions[request.id] ?? [],
                                requestRoleCodes[request.id] || undefined,
                              )
                            }
                          >
                            Reject Access
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
                {user.role === "ADMIN" && permissionRequests.length > 0 && (
                  <div className="notification-panel-title notification-panel-subtitle">
                    Permission Requests
                  </div>
                )}
                {permissionRequests.map((pr) => (
                  <div className="access-request" key={pr.id}>
                    <div className="access-request-head">
                      <div>
                        <strong>{pr.username}</strong>
                        <div
                          style={{
                            fontSize: "12px",
                            color: "#4b5563",
                            marginTop: "2px",
                          }}
                        >
                          needs <strong>{describePermission(pr.permissionCode)}</strong>
                        </div>
                        {pr.reason && (
                          <div
                            style={{
                              fontSize: "11px",
                              color: "var(--text-3)",
                              marginTop: "4px",
                              fontStyle: "italic",
                            }}
                          >
                            “{pr.reason}”
                          </div>
                        )}
                      </div>
                      <span
                        className={`access-request-status ${pr.status.toLowerCase()}`}
                      >
                        {pr.status}
                      </span>
                    </div>
                    {pr.status === "PENDING" && onReviewPermissionRequest && (
                      <div className="access-request-actions">
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          onClick={() =>
                            onReviewPermissionRequest(pr.id, "APPROVED")
                          }
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() =>
                            onReviewPermissionRequest(pr.id, "REJECTED")
                          }
                        >
                          Reject
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={onBackup}
          title="Create Backup (Ctrl+B)"
        >
          Backup
        </button>
        {user && (
          <div className="profile-menu-wrap" ref={profileRef}>
            <button
              type="button"
              className="profile-menu-trigger"
              onClick={() => setOpenProfile((prev) => !prev)}
              aria-label="Open user menu"
              aria-expanded={openProfile}
              aria-haspopup="menu"
            >
              <span className="profile-menu-icon">
                <UserIcon />
              </span>
              <span className="profile-menu-name">{user.username}</span>
              <ChevronDown />
            </button>
            {openProfile && (
              <div className="profile-menu" role="menu" style={{ width: 235, padding: "8px" }}>
                <div style={{ padding: "4px 8px 8px", borderBottom: "1px solid var(--chrome-line)", marginBottom: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="profile-menu-icon" style={{ width: 28, height: 28 }}>
                      <UserIcon />
                    </span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: "0.84rem", color: "var(--chrome-ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {user.username}
                      </div>
                      <div style={{ fontSize: "0.68rem", color: "var(--chrome-muted)", fontWeight: 600 }}>
                        {user.role === "ADMIN" ? "Administrator" : "Standard User"}
                      </div>
                    </div>
                  </div>
                </div>

                <div style={{ padding: "4px 8px 3px", fontSize: "0.68rem", fontWeight: 700, color: "var(--chrome-link-strong)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Switch Profile
                </div>
                
                <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 6 }}>
                  {savedProfiles && savedProfiles.length > 0 ? (
                    savedProfiles.map((p) => {
                      const isCurrent = p.id === user.id || p.username.toLowerCase() === user.username.toLowerCase();
                      return (
                        <button
                          key={p.id || p.token}
                          type="button"
                          className={`nav-dd-item ${isCurrent ? "active" : ""}`}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            padding: "6px 8px",
                            fontSize: "0.78rem",
                            borderRadius: 8,
                            opacity: isCurrent ? 1 : 0.85,
                          }}
                          onClick={() => {
                            if (!isCurrent && onSwitchProfile) {
                              void onSwitchProfile(p.token);
                            }
                            setOpenProfile(false);
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                            <span
                              style={{
                                width: 20,
                                height: 20,
                                borderRadius: "50%",
                                background: isCurrent ? "var(--chrome-link)" : "var(--neutral-300)",
                                color: "var(--white)",
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "center",
                                fontSize: "0.65rem",
                                fontWeight: 700,
                                flexShrink: 0,
                              }}
                            >
                              {p.username.slice(0, 1).toUpperCase()}
                            </span>
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: isCurrent ? 700 : 500 }}>
                              {p.username}
                            </span>
                          </div>
                          {isCurrent ? (
                            <span style={{ fontSize: "0.64rem", color: "var(--chrome-link-strong)", fontWeight: 700, background: "rgba(49,130,206,0.12)", padding: "1px 6px", borderRadius: 999 }}>Active</span>
                          ) : (
                            <span style={{ fontSize: "0.64rem", color: "var(--chrome-muted)" }}>Switch</span>
                          )}
                        </button>
                      );
                    })
                  ) : null}

                  {onAddAccount && (
                    <button
                      type="button"
                      className="nav-dd-item"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "6px 8px",
                        fontSize: "0.76rem",
                        color: "var(--chrome-link-strong)",
                        fontWeight: 600,
                      }}
                      onClick={() => {
                        onAddAccount();
                        setOpenProfile(false);
                      }}
                    >
                      <span style={{ fontSize: "0.9rem", fontWeight: 700 }}>+</span> Add Account
                    </button>
                  )}
                </div>

                <div style={{ borderTop: "1px solid var(--chrome-line)", margin: "4px 0" }} />

                <button
                  type="button"
                  className="profile-menu-item"
                  onClick={() => {
                    onProfile();
                    setOpenProfile(false);
                  }}
                >
                  Profile & Roles
                </button>
                <button
                  type="button"
                  className="profile-menu-item"
                  onClick={() => {
                    onChangePassword();
                    setOpenProfile(false);
                  }}
                >
                  Change Password
                </button>
                <button
                  type="button"
                  className="profile-menu-item danger"
                  onClick={() => {
                    onLogout();
                    setOpenProfile(false);
                  }}
                >
                  Logout
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </nav>
  );
};
