import React from "react";
import type { AppRoute } from "../app/routes";

interface NavPageProps {
  onNavigate: (route: AppRoute) => void;
  permissions: string[];
  isAdmin: boolean;
}

interface NavTile {
  route: AppRoute;
  label: string;
  description: string;
  icon: React.ReactNode;
  color: string;
  permission?: string;
  anyPermission?: string[];
}

interface NavSection {
  label: string;
  tiles: NavTile[];
}

// ── SVG Icons ─────────────────────────────────────────────────────────────────
const Icon = {
  dashboard: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>,
  scan:      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><line x1="3" y1="12" x2="21" y2="12"/></svg>,
  dispatch:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>,
  return_:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>,
  stock:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>,
  history:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>,
  voucher:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8M10 9H8"/></svg>,
  cash:      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/></svg>,
  ledger:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/><path d="M8 7h6M8 11h8"/></svg>,
  balance:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10M12 3v18M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/></svg>,
  purchase:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>,
  party:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
  product:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m7.5 4.27 9 5.15M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/></svg>,
  qr:        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM21 14v3M18 21h3M14 21h.01"/></svg>,
  settings:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>,
  daily:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>,
  workspace: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>,
  store:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4"/><path d="M2 7h20"/><path d="M22 7v3a2 2 0 0 1-2 2a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 16 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 12 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 8 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 4 12a2 2 0 0 1-2-2V7"/></svg>,
};

const SECTIONS: NavSection[] = [
  {
    label: "Operations",
    tiles: [
      { route: "dashboard",        label: "Dashboard",          description: "KPIs & overview",          icon: Icon.dashboard, color: "#3b82f6", permission: "dashboard" },
      { route: "live-production",  label: "Live Production",    description: "Scan & record production", icon: Icon.scan,      color: "#10b981", permission: "live-production" },
      { route: "live-dispatch",    label: "Live Dispatch",      description: "Dispatch scanning",        icon: Icon.dispatch,  color: "#6366f1", permission: "live-dispatch" },
      { route: "live-return",      label: "Return Scanning",    description: "Process returns",          icon: Icon.return_,   color: "#f59e0b", permission: "live-return" },
      { route: "store-home",       label: "Store Station",      description: "Finished goods store",     icon: Icon.store,     color: "#8b5cf6", permission: "store-scanning" },
      { route: "munshi-home",      label: "Munshi Station",     description: "Gatepass desk",            icon: Icon.voucher,   color: "#8b5cf6", permission: "munshi" },
    ],
  },
  {
    label: "Inventory",
    tiles: [
      { route: "stock",             label: "Current Stock",      description: "Live inventory levels",    icon: Icon.stock,    color: "#0ea5e9", permission: "stock" },
      { route: "daily-production",  label: "Daily Production",   description: "Production log",           icon: Icon.daily,    color: "#10b981", permission: "daily-production" },
      { route: "daily-dispatch",    label: "Daily Dispatch",     description: "Dispatch log",             icon: Icon.daily,    color: "#6366f1", permission: "daily-dispatch" },
      { route: "production-history",label: "Production History", description: "Full production record",   icon: Icon.history,  color: "#64748b", permission: "production-history" },
      { route: "dispatch-history",  label: "Dispatch History",   description: "Full dispatch record",     icon: Icon.history,  color: "#64748b", permission: "dispatch-history" },
    ],
  },
  {
    label: "Billing",
    tiles: [
      { route: "sale-voucher-form",    label: "Sale Vouchers",    description: "Create & manage bills",   icon: Icon.voucher,  color: "#ef4444", permission: "sale-voucher-form" },
      { route: "cash-voucher-form",    label: "Cash Voucher",     description: "Record receipts / payments", icon: Icon.cash, color: "#10b981", permission: "cash-voucher-form" },
      { route: "customer-ledger",      label: "Customer Ledger",  description: "Per-customer transactions", icon: Icon.ledger, color: "#3b82f6", permission: "customer-ledger" },
      { route: "customer-balance",     label: "Customer Balance", description: "All balances at a glance",  icon: Icon.balance,color: "#8b5cf6", permission: "customer-balance" },
      { route: "purchase-voucher-form",label: "Purchase Bill",    description: "Record supplier bills",   icon: Icon.purchase, color: "#f59e0b", permission: "purchase-voucher-form" },
    ],
  },
  {
    label: "Setup",
    tiles: [
      { route: "party-list",       label: "Party List",     description: "Customers & suppliers",    icon: Icon.party,    color: "#0ea5e9", permission: "party-list" },
      { route: "product-list",     label: "Products",       description: "Article & size catalogue", icon: Icon.product,  color: "#10b981", permission: "product-list" },
      { route: "qr-generator",label: "QR Generator",   description: "Generate product QR codes",icon: Icon.qr,  color: "#6366f1", permission: "qr-generator" },
      { route: "workspace",        label: "Workspace",      description: "Tasks, messages & activity",icon: Icon.workspace,color: "#64748b" },
      { route: "settings",         label: "Settings",       description: "System configuration",     icon: Icon.settings, color: "#94a3b8", permission: "settings" },
    ],
  },
];

export const NavPage: React.FC<NavPageProps> = ({ onNavigate, permissions, isAdmin }) => {
  const can = (tile: NavTile) => {
    if (isAdmin) return true;
    if (!tile.permission && !tile.anyPermission) return true;
    if (tile.permission && permissions.includes(tile.permission)) return true;
    if (tile.anyPermission && tile.anyPermission.some((p) => permissions.includes(p))) return true;
    return false;
  };

  return (
    <div className="nav-page">
      <div className="nav-page-header">
        <h1>Navigation</h1>
        <p>Select a section to get started</p>
      </div>

      {SECTIONS.map((section) => {
        const visible = section.tiles.filter(can);
        if (visible.length === 0) return null;
        return (
          <div key={section.label} className="nav-page-section">
            <h2 className="nav-page-section-label">{section.label}</h2>
            <div className="nav-page-grid">
              {visible.map((tile) => (
                <button
                  key={tile.route}
                  type="button"
                  className="nav-tile"
                  onClick={() => onNavigate(tile.route)}
                  style={{ "--tile-color": tile.color } as React.CSSProperties}
                >
                  <div className="nav-tile-icon">{tile.icon}</div>
                  <div className="nav-tile-body">
                    <strong>{tile.label}</strong>
                    <span>{tile.description}</span>
                  </div>
                  <div className="nav-tile-arrow">›</div>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
};
