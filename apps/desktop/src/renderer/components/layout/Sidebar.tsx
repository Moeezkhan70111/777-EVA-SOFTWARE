import React from "react";

export type AppRoute =
  | "dashboard"
  | "production"
  | "inventory"
  | "products"
  | "history"
  | "reports"
  | "settings"
  | "health"
  | "logs";

// ─── SVG Icons (inline, no external dep) ─────────────────────────────────────
const Icon = {
  dashboard: (
    <svg className="nav-icon" viewBox="0 0 20 20" fill="currentColor">
      <path d="M2 3a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H3a1 1 0 01-1-1V3zm9 0a1 1 0 011-1h5a1 1 0 011 1v2a1 1 0 01-1 1h-5a1 1 0 01-1-1V3zm0 6a1 1 0 011-1h5a1 1 0 011 1v8a1 1 0 01-1 1h-5a1 1 0 01-1-1V9zM2 11a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H3a1 1 0 01-1-1v-6z" />
    </svg>
  ),
  production: (
    <svg className="nav-icon" viewBox="0 0 20 20" fill="currentColor">
      <path d="M2 4a2 2 0 012-2h12a2 2 0 012 2v1a1 1 0 01-1 1H3a1 1 0 01-1-1V4zm1 3h14v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7zm4 2a1 1 0 000 2h6a1 1 0 100-2H7zm0 3a1 1 0 000 2h4a1 1 0 100-2H7z" />
    </svg>
  ),
  inventory: (
    <svg className="nav-icon" viewBox="0 0 20 20" fill="currentColor">
      <path d="M4 3a2 2 0 100 4h12a2 2 0 100-4H4zm-2 6a1 1 0 011-1h14a1 1 0 011 1v7a2 2 0 01-2 2H5a2 2 0 01-2-2V9zm5 2a1 1 0 100 2h4a1 1 0 100-2H7z" />
    </svg>
  ),
  products: (
    <svg className="nav-icon" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M10 2a4 4 0 00-4 4v1H5a1 1 0 00-.994.89l-1 9A1 1 0 004 18h12a1 1 0 00.994-1.11l-1-9A1 1 0 0015 7h-1V6a4 4 0 00-4-4zm2 5V6a2 2 0 10-4 0v1h4zm-6 3a1 1 0 112 0 1 1 0 01-2 0zm7-1a1 1 0 100 2 1 1 0 000-2z" clipRule="evenodd" />
    </svg>
  ),
  history: (
    <svg className="nav-icon" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
    </svg>
  ),
  reports: (
    <svg className="nav-icon" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M6 2a2 2 0 00-2 2v12a2 2 0 002 2h8a2 2 0 002-2V7.414A2 2 0 0015.414 6L12 2.586A2 2 0 0010.586 2H6zm2 10a1 1 0 10-2 0v3a1 1 0 102 0v-3zm4-1a1 1 0 011 1v3a1 1 0 11-2 0v-3a1 1 0 011-1zm-2-6a1 1 0 10-2 0v6a1 1 0 102 0V5z" clipRule="evenodd" />
    </svg>
  ),
  settings: (
    <svg className="nav-icon" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
    </svg>
  ),
  health: (
    <svg className="nav-icon" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z" clipRule="evenodd" />
    </svg>
  ),
  logs: (
    <svg className="nav-icon" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd" />
    </svg>
  ),
};

interface NavItem {
  id: AppRoute;
  label: string;
  shortcut: string;
  group: "main" | "ops" | "system";
}

const items: NavItem[] = [
  { id: "dashboard",  label: "Dashboard",  shortcut: "F1", group: "main" },
  { id: "production", label: "Production", shortcut: "F2", group: "main" },
  { id: "inventory",  label: "Inventory",  shortcut: "F3", group: "main" },
  { id: "products",   label: "Products",   shortcut: "F4", group: "main" },
  { id: "reports",    label: "Reports",    shortcut: "F5", group: "ops" },
  { id: "history",    label: "History",    shortcut: "F6", group: "ops" },
  { id: "settings",   label: "Settings",   shortcut: "F7", group: "system" },
  { id: "health",     label: "Health",     shortcut: "F8", group: "system" },
  { id: "logs",       label: "Logs",       shortcut: "—",  group: "system" },
];

const groups: Array<{ id: "main" | "ops" | "system"; label: string }> = [
  { id: "main",   label: "Operations" },
  { id: "ops",    label: "Analytics" },
  { id: "system", label: "System" },
];

export const Sidebar = ({
  current,
  onSelect,
}: {
  current: AppRoute;
  onSelect: (route: AppRoute) => void;
}) => {
  return (
    <aside className="sidebar">
      {/* Brand */}
      <div className="sidebar-brand">
        <div className="sidebar-logo">7</div>
        <div className="sidebar-brand-text">
          <span className="sidebar-title">777 ERP</span>
          <span className="sidebar-subtitle">Manufacturing</span>
        </div>
      </div>

      {/* Nav */}
      <nav className="sidebar-nav">
        {groups.map((group) => {
          const groupItems = items.filter((i) => i.group === group.id);
          return (
            <div key={group.id}>
              <div className="sidebar-section-label">{group.label}</div>
              {groupItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`nav-item${current === item.id ? " active" : ""}`}
                  onClick={() => onSelect(item.id)}
                  title={`${item.label} (${item.shortcut})`}
                >
                  {Icon[item.id]}
                  <span className="nav-label">{item.label}</span>
                  <span className="nav-shortcut">{item.shortcut}</span>
                </button>
              ))}
            </div>
          );
        })}
      </nav>
    </aside>
  );
};
