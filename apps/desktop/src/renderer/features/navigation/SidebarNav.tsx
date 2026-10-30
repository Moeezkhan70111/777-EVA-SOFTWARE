import React, { useState } from "react";
import type { AppRoute } from "../../app/routes";
import { copy } from "../../config/copy";
import type { AuthUser } from "../../types/desktopApi";
import { HOME_ROUTE, landingRoute } from "../auth/session";
import type { StoreDirection } from "../store/storeOperators";
import { STORE_STATION_ROUTE } from "../store/useStoreJob";
import { isNavItemActive, visibleNavSections, type NavSection, type NavSectionId } from "./navCatalogue";
import { HOME_ICON, SECTION_ICONS } from "./NavIcons";
import { RailLink } from "./RailLink";
import { StoreJobNav } from "./StoreJobNav";

// The sidebar's list: Home, then the same cards Home shows, as rows under their section.
// Each section folds open and shut from its heading so a role with many pages can keep the
// rail short; the rows are plain buttons in the rail (no hover flyouts), which also works
// for touch. A standalone section (Machine Program) is one top-level row, like Home.
//
// A store operator gets a different rail (StoreJobNav): only Select Job until they pick a job,
// then that job and its pages.

interface SidebarNavProps {
  user: AuthUser;
  current: AppRoute;
  onSelect: (route: AppRoute) => void;
  /** The job a store operator has picked (useStoreJob); null before they pick one. */
  storeJob?: StoreDirection | null;
  /** Pages this computer does not offer whatever the role: the ledgers, off the Accounts holder. */
  hiddenRoutes?: ReadonlySet<AppRoute>;
}

const Chevron = () => (
  <svg className="chevron" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

interface NavGroupProps {
  section: NavSection;
  open: boolean;
  current: AppRoute;
  onToggle: () => void;
  onSelect: (route: AppRoute) => void;
}

/** A section heading that folds its pages, listed as rows under it. */
const NavGroup: React.FC<NavGroupProps> = ({ section, open, current, onToggle, onSelect }) => {
  const listId = `nav-section-${section.id}`;
  return (
    <div className="nav-group">
      <button
        type="button"
        className={`nav-group-head${open ? " open" : ""}`}
        aria-expanded={open}
        aria-controls={listId}
        onClick={onToggle}
      >
        <span className="nav-top-icon" aria-hidden="true">{SECTION_ICONS[section.id]}</span>
        <span className="nav-top-label">{section.label}</span>
        <Chevron />
      </button>
      {open && (
        <ul id={listId} className="nav-group-items">
          {section.items.map((item) => {
            const active = isNavItemActive(item, current);
            return (
              <li key={item.route}>
                <button
                  type="button"
                  className={`nav-item${active ? " active" : ""}`}
                  aria-current={active ? "page" : undefined}
                  onClick={() => onSelect(item.route)}
                >
                  {item.label}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export const SidebarNav: React.FC<SidebarNavProps> = ({ user, current, onSelect, storeJob = null, hiddenRoutes }) => {
  const [collapsed, setCollapsed] = useState<ReadonlySet<NavSectionId>>(new Set());
  const sections = visibleNavSections(user, hiddenRoutes);

  if (landingRoute(user) === STORE_STATION_ROUTE) {
    return <StoreJobNav user={user} job={storeJob} current={current} onSelect={onSelect} />;
  }

  const toggle = (id: NavSectionId) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="navbar-nav" role="navigation" aria-label={copy.nav.railLabel}>
      <RailLink icon={HOME_ICON} label={copy.nav.home} active={current === HOME_ROUTE} onClick={() => onSelect(HOME_ROUTE)} />

      {sections.map((section) => {
        if (section.standalone) {
          const page = section.items[0];
          return (
            <RailLink
              key={section.id}
              icon={SECTION_ICONS[section.id]}
              label={page.label}
              active={isNavItemActive(page, current)}
              onClick={() => onSelect(page.route)}
            />
          );
        }
        return (
          <NavGroup
            key={section.id}
            section={section}
            open={!collapsed.has(section.id)}
            current={current}
            onToggle={() => toggle(section.id)}
            onSelect={onSelect}
          />
        );
      })}
    </div>
  );
};
