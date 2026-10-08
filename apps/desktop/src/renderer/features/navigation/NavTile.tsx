import React from "react";
import type { AppRoute } from "../../app/routes";
import type { NavItem, NavTone } from "./navCatalogue";
import { NAV_ICONS } from "./NavIcons";

// One Home card. The whole card is the button, so its accessible name is the page's label and
// one-line description. Colour comes from the section's tone class in theme.css (R3).

interface NavTileProps {
  item: NavItem;
  tone: NavTone;
  onSelect: (route: AppRoute) => void;
}

export const NavTile: React.FC<NavTileProps> = ({ item, tone, onSelect }) => (
  <button
    type="button"
    className={`nav-tile nav-tile--${tone}`}
    onClick={() => onSelect(item.route)}
    data-testid={`nav-tile-${item.route}`}
  >
    <span className="nav-tile-icon">{NAV_ICONS[item.icon]}</span>
    <span className="nav-tile-body">
      <strong>{item.label}</strong>
      <span>{item.line}</span>
    </span>
    <span className="nav-tile-arrow" aria-hidden="true">›</span>
  </button>
);
