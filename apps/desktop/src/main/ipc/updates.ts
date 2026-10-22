// Automatic updates, as the renderer sees them.
//
// Three channels and nothing else: what the state is, check again, install now. The engine and
// every decision in it live in main/updater.ts — this file only exposes it and authorises it.
//
// WHO MAY DO WHAT
//
//   status   any signed-in user. The "update ready" prompt is for whoever is standing at the
//            machine, and on a factory PC that is not an administrator.
//   check    any signed-in user. It reads a public-facing release feed and changes nothing here.
//   install  any signed-in user, deliberately. Installing is a restart of the application on
//            the machine they are already sitting at, it destroys nothing, and the alternative
//            is a factory PC that stays on an old build because the one person who could press
//            the button is not in the building. The update lands on the next ordinary quit
//            anyway (autoInstallOnAppQuit), so this only changes WHEN, not WHETHER.
//
// WHAT THE RENDERER NEVER GETS: the update token. It is never read here, never logged and never
// part of a status. A refused credential is reported as "an administrator needs to renew it".

import { app, ipcMain } from "electron";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { rejection } from "../authorize";
import type { UpdateStatus } from "../updater";

/** What a computer with no update service reports — an honest state, not an error. */
const unavailable = (currentVersion: string): UpdateStatus => ({
  phase: "DISABLED",
  currentVersion,
  reason: "Automatic updates are not running on this computer. Everything else in 777 ERP works normally.",
});

export function registerUpdateHandlers(ctx: IpcContext): void {
  const { updates, authorizer, logger, deviceId } = ctx;
  // The running version is a property of this process, not of the update service, so a computer
  // with no service still reports what it is running.
  const currentVersion = app.getVersion();

  ipcMain.handle(IPC.getUpdateStatus, (event): UpdateStatus => {
    authorizer.requireUser(event);
    return updates?.status() ?? unavailable(currentVersion);
  });

  ipcMain.handle(IPC.checkForUpdates, async (event): Promise<UpdateStatus> => {
    authorizer.requireUser(event);
    if (updates === null) return unavailable(currentVersion);
    return updates.checkNow();
  });

  ipcMain.handle(IPC.installUpdate, (event): { accepted: boolean; reason?: string } => {
    const user = authorizer.requireUser(event);
    if (updates === null) {
      return { accepted: false, reason: "Automatic updates are not running on this computer." };
    }
    const outcome = updates.installNow();
    // Logged because it is the last thing this installation does before it restarts: if the new
    // build fails to open, this line is what says when the old one was still running.
    logger.log({
      module: "update",
      severity: outcome.accepted ? "INFO" : "WARNING",
      operation: "install-update",
      deviceId,
      userId: user.id,
      message: outcome.accepted
        ? `${user.username} restarted 777 ERP to install a downloaded update.`
        : `${user.username} asked to install an update and it was refused: ${outcome.reason ?? "no reason given"}`,
    });
    return outcome;
  });

  // ADMIN-ONLY, unlike installing. Installing affects the machine the operator is sitting at;
  // discarding changes what everyone else's next restart does, and is the action taken when a
  // bad version is being pulled back (docs/36 §A2).
  ipcMain.handle(IPC.discardUpdate, (event): { accepted: boolean; reason?: string } => {
    let admin;
    try {
      admin = authorizer.requireAdmin(event);
    } catch (error) {
      return rejection(error, "The downloaded update could not be discarded.");
    }
    if (updates === null) {
      return { accepted: false, reason: "Automatic updates are not running on this computer." };
    }
    const outcome = updates.discardDownloaded();
    logger.log({
      module: "update",
      severity: outcome.accepted ? "INFO" : "WARNING",
      operation: "discard-update",
      deviceId,
      userId: admin.id,
      message: outcome.accepted
        ? `${admin.username} discarded the downloaded update on this computer.`
        : `${admin.username} asked to discard a downloaded update and it was refused: ${outcome.reason ?? "no reason given"}`,
    });
    return outcome;
  });
}
