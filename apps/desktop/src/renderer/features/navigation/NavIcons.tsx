import React from "react";
import type { NavIconId, NavSectionId } from "./navCatalogue";

// Pictures for Home tiles and sidebar sections. Decorative only — the label beside each one
// is what is read (R18) — so every svg is aria-hidden. Stroke icons on a 24px grid, drawn in
// currentColor so the tile or rail decides the colour.

const Svg = ({ children }: { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const NAV_ICONS: Record<NavIconId, React.ReactNode> = {
  dashboard: <Svg><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /></Svg>,
  workspace: <Svg><rect x="3.3" y="4" width="17.4" height="16" rx="2.2" /><path d="M3.3 9h17.4M9.5 9v11" /></Svg>,
  scan: <Svg><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" /><path d="M7 8v8M10.5 8v8M14 8v8M17 8v8" /></Svg>,
  dispatch: <Svg><path d="M5 12h14M12 5l7 7-7 7" /></Svg>,
  return: <Svg><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></Svg>,
  store: <Svg><path d="M3.5 9.5 12 3.5l8.5 6" /><path d="M5 9.8V20h14V9.8" /><path d="M9 20v-5.5h6V20" /></Svg>,
  voucher: <Svg><path d="M6 3.5h8l4.5 4.5v12.5H6V3.5z" /><path d="M13.8 3.7V8.3h4.6M9 14l2.2 2.2L15.4 12" /></Svg>,
  stock: <Svg><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22V12" /></Svg>,
  history: <Svg><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></Svg>,
  daily: <Svg><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></Svg>,
  party: <Svg><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></Svg>,
  product: <Svg><path d="m7.5 4.27 9 5.15M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /></Svg>,
  qr: <Svg><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3h-3zM21 14v3M18 21h3M14 21h.01" /></Svg>,
  cash: <Svg><rect x="2" y="6" width="20" height="12" rx="2" /><circle cx="12" cy="12" r="2" /><path d="M6 12h.01M18 12h.01" /></Svg>,
  ledger: <Svg><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" /><path d="M8 7h6M8 11h8" /></Svg>,
  balance: <Svg><path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" /><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" /><path d="M7 21h10M12 3v18M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2" /></Svg>,
  purchase: <Svg><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z" /><path d="M3 6h18" /><path d="M16 10a4 4 0 0 1-8 0" /></Svg>,
  settings: <Svg><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></Svg>,
  health: <Svg><path d="M3 12.5h4l2-5 3.5 10.5 3-8 1.8 2.5H21" /></Svg>,
  logs: <Svg><rect x="4" y="3.5" width="16" height="17" rx="2.2" /><path d="M8 8h8M8 12h8M8 16h5" /></Svg>,
  machine: <Svg><rect x="3" y="5" width="18" height="13" rx="2.2" /><rect x="6" y="8" width="7" height="5" rx="1" /><path d="M16.5 8.5v4M6 21h3M15 21h3M7.5 18v3M16.5 18v3" /></Svg>,
};

/** The picture beside each section in the sidebar. */
export const SECTION_ICONS: Record<NavSectionId, React.ReactNode> = {
  overview: NAV_ICONS.dashboard,
  scanning: NAV_ICONS.scan,
  store: NAV_ICONS.store,
  munshi: NAV_ICONS.ledger,
  gatepass: NAV_ICONS.voucher,
  machineProgram: NAV_ICONS.machine,
  inventory: NAV_ICONS.stock,
  masters: NAV_ICONS.product,
  billing: NAV_ICONS.cash,
  system: NAV_ICONS.settings,
};

export const HOME_ICON = NAV_ICONS.dashboard;
