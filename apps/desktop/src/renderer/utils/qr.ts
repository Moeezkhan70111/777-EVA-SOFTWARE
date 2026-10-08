import { parseQrCode } from "@erp/domain";

// Scanner-input helpers shared by every scanning station (Live Production, Live Dispatch,
// Live Return, Store Move In / Move Out). The domain parser is the only authority on what
// a code means; these helpers only shape keyboard-wedge input and produce display parts.
// No page decides anything about a QR here — the main process does that.

/**
 * Strip control characters and upper-case, so wedge scanners and hand-typing agree. Also
 * strips a literal backslash: some scanners are programmed (or default) with a prefix/suffix
 * character that wraps every scan — `\RM_1_1_8\` instead of `RM_1_1_8` — and no code this ERP
 * generates ever legitimately contains one, so it is always scanner framing, never data.
 */
export const sanitizeScanInput = (raw: string): string =>
  raw.replace(/[\x00-\x1F\x7F-\x9F\\]/g, "").trim().toUpperCase();

/**
 * The V1 (ARTICLE_COLOR_SIZE_SERIAL) and planned V2 (FACTORY_…_BATCH_SERIAL) shapes, exactly
 * as @erp/domain qr.ts defines them (size is always `n/n`).
 */
const V1_QR = /^([A-Z0-9]+)_([A-Z0-9]+)_([0-9]+\/[0-9]+)_([0-9]+)$/;
const V2_QR = /^([A-Z0-9]+)_([A-Z0-9]+)_([A-Z0-9]+)_([0-9]+\/[0-9]+)_([A-Z0-9]+)_([0-9]+)$/;

/** True once the buffered text looks like a complete carton QR, so a page can auto-submit. */
export const isCompleteQr = (value: string): boolean => {
  const clean = sanitizeScanInput(value);
  return V1_QR.test(clean) || V2_QR.test(clean);
};

export interface QrDisplayParts {
  article: string;
  color: string;
  size: string;
  serial?: string;
}

/**
 * Article / colour / size / serial for showing a scan result. Uses the domain parser
 * first; for input the parser rejects (which the main process will also reject) it falls
 * back to a best-effort split so the operator still sees what was read.
 */
export const parseQrForDisplay = (raw: string): QrDisplayParts => {
  const clean = sanitizeScanInput(raw);
  try {
    const { payload } = parseQrCode(clean);
    return { article: payload.article, color: payload.color, size: payload.size, serial: payload.serial };
  } catch {
    // fall through to the lenient display split
  }
  const v2 = clean.match(V2_QR);
  if (v2) return { article: v2[2] ?? "", color: v2[3] ?? "", size: v2[4] ?? "", serial: v2[6] ?? "" };
  const parts = clean.split("_");
  return {
    article: parts[0] ?? "",
    color: parts[1] ?? "",
    size: parts[2] ?? "",
    serial: parts.length >= 4 ? parts.slice(3).join("_") : undefined,
  };
};
