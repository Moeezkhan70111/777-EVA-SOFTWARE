// Platform abstraction for print-outs and the bundled letterhead.
//
// Pages must not call `window.open` / `document.write` themselves. Today the ERP runs in
// Electron, where a popup window with the print dialog is the right behaviour; on the
// planned Android/iOS shell this module is the single place to swap in a native bridge.

import type { PrinterRole } from "../../shared/printerRole";
import { BRAND_LOGO_URL } from "../config/branding";
import { desktopApi } from "../hooks/useDesktopApi";

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
 * Prints a ready-made document straight on the computer's default printer, or on the one a role
 * names — no preview window, no print dialog. On the desktop this goes through the main process;
 * a mobile shell would route it to its native print bridge here.
 */
export const printDocumentDirect = async (html: string, pageSize?: PrintPageSize, printer?: PrinterRole): Promise<PrintDirectResult> => {
  try {
    const result = await desktopApi().printDocument({ html, pageSize, printer });
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

/** The family the app's Urdu is set in (theme.css --font-urdu, bundled from @fontsource). */
const URDU_FONT_FAMILY = "Noto Nastaliq Urdu";

/**
 * The bundled Urdu font, as @font-face rules a print window can use (26 Nov 2026).
 *
 * A print-out is its own window: it cannot see the app's stylesheet, so its Urdu fell back to whatever font the
 * computer had (often Tahoma), not the Nastaliq every screen shows. The app's stylesheet already carries the font
 * itself (the renderer build inlines it), so its @font-face rules are copied into the print-out as they are: the
 * same letters on paper as on screen, offline, with nothing downloaded or bundled twice. "" when there are none
 * (a test, or a stylesheet that cannot be read), and the print-out falls back as before.
 */
export const urduFontFaceCss = (): string => {
  const rules: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let sheetRules: CSSRuleList;
    try { sheetRules = sheet.cssRules; } catch { continue; }
    for (const rule of Array.from(sheetRules)) {
      const css = rule.cssText;
      if (css.trimStart().startsWith("@font-face") && css.includes(URDU_FONT_FAMILY)) rules.push(css);
    }
  }
  return rules.join("\n");
};
