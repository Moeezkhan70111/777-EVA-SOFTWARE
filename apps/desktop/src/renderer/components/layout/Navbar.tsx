import React, { useRef } from "react";
import type { AppRoute } from "../../app/routes";
import { BRAND_LOGO_URL } from "../../config/branding";
import { copy } from "../../config/copy";
import type { AuthUser } from "../../types/desktopApi";
import { RAIL_ICONS } from "../../features/navigation/NavIcons";
import { RailLink } from "../../features/navigation/RailLink";
import { SidebarNav } from "../../features/navigation/SidebarNav";
import { useRailTooltip } from "../../features/navigation/useRailTooltip";
import { useSidebarRail, useSlimRailScroll } from "../../features/navigation/useSidebarRail";
import { SyncStatusIndicator } from "../../features/sync/SyncStatusIndicator";

// Every permission an administrator can give a role or a user (Profile & Roles). A page the
// user holds the permission for appears as a card on their Home and as a row in the sidebar
// (features/navigation/navCatalogue.ts).
//
// "navbar" is no longer offered: every role now has the sidebar. Rows that still hold it in
// the database are harmless and are left untouched.
export const NAV_PERMISSION_MODULES = [
  {
    id: "dashboard",
    label: "Business Overview (KPIs)",
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
      ["stock.upper.view", "Upper Stock"],
      ["stock.dana.view", "Dana Stock"],
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
    ],
  },
  {
    // A page of its own (not under Inventory), the same as in the sidebar.
    id: "machine-program",
    label: "Machine Program",
    children: [],
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
      ["supplier-ledger", "Supplier Ledger"],
      ["supplier-balance", "Supplier Balance"],
      ["contractor-ledger", "Contractor Ledger"],
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
] as const;

interface NavbarProps {
  current: AppRoute;
  onSelect: (route: AppRoute) => void;
  appVersion: string;
  onBackup: () => void;
  /** The signed-in user. The sidebar lists only the pages their role has been given. */
  user: AuthUser | null;
  /** Pages this computer does not offer whatever the role: the ledgers, off the Accounts holder. */
  hiddenRoutes?: ReadonlySet<AppRoute>;
}

// THE SIDEBAR: slim by default — one picture per row, no logo — and open on hover, on keyboard
// focus, or for good once pinned (useSidebarRail). Its panel always lies over the page; the outer
// box is what the page makes room for: the slim width, or the open width once pinned. So hovering
// never moves the page, and pinning moves it once.
//
// The logo shows here only while the rail is open; slim, the page header carries it (PageHeader).
//
// Navigation and the rail's own foot only: whether this computer is sharing its work, Backup,
// the pin, the version. The bell and the profile are top right of the page (HeaderActions), where
// the Store page header puts them.

export const Navbar = ({ current, onSelect, appVersion, onBackup, user, hiddenRoutes }: NavbarProps) => {
  const rail = useSidebarRail();
  const tips = useRailTooltip(!rail.expanded);
  const { onMouseLeave } = rail.railHandlers;
  const panel = useRef<HTMLDivElement>(null);
  useSlimRailScroll(panel, rail.expanded, current);

  return (
    <div className={`navbar${rail.expanded ? " is-expanded" : ""}${rail.pinned ? " is-pinned" : ""}`}>
      <div
        ref={panel}
        className="navbar-panel"
        {...rail.railHandlers}
        onMouseOver={tips.onMouseOver}
        onMouseLeave={() => {
          tips.hide();
          onMouseLeave();
        }}
      >
        <div className="navbar-brand">
          <img src={BRAND_LOGO_URL} alt={copy.app.brandLine} className="navbar-logo-img" />
        </div>

        {/* Home and the pages this user's role has been given — the same cards Home shows. */}
        {user && <SidebarNav user={user} current={current} onSelect={onSelect} hiddenRoutes={hiddenRoutes} />}

        <div className="navbar-foot">
          {/* Whether this computer is sharing its work with the others, in four words
              (features/sync/syncHealth.ts). */}
          {user && <SyncStatusIndicator onOpenSettings={() => onSelect("settings")} />}
          <RailLink icon={RAIL_ICONS.backup} label={copy.nav.rail.backup} tip={copy.nav.rail.backupHint} onClick={onBackup} />
          <RailLink icon={RAIL_ICONS.pin} label={copy.nav.rail.pin} pressed={rail.pinned} className="nav-pin" onClick={rail.togglePinned} />
          <span className="navbar-version" data-tip={copy.nav.rail.version(appVersion)}>
            {appVersion}
          </span>
        </div>
      </div>
      {tips.tooltip}
    </div>
  );
};
