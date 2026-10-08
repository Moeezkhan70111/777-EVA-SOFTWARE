import { useCallback, useEffect, useState } from "react";
import { ACCESS_STATUS } from "@erp/domain";
import type { AppRoute } from "../../app/routes";
import { copy } from "../../config/copy";
import type { NoticeKind } from "../../state/NotificationsContext";
import type { AuthUser, DesktopApi } from "../../types/desktopApi";
import type { AuthView } from "./AuthScreen";
import type { RequestStatus } from "./RookieScreen";
import {
  canSeeNavbar,
  clearActiveSession,
  forgetProfile,
  getDefaultLandingRoute,
  loadPersistedSession,
  normalizeAuthUser,
  persistActiveProfile,
  type SavedProfile,
} from "./session";

/** How often the shell re-reads the session so role/permission changes reach the user. */
const SESSION_REFRESH_MS = 3000;

interface UseAuthSessionArgs {
  api: DesktopApi;
  push: (kind: NoticeKind, title: string, message?: string) => void;
  route: AppRoute;
  setRoute: (route: AppRoute) => void;
}

export interface AuthSessionState {
  session: AuthUser | null;
  sessionToken: string | null;
  savedProfiles: SavedProfile[];
  isAddingAccount: boolean;
  authView: AuthView;
  setAuthView: (view: AuthView) => void;
  authError: string | null;
  authSuccess: string | null;
  requestStatus: RequestStatus;
  /** True once boot confirms no ADMIN exists yet; routes to BootstrapAdminScreen instead of AuthScreen. */
  needsBootstrap: boolean;
  handleBootstrapSubmit: (username: string, password: string, confirmPassword: string) => Promise<void>;
  handleAuthSubmit: (username: string, password: string, confirmPassword?: string) => Promise<void>;
  handleSwitchProfile: (token: string) => Promise<void>;
  handleAddAccount: () => void;
  cancelAddAccount: () => void;
  handleLogout: () => Promise<void>;
  handleRequestAccess: () => Promise<void>;
  handleChangePassword: (currentPassword: string, newPassword: string, confirmPassword: string) => Promise<void>;
  setAuthError: (message: string | null) => void;
}

const profileOf = (user: AuthUser, token: string): SavedProfile => ({
  id: user.id,
  username: user.username,
  token,
  role: user.role,
  lastUsedAt: new Date().toISOString(),
});

export const useAuthSession = ({ api, push, route, setRoute }: UseAuthSessionArgs): AuthSessionState => {
  const [session, setSession] = useState<AuthUser | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [savedProfiles, setSavedProfiles] = useState<SavedProfile[]>([]);
  const [isAddingAccount, setIsAddingAccount] = useState(false);
  const [authView, setAuthView] = useState<AuthView>("login");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSuccess, setAuthSuccess] = useState<string | null>(null);
  const [requestStatus, setRequestStatus] = useState<RequestStatus>(null);
  // Starts false (the existing sign-in flow, unchanged) so the common case — an admin already
  // exists — renders exactly as it always has, with no new async gate before AuthScreen. Only
  // flips to true if the boot check below finds no ADMIN at all, which is the fresh-install case.
  const [needsBootstrap, setNeedsBootstrap] = useState(false);

  /** Lands the user on a screen they are allowed to see. */
  const landOn = useCallback(
    (user: AuthUser, keepCurrentRoute: boolean) => {
      if (!canSeeNavbar(user) || (!keepCurrentRoute && !user.permissions.includes(route))) {
        setRoute(getDefaultLandingRoute(user.permissions, user.role));
      }
    },
    [route, setRoute]
  );

  const refreshAccessRequest = useCallback(
    async (user: AuthUser, token: string) => {
      if (user.accessStatus !== ACCESS_STATUS.APPROVED && typeof api.getMyAccessRequest === "function") {
        const request = await api.getMyAccessRequest(token);
        setRequestStatus(request.request?.status ?? null);
      }
    },
    [api]
  );

  /** Activates a proven session in memory and persists it through the main process. */
  const activate = useCallback(
    async (user: AuthUser, token: string) => {
      setSessionToken(token);
      setSession(user);
      const persisted = await persistActiveProfile(api, profileOf(user, token));
      setSavedProfiles(persisted.profiles);
      if (user.roleNotification) push("success", copy.auth.roleUpdatedTitle, user.roleNotification);
      await refreshAccessRequest(user, token);
    },
    [api, push, refreshAccessRequest]
  );

  // Boot: no session can be valid until an administrator exists, so that check comes first.
  useEffect(() => {
    void (async () => {
      const { hasAdmin } = await api.hasAnyAdmin();
      setNeedsBootstrap(!hasAdmin);
      if (!hasAdmin) return;

      const persisted = await loadPersistedSession(api);
      setSavedProfiles(persisted.profiles);
      if (!persisted.activeToken) return;
      const result = await api.getSession(persisted.activeToken);
      if (!result) {
        await forgetProfile(api, persisted.activeToken);
        return;
      }
      const user = normalizeAuthUser(result);
      await activate(user, persisted.activeToken);
      landOn(user, true);
    })();
    // Boot only once; `activate`/`landOn` are stable for the initial render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  // Keep the session fresh so permission/role changes reach the operator without re-login.
  useEffect(() => {
    if (!sessionToken || !session) return;
    const refresh = () => {
      void api.getSession(sessionToken).then((updated: AuthUser | null) => {
        if (updated) {
          const refreshedUser = normalizeAuthUser(updated);
          setSession(refreshedUser);
          if (refreshedUser.roleNotification) push("success", copy.auth.roleUpdatedTitle, refreshedUser.roleNotification);
          if (updated.accessStatus === ACCESS_STATUS.APPROVED) setRequestStatus(ACCESS_STATUS.APPROVED);
        } else {
          void clearActiveSession(api);
          setSession(null);
          setSessionToken(null);
          setRoute("dashboard");
        }
      });
    };
    const timer = window.setInterval(refresh, SESSION_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [api, push, session, sessionToken, setRoute]);

  const handleBootstrapSubmit = useCallback(
    async (username: string, password: string, confirmPassword: string) => {
      setAuthError(null);
      setAuthSuccess(null);
      const result = await api.bootstrapAdmin(username, password, confirmPassword);

      if (!result.accepted) {
        setAuthError(result.reason ?? copy.auth.authFailed);
        return;
      }
      if (!result.user) return;

      const activeToken = result.token ?? `session-${result.user.id}-${Date.now()}`;
      const adminUser = normalizeAuthUser(result.user);
      setNeedsBootstrap(false);
      await activate(adminUser, activeToken);
      setAuthError(null);
      setAuthSuccess(null);
      landOn(adminUser, false);
    },
    [activate, api, landOn]
  );

  const handleAuthSubmit = useCallback(
    async (username: string, password: string, confirmPassword?: string) => {
      setAuthError(null);
      setAuthSuccess(null);
      const result =
        authView === "login" ? await api.signIn(username, password) : await api.signUp(username, password, confirmPassword ?? "");

      if (!result.accepted) {
        setAuthError(result.reason ?? copy.auth.authFailed);
        return;
      }
      if (!result.user) return;

      const activeToken = result.token ?? `session-${result.user.id}-${Date.now()}`;
      const signedInUser = normalizeAuthUser(result.user);
      setRequestStatus(null);
      await activate(signedInUser, activeToken);
      setIsAddingAccount(false);
      setAuthError(null);
      setAuthSuccess(null);
      landOn(signedInUser, false);
    },
    [activate, api, authView, landOn]
  );

  const handleSwitchProfile = useCallback(
    async (targetToken: string) => {
      try {
        const result = await api.getSession(targetToken);
        if (result) {
          const hydrated = normalizeAuthUser(result);
          await activate(hydrated, targetToken);
          setIsAddingAccount(false);
          push("success", copy.auth.switchedProfileTitle, copy.auth.switchedProfileBody(hydrated.username));
          landOn(hydrated, false);
        } else {
          push("error", copy.auth.sessionExpiredTitle, copy.auth.sessionExpiredProfile);
          const persisted = await forgetProfile(api, targetToken);
          setSavedProfiles(persisted.profiles);
        }
      } catch (error) {
        push("error", copy.auth.switchFailedTitle, error instanceof Error ? error.message : copy.auth.switchFailedBody);
      }
    },
    [activate, api, landOn, push]
  );

  const handleAddAccount = useCallback(() => {
    setIsAddingAccount(true);
    setAuthView("login");
    setAuthError(null);
    setAuthSuccess(null);
  }, []);

  const cancelAddAccount = useCallback(() => setIsAddingAccount(false), []);

  const handleLogout = useCallback(async () => {
    if (sessionToken) {
      await api.logout(sessionToken);
      const persisted = await forgetProfile(api, sessionToken);
      setSavedProfiles(persisted.profiles);
    }
    setSession(null);
    setSessionToken(null);
    setRequestStatus(null);
    setRoute("dashboard");
    setAuthError(null);
    setAuthSuccess(null);
    setAuthView("login");
    setIsAddingAccount(false);
  }, [api, sessionToken, setRoute]);

  const handleRequestAccess = useCallback(async () => {
    if (!sessionToken) return;
    try {
      const result = await api.requestAccess(sessionToken);
      if (result.accepted && result.status) {
        setRequestStatus(result.status);
        setAuthError(null);
      } else {
        setAuthError(result.reason ?? copy.auth.requestFailed);
      }
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : copy.auth.requestFailed);
    }
  }, [api, sessionToken]);

  const handleChangePassword = useCallback(
    async (currentPassword: string, newPassword: string, confirmPassword: string) => {
      if (!sessionToken) {
        setAuthError(copy.auth.sessionExpired);
        return;
      }
      const result = await api.changePassword(currentPassword, newPassword, confirmPassword, sessionToken);
      if (!result.accepted) {
        setAuthError(result.reason ?? copy.auth.passwordChangeFailed);
        setAuthSuccess(null);
        return;
      }
      setAuthError(null);
      setAuthSuccess(copy.auth.passwordChanged);
    },
    [api, sessionToken]
  );

  return {
    session,
    sessionToken,
    savedProfiles,
    isAddingAccount,
    authView,
    setAuthView,
    authError,
    authSuccess,
    requestStatus,
    needsBootstrap,
    handleBootstrapSubmit,
    handleAuthSubmit,
    handleSwitchProfile,
    handleAddAccount,
    cancelAddAccount,
    handleLogout,
    handleRequestAccess,
    handleChangePassword,
    setAuthError,
  };
};
