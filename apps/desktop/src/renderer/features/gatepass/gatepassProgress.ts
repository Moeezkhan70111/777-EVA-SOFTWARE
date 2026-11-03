import { copy } from "../../config/copy";

// WHAT A GATEPASS'S CARTONS HAVE DONE, in one sentence, for every screen that shows it (docs/42 §10.2).
//
// A gatepass line is split when it is made: QR cartons in the store are reserved and scanned out as
// they always were, and cartons with no QR (Manual Production) are ISSUED DIRECTLY -- taken out of
// stock at once, never scanned. The figures come from the main process, read from the scan and carton
// records (gatepassLineSql.ts); this only words them. An issued carton is never called scanned.
//
//   QR only        "3 of 5 moved out" / "All moved out"                            (unchanged)
//   Manual only    "All cartons issued — No Store Scan Required"
//   Mixed          "2 cartons issued directly. Scan the remaining 3 QR cartons."
//   Mixed, done    "2 cartons issued directly · 3 QR cartons scanned out"

export interface CartonFigures {
  /** Every carton the gatepass (or line) asks for. */
  total: number;
  /** Taken out of stock when the gatepass was made: no QR, never scanned. */
  issuedDirectly: number;
  /** QR cartons scanned out at this desk. */
  scanned: number;
  /** QR cartons still to scan at this desk. */
  remaining: number;
}

/** Every carton was issued directly: there is nothing at all to scan. */
export const isIssuedWhole = (figures: CartonFigures): boolean => figures.total > 0 && figures.issuedDirectly >= figures.total;

/** What a scanning desk's banner says once nothing is left to scan there. QR-only wording is unchanged. */
export const deskDoneMessage = (desk: "STORE" | "DISPATCH", figures: CartonFigures): { title: string; message: string } => {
  if (isIssuedWhole(figures)) {
    return { title: copy.gatepass.deskNothingToScanTitle, message: desk === "STORE" ? copy.gatepass.noStoreScanRequired : copy.gatepass.noGateScanRequired };
  }
  if (figures.issuedDirectly > 0) return { title: copy.gatepass.deskCompleteTitle, message: copy.gatepass.everyQrCartonScanned };
  return { title: copy.gatepass.deskCompleteTitle, message: copy.gatepass.everyCartonScanned };
};

/** What a desk says before the next scan: the familiar prompt, or -- when some cartons were issued directly -- how many QR cartons to scan. */
export const deskIdleMessage = (figures: CartonFigures): string =>
  figures.issuedDirectly > 0 && figures.remaining > 0 ? copy.gatepass.issuedThenScan(figures.issuedDirectly, figures.remaining) : copy.gatepass.scanPrompt;

/** The store side of a gatepass, as one sentence. */
export const describeStoreProgress = (figures: CartonFigures): string => {
  if (figures.issuedDirectly <= 0) {
    return figures.remaining <= 0 && figures.total > 0 ? copy.gatepass.allMovedOut : copy.gatepass.movedOutOf(figures.scanned, figures.total);
  }
  if (isIssuedWhole(figures)) return copy.gatepass.noStoreScanRequired;
  if (figures.remaining > 0) return copy.gatepass.issuedThenScan(figures.issuedDirectly, figures.remaining);
  return copy.gatepass.issuedAndScanned(figures.issuedDirectly, figures.scanned);
};
