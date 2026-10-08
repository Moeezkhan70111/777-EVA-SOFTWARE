import { PERMISSION, USER_ROLE } from "@erp/domain";
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
});

export const isAdmin = (user: AuthUser | null | undefined): boolean => user?.role === USER_ROLE.ADMIN;

export const hasPermission = (user: AuthUser | null | undefined, permission: string): boolean =>
  !!user && (isAdmin(user) || user.permissions.includes(permission));

/** Whether the full navigation chrome is shown (admins and users holding "navbar"). */
export const canSeeNavbar = (user: AuthUser | null | undefined): boolean => hasPermission(user, PERMISSION.NAVBAR);

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
  "store-out-operator": PERMISSION.STORE_SCANNING,

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
  "qr-generator": PERMISSION.QR_GENERATOR,
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
};

/** Where a user lands after sign-in, in priority order of their permissions. */
const LANDING_ORDER: Array<[PermissionCode, AppRoute]> = [
  // A Munshi works from their station and nowhere else, so it comes first.
  [PERMISSION.MUNSHI, "munshi-home"],
  [PERMISSION.LIVE_PRODUCTION, "live-production"],
  [PERMISSION.LIVE_DISPATCH, "live-dispatch"],
  [PERMISSION.LIVE_RETURN, "live-return"],
  // A store operator lands on the Move In / Move Out chooser, not straight on a scanner.
  [PERMISSION.STORE_SCANNING, "store-home"],
  [PERMISSION.GATEPASS, "gatepass"],
  [PERMISSION.STOCK, "stock"],
  [PERMISSION.SALE_VOUCHER_FORM, "sale-voucher-form"],
  [PERMISSION.DAILY_PRODUCTION, "daily-production"],
  [PERMISSION.DAILY_DISPATCH, "daily-dispatch"],
  [PERMISSION.CASH_VOUCHER_FORM, "cash-voucher-form"],
  [PERMISSION.PARTY_LIST, "party-list"],
  [PERMISSION.PRODUCT_LIST, "product-list"],
  [PERMISSION.WORKSPACE, "workspace"],
  [PERMISSION.DASHBOARD, "dashboard"],
];

export const getDefaultLandingRoute = (permissions: string[], role?: UserRole): AppRoute => {
  if (role === USER_ROLE.ADMIN) return "dashboard";
  if (permissions.includes(PERMISSION.NAVBAR) && permissions.includes(PERMISSION.DASHBOARD)) return "dashboard";
  for (const [permission, route] of LANDING_ORDER) {
    if (permissions.includes(permission)) return route;
  }
  return "live-production";
};
