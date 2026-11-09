// Carton Cloud activation, from Settings (packages/data/src/database/stockProtection.ts; docs/44).
//
// IPC handlers are registered per feature; every write is authorised through ctx.authorizer (see ../authorize.ts) and
// every channel name comes from shared/ipcChannels.ts.
//
//   getCartonCloudStatus   whether Carton Cloud is active here, the cutoff if it is, and every reason it may not be
//                          activated yet (cloud migrations, lease holders, a fresh lease read). Reads only. Administrators.
//   getCartonCloudState    for every signed-in user: is cloud sync set up here, and is Carton Cloud active. The working
//                          screens warn from it that work saved before activation stays local as test data.
//   activateCartonCloud    ONCE per database, by an administrator at this computer, who names the cloud project shown
//                          to them: a stale screen, or a computer that has moved project since, is refused. Logged with
//                          the time, the device, the project and the cutoff.
//
// Not a leased write: activation sends nothing and moves no figure. It only decides, for ever, which local stock
// records may be sent: those made after it.

import { ipcMain } from "electron";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { rejection } from "../authorize";
import { isCloudSyncConfigured } from "../cloudSyncPass";

export interface CartonCloudContext {
  db: Pick<IpcContext["db"], "cartonCloudStatus" | "activateCartonCloud">;
  logger: Pick<IpcContext["logger"], "log">;
  authorizer: Pick<IpcContext["authorizer"], "requireAdmin" | "requireUser">;
  deviceId: string;
  paths: Pick<IpcContext["paths"], "dataRoot">;
}

export function registerCartonCloudHandlers(ctx: CartonCloudContext): void {
  const { db, logger, authorizer, deviceId } = ctx;

  ipcMain.handle(IPC.getCartonCloudState, (event) => {
    try {
      authorizer.requireUser(event);
    } catch (error) {
      return rejection(error, "Whether Carton Cloud is active could not be read.");
    }
    const configured = isCloudSyncConfigured({ deviceId, dataRoot: ctx.paths.dataRoot });
    return { accepted: true as const, value: { configured, state: db.cartonCloudStatus(new Date().toISOString()).state } };
  });

  ipcMain.handle(IPC.getCartonCloudStatus, (event) => {
    try {
      authorizer.requireAdmin(event);
    } catch (error) {
      return rejection(error, "Whether Carton Cloud is active could not be read.");
    }
    return { accepted: true as const, value: db.cartonCloudStatus(new Date().toISOString()) };
  });

  ipcMain.handle(IPC.activateCartonCloud, (event, confirmedProject?: unknown) => {
    let admin;
    try {
      admin = authorizer.requireAdmin(event);
    } catch (error) {
      return rejection(error, "Carton Cloud could not be activated.");
    }
    const nowIso = new Date().toISOString();
    const shown = db.cartonCloudStatus(nowIso).projectKey;
    if (typeof confirmedProject !== "string" || shown === null || confirmedProject !== shown) {
      logger.log({ module: "sync", severity: "WARNING", operation: "carton-cloud-activation", deviceId, userId: admin.id,
        message: `${admin.username} tried to activate Carton Cloud for a project that is not the one this computer syncs with; refused.` });
      return { accepted: false as const, reason: "The cloud project has changed since this screen was opened. Reload it, check the project, then try again." };
    }
    const outcome = db.activateCartonCloud({ nowIso, activatedBy: admin.username });
    if (!outcome.activated) {
      logger.log({ module: "sync", severity: "INFO", operation: "carton-cloud-activation", deviceId, userId: admin.id,
        message: `${admin.username} asked to activate Carton Cloud; refused: ${outcome.problems.join(" | ")}` });
      return { accepted: false as const, reason: outcome.problems.join("\n"), problems: outcome.problems };
    }
    const { activation, retiredMarks, parked } = outcome;
    logger.log({ module: "sync", severity: "WARNING", operation: "carton-cloud-activation", deviceId, userId: admin.id,
      message:
        `${admin.username} ACTIVATED Carton Cloud at ${activation.activatedAt} on device ${activation.deviceId} for ${activation.projectKey}. ` +
        `Cutoff (excluded for ever at or below): ${JSON.stringify(activation.cutoff)}. ` +
        `Retired marks of test records: ${JSON.stringify(retiredMarks)}. Parked queued test events: ${String(parked)}.` });
    return { accepted: true as const, value: db.cartonCloudStatus(nowIso) };
  });
}
