// THE STORE'S SLIP PRINTER: a Star TSP800II on a roll of 104 mm paper. No Electron here, so it can be
// tested. Windows shows it as "Star TSP800II (TSP847II)", but another computer's copy may be named
// a little differently, so it is found by its model.

const SLIP_PRINTER_MODEL = "TSP800";

const MICRONS_PER_MM = 1000;
const MICRONS_PER_CSS_PIXEL = 25400 / 96;
/** The driver's "104mm x Receipt" form. The slip's content inside it is 4 inches wide. */
const ROLL_WIDTH_MM = 104;
/** Paper fed past the content, so the cutter does not cut through the last line. */
const FEED_AFTER_MM = 8;
/** A page must stay taller than wide, or it is taken for landscape. */
const MIN_LENGTH_MM = 120;
/** About a metre. A slip longer than this carries on across a second page. */
const MAX_LENGTH_MM = 1000;

/** The slip printer's name among this computer's printers, or null when it has none. */
export const findSlipPrinter = (printers: ReadonlyArray<{ name: string }>): string | null =>
  printers.find((printer) => printer.name.toUpperCase().includes(SLIP_PRINTER_MODEL))?.name ?? null;

/** The page for a slip whose content is this tall: as long as the slip itself, so one slip is one cut. */
export const slipPageSize = (contentHeightPx: number): { width: number; height: number } => {
  const contentMm = (contentHeightPx * MICRONS_PER_CSS_PIXEL) / MICRONS_PER_MM;
  const lengthMm = Math.min(MAX_LENGTH_MM, Math.max(MIN_LENGTH_MM, contentMm + FEED_AFTER_MM));
  return { width: ROLL_WIDTH_MM * MICRONS_PER_MM, height: Math.ceil(lengthMm) * MICRONS_PER_MM };
};
