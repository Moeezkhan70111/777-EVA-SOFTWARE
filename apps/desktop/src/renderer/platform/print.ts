// Platform abstraction for print-outs and the bundled letterhead.
//
// Pages must not call `window.open` / `document.write` themselves. Today the ERP runs in
// Electron, where a popup window with the print dialog is the right behaviour; on the
// planned Android/iOS shell this module is the single place to swap in a native bridge.

import { BRAND_LOGO_URL } from "../config/branding";

export interface PrintDocumentOptions {
  /** Popup features string (only meaningful in a desktop browser/Electron). */
  features?: string;
}

export type PrintDocumentResult = { opened: true; window: Window } | { opened: false; reason: "POPUP_BLOCKED" };

/**
 * Opens a print-ready window synchronously (so it counts as user-initiated) and fills it
 * with `html`. Returns `{ opened: false }` when the popup was blocked so the caller can
 * tell the operator.
 */
export const openPrintDocument = (html: string, options: PrintDocumentOptions = {}): PrintDocumentResult => {
  const popup = window.open("", "_blank", options.features);
  if (!popup) return { opened: false, reason: "POPUP_BLOCKED" };
  popup.document.write(html);
  popup.document.close();
  return { opened: true, window: popup };
};

/**
 * Same as `openPrintDocument`, but the window is opened at once (inside the click) and
 * filled when `html` resolves — for documents that first need an asset such as the logo.
 */
export const openPrintDocumentAsync = (html: Promise<string>, options: PrintDocumentOptions = {}): boolean => {
  const popup = window.open("", "_blank", options.features);
  if (!popup) return false;
  void html.then((content) => {
    popup.document.write(content);
    popup.document.close();
  });
  return true;
};

/** A document page size in inches, e.g. one 3 × 2 sticker. */
export interface PrintPageSize {
  widthIn: number;
  heightIn: number;
}

export type PrintDirectResult = { printed: true } | { printed: false; reason: string };

/**
 * Prints a ready-made document straight on the computer's default printer — no preview
 * window, no print dialog. Callers confirm with the operator first. On the desktop this goes
 * through the main process; a mobile shell would route it to its native print bridge here.
 */
export const printDocumentDirect = async (html: string, pageSize?: PrintPageSize): Promise<PrintDirectResult> => {
  try {
    const result = await window.desktop.api.printDocument({ html, pageSize });
    return result.accepted ? { printed: true } : { printed: false, reason: result.reason ?? "The printer did not accept the job" };
  } catch (error) {
    return { printed: false, reason: error instanceof Error ? error.message : "Could not print" };
  }
};

/** The bundled letterhead logo as a data URL; empty when it cannot be read (print still works). */
export const loadLogoDataUrl = async (): Promise<string> => {
  try {
    const response = await fetch(BRAND_LOGO_URL);
    const blob = await response.blob();
    return await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(typeof reader.result === "string" ? reader.result : "");
      reader.onerror = () => resolve("");
      reader.readAsDataURL(blob);
    });
  } catch {
    return "";
  }
};
