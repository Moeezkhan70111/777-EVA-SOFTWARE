import React, { useMemo } from "react";
import qrcode from "qrcode-generator";
import { escapeHtml } from "./html";
import { openPrintDocument, printDocumentDirect, type PrintDirectResult } from "../platform/print";
import { colorValueInUrdu } from "./urdu";
import { copy } from "../config/copy";

// Shared by the QR Generator, QR Management and Raw Material label pages so a label is drawn
// and printed exactly one way. The encoded value is always the registered identity itself —
// the registry (qr_codes / raw_material_qr_codes) stays the source of truth for everything
// else, so a relabelled or reprinted carton can never carry stale article/colour/size data.

// ─── The printed sticker ─────────────────────────────────────────────────────────
// Each label prints on its own 3in wide × 2in tall page — the physical sticker size 777
// already buys — so labels come off the printer pre-sized for the stock rather than needing
// to be cut.
const LABEL_WIDTH_IN = 3;
const LABEL_HEIGHT_IN = 2;

/** Keeps the artwork clear of the printer edge tolerance on all four sides. */
const SAFE_MARGIN_IN = 0.08;
/**
 * Blank modules the QR specification requires on all four sides of the symbol. Carried inside
 * the artwork (as part of the drawn viewBox, at one unit per module) rather than as label
 * padding, so it stays exactly this many modules wide however large the symbol is printed.
 */
const QUIET_ZONE_MODULES = 4;
/** Artwork box: the sticker less the safe margin on each side. */
const ARTWORK_WIDTH_IN = LABEL_WIDTH_IN - 2 * SAFE_MARGIN_IN;
const ARTWORK_HEIGHT_IN = LABEL_HEIGHT_IN - 2 * SAFE_MARGIN_IN;
/**
 * Printed side of the square symbol. A carton identity (ARTICLE_COLOR_SIZE_SERIAL) needs
 * 25–33 modules at error-correction level M, so 1.3in keeps every module at roughly 1mm —
 * comfortably above the ~0.33mm a handheld imager needs, even on a smudged thermal print.
 * The rest of the height carries the two text lines: the plain-language name above and the
 * identity below.
 */
const QR_SIDE_IN = 1.3;

/**
 * Error-correction level M recovers ~15% of a damaged symbol. Cartons are handled, stacked
 * and scanned in a factory, so a label that has been scuffed must still read; L would fit a
 * smaller symbol but gives up that margin, and Q/H would grow the symbol for no gain at the
 * identity lengths 777 issues.
 */
const ERROR_CORRECTION_LEVEL = "M" as const;
/** 0 = let the encoder pick the smallest version that fits the identity. */
const AUTO_TYPE_NUMBER = 0;

/**
 * Turns one identity into the dark-module geometry of its QR symbol: an SVG path covering
 * every dark module, plus the side of the square (symbol + quiet zone) in module units,
 * which is the viewBox the path is drawn in.
 *
 * One path for the whole symbol rather than a rect per module keeps both the print document
 * and the on-screen preview to a single node, and scales crisply at any printed size.
 */
const buildQrGeometry = (value: string): { path: string; side: number } => {
  const qr = qrcode(AUTO_TYPE_NUMBER, ERROR_CORRECTION_LEVEL);
  qr.addData(value);
  qr.make();

  const moduleCount = qr.getModuleCount();
  const segments: string[] = [];
  for (let row = 0; row < moduleCount; row += 1) {
    for (let col = 0; col < moduleCount; col += 1) {
      if (!qr.isDark(row, col)) continue;
      segments.push(`M${col + QUIET_ZONE_MODULES} ${row + QUIET_ZONE_MODULES}h1v1h-1z`);
    }
  }
  return { path: segments.join(""), side: moduleCount + 2 * QUIET_ZONE_MODULES };
};

/**
 * Renders the QR symbol for one identity as SVG markup for print output. The human-readable
 * identity is printed as text beneath it (see the label styles below) rather than inside the
 * symbol, so it stays crisp at any size. Falls back to the plain identity so a rendering
 * failure never loses the registered value.
 */
export const renderQrSvgMarkup = (value: string): string => {
  try {
    const { path, side } = buildQrGeometry(value);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges">` +
      `<rect width="${side}" height="${side}" fill="#fff"/>` +
      `<path d="${path}" fill="#000"/>` +
      `</svg>`
    );
  } catch {
    return `<div class="label-fallback">${escapeHtml(value)}</div>`;
  }
};

/**
 * On-screen QR preview of a registered identity: the same symbol the label prints, with the
 * identity printed under it exactly as the sticker carries it, so an operator can check a
 * printed label against the screen without scanning it.
 */
export const QrPreview: React.FC<{ value: string }> = ({ value }) => {
  // Built as React elements rather than injected markup: the same geometry, with no HTML
  // string ever reaching the DOM.
  const geometry = useMemo(() => {
    try {
      return buildQrGeometry(value);
    } catch {
      // A preview that cannot be drawn must not take the surrounding panel down with it.
      return null;
    }
  }, [value]);

  return (
    <div className="qr-preview">
      {geometry && (
        <svg
          className="qr-preview-svg"
          viewBox={`0 0 ${geometry.side} ${geometry.side}`}
          shapeRendering="crispEdges"
          role="img"
          aria-label={`QR code for ${value}`}
        >
          <rect width={geometry.side} height={geometry.side} fill="#fff" />
          <path d={geometry.path} fill="#000" />
        </svg>
      )}
      <span className="qr-preview-value">{value}</span>
    </div>
  );
};

const PRINT_STYLES = `
  * { box-sizing: border-box; }
  @page { size: ${LABEL_WIDTH_IN}in ${LABEL_HEIGHT_IN}in; margin: 0; }
  body { font-family: "Segoe UI", Helvetica, Arial, sans-serif; margin: 24px; color: #111; }
  .print-actions { text-align: center; margin-bottom: 20px; }
  .print-actions button {
    padding: 10px 26px; font-size: 13px; font-weight: 600; letter-spacing: .04em;
    text-transform: uppercase; background: #17365d; color: #fff; border: none; border-radius: 4px; cursor: pointer;
  }
  .print-heading { text-align: center; margin-bottom: 18px; }
  .print-heading h1 { font-size: 16px; margin: 0 0 4px; }
  .print-heading p { font-size: 12px; color: #555; margin: 0; }
  .label-grid { display: flex; flex-direction: column; align-items: center; gap: 14px; }
  /* One sticker, shared by cartons and raw material packets. */
  .label {
    width: ${LABEL_WIDTH_IN}in; height: ${LABEL_HEIGHT_IN}in;
    display: flex; align-items: center; justify-content: center;
    border: 1px solid #999; page-break-after: always;
  }
  .label:last-of-type { page-break-after: auto; }
  /* Centred in the sticker with SAFE_MARGIN_IN clear on every side. flex: none so the row
     can never shrink the box to fit — that shrinks the modules until they stop scanning. */
  .label-artwork {
    flex: none;
    width: ${ARTWORK_WIDTH_IN}in; height: ${ARTWORK_HEIGHT_IN}in;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 0.05in;
  }
  /* flex: none for the same reason: the symbol prints at exactly QR_SIDE_IN square, and a
     long name above it must wrap rather than squeeze the symbol. */
  .label-artwork svg { display: block; flex: none; width: ${QR_SIDE_IN}in; height: ${QR_SIDE_IN}in; }
  .label-fallback { font-family: Consolas, "Courier New", monospace; font-size: 0.16in; text-align: center; }
  @media print {
    .print-actions, .print-heading { display: none; }
    body { margin: 0; }
    .label { border: none; }
  }
`;


// ─── Raw material label ───────────────────────────────────────────────────────
// A raw material label carries more than a finished-goods sticker: the material's category,
// its configured attributes, and the supplier it came from, on the same QR symbol/identity
// every other label prints. It stays on the same LABEL_WIDTH_IN x LABEL_HEIGHT_IN sticker
// stock as the label above — a second, larger label size is its own stock-and-printer
// decision, not this template's to make — so only the layout inside one sticker differs.
//
// The v2 raw material identity (RM_PARTYTOKEN_ITEMTOKEN_SERIAL, e.g. "RM_6_42_6") is short
// enough that its QR symbol needs far fewer modules than a full carton identity, so it keeps
// scanning reliably at well under the 1.3in a full carton identity needs — freeing room for
// the extra text this layout carries.
const RM_QR_SIDE_IN = 0.95;

// ─── Shrink-to-fit text ─────────────────────────────────────────────────────────
// This is a print document generated as a plain HTML string — there is no live DOM or canvas
// to measure real text against before it prints. A category name, a colour, a supplier's name
// are all whatever the operator typed: anywhere from one word to a phrase. Sizing every field
// at one fixed font either clips a long name or leaves a short one looking accidental, so each
// field's font size is computed here from the text it will actually hold, then clamped to a
// floor (never smaller than legible) and a ceiling (never stretched past what looks intentional).
//
// A bold sans-serif glyph averages roughly 0.6 of its font-size in on-screen width; that is the
// whole model. It is an approximation, not real text metrics, so every box also keeps
// `overflow-wrap: anywhere` as the actual safety net if a particular font renders a touch wider
// than this estimate.
const AVG_GLYPH_WIDTH_EM = 0.6;
/** Bold text wraps to roughly this many line-heights per line at these sizes. */
const LINE_HEIGHT_FACTOR = 1.25;

/** The largest font size (inches) that fits `text` on one line `widthIn` wide, clamped to `[minIn, maxIn]`. */
const fitFontSizeIn = (text: string, widthIn: number, minIn: number, maxIn: number): number => {
  const length = text.trim().length || 1;
  return Math.min(maxIn, Math.max(minIn, widthIn / (length * AVG_GLYPH_WIDTH_EM)));
};

/**
 * The largest font size (inches) that fits every one of `values`, each its own line, inside a
 * `widthIn` x `heightIn` box, clamped to `[minIn, maxIn]`. Width and height are both checked
 * and the tighter one wins, so a single long value and a long list of short ones are each
 * sized by whichever dimension actually constrains them.
 */
const fitFontSizeForLines = (values: string[], widthIn: number, heightIn: number, minIn: number, maxIn: number): number => {
  const lines = values.map((value) => value.trim()).filter(Boolean);
  if (lines.length === 0) return maxIn;
  const longest = Math.max(...lines.map((line) => line.length));
  const byWidth = widthIn / (longest * AVG_GLYPH_WIDTH_EM);
  const byHeight = heightIn / (lines.length * LINE_HEIGHT_FACTOR);
  return Math.min(maxIn, Math.max(minIn, Math.min(byWidth, byHeight)));
};

const inches = (value: number): string => `${value.toFixed(3)}in`;

/**
 * Urdu (Nastaliq) glyphs run narrower per character than a bold Latin sans-serif at the same
 * font-size — the script joins and slopes rather than each letter sitting in its own box — so
 * the colour line gets its own, smaller width-per-character estimate rather than reusing
 * AVG_GLYPH_WIDTH_EM. Still an approximation; `overflow-wrap: anywhere` remains the real
 * safety net if a particular installed font runs wider than this.
 */
const URDU_GLYPH_WIDTH_EM = 0.55;

/** Same shrink-to-fit as fitFontSizeIn, for the Urdu colour line's own narrower glyph estimate. */
const fitUrduFontSizeIn = (text: string, widthIn: number, minIn: number, maxIn: number): number => {
  const length = text.trim().length || 1;
  return Math.min(maxIn, Math.max(minIn, widthIn / (length * URDU_GLYPH_WIDTH_EM)));
};

/** Usable width for a line spanning the sticker, clear of the safe margin and a little breathing room. */
const RM_FULL_WIDTH_IN = LABEL_WIDTH_IN - 2 * SAFE_MARGIN_IN - 0.16;
/** Usable width for the attribute list, which shares the body row with the QR symbol. */
const RM_ATTRS_WIDTH_IN = LABEL_WIDTH_IN - 2 * SAFE_MARGIN_IN - RM_QR_SIDE_IN - 0.1 - 0.08;
/** The compact "SK12 / 7/10"-style stack of everything that isn't the colour, next to the QR. */
const RM_PLAIN_ATTRS_WIDTH_IN = 0.62;
/** What is left for the colour once the QR and (if any) the plain-attribute stack have theirs. */
const rmColorWidthIn = (hasPlainAttrs: boolean): number =>
  LABEL_WIDTH_IN - 2 * SAFE_MARGIN_IN - RM_QR_SIDE_IN - 0.16 - (hasPlainAttrs ? RM_PLAIN_ATTRS_WIDTH_IN + 0.08 : 0);

/**
 * The good Urdu typeface this ERP already standardises on for every other Urdu field
 * (theme.css --font-urdu) — repeated here as a literal because this print document is its own
 * standalone HTML page and cannot reach the app's CSS custom properties. Nastaliq first,
 * Naskh as the nearest fallback shape, Tahoma as the last resort that at least has the glyphs.
 */
const URDU_FONT_STACK = `"Noto Nastaliq Urdu", "Noto Naskh Arabic", Tahoma, sans-serif`;

export interface RawMaterialLabelAttribute {
  label: string;
  value: string;
  /** Printed larger than the other attributes — the factory floor reads this one first. */
  isColor: boolean;
}

/** Everything on a raw material sticker that is the same across the whole run — only the QR/code changes per label. */
export interface RawMaterialLabelHeader {
  /** The material's top-level category, e.g. "UPPER". */
  categoryLine: string;
  /** The material's sub-category, e.g. "RUBBER". Empty for a material in a top-level-only category. */
  subCategoryLine: string;
  attributes: RawMaterialLabelAttribute[];
  partyName: string;
  /**
   * How much one packet holds, as a bare figure ("5", "10") — the same material arrives in
   * more than one packet size, so the floor reads it off the label. Empty prints nothing.
   */
  packQuantity: string;
}

// Floor/ceiling per field, in inches — the shrink-to-fit result never leaves this range.
const RM_CATEGORY_RANGE = [0.12, 0.2] as const;
const RM_SUBCATEGORY_RANGE = [0.09, 0.15] as const;
const RM_PARTY_RANGE = [0.1, 0.17] as const;
const RM_CODE_RANGE = [0.08, 0.12] as const;
/** Plain (non-colour) attributes: a compact "SK12 / 7/10"-style stack beside the QR. */
const RM_PLAIN_ATTRIBUTE_RANGE = [0.1, 0.16] as const;
/**
 * The colour line's own, much higher ceiling — colour is the single most important fact on a
 * raw material label (it is what the store actually pulls off the shelf by), so it gets its
 * own dedicated space beside the QR rather than sharing a list with everything else, and is
 * sized to fill that space rather than settling for a fixed bump over the other attributes.
 */
const RM_COLOR_RANGE = [0.2, 0.6] as const;
/** The packet quantity in the bottom-left corner: just the figure, big and bold. */
const RM_PACK_QTY_RANGE = [0.16, 0.3] as const;
/** Width of the bottom-left quantity box, mirrored on the right so the party/code stay centred. */
const RM_PACK_QTY_WIDTH_IN = 0.5;

const RAW_MATERIAL_LABEL_STYLES = `
  .rm-label {
    width: ${LABEL_WIDTH_IN}in; height: ${LABEL_HEIGHT_IN}in;
    box-sizing: border-box; padding: ${SAFE_MARGIN_IN}in;
    display: flex; flex-direction: column; justify-content: space-between; gap: 0.03in;
    border: 1px solid #999; page-break-after: always;
  }
  .rm-label:last-of-type { page-break-after: auto; }
  .rm-label-heading { flex: none; text-align: center; overflow: hidden; }
  .rm-label-heading .rm-category, .rm-label-heading .rm-subcategory { font-weight: 700; line-height: 1.15; overflow-wrap: anywhere; }
  .rm-label-body { flex: 1; min-height: 0; display: flex; align-items: center; gap: 0.08in; }
  .rm-label-qr { flex: none; display: flex; align-items: center; justify-content: center; }
  .rm-label-qr svg { display: block; width: ${RM_QR_SIDE_IN}in; height: ${RM_QR_SIDE_IN}in; }
  /* The fraction-bar look: each plain attribute its own line, ruled off from the next. Width
     is set inline per label — a narrow column beside a big colour, or the full remaining
     width when this material has no colour attribute to make room for. */
  .rm-label-plain-attrs { min-width: 0; overflow: hidden; display: flex; flex-direction: column; align-items: stretch; justify-content: center; }
  .rm-label-plain-attrs div { font-weight: 800; line-height: ${LINE_HEIGHT_FACTOR}; text-align: center; overflow-wrap: anywhere; padding: 0.02in 0; }
  .rm-label-plain-attrs div + div { border-top: 0.02in solid #111; }
  /* Genuinely the star of the label: no width cap forced on it beyond the flex box, no
     overflow clipping — Nastaliq's ascenders/descenders need room a Latin line-height model
     would otherwise cut into. */
  .rm-label-color { flex: 1; min-width: 0; display: flex; align-items: center; justify-content: center; text-align: center; }
  .rm-label-color span { font-family: ${URDU_FONT_STACK}; font-weight: 600; line-height: 1.4; }
  .rm-label-footer { flex: none; display: flex; flex-direction: column; align-items: center; gap: 0.02in; }
  /* With a packet quantity: quantity | party + code | an equal empty box, so the middle stays centred. */
  .rm-label-footer-row { flex: none; display: grid; grid-template-columns: ${RM_PACK_QTY_WIDTH_IN}in minmax(0, 1fr) ${RM_PACK_QTY_WIDTH_IN}in; align-items: end; }
  .rm-label-footer-row .rm-label-footer { min-width: 0; }
  .rm-label-pack-qty { font-weight: 900; line-height: 1; text-align: left; white-space: nowrap; overflow: hidden; text-align:center; margin-left:8px; }
  .rm-label-party { text-align: center; font-weight: 700; line-height: 1.15; overflow: hidden; overflow-wrap: anywhere; }
  .rm-label-code {
    font-family: Consolas, "Courier New", monospace; font-weight: 700;
    text-align: center; overflow-wrap: anywhere;
  }
  @media print { .rm-label { border: none; } }
`;

/**
 * Party name and unique code, centred. When the run has a packet quantity it sits bottom-left,
 * bold, as just the figure — the operator asked for the number, not a sentence.
 */
const renderRawMaterialFooter = (header: RawMaterialLabelHeader, qrId: string, codeFontSizeIn: number): string => {
  const packQuantity = header.packQuantity.trim();
  const centreWidthIn = packQuantity ? RM_FULL_WIDTH_IN - 2 * RM_PACK_QTY_WIDTH_IN : RM_FULL_WIDTH_IN;
  const partySizeIn = fitFontSizeIn(header.partyName, centreWidthIn, ...RM_PARTY_RANGE);
  const footer =
    `<div class="rm-label-footer">` +
    `<div class="rm-label-party" style="font-size:${inches(partySizeIn)}">${escapeHtml(header.partyName)}</div>` +
    `<div class="rm-label-code" style="font-size:${inches(codeFontSizeIn)}">${escapeHtml(qrId)}</div>` +
    `</div>`;
  if (!packQuantity) return footer;
  const qtySizeIn = fitFontSizeIn(packQuantity, RM_PACK_QTY_WIDTH_IN, ...RM_PACK_QTY_RANGE);
  return (
    `<div class="rm-label-footer-row">` +
    `<div class="rm-label-pack-qty" style="font-size:${inches(qtySizeIn)}" aria-label="Packet holds ${escapeHtml(packQuantity)}">${escapeHtml(packQuantity)}</div>` +
    footer +
    `<div aria-hidden="true"></div>` +
    `</div>`
  );
};

const renderRawMaterialLabel = (header: RawMaterialLabelHeader, qrId: string, codeFontSizeIn: number): string => {
  const categorySizeIn = fitFontSizeIn(header.categoryLine, RM_FULL_WIDTH_IN, ...RM_CATEGORY_RANGE);
  const subCategorySizeIn = fitFontSizeIn(header.subCategoryLine, RM_FULL_WIDTH_IN, ...RM_SUBCATEGORY_RANGE);
  const plainAttributes = header.attributes.filter((attribute) => !attribute.isColor);
  const colorAttribute = header.attributes.find((attribute) => attribute.isColor);
  const hasPlainAttrs = plainAttributes.length > 0;
  // Beside a big colour, plain attributes are a narrow column that leaves it the rest of the
  // row. With no colour to make room for, they take the full width instead — the old, single-
  // column layout for a category that has no colour attribute at all.
  const plainAttrsWidthIn = colorAttribute ? RM_PLAIN_ATTRS_WIDTH_IN : RM_ATTRS_WIDTH_IN;

  const plainAttributeSizeIn = fitFontSizeForLines(
    plainAttributes.map((attribute) => attribute.value),
    plainAttrsWidthIn,
    RM_QR_SIDE_IN,
    ...RM_PLAIN_ATTRIBUTE_RANGE
  );
  const plainAttrsHtml = plainAttributes
    .map((attribute) => `<div style="font-size:${inches(plainAttributeSizeIn)}">${escapeHtml(attribute.value)}</div>`)
    .join("");
  const plainAttrsStyle = colorAttribute ? `flex:none;width:${inches(plainAttrsWidthIn)}` : `flex:1`;

  const colorSizeIn = colorAttribute
    ? fitUrduFontSizeIn(colorAttribute.value, rmColorWidthIn(hasPlainAttrs), ...RM_COLOR_RANGE)
    : 0;
  const colorHtml = colorAttribute
    ? `<div class="rm-label-color"><span style="font-size:${inches(colorSizeIn)}">${escapeHtml(colorAttribute.value)}</span></div>`
    : "";

  const subCategoryHtml = header.subCategoryLine
    ? `<div class="rm-subcategory" style="font-size:${inches(subCategorySizeIn)}">${escapeHtml(header.subCategoryLine)}</div>`
    : "";

  return (
    `<div class="rm-label">` +
    `<div class="rm-label-heading">` +
    `<div class="rm-category" style="font-size:${inches(categorySizeIn)}">${escapeHtml(header.categoryLine)}</div>${subCategoryHtml}` +
    `</div>` +
    `<div class="rm-label-body">` +
    `<div class="rm-label-qr">${renderQrSvgMarkup(qrId)}</div>` +
    (hasPlainAttrs ? `<div class="rm-label-plain-attrs" style="${plainAttrsStyle}">${plainAttrsHtml}</div>` : "") +
    colorHtml +
    `</div>` +
    renderRawMaterialFooter(header, qrId, codeFontSizeIn) +
    `</div>`
  );
};

/** Builds the print-ready HTML for a sheet of raw material QR labels sharing one header. */
export const renderRawMaterialLabelSheetHtml = (opts: {
  title: string;
  heading: string;
  subheading: string;
  header: RawMaterialLabelHeader;
  ids: string[];
}): string => {
  // One shared code font size for the whole run — sized to the longest id in the batch, so
  // every sticker in a print job reads at the same size rather than each drifting slightly
  // as the serial gains a digit partway through a large batch.
  const longestId = opts.ids.reduce((longest, id) => (id.length > longest.length ? id : longest), "");
  const codeFontSizeIn = fitFontSizeIn(longestId, RM_FULL_WIDTH_IN, ...RM_CODE_RANGE);
  const labels = opts.ids.map((id) => renderRawMaterialLabel(opts.header, id, codeFontSizeIn)).join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(opts.title)}</title>
  <style>${PRINT_STYLES}${RAW_MATERIAL_LABEL_STYLES}</style>
</head>
<body>
  <div class="print-actions"><button onclick="window.print()">${copy.reports.printOrSave}</button></div>
  <div class="print-heading">
    <h1>${escapeHtml(opts.heading)}</h1>
    <p>${escapeHtml(opts.subheading)}</p>
  </div>
  <div class="label-grid">${labels}</div>
</body>
</html>`;
};

/** Everything one sheet of raw material labels needs: the shared header and the identities. */
export interface RawMaterialLabelSheet {
  title: string;
  heading: string;
  subheading: string;
  header: RawMaterialLabelHeader;
  ids: string[];
}

/**
 * Prints raw material labels straight on the default printer, one sticker per page — no
 * preview window. The caller confirms with the operator first.
 */
export const printRawMaterialLabels = (sheet: RawMaterialLabelSheet): Promise<PrintDirectResult> =>
  printDocumentDirect(renderRawMaterialLabelSheetHtml(sheet), { widthIn: LABEL_WIDTH_IN, heightIn: LABEL_HEIGHT_IN });

// ─── The carton label ─────────────────────────────────────────────────────────
// A finished carton prints the SAME sticker as a raw material packet — one template, so the
// two can never drift apart again. It simply has fewer things to say: an article instead of a
// category, no sub-category, no supplier and no pack figure. Its colour is printed large in
// Urdu, as the floor reads it, through the same transliteration every other Urdu field uses.

/** What one carton's sticker says, from the carton's own identity. */
export const cartonLabelHeader = (identity: { article: string; color: string; size: string }): RawMaterialLabelHeader => ({
  categoryLine: identity.article.trim(),
  subCategoryLine: "",
  attributes: [
    ...(identity.size.trim() ? [{ label: "SIZE", value: identity.size.trim(), isColor: false }] : []),
    ...(identity.color.trim() ? [{ label: "COLOUR", value: colorValueInUrdu(identity.color), isColor: true }] : []),
  ],
  partyName: "",
  packQuantity: "",
});

/**
 * Opens a print-ready window of carton QR labels — the QR Generator's run, or a single code
 * reprinted from QR Management. Both go through here, so both print the same sticker.
 */
export const openCartonLabelPrintWindow = (opts: {
  title: string;
  heading: string;
  subheading: string;
  identity: { article: string; color: string; size: string };
  ids: string[];
}): boolean =>
  openRawMaterialLabelPrintWindow({
    title: opts.title,
    heading: opts.heading,
    subheading: opts.subheading,
    header: cartonLabelHeader(opts.identity),
    ids: opts.ids,
  });

/**
 * Opens a print-ready window of raw material QR labels. Returns false when the popup was
 * blocked so the caller can tell the operator.
 */
export const openRawMaterialLabelPrintWindow = (opts: {
  title: string;
  heading: string;
  subheading: string;
  header: RawMaterialLabelHeader;
  ids: string[];
}): boolean => openPrintDocument(renderRawMaterialLabelSheetHtml(opts)).opened;
