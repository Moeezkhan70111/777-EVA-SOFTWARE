import type { IpcMainInvokeEvent } from "electron";
import { ACCESS_STATUS, USER_ROLE } from "@erp/domain";
import type { AccessStatus, PermissionCode, UserRole } from "@erp/domain";

// Backend authorisation for IPC handlers.
//
// The renderer hides screens the user may not open, but hiding a button is not
// authorisation. Every write handler in main.ts asks this module first. The session is
// resolved from an explicit token when the handler receives one, otherwise from the
// session most recently proven for the calling window (bound on sign-in / get-session,
// released on logout). ADMIN bypasses permission codes, exactly as the navigation does.

export interface SessionUser {
  id: string;
  username: string;
  role: UserRole;
  accessStatus: AccessStatus;
  permissions: string[];
}

export type AuthorizationFailure = "SESSION_REQUIRED" | "ACCESS_NOT_APPROVED" | "PERMISSION_DENIED" | "ADMIN_REQUIRED";

const FAILURE_MESSAGE: Record<AuthorizationFailure, string> = {
  SESSION_REQUIRED: "Your session has expired. Please sign in again.",
  ACCESS_NOT_APPROVED: "Your access has not been approved yet.",
  PERMISSION_DENIED: "You do not have permission to perform this action.",
  ADMIN_REQUIRED: "Administrator access required",
};

export class AuthorizationError extends Error {
  readonly code: AuthorizationFailure;

  constructor(code: AuthorizationFailure) {
    super(FAILURE_MESSAGE[code]);
    this.name = "AuthorizationError";
    this.code = code;
  }
}

export class Authorizer {
  /** webContents id → the session token that window last proved. */
  private readonly boundTokens = new Map<number, string>();

  constructor(private readonly lookupSession: (token: string) => SessionUser | null) {}

  /** Remembers that this window holds `token` (after sign-in or a successful get-session). */
  bind(event: IpcMainInvokeEvent, token: string): void {
    this.boundTokens.set(event.sender.id, token);
  }

  release(event: IpcMainInvokeEvent): void {
    this.boundTokens.delete(event.sender.id);
  }

  /** The signed-in user for this call, or null. An explicit token always wins. */
  resolve(event: IpcMainInvokeEvent, explicitToken?: unknown): SessionUser | null {
    const token =
      typeof explicitToken === "string" && explicitToken.trim()
        ? explicitToken.trim()
        : this.boundTokens.get(event.sender.id);
    if (!token) return null;
    return this.lookupSession(token);
  }

  /** Any signed-in, approved user. */
  requireUser(event: IpcMainInvokeEvent, explicitToken?: unknown): SessionUser {
    const user = this.resolve(event, explicitToken);
    if (!user) throw new AuthorizationError("SESSION_REQUIRED");
    if (user.accessStatus !== ACCESS_STATUS.APPROVED) throw new AuthorizationError("ACCESS_NOT_APPROVED");
    return user;
  }

  /** A user holding `permission` (administrators hold every permission). */
  requirePermission(event: IpcMainInvokeEvent, permission: PermissionCode, explicitToken?: unknown): SessionUser {
    const user = this.requireUser(event, explicitToken);
    if (user.role === USER_ROLE.ADMIN) return user;
    if (!user.permissions.includes(permission)) throw new AuthorizationError("PERMISSION_DENIED");
    return user;
  }

  /** A user holding at least one of `permissions` (administrators hold every permission). */
  requireAnyPermission(event: IpcMainInvokeEvent, permissions: readonly PermissionCode[], explicitToken?: unknown): SessionUser {
    const user = this.requireUser(event, explicitToken);
    if (user.role === USER_ROLE.ADMIN) return user;
    if (!permissions.some((permission) => user.permissions.includes(permission))) throw new AuthorizationError("PERMISSION_DENIED");
    return user;
  }

  requireAdmin(event: IpcMainInvokeEvent, explicitToken?: unknown): SessionUser {
    const user = this.requireUser(event, explicitToken);
    if (user.role !== USER_ROLE.ADMIN) throw new AuthorizationError("ADMIN_REQUIRED");
    return user;
  }
}

/** Converts an authorisation failure into the `{ accepted: false, reason }` shape handlers return. */
export const rejection = (error: unknown, fallback: string): { accepted: false; reason: string; code?: string } => {
  if (error instanceof AuthorizationError) return { accepted: false, reason: error.message, code: error.code };
  return { accepted: false, reason: error instanceof Error ? error.message : fallback };
};
