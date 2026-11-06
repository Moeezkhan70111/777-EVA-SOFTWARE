import React from "react";
import type { AppRoute } from "../../app/routes";
import { copy } from "../../config/copy";
import type { AuthUser } from "../../types/desktopApi";
import { StateView } from "../../components/shared/StateView";
import { isAdmin } from "../auth/session";
import { visibleNavSections, type NavSection } from "./navCatalogue";
import { FeatureCard } from "./FeatureCard";
import { NavTile } from "./NavTile";

// Every role's front door: the Dashboard's own cards, Upper Stock and Dana Stock, each shown only to a
// profile that may open it. Every other page opens from the sidebar; a user with no sidebar (a store
// operator) still gets the full list below them (listAllPages). The sidebar lists the same
// pages (navCatalogue.ts), so the Dashboard and the rail never disagree. A role with nothing
// assigned gets an explanation instead of a blank screen.
//
//               MUNSHI                         ← the user's role, under the page header
//     [ Upper Stock ] [ Dana Stock ]               ← the cards this profile may open
//     GATEPASS                                     ← with no sidebar only: every other page
//     [ Gatepass List ]
//
// Pages with a large card (FeatureCard) come first, side by side; the rest stay compact tiles
// under their section until their artwork is made. A large card names its own page, so it has
// no section heading over it.

/**
 * The page header names the page (Dashboard); the line under it names the user's role (e.g.
 * "Munshi"), so each role still sees its own desk. An administrator without a role is
 * "Administrator"; anyone else without one has no line, since it would only repeat the header.
 */
export const deskName = (user: AuthUser): string | null => user.roleName ?? (isAdmin(user) ? copy.nav.adminTitle : null);

interface HomePageProps {
  user: AuthUser;
  onNavigate: (route: AppRoute) => void;
  /** Pages this computer does not offer whatever the role: the ledgers, off the Accounts holder. */
  hiddenRoutes?: ReadonlySet<AppRoute>;
  /**
   * List every page this user may open, under the Dashboard's own cards. For a user with no
   * sidebar, a store operator, for whom Home (F1) is the only way to those pages.
   */
  listAllPages?: boolean;
}

/** Every page of this user's with a large card, and which section's page is which. */
const featuredPages = (sections: readonly NavSection[]) =>
  sections.flatMap((section) => section.items.flatMap((item) => (item.feature ? [{ item, feature: item.feature }] : [])));

/** Every other card and tile: the list a user with no sidebar reaches their pages from. */
const AllPages: React.FC<{ sections: readonly NavSection[]; onNavigate: (route: AppRoute) => void }> = ({ sections, onNavigate }) => {
  const featured = featuredPages(sections).filter(({ feature }) => !feature.onDashboard);
  const tileSections = sections
    .map((section) => ({ ...section, items: section.items.filter((item) => !item.feature) }))
    .filter((section) => section.items.length > 0);

  return (
    <>
      {featured.length > 0 ? (
        <div className="nav-page-section nav-page-grid nav-page-grid--feature">
          {featured.map(({ item, feature }) => (
            <FeatureCard key={item.route} item={item} feature={feature} onSelect={onNavigate} />
          ))}
        </div>
      ) : null}

      {tileSections.map((section) => (
        <section key={section.id} className="nav-page-section" aria-label={section.label}>
          <h2 className="nav-page-section-label">{section.label}</h2>
          <div className="nav-page-grid">
            {section.items.map((item) => (
              <NavTile key={item.route} item={item} tone={section.tone} onSelect={onNavigate} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
};

export const HomePage: React.FC<HomePageProps> = ({ user, onNavigate, hiddenRoutes, listAllPages = false }) => {
  const sections = visibleNavSections(user, hiddenRoutes);
  const desk = deskName(user);
  // Only the cards this user's permissions open: visibleNavSections has already asked canOpenRoute.
  const cards = featuredPages(sections).filter(({ feature }) => feature.onDashboard);

  return (
    <div className="nav-page">
      {desk ? <p className="nav-page-desk">{desk}</p> : null}

      {sections.length === 0 ? <StateView kind="empty" title={copy.nav.emptyTitle} hint={copy.nav.emptyHint} /> : null}
      {sections.length > 0 && cards.length === 0 && !listAllPages ? (
        <StateView kind="empty" title={copy.nav.noCardsTitle} hint={copy.nav.noCardsHint} />
      ) : null}

      {cards.length > 0 ? (
        <div className="nav-page-section nav-page-grid nav-page-grid--dashboard">
          {cards.map(({ item, feature }) => (
            <FeatureCard key={item.route} item={item} feature={feature} onSelect={onNavigate} />
          ))}
        </div>
      ) : null}

      {listAllPages ? <AllPages sections={sections} onNavigate={onNavigate} /> : null}
    </div>
  );
};
