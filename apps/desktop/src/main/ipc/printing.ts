// Printing a ready-made document straight to the computer's default printer.
//
// The renderer builds the document (e.g. a run of QR labels) and asks for it to be printed;
// it never opens a preview window of its own. The document is loaded into a hidden window
// and sent to the system default printer without a dialog — the operator has already
// confirmed inside the app.
//
// IPC handlers are registered per feature; every write is authorised through ctx.authorizer
// (see ../authorize.ts) and every channel name comes from shared/ipcChannels.ts.

import { BrowserWindow, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";

const MICRONS_PER_INCH = 25400;
/** Sanity bounds for a page edge: smaller than a sticker or larger than A3 is a mistake. */
const MIN_PAGE_EDGE_IN = 0.5;
const MAX_PAGE_EDGE_IN = 17;

export interface PrintDocumentResult {
  accepted: boolean;
  reason?: string;
}

/** The page size in microns, or null when none (or a nonsensical one) was sent. */
const pageSizeMicrons = (value: unknown): { width: number; height: number } | null => {
  if (typeof value !== "object" || value === null) return null;
  const { widthIn, heightIn } = value as { widthIn?: unknown; heightIn?: unknown };
  const valid = (edge: unknown): edge is number =>
    typeof edge === "number" && Number.isFinite(edge) && edge >= MIN_PAGE_EDGE_IN && edge <= MAX_PAGE_EDGE_IN;
  if (!valid(widthIn) || !valid(heightIn)) return null;
  return { width: Math.round(widthIn * MICRONS_PER_INCH), height: Math.round(heightIn * MICRONS_PER_INCH) };
};

/** Sends the loaded page to the default printer; resolves with Chromium's answer. */
const printSilently = (window: BrowserWindow, pageSize: { width: number; height: number } | null): Promise<PrintDocumentResult> =>
  new Promise((resolve) => {
    window.webContents.print(
      {
        silent: true,
        printBackground: true,
        margins: { marginType: "none" },
        ...(pageSize ? { pageSize } : {}),
      },
      (success, failureReason) => resolve(success ? { accepted: true } : { accepted: false, reason: failureReason || "The printer did not accept the job" })
    );
  });

export function registerPrintingHandlers(ctx: IpcContext): void {
  const { logger, authorizer, deviceId, paths } = ctx;

  ipcMain.handle(IPC.printDocument, async (event, payload?: { html?: unknown; pageSize?: unknown }): Promise<PrintDocumentResult> => {
    authorizer.requireUser(event);
    if (typeof payload?.html !== "string" || payload.html.trim() === "") {
      return { accepted: false, reason: "Nothing to print" };
    }

    // Chromium rejects large data URLs, so the document goes through a temporary local file.
    const tempHtmlPath = path.join(paths.scratchDir, `print-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
    const printWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    try {
      fs.writeFileSync(tempHtmlPath, payload.html, "utf8");
      await printWindow.loadFile(tempHtmlPath);
      const result = await printSilently(printWindow, pageSizeMicrons(payload.pageSize));
      if (!result.accepted) {
        logger.log({ module: "printing", severity: "WARNING", operation: "print-document", deviceId, message: `Print failed: ${result.reason}` });
      }
      return result;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Could not print";
      logger.log({ module: "printing", severity: "ERROR", operation: "print-document", deviceId, message: `Print failed: ${reason}` });
      return { accepted: false, reason };
    } finally {
      if (!printWindow.isDestroyed()) printWindow.destroy();
      try { fs.unlinkSync(tempHtmlPath); } catch { /* already removed */ }
    }
  });
}
