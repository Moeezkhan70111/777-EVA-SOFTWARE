import React, { createContext, useContext, useMemo } from "react";
import type { AuthUser } from "../../types/desktopApi";
import { hasPermission, isAdmin } from "./session";

// Application-wide session state (CLAUDE.md R6: shared state → one shared mechanism).
// App owns the state; every page reads it through useSession() instead of receiving
// `token` / `username` props. The token never leaves memory in the renderer.

export interface SessionValue {
  user: AuthUser | null;
  token: string | null;
  isAdmin: boolean;
  can: (permission: string) => boolean;
}

const SessionContext = createContext<SessionValue | undefined>(undefined);

export const SessionProvider = ({
  user,
  token,
  children,
}: {
  user: AuthUser | null;
  token: string | null;
  children: React.ReactNode;
}) => {
  const value = useMemo<SessionValue>(
    () => ({
      user,
      token,
      isAdmin: isAdmin(user),
      can: (permission) => hasPermission(user, permission),
    }),
    [user, token]
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
};

export const useSession = (): SessionValue => {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error("useSession must be used within SessionProvider");
  }
  return context;
};
