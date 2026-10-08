// Sign-in, sign-up, session lookup and the encrypted session store.
//
// IPC handlers are registered per feature; every write is authorised through ctx.authorizer
// (see ../authorize.ts) and every channel name comes from shared/ipcChannels.ts.

import { ipcMain } from "electron";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import type { StoredProfile } from "../sessionStore";
import { USER_ROLE } from "@erp/domain";
import { app } from "electron";

export function registerSessionHandlers(ctx: IpcContext): void {
  const { db, authorizer, sessionStore, paths, dbPath, dataMigration, useCases } = ctx;
  const { processScanUseCase, dispatchScanUseCase, returnScanUseCase, storeEntryScanUseCase, storeExitScanUseCase, createGatepassUseCase, cancelGatepassUseCase } = useCases;

  ipcMain.handle(IPC.getRuntime, () => ({
    dbPath,
    dataRoot: paths.dataRoot,
    dataMigration: dataMigration.status,
    appVersion: app.getVersion(),
  }));

  ipcMain.handle(IPC.sessionStoreLoad, () => sessionStore.load());

  ipcMain.handle(IPC.sessionStoreSave, (_event, profile?: StoredProfile) => {
    if (!profile || typeof profile.token !== "string" || !profile.token) return sessionStore.load();
    // Only a token the database recognises may be persisted.
    if (!db.getUserBySessionToken(profile.token)) return sessionStore.load();
    return sessionStore.setActive({
      id: String(profile.id ?? ""),
      username: String(profile.username ?? ""),
      token: profile.token,
      role: profile.role === USER_ROLE.ADMIN ? USER_ROLE.ADMIN : USER_ROLE.USER,
      lastUsedAt: typeof profile.lastUsedAt === "string" ? profile.lastUsedAt : undefined,
    });
  });

  ipcMain.handle(IPC.sessionStoreRemove, (_event, token?: string) =>
    typeof token === "string" && token ? sessionStore.removeProfile(token) : sessionStore.load()
  );

  ipcMain.handle(IPC.sessionStoreClear, () => sessionStore.clearActive());

  ipcMain.handle(IPC.getSession, (event, token?: string) => {
    if (typeof token !== "string" || !token.trim()) return null;
    const user = db.getUserBySessionToken(token.trim());
    // A valid token proves which session this window holds; write handlers rely on it.
    if (user) authorizer.bind(event,token.trim());
    return user;
  });

  ipcMain.handle(IPC.hasAnyAdmin, () => ({ hasAdmin: db.hasAnyAdmin() }));

  ipcMain.handle(IPC.bootstrapAdmin, (event, username?: string, password?: string, confirmPassword?: string) => {
    const normalizedUsername = typeof username === "string" ? username.trim() : "";
    const normalizedPassword = typeof password === "string" ? password : "";
    const normalizedConfirm = typeof confirmPassword === "string" ? confirmPassword : "";

    if (!normalizedUsername) {
      return { accepted: false, reason: "Username is required" };
    }
    if (!normalizedPassword) {
      return { accepted: false, reason: "Password is required" };
    }
    if (normalizedPassword !== normalizedConfirm) {
      return { accepted: false, reason: "Passwords do not match" };
    }

    try {
      const admin = db.bootstrapFirstAdmin(normalizedUsername, normalizedPassword);
      const token = db.createUserSession(admin.id);
      authorizer.bind(event, token);
      return { accepted: true, user: db.getUserBySessionToken(token), token };
    } catch (error) {
      return {
        accepted: false,
        reason: error instanceof Error ? error.message : "Unable to create administrator account",
      };
    }
  });

  ipcMain.handle(IPC.signIn, (event, username?: string, password?: string) => {
    const normalizedUsername = typeof username === "string" ? username.trim() : "";
    const normalizedPassword = typeof password === "string" ? password : "";

    if (!normalizedUsername) {
      return { accepted: false, reason: "Please enter your username" };
    }
    if (!normalizedPassword) {
      return { accepted: false, reason: "Please enter your password" };
    }

    const user = db.authenticateUser(normalizedUsername, normalizedPassword);
    if (!user) {
      return { accepted: false, reason: "Invalid username or password" };
    }

    const token = db.createUserSession(user.id);
    authorizer.bind(event,token);
    return { accepted: true, user: db.getUserBySessionToken(token), token };
  });

  ipcMain.handle(IPC.signUp, (event, username?: string, password?: string, confirmPassword?: string) => {
    const normalizedUsername = typeof username === "string" ? username.trim() : "";
    const normalizedPassword = typeof password === "string" ? password : "";
    const normalizedConfirm = typeof confirmPassword === "string" ? confirmPassword : "";

    if (!normalizedUsername) {
      return { accepted: false, reason: "Username is required" };
    }
    if (!normalizedPassword) {
      return { accepted: false, reason: "Password is required" };
    }
    if (!normalizedConfirm) {
      return { accepted: false, reason: "Please confirm your password" };
    }
    if (normalizedPassword !== normalizedConfirm) {
      return { accepted: false, reason: "Passwords do not match" };
    }

    try {
      const user = db.createUserAccount(normalizedUsername, normalizedPassword);
      const token = db.createUserSession(user.id);
      authorizer.bind(event,token);
      return { accepted: true, user: db.getUserBySessionToken(token), token };
    } catch (error) {
      return {
        accepted: false,
        reason: error instanceof Error ? error.message : "Unable to create account",
      };
    }
  });

  ipcMain.handle(IPC.changePassword, (_event, currentPassword?: string, newPassword?: string, confirmPassword?: string, token?: string) => {
    const current = typeof currentPassword === "string" ? currentPassword : "";
    const next = typeof newPassword === "string" ? newPassword : "";
    const confirm = typeof confirmPassword === "string" ? confirmPassword : "";
    const sessionToken = typeof token === "string" ? token.trim() : "";

    if (!current) return { accepted: false, reason: "Please enter your current password" };
    if (!next) return { accepted: false, reason: "Please enter your new password" };
    if (next !== confirm) return { accepted: false, reason: "Passwords do not match" };
    if (!sessionToken) return { accepted: false, reason: "Your session has expired. Please sign in again." };

    const sessionUser = db.getUserBySessionToken(sessionToken);
    if (!sessionUser) {
      return { accepted: false, reason: "Your session has expired. Please sign in again." };
    }

    try {
      db.changePasswordForUser(sessionUser.id, current, next);
      return { accepted: true };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "Unable to change password" };
    }
  });

  ipcMain.handle(IPC.logout, (event, token?: string) => {
    const sessionToken = typeof token === "string" ? token.trim() : "";
    if (sessionToken) {
      db.revokeSessionToken(sessionToken);
      sessionStore.removeProfile(sessionToken);
    }
    authorizer.release(event);
    return { accepted: true };
  });

  ipcMain.handle(IPC.requestAccess, (_event, token?: string) => {
    const sessionUser = typeof token === "string" ? db.getUserBySessionToken(token.trim()) : null;
    if (!sessionUser) return { accepted: false, reason: "Your session has expired. Please sign in again." };
    try {
      return { accepted: true, ...db.createAccessRequest(sessionUser.id) };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "Unable to request access" };
    }
  });

  ipcMain.handle(IPC.getMyAccessRequest, (_event, token?: string) => {
    const sessionUser = typeof token === "string" ? db.getUserBySessionToken(token.trim()) : null;
    if (!sessionUser) return { accepted: false, reason: "Your session has expired. Please sign in again." };
    return { accepted: true, request: db.getAccessRequestForUser(sessionUser.id) };
  });
}
