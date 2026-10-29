import React from "react";
import type { AppRoute } from "../../app/routes";
import { copy } from "../../config/copy";
import { STORE_LANDING_ROUTE } from "../auth/session";
import { isStoreRoute } from "../store/page/storeTabs";
import { NAV_ICONS } from "./NavIcons";
import { RailLink } from "./RailLink";

// The sidebar for a store operator (0.3.9): one row, Store. Receiving and Issuing are the page's own
// switch, and its sections are its own tabs, so there is nothing more to list here. Everything else
// the account may open stays on Home (F1).

interface StoreNavProps {
  current: AppRoute;
  onSelect: (route: AppRoute) => void;
}

export const StoreNav: React.FC<StoreNavProps> = ({ current, onSelect }) => (
  <div className="navbar-nav" role="navigation" aria-label={copy.nav.railLabel}>
    <RailLink
      icon={NAV_ICONS.store}
      label={copy.nav.items.storeHome.label}
      active={isStoreRoute(current)}
      onClick={() => onSelect(STORE_LANDING_ROUTE)}
    />
  </div>
);
