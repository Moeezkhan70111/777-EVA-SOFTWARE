import { PERMISSION, QR_GENERATOR_ACCESS, USER_ROLE } from "@erp/domain";
import type { PermissionCode, UserRole } from "@erp/domain";
import type { AppRoute } from "../../app/routes";
import type { AuthUser, DesktopApi } from "../../types/desktopApi";

// Session model for the renderer.
//
// The token lives in React state for the lifetime of the window and is persisted ONLY by
// the main process (encrypted, see main/sessionStore.ts). Nothing here touches
// localStorage. When the desktop API does not expose a session store (older preload,
// unit tests) the app simply starts signed out.

export interface SavedProfile {
  id: string;
  username: string;
  token: string;
  role: UserRole;
  lastUsedAt?: string;
}

export interface PersistedSession {
  activeToken: string | null;
  profiles: SavedProfile[];
}

const EMPTY_SESSION: PersistedSession = { activeToken: null, profiles: [] };

const sessionStoreOf = (api: DesktopApi) => (typeof api.sessionStore?.load === "function" ? api.sessionStore : null);

export const loadPersistedSession = async (api: DesktopApi): Promise<PersistedSession> => {
  const store = sessionStoreOf(api);
  if (!store) return EMPTY_SESSION;
  try {
    return await store.load();
  } catch {
    return EMPTY_SESSION;
  }
};

export const persistActiveProfile = async (api: DesktopApi, profile: SavedProfile): Promise<PersistedSession> => {
  const store = sessionStoreOf(api);
  if (!store) return { activeToken: profile.token, profiles: [profile] };
  try {
    return await store.save({ ...profile, lastUsedAt: profile.lastUsedAt ?? new Date().toISOString() });
  } catch {
    return { activeToken: profile.token, profiles: [profile] };
  }
};

export const forgetProfile = async (api: DesktopApi, token: string): Promise<PersistedSession> => {
  const store = sessionStoreOf(api);
  if (!store) return EMPTY_SESSION;
  try {
    return await store.remove(token);
  } catch {
    return EMPTY_SESSION;
  }
};

export const clearActiveSession = async (api: DesktopApi): Promise<void> => {
  const store = sessionStoreOf(api);
  if (!store) return;
  try {
    await store.clear();
  } catch {
    // Nothing to do: the in-memory session is already gone.
  }
};

/** Default permissions for a session record that predates per-user permissions. */
const LEGACY_DEFAULT_PERMISSIONS = [
  PERMISSION.DASHBOARD,
  PERMISSION.WORKSPACE,
  "scanning",
  "inventory",
  "masters",
  "billing",
  PERMISSION.SETTINGS,
  PERMISSION.HEALTH,
  PERMISSION.LOGS,
];

export const normalizeAuthUser = (user: AuthUser): AuthUser => ({
  id: user.id,
  username: user.username,
  role: user.role ?? USER_ROLE.USER,
  accessStatus: user.accessStatus ?? "APPROVED",
  permissions: user.permissions ?? LEGACY_DEFAULT_PERMISSIONS,
  lastLoginAt: user.lastLoginAt ?? null,
  roleNotification: user.roleNotification ?? null,
  roleName: typeof user.roleName === "string" && user.roleName.trim() ? user.roleName.trim() : null,
});

export const isAdmin = (user: AuthUser | null | undefined): boolean => user?.role === USER_ROLE.ADMIN;

export const hasPermission = (user: AuthUser | null | undefined, permission: string): boolean =>
  !!user && (isAdmin(user) || user.permissions.includes(permission));

/** Route → permission required to open it (undefined = open to any signed-in user). */
export const routePermission: Partial<Record<AppRoute, PermissionCode>> = {
  dashboard: PERMISSION.DASHBOARD,
  workspace: PERMISSION.WORKSPACE,

  "live-production": PERMISSION.LIVE_PRODUCTION,
  "daily-production": PERMISSION.DAILY_PRODUCTION,

  "live-dispatch": PERMISSION.LIVE_DISPATCH,
  "gatepass-store-scan": PERMISSION.STORE_SCANNING,
  "gatepass-dispatch-scan": PERMISSION.LIVE_DISPATCH,
  "daily-dispatch": PERMISSION.DAILY_DISPATCH,
  "dispatch-history": PERMISSION.DISPATCH_HISTORY,

  "live-return": PERMISSION.LIVE_RETURN,
  "return-history": PERMISSION.RETURN_HISTORY,

  // The whole store station — the home screen and both directions — is one job, so it
  // shares the single store-scanning permission.
  "store-home": PERMISSION.STORE_SCANNING,
  "store-in-operator": PERMISSION.STORE_SCANNING,
  "store-in-new-material": PERMISSION.STOCK,
  "store-in-qr-generator": PERMISSION.RAW_MATERIAL_QR_GENERATOR,
  "store-in-scanner": PERMISSION.STORE_SCANNING,
  "store-in-stock": PERMISSION.STOCK,
  "store-in-receipts": PERMISSION.STOCK,
  // The day's movements are read by whoever works the store, the same as the stations.
  "store-in-daily-report": PERMISSION.STORE_SCANNING,
  // Typing in an unlabelled delivery is store work, as the button under the scanner was.
  "store-in-manual-entry": PERMISSION.STORE_SCANNING,
  "store-out-operator": PERMISSION.STORE_SCANNING,
  // The Store page (0.3.9): Receiving and Issuing, one page, the store's one permission.
  "store-receiving": PERMISSION.STORE_SCANNING,
  "store-issuing": PERMISSION.STORE_SCANNING,
  "store-out-daily-report": PERMISSION.STORE_SCANNING,

  // The Munshi's station. Only the station screen itself is the Munshi's permission; the
  // stock section keeps the Stock permission its page has always required.
  "munshi-home": PERMISSION.MUNSHI,
  "munshi-stock": PERMISSION.STOCK,
  "store-scanning": PERMISSION.STORE_SCANNING,
  "store-move-out": PERMISSION.STORE_SCANNING,

  // Gatepass: one permission for viewing, creating and printing the document. Cancelling
  // is checked separately (gatepass-cancel) by the main process and the detail page.
  gatepass: PERMISSION.GATEPASS,
  "gatepass-list": PERMISSION.GATEPASS,

  stock: PERMISSION.STOCK,
  // The Raw Material workspace itself is gated by routeAnyPermission below, because it holds
  // what used to be three separately-permissioned pages. These two are deep links onto one of
  // its tabs, and keep exactly the permission their page had.
  "raw-material-qr-generator": PERMISSION.RAW_MATERIAL_QR_GENERATOR,
  // Programming a machine commits store stock to it, so it is its own permission rather than
  // something everyone who can read stock may do.
  "machine-program": PERMISSION.MACHINE_PROGRAM,
  history: PERMISSION.HISTORY,
  "stock-history": PERMISSION.HISTORY,
  "production-history": PERMISSION.PRODUCTION_HISTORY,

  "party-list": PERMISSION.PARTY_LIST,
  "party-form": PERMISSION.PARTY_FORM,

  "product-list": PERMISSION.PRODUCT_LIST,
  "product-form": PERMISSION.PRODUCT_FORM,
  // Editing the dropdown values is editing Product Master, so it shares that permission.
  "product-lists": PERMISSION.PRODUCT_FORM,
  // qr-generator and b-carton-generator are in routeAnyPermission below: store operators may
  // open them too (QR_GENERATOR_ACCESS).
  "qr-management": PERMISSION.QR_MANAGEMENT,
  // Tracing a code's path is a read over the same registry + event log QR Management
  // audits, so it shares that permission.
  "qr-journey": PERMISSION.QR_MANAGEMENT,
  "discount-policy": PERMISSION.DISCOUNT_POLICY,

  "customer-ledger": PERMISSION.CUSTOMER_LEDGER,
  "customer-balance": PERMISSION.CUSTOMER_BALANCE,

  "sale-voucher-form": PERMISSION.SALE_VOUCHER_FORM,
  "sale-voucher-list": PERMISSION.SALE_VOUCHER_LIST,

  "purchase-voucher-form": PERMISSION.PURCHASE_VOUCHER_FORM,
  "purchase-voucher-list": PERMISSION.PURCHASE_VOUCHER_LIST,
  "supplier-ledger": PERMISSION.SUPPLIER_LEDGER,
  "supplier-balance": PERMISSION.SUPPLIER_BALANCE,
  "contractor-ledger": PERMISSION.CONTRACTOR_LEDGER,

  "cash-voucher-form": PERMISSION.CASH_VOUCHER_FORM,
  "cash-voucher-list": PERMISSION.CASH_VOUCHER_LIST,

  settings: PERMISSION.SETTINGS,
  health: PERMISSION.HEALTH,
  logs: PERMISSION.LOGS,
};

/**
 * Routes that open for a user holding ANY of several permissions.
 *
 * Only the Raw Material workspace needs this: it gathered up three pages that were gated
 * separately (stock, label generation, settings), and refusing entry unless the user held all
 * three — or picking one of them — would have taken access away from people who had it. The
 * workspace then shows only the tabs the user's own permissions cover.
 */
export const routeAnyPermission: Partial<Record<AppRoute, PermissionCode[]>> = {
  "raw-material": [PERMISSION.STOCK, PERMISSION.RAW_MATERIAL_QR_GENERATOR, PERMISSION.SETTINGS, PERMISSION.RAW_MATERIAL_SETUP],
  // Raw material setup: the whole of Settings, or just this part of it.
  "raw-material-setup": [PERMISSION.SETTINGS, PERMISSION.RAW_MATERIAL_SETUP],
  "store-in-setup": [PERMISSION.SETTINGS, PERMISSION.RAW_MATERIAL_SETUP],
  // The raw material scanners belong to the store station, so a store operator always has
  // them; the page's own permission offers them to someone who is not a store operator.
  "raw-material-input": [PERMISSION.STORE_SCANNING, PERMISSION.RAW_MATERIAL_INPUT],
  "raw-material-output": [PERMISSION.STORE_SCANNING, PERMISSION.RAW_MATERIAL_OUTPUT],
  // Carton QRs: QR Generator, or any store operator (0.3.6). The main process enforces the same
  // list on every generate and print call. B carton labels are carton labels, so they share it.
  "qr-generator": [...QR_GENERATOR_ACCESS],
  "b-carton-generator": [...QR_GENERATOR_ACCESS],
};

/**
 * Whether this user may open a route. The one check behind the route guard in App, the Home
 * tiles and the sidebar, so a card is shown exactly when its page would open.
 *
 * This decides what the interface offers. Every operation is still authorised again by the
 * main process (main/authorize.ts) — hiding a card is not a security boundary.
 */
export const canOpenRoute = (user: AuthUser | null | undefined, route: AppRoute): boolean => {
  if (!user) return false;
  const required = routePermission[route];
  if (required && !hasPermission(user, required)) return false;
  const anyOf = routeAnyPermission[route];
  if (anyOf && !anyOf.some((permission) => hasPermission(user, permission))) return false;
  return true;
};

/**
 * Every role starts on Home: the tile dashboard of the pages assigned to it. Escape returns
 * there too, and a route the user may not open falls back to it.
 */
export const HOME_ROUTE: AppRoute = "home";

/**
 * Where a user starts after signing in, and where Escape takes them.
 *
 * A store operator (anyone but an administrator who holds Store Scanning) starts on Store
 * Station — "What is your job today?" — and the job they pick opens its own screen. Everyone
 * else starts on their Dashboard. The Dashboard stays one click away in the sidebar for all.
 */
export const landingRoute = (user: AuthUser | null | undefined): AppRoute =>
  user && !isAdmin(user) && hasPermission(user, PERMISSION.STORE_SCANNING) ? "store-home" : HOME_ROUTE;
