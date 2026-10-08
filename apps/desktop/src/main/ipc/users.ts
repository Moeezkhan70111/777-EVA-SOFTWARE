// Members, roles, permissions and access/permission requests (admin).
//
// IPC handlers are registered per feature; every write is authorised through ctx.authorizer
// (see ../authorize.ts) and every channel name comes from shared/ipcChannels.ts.

import { ipcMain } from "electron";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { ACCESS_STATUS, USER_ROLE } from "@erp/domain";

export function registerUsersHandlers(ctx: IpcContext): void {
  const { db, useCases } = ctx;
  const { processScanUseCase, dispatchScanUseCase, returnScanUseCase, storeEntryScanUseCase, storeExitScanUseCase, createGatepassUseCase, cancelGatepassUseCase } = useCases;

  ipcMain.handle(IPC.getAccessRequests, (_event, token?: string) => {
    const sessionUser = typeof token === "string" ? db.getUserBySessionToken(token.trim()) : null;
    if (!sessionUser || sessionUser.role !== USER_ROLE.ADMIN) return { accepted: false, reason: "Administrator access required", requests: [] };
    return { accepted: true, requests: db.getAccessRequests() };
  });

  ipcMain.handle(IPC.reviewAccessRequest, (_event, token?: string, requestId?: string, decision?: string, permissions?: string[], roleCode?: string) => {
    const sessionUser = typeof token === "string" ? db.getUserBySessionToken(token.trim()) : null;
    if (!sessionUser || sessionUser.role !== USER_ROLE.ADMIN) return { accepted: false, reason: "Administrator access required" };
    if (!requestId || (decision !== "APPROVED" && decision !== "REJECTED")) return { accepted: false, reason: "Invalid access decision" };
    try {
      db.reviewAccessRequest(requestId, sessionUser.id, decision, Array.isArray(permissions) ? permissions : [], typeof roleCode === "string" ? roleCode : undefined);
      return { accepted: true };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "Unable to review access request" };
    }
  });

  ipcMain.handle(IPC.listMembers, (_event, token?: string) => {
    const admin = typeof token === "string" ? db.getUserBySessionToken(token.trim()) : null;
    if (!admin || admin.role !== USER_ROLE.ADMIN) return { accepted: false, members: [], reason: "Administrator access required" };
    return { accepted: true, members: db.listMembers() };
  });

  ipcMain.handle(IPC.updateUserPermissions, (_event, token?: string, userId?: string, permissions?: string[]) => {
    const admin = typeof token === "string" ? db.getUserBySessionToken(token.trim()) : null;
    if (!admin || admin.role !== USER_ROLE.ADMIN || !userId) return { accepted: false, reason: "Administrator access required" };
    try { db.updateUserPermissions(userId, admin.id, Array.isArray(permissions) ? permissions : []); return { accepted: true }; }
    catch (error) { return { accepted: false, reason: error instanceof Error ? error.message : "Unable to update permissions" }; }
  });

  ipcMain.handle(IPC.updateMemberJobRole, (_event, token?: string, userId?: string, jobRole?: string) => {
    const admin = typeof token === "string" ? db.getUserBySessionToken(token.trim()) : null;
    if (!admin || admin.role !== USER_ROLE.ADMIN || !userId) return { accepted: false, reason: "Administrator access required" };
    try { db.updateMemberJobRole(userId, admin.id, typeof jobRole === "string" ? jobRole : ""); return { accepted: true }; }
    catch (error) { return { accepted: false, reason: error instanceof Error ? error.message : "Unable to update member role" }; }
  });

  ipcMain.handle(IPC.updateMemberAuthority, (_event, token?: string, userId?: string, authorityLevel?: number) => {
    const admin = typeof token === "string" ? db.getUserBySessionToken(token.trim()) : null;
    if (!admin || admin.role !== USER_ROLE.ADMIN || !userId || !Number.isFinite(authorityLevel)) return { accepted: false, reason: "Administrator access required" };
    try { db.updateMemberAuthorityLevel(userId, admin.id, Number(authorityLevel)); return { accepted: true }; }
    catch (error) { return { accepted: false, reason: error instanceof Error ? error.message : "Unable to update authority" }; }
  });

  ipcMain.handle(IPC.getJobRoleOptions, (_event, token?: string) => {
    const admin = typeof token === "string" ? db.getUserBySessionToken(token.trim()) : null;
    if (!admin || admin.role !== USER_ROLE.ADMIN) return { accepted: false, roles: [], reason: "Administrator access required" };
    return { accepted: true, roles: db.getJobRoleOptions() };
  });

  ipcMain.handle(IPC.listRoles, (_event, token?: string) => {
    const admin = typeof token === "string" ? db.getUserBySessionToken(token.trim()) : null;
    if (!admin || admin.role !== USER_ROLE.ADMIN) return { accepted: false, roles: [], reason: "Administrator access required" };
    return { accepted: true, roles: db.listRoles() };
  });

  ipcMain.handle(IPC.createRole, (_event, token?: string, input?: Record<string, unknown>) => {
    const admin = typeof token === "string" ? db.getUserBySessionToken(token.trim()) : null;
    if (!admin || admin.role !== USER_ROLE.ADMIN) return { accepted: false, reason: "Administrator access required" };
    try {
      const role = db.createRole({
        name: typeof input?.name === "string" ? input.name : "",
        description: typeof input?.description === "string" ? input.description : undefined,
        permissions: Array.isArray(input?.permissions) ? input.permissions.filter((item): item is string => typeof item === "string") : [],
        loginPolicy: input?.loginPolicy === "DAILY_LOGIN" ? "DAILY_LOGIN" : "ALWAYS_LOGGED_IN",
      });
      return { accepted: true, role };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "Unable to create role" };
    }
  });

  ipcMain.handle(IPC.updateRole, (_event, token?: string, roleCode?: string, input?: Record<string, unknown>) => {
    const admin = typeof token === "string" ? db.getUserBySessionToken(token.trim()) : null;
    if (!admin || admin.role !== USER_ROLE.ADMIN) return { accepted: false, reason: "Administrator access required" };
    try {
      if (typeof roleCode !== "string" || !roleCode.trim()) throw new Error("Role is required");
      const payload: { name?: string; description?: string; permissions?: string[]; loginPolicy?: "ALWAYS_LOGGED_IN" | "DAILY_LOGIN" } = {};
      if (typeof input?.name === "string") payload.name = input.name;
      if (typeof input?.description === "string") payload.description = input.description;
      if (Array.isArray(input?.permissions)) payload.permissions = input.permissions.filter((item): item is string => typeof item === "string");
      if (input?.loginPolicy === "DAILY_LOGIN" || input?.loginPolicy === "ALWAYS_LOGGED_IN") payload.loginPolicy = input.loginPolicy;
      const updated = db.updateRole(roleCode.trim(), payload);
      return { accepted: true, role: updated };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "Unable to update role" };
    }
  });

  ipcMain.handle(IPC.deleteRole, (_event, token?: string, roleCode?: string) => {
    const admin = typeof token === "string" ? db.getUserBySessionToken(token.trim()) : null;
    if (!admin || admin.role !== USER_ROLE.ADMIN) return { accepted: false, reason: "Administrator access required" };
    try {
      if (typeof roleCode !== "string" || !roleCode.trim()) throw new Error("Role is required");
      db.deleteRole(roleCode.trim());
      return { accepted: true };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "Unable to delete role" };
    }
  });

  ipcMain.handle(IPC.assignUserRole, (_event, token?: string, userId?: string, roleCode?: string) => {
    const admin = typeof token === "string" ? db.getUserBySessionToken(token.trim()) : null;
    if (!admin || admin.role !== USER_ROLE.ADMIN) return { accepted: false, reason: "Administrator access required" };
    try {
      if (!userId || !roleCode) throw new Error("User and role are required");
      db.assignUserRole(userId, roleCode, admin.id);
      return { accepted: true };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "Unable to assign role" };
    }
  });

  ipcMain.handle(IPC.getUserNotifications, (_event, token?: string) => {
    const user = typeof token === "string" ? db.getUserBySessionToken(token.trim()) : null;
    if (!user) return { accepted: false, notifications: [], reason: "Your session has expired. Please sign in again." };
    return { accepted: true, notifications: db.getUserNotifications(user.id) };
  });

  ipcMain.handle(IPC.markNotificationRead, (_event, token?: string, notificationId?: string) => {
    const user = typeof token === "string" ? db.getUserBySessionToken(token.trim()) : null;
    if (!user) {
      return { accepted: false, reason: "Your session has expired. Please sign in again." };
    }
    if (!notificationId?.trim()) {
      return { accepted: false, reason: "Notification ID is required" };
    }
    try {
      db.markNotificationRead(user.id, notificationId.trim());
      return { accepted: true };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "Unable to mark notification as read" };
    }
  });

  ipcMain.handle(IPC.revokeUserAccess, (_event, token?: string, userId?: string) => {
    const admin = typeof token === "string" ? db.getUserBySessionToken(token.trim()) : null;
    if (!admin || admin.role !== USER_ROLE.ADMIN || !userId) return { accepted: false, reason: "Administrator access required" };
    try { db.revokeUserAccess(userId, admin.id); return { accepted: true }; }
    catch (error) { return { accepted: false, reason: error instanceof Error ? error.message : "Unable to revoke access" }; }
  });

  const requirePermission = (token: string | undefined, permission: string) => {
    const user = typeof token === "string" ? db.getUserBySessionToken(token.trim()) : null;
    if (!user) throw new Error("Your session has expired. Please sign in again.");
    if (user.accessStatus !== ACCESS_STATUS.APPROVED) throw new Error("Your account has not been approved.");
    if (user.role === "ADMIN") return user;
    if (!permission || user.permissions.includes(permission)) return user;
    // Allow parent modules if a child permission is requested (e.g. "stock" child under "inventory")
    if (permission === "stock" && user.permissions.includes("inventory")) return user;
    if (permission === "production-history" && (user.permissions.includes("inventory") || user.permissions.includes("scanning"))) return user;
    if (permission === "customer-ledger" && user.permissions.includes("billing")) return user;
    if (permission === "customer-balance" && user.permissions.includes("billing")) return user;
    if (["live-production","daily-production","live-dispatch","dispatch-history","live-return","return-history"].includes(permission) && user.permissions.includes("scanning")) return user;
    if (["party-list","party-form","product-list","product-form","discount-policy","qr-generator","qr-management","qr-journey"].includes(permission) && user.permissions.includes("masters")) return user;
    if (["sale-voucher-form","sale-voucher-list","cash-voucher-form","cash-voucher-list"].includes(permission) && user.permissions.includes("billing")) return user;
    throw new Error(`Access to this feature (${permission}) requires permission from your administrator.`);
  };

  ipcMain.handle(IPC.createPermissionRequest, (_event, token?: string, permissionCode?: string, reason?: string) => {
    try {
      const user = requirePermission(token, "workspace");
      if (typeof permissionCode !== "string" || !permissionCode.trim()) throw new Error("Permission is required");
      const result = db.createPermissionRequest(user.id, permissionCode, reason);
      return { accepted: true, ...result };
    } catch (error) { return { accepted: false, reason: error instanceof Error ? error.message : "Unable to request permission" }; }
  });

  ipcMain.handle(IPC.getPermissionRequests, (_event, token?: string) => {
    try {
      const admin = typeof token === "string" ? db.getUserBySessionToken(token.trim()) : null;
      if (!admin || admin.role !== USER_ROLE.ADMIN) throw new Error("Administrator access required");
      return { accepted: true, requests: db.getPermissionRequests() };
    } catch (error) { return { accepted: false, requests: [], reason: error instanceof Error ? error.message : "Unable to load permission requests" }; }
  });

  ipcMain.handle(IPC.getMyPermissionRequests, (_event, token?: string) => {
    try {
      const user = requirePermission(token, "workspace");
      return { accepted: true, requests: db.getMyPermissionRequests(user.id) };
    } catch (error) { return { accepted: false, requests: [], reason: error instanceof Error ? error.message : "Unable to load your permission requests" }; }
  });

  ipcMain.handle(IPC.reviewPermissionRequest, (_event, token?: string, requestId?: string, decision?: string, reviewNotes?: string) => {
    try {
      const admin = typeof token === "string" ? db.getUserBySessionToken(token.trim()) : null;
      if (!admin || admin.role !== USER_ROLE.ADMIN) throw new Error("Administrator access required");
      if (!requestId || (decision !== "APPROVED" && decision !== "REJECTED")) throw new Error("Invalid permission review data");
      const result = db.reviewPermissionRequest(requestId, admin.id, decision, reviewNotes);
      return { accepted: true, ...result };
    } catch (error) { return { accepted: false, reason: error instanceof Error ? error.message : "Unable to review permission request" }; }
  });

  ipcMain.handle(IPC.setUserAdditionalPermissions, (_event, token?: string, userId?: string, permissions?: string[]) => {
    try {
      const admin = typeof token === "string" ? db.getUserBySessionToken(token.trim()) : null;
      if (!admin || admin.role !== USER_ROLE.ADMIN || !userId) throw new Error("Administrator access required");
      db.setUserAdditionalPermissions(userId, Array.isArray(permissions) ? permissions.filter((p): p is string => typeof p === "string") : []);
      return { accepted: true };
    } catch (error) { return { accepted: false, reason: error instanceof Error ? error.message : "Unable to update additional permissions" }; }
  });

  ipcMain.handle(IPC.getUserAdditionalPermissions, (_event, token?: string, userId?: string) => {
    try {
      const admin = typeof token === "string" ? db.getUserBySessionToken(token.trim()) : null;
      if (!admin || admin.role !== USER_ROLE.ADMIN || !userId) throw new Error("Administrator access required");
      return { accepted: true, permissions: db.getUserAdditionalPermissions(userId) };
    } catch (error) { return { accepted: false, permissions: [], reason: error instanceof Error ? error.message : "Unable to load additional permissions" }; }
  });
}
