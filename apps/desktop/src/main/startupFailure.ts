import { app, dialog } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Fatal startup reporting.
//
// A packaged ERP must never present a normal-looking window with no working database behind it:
// every screen would fail with "no handler registered" and the operator would have no idea why.
// If initialisation fails, they get one plain dialog naming a log file they can send on, and the
// process exits non-zero.
//
// Deliberately dependency-free — no @erp/data, no StructuredLogger — because the failure being
// reported may be the data layer itself failing to load.

export const STARTUP_LOG_FILE_NAME = "startup.log";

/**
 * Where the diagnostic line goes: beside the application's other logs when the data folder is
 * usable, otherwise temp (the data folder being unusable is itself one of the failures here).
 */
export const startupLogFile = (logsDir?: string): string =>
  path.join(logsDir?.trim() || path.join(os.tmpdir(), "777-erp-logs"), STARTUP_LOG_FILE_NAME);

export interface StartupFailure {
  /** Which step failed: "filesystem-locations" or "database". */
  stage: string;
  error: unknown;
}

const errorDetails = (error: unknown): { name: string; message: string; stack?: string } =>
  error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { name: "NonError", message: String(error) };

/**
 * Appends one JSON line describing the failure, in the same shape StructuredLogger uses so both
 * files read alike. Never throws: logging must not replace the error it is reporting.
 *
 * Only environment and error text is recorded — no session tokens, no passwords, no encryption
 * keys, no database contents.
 */
export function logStartupFailure(failure: StartupFailure, logsDir?: string): string {
  const file = startupLogFile(logsDir);
  const details = errorDetails(failure.error);
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    module: "startup",
    severity: "CRITICAL",
    operation: failure.stage,
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    packaged: app.isPackaged,
    message: details.message,
    errorName: details.name,
    errorDetails: details.stack,
  });

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${line}\n`, "utf-8");
  } catch {
    // Nothing further to try — the dialog below still tells the operator what happened.
  }
  console.error(line);
  return file;
}

const FATAL_TITLE = "777 ERP";
const FATAL_MESSAGE = "777 ERP could not start";

const fatalDetail = (logFile: string): string =>
  [
    "The application could not initialize its database.",
    "",
    "Please contact the administrator and provide the diagnostic log:",
    logFile,
  ].join("\n");

/**
 * Logs the failure, tells the operator in plain words, and exits. Called instead of opening the
 * main window, so a broken installation can never look like a working one.
 */
export function reportFatalStartupError(failure: StartupFailure, logsDir?: string): void {
  const logFile = logStartupFailure(failure, logsDir);
  try {
    dialog.showMessageBoxSync({
      type: "error",
      title: FATAL_TITLE,
      message: FATAL_MESSAGE,
      detail: fatalDetail(logFile),
      buttons: ["Close"],
      defaultId: 0,
    });
  } catch {
    // showMessageBoxSync needs a ready app; showErrorBox works at any point.
    dialog.showErrorBox(FATAL_MESSAGE, fatalDetail(logFile));
  }
  app.exit(1);
}
