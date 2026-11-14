// Printing a ready-made document straight to a printer: the computer's default one, or the one a
// job's role names (shared/printerRole.ts; only store slips name one, QR labels never do).
//
// The renderer builds the document (e.g. a run of QR labels) and asks for it to be printed;
// it never opens a preview window of its own. The document is loaded into a hidden window
// and sent to that printer without a dialog — the operator has already confirmed inside the app.
//
// IPC handlers are registered per feature; every write is authorised through ctx.authorizer
// (see ../authorize.ts) and every channel name comes from shared/ipcChannels.ts.

import { BrowserWindow, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { IPC } from "../../shared/ipcChannels";
import { PRINTER_ROLE } from "../../shared/printerRole";
import { findSlipPrinter, slipPageSize } from "../slipPrinter";
import { safePdfName, saveHtmlAsPdf, type SavePdfResult } from "../pdfFile";
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

interface PrintTarget {
  pageSize: { width: number; height: number } | null;
  /** The printer by name; left out, the computer's default printer. */
  deviceName?: string;
}

/** Sends the loaded page to its printer; resolves with Chromium's answer. */
const printSilently = (window: BrowserWindow, { pageSize, deviceName }: PrintTarget): Promise<PrintDocumentResult> =>
  new Promise((resolve) => {
    window.webContents.print(
      {
        silent: true,
        printBackground: true,
        margins: { marginType: "none" },
        ...(pageSize ? { pageSize } : {}),
        ...(deviceName ? { deviceName } : {}),
      },
      (success, failureReason) => resolve(success ? { accepted: true } : { accepted: false, reason: failureReason || "The printer did not accept the job" })
    );
  });

/** Where a slip goes and how long its page is, or why it cannot be printed here. */
const slipTarget = async (window: BrowserWindow): Promise<PrintTarget | { refused: string }> => {
  const deviceName = findSlipPrinter(await window.webContents.getPrintersAsync());
  if (!deviceName) return { refused: "The slip printer (Star TSP800II) is not installed on this computer" };
  const height = (await window.webContents.executeJavaScript("document.body.getBoundingClientRect().height")) as number;
  return { deviceName, pageSize: slipPageSize(height) };
};

export function registerPrintingHandlers(ctx: IpcContext): void {
  const { logger, authorizer, deviceId, paths } = ctx;

  ipcMain.handle(IPC.printDocument, async (event, payload?: { html?: unknown; pageSize?: unknown; printer?: unknown }): Promise<PrintDocumentResult> => {
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
      const target = payload.printer === PRINTER_ROLE.SLIP ? await slipTarget(printWindow) : { pageSize: pageSizeMicrons(payload.pageSize) };
      if ("refused" in target) return { accepted: false, reason: target.refused };
      const result = await printSilently(printWindow, target);
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

  // "Download PDF": the renderer's document, saved as a PDF where the person chooses (pdfFile.ts). It writes a file
  // the person picked, and nothing in the ERP, so it is open to anyone signed in, like printing.
  ipcMain.handle(IPC.savePdfDocument, async (event, payload?: { html?: unknown; fileName?: unknown; landscape?: unknown }): Promise<SavePdfResult> => {
    authorizer.requireUser(event);
    if (typeof payload?.html !== "string" || payload.html.trim() === "") return { accepted: false, reason: "There is nothing to save." };
    const result = await saveHtmlAsPdf({
      parent: BrowserWindow.fromWebContents(event.sender) ?? undefined,
      html: payload.html,
      fileName: safePdfName(typeof payload.fileName === "string" ? payload.fileName : "", "document"),
      scratchDir: paths.scratchDir,
      landscape: payload.landscape === true,
    });
    if (!result.accepted && "reason" in result) {
      logger.log({ module: "printing", severity: "WARNING", operation: "save-pdf", deviceId, message: `PDF not saved: ${result.reason}` });
    }
    return result;
  });
}
