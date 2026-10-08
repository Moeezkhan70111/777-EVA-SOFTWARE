import React from "react";
import type { AppRoute } from "../../app/routes";
import { copy } from "../../config/copy";
import type { AuthUser } from "../../types/desktopApi";
import { canOpenRoute } from "../auth/session";
import { STORE_JOB_PAGES, storeOperator, type StoreDirection } from "../store/storeOperators";
import { STORE_STATION_ROUTE } from "../store/useStoreJob";
import { NAV_ICONS } from "./NavIcons";
import { RailLink } from "./RailLink";

// The sidebar for a store operator. Before they pick a job it holds one row, Select Job. Once
// they have picked one it adds that job and, under it, the job's own pages — the same cards the
// job screen shows (storeOperators.ts), limited to the ones their role may open.
//
//   Select Job
//   Move In
//     Add New Material · Raw Material QR · Raw Material Move In · Stock · Receipts · Setup

interface StoreJobNavProps {
  user: AuthUser;
  job: StoreDirection | null;
  current: AppRoute;
  onSelect: (route: AppRoute) => void;
}

export const StoreJobNav: React.FC<StoreJobNavProps> = ({ user, job, current, onSelect }) => {
  const operator = job ? storeOperator(job) : null;
  const pages = job ? STORE_JOB_PAGES[job].filter((page) => canOpenRoute(user, page.route)) : [];

  return (
    <div className="navbar-nav" role="navigation" aria-label={copy.nav.railLabel}>
      <RailLink
        icon={NAV_ICONS.store}
        label={copy.nav.selectJob}
        active={current === STORE_STATION_ROUTE}
        onClick={() => onSelect(STORE_STATION_ROUTE)}
      />

      {operator ? (
        <>
          <RailLink
            icon={job === "in" ? NAV_ICONS.scan : NAV_ICONS.dispatch}
            label={operator.title}
            active={current === operator.route}
            onClick={() => onSelect(operator.route)}
          />
          {pages.length > 0 ? (
            <ul className="nav-group-items" aria-label={operator.title}>
              {pages.map((page) => {
                const active = current === page.route;
                return (
                  <li key={page.id}>
                    <button
                      type="button"
                      className={`nav-item${active ? " active" : ""}`}
                      aria-current={active ? "page" : undefined}
                      onClick={() => onSelect(page.route)}
                    >
                      {page.title}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  );
};
