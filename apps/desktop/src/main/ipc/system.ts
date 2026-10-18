// Settings, backups, health, scanner presence and logs.
//
// IPC handlers are registered per feature; every write is authorised through ctx.authorizer
// (see ../authorize.ts) and every channel name comes from shared/ipcChannels.ts.

import { ipcMain } from "electron";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { app } from "electron";
import { asOptionalString, oneOf } from "@erp/domain";
import { resetLocalData } from "../runtimePaths";
import { childProcessEnv } from "../cloudConfig";

export function registerSystemHandlers(ctx: IpcContext): void {
  const { db, logger, authorizer, deviceId, paths, useCases } = ctx;
  const { processScanUseCase, dispatchScanUseCase, returnScanUseCase, storeEntryScanUseCase, storeExitScanUseCase, createGatepassUseCase, cancelGatepassUseCase } = useCases;

  ipcMain.handle(IPC.getSettings, () => db.getSettings());

  ipcMain.handle(IPC.saveSettings, (event, entries?: Record<string, string>) => {
    authorizer.requireUser(event);
    // Writes everything except the keys that decide which document numbers this computer owns:
    // the screen sends every setting back on save, and the range is written only by provisioning
    // (see ./numberBlock.ts).
    const { dropped } = db.setOperatorSettings(entries ?? {}, "desktop-ui");
    if (dropped.length > 0) {
      logger.log({
        module: "settings",
        severity: "WARNING",
        operation: "save-settings",
        deviceId,
        message: `Ignored protected setting(s) sent from the renderer: ${dropped.join(", ")}`
      });
    }
    logger.log({
      module: "settings",
      severity: "INFO",
      operation: "save-settings",
      deviceId,
      message: "Settings updated from renderer"
    });
  });

  // Destructive: wipes the local database, product images and sign-ins, then relaunches
  // into a genuinely empty app (see resetLocalData for what is kept and why).
  ipcMain.handle(IPC.resetDatabase, (event) => {
    const admin = authorizer.requireAdmin(event);
    logger.log({ module: "settings", severity: "CRITICAL", operation: "reset-database", deviceId, userId: admin.id, message: `Database reset requested by ${admin.username}` });
    db.close();
    resetLocalData(paths, admin.username);

    setImmediate(() => {
      app.relaunch();
      app.exit(0);
    });

    return { accepted: true };
  });

  ipcMain.handle(IPC.createBackup, (event) => {
    authorizer.requireUser(event);
    const settings = db.getSettings();
    const backupFolder = settings["backup.folder"] || paths.backupsDir;
    const backup = db.createBackup(backupFolder, "MANUAL");
    logger.log({
      module: "backup",
      severity: "INFO",
      operation: "create-backup",
      deviceId,
      message: `Backup created in ${backupFolder}`
    });
    return backup;
  });

  ipcMain.handle(IPC.listBackups, () => db.listBackups());

  ipcMain.handle(IPC.getHealth, () => {
    return db.captureHealthSnapshot({
      scannerConnected: true,
      appVersion: app.getVersion(),
      deviceId
    });
  });

  // Detects the Motorola/Zebra LI4278 by its stable Bluetooth MAC (C47DCC16FAE5)
  // or its USB cradle (VID_05E0 / PID_1200). Uses PowerShell PnP query.
  // Returns false on any error or if no matching device is present.
  ipcMain.handle(IPC.scannerStatus, async () => {
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);

      // Query 1: Bluetooth device by MAC address (works regardless of adapter)
      // Query 2: USB cradle by VID/PID
      // PowerShell script returns "true" if any matching device IsPresent = True
      const ps = `
        $btMac = 'C47DCC16FAE5'
        $usbVidPid = 'VID_05E0.*PID_1200'
        $found = $false
        Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object {
          ($_.InstanceId -match $btMac) -or ($_.InstanceId -match $usbVidPid)
        } | ForEach-Object {
          try {
            $present = (Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName 'DEVPKEY_Device_IsPresent' -ErrorAction Stop).Data
            if ($present -eq $true) { $found = $true }
          } catch {}
        }
        Write-Output $found
      `.trim();

      // An explicit environment, not this process's. A spawned child inherits everything by
      // default, which would hand a PnP device query the cloud device account's password; it
      // has no use for it, and it would sit in that child's environment block for anything able
      // to read it. childProcessEnv keeps every variable powershell.exe actually needs.
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", ps],
        { timeout: 5000, windowsHide: true, env: childProcessEnv() }
      );

      return stdout.trim().toLowerCase() === "true";
    } catch {
      return false;
    }
  });

  ipcMain.handle(IPC.getLogs, (_event, query?: Record<string, unknown>) => {
    return logger.readEntries({
      level: oneOf(query?.level, ["ALL", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] as const, "ALL"),
      module: asOptionalString(query?.module),
      fromDate: asOptionalString(query?.fromDate),
      toDate: asOptionalString(query?.toDate),
    });
  });
}
