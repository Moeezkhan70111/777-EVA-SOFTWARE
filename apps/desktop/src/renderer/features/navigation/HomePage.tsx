import React from "react";
import type { AppRoute } from "../../app/routes";
import { copy } from "../../config/copy";
import type { AuthUser } from "../../types/desktopApi";
import { StateView } from "../../components/shared/StateView";
import { isAdmin } from "../auth/session";
import { visibleNavSections } from "./navCatalogue";
import { FeatureCard } from "./FeatureCard";
import { NavTile } from "./NavTile";

// Every role's front door: the pages the user's role has been given. The sidebar lists the same
// pages (navCatalogue.ts), so the Dashboard and the rail never disagree. A role with nothing
// assigned gets an explanation instead of a blank screen.
//
//               Munshi                         ← the user's role
//     [ Machine Program ] [ Create Gatepass ]      ← every large card, together, centred
//     GATEPASS
//     [ Gatepass List ]                            ← the rest as compact tiles, by section
//
// Pages with a large card (FeatureCard) come first, side by side; the rest stay compact tiles
// under their section until their artwork is made. A large card names its own page, so it has
// no section heading over it.

/**
 * The page is titled with the user's role (e.g. "Munshi"), so each role sees its own desk.
 * An administrator without a role is "Administrator"; anyone else without one sees "Dashboard".
 * (The sidebar row keeps the name Dashboard.)
 */
export const dashboardTitle = (user: AuthUser): string =>
  user.roleName ?? (isAdmin(user) ? copy.nav.adminTitle : copy.nav.homeTitle);

interface HomePageProps {
  user: AuthUser;
  onNavigate: (route: AppRoute) => void;
}

export const HomePage: React.FC<HomePageProps> = ({ user, onNavigate }) => {
  const sections = visibleNavSections(user);
  const featured = sections.flatMap((section) => section.items.flatMap((item) => (item.feature ? [{ item, feature: item.feature }] : [])));
  const tileSections = sections
    .map((section) => ({ ...section, items: section.items.filter((item) => !item.feature) }))
    .filter((section) => section.items.length > 0);

  return (
    <div className="nav-page">
      <header className="nav-page-header">
        <h1>{dashboardTitle(user)}</h1>
      </header>

      {sections.length === 0 ? <StateView kind="empty" title={copy.nav.emptyTitle} hint={copy.nav.emptyHint} /> : null}

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
    </div>
  );
};
