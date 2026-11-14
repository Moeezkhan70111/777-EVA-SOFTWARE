// SAVING A DOCUMENT AS A PDF FILE: the person chooses where, the document is rendered in a hidden window, and the
// file is written. One implementation for every "Download PDF" (the Rate List, the production reports) (R1).
//
// The renderer builds the HTML; nothing in it is trusted to run: the hidden window is sandboxed, and the page is
// loaded from a temporary local file (Chromium refuses large percent-encoded data URLs, and a file keeps embedded
// images and CSS intact). A file that is open elsewhere (EBUSY/EPERM/EACCES) is saved beside it as "name (1).pdf".

import { BrowserWindow, dialog } from "electron";
import fs from "node:fs";
import path from "node:path";

export type SavePdfResult =
  | { accepted: true; filePath: string }
  | { accepted: false; canceled: true }
  | { accepted: false; reason: string };

export interface SavePdfOptions {
  /** The window the Save dialog belongs to. */
  parent?: BrowserWindow;
  html: string;
  /** The name offered in the Save dialog. */
  fileName: string;
  /** Where the temporary page is written (runtimePaths scratchDir). */
  scratchDir: string;
  landscape?: boolean;
}

const LOCKED = new Set(["EBUSY", "EPERM", "EACCES"]);

/** Writes the PDF, or beside it as "name (n).pdf" when the chosen file is open in another program. */
const writeBesideIfLocked = (chosen: string, pdf: Buffer): string => {
  try {
    fs.writeFileSync(chosen, pdf);
    return chosen;
  } catch (error) {
    if (!LOCKED.has((error as { code?: string }).code ?? "")) throw error;
    const parsed = path.parse(chosen);
    let suffix = 1;
    let candidate: string;
    do {
      candidate = path.join(parsed.dir, `${parsed.name} (${String(suffix)})${parsed.ext}`);
      suffix += 1;
    } while (fs.existsSync(candidate));
    fs.writeFileSync(candidate, pdf);
    return candidate;
  }
};

/** A file name Windows accepts, with .pdf on the end. */
export const safePdfName = (name: string, fallback: string): string => {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, " ").replace(/\s+/g, " ").trim().replace(/\.pdf$/i, "");
  return `${cleaned || fallback}.pdf`;
};

export async function saveHtmlAsPdf(options: SavePdfOptions): Promise<SavePdfResult> {
  const saveOptions = { defaultPath: options.fileName, filters: [{ name: "PDF document", extensions: ["pdf"] }] };
  const choice = options.parent ? await dialog.showSaveDialog(options.parent, saveOptions) : await dialog.showSaveDialog(saveOptions);
  if (choice.canceled || !choice.filePath) return { accepted: false, canceled: true };

  const tempHtmlPath = path.join(options.scratchDir, `document-${String(Date.now())}-${Math.random().toString(36).slice(2)}.html`);
  const printWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    fs.writeFileSync(tempHtmlPath, options.html, "utf8");
    await printWindow.loadFile(tempHtmlPath);
    const pdf = await printWindow.webContents.printToPDF({ printBackground: true, pageSize: "A4", landscape: options.landscape ?? false });
    return { accepted: true, filePath: writeBesideIfLocked(choice.filePath, pdf) };
  } catch (error) {
    return { accepted: false, reason: error instanceof Error ? error.message : "The PDF could not be made." };
  } finally {
    if (!printWindow.isDestroyed()) printWindow.destroy();
    try { fs.unlinkSync(tempHtmlPath); } catch { /* already removed */ }
  }
}
