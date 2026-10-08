import type { AppRoute } from "./routes";

/**
 * Central switchboard for the app shell.
 *
 * The incremental UI rebuild is over — every route is shown. This stays a function (rather
 * than being deleted at every call site in App.tsx/Navbar.tsx) so a section can be pulled
 * back out of the visible app later, without touching every call site, by naming it here.
 */
export function isRouteActive(_route: AppRoute): boolean {
  return true;
}

/** Whether the full Navbar chrome should render. False = blank shell. */
export const NAV_ACTIVE = true;
