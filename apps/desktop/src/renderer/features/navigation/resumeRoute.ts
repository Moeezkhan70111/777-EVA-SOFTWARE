import { isAppRoute, type AppRoute } from "../../app/routes";

// THE SCREEN A RELOAD COMES BACK TO.
//
// Opening the app is a fresh start: the user lands on their starting screen (landingRoute). But a
// RELOAD of an open window -- Ctrl+R, F5, or the window reloading itself -- used to land them there
// too, throwing somebody on the stock screen back to the home page. sessionStorage is exactly the
// difference between the two: it survives a reload of the window and is cleared when the window
// closes. So the current screen is kept there, and a reload resumes it.
//
// A per-window convenience, never business state (CLAUDE.md, browser storage): every read and write
// is guarded, and without storage the app simply behaves as before.

const KEY = "erp.resume-route";

/**
 * Screens a reload does NOT resume: forms opened for one record, whose record is passed in memory
 * and is gone after a reload. Resuming one would show an empty form, or the wrong one.
 */
const NOT_RESUMED = (route: AppRoute): boolean => route.endsWith("-form") || route === "change-password";

const readStored = (): AppRoute | null => {
  try {
    const value = window.sessionStorage.getItem(KEY);
    return isAppRoute(value) && !NOT_RESUMED(value) ? value : null;
  } catch {
    return null;
  }
};

/**
 * What this window showed before a reload, read once when the window's code first runs -- before
 * anything stores the screen of this run. Null on a fresh start.
 */
const RESUMED: AppRoute | null = readStored();

export const routeBeforeReload = (): AppRoute | null => RESUMED;

/** Keeps the current screen for a reload to come back to. */
export const rememberRoute = (route: AppRoute): void => {
  try {
    window.sessionStorage.setItem(KEY, route);
  } catch {
    // Storage blocked: a reload lands on the starting screen, as it always did.
  }
};
