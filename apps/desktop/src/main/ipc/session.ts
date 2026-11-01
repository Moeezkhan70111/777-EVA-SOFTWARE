// Sign-in, sign-up, session lookup and the encrypted session store.
//
// IPC handlers are registered per feature; every write is authorised through ctx.authorizer
// (see ../authorize.ts) and every channel name comes from shared/ipcChannels.ts.

import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { IPC } from "../../shared/ipcChannels";
import {
  CLOUD_ACCOUNTS_SWITCH_READY,
  cloudClaim,
  cloudSignIn,
  cloudSignUp,
  forgetPersonToken,
  personTokenFor,
  switchThisComputerToCloud,
  usesCloudAccounts,
  type AccountDeps,
  type AccountOutcome,
} from "../cloudAccounts";
import { isCloudSyncConfigured, signedInTransport } from "../cloudSyncPass";
import { changeOwnPassword } from "../cloudAdmin";
import type { IpcContext } from "./context";
import type { StoredProfile } from "../sessionStore";
import { USER_ROLE } from "@erp/domain";
import { app } from "electron";
import { readBuildInfo } from "../buildInfo";

export function registerSessionHandlers(ctx: IpcContext): void {
  const { db, logger, deviceId, authorizer, sessionStore, paths, dbPath, dataMigration, useCases } = ctx;
  const { processScanUseCase, dispatchScanUseCase, returnScanUseCase, storeEntryScanUseCase, storeExitScanUseCase, createGatepassUseCase, cancelGatepassUseCase } = useCases;

  ipcMain.handle(IPC.getRuntime, () => ({
    dbPath,
    dataRoot: paths.dataRoot,
    dataMigration: dataMigration.status,
    appVersion: app.getVersion(),
    // Which code this is: commit, cleanliness, build time and the migration ceiling it ships.
    // Version alone could not identify a build — 0.2.0 stood still while the schema moved from
    // 069 to 076. Nothing secret: a hash, a flag, a timestamp and a number.
    build: readBuildInfo(),
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

  // ── Cloud accounts (docs/41) ──
  // Local mode is untouched below. Under cloud accounts sign-in and sign-up go to the cloud through
  // this computer's enrolled device (cloudAccounts.ts), and the local writes refuse (accountsMode.ts).

  const inCloudAccounts = (): Promise<boolean> => usesCloudAccounts(db);

  const accountDeps = async (): Promise<AccountDeps> => {
    const signedIn = await signedInTransport({ logger, deviceId, dataRoot: paths.dataRoot });
    return { db, caller: signedIn.ok ? signedIn.transport : null };
  };

  const answerFor = (event: IpcMainInvokeEvent, outcome: AccountOutcome) => {
    if (outcome.kind === "NEEDS_EMAIL") return { accepted: false, needsEmail: true, reason: outcome.message };
    if (outcome.kind === "REFUSED") return { accepted: false, reason: outcome.message };
    authorizer.bind(event, outcome.sessionToken);
    return { accepted: true, user: db.getUserBySessionToken(outcome.sessionToken), token: outcome.sessionToken };
  };

  ipcMain.handle(IPC.getAccountsStatus, async () => ({
    mode: (await inCloudAccounts()) ? "CLOUD" : "LOCAL",
    cloudConfigured: isCloudSyncConfigured({ deviceId, dataRoot: paths.dataRoot }),
    deviceId,
    switchReady: CLOUD_ACCOUNTS_SWITCH_READY,
  }));

  // THE SWITCH, BY HAND (docs/41 section 12): an admin signed in here, at this computer, after the
  // screen has said what it does and they have confirmed. Never automatic: applying a migration must
  // never be what signs a store out. Everyone else here is signed out by it.
  ipcMain.handle(IPC.switchToCloudAccounts, async (event, token?: string, email?: string, password?: string) => {
    let admin;
    try {
      admin = authorizer.requireAdmin(event, token);
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "Administrator access required" };
    }
    const givenEmail = typeof email === "string" ? email.trim() : "";
    const givenPassword = typeof password === "string" ? password : "";
    if (!givenEmail || !givenPassword) return { accepted: false, reason: "Enter your email and password" };
    const sessionToken = typeof token === "string" ? token.trim() : "";

    const outcome = await switchThisComputerToCloud(
      { ...(await accountDeps()), logger, deviceId, switchReady: CLOUD_ACCOUNTS_SWITCH_READY },
      { sessionToken, localUserId: admin.id, localUsername: admin.username, email: givenEmail, password: givenPassword }
    );
    if (outcome.kind === "REFUSED") return { accepted: false, reason: outcome.message };
    authorizer.bind(event, outcome.sessionToken);
    return { accepted: true, user: db.getUserBySessionToken(outcome.sessionToken), token: outcome.sessionToken, people: outcome.people };
  });

  // Under cloud accounts there is no first admin to make here: the screen that asks must not appear.
  ipcMain.handle(IPC.hasAnyAdmin, async () => ({ hasAdmin: (await inCloudAccounts()) || db.hasAnyAdmin() }));

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

  ipcMain.handle(IPC.signIn, async (event, username?: string, password?: string, email?: string) => {
    const normalizedUsername = typeof username === "string" ? username.trim() : "";
    const normalizedPassword = typeof password === "string" ? password : "";

    if (!normalizedUsername) {
      return { accepted: false, reason: "Please enter your email or username" };
    }
    if (!normalizedPassword) {
      return { accepted: false, reason: "Please enter your password" };
    }

    // An email signs in through the cloud. An old username is an account this computer holds that
    // has not moved up yet: its password is checked here, then it moves up with an email.
    if (await inCloudAccounts()) {
      const deps = await accountDeps();
      const outcome = normalizedUsername.includes("@")
        ? await cloudSignIn(deps, normalizedUsername, normalizedPassword)
        : await cloudClaim(deps, normalizedUsername, normalizedPassword, typeof email === "string" ? email : null);
      return answerFor(event, outcome);
    }

    const user = db.authenticateUser(normalizedUsername, normalizedPassword);
    if (!user) {
      return { accepted: false, reason: "Invalid username or password" };
    }

    const token = db.createUserSession(user.id);
    authorizer.bind(event,token);
    return { accepted: true, user: db.getUserBySessionToken(token), token };
  });

  ipcMain.handle(IPC.signUp, async (event, username?: string, password?: string, confirmPassword?: string, displayName?: string) => {
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

    // Under cloud accounts the username field holds the email, and the account is made in the cloud.
    if (await inCloudAccounts()) {
      const name = typeof displayName === "string" ? displayName.trim() : "";
      if (!name) return { accepted: false, reason: "Please enter your name" };
      return answerFor(event, await cloudSignUp(await accountDeps(), normalizedUsername, normalizedPassword, name));
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

  ipcMain.handle(IPC.changePassword, async (_event, currentPassword?: string, newPassword?: string, confirmPassword?: string, token?: string) => {
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

    // Under cloud accounts a password lives in the cloud; this computer's check is remade with it.
    if (await inCloudAccounts()) {
      const { caller } = await accountDeps();
      return changeOwnPassword({ db, caller, personToken: personTokenFor(sessionToken) }, current, next);
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
      forgetPersonToken(sessionToken);
    }
    authorizer.release(event);
    return { accepted: true };
  });

  ipcMain.handle(IPC.requestAccess, async (_event, token?: string) => {
    const sessionUser = typeof token === "string" ? db.getUserBySessionToken(token.trim()) : null;
    if (!sessionUser) return { accepted: false, reason: "Your session has expired. Please sign in again." };
    // Under cloud accounts signing up IS the request: there is nothing more to send.
    if (await inCloudAccounts()) return { accepted: true, status: sessionUser.accessStatus };
    try {
      return { accepted: true, ...db.createAccessRequest(sessionUser.id) };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "Unable to request access" };
    }
  });

  ipcMain.handle(IPC.getMyAccessRequest, async (_event, token?: string) => {
    const sessionUser = typeof token === "string" ? db.getUserBySessionToken(token.trim()) : null;
    if (!sessionUser) return { accepted: false, reason: "Your session has expired. Please sign in again." };
    if (await inCloudAccounts()) return { accepted: true, request: { status: sessionUser.accessStatus } };
    return { accepted: true, request: db.getAccessRequestForUser(sessionUser.id) };
  });
}
